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
}

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

export function buildOpenAiRequest(model: string, req: WritingRequest): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: JSON.stringify(req.input) },
    ],
    max_completion_tokens: req.maxOutputTokens,
    response_format: {
      type: "json_schema",
      json_schema: { name: req.purpose, schema: toProviderSchema(req.jsonSchema), strict: false },
    },
  };
}

export function parseOpenAiResponse(body: ChatResponse, fallbackModel: string): { result: WritingResult; failure: WriterOutputError | null } {
  const usage = { inputTokens: num(body.usage?.prompt_tokens), outputTokens: num(body.usage?.completion_tokens) };
  const model = typeof body.model === "string" && body.model ? body.model : fallbackModel;
  const base = { provider: "openai_compatible", model, usage };
  const choice = body.choices?.[0];
  if (choice?.message?.refusal) return { result: { ...base, output: null }, failure: new WriterOutputError("The writing model declined the request.", "refusal") };
  if (choice?.finish_reason === "length") return { result: { ...base, output: null }, failure: new WriterOutputError("Writer output was truncated (length).", "truncated") };
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
  return {
    name: "openai_compatible",
    model: cfg.model,
    async write(req: WritingRequest): Promise<WritingResult> {
      const body = buildOpenAiRequest(cfg.model, req);
      return metered(
        cfg,
        {
          provider: "openai_compatible",
          model: cfg.model,
          purpose: req.purpose,
          estimatedTokens: estimateTokens(req.system + JSON.stringify(req.input)) + req.maxOutputTokens,
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
          });
          const parsed = parseOpenAiResponse((r.json ?? {}) as ChatResponse, cfg.model);
          return { result: parsed.result, failure: parsed.failure, requestId: r.requestId, latencyMs: r.latencyMs };
        },
      );
    },
    /** Free check: GET {base}/models (no inference). */
    async test() {
      try {
        const res = await cfg.fetchImpl(`${base}/models`, { method: "GET", headers: { Authorization: `Bearer ${cfg.apiKey}` } });
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
