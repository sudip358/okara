/**
 * Ask Okara chat model over an OpenAI-compatible Chat Completions endpoint with function tools
 * (the default writer with WRITER_PROVIDER=openai_compatible, or the workspace's custom writer).
 *
 * Contract (https://platform.openai.com/docs/api-reference/chat/create,
 * https://platform.openai.com/docs/guides/function-calling):
 *   POST {base}/chat/completions
 *   body: { model, messages, tools: [{ type: "function", function: { name, description, parameters } }],
 *           max_completion_tokens }
 *   response: { choices: [{ message: { content, tool_calls: [{ id, type: "function", function: { name, arguments } }],
 *               refusal? }, finish_reason: "stop" | "tool_calls" | "length" | ... }], usage: { prompt_tokens, completion_tokens } }
 *   tool results: one { role: "tool", tool_call_id, content } message per call, after the assistant message.
 * `arguments` is a JSON string the model generated; it may be invalid JSON and is always validated server-side.
 * The assistant message is replayed verbatim (role, content, tool_calls). Every attempt is metered
 * (writing/metering.ts); for a custom provider the response body is size-capped and the key is scrubbed
 * from stored errors (writing/http.ts).
 */
import { requestJson } from "../writing/http";
import { estimateTokens, metered, WriterOutputError, type WriterHooks } from "../writing/metering";
import { normalizeBaseUrl } from "../providers/writer-openai";
import { CHAT_MAX_OUTPUT_TOKENS, CHAT_MAX_RETRIES } from "./model-anthropic";
import { ChatModelError, type ChatModel, type RoundRequest, type RoundResult, type ToolCall } from "./types";

export interface OpenAiChatConfig extends WriterHooks {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  maxRetries?: number;
  /** Response body cap per attempt (custom providers). */
  maxResponseBytes?: number;
}

interface ChatCompletion {
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: string | null; refusal?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function buildOpenAiChatMessages(req: Pick<RoundRequest, "system" | "history" | "turn">): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: req.system }];
  for (const h of req.history) messages.push({ role: h.role, content: h.text });
  for (const t of req.turn) {
    if (t.role === "user") messages.push({ role: "user", content: t.text });
    else if (t.role === "assistant") messages.push(t.raw && typeof t.raw === "object" ? (t.raw as Record<string, unknown>) : { role: "assistant", content: "" });
    else for (const r of t.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
  }
  return messages;
}

export function buildOpenAiChatRequest(model: string, req: RoundRequest): Record<string, unknown> {
  return {
    model,
    messages: buildOpenAiChatMessages(req),
    tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    max_completion_tokens: CHAT_MAX_OUTPUT_TOKENS,
  };
}

export function parseOpenAiChatResponse(body: ChatCompletion): RoundResult {
  const choice = body.choices?.[0];
  const msg = choice?.message ?? {};
  const toolCalls: ToolCall[] = [];
  const rawCalls: Array<Record<string, unknown>> = [];
  for (const tc of msg.tool_calls ?? []) {
    if (!tc || typeof tc.id !== "string" || typeof tc.function?.name !== "string") continue;
    const args = typeof tc.function.arguments === "string" ? tc.function.arguments : "";
    let input: unknown = {};
    let invalidJson = false;
    try {
      input = args.trim() ? JSON.parse(args) : {};
    } catch {
      invalidJson = true;
    }
    toolCalls.push({ id: tc.id, name: tc.function.name, input, ...(invalidJson ? { invalidJson } : {}) });
    rawCalls.push({ id: tc.id, type: "function", function: { name: tc.function.name, arguments: args } });
  }
  const text = typeof msg.content === "string" ? msg.content : "";
  const raw: Record<string, unknown> = { role: "assistant", content: text || null };
  if (rawCalls.length) raw.tool_calls = rawCalls;
  const fr = choice?.finish_reason;
  const stop: RoundResult["stop"] = msg.refusal ? "refusal" : fr === "length" ? "max_tokens" : toolCalls.length ? "tool_use" : "end";
  return {
    raw,
    text,
    toolCalls,
    stop,
    usage: { inputTokens: num(body.usage?.prompt_tokens), outputTokens: num(body.usage?.completion_tokens) },
  };
}

export function createOpenAiChatModel(cfg: OpenAiChatConfig): ChatModel {
  const base = normalizeBaseUrl(cfg.baseUrl);
  const maxRetries = cfg.maxRetries ?? CHAT_MAX_RETRIES;
  return {
    provider: "openai_compatible",
    model: cfg.model,
    async round(req: RoundRequest): Promise<RoundResult> {
      const body = buildOpenAiChatRequest(cfg.model, req);
      let parsed: RoundResult | null = null;
      try {
        await metered(
          cfg,
          { provider: "openai_compatible", model: cfg.model, purpose: "chat.turn", estimatedTokens: estimateTokens(JSON.stringify(body)) + CHAT_MAX_OUTPUT_TOKENS, maxRetries },
          async (onAttempt) => {
            const r = await requestJson({
              fetchImpl: cfg.fetchImpl,
              url: `${base}/chat/completions`,
              headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
              body,
              timeoutMs: Math.max(5_000, Math.min(req.timeoutMs, 90_000)),
              maxRetries,
              requestIdHeader: "x-request-id",
              onAttempt,
              sleep: cfg.sleep,
              maxResponseBytes: cfg.maxResponseBytes,
              secrets: [cfg.apiKey],
            });
            parsed = parseOpenAiChatResponse((r.json ?? {}) as ChatCompletion);
            const failure =
              parsed.stop === "refusal" ? new WriterOutputError("The model declined the request.", "refusal")
              : parsed.stop === "max_tokens" ? new WriterOutputError("The model's answer was cut off (output limit).", "truncated")
              : null;
            return { result: { usage: parsed.usage }, failure, requestId: r.requestId, latencyMs: r.latencyMs };
          },
        );
      } catch (e) {
        if (e instanceof WriterOutputError) throw new ChatModelError(e.message, e.reason === "refusal" ? "refusal" : "truncated");
        throw e;
      }
      if (!parsed) throw new ChatModelError("The model returned no response.", "invalid_response");
      return parsed;
    },
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
