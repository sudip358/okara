/**
 * OpenAI-compatible Chat Completions writing provider.
 *
 * Contract (https://platform.openai.com/docs/api-reference/chat/create):
 *   POST {WRITER_BASE_URL}/chat/completions   (e.g. WRITER_BASE_URL=https://api.openai.com/v1)
 *   headers: Authorization: Bearer <key>, Content-Type: application/json
 *   body: { model, messages: [{role:"system"},{role:"user"}], max_completion_tokens,
 *           response_format: { type: "json_schema", json_schema: { name, schema, strict: false } } }
 *   response: { id, model, choices: [{ message: { content, refusal? }, finish_reason }], usage: { prompt_tokens, completion_tokens } }
 *   request id header: x-request-id
 *
 * `max_completion_tokens` is "an upper bound for ... visible output tokens and reasoning tokens"
 * (openai-openapi ChatCompletion request). `reasoning_effort` (documented only "for reasoning models";
 * values none|minimal|low|medium|high|xhigh|max, not all supported by every model) is sent only when the
 * operator sets WRITER_REASONING_EFFORT, since non-reasoning models may reject it. Reasoning headroom
 * follows the same opt-in: WRITER_REASONING_HEADROOM_TOKENS extra completion tokens (default 0 when
 * WRITER_REASONING_EFFORT is unset, OPENAI_REASONING_HEADROOM_TOKENS when it is set) are added to the
 * caller's answer budget, so non-reasoning models with small output caps (e.g. 4096) are not asked for more
 * than they accept. The writer_tokens reservation uses the same total.
 *
 * `strict: false` because strict mode requires every property to be listed in `required`, which the
 * recommendation.v1 schema (optional fields) does not satisfy; callers validate every output with
 * zod regardless. No `tools` are sent. The model id comes only from WRITER_MODEL.
 */
import type { WritingProvider, WritingRequest, WritingResult } from "./types";
import { toProviderSchema } from "../writing/schemas";
import { requestJson } from "../writing/http";
import { estimateTokens, metered, WRITER_MAX_RETRIES, WRITER_TIMEOUT_MS, WriterOutputError, type WriterHooks } from "../writing/metering";

export interface OpenAiWriterConfig extends WriterHooks {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Opt-in reasoning_effort (WRITER_REASONING_EFFORT); omitted when unset. */
  reasoningEffort?: OpenAiReasoningEffort | null;
  /** Extra completion tokens for reasoning (see reasoningHeadroomTokens); defaults from reasoningEffort. */
  reasoningHeadroomTokens?: number;
  /** Replaces the env-variable advice in the truncation error (workspace custom providers have no env settings). */
  truncationHint?: string;
  /** Cap on the response body read per attempt (workspace custom providers: hosts the operator does not control). */
  maxResponseBytes?: number;
}

/**
 * Default engineering headroom for reasoning tokens on top of the caller's answer budget when
 * WRITER_REASONING_EFFORT is set (not a provider limit). 0 when it is unset.
 */
export const OPENAI_REASONING_HEADROOM_TOKENS = 4000;
/** Upper bound accepted for WRITER_REASONING_HEADROOM_TOKENS (engineering sanity cap, not a provider limit). */
export const OPENAI_REASONING_HEADROOM_MAX = 100_000;
export const OPENAI_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

/** Parse WRITER_REASONING_EFFORT; unset or unknown values -> null (parameter not sent). */
export function parseReasoningEffort(raw: string | undefined | null): OpenAiReasoningEffort | null {
  const v = (raw ?? "").trim().toLowerCase();
  return (OPENAI_REASONING_EFFORTS as readonly string[]).includes(v) ? (v as OpenAiReasoningEffort) : null;
}

/** Parse WRITER_REASONING_HEADROOM_TOKENS: a whole number 0..OPENAI_REASONING_HEADROOM_MAX, else null (use the default). */
export function parseReasoningHeadroom(raw: string | undefined | null): number | null {
  const v = (raw ?? "").trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n <= OPENAI_REASONING_HEADROOM_MAX ? n : null;
}

/** Headroom to add: explicit WRITER_REASONING_HEADROOM_TOKENS wins; else 4000 with an effort set, 0 without. */
export function reasoningHeadroomTokens(reasoningEffort: OpenAiReasoningEffort | null, rawHeadroom?: string | null): number {
  return parseReasoningHeadroom(rawHeadroom) ?? (reasoningEffort ? OPENAI_REASONING_HEADROOM_TOKENS : 0);
}

/** max_completion_tokens sent, and the completion part of the writer_tokens reservation. */
export const openAiCompletionBudget = (maxOutputTokens: number, headroomTokens = 0) => maxOutputTokens + Math.max(0, headroomTokens);

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function normalizeBaseUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== "https:") throw new Error("WRITER_BASE_URL must use https.");
  return u.toString().replace(/\/+$/, "");
}

export function buildOpenAiRequest(
  model: string,
  req: WritingRequest,
  reasoningEffort: OpenAiReasoningEffort | null = null,
  headroomTokens: number = reasoningHeadroomTokens(reasoningEffort),
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: JSON.stringify(req.input) },
    ],
    max_completion_tokens: openAiCompletionBudget(req.maxOutputTokens, headroomTokens),
    response_format: {
      type: "json_schema",
      json_schema: { name: req.purpose, schema: toProviderSchema(req.jsonSchema), strict: false },
    },
  };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  return body;
}

export interface OpenAiLimitInfo {
  /** max_completion_tokens that was sent. */
  maxCompletionTokens?: number;
  /** Reasoning headroom included in it. */
  headroomTokens?: number;
  reasoningEffort?: OpenAiReasoningEffort | null;
  /** Advice appended to the truncation error instead of the WRITER_REASONING_* hint. */
  hint?: string;
}

function truncationMessage(outputTokens: number, limit: OpenAiLimitInfo): string {
  const cap = limit.maxCompletionTokens !== undefined ? `max_completion_tokens ${limit.maxCompletionTokens}` : "max_completion_tokens";
  const parts = [`hit ${cap}`];
  if (limit.headroomTokens !== undefined) parts.push(`including ${limit.headroomTokens} reasoning headroom tokens`);
  if (outputTokens) parts.push(`${outputTokens} completion tokens used, reasoning tokens included`);
  const hint = limit.hint
    ? limit.hint
    : limit.reasoningEffort
    ? `The model spent the budget reasoning at WRITER_REASONING_EFFORT=${limit.reasoningEffort}: lower it (e.g. low or minimal) or raise WRITER_REASONING_HEADROOM_TOKENS.`
    : "If WRITER_MODEL is a reasoning model, set WRITER_REASONING_EFFORT (e.g. low), which also adds reasoning headroom (WRITER_REASONING_HEADROOM_TOKENS); otherwise use a non-reasoning model.";
  return `Writer output was truncated: finish_reason "length" (${parts.join("; ")}). ${hint}`;
}

export function parseOpenAiResponse(body: ChatResponse, fallbackModel: string, limit: OpenAiLimitInfo = {}): { result: WritingResult; failure: WriterOutputError | null } {
  const usage = { inputTokens: num(body.usage?.prompt_tokens), outputTokens: num(body.usage?.completion_tokens) };
  const model = typeof body.model === "string" && body.model ? body.model : fallbackModel;
  const base = { provider: "openai_compatible", model, usage };
  const choice = body.choices?.[0];
  if (choice?.message?.refusal) return { result: { ...base, output: null }, failure: new WriterOutputError("The writing model declined the request.", "refusal") };
  if (choice?.finish_reason === "length") return { result: { ...base, output: null }, failure: new WriterOutputError(truncationMessage(usage.outputTokens, limit), "truncated") };
  const text = choice?.message?.content ?? "";
  if (!text.trim()) return { result: { ...base, output: null }, failure: new WriterOutputError("Writer returned no content.", "empty") };
  try {
    return { result: { ...base, output: JSON.parse(text) }, failure: null };
  } catch {
    return { result: { ...base, output: null }, failure: new WriterOutputError("Writer output was not valid JSON.", "invalid_json") };
  }
}

export function createOpenAiCompatibleWriter(cfg: OpenAiWriterConfig): WritingProvider {
  const base = normalizeBaseUrl(cfg.baseUrl);
  const headers = { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };
  const maxRetries = cfg.maxRetries ?? WRITER_MAX_RETRIES;
  const reasoningEffort = cfg.reasoningEffort ?? null;
  const headroomTokens = Math.max(0, cfg.reasoningHeadroomTokens ?? reasoningHeadroomTokens(reasoningEffort));
  return {
    name: "openai_compatible",
    model: cfg.model,
    async write(req: WritingRequest): Promise<WritingResult> {
      const body = buildOpenAiRequest(cfg.model, req, reasoningEffort, headroomTokens);
      const maxCompletionTokens = openAiCompletionBudget(req.maxOutputTokens, headroomTokens);
      return metered(
        cfg,
        {
          provider: "openai_compatible",
          model: cfg.model,
          purpose: req.purpose,
          estimatedTokens: estimateTokens(req.system + JSON.stringify(req.input)) + maxCompletionTokens,
          maxRetries,
        },
        async (onAttempt) => {
          const r = await requestJson({
            fetchImpl: cfg.fetchImpl,
            url: `${base}/chat/completions`,
            headers,
            body,
            timeoutMs: cfg.timeoutMs ?? WRITER_TIMEOUT_MS,
            maxRetries,
            requestIdHeader: "x-request-id",
            onAttempt,
            sleep: cfg.sleep,
            maxResponseBytes: cfg.maxResponseBytes,
            // An error body may echo the key in a format redact() does not know; never store it.
            secrets: [cfg.apiKey],
          });
          const parsed = parseOpenAiResponse((r.json ?? {}) as ChatResponse, cfg.model, { maxCompletionTokens, headroomTokens, reasoningEffort, hint: cfg.truncationHint });
          return { result: parsed.result, failure: parsed.failure, requestId: r.requestId, latencyMs: r.latencyMs };
        },
      );
    },
    /** Free check: GET {base}/models (no inference). */
    async test() {
      try {
        const fetchImpl = cfg.fetchImpl;
        const res = await fetchImpl(`${base}/models`, { method: "GET", headers: { Authorization: `Bearer ${cfg.apiKey}` } });
        if (res.ok) return { ok: true, detail: "Key accepted by the OpenAI-compatible endpoint." };
        if (res.status === 401 || res.status === 403) return { ok: false, detail: "Key rejected by the writer endpoint." };
        return { ok: false, detail: `Writer endpoint returned HTTP ${res.status}.` };
      } catch (e) {
        return { ok: false, detail: `Could not reach the writer endpoint: ${e instanceof Error ? e.message : "unknown error"}` };
      }
    },
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
