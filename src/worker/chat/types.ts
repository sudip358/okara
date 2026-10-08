/**
 * Ask Okara: provider-neutral types for the chat agent loop (src/worker/chat/loop.ts).
 *
 * Transcript shape:
 *  - Earlier turns are replayed as plain text pairs (user text, assistant answer text) only. No earlier
 *    thinking blocks or tool calls are replayed, so nothing bound to an earlier request can be invalidated
 *    ("simple compaction" in the Anthropic preserved-thinking guidance).
 *  - Inside the current turn the history is append-only: each assistant round is replayed verbatim in its
 *    provider-native form (`raw`), followed by one tool-results item that answers every tool call of that round.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; validated by the tool's zod schema before anything runs. */
  input: unknown;
  /** True when the provider sent arguments that were not valid JSON. */
  invalidJson?: boolean;
}

export interface ToolResultItem {
  id: string;
  name: string;
  /** JSON (or plain text) handed back to the model. */
  content: string;
  isError: boolean;
}

export type HistoryItem = { role: "user"; text: string } | { role: "assistant"; text: string };

export type TurnItem =
  | { role: "user"; text: string }
  /** One model round, replayed verbatim (Anthropic content blocks incl. thinking, or an OpenAI assistant message). */
  | { role: "assistant"; provider: string; raw: unknown }
  | { role: "tool_results"; results: ToolResultItem[] };

export type RoundStop = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface RoundResult {
  /** Provider-native assistant message for verbatim replay. */
  raw: unknown;
  text: string;
  toolCalls: ToolCall[];
  stop: RoundStop;
  /** `estimated`: the provider reported no usage (a stream without a usage chunk); tokens are Okara's estimate. */
  usage: { inputTokens: number; outputTokens: number; estimated?: boolean };
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) for the arguments. */
  parameters: Record<string, unknown>;
}

export interface RoundRequest {
  system: string;
  history: HistoryItem[];
  turn: TurnItem[];
  tools: ToolSpec[];
  /** Milliseconds left before the turn's wall-clock limit (bounds the HTTP timeout). */
  timeoutMs: number;
  /**
   * [A40] Set when the caller streams the answer: the adapter requests a streamed response and calls this with each
   * visible text delta as it arrives (never tool-call text). Unset: a plain (non-stream) request.
   */
  onText?: (delta: string) => void;
  /** [A40] A retry restarts the round: text already passed to onText is void. */
  onRestart?: () => void;
}

/** A tool-calling chat model (the workspace writer). Implementations meter every attempt (budget + provider_calls). */
export interface ChatModel {
  provider: "anthropic" | "openai_compatible";
  model: string;
  round(req: RoundRequest): Promise<RoundResult>;
}

/** Raised by a model adapter for a non-retryable output problem (refusal, truncation). */
export class ChatModelError extends Error {
  constructor(message: string, public readonly reason: "refusal" | "truncated" | "invalid_response" | "provider") {
    super(message);
  }
}
