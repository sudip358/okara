/**
 * OpenAI GEO lane (GeoProvider): Responses API with the built-in `web_search` tool.
 *
 * Contract (docs/provider-contracts.md, "OpenAI Responses API web search — GEO", verified 2026-09-30):
 *   - Guide https://developers.openai.com/api/docs/guides/tools-web-search
 *   - Reference https://developers.openai.com/api/reference/resources/responses/methods/create
 *   - Pricing https://developers.openai.com/api/docs/pricing#built-in-tools
 *   POST https://api.openai.com/v1/responses, `Authorization: Bearer <key>`
 *   body { model, input, instructions?, tools: [{ type: "web_search" }], tool_choice: "auto",
 *          include: ["web_search_call.action.sources"], max_output_tokens }
 *   output[]: `web_search_call` { id, status, action: { type: "search", queries?, query?, sources? } |
 *             { type: "open_page", url } | { type: "find_in_page", pattern, url } }
 *             `message` { content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url, title, start_index, end_index }] }] }
 *   usage { input_tokens, output_tokens, ... } (no search count, no cost); request id header x-request-id.
 *
 * Rules:
 *   - grounded = true only when the output holds a `web_search_call` with status "completed" and
 *     action.type "search". tool_choice "auto" makes search optional; an unsearched answer stays ungrounded.
 *   - Citations come only from `url_citation` annotations. Consulted `sources` are never citations.
 *   - Engine search queries: action.queries[], else action.query, from search actions; when search calls
 *     carry neither, the queries are "not exposed".
 *   - Cost is always an estimate from the versioned rate table (rates.ts); unknown -> null, never 0.
 *   - The model id comes only from OPENAI_GEO_MODEL; nothing is hardcoded. The request never names the brand.
 */
import type { Env } from "../env";
import type { GeoCitation } from "./types";
import { estimateCost, neutralInstruction, sendJson, type GeoAnswerWithOutcome, type GeoProviderAdapter } from "./rates";

export const OPENAI_API_BASE = "https://api.openai.com";
export const OPENAI_GEO_GROUNDING_MODE = "openai_web_search";
export const OPENAI_GEO_TOOL_TYPE = "web_search";
export const OPENAI_GEO_TOOL_CHOICE = "auto";
export const OPENAI_GEO_DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface OpenAiGeoProviderConfig {
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  maxOutputTokens?: number;
  timeoutMs?: number;
  now?: () => Date;
}

/** Plain OpenAI model ids (e.g. from the models page); rejects whitespace, slashes and query characters. */
export function isValidOpenAiModelId(model: string | undefined | null): boolean {
  return typeof model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,99}$/.test(model.trim());
}

/** True when a key and a model id (env.OPENAI_GEO_MODEL only) are configured. */
export function openaiGeoConfigured(env: Pick<Env, "OPENAI_GEO_API_KEY" | "OPENAI_GEO_MODEL">, apiKey?: string | null): boolean {
  const key = (apiKey ?? env.OPENAI_GEO_API_KEY ?? "").trim();
  return key.length > 0 && isValidOpenAiModelId(env.OPENAI_GEO_MODEL);
}

// ------------------------------------------------------------------ response parsing (pure)

interface OaiAnnotation { type?: unknown; url?: unknown; title?: unknown }
interface OaiContent { type?: unknown; text?: unknown; annotations?: OaiAnnotation[] }
interface OaiAction { type?: unknown; queries?: unknown; query?: unknown }
interface OaiOutputItem { type?: unknown; status?: unknown; action?: OaiAction; content?: OaiContent[] }
interface OaiResponse {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  error?: { message?: unknown; code?: unknown } | null;
  incomplete_details?: { reason?: unknown } | null;
  output?: OaiOutputItem[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface ParsedOpenAiGeo {
  status: "ok" | "incomplete" | "failed";
  model: string | null;
  text: string | null;
  grounded: boolean;
  citations: GeoCitation[];
  searchQueries: string[] | null;
  searchQueriesExposed: boolean;
  responseId: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; searchRequests: number | null };
  finishReason: string | null;
  error: string | null;
}

export function parseOpenAiGeoResponse(body: unknown): ParsedOpenAiGeo {
  const r = (body ?? {}) as OaiResponse;
  const output = Array.isArray(r.output) ? r.output : [];

  const texts: string[] = [];
  const citations: GeoCitation[] = [];
  const seen = new Set<string>();
  const searchCalls: OaiOutputItem[] = [];
  for (const item of output) {
    if (item?.type === "web_search_call") {
      searchCalls.push(item);
    } else if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type !== "output_text" || typeof part.text !== "string") continue;
        texts.push(part.text);
        for (const a of Array.isArray(part.annotations) ? part.annotations : []) {
          if (a?.type !== "url_citation") continue;
          const url = str(a.url);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          citations.push({ url, title: str(a.title), position: citations.length + 1 });
        }
      }
    }
  }
  const text = texts.length > 0 ? texts.join("\n\n") : null;

  const searchActions = searchCalls.filter((c) => c.action?.type === "search");
  const grounded = searchActions.some((c) => c.status === "completed");
  // Billable calls = search actions. A web_search_call without an action cannot be classified: unknown.
  const unclassified = searchCalls.some((c) => !c.action || typeof c.action.type !== "string");
  const searchRequests = unclassified ? null : searchActions.length;

  const queries: string[] = [];
  let anyQueryField = false;
  for (const c of searchActions) {
    const a = c.action!;
    if (Array.isArray(a.queries)) {
      anyQueryField = true;
      for (const q of a.queries) if (typeof q === "string" && q.trim()) queries.push(q.trim());
    } else if (typeof a.query === "string") {
      anyQueryField = true;
      if (a.query.trim()) queries.push(a.query.trim());
    }
  }
  // No search at all: nothing was issued, so the (empty) query list is known. Searches without any query
  // field: "not exposed".
  const searchQueriesExposed = searchActions.length === 0 ? !unclassified : anyQueryField;
  const searchQueries = searchQueriesExposed ? [...new Set(queries)] : null;

  const usage = { inputTokens: num(r.usage?.input_tokens), outputTokens: num(r.usage?.output_tokens), searchRequests };

  const st = str(r.status);
  let status: ParsedOpenAiGeo["status"];
  let error: string | null = null;
  let finishReason: string | null = st;
  if (st === "completed") {
    status = text === null ? "incomplete" : "ok";
    if (text === null) error = "OpenAI returned no answer text.";
  } else if (st === "incomplete") {
    status = "incomplete";
    const reason = str(r.incomplete_details?.reason);
    finishReason = reason ?? st;
    error = `OpenAI response incomplete${reason ? ` (${reason})` : ""}.`;
  } else {
    status = "failed";
    const msg = str(r.error?.message);
    error = `OpenAI response status ${st ?? "missing"}${msg ? `: ${msg.slice(0, 300)}` : ""}.`;
  }

  return { status, model: str(r.model), text, grounded, citations, searchQueries, searchQueriesExposed, responseId: str(r.id), usage, finishReason, error };
}

// ------------------------------------------------------------------ provider

export function createOpenAiGeoProvider(config: OpenAiGeoProviderConfig): GeoProviderAdapter {
  const model = config.model.trim();
  const maxOutputTokens = config.maxOutputTokens ?? OPENAI_GEO_DEFAULT_MAX_OUTPUT_TOKENS;
  const samplingOptions = { maxOutputTokens, tools: [OPENAI_GEO_TOOL_TYPE], toolChoice: OPENAI_GEO_TOOL_CHOICE };
  const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };

  const base = (): Omit<GeoAnswerWithOutcome, "status" | "outcome" | "latencyMs"> => ({
    provider: "openai_geo",
    model,
    groundingMode: OPENAI_GEO_GROUNDING_MODE,
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

  return {
    id: "openai_geo",
    label: "OpenAI Responses API with web_search",
    model,
    groundingMode: OPENAI_GEO_GROUNDING_MODE,
    samplingOptions,

    async ask(prompt, opts) {
      if (!config.apiKey || !isValidOpenAiModelId(model)) {
        return { ...base(), status: "failed", outcome: "not_sent", error: "OpenAI GEO lane is not configured (API key or OPENAI_GEO_MODEL missing).", latencyMs: 0 };
      }
      const body: Record<string, unknown> = {
        model,
        input: prompt,
        tools: [{ type: OPENAI_GEO_TOOL_TYPE }],
        tool_choice: OPENAI_GEO_TOOL_CHOICE,
        include: ["web_search_call.action.sources"],
        max_output_tokens: maxOutputTokens,
      };
      const instruction = neutralInstruction(opts.locale, opts.language);
      if (instruction) body.instructions = instruction;

      const res = await sendJson(config.fetchImpl, `${OPENAI_API_BASE}/v1/responses`, { method: "POST", headers, body, signal: opts.signal }, config.apiKey, "OpenAI", config.timeoutMs);
      if (res.kind !== "ok") {
        return { ...base(), status: "failed", outcome: res.outcome, error: res.error, latencyMs: res.latencyMs };
      }
      const p = parseOpenAiGeoResponse(res.body);
      const answeredModel = p.model ?? model;
      // Rates are keyed by the configured id: the response may return a dated snapshot id.
      const cost = estimateCost("openai_geo", model, p.usage, { grounded: p.grounded, at: (config.now ?? (() => new Date()))() });
      return {
        ...base(),
        model: answeredModel,
        status: p.status,
        outcome: "ok",
        grounded: p.grounded,
        text: p.text,
        citations: p.citations,
        searchQueries: p.searchQueries,
        searchQueriesExposed: p.searchQueriesExposed,
        requestId: p.responseId,
        usage: p.usage,
        costUsd: cost.costUsd,
        costIsEstimate: true,
        rateVersion: cost.rateVersion,
        error: p.error,
        finishReason: p.finishReason,
        latencyMs: res.latencyMs,
      };
    },

    /** Free check: GET /v1/models/{model} verifies the key and the configured model id (no inference). */
    async test() {
      if (!config.apiKey) return { ok: false, detail: "OpenAI API key is not configured." };
      if (!isValidOpenAiModelId(model)) return { ok: false, detail: "OPENAI_GEO_MODEL is not set to a valid model id." };
      const res = await sendJson(config.fetchImpl, `${OPENAI_API_BASE}/v1/models/${encodeURIComponent(model)}`, { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}` } }, config.apiKey, "OpenAI", 12_000);
      if (res.kind === "ok") return { ok: true, detail: `Key accepted; model ${model} is available.` };
      if (res.kind === "http_error" && res.status === 404) return { ok: false, detail: `Model ${model} was not found for this key.` };
      return { ok: false, detail: res.error };
    },
  };
}
