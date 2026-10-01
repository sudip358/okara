/**
 * Versioned cost-estimate rates for GEO answer engines, plus the budget-accounting helpers the GEO
 * batch uses around each provider call.
 *
 * Every number here was read from the provider's official pricing page (Gemini and Perplexity on
 * 2026-09-30; OpenAI and Claude re-verified live on 2026-10-01, values unchanged):
 *   - Gemini API pricing (Standard, paid tier): https://ai.google.dev/gemini-api/docs/pricing
 *     Grounding billing semantics: https://ai.google.dev/gemini-api/docs/google-search#pricing
 *   - Perplexity Agent API pricing: https://docs.perplexity.ai/docs/getting-started/pricing
 *     and https://docs.perplexity.ai/docs/agent-api/tools/web-search#pricing
 *   - OpenAI API pricing (Standard tier text tokens; "Tools" table for web search):
 *     https://developers.openai.com/api/docs/pricing#built-in-tools
 *   - Claude API pricing (model tokens; "Web search tool" section):
 *     https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Rules:
 *   - Unknown provider/model -> costUsd null (never 0) and costIsEstimate true.
 *   - An actual cost returned by the provider (Perplexity `usage.cost.total_cost`) wins over any
 *     estimate and is recorded with costIsEstimate false.
 *   - Estimates use list prices of the paid Standard tier and ignore free allowances (Gemini 3.x:
 *     5,000 free search requests per month shared across models; Gemini 2.5: 1,500 free grounded
 *     prompts per day). Estimates are therefore conservative upper bounds of list price, not invoices.
 *   - Gemini 3.x bills grounding per executed (non-empty, unique) search query; Gemini 2.5 bills per
 *     grounded prompt. Perplexity bills `web_search` per invocation. OpenAI bills the `web_search` tool
 *     per search call ($10 / 1k) plus search content tokens at model rates (already inside
 *     `usage.input_tokens`; gpt-4.1-mini instead bills a fixed 8,000-token block per call, added here on top,
 *     so the estimate is an upper bound). Anthropic bills $10 per 1,000 web searches
 *     (`usage.server_tool_use.web_search_requests`; errored searches are not billed) plus tokens.
 *   - Cached-input discounts are ignored (every input token is priced at the full input rate): upper bound.
 *   - Rates that change on a documented date carry validFrom/validUntil; outside every window the
 *     model is treated as unknown (null) until this table is re-verified and RATE_VERSION bumped.
 */

import type { GeoAnswer, GeoProvider } from "./types";

/** Bump whenever a value below changes. Stored on provider_calls.rate_version. */
export const RATE_VERSION = "geo-rates-2026-09-30.2";

export interface CostUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * Billable search units: Gemini 3.x = executed queries; Gemini 2.5 = grounded prompts; Perplexity = web_search
   * invocations; OpenAI = web_search_call items with action.type "search"; Anthropic = web_search_requests.
   */
  searchRequests: number | null;
}

type SearchBilling = "per_search_query" | "per_grounded_prompt" | "per_invocation" | "none";

export type RatedProvider = "gemini" | "perplexity" | "openai_geo" | "anthropic_geo";

interface RateEntry {
  provider: RatedProvider;
  /** Exact model id as sent to the provider. */
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** Optional long-prompt tier (Gemini Pro models: prompts > 200k tokens). */
  longPrompt?: { thresholdTokens: number; inputPerMTok: number; outputPerMTok: number };
  searchBilling: SearchBilling;
  searchUsd: number;
  /** Extra input tokens billed per search unit (OpenAI gpt-4.1-mini: fixed 8,000-token search content block). */
  fixedSearchInputTokens?: number;
  /** The listed price applies only up to this many input tokens; above it the cost is unknown (null). */
  maxPricedInputTokens?: number;
  /** Inclusive UTC days (YYYY-MM-DD). */
  validFrom?: string;
  validUntil?: string;
  source: string;
}

const GEMINI_PRICING = "https://ai.google.dev/gemini-api/docs/pricing";
const PPLX_PRICING = "https://docs.perplexity.ai/docs/getting-started/pricing";
/** Gemini 3.x grounding: "5,000 free search requests per month ..., then $14 per 1,000 requests." */
const GEMINI3_SEARCH_USD = 14 / 1000;
/** Gemini 2.5 grounding: "... then $35 / 1,000 grounded prompts". */
const GEMINI25_GROUNDED_PROMPT_USD = 35 / 1000;
/** Perplexity `web_search`: "$2.50 per 1,000 invocations" (standard `search_type: "web"`). */
const PPLX_WEB_SEARCH_USD = 2.5 / 1000;
const OPENAI_PRICING = "https://developers.openai.com/api/docs/pricing";
const ANTHROPIC_PRICING = "https://platform.claude.com/docs/en/about-claude/pricing";
/** OpenAI Responses `web_search` (all models, non-preview): "$10.00 / 1k calls + search content tokens billed at model rates". */
const OPENAI_WEB_SEARCH_USD = 10 / 1000;
/** OpenAI: "For gpt-4o-mini and gpt-4.1-mini ... search content tokens are billed as a fixed block of 8,000 input tokens per call." */
const OPENAI_MINI_FIXED_SEARCH_TOKENS = 8_000;
/** Anthropic web search: "$10 per 1,000 searches plus standard token costs". */
const ANTHROPIC_WEB_SEARCH_USD = 10 / 1000;

function openai(model: string, inputPerMTok: number, outputPerMTok: number, extra: Partial<RateEntry> = {}): RateEntry {
  return { provider: "openai_geo", model, inputPerMTok, outputPerMTok, searchBilling: "per_invocation", searchUsd: OPENAI_WEB_SEARCH_USD, source: OPENAI_PRICING, ...extra };
}
function anthropic(model: string, inputPerMTok: number, outputPerMTok: number): RateEntry {
  return { provider: "anthropic_geo", model, inputPerMTok, outputPerMTok, searchBilling: "per_invocation", searchUsd: ANTHROPIC_WEB_SEARCH_USD, source: ANTHROPIC_PRICING };
}

function gemini3(model: string, inputPerMTok: number, outputPerMTok: number, extra: Partial<RateEntry> = {}): RateEntry {
  return { provider: "gemini", model, inputPerMTok, outputPerMTok, searchBilling: "per_search_query", searchUsd: GEMINI3_SEARCH_USD, source: GEMINI_PRICING, ...extra };
}
function gemini25(model: string, inputPerMTok: number, outputPerMTok: number, extra: Partial<RateEntry> = {}): RateEntry {
  return { provider: "gemini", model, inputPerMTok, outputPerMTok, searchBilling: "per_grounded_prompt", searchUsd: GEMINI25_GROUNDED_PROMPT_USD, source: GEMINI_PRICING, ...extra };
}

/** Standard tier, paid, text input. Verified 2026-09-30. */
export const RATES: readonly RateEntry[] = [
  // Gemini 3.8 / 3.7 / 3.6 Flash: promotional price through 2026-12-31, then doubled from 2027-01-01.
  ...["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"].flatMap((m) => [
    gemini3(m, 0.75, 3.75, { validUntil: "2026-12-31" }),
    gemini3(m, 1.5, 7.5, { validFrom: "2027-01-01" }),
  ]),
  gemini3("gemini-3.5-flash", 1.5, 9.0),
  gemini3("gemini-3.5-flash-lite", 0.3, 2.5),
  gemini3("gemini-3.1-flash-lite", 0.25, 1.5),
  gemini3("gemini-3-flash-preview", 0.5, 3.0),
  gemini3("gemini-3.1-pro-preview", 2.0, 12.0, { longPrompt: { thresholdTokens: 200_000, inputPerMTok: 4.0, outputPerMTok: 18.0 } }),
  gemini25("gemini-2.5-pro", 1.25, 10.0, { longPrompt: { thresholdTokens: 200_000, inputPerMTok: 2.5, outputPerMTok: 15.0 } }),
  gemini25("gemini-2.5-flash", 0.3, 2.5),
  gemini25("gemini-2.5-flash-lite", 0.1, 0.4),
  // Perplexity Agent API model "perplexity/sonar": $0.25 input / $2.50 output per 1M tokens.
  { provider: "perplexity", model: "perplexity/sonar", inputPerMTok: 0.25, outputPerMTok: 2.5, searchBilling: "per_invocation", searchUsd: PPLX_WEB_SEARCH_USD, source: PPLX_PRICING },
  // OpenAI Standard tier text-token rates (pricing page, read 2026-09-30, re-verified 2026-10-01);
  // web_search support per the web_search guide varies by model and is not implied by this table.
  // gpt-5.5: the listed price is for prompts < 272K tokens; the long-context price was not verified -> unknown above it.
  openai("gpt-5.5", 5.0, 30.0, { maxPricedInputTokens: 272_000 }),
  openai("gpt-5", 1.25, 10.0),
  openai("gpt-5-mini", 0.25, 2.0),
  openai("gpt-4.1", 2.0, 8.0),
  openai("gpt-4.1-mini", 0.4, 1.6, { fixedSearchInputTokens: OPENAI_MINI_FIXED_SEARCH_TOKENS }),
  // Claude API first-party base input/output rates (verified live on
  // platform.claude.com/docs/en/about-claude/pricing 2026-10-01; web search $10 per 1,000 searches).
  anthropic("claude-opus-5-5", 4.0, 20.0),
  anthropic("claude-opus-5", 5.0, 25.0),
  anthropic("claude-opus-4-8", 5.0, 25.0),
  anthropic("claude-sonnet-5-5", 2.0, 10.0),
  anthropic("claude-sonnet-5", 2.0, 10.0),
  anthropic("claude-sonnet-4-6", 3.0, 15.0),
  anthropic("claude-haiku-4-5", 1.0, 5.0),
];

function normalizeModel(provider: string, model: string): string {
  const m = model.trim();
  return provider === "gemini" ? m.replace(/^models\//, "") : m;
}

export function findRate(provider: string, model: string, at: Date = new Date()): RateEntry | null {
  const day = at.toISOString().slice(0, 10);
  const id = normalizeModel(provider, model);
  return (
    RATES.find(
      (r) =>
        r.provider === provider &&
        r.model === id &&
        (r.validFrom === undefined || day >= r.validFrom) &&
        (r.validUntil === undefined || day <= r.validUntil),
    ) ?? null
  );
}

export interface CostEstimate {
  costUsd: number | null;
  costIsEstimate: boolean;
  rateVersion: string | null;
}

/**
 * Estimate the list-price cost of one call from usage. Returns null cost when the model has no
 * verified rate or when a billable usage component is unknown (never a silent 0).
 */
export function estimateCost(provider: string, model: string, usage: CostUsage, opts: { grounded?: boolean; at?: Date } = {}): CostEstimate {
  const rate = findRate(provider, model, opts.at);
  if (!rate) return { costUsd: null, costIsEstimate: true, rateVersion: null };
  const { inputTokens, outputTokens, searchRequests } = usage;
  if (inputTokens === null || outputTokens === null) return { costUsd: null, costIsEstimate: true, rateVersion: RATE_VERSION };

  if (rate.maxPricedInputTokens !== undefined && inputTokens > rate.maxPricedInputTokens) return { costUsd: null, costIsEstimate: true, rateVersion: RATE_VERSION };
  const long = rate.longPrompt && inputTokens > rate.longPrompt.thresholdTokens ? rate.longPrompt : null;
  const inPer = long ? long.inputPerMTok : rate.inputPerMTok;
  const outPer = long ? long.outputPerMTok : rate.outputPerMTok;
  let usd = (inputTokens * inPer + outputTokens * outPer) / 1_000_000;

  switch (rate.searchBilling) {
    case "per_search_query":
    case "per_invocation":
      if (searchRequests === null) return { costUsd: null, costIsEstimate: true, rateVersion: RATE_VERSION };
      usd += searchRequests * rate.searchUsd;
      if (rate.fixedSearchInputTokens) usd += (searchRequests * rate.fixedSearchInputTokens * inPer) / 1_000_000;
      break;
    case "per_grounded_prompt": {
      const grounded = opts.grounded ?? (searchRequests === null ? null : searchRequests > 0);
      if (grounded === null) return { costUsd: null, costIsEstimate: true, rateVersion: RATE_VERSION };
      if (grounded) usd += rate.searchUsd;
      break;
    }
    case "none":
      break;
  }
  return { costUsd: roundUsd(usd), costIsEstimate: true, rateVersion: RATE_VERSION };
}

/** Prefer a provider-reported actual cost; otherwise fall back to the versioned estimate. */
export function resolveCost(provider: string, model: string, usage: CostUsage, actualUsd: number | null | undefined, opts: { grounded?: boolean; at?: Date } = {}): CostEstimate {
  if (typeof actualUsd === "number" && Number.isFinite(actualUsd) && actualUsd >= 0) {
    return { costUsd: roundUsd(actualUsd), costIsEstimate: false, rateVersion: null };
  }
  return estimateCost(provider, model, usage, opts);
}

function roundUsd(usd: number): number {
  return Math.round(usd * 1e8) / 1e8;
}

// ------------------------------------------------------------------ budget helpers

/**
 * Usage envelope used for the pre-call usd_micros reservation. These are engineering bounds for a
 * single short buyer prompt, not provider limits: the reservation only has to cover in-flight calls
 * and is settled to the actual/estimated cost afterwards (settle may exceed the reservation).
 */
export const RESERVATION_ENVELOPE = {
  inputTokens: 8_000,
  outputTokens: 8_192,
  /** Gemini 3.x executed-query allowance per call used for the bound. */
  geminiSearchQueries: 5,
  /** Perplexity web_search invocations per call used for the bound (direct model, max_steps default 1). */
  perplexitySearchInvocations: 2,
  /** OpenAI web_search calls per response used for the bound (tool_choice auto; reasoning models may search repeatedly). */
  openaiSearchCalls: 5,
  /** Anthropic searches per answer: max_uses (3) for the request plus one bounded pause_turn continuation. */
  anthropicSearches: 6,
} as const;

/** Reserved when no verified rate exists; a guard amount, not a price. Settled in full if cost stays unknown. */
export const UNKNOWN_RATE_RESERVE_USD_MICROS = 150_000;

export function reservationMicros(provider: string, model: string, at: Date = new Date()): number {
  const rate = findRate(provider, model, at);
  if (!rate) return UNKNOWN_RATE_RESERVE_USD_MICROS;
  const searches =
    rate.searchBilling === "per_search_query" ? RESERVATION_ENVELOPE.geminiSearchQueries
    : rate.searchBilling === "per_invocation"
      ? rate.provider === "openai_geo" ? RESERVATION_ENVELOPE.openaiSearchCalls
      : rate.provider === "anthropic_geo" ? RESERVATION_ENVELOPE.anthropicSearches
      : RESERVATION_ENVELOPE.perplexitySearchInvocations
    : rate.searchBilling === "per_grounded_prompt" ? 1
    : 0;
  const est = estimateCost(provider, model, { inputTokens: RESERVATION_ENVELOPE.inputTokens, outputTokens: RESERVATION_ENVELOPE.outputTokens, searchRequests: searches }, { grounded: true, at });
  return est.costUsd === null ? UNKNOWN_RATE_RESERVE_USD_MICROS : usdToMicros(est.costUsd);
}

export function usdToMicros(usd: number): number {
  return Math.ceil(usd * 1_000_000 - 1e-6);
}

/**
 * How a provider call ended, for budget accounting. Adapters in this folder attach it to the
 * GeoAnswer they return (see `GeoAnswerWithOutcome`); answers without it are treated as "unknown".
 *   ok          request completed and a response body was parsed
 *   not_sent    certainly never reached the provider (e.g. invalid local config) -> release
 *   rejected    provider answered with a definite client-side rejection (4xx incl. 429) -> not billed
 *   server_error provider answered 5xx; billing unknown -> keep reservation (markUnknown)
 *   timeout     aborted after send -> keep reservation (markUnknown)
 *   network     transport error, may or may not have been sent -> keep reservation (markUnknown)
 */
export type GeoCallOutcome = "ok" | "not_sent" | "rejected" | "server_error" | "timeout" | "network";

/** GeoAnswer plus accounting metadata returned by the adapters in this folder and consumed by runGeoBatch. */
export type GeoAnswerWithOutcome = GeoAnswer & {
  outcome: GeoCallOutcome;
  /** true when the provider response carried a search-query field (even if empty); false = "not exposed". */
  searchQueriesExposed: boolean;
  finishReason?: string | null;
};

/** The adapters in this folder: a GeoProvider whose answers carry accounting metadata. */
export interface GeoProviderAdapter extends GeoProvider {
  /** Request options that can change answers; part of the cohort key. */
  readonly samplingOptions: Record<string, unknown>;
  ask(prompt: string, opts: { locale: string; language: string; signal?: AbortSignal }): Promise<GeoAnswerWithOutcome>;
}

export function outcomeOf(answer: unknown): GeoCallOutcome | null {
  const o = (answer as { outcome?: unknown } | null)?.outcome;
  return o === "ok" || o === "not_sent" || o === "rejected" || o === "server_error" || o === "timeout" || o === "network" ? o : null;
}

// ------------------------------------------------------------------ shared adapter transport

export const GEO_CALL_TIMEOUT_MS = 30_000;

export type TransportResult =
  | { kind: "ok"; status: number; body: unknown; latencyMs: number }
  | { kind: "http_error"; status: number; outcome: "rejected" | "server_error"; error: string; latencyMs: number }
  | { kind: "exception"; outcome: "timeout" | "network"; error: string; latencyMs: number };

/**
 * POST/GET JSON with a hard timeout. Never includes request headers (credentials) in errors;
 * provider error text is scrubbed of the key and truncated.
 */
export async function sendJson(
  fetchImpl: typeof fetch,
  url: string,
  init: { method: "POST" | "GET"; headers: Record<string, string>; body?: unknown; signal?: AbortSignal },
  secret: string,
  label: string,
  timeoutMs = GEO_CALL_TIMEOUT_MS,
): Promise<TransportResult> {
  const started = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
  } catch (e) {
    const latencyMs = Date.now() - started;
    const name = (e as { name?: string } | null)?.name;
    if (timeout.aborted || name === "TimeoutError") return { kind: "exception", outcome: "timeout", error: `${label} request timed out after ${timeoutMs} ms.`, latencyMs };
    if (name === "AbortError") return { kind: "exception", outcome: "timeout", error: `${label} request was aborted.`, latencyMs };
    return { kind: "exception", outcome: "network", error: `${label} network error: ${scrub(String((e as Error)?.message ?? e), secret)}`, latencyMs };
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    // body unreadable; keep empty
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const detail = providerErrorDetail(text);
    return {
      kind: "http_error",
      status: res.status,
      outcome: res.status >= 500 ? "server_error" : "rejected",
      error: scrub(`${label} HTTP ${res.status}${detail ? `: ${detail}` : ""}`, secret),
      latencyMs,
    };
  }
  try {
    return { kind: "ok", status: res.status, body: JSON.parse(text) as unknown, latencyMs };
  } catch {
    // The provider accepted and processed the request but the body is not JSON: treat billing as unknown.
    return { kind: "http_error", status: res.status, outcome: "server_error", error: `${label} returned a non-JSON response body.`, latencyMs };
  }
}

/** Extract `error.status`/`error.code` and a short message from a JSON error body (Google and Perplexity shapes). */
function providerErrorDetail(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { status?: unknown; code?: unknown; type?: unknown; message?: unknown } };
    const e = j?.error;
    if (!e || typeof e !== "object") return "";
    const tag = [e.status, e.type, e.code].find((v) => typeof v === "string" && v.length > 0) as string | undefined;
    const msg = typeof e.message === "string" ? e.message : "";
    return [tag, msg].filter(Boolean).join(" - ").slice(0, 300);
  } catch {
    return "";
  }
}

/** Remove the secret (and anything that looks like a key query param) from a message. */
export function scrub(message: string, secret: string): string {
  let out = message;
  if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  out = out.replace(/([?&](?:key|api_key|apikey)=)[^&\s]+/gi, "$1[redacted]");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, "$1[redacted]");
  return out.slice(0, 500);
}

/** Locale/language strings go into provider instructions; accept only BCP-47-like tokens. */
export function safeLocaleToken(value: string | undefined | null): string | null {
  const v = (value ?? "").trim();
  return /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/.test(v) ? v : null;
}

/** Neutral instruction: never mentions the brand, only the audience locale/language. */
export function neutralInstruction(locale: string, language: string): string | null {
  const loc = safeLocaleToken(locale);
  const lang = safeLocaleToken(language);
  if (!loc && !lang) return null;
  if (loc && lang) return `Answer as you normally would for a user in ${loc}, writing in language "${lang}".`;
  return `Answer as you normally would for a user in ${loc ?? lang}.`;
}
