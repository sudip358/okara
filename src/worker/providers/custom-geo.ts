/**
 * Custom GEO engine adapter (GeoProvider): a workspace custom OpenAI-compatible provider with role 'geo'
 * (platform/custom-providers.ts, geo/custom-lanes.ts). Contract: the same OpenAI-compatible Chat Completions
 * request the custom writer uses (docs/provider-contracts.md "Custom OpenAI-compatible provider"):
 *   POST {base}/chat/completions, `Authorization: Bearer <key>`,
 *   body { model, messages: [ {role:"system", content:<neutral locale instruction>}?, {role:"user", content:<prompt>} ],
 *          max_completion_tokens }
 *   response { id?, model?, choices[0].message.content, choices[0].finish_reason, usage.{prompt_tokens, completion_tokens} }
 * No tools and no web search are requested, and nothing in an OpenAI-compatible response proves a search
 * happened, so every answer is grounded = false with groundingMode "none (custom provider)", no citations
 * and no search queries (searchQueriesExposed false). Cost is unknown (null): no rate exists for an
 * arbitrary provider and none is invented. The request never mentions the brand.
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
import { CUSTOM_GEO_GROUNDING_MODE } from "../geo/custom-lanes";

export const CUSTOM_GEO_MAX_COMPLETION_TOKENS = 4096;
/** Response body cap per answer (output is already bounded by max_completion_tokens). */
export const CUSTOM_GEO_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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
  choices?: Array<{ message?: { content?: unknown; refusal?: unknown } | null; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface ParsedCustomGeo {
  status: "ok" | "incomplete" | "failed";
  text: string | null;
  model: string | null;
  requestId: string | null;
  finishReason: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  error: string | null;
}

/** Pure parse of a Chat Completions body. Text is untrusted evidence (stored as plain text only). */
export function parseCustomGeoResponse(body: unknown): ParsedCustomGeo {
  const b = (body && typeof body === "object" ? body : {}) as ChatBody;
  const choice = Array.isArray(b.choices) ? b.choices[0] : undefined;
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content : null;
  const finishReason = str(choice?.finish_reason);
  const usage = { inputTokens: num(b.usage?.prompt_tokens), outputTokens: num(b.usage?.completion_tokens) };
  // Untrusted host strings: bounded (200 characters, no control characters) or dropped.
  const base = { model: cleanModelId(b.model), requestId: cleanModelId(b.id), finishReason: cleanModelId(choice?.finish_reason), usage };
  if (!choice) return { ...base, status: "failed", text: null, error: "Custom provider returned no choices." };
  if (str(choice.message?.refusal) && !text?.trim()) return { ...base, status: "failed", text: null, error: "The custom provider's model declined to answer." };
  if (!text || !text.trim()) return { ...base, status: "failed", text: null, error: "Custom provider returned no answer text." };
  if (finishReason === "length") return { ...base, status: "incomplete", text, error: `Answer truncated: finish_reason "length" (max_completion_tokens ${CUSTOM_GEO_MAX_COMPLETION_TOKENS}).` };
  return { ...base, status: "ok", text, error: null };
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
    groundingMode: CUSTOM_GEO_GROUNDING_MODE,
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
      return answer({
        status: p.status,
        outcome: "ok",
        text: p.text,
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
