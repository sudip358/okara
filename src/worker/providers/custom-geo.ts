/**
 * Custom GEO engine adapter (GeoProvider): a workspace custom OpenAI-compatible provider with role 'geo'
 * (platform/custom-providers.ts, geo/custom-lanes.ts). Contract: the same OpenAI-compatible Chat Completions
 * request the custom writer uses (docs/provider-contracts.md "Custom OpenAI-compatible provider"):
 *   POST {base}/chat/completions, `Authorization: Bearer <key>`,
 *   body { model, messages: [ {role:"system", content:<neutral locale instruction>}?, {role:"user", content:<prompt>} ],
 *          max_completion_tokens }
 *   response { id?, model?, choices[0].message.content, choices[0].finish_reason, usage.{prompt_tokens, completion_tokens} }
 * No tool or plugin is ever requested: the owner picks a model/provider that searches by itself (e.g. an
 * OpenRouter ":online" model). Grounding (amendment 2026-10-02): an answer is grounded = true, groundingMode
 * CUSTOM_GEO_SOURCES_MODE, only when the response returns at least one valid web source in a documented
 * OpenAI-compatible shape (parseCustomGeoSources; docs/provider-contracts.md "Custom GEO engine"):
 *   (a) choices[0].message.annotations[] {type:"url_citation", url_citation:{url, title, start_index, end_index}}
 *       (OpenAI Chat Completions search models; OpenRouter web search),
 *   (b) top-level `citations: string[]` and `search_results: [{title, url, date, ...}]` (Perplexity Sonar
 *       CompletionResponse shape, also served by Perplexity-compatible APIs).
 * Otherwise grounded = false, groundingMode CUSTOM_GEO_GROUNDING_MODE ("none (custom provider)"), no
 * citations. Search queries are never exposed (null). Cost is unknown (null): no rate exists for an
 * arbitrary provider and none is invented. The request never mentions the brand. Sources are untrusted
 * evidence: URLs are validated (http/https, no credentials, <= 2048 chars, no control characters), titles are
 * plain text (<= 300 chars), deduplicated by URL (first position kept), capped at 50.
 *
 * The host is chosen by the workspace owner, not the operator: `fetchImpl` must be the guarded API fetch with
 * only that host admitted (redirects are never followed), the body read is capped, provider error bodies are
 * never stored (only the HTTP status), and the key is scrubbed from every message. The response's `model`
 * and `id` are untrusted too: every answer records the CONFIGURED model (so the cohort key, and with it the
 * trend series, is fixed by the owner's selection and not by what the host reports), and the request id is
 * kept only when it is at most 200 characters without control characters.
 */
import { readCapped } from "../lib/read-capped";
import { cleanModelId } from "../platform/custom-providers";
import type { GeoAnswerWithOutcome, GeoCallOutcome, GeoProviderAdapter } from "./rates";
import { GEO_CALL_TIMEOUT_MS, neutralInstruction, scrub } from "./rates";
import type { GeoCitation } from "./types";
import { CUSTOM_GEO_GROUNDING_MODE, CUSTOM_GEO_LANE_GROUNDING_MODE, CUSTOM_GEO_SOURCES_MODE } from "../geo/custom-lanes";

export { CUSTOM_GEO_GROUNDING_MODE, CUSTOM_GEO_SOURCES_MODE };

export const CUSTOM_GEO_MAX_COMPLETION_TOKENS = 4096;
/** Response body cap per answer (output is already bounded by max_completion_tokens). */
export const CUSTOM_GEO_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Provider-reported sources kept per answer. */
export const CUSTOM_GEO_MAX_SOURCES = 50;
export const CUSTOM_GEO_MAX_SOURCE_URL = 2048;
export const CUSTOM_GEO_MAX_SOURCE_TITLE = 300;

export interface CustomGeoProviderConfig {
  /** "custom_geo:<row id>" */
  id: string;
  label: string;
  model: string;
  /** Validated base URL (platform/custom-providers.ts validateCustomBaseUrl). */
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

interface ChatBody {
  id?: unknown;
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown; refusal?: unknown; annotations?: unknown } | null; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  /** Perplexity Sonar CompletionResponse: URLs of sources used to generate the response. */
  citations?: unknown;
  /** Perplexity Sonar CompletionResponse: search results used for context ({title, url, date, ...}). */
  search_results?: unknown;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface ParsedCustomGeo {
  status: "ok" | "incomplete" | "failed";
  text: string | null;
  /** Valid provider-reported web sources (empty when none); grounded iff non-empty. */
  citations: GeoCitation[];
  model: string | null;
  requestId: string | null;
  finishReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  error: string | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
// eslint-disable-next-line no-control-regex
const CONTROL_G = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** A provider-reported source URL, or null: http/https only, no credentials, <= 2048 chars, no control chars. */
export function cleanSourceUrl(v: unknown): { url: string; key: string } | null {
  if (typeof v !== "string") return null;
  const raw = v.trim();
  if (!raw || raw.length > CUSTOM_GEO_MAX_SOURCE_URL || CONTROL.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || !u.hostname) return null;
  if (u.href.length > CUSTOM_GEO_MAX_SOURCE_URL) return null;
  return { url: raw, key: u.href };
}

/** Plain-text title (control and bidi/zero-width characters removed, whitespace collapsed, <= 300 chars), or null. */
export function cleanSourceTitle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(CONTROL_G, " ").replace(/\s+/g, " ").trim().slice(0, CUSTOM_GEO_MAX_SOURCE_TITLE).trim();
  return t.length > 0 ? t : null;
}

/**
 * Provider-reported sources of an OpenAI-compatible Chat Completions body, in order of first appearance:
 * choices[0].message.annotations url_citation entries, then top-level `citations` (string URLs), then
 * top-level `search_results` ({url, title}). Invalid entries are dropped; duplicates (same parsed URL) keep
 * the first position (a later title fills a missing one); at most CUSTOM_GEO_MAX_SOURCES; position = 1-based
 * order of first appearance. Never fetched; untrusted evidence.
 */
export function parseCustomGeoSources(body: unknown): GeoCitation[] {
  const b = (body && typeof body === "object" ? body : {}) as ChatBody;
  const out: GeoCitation[] = [];
  const index = new Map<string, number>();
  const add = (urlValue: unknown, titleValue: unknown) => {
    const u = cleanSourceUrl(urlValue);
    if (!u) return;
    const title = cleanSourceTitle(titleValue);
    const at = index.get(u.key);
    if (at !== undefined) {
      if (out[at]!.title === null && title !== null) out[at]!.title = title;
      return;
    }
    if (out.length >= CUSTOM_GEO_MAX_SOURCES) return;
    index.set(u.key, out.length);
    out.push({ url: u.url, title, position: out.length + 1 });
  };
  const choice = Array.isArray(b.choices) ? b.choices[0] : undefined;
  const annotations = choice?.message && typeof choice.message === "object" ? choice.message.annotations : undefined;
  if (Array.isArray(annotations)) {
    for (const a of annotations) {
      if (!a || typeof a !== "object" || (a as { type?: unknown }).type !== "url_citation") continue;
      const c = (a as { url_citation?: unknown }).url_citation;
      if (!c || typeof c !== "object") continue;
      add((c as { url?: unknown }).url, (c as { title?: unknown }).title);
    }
  }
  if (Array.isArray(b.citations)) for (const c of b.citations) add(c, null);
  if (Array.isArray(b.search_results)) {
    for (const r of b.search_results) {
      if (!r || typeof r !== "object") continue;
      add((r as { url?: unknown }).url, (r as { title?: unknown }).title);
    }
  }
  return out;
}

/** Pure parse of a Chat Completions body. Text and sources are untrusted evidence (stored as plain text only). */
export function parseCustomGeoResponse(body: unknown): ParsedCustomGeo {
  const b = (body && typeof body === "object" ? body : {}) as ChatBody;
  const choice = Array.isArray(b.choices) ? b.choices[0] : undefined;
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content : null;
  const finishReason = str(choice?.finish_reason);
  const usage = { inputTokens: num(b.usage?.prompt_tokens), outputTokens: num(b.usage?.completion_tokens) };
  // Untrusted host strings: bounded (200 characters, no control characters) or dropped.
  const base = { model: cleanModelId(b.model), requestId: cleanModelId(b.id), finishReason: cleanModelId(choice?.finish_reason), usage, citations: [] as GeoCitation[] };
  if (!choice) return { ...base, status: "failed", text: null, error: "Custom provider returned no choices." };
  if (str(choice.message?.refusal) && !text?.trim()) return { ...base, status: "failed", text: null, error: "The custom provider's model declined to answer." };
  if (!text || !text.trim()) return { ...base, status: "failed", text: null, error: "Custom provider returned no answer text." };
  const citations = parseCustomGeoSources(b);
  if (finishReason === "length")
    return { ...base, citations, status: "incomplete", text, error: `Answer truncated: finish_reason "length" (max_completion_tokens ${CUSTOM_GEO_MAX_COMPLETION_TOKENS}).` };
  return { ...base, citations, status: "ok", text, error: null };
}

export function createCustomGeoProvider(cfg: CustomGeoProviderConfig): GeoProviderAdapter {
  const model = cfg.model.trim();
  const samplingOptions = { maxCompletionTokens: CUSTOM_GEO_MAX_COMPLETION_TOKENS, tools: "none" };
  const answer = (over: Partial<GeoAnswerWithOutcome> & { outcome: GeoCallOutcome; status: GeoAnswerWithOutcome["status"] }): GeoAnswerWithOutcome => ({
    provider: cfg.id,
    model,
    groundingMode: CUSTOM_GEO_GROUNDING_MODE,
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
    latencyMs: 0,
    finishReason: null,
    ...over,
  });

  return {
    id: cfg.id,
    label: cfg.label,
    model,
    // Lane-level mode (cohort key): fixed per lane; each answer records its own mode (sources or none).
    groundingMode: CUSTOM_GEO_LANE_GROUNDING_MODE,
    samplingOptions,
    async ask(prompt, opts) {
      if (!cfg.apiKey || !model) return answer({ status: "failed", outcome: "not_sent", error: "Custom GEO engine is not configured (key or model missing)." });
      const messages: Array<{ role: string; content: string }> = [];
      const instruction = neutralInstruction(opts.locale, opts.language);
      if (instruction) messages.push({ role: "system", content: instruction });
      messages.push({ role: "user", content: prompt });
      const timeoutMs = cfg.timeoutMs ?? GEO_CALL_TIMEOUT_MS;
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      const started = Date.now();
      let res: Response;
      try {
        res = await cfg.fetchImpl(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ model, messages, max_completion_tokens: CUSTOM_GEO_MAX_COMPLETION_TOKENS }),
          redirect: "manual",
          signal,
        });
      } catch (e) {
        const latencyMs = Date.now() - started;
        const name = (e as { name?: string } | null)?.name;
        if (timeout.aborted || name === "TimeoutError" || name === "AbortError") {
          return answer({ status: "failed", outcome: "timeout", error: `Custom provider request timed out after ${timeoutMs} ms.`, latencyMs });
        }
        return answer({ status: "failed", outcome: "network", error: scrub(`Custom provider network error: ${String((e as Error)?.message ?? e)}`, cfg.apiKey), latencyMs });
      }
      const discard = () => res.body?.cancel().catch(() => undefined);
      if (res.status >= 300 && res.status < 400) {
        await discard();
        return answer({ status: "failed", outcome: "rejected", error: `Custom provider answered with a redirect (HTTP ${res.status}); not followed.`, latencyMs: Date.now() - started });
      }
      if (!res.ok) {
        await discard();
        // The provider's error body is never stored: an owner-chosen host may echo request data or the key.
        return answer({
          status: "failed",
          outcome: res.status >= 500 ? "server_error" : "rejected",
          error: `Custom provider returned HTTP ${res.status}.`,
          latencyMs: Date.now() - started,
        });
      }
      let text: string | null;
      try {
        text = await readCapped(res, CUSTOM_GEO_MAX_RESPONSE_BYTES);
      } catch {
        return answer({ status: "failed", outcome: "network", error: "Custom provider response could not be read (network error or timeout).", latencyMs: Date.now() - started });
      }
      const latencyMs = Date.now() - started;
      if (text === null) return answer({ status: "failed", outcome: "server_error", error: "Custom provider response is too large.", latencyMs });
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return answer({ status: "failed", outcome: "server_error", error: "Custom provider returned a non-JSON response body.", latencyMs });
      }
      const p = parseCustomGeoResponse(json);
      // Grounded only with at least one valid provider-reported source (never for a failed answer).
      const grounded = p.status !== "failed" && p.citations.length > 0;
      return answer({
        status: p.status,
        outcome: "ok",
        text: p.text,
        grounded,
        groundingMode: grounded ? CUSTOM_GEO_SOURCES_MODE : CUSTOM_GEO_GROUNDING_MODE,
        citations: grounded ? p.citations : [],
        // The configured model, never the host-reported one (see the header).
        model,
        requestId: p.requestId,
        usage: { inputTokens: p.usage.inputTokens, outputTokens: p.usage.outputTokens, searchRequests: null },
        error: p.error ? scrub(p.error, cfg.apiKey) : null,
        finishReason: p.finishReason,
        latencyMs,
      });
    },
    /** Free check: the model list (no inference); routes/custom-providers.ts runs the same test. */
    async test() {
      return { ok: true, detail: "Use the custom provider's Test button on the Integrations page." };
    },
  };
}
