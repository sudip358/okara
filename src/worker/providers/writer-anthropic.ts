/**
 * Anthropic Messages API writing provider (raw fetch; no SDK dependency in the Worker bundle).
 *
 * Contract (https://docs.claude.com/en/api/messages):
 *   POST https://api.anthropic.com/v1/messages
 *   headers: x-api-key, anthropic-version: 2023-06-01, content-type: application/json
 *   body: { model, max_tokens, system, messages: [{ role: "user", content }], output_config: { format: { type: "json_schema", schema } } }
 *   response: { id, model, content: [{ type: "text", text } | { type: "thinking", ... }], stop_reason, usage: { input_tokens, output_tokens } }
 *   request id header: request-id
 *
 * JSON output uses structured outputs (`output_config.format`), NOT a forced tool: current models
 * (Claude Opus 5.5, Sonnet 5.5, Fable 5.1) reject `tool_choice: {type: "tool"}` with HTTP 400.
 * No tools are sent at all, so the model has no tool access. Schema constraints that structured
 * outputs do not accept are stripped (toProviderSchema) and enforced client-side with zod by callers.
 * The model id comes only from WRITER_MODEL; there is no default.
 */
import type { WritingProvider, WritingRequest, WritingResult } from "./types";
import { toProviderSchema } from "../writing/schemas";
import { requestJson } from "../writing/http";
import { estimateTokens, metered, WRITER_MAX_RETRIES, WRITER_TIMEOUT_MS, WriterOutputError, type WriterHooks } from "../writing/metering";

export const ANTHROPIC_API_BASE = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicWriterConfig extends WriterHooks {
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

interface MessagesResponse {
  id?: string;
  model?: string;
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function buildAnthropicRequest(model: string, req: WritingRequest): Record<string, unknown> {
  return {
    model,
    max_tokens: req.maxOutputTokens,
    system: req.system,
    messages: [{ role: "user", content: JSON.stringify(req.input) }],
    output_config: { format: { type: "json_schema", schema: toProviderSchema(req.jsonSchema) } },
  };
}

export function parseAnthropicResponse(body: MessagesResponse, fallbackModel: string): { result: WritingResult; failure: WriterOutputError | null } {
  const usage = { inputTokens: num(body.usage?.input_tokens), outputTokens: num(body.usage?.output_tokens) };
  const model = typeof body.model === "string" && body.model ? body.model : fallbackModel;
  const base = { provider: "anthropic", model, usage };
  if (body.stop_reason === "refusal") return { result: { ...base, output: null }, failure: new WriterOutputError("The writing model declined the request.", "refusal") };
  if (body.stop_reason === "max_tokens") return { result: { ...base, output: null }, failure: new WriterOutputError("Writer output was truncated (max_tokens).", "truncated") };
  const text = (body.content ?? []).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
  if (!text.trim()) return { result: { ...base, output: null }, failure: new WriterOutputError("Writer returned no text output.", "empty") };
  try {
    return { result: { ...base, output: JSON.parse(text) }, failure: null };
  } catch {
    return { result: { ...base, output: null }, failure: new WriterOutputError("Writer output was not valid JSON.", "invalid_json") };
  }
}

export function createAnthropicWriter(cfg: AnthropicWriterConfig): WritingProvider {
  const headers = {
    "x-api-key": cfg.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
  const maxRetries = cfg.maxRetries ?? WRITER_MAX_RETRIES;
  return {
    name: "anthropic",
    model: cfg.model,
    async write(req: WritingRequest): Promise<WritingResult> {
      const body = buildAnthropicRequest(cfg.model, req);
      return metered(
        cfg,
        {
          provider: "anthropic",
          model: cfg.model,
          purpose: req.purpose,
          estimatedTokens: estimateTokens(req.system + JSON.stringify(req.input)) + req.maxOutputTokens,
          maxRetries,
        },
        async (onAttempt) => {
          const r = await requestJson({
            fetchImpl: cfg.fetchImpl,
            url: `${ANTHROPIC_API_BASE}/v1/messages`,
            headers,
            body,
            timeoutMs: cfg.timeoutMs ?? WRITER_TIMEOUT_MS,
            maxRetries,
            requestIdHeader: "request-id",
            onAttempt,
            sleep: cfg.sleep,
          });
          const parsed = parseAnthropicResponse((r.json ?? {}) as MessagesResponse, cfg.model);
          return { result: parsed.result, failure: parsed.failure, requestId: r.requestId, latencyMs: r.latencyMs };
        },
      );
    },
    /** Free check: GET /v1/models/{model} verifies both the key and the configured model id. */
    async test() {
      try {
        const fetchImpl = cfg.fetchImpl;
        const res = await fetchImpl(`${ANTHROPIC_API_BASE}/v1/models/${encodeURIComponent(cfg.model)}`, {
          method: "GET",
          headers: { "x-api-key": cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION },
        });
        if (res.ok) return { ok: true, detail: `Key accepted; model ${cfg.model} is available.` };
        if (res.status === 401 || res.status === 403) return { ok: false, detail: "Key rejected by Anthropic." };
        if (res.status === 404) return { ok: false, detail: `Model ${cfg.model} was not found for this key.` };
        return { ok: false, detail: `Anthropic returned HTTP ${res.status}.` };
      } catch (e) {
        return { ok: false, detail: `Could not reach Anthropic: ${e instanceof Error ? e.message : "unknown error"}` };
      }
    },
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
