/**
 * Gemini API adapter with Grounding with Google Search (GeoProvider).
 *
 * Contract verified 2026-09-30 against official docs:
 *   - Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *     (https://ai.google.dev/api/generate-content#method:-models.generatecontent), auth header
 *     `x-goog-api-key` (https://ai.google.dev/gemini-api/docs/google-search REST example).
 *   - Request: `contents[]`, `systemInstruction` (Content, text only), `tools[].googleSearch` (Tool JSON
 *     representation; the proto also accepts `google_search`), `generationConfig.maxOutputTokens`.
 *   - Response: `candidates[].content.parts[].text` (parts with `thought: true` are thought summaries and
 *     are excluded), `candidates[].finishReason` (enum; STOP = natural stop), `candidates[].groundingMetadata`
 *     with `webSearchQueries[]`, `groundingChunks[].web.{uri,title}`, `groundingSupports[]`;
 *     `usageMetadata.{promptTokenCount,candidatesTokenCount,thoughtsTokenCount,toolUsePromptTokenCount}`;
 *     `responseId`; `modelVersion`. `promptFeedback.blockReason` when the prompt is blocked.
 *   - Credential check: GET https://generativelanguage.googleapis.com/v1beta/models/{model} (models.get,
 *     https://ai.google.dev/api/models#method:-models.get), no inference.
 *
 * Documentation conflict (recorded per OPERATING RULE 3): as of 2026-09-30 the Google Search grounding
 * guide shows only the newer Interactions API (POST /v1beta/interactions, `tools: [{type:"google_search"}]`,
 * `google_search_call.arguments.queries`, `url_citation` annotations). generateContent and
 * GroundingMetadata remain in the current official API reference, so this adapter keeps generateContent
 * (the contract the rest of the system was designed around) and documents the Interactions API as the
 * migration path. Re-verify before changing.
 *
 * Grounding semantics:
 *   - grounded = true only when groundingMetadata has at least one non-empty webSearchQuery or at least
 *     one groundingChunk. No metadata => not grounded, searchQueries = null ("not exposed"/no search).
 *   - Billing (https://ai.google.dev/gemini-api/docs/google-search#pricing): Gemini 3 bills each executed
 *     search query and "ignore[s] the empty web search queries"; Gemini 2.5 bills per grounded prompt.
 *     usage.searchRequests = number of unique non-empty webSearchQueries.
 *
 * Citation hosts: web grounding chunk URIs may be Google redirect wrappers
 * (https://vertexaisearch.cloud.google.com/grounding-api-redirect/...) whose `title` carries the source
 * domain (e.g. "uefa.com"). We keep uri and title as returned; `citationHost()` derives the host from the
 * title when the uri is such a wrapper. geo-analysis must match brand domains using that host (or the
 * title/domain), never the redirect host.
 *
 * The request never mentions the project's brand: only the raw prompt plus a neutral locale instruction.
 */
import type { Env } from "../env";
import type { GeoCitation } from "./types";
import { neutralInstruction, resolveCost, sendJson, type GeoAnswerWithOutcome, type GeoProviderAdapter } from "./rates";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_GROUNDING_MODE = "google_search";
export const GEMINI_DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** Hosts known to wrap grounding URIs in a redirect. */
const REDIRECT_WRAPPER_HOSTS = new Set(["vertexaisearch.cloud.google.com"]);

export interface GeminiProviderConfig {
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Clock for selecting the dated rate window (defaults to now). */
  now?: () => Date;
}

/** Model ids go into the URL path: allow only plain ids like "gemini-3.8-flash" (optionally "models/..."). */
export function isValidGeminiModelId(model: string | undefined | null): boolean {
  return typeof model === "string" && /^(?:models\/)?[a-z0-9][a-z0-9.\-]{1,80}$/i.test(model.trim());
}

/**
 * True when an operator key and a model id are configured. Model ids come ONLY from configuration
 * (env.GEMINI_MODEL); with none set the runtime must show Gemini as setup_required.
 * BYO workspace keys are resolved by the runtime; pass `apiKey` to check that path.
 */
export function geminiConfigured(env: Pick<Env, "GEMINI_API_KEY" | "GEMINI_MODEL">, apiKey?: string | null): boolean {
  const key = (apiKey ?? env.GEMINI_API_KEY ?? "").trim();
  return key.length > 0 && isValidGeminiModelId(env.GEMINI_MODEL);
}

export function isRedirectWrapper(uri: string): boolean {
  try {
    return REDIRECT_WRAPPER_HOSTS.has(new URL(uri).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Host to attribute a citation to. For redirect-wrapped grounding URIs the title carries the domain;
 * returns null when neither yields a plausible hostname.
 */
export function citationHost(url: string, title: string | null): string | null {
  if (!isRedirectWrapper(url)) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || null;
    } catch {
      return null;
    }
  }
  const t = (title ?? "").trim().toLowerCase();
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(t) ? t.replace(/^www\./, "") : null;
}

// ------------------------------------------------------------------ response parsing (pure)

interface GeminiPart { text?: unknown; thought?: unknown }
interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: unknown;
  groundingMetadata?: {
    webSearchQueries?: unknown;
    groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }>;
    groundingSupports?: unknown;
  };
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown; toolUsePromptTokenCount?: unknown };
  responseId?: unknown;
  modelVersion?: unknown;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface ParsedGemini {
  status: "ok" | "incomplete" | "failed";
  text: string | null;
  grounded: boolean;
  citations: GeoCitation[];
  searchQueries: string[] | null;
  searchQueriesExposed: boolean;
  requestId: string | null;
  modelVersion: string | null;
  finishReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; searchRequests: number | null };
  error: string | null;
}

export function parseGeminiResponse(body: unknown): ParsedGemini {
  const r = (body ?? {}) as GeminiResponse;
  const cand = Array.isArray(r.candidates) ? r.candidates[0] : undefined;
  const parts = Array.isArray(cand?.content?.parts) ? cand!.content!.parts! : [];
  const textParts = parts.filter((p) => p && p.thought !== true && typeof p.text === "string").map((p) => p.text as string);
  const text = textParts.length > 0 ? textParts.join("") : null;

  const gm = cand?.groundingMetadata;
  const rawQueries = Array.isArray(gm?.webSearchQueries) ? (gm!.webSearchQueries as unknown[]) : null;
  const queries = rawQueries ? rawQueries.filter((q): q is string => typeof q === "string").map((q) => q.trim()).filter((q) => q.length > 0) : [];
  const chunks = Array.isArray(gm?.groundingChunks) ? gm!.groundingChunks! : [];

  const citations: GeoCitation[] = [];
  chunks.forEach((c, i) => {
    const uri = str(c?.web?.uri);
    if (!uri) return; // non-web chunks (maps, retrievedContext, image) are not web citations
    citations.push({ url: uri, title: str(c?.web?.title), position: i + 1 });
  });

  const grounded = queries.length > 0 || chunks.length > 0;
  const searchQueriesExposed = gm !== undefined && gm !== null && rawQueries !== null;
  const searchQueries = searchQueriesExposed ? [...new Set(queries)] : null;

  const u = r.usageMetadata ?? {};
  const candidates = num(u.candidatesTokenCount);
  const thoughts = num(u.thoughtsTokenCount);
  // Output price on the pricing page includes thinking tokens, so bill candidates + thoughts.
  const outputTokens = candidates === null && thoughts === null ? null : (candidates ?? 0) + (thoughts ?? 0);
  const usage = {
    inputTokens: num(u.promptTokenCount),
    outputTokens,
    searchRequests: gm ? new Set(queries).size : 0,
  };

  const finishReason = str(cand?.finishReason);
  const blockReason = str(r.promptFeedback?.blockReason);
  let status: ParsedGemini["status"] = "ok";
  let error: string | null = null;
  if (!cand) {
    status = "failed";
    error = blockReason ? `Gemini returned no candidates (prompt blocked: ${blockReason}).` : "Gemini returned no candidates.";
  } else if (finishReason !== null && finishReason !== "STOP") {
    status = "incomplete";
    error = `Gemini finishReason ${finishReason}.`;
  } else if (text === null) {
    status = "incomplete";
    error = "Gemini returned no answer text.";
  }

  return {
    status,
    text,
    grounded,
    citations,
    searchQueries,
    searchQueriesExposed,
    requestId: str(r.responseId),
    modelVersion: str(r.modelVersion),
    finishReason,
    usage,
    error,
  };
}

// ------------------------------------------------------------------ provider

export function createGeminiProvider(config: GeminiProviderConfig): GeoProviderAdapter {
  const model = config.model.trim().replace(/^models\//, "");
  const maxOutputTokens = config.maxOutputTokens ?? GEMINI_DEFAULT_MAX_OUTPUT_TOKENS;
  const samplingOptions = { maxOutputTokens };
  const headers = { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" };

  const base = (): Omit<GeoAnswerWithOutcome, "status" | "outcome" | "latencyMs"> => ({
    provider: "gemini",
    model,
    groundingMode: GEMINI_GROUNDING_MODE,
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
    id: "gemini",
    label: "Gemini API with Google Search grounding",
    model,
    groundingMode: GEMINI_GROUNDING_MODE,
    samplingOptions,

    async ask(prompt, opts) {
      if (!config.apiKey || !isValidGeminiModelId(model)) {
        return { ...base(), status: "failed", outcome: "not_sent", error: "Gemini is not configured (API key or model id missing).", latencyMs: 0 };
      }
      const instruction = neutralInstruction(opts.locale, opts.language);
      const body: Record<string, unknown> = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens },
      };
      if (instruction) body.systemInstruction = { parts: [{ text: instruction }] };

      const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
      const res = await sendJson(config.fetchImpl, url, { method: "POST", headers, body, signal: opts.signal }, config.apiKey, "Gemini", config.timeoutMs);
      if (res.kind !== "ok") {
        return { ...base(), status: "failed", outcome: res.outcome, error: res.error, latencyMs: res.latencyMs };
      }
      const p = parseGeminiResponse(res.body);
      const cost = resolveCost("gemini", model, p.usage, null, { grounded: p.grounded, at: (config.now ?? (() => new Date()))() });
      return {
        ...base(),
        status: p.status,
        outcome: "ok",
        grounded: p.grounded,
        text: p.text,
        citations: p.citations,
        searchQueries: p.searchQueries,
        searchQueriesExposed: p.searchQueriesExposed,
        requestId: p.requestId,
        usage: p.usage,
        costUsd: cost.costUsd,
        costIsEstimate: cost.costIsEstimate,
        rateVersion: cost.rateVersion,
        error: p.error,
        finishReason: p.finishReason,
        latencyMs: res.latencyMs,
      };
    },

    async test() {
      if (!config.apiKey || !isValidGeminiModelId(model)) return { ok: false, detail: "Gemini API key or model id is not configured." };
      const res = await sendJson(config.fetchImpl, `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}`, { method: "GET", headers: { "x-goog-api-key": config.apiKey } }, config.apiKey, "Gemini", 12_000);
      if (res.kind === "ok") return { ok: true, detail: `Gemini key accepted; model ${model} is available.` };
      return { ok: false, detail: res.error };
    },
  };
}
