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

type RawToolCall = { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };

interface ChatCompletion {
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      /** A string, or (some compatible servers) an array of parts like { type: "text", text }. */
      content?: unknown;
      refusal?: string | null;
      tool_calls?: RawToolCall[] | null;
      /** Legacy single function call (pre-tools API), still sent by some compatible servers. */
      function_call?: { name?: unknown; arguments?: unknown } | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Text of a message `content`: a string, or the text parts of a content-part array. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
    .join("");
}

/**
 * Tool calls some OpenAI-compatible servers (open-weight model hosts, gateways) put in the text instead of
 * `tool_calls`: <tool_call>{"name": "...", "arguments": {...}}</tool_call>. Only well-formed JSON with a string
 * name is taken; the blocks are removed from the visible text. The arguments are validated server-side like any
 * other tool input.
 */
const TEXT_TOOL_CALL = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
export function extractTextToolCalls(text: string): { text: string; calls: Array<{ name: string; arguments: string }> } {
  const calls: Array<{ name: string; arguments: string }> = [];
  const rest = text.replace(TEXT_TOOL_CALL, (whole, json: string) => {
    try {
      const v = JSON.parse(json) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      if (typeof v.name !== "string") return whole;
      const a = v.arguments ?? v.parameters ?? {};
      calls.push({ name: v.name, arguments: typeof a === "string" ? a : JSON.stringify(a) });
      return "";
    } catch {
      return whole;
    }
  });
  return { text: calls.length ? rest.trim() : text, calls };
}

/**
 * Text-tools mode, for endpoints that ignore the `tools` parameter (the model answers with neither text nor a
 * tool call): the tool catalog goes into the system prompt and the model asks for a tool with a
 * <tool_call>{"name": ..., "arguments": {...}}</tool_call> block in its text. Replayed assistant tool calls are
 * written back as those blocks and tool results go back as a user message, so no tools/tool-role fields are sent.
 * Every requested call is still validated and confirmation-gated server-side exactly like native tool calls.
 */
export function textToolsSystem(system: string, tools: RoundRequest["tools"]): string {
  const catalog = tools.map((t) => `- ${t.name}: ${t.description}\n  arguments (JSON Schema): ${JSON.stringify(t.parameters)}`).join("\n");
  return `${system}

## Calling tools (this endpoint has no native tool calling)
To use a tool, reply with one or more blocks exactly like:
<tool_call>{"name": "<tool name>", "arguments": {<arguments as JSON>}}</tool_call>
and nothing else in that reply. You will then receive the results in <tool_result> blocks. When you have what you need, reply with the final answer as plain text without any <tool_call> block.

Available tools:
${catalog}`;
}

export function buildOpenAiChatMessages(req: Pick<RoundRequest, "system" | "history" | "turn">, textTools = false): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: req.system }];
  for (const h of req.history) messages.push({ role: h.role, content: h.text });
  for (const t of req.turn) {
    if (t.role === "user") messages.push({ role: "user", content: t.text });
    else if (t.role === "assistant") {
      const raw = t.raw && typeof t.raw === "object" ? (t.raw as Record<string, unknown>) : { role: "assistant", content: "" };
      if (!textTools) messages.push(raw);
      else {
        const calls = Array.isArray(raw.tool_calls) ? (raw.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>) : [];
        const blocks = calls.map((c) => {
          let args: unknown = {};
          try {
            args = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
          } catch {
            args = {};
          }
          return `<tool_call>${JSON.stringify({ name: c.function?.name ?? "", arguments: args })}</tool_call>`;
        });
        messages.push({ role: "assistant", content: [typeof raw.content === "string" ? raw.content : "", ...blocks].filter(Boolean).join("\n") });
      }
    } else if (!textTools) for (const r of t.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    else messages.push({ role: "user", content: t.results.map((r) => `<tool_result id="${r.id}">\n${r.content}\n</tool_result>`).join("\n") });
  }
  return messages;
}

export function buildOpenAiChatRequest(model: string, req: RoundRequest, textTools = false): Record<string, unknown> {
  if (textTools) {
    return {
      model,
      messages: buildOpenAiChatMessages({ ...req, system: textToolsSystem(req.system, req.tools) }, true),
      max_completion_tokens: CHAT_MAX_OUTPUT_TOKENS,
    };
  }
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
  const push = (id: string, name: string, argsValue: unknown) => {
    // Some servers send arguments as an object instead of a JSON string.
    const args = typeof argsValue === "string" ? argsValue : argsValue && typeof argsValue === "object" ? JSON.stringify(argsValue) : "";
    let input: unknown = {};
    let invalidJson = false;
    try {
      input = args.trim() ? JSON.parse(args) : {};
    } catch {
      invalidJson = true;
    }
    toolCalls.push({ id, name, input, ...(invalidJson ? { invalidJson } : {}) });
    rawCalls.push({ id, type: "function", function: { name, arguments: args } });
  };
  // Some servers omit the call id; a stable synthetic one keeps tool results paired with their call.
  const callId = (i: number) => `call_okara_${i}`;
  (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).forEach((tc, i) => {
    if (!tc || typeof tc.function?.name !== "string") return;
    push(typeof tc.id === "string" && tc.id ? tc.id : callId(i), tc.function.name, tc.function.arguments);
  });
  if (!toolCalls.length && msg.function_call && typeof msg.function_call.name === "string") push(callId(0), msg.function_call.name, msg.function_call.arguments);
  let text = contentText(msg.content);
  if (!toolCalls.length) {
    const fromText = extractTextToolCalls(text);
    fromText.calls.forEach((c, i) => push(callId(i), c.name, c.arguments));
    text = fromText.text;
  }
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

/** Field names only (never values) of a response that yielded neither text nor a tool call, for the error shown to the user. */
export function describeEmptyResponse(body: ChatCompletion): string {
  const choice = body.choices?.[0];
  if (!choice) return "no choices in the response";
  const fields = Object.keys(choice.message ?? {}).filter((k) => k !== "role").sort();
  return `finish_reason ${choice.finish_reason ?? "none"}; message fields: ${fields.length ? fields.join(", ") : "none"}`;
}

export function createOpenAiChatModel(cfg: OpenAiChatConfig): ChatModel {
  const base = normalizeBaseUrl(cfg.baseUrl);
  const maxRetries = cfg.maxRetries ?? CHAT_MAX_RETRIES;
  let textTools = false;
  return {
    provider: "openai_compatible",
    model: cfg.model,
    async round(req: RoundRequest): Promise<RoundResult> {
      if (!textTools) {
        const first = await this.attempt(req, false);
        if (first.ok || !req.tools.length) return finish(first);
        textTools = true; // this endpoint ignored native tools: use text tools for the rest of the session's model
      }
      return finish(await this.attempt(req, true));
    },
    async attempt(req: RoundRequest, text: boolean): Promise<Attempt> {
      const body = buildOpenAiChatRequest(cfg.model, req, text);
      let parsed: RoundResult | null = null;
      let empty: string | null = null;
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
            const json = (r.json ?? {}) as ChatCompletion;
            parsed = parseOpenAiChatResponse(json);
            const failure =
              parsed.stop === "refusal" ? new WriterOutputError("The model declined the request.", "refusal")
              : parsed.stop === "max_tokens" ? new WriterOutputError("The model's answer was cut off (output limit).", "truncated")
              : null;
            if (!failure && !parsed.text.trim() && !parsed.toolCalls.length) empty = describeEmptyResponse(json);
            return { result: { usage: parsed.usage }, failure, requestId: r.requestId, latencyMs: r.latencyMs };
          },
        );
      } catch (e) {
        if (e instanceof WriterOutputError) throw new ChatModelError(e.message, e.reason === "refusal" ? "refusal" : "truncated");
        throw e;
      }
      if (!parsed) throw new ChatModelError("The model returned no response.", "invalid_response");
      return { ok: !empty, result: parsed, empty, text };
    },
  } as ChatModel & { attempt(req: RoundRequest, text: boolean): Promise<Attempt> };

  function finish(a: Attempt): RoundResult {
    if (a.ok) return a.result;
    throw new ChatModelError(
      `${cfg.model} answered with neither text nor a tool call (${a.empty})${a.text ? ", also when the tools were described in the prompt" : ""}. Pick another model under Integrations → Writer → Change model.`,
      "invalid_response",
    );
  }
}

interface Attempt {
  ok: boolean;
  result: RoundResult;
  empty: string | null;
  text: boolean;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
