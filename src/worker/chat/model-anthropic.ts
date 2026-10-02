/**
 * Ask Okara chat model over the Anthropic Messages API with client tools, via the official SDK
 * (@anthropic-ai/sdk). The SDK's own retries are disabled (maxRetries: 0) so every attempt passes through
 * writing/metering.ts (provider_calls + writer_tokens budget), like the writer.
 *
 * Contract (https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview,
 * https://docs.claude.com/en/api/messages):
 *   POST https://api.anthropic.com/v1/messages
 *   body: { model, max_tokens, system, tools: [{ name, description, input_schema }], messages }
 *   response: { content: [text | thinking | redacted_thinking | tool_use{id,name,input}], stop_reason, usage }
 *   tool results go back as one user message of tool_result blocks { tool_use_id, content, is_error }.
 * Manual loop: assistant content is appended verbatim (thinking blocks included, unchanged) and every tool_use
 * gets a tool_result in a single following user message. tool_choice is left at its default (auto): forced
 * tool use is rejected by current models. No `thinking` parameter is sent, so each model uses its own default
 * (adaptive on current models). The model id comes only from configuration (WRITER_MODEL / the workspace's
 * custom writer); there is no default.
 */
import Anthropic from "@anthropic-ai/sdk";
import { backoffMs, ProviderHttpError } from "../writing/http";
import { estimateTokens, metered, WriterOutputError, type WriterHooks } from "../writing/metering";
import { redact } from "../runs/calls";
import { ChatModelError, type ChatModel, type RoundRequest, type RoundResult, type ToolCall, type TurnItem } from "./types";

/** Output cap per model round (answer + thinking). Engineering choice, not a provider limit. */
export const CHAT_MAX_OUTPUT_TOKENS = 6000;
/** One retry for interactive chat (429 / 5xx / overload / timeouts only). */
export const CHAT_MAX_RETRIES = 1;

export interface AnthropicChatConfig extends WriterHooks {
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch;
  maxRetries?: number;
}

type Block = Record<string, unknown> & { type: string };

/** Response content -> request param blocks for verbatim replay (same fields the API returned). */
export function replayBlocks(content: unknown): Block[] {
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const b of content as Block[]) {
    if (!b || typeof b !== "object" || typeof b.type !== "string") continue;
    if (b.type === "text") out.push({ type: "text", text: String(b.text ?? "") });
    else if (b.type === "thinking") out.push({ type: "thinking", thinking: String(b.thinking ?? ""), signature: String(b.signature ?? "") });
    else if (b.type === "redacted_thinking") out.push({ type: "redacted_thinking", data: String(b.data ?? "") });
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: String(b.id), name: String(b.name), input: b.input ?? {} });
    else out.push(b); // unknown block types are replayed unchanged
  }
  return out;
}

/** Neutral transcript -> Anthropic messages. Earlier turns are text pairs; the current turn is append-only. */
export function buildAnthropicMessages(req: Pick<RoundRequest, "history" | "turn">): Array<{ role: "user" | "assistant"; content: unknown }> {
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const h of req.history) messages.push({ role: h.role, content: h.text });
  for (const t of req.turn as TurnItem[]) {
    if (t.role === "user") messages.push({ role: "user", content: t.text });
    else if (t.role === "assistant") messages.push({ role: "assistant", content: replayBlocks(t.raw) });
    else
      messages.push({
        role: "user",
        content: t.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      });
  }
  return messages;
}

export function buildAnthropicChatRequest(model: string, req: RoundRequest): Record<string, unknown> {
  return {
    model,
    max_tokens: CHAT_MAX_OUTPUT_TOKENS,
    system: req.system,
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    messages: buildAnthropicMessages(req),
  };
}

interface MessagesBody {
  model?: string;
  content?: Block[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function parseAnthropicChatResponse(body: MessagesBody): RoundResult {
  const content = Array.isArray(body.content) ? body.content : [];
  const text = content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
  const toolCalls: ToolCall[] = content
    .filter((b) => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
    .map((b) => ({ id: b.id as string, name: b.name as string, input: b.input ?? {} }));
  const sr = body.stop_reason;
  // Refusal and truncation win (a truncated tool_use input is not trustworthy); pause_turn is re-sent.
  const stop: RoundResult["stop"] =
    sr === "refusal" ? "refusal"
    : sr === "max_tokens" || sr === "model_context_window_exceeded" ? "max_tokens"
    : toolCalls.length ? "tool_use"
    : sr === "pause_turn" ? "other"
    : "end";
  return {
    raw: content,
    text,
    toolCalls,
    stop,
    usage: { inputTokens: num(body.usage?.input_tokens), outputTokens: num(body.usage?.output_tokens) },
  };
}

export function createAnthropicChatModel(cfg: AnthropicChatConfig): ChatModel {
  const maxRetries = cfg.maxRetries ?? CHAT_MAX_RETRIES;
  return {
    provider: "anthropic",
    model: cfg.model,
    async round(req: RoundRequest): Promise<RoundResult> {
      const body = buildAnthropicChatRequest(cfg.model, req);
      const timeout = Math.max(5_000, Math.min(req.timeoutMs, 90_000));
      let parsed: RoundResult | null = null;
      try {
        await metered(
          cfg,
          { provider: "anthropic", model: cfg.model, purpose: "chat.turn", estimatedTokens: estimateTokens(JSON.stringify(body)) + CHAT_MAX_OUTPUT_TOKENS, maxRetries },
          async (onAttempt) => {
            const client = new Anthropic({
              apiKey: cfg.apiKey,
              // Call fetch without a receiver: workerd rejects the platform fetch invoked as obj.fetch().
              fetch: (input, init) => cfg.fetchImpl(input as RequestInfo, init as RequestInit),
              maxRetries: 0,
              timeout,
            });
            const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
            let last: ProviderHttpError | null = null;
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
              const started = Date.now();
              let retryAfter: string | null = null;
              try {
                const { data, request_id } = await client.messages.create(body as unknown as Anthropic.MessageCreateParamsNonStreaming).withResponse();
                const latencyMs = Date.now() - started;
                await onAttempt({ attempt, ok: true, status: 200, timedOut: false, outcomeUnknown: false, requestId: request_id ?? null, latencyMs, error: null });
                parsed = parseAnthropicChatResponse(data as unknown as MessagesBody);
                const failure =
                  parsed.stop === "refusal" ? new WriterOutputError("The model declined the request.", "refusal")
                  : parsed.stop === "max_tokens" ? new WriterOutputError("The model's answer was cut off (output limit).", "truncated")
                  : null;
                return { result: { usage: parsed.usage }, failure, requestId: request_id ?? null, latencyMs };
              } catch (e) {
                const latencyMs = Date.now() - started;
                if (e instanceof Anthropic.APIUserAbortError) throw new ProviderHttpError("Request cancelled.", null, false, null, true);
                if (e instanceof Anthropic.APIConnectionError) {
                  const timedOut = e instanceof Anthropic.APIConnectionTimeoutError;
                  const msg = timedOut ? `Timed out after ${timeout} ms.` : `Connection error: ${redact(e.message)}`;
                  await onAttempt({ attempt, ok: false, status: null, timedOut, outcomeUnknown: true, requestId: null, latencyMs, error: msg });
                  last = new ProviderHttpError(msg, null, timedOut, null, true);
                } else if (e instanceof Anthropic.APIError) {
                  const status = typeof e.status === "number" ? e.status : null;
                  retryAfter = e.headers?.get("retry-after") ?? null;
                  const msg = `HTTP ${status ?? "error"}: ${redact(e.message).slice(0, 300)}`;
                  await onAttempt({ attempt, ok: false, status, timedOut: false, outcomeUnknown: false, requestId: e.requestID ?? null, latencyMs, error: msg });
                  last = new ProviderHttpError(msg, status, false, e.requestID ?? null, false);
                  const retryable = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || status === 408 || status === 529;
                  if (!retryable) throw last;
                } else {
                  throw e;
                }
              }
              if (attempt < maxRetries) await sleep(backoffMs(attempt, retryAfter));
            }
            throw last ?? new ProviderHttpError("Request failed.", null, false, null, false);
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
