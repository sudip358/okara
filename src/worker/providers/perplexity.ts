/**
 * Perplexity adapter (GeoProvider) using the Agent API with the built-in `web_search` tool.
 *
 * Contract verified 2026-09-30 against official docs:
 *   - Endpoint: POST https://api.perplexity.ai/v1/agent, `Authorization: Bearer <key>`
 *     (https://docs.perplexity.ai/api-reference/agent-post, OpenAPI https://docs.perplexity.ai/openapi.json
 *     operation `createAgent`).
 *   - Request (ResponsesRequest): `model` in provider/model format (e.g. "perplexity/sonar"), `input`
 *     (string), `instructions`, `tools: [{ type: "web_search" }]`, `language_preference` (ISO 639-1),
 *     `max_output_tokens`. With a direct `model` and no preset, `max_steps` defaults to 1: the tool may
 *     run and the agent then "makes one final pass to answer from what it has gathered"
 *     (https://docs.perplexity.ai/docs/agent-api/building-agents/define-the-run). Requests that select a
 *     model directly must add the `web_search` tool to search the web
 *     (https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/how-to).
 *   - Response (ResponsesResponse): `id`, `model`, `status` (completed | failed | incomplete | in_progress |
 *     queued | cancelled), `error`, `output[]` items discriminated by `type`:
 *       * `message` -> `content[].{type:"output_text", text}`
 *       * `search_results` -> `results[].{id,url,title,snippet,date,last_updated,source}` and optional
 *         `queries[]` (the search queries issued; this is what we store as engine search queries)
 *     `usage.{input_tokens, output_tokens, total_tokens, tool_calls_details.search_web.invocation,
 *     cost.{input_cost, output_cost, tool_calls_cost, total_cost, currency:"USD"}}`
 *     (https://docs.perplexity.ai/docs/agent-api/tools/web-search#response-shape).
 *   - Credential check: GET https://api.perplexity.ai/v1/models (List Models, no inference).
 *
 * Documentation conflict (recorded per OPERATING RULE 3): the build kit and older integrations describe
 * Sonar Chat Completions (`/v1/sonar`, `choices[]`, top-level `search_results`, removed `citations`).
 * Perplexity's migration page states "Sonar Chat Completions support ended on September 27, 2026" and
 * recommends the Agent API for all new projects, so this adapter targets /v1/agent. The legacy
 * top-level `citations` field is never parsed; only `search_results` output items produce citations.
 *
 * Grounding: grounded = true only when at least one `search_results` output item has a non-empty
 * `results` array. The actual cost from `usage.cost.total_cost` is used when present
 * (costIsEstimate false); otherwise the versioned rate table estimates it.
 *
 * The request never mentions the project's brand: only the raw prompt plus a neutral locale instruction.
 */
import type { Env } from "../env";
import type { GeoCitation, GeoProvider } from "./types";
import { neutralInstruction, resolveCost, safeLocaleToken, sendJson, type GeoAnswerWithOutcome } from "./rates";

export const PERPLEXITY_API_BASE = "https://api.perplexity.ai";
export const PERPLEXITY_GROUNDING_MODE = "perplexity_web_search";
export const PERPLEXITY_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface PerplexityProviderConfig {
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/** Agent API model ids are provider/model, e.g. "perplexity/sonar". */
export function isValidPerplexityModelId(model: string | undefined | null): boolean {
  return typeof model === "string" && /^[a-z0-9][a-z0-9_.\-]*\/[a-z0-9][a-z0-9_.\-]{0,80}$/i.test(model.trim());
}

/** True when an API key and a model id (from env.PERPLEXITY_MODEL only) are configured. */
export function perplexityConfigured(env: Pick<Env, "PERPLEXITY_API_KEY" | "PERPLEXITY_MODEL">, apiKey?: string | null): boolean {
  const key = (apiKey ?? env.PERPLEXITY_API_KEY ?? "").trim();
  return key.length > 0 && isValidPerplexityModelId(env.PERPLEXITY_MODEL);
}

// ------------------------------------------------------------------ response parsing (pure)

interface PplxOutputItem {
  type?: unknown;
  content?: Array<{ type?: unknown; text?: unknown }>;
  results?: Array<{ id?: unknown; url?: unknown; title?: unknown; date?: unknown }>;
  queries?: unknown;
}
interface PplxResponse {
  id?: unknown;
  model?: unknown;
  status?: unknown;
  error?: { message?: unknown; code?: unknown };
  output?: PplxOutputItem[];
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    tool_calls_details?: Record<string, { invocation?: unknown } | undefined>;
    cost?: { total_cost?: unknown; currency?: unknown };
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface ParsedPerplexity {
  status: "ok" | "incomplete" | "failed";
  model: string | null;
  text: string | null;
  grounded: boolean;
  citations: Array<GeoCitation & { date: string | null }>;
  searchQueries: string[] | null;
  searchQueriesExposed: boolean;
  requestId: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; searchRequests: number | null };
  actualCostUsd: number | null;
  error: string | null;
}

export function parsePerplexityResponse(body: unknown): ParsedPerplexity {
  const r = (body ?? {}) as PplxResponse;
  const output = Array.isArray(r.output) ? r.output : [];

  const texts: string[] = [];
  const searchItems: PplxOutputItem[] = [];
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
    } else if (item?.type === "search_results") {
      searchItems.push(item);
    }
  }
  const text = texts.length > 0 ? texts.join("\n\n") : null;

  // Citations: each result url once, in order of first appearance. Position = 1-based order.
  const citations: ParsedPerplexity["citations"] = [];
  const seen = new Set<string>();
  let resultCount = 0;
  for (const item of searchItems) {
    for (const res of Array.isArray(item.results) ? item.results : []) {
      const url = str(res?.url);
      if (!url) continue;
      resultCount++;
      if (seen.has(url)) continue;
      seen.add(url);
      citations.push({ url, title: str(res?.title), position: citations.length + 1, date: str(res?.date) });
    }
  }
  const grounded = resultCount > 0;

  const queryArrays = searchItems.map((i) => i.queries).filter((q): q is unknown[] => Array.isArray(q));
  const searchQueriesExposed = queryArrays.length > 0;
  const searchQueries = searchQueriesExposed
    ? [...new Set(queryArrays.flat().filter((q): q is string => typeof q === "string").map((q) => q.trim()).filter((q) => q.length > 0))]
    : null;

  const u = r.usage ?? {};
  const invocation = num(u.tool_calls_details?.search_web?.invocation);
  const usage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    // Documented counter first; if absent but search results exist, each search_results item evidences one invocation.
    searchRequests: invocation ?? (searchItems.length > 0 ? searchItems.length : u.tool_calls_details ? 0 : null),
  };
  const currency = u.cost?.currency;
  const actualCostUsd = currency === undefined || currency === "USD" ? num(u.cost?.total_cost) : null;

  const st = str(r.status);
  let status: ParsedPerplexity["status"];
  let error: string | null = null;
  if (st === "completed") {
    status = text === null ? "incomplete" : "ok";
    if (text === null) error = "Perplexity returned no answer text.";
  } else if (st === "incomplete") {
    status = "incomplete";
    error = "Perplexity response status incomplete.";
  } else {
    status = "failed";
    const msg = str(r.error?.message);
    error = `Perplexity response status ${st ?? "missing"}${msg ? `: ${msg.slice(0, 300)}` : ""}.`;
  }

  return { status, model: str(r.model), text, grounded, citations, searchQueries, searchQueriesExposed, requestId: str(r.id), usage, actualCostUsd, error };
}

// ------------------------------------------------------------------ provider

export function createPerplexityProvider(config: PerplexityProviderConfig): GeoProvider & { readonly samplingOptions: Record<string, unknown>; ask(prompt: string, opts: { locale: string; language: string; signal?: AbortSignal }): Promise<GeoAnswerWithOutcome> } {
  const model = config.model.trim();
  const maxOutputTokens = config.maxOutputTokens ?? PERPLEXITY_DEFAULT_MAX_OUTPUT_TOKENS;
  const samplingOptions = { maxOutputTokens, tools: ["web_search"] };
  const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };

  const base = (): Omit<GeoAnswerWithOutcome, "status" | "outcome" | "latencyMs"> => ({
    provider: "perplexity",
    model,
    groundingMode: PERPLEXITY_GROUNDING_MODE,
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
  });

  return {
    id: "perplexity",
    label: "Perplexity Agent API with web_search",
    model,
    groundingMode: PERPLEXITY_GROUNDING_MODE,
    samplingOptions,

    async ask(prompt, opts) {
      if (!config.apiKey || !isValidPerplexityModelId(model)) {
        return { ...base(), status: "failed", outcome: "not_sent", error: "Perplexity is not configured (API key or model id missing).", latencyMs: 0 };
      }
      const body: Record<string, unknown> = {
        model,
        input: prompt,
        tools: [{ type: "web_search" }],
        max_output_tokens: maxOutputTokens,
      };
      const instruction = neutralInstruction(opts.locale, opts.language);
      if (instruction) body.instructions = instruction;
      const lang = safeLocaleToken(opts.language);
      if (lang && /^[a-z]{2}$/i.test(lang)) body.language_preference = lang.toLowerCase();

      const res = await sendJson(config.fetchImpl, `${PERPLEXITY_API_BASE}/v1/agent`, { method: "POST", headers, body, signal: opts.signal }, config.apiKey, "Perplexity", config.timeoutMs);
      if (res.kind !== "ok") {
        return { ...base(), status: "failed", outcome: res.outcome, error: res.error, latencyMs: res.latencyMs };
      }
      const p = parsePerplexityResponse(res.body);
      const answeredModel = p.model ?? model;
      const cost = resolveCost("perplexity", answeredModel, p.usage, p.actualCostUsd, { grounded: p.grounded });
      return {
        ...base(),
        model: answeredModel,
        status: p.status,
        outcome: "ok",
        grounded: p.grounded,
        text: p.text,
        citations: p.citations.map(({ url, title, position }) => ({ url, title, position })),
        searchQueries: p.searchQueries,
        searchQueriesExposed: p.searchQueriesExposed,
        requestId: p.requestId,
        usage: p.usage,
        costUsd: cost.costUsd,
        costIsEstimate: cost.costIsEstimate,
        rateVersion: cost.rateVersion,
        error: p.error,
        latencyMs: res.latencyMs,
      };
    },

    async test() {
      if (!config.apiKey) return { ok: false, detail: "Perplexity API key is not configured." };
      const res = await sendJson(config.fetchImpl, `${PERPLEXITY_API_BASE}/v1/models`, { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}` } }, config.apiKey, "Perplexity", 12_000);
      if (res.kind !== "ok") return { ok: false, detail: res.error };
      const ids = Array.isArray((res.body as { data?: unknown })?.data) ? ((res.body as { data: Array<{ id?: unknown }> }).data.map((m) => m?.id).filter((x) => typeof x === "string") as string[]) : [];
      if (model && ids.length > 0 && !ids.includes(model)) return { ok: false, detail: `Key accepted, but model ${model} is not listed by /v1/models.` };
      return { ok: true, detail: "Perplexity key accepted." };
    },
  };
}
