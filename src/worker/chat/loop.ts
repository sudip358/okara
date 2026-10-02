/**
 * Ask Okara agent loop (provider-neutral, no persistence; tested with fake models in Node).
 *
 *  - At most `maxRounds` model rounds and a wall-clock deadline per turn; then it stops and says so.
 *  - Read/output tools run immediately (arguments validated with zod first; an unknown tool or invalid
 *    arguments become an error tool_result, never an exception).
 *  - Action tools are NEVER executed here: `prepare()` validates them, `proposeAction` records a pending
 *    action, and the loop pauses with the provider transcript so the confirm endpoint can resume it. At most
 *    one action per round; extra action calls get an error result.
 *  - Every tool call of a round gets exactly one result, in call order, in one tool-results item.
 */
import type { ChatStep } from "@shared/types";
import { BudgetExceededError } from "../lib/errors";
import { ProviderHttpError } from "../writing/http";
import { OutboundBlockedError } from "../runs/runtime";
import { getTool, isActionTool, resultForModel, summarizeArgs, toolErrorMessage, toolSpecs, type ActionTool, type ToolContext } from "./tools";
import { ChatModelError, type ChatModel, type HistoryItem, type ToolCall, type ToolResultItem, type TurnItem } from "./types";

export const CHAT_MAX_TOOL_ROUNDS = 8;
export const CHAT_TURN_DEADLINE_MS = 120_000;
/** Max characters of the final answer stored and shown. */
export const CHAT_ANSWER_MAX_CHARS = 20_000;

export interface PendingState {
  v: 1;
  provider: string;
  model: string;
  /** Current turn, including the assistant round that proposed the action. */
  turn: TurnItem[];
  /** Tool call ids of that round, in order. */
  callOrder: string[];
  /** Results already computed for the round's other calls. */
  results: ToolResultItem[];
  actionCallId: string;
  actionName: string;
  rounds: number;
  /** Model text produced so far in this turn (shown above the confirmation card). */
  text: string;
}

export type LoopOutcome =
  | { kind: "complete"; text: string; rounds: number }
  | { kind: "paused"; text: string; actionId: string; pending: PendingState; rounds: number }
  | { kind: "stopped"; text: string; reason: "max_rounds" | "deadline"; rounds: number }
  | { kind: "error"; text: string; code: string; message: string; rounds: number };

export interface LoopDeps {
  model: ChatModel;
  ctx: ToolContext;
  system: string;
  history: HistoryItem[];
  maxRounds?: number;
  deadlineAt: number;
  nowMs?: () => number;
  /** A new or updated step (same id = update). */
  onStep: (step: ChatStep) => Promise<void> | void;
  /** Persist a pending action; returns its id. */
  proposeAction: (call: ToolCall, tool: ActionTool, input: unknown, prepared: { title: string; detail: string }) => Promise<string>;
}

const stepId = (callId: string) => `st_${callId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || Math.random().toString(36).slice(2)}`;

/** Pick the user-facing answer: the last round's text, else everything said this turn. */
function finalText(texts: string[]): string {
  const last = texts[texts.length - 1]?.trim() ?? "";
  return (last || texts.map((t) => t.trim()).filter(Boolean).join("\n\n")).slice(0, CHAT_ANSWER_MAX_CHARS);
}

export function errorOutcome(e: unknown): { code: string; message: string } {
  if (e instanceof BudgetExceededError) return { code: "budget_exceeded", message: "Daily usage limit reached for this project (writer tokens or provider calls). Try again tomorrow." };
  if (e instanceof ChatModelError) return { code: e.reason === "refusal" ? "model_refused" : "model_output", message: e.message };
  if (e instanceof OutboundBlockedError) return { code: "outbound_blocked", message: "The model endpoint is not an allowed provider host." };
  if (e instanceof ProviderHttpError) return { code: "provider_error", message: `The model provider returned an error (${e.status ?? (e.timedOut ? "timeout" : "network")}).` };
  return { code: "internal", message: "Something went wrong while answering." };
}

export async function runAgentLoop(deps: LoopDeps, start: { turn: TurnItem[]; rounds: number; texts: string[] }): Promise<LoopOutcome> {
  const maxRounds = deps.maxRounds ?? CHAT_MAX_TOOL_ROUNDS;
  const now = deps.nowMs ?? (() => Date.now());
  const turn = start.turn;
  const texts = [...start.texts];
  let rounds = start.rounds;
  const specs = toolSpecs();

  for (;;) {
    if (rounds >= maxRounds) {
      const t = finalText(texts);
      return { kind: "stopped", reason: "max_rounds", rounds, text: `${t ? `${t}\n\n` : ""}I stopped after ${rounds} tool rounds without a final answer. Ask a narrower question to continue.` };
    }
    const left = deps.deadlineAt - now();
    if (left <= 1000) {
      const t = finalText(texts);
      return { kind: "stopped", reason: "deadline", rounds, text: `${t ? `${t}\n\n` : ""}I ran out of time for this answer. Ask again or narrow the question.` };
    }
    let round;
    try {
      round = await deps.model.round({ system: deps.system, history: deps.history, turn, tools: specs, timeoutMs: left });
    } catch (e) {
      const { code, message } = errorOutcome(e);
      return { kind: "error", code, message, rounds, text: finalText(texts) };
    }
    rounds++;
    turn.push({ role: "assistant", provider: deps.model.provider, raw: round.raw });
    if (round.text.trim()) texts.push(round.text);
    if (round.toolCalls.length === 0) {
      if (round.stop === "other") continue; // e.g. pause_turn: re-send with the assistant turn appended
      return { kind: "complete", rounds, text: finalText(texts) || "I could not produce an answer." };
    }

    const results: ToolResultItem[] = [];
    let paused: { actionId: string; callId: string; name: string } | null = null;
    for (const call of round.toolCalls) {
      const tool = getTool(call.name);
      const id = stepId(call.id);
      const fail = async (message: string, kind: ChatStep["kind"] = tool?.kind ?? "read") => {
        results.push({ id: call.id, name: call.name, content: JSON.stringify({ ok: false, error: message }), isError: true });
        await deps.onStep({ id, kind, tool: call.name.slice(0, 80), args: summarizeArgs(call.input), result: message.slice(0, 300), status: "error" });
      };
      if (!tool) {
        await fail(`Unknown tool "${call.name.slice(0, 60)}".`);
        continue;
      }
      if (call.invalidJson) {
        await fail("Arguments were not valid JSON.");
        continue;
      }
      const parsed = tool.schema.safeParse(call.input ?? {});
      if (!parsed.success) {
        await fail(toolErrorMessage(parsed.error));
        continue;
      }
      const input = parsed.data;
      if (isActionTool(tool)) {
        if (paused) {
          await fail("Only one action can wait for confirmation at a time. Propose it again after the user decides on the first one.", "action");
          continue;
        }
        try {
          const prepared = await tool.prepare(deps.ctx, input);
          const actionId = await deps.proposeAction(call, tool, input, prepared);
          paused = { actionId, callId: call.id, name: tool.name };
          await deps.onStep({ id, kind: "action", tool: tool.name, args: summarizeArgs(input), result: prepared.title, status: "awaiting_confirmation", actionId });
        } catch (e) {
          await fail(toolErrorMessage(e), "action");
        }
        continue;
      }
      try {
        const out = await tool.run(deps.ctx, input);
        results.push({ id: call.id, name: tool.name, content: resultForModel({ ok: true, data: out.data }), isError: false });
        await deps.onStep({
          id,
          kind: tool.kind,
          tool: tool.name,
          args: summarizeArgs(input),
          result: out.summary.slice(0, 300),
          status: "ok",
          navigate: out.navigate ?? null,
          download: out.download ?? null,
        });
      } catch (e) {
        await fail(toolErrorMessage(e));
      }
    }

    if (paused) {
      return {
        kind: "paused",
        rounds,
        actionId: paused.actionId,
        text: finalText(texts),
        pending: {
          v: 1,
          provider: deps.model.provider,
          model: deps.model.model,
          turn,
          callOrder: round.toolCalls.map((c) => c.id),
          results,
          actionCallId: paused.callId,
          actionName: paused.name,
          rounds,
          text: texts.join("\n\n").slice(0, CHAT_ANSWER_MAX_CHARS),
        },
      };
    }
    turn.push({ role: "tool_results", results: orderResults(round.toolCalls.map((c) => c.id), results) });
  }
}

/** Results in call order (one per call id). */
export function orderResults(callOrder: string[], results: ToolResultItem[]): ToolResultItem[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return callOrder.map((id) => byId.get(id)).filter((r): r is ToolResultItem => Boolean(r));
}
