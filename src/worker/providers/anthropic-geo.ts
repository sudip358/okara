/**
 * Anthropic GEO lane (GeoProvider): Messages API with the server-side `web_search_20250305` tool, via the
 * official SDK (@anthropic-ai/sdk) with `maxRetries: 0` (one metered attempt per call, like the writer).
 *
 * Contract (docs/provider-contracts.md, "Anthropic Messages web search — GEO", verified 2026-09-30):
 *   - https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
 *   - https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
 *   - https://platform.claude.com/docs/en/about-claude/pricing
 *   POST https://api.anthropic.com/v1/messages (x-api-key, anthropic-version 2023-06-01; no beta header)
 *   body { model, max_tokens, system?, messages: [{ role: "user", content }],
 *          tools: [{ type: "web_search_20250305", name: "web_search", max_uses }] }
 *   content[]: server_tool_use { name: "web_search", input: { query } };
 *              web_search_tool_result { content: web_search_result[] | { type: "web_search_tool_result_error", error_code } };
 *              text { text, citations?: [{ type: "web_search_result_location", url, title, cited_text }] }
 *   usage { input_tokens, output_tokens, server_tool_use: { web_search_requests } }; request id header request-id.
 *
 * Rules:
 *   - grounded = true only when a web_search server_tool_use is followed by a web_search_tool_result whose
 *     content is a result list, AND usage.server_tool_use.web_search_requests >= 1.
 *   - Citations only from `web_search_result_location` citations on text blocks; uncited results are not citations.
 *     encrypted_content / encrypted_index are never stored.
 *   - `pause_turn`: continued at most once by sending the assistant content back unchanged; a second pause
 *     makes the observation `incomplete`.
 *   - Cost = web_search_requests x $0.01 + tokens x the configured model's rates (estimate); no rate -> null.
 *   - The model id comes only from ANTHROPIC_GEO_MODEL; the request never names the brand.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import type { GeoCitation } from "./types";
import { estimateCost, GEO_CALL_TIMEOUT_MS, neutralInstruction, scrub, type GeoAnswerWithOutcome, type GeoCallOutcome, type GeoProviderAdapter } from "./rates";

export const ANTHROPIC_GEO_API_BASE = "https://api.anthropic.com";
export const ANTHROPIC_GEO_VERSION = "2023-06-01";
export const ANTHROPIC_GEO_TOOL_TYPE = "web_search_20250305";
export const ANTHROPIC_GEO_GROUNDING_MODE = "anthropic_web_search";
/** Searches allowed per request (engineering bound; part of the cohort key). */
export const ANTHROPIC_GEO_MAX_USES = 3;
export const ANTHROPIC_GEO_DEFAULT_MAX_TOKENS = 8192;
/** At most one continuation after `pause_turn`. */
export const ANTHROPIC_GEO_MAX_CONTINUATIONS = 1;

export interface AnthropicGeoProviderConfig {
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  maxTokens?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export function isValidAnthropicModelId(model: string | undefined | null): boolean {
  return typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@\-]{0,99}$/.test(model.trim());
}

/** True when a key and a model id (env.ANTHROPIC_GEO_MODEL only) are configured. */
export function anthropicGeoConfigured(env: Pick<Env, "ANTHROPIC_GEO_API_KEY" | "ANTHROPIC_GEO_MODEL">, apiKey?: string | null): boolean {
  const key = (apiKey ?? env.ANTHROPIC_GEO_API_KEY ?? "").trim();
  return key.length > 0 && isValidAnthropicModelId(env.ANTHROPIC_GEO_MODEL);
}

// ------------------------------------------------------------------ response parsing (pure)

interface AntBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: { query?: unknown } | null;
  tool_use_id?: unknown;
  content?: unknown;
  text?: unknown;
  citations?: Array<{ type?: unknown; url?: unknown; title?: unknown }> | null;
}
export interface AntMessage {
  id?: unknown;
  model?: unknown;
  stop_reason?: unknown;
  content?: AntBlock[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown; server_tool_use?: { web_search_requests?: unknown } | null };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface ParsedAnthropicGeo {
  status: "ok" | "incomplete" | "failed";
  model: string | null;
  text: string | null;
  grounded: boolean;
  citations: GeoCitation[];
  searchQueries: string[];
  searchQueriesExposed: boolean;
  messageId: string | null;
  stopReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; searchRequests: number | null };
  searchErrors: string[];
  error: string | null;
}

/** Parse one or more Messages responses of the same turn (the second is a pause_turn continuation). */
export function parseAnthropicGeoMessages(messages: AntMessage[]): ParsedAnthropicGeo {
  const blocks = messages.flatMap((m) => (Array.isArray(m?.content) ? m.content : []));
  const last = messages[messages.length - 1] ?? {};

  const searchUseIds = new Set<string>();
  const queries: string[] = [];
  const searchErrors: string[] = [];
  let resultListFollowsSearch = false;
  const texts: string[] = [];
  const citations: GeoCitation[] = [];
  const seen = new Set<string>();

  for (const b of blocks) {
    if (b?.type === "server_tool_use" && b.name === "web_search") {
      const id = str(b.id);
      if (id) searchUseIds.add(id);
      const q = typeof b.input?.query === "string" ? b.input.query.trim() : "";
      if (q) queries.push(q);
    } else if (b?.type === "web_search_tool_result") {
      const toolUseId = str(b.tool_use_id);
      const follows = toolUseId !== null && searchUseIds.has(toolUseId);
      if (Array.isArray(b.content)) {
        if (follows) resultListFollowsSearch = true;
      } else if (b.content && typeof b.content === "object") {
        const code = str((b.content as { error_code?: unknown }).error_code);
        searchErrors.push(code ?? "unknown_error");
      }
    } else if (b?.type === "text" && typeof b.text === "string") {
      texts.push(b.text);
      for (const c of Array.isArray(b.citations) ? b.citations : []) {
        if (c?.type !== "web_search_result_location") continue;
        const url = str(c.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        citations.push({ url, title: str(c.title), position: citations.length + 1 });
      }
    }
  }
  const joined = texts.join("");
  const text = joined.trim() ? joined : null;

  // Usage summed over the turn's responses; unknown if any response lacks a token count.
  let inputTokens: number | null = 0;
  let outputTokens: number | null = 0;
  let searchRequests: number | null = 0;
  for (const m of messages) {
    const i = num(m?.usage?.input_tokens);
    const o = num(m?.usage?.output_tokens);
    inputTokens = inputTokens === null || i === null ? null : inputTokens + i;
    outputTokens = outputTokens === null || o === null ? null : outputTokens + o;
    const w = num(m?.usage?.server_tool_use?.web_search_requests);
    const searchedHere = (Array.isArray(m?.content) ? m.content : []).some((b) => b?.type === "server_tool_use" && b.name === "web_search");
    // Absent counter with no search block in that response: nothing was searched (0). Absent with a search: unknown.
    const s = w ?? (searchedHere ? null : 0);
    searchRequests = searchRequests === null || s === null ? null : searchRequests + s;
  }

  const grounded = resultListFollowsSearch && (searchRequests ?? 0) >= 1;
  const stopReason = str(last.stop_reason);
  let status: ParsedAnthropicGeo["status"];
  let error: string | null = null;
  if (stopReason === "refusal") {
    status = "failed";
    error = "Anthropic declined to answer (stop_reason refusal).";
  } else if (stopReason === "max_tokens") {
    status = "incomplete";
    error = "Anthropic answer was truncated (stop_reason max_tokens).";
  } else if (stopReason === "pause_turn") {
    status = "incomplete";
    error = "Anthropic search turn was still paused after one continuation (stop_reason pause_turn).";
  } else if (text === null) {
    status = "incomplete";
    error = "Anthropic returned no answer text.";
  } else {
    status = "ok";
  }
  if (!error && searchErrors.length > 0 && !grounded) error = `Web search returned errors: ${[...new Set(searchErrors)].join(", ")}.`;

  return {
    status,
    model: str(last.model),
    text,
    grounded,
    citations,
    searchQueries: [...new Set(queries)],
    // Every web_search server_tool_use carries its query, so queries are always exposed.
    searchQueriesExposed: true,
    messageId: str(last.id),
    stopReason,
    usage: { inputTokens, outputTokens, searchRequests },
    searchErrors,
    error,
  };
}

// ------------------------------------------------------------------ provider

export function createAnthropicGeoProvider(config: AnthropicGeoProviderConfig): GeoProviderAdapter {
  const model = config.model.trim();
  const maxTokens = config.maxTokens ?? ANTHROPIC_GEO_DEFAULT_MAX_TOKENS;
  const timeoutMs = config.timeoutMs ?? GEO_CALL_TIMEOUT_MS;
  const samplingOptions = { maxTokens, tools: [ANTHROPIC_GEO_TOOL_TYPE], maxUses: ANTHROPIC_GEO_MAX_USES };

  const base = (): Omit<GeoAnswerWithOutcome, "status" | "outcome" | "latencyMs"> => ({
    provider: "anthropic_geo",
    model,
    groundingMode: ANTHROPIC_GEO_GROUNDING_MODE,
    grounded: false,
    text: null,
    citations: [],
    searchQueries: null,
    searchQueriesExposed: false,
    requestId: null,
    usage: { inputTokens: null, outputTokens: null, searchRequests: null },
    costUsd: null,
    costIsEstimate: true,
    rateVersion: null,
    error: null,
    finishReason: null,
  });

  const client = () =>
    new Anthropic({
      apiKey: config.apiKey,
      // Call fetch without a receiver: workerd rejects the platform fetch invoked as obj.fetch().
      fetch: (input, init) => config.fetchImpl(input as RequestInfo, init as RequestInit),
      maxRetries: 0,
      timeout: timeoutMs,
    });

  return {
    id: "anthropic_geo",
    label: "Anthropic Messages API with web_search",
    model,
    groundingMode: ANTHROPIC_GEO_GROUNDING_MODE,
    samplingOptions,

    async ask(prompt, opts) {
      if (!config.apiKey || !isValidAnthropicModelId(model)) {
        return { ...base(), status: "failed", outcome: "not_sent", error: "Anthropic GEO lane is not configured (API key or ANTHROPIC_GEO_MODEL missing).", latencyMs: 0 };
      }
      const c = client();
      const instruction = neutralInstruction(opts.locale, opts.language);
      const userTurn = { role: "user" as const, content: prompt };
      const tools = [{ type: ANTHROPIC_GEO_TOOL_TYPE, name: "web_search", max_uses: ANTHROPIC_GEO_MAX_USES }];
      const started = Date.now();
      const responses: AntMessage[] = [];
      let requestId: string | null = null;
      let messages: unknown[] = [userTurn];

      for (let attempt = 0; attempt <= ANTHROPIC_GEO_MAX_CONTINUATIONS; attempt++) {
        const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages, tools };
        if (instruction) body.system = instruction;
        try {
          const { data, request_id } = await c.messages
            .create(body as unknown as Anthropic.MessageCreateParamsNonStreaming, { signal: opts.signal })
            .withResponse();
          requestId = request_id ?? requestId;
          const msg = data as unknown as AntMessage;
          responses.push(msg);
          if (msg.stop_reason !== "pause_turn" || attempt === ANTHROPIC_GEO_MAX_CONTINUATIONS) break;
          // Continue the paused turn: send the assistant content back unchanged.
          messages = [userTurn, { role: "assistant", content: msg.content ?? [] }];
        } catch (e) {
          const failure = mapError(e, timeoutMs, config.apiKey);
          if (responses.length === 0) {
            return { ...base(), status: "failed", outcome: failure.outcome, error: failure.error, requestId: failure.requestId, latencyMs: Date.now() - started };
          }
          // The first response was parsed and billed; the continuation failed. Keep what the first response
          // proves. The continuation's billing is unknown, so the cost stays null (the batch then settles the
          // full reservation) rather than a partial number.
          const p = parseAnthropicGeoMessages(responses);
          return {
            ...base(),
            model: p.model ?? model,
            status: "incomplete",
            outcome: "ok",
            grounded: p.grounded,
            text: p.text,
            citations: p.citations,
            searchQueries: p.searchQueries,
            searchQueriesExposed: p.searchQueriesExposed,
            requestId,
            usage: p.usage,
            error: `pause_turn continuation failed: ${failure.error}`,
            finishReason: p.stopReason,
            latencyMs: Date.now() - started,
          };
        }
      }

      const p = parseAnthropicGeoMessages(responses);
      const cost = estimateCost("anthropic_geo", model, p.usage, { grounded: p.grounded, at: (config.now ?? (() => new Date()))() });
      return {
        ...base(),
        model: p.model ?? model,
        status: p.status,
        outcome: "ok",
        grounded: p.grounded,
        text: p.text,
        citations: p.citations,
        searchQueries: p.searchQueries,
        searchQueriesExposed: p.searchQueriesExposed,
        requestId: requestId ?? p.messageId,
        usage: p.usage,
        costUsd: cost.costUsd,
        costIsEstimate: true,
        rateVersion: cost.rateVersion,
        error: p.error,
        finishReason: p.stopReason,
        latencyMs: Date.now() - started,
      };
    },

    /** Free check: GET /v1/models/{model} verifies the key and the configured model id (no inference). */
    async test() {
      if (!config.apiKey) return { ok: false, detail: "Anthropic API key is not configured." };
      if (!isValidAnthropicModelId(model)) return { ok: false, detail: "ANTHROPIC_GEO_MODEL is not set to a valid model id." };
      try {
        const res = await config.fetchImpl(`${ANTHROPIC_GEO_API_BASE}/v1/models/${encodeURIComponent(model)}`, {
          method: "GET",
          headers: { "x-api-key": config.apiKey, "anthropic-version": ANTHROPIC_GEO_VERSION },
          signal: AbortSignal.timeout(12_000),
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.ok) return { ok: true, detail: `Key accepted; model ${model} is available.` };
        if (res.status === 401 || res.status === 403) return { ok: false, detail: "Key rejected by Anthropic." };
        if (res.status === 404) return { ok: false, detail: `Model ${model} was not found for this key.` };
        return { ok: false, detail: `Anthropic returned HTTP ${res.status}.` };
      } catch (e) {
        return { ok: false, detail: `Could not reach Anthropic: ${scrub(e instanceof Error ? e.message : "unknown error", config.apiKey)}` };
      }
    },
  };
}

/** Typed SDK errors -> budget outcome. Never message matching. */
function mapError(e: unknown, timeoutMs: number, secret: string): { outcome: GeoCallOutcome; error: string; requestId: string | null } {
  if (e instanceof Anthropic.APIUserAbortError) return { outcome: "timeout", error: "Anthropic request was aborted.", requestId: null };
  if (e instanceof Anthropic.APIConnectionTimeoutError) return { outcome: "timeout", error: `Anthropic request timed out after ${timeoutMs} ms.`, requestId: null };
  if (e instanceof Anthropic.APIConnectionError) return { outcome: "network", error: `Anthropic network error: ${scrub(e.message, secret)}`, requestId: null };
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === "number" ? e.status : null;
    const detail = scrub(`Anthropic HTTP ${status ?? "error"}: ${e.message}`, secret).slice(0, 400);
    // 4xx (including 429 and 400 "web search not enabled") is a definite rejection; 5xx/529 billing unknown.
    const outcome: GeoCallOutcome = status !== null && status < 500 ? "rejected" : "server_error";
    return { outcome, error: detail, requestId: e.requestID ?? null };
  }
  return { outcome: "network", error: `Anthropic adapter error: ${scrub(String((e as Error)?.message ?? e), secret)}`, requestId: null };
}
