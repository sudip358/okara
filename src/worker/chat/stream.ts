/**
 * Ask Okara streaming helpers [A40] (pure where possible; tested in Node with synthetic streams):
 *  - `readSseData`: Server-Sent Events reader (data lines of each event, any chunking, CRLF/LF).
 *  - `OpenAiStreamAccumulator`: Chat Completions chunks (`stream: true`) -> the non-stream response shape
 *    (delta.content, delta.tool_calls by index with arguments split across chunks, refusal, finish_reason, the
 *    final usage chunk of `stream_options.include_usage`), so parsing stays in one place (parseOpenAiChatResponse).
 *  - `AnthropicStreamAccumulator`: Messages API stream events -> the Message shape (text, thinking + signature,
 *    tool_use input_json_delta, stop_reason, usage).
 *  - `ToolCallTextFilter`: visible text of a streamed round without <tool_call> blocks (text-tools mode).
 *  - `StreamRedactor`: key-like strings are masked before any streamed text leaves the server ([A35]).
 *  - `requestStream`: one metered POST that reads an SSE body (or a JSON body when the server ignored `stream`),
 *    with the same retry, timeout, size-cap and key-scrubbing rules as writing/http.ts requestJson.
 */
import { redact } from "../runs/calls";
import { readCapped } from "../lib/read-capped";
import { backoffMs, ProviderHttpError, type JsonRequest } from "../writing/http";
import { redactSecrets } from "./secrets";

// ------------------------------------------------------------------ SSE
/** Calls `onData` with the joined data lines of every event; resolves at end of stream. Bounded by `maxBytes`. */
export async function readSseData(body: ReadableStream<Uint8Array>, onData: (data: string, event: string | null) => void, maxBytes?: number): Promise<{ bytes: number; overflow: boolean }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let bytes = 0;
  let data: string[] = [];
  let event: string | null = null;
  const dispatch = () => {
    if (data.length) onData(data.join("\n"), event);
    data = [];
    event = null;
  };
  const line = (l: string) => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const name = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "data") data.push(value);
    else if (name === "event") event = value;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (maxBytes && bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return { bytes, overflow: true };
    }
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + (buf[nl] === "\r" && buf[nl + 1] === "\n" ? 2 : 1));
      line(l);
    }
  }
  buf += dec.decode();
  if (buf) line(buf);
  dispatch();
  return { bytes, overflow: false };
}

// ------------------------------------------------------------------ OpenAI-compatible chunks
interface ToolCallAcc {
  id: string | null;
  name: string;
  args: string;
}

export class OpenAiStreamAccumulator {
  content = "";
  refusal = "";
  finishReason: string | null = null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  model: string | undefined;
  done = false;
  readonly calls: ToolCallAcc[] = [];
  private fields = new Set<string>();

  /** One `data:` payload. Returns the visible content delta (may be ""). Throws on a provider error chunk. */
  push(data: string): string {
    if (data.trim() === "[DONE]") {
      this.done = true;
      return "";
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return ""; // keep-alive or non-JSON noise
    }
    if (chunk.error && typeof chunk.error === "object") {
      const msg = typeof (chunk.error as { message?: unknown }).message === "string" ? (chunk.error as { message: string }).message : "stream error";
      throw new ProviderHttpError(`Stream error: ${redact(msg).slice(0, 300)}`, null, false, null, true);
    }
    if (typeof chunk.model === "string") this.model = chunk.model;
    const u = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | null | undefined;
    if (u && typeof u === "object") this.usage = u;
    const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Record<string, unknown> | undefined) : undefined;
    if (!choice) return "";
    if (typeof choice.finish_reason === "string") this.finishReason = choice.finish_reason;
    const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(delta)) if (k !== "role" && delta[k] !== null && delta[k] !== "") this.fields.add(k);
    if (typeof delta.refusal === "string") this.refusal += delta.refusal;
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
        const fn = (raw.function ?? {}) as { name?: unknown; arguments?: unknown };
        const id = typeof raw.id === "string" && raw.id ? raw.id : null;
        let acc: ToolCallAcc | undefined;
        if (typeof raw.index === "number") {
          while (this.calls.length <= raw.index) this.calls.push({ id: null, name: "", args: "" });
          acc = this.calls[raw.index];
        } else {
          const last = this.calls[this.calls.length - 1];
          acc = last && (!id || !last.id || last.id === id) ? last : undefined;
          if (!acc) this.calls.push((acc = { id: null, name: "", args: "" }));
        }
        if (!acc) continue;
        if (id && !acc.id) acc.id = id;
        if (typeof fn.name === "string" && fn.name) acc.name = !acc.name ? fn.name : acc.name === fn.name ? acc.name : acc.name + fn.name;
        if (typeof fn.arguments === "string") acc.args += fn.arguments;
        else if (fn.arguments && typeof fn.arguments === "object") acc.args = JSON.stringify(fn.arguments);
      }
    }
    const c = delta.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("") : "";
    this.content += text;
    return text;
  }

  /** The equivalent non-stream Chat Completions body. */
  toCompletion(): Record<string, unknown> {
    const message: Record<string, unknown> = { role: "assistant", content: this.content };
    for (const f of this.fields) if (!(f in message) && f !== "tool_calls" && f !== "refusal") message[f] = "";
    const calls = this.calls.filter((c) => c.name);
    if (calls.length) message.tool_calls = calls.map((c) => ({ ...(c.id ? { id: c.id } : {}), type: "function", function: { name: c.name, arguments: c.args } }));
    if (this.refusal) message.refusal = this.refusal;
    return { model: this.model, choices: [{ message, finish_reason: this.finishReason }], ...(this.usage ? { usage: this.usage } : {}) };
  }
}

// ------------------------------------------------------------------ Anthropic events
type Block = Record<string, unknown> & { type: string };

export class AnthropicStreamAccumulator {
  readonly blocks: Block[] = [];
  private json = new Map<number, string>();
  stopReason: string | null = null;
  inputTokens = 0;
  outputTokens = 0;
  sawUsage = false;
  done = false;
  model: string | undefined;

  /** One parsed stream event. Returns the visible text delta (may be ""). */
  push(ev: Record<string, unknown>): string {
    switch (ev.type) {
      case "message_start": {
        const m = (ev.message ?? {}) as { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        this.model = m.model;
        if (m.usage) {
          this.sawUsage = true;
          this.inputTokens = num(m.usage.input_tokens);
          this.outputTokens = num(m.usage.output_tokens);
        }
        return "";
      }
      case "content_block_start": {
        const i = num(ev.index);
        const b = { ...((ev.content_block ?? { type: "text", text: "" }) as Block) };
        if (b.type === "tool_use") b.input = {};
        this.blocks[i] = b;
        return b.type === "text" && typeof b.text === "string" ? b.text : "";
      }
      case "content_block_delta": {
        const i = num(ev.index);
        const d = (ev.delta ?? {}) as Record<string, unknown>;
        const b = this.blocks[i] ?? (this.blocks[i] = { type: d.type === "input_json_delta" ? "tool_use" : d.type === "thinking_delta" ? "thinking" : "text" });
        if (d.type === "text_delta" && typeof d.text === "string") {
          b.text = String(b.text ?? "") + d.text;
          return d.text;
        }
        if (d.type === "input_json_delta" && typeof d.partial_json === "string") this.json.set(i, (this.json.get(i) ?? "") + d.partial_json);
        else if (d.type === "thinking_delta" && typeof d.thinking === "string") b.thinking = String(b.thinking ?? "") + d.thinking;
        else if (d.type === "signature_delta" && typeof d.signature === "string") b.signature = String(b.signature ?? "") + d.signature;
        return "";
      }
      case "content_block_stop": {
        const i = num(ev.index);
        const b = this.blocks[i];
        if (b && b.type === "tool_use") {
          const raw = this.json.get(i) ?? "";
          try {
            b.input = raw.trim() ? JSON.parse(raw) : {};
          } catch {
            b.input = {};
            b._invalidJson = true;
          }
        }
        return "";
      }
      case "message_delta": {
        const d = (ev.delta ?? {}) as { stop_reason?: string | null };
        if (typeof d.stop_reason === "string") this.stopReason = d.stop_reason;
        const u = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (u) {
          this.sawUsage = true;
          if (typeof u.output_tokens === "number") this.outputTokens = u.output_tokens;
          if (typeof u.input_tokens === "number" && u.input_tokens > this.inputTokens) this.inputTokens = u.input_tokens;
        }
        return "";
      }
      case "message_stop":
        this.done = true;
        return "";
      default:
        return ""; // ping and future event types
    }
  }

  toMessage(): { model?: string; content: Block[]; stop_reason: string | null; usage?: { input_tokens: number; output_tokens: number } } {
    return {
      model: this.model,
      content: this.blocks.filter(Boolean).map((b) => {
        const { _invalidJson, ...rest } = b;
        void _invalidJson;
        return rest as Block;
      }),
      stop_reason: this.stopReason,
      ...(this.sawUsage ? { usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens } } : {}),
    };
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ------------------------------------------------------------------ visible text
const TOOL_TAG = "<tool_call";

/** Streams text up to the first <tool_call block; holds back a trailing partial "<tool_c". */
export class ToolCallTextFilter {
  private buf = "";
  private sent = 0;
  private blocked = false;

  push(delta: string): string {
    if (this.blocked || !delta) return "";
    this.buf += delta;
    const at = this.buf.indexOf(TOOL_TAG, Math.max(0, this.sent - TOOL_TAG.length));
    if (at >= 0) {
      this.blocked = true;
      const out = this.buf.slice(this.sent, Math.max(this.sent, at));
      this.sent = Math.max(this.sent, at);
      return out;
    }
    let safe = this.buf.length;
    for (let k = Math.min(TOOL_TAG.length - 1, this.buf.length); k > 0; k--) {
      if (TOOL_TAG.startsWith(this.buf.slice(-k))) {
        safe = this.buf.length - k;
        break;
      }
    }
    const out = this.buf.slice(this.sent, Math.max(this.sent, safe));
    this.sent = Math.max(this.sent, safe);
    return out;
  }

  /** Remaining held-back text at the end of the round. */
  flush(): string {
    if (this.blocked) return "";
    const out = this.buf.slice(this.sent);
    this.sent = this.buf.length;
    return out;
  }
}

/**
 * Masks key-like strings in streamed text before it is sent: text is released only up to the last whitespace (a
 * key is one unbroken token, so a released prefix never changes later) and always through redactSecrets, the same
 * rule as the stored answer. Returns {delta, reset}: reset = replace what was shown with delta (rare).
 */
export class StreamRedactor {
  private raw = "";
  private shown = "";

  push(delta: string): { delta: string; reset: boolean } | null {
    this.raw += delta;
    const cut = Math.max(this.raw.lastIndexOf(" "), this.raw.lastIndexOf("\n"), this.raw.lastIndexOf("\t"));
    if (cut < 0) return null;
    return this.release(this.raw.slice(0, cut + 1));
  }

  /** End of round: release everything. */
  flush(): { delta: string; reset: boolean } | null {
    return this.release(this.raw);
  }

  private release(prefix: string): { delta: string; reset: boolean } | null {
    const masked = redactSecrets(prefix, { generic: false }).text;
    if (masked === this.shown) return null;
    if (masked.startsWith(this.shown)) {
      const delta = masked.slice(this.shown.length);
      this.shown = masked;
      return { delta, reset: false };
    }
    this.shown = masked;
    return { delta: masked, reset: true };
  }
}

// ------------------------------------------------------------------ streaming POST
export interface StreamRequest extends JsonRequest {
  /** Called with each SSE data payload (only for a text/event-stream response). */
  onData: (data: string, event: string | null) => void;
  /** Called before a retry attempt (the caller resets its accumulator and any streamed text). */
  onRestart: () => void;
}

export interface StreamResponse {
  /** Set when the server answered with JSON instead of SSE (it ignored `stream`). */
  json: unknown | null;
  streamed: boolean;
  requestId: string | null;
  latencyMs: number;
}

const RETRYABLE = (s: number) => s === 408 || s === 429 || (s >= 500 && s <= 599);

/** Like requestJson, for an SSE response body (or JSON when the server does not stream). */
export async function requestStream(req: StreamRequest): Promise<StreamResponse> {
  const sleep = req.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const secrets = [
    ...new Set((req.secrets ?? []).filter((k) => typeof k === "string" && k.length >= 8).flatMap((k) => [k, JSON.stringify(k).slice(1, -1), encodeURIComponent(k)])),
  ].sort((a, b) => b.length - a.length);
  const scrub = (t: string) => redact(secrets.reduce((acc, k) => acc.split(k).join("[redacted]"), t));
  let last: ProviderHttpError | null = null;
  for (let attempt = 0; attempt <= req.maxRetries; attempt++) {
    if (attempt > 0) req.onRestart();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);
    const started = Date.now();
    let retryAfter: string | null = null;
    let requestId: string | null = null;
    let status: number | null = null;
    try {
      const fetchImpl = req.fetchImpl;
      const res = await fetchImpl(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: controller.signal });
      status = res.status;
      requestId = res.headers.get(req.requestIdHeader);
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && /event-stream/i.test(type) && res.body) {
        const r = await readSseData(res.body, req.onData, req.maxResponseBytes);
        const latencyMs = Date.now() - started;
        if (r.overflow) {
          const msg = `Response exceeded ${req.maxResponseBytes} bytes.`;
          await req.onAttempt({ attempt, ok: false, status: res.status, timedOut: false, outcomeUnknown: true, requestId, latencyMs, error: msg });
          throw new ProviderHttpError(msg, res.status, false, requestId, true);
        }
        await req.onAttempt({ attempt, ok: true, status: res.status, timedOut: false, outcomeUnknown: false, requestId, latencyMs, error: null });
        return { json: null, streamed: true, requestId, latencyMs };
      }
      const text = req.maxResponseBytes ? await readCapped(res, req.maxResponseBytes) : await res.text();
      const latencyMs = Date.now() - started;
      if (text === null) {
        const msg = `Response exceeded ${req.maxResponseBytes} bytes.`;
        await req.onAttempt({ attempt, ok: false, status: res.status, timedOut: false, outcomeUnknown: res.ok, requestId, latencyMs, error: msg });
        throw new ProviderHttpError(msg, res.status, false, requestId, res.ok);
      }
      if (res.ok) {
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          await req.onAttempt({ attempt, ok: false, status: res.status, timedOut: false, outcomeUnknown: false, requestId, latencyMs, error: "Response was not valid JSON." });
          throw new ProviderHttpError("Provider returned a non-JSON response.", res.status, false, requestId, false);
        }
        await req.onAttempt({ attempt, ok: true, status: res.status, timedOut: false, outcomeUnknown: false, requestId, latencyMs, error: null });
        return { json, streamed: false, requestId, latencyMs };
      }
      retryAfter = res.headers.get("retry-after");
      const msg = `HTTP ${res.status}: ${scrub(text).slice(0, 300)}`;
      await req.onAttempt({ attempt, ok: false, status: res.status, timedOut: false, outcomeUnknown: false, requestId, latencyMs, error: msg });
      last = new ProviderHttpError(msg, res.status, false, requestId, false);
      if (!RETRYABLE(res.status)) throw last;
    } catch (e) {
      if (e instanceof ProviderHttpError) {
        if (e === last && last.status !== null && RETRYABLE(last.status)) {
          // retry below
        } else if (e.message.startsWith("Stream error")) {
          // An error event mid-stream (e.g. overloaded): recorded, then retried while attempts remain.
          await req.onAttempt({ attempt, ok: false, status, timedOut: false, outcomeUnknown: true, requestId, latencyMs: Date.now() - started, error: scrub(e.message) });
          last = new ProviderHttpError(scrub(e.message), status, false, requestId, true);
          if (attempt >= req.maxRetries) throw last;
        } else throw e;
      } else {
        const latencyMs = Date.now() - started;
        const msg = timedOut ? `Timed out after ${req.timeoutMs} ms.` : `Connection error: ${e instanceof Error ? scrub(e.message) : "unknown"}`;
        await req.onAttempt({ attempt, ok: false, status: null, timedOut, outcomeUnknown: true, requestId, latencyMs, error: msg });
        last = new ProviderHttpError(msg, null, timedOut, requestId, true);
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < req.maxRetries) await sleep(backoffMs(attempt, retryAfter));
  }
  throw last ?? new ProviderHttpError("Request failed.", null, false, null, false);
}

