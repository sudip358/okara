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
 *  - [A40] Each round sends only the routed tools (routing.ts: core + groups for the message, grown by unsent-tool
 *    calls, one more_tools expansion, or one "I lack a tool" expansion) and the matching system prompt; read calls
 *    of one round run concurrently (CHAT_READ_CONCURRENCY) with results kept in call order; actions stay
 *    sequential; reads may be served from the session's short-lived cache (cache.ts); text deltas stream out
 *    masked (StreamRedactor) when `onText` is set.
 */
import type { ChatStep } from "@shared/types";
import { BudgetExceededError } from "../lib/errors";
import { ProviderHttpError } from "../writing/http";
import { OutboundBlockedError } from "../runs/runtime";
import { CHAT_TOOLS, getTool, isActionTool, resultForModel, summarizeArgs, toolErrorMessage, toolSpec, type ActionTool, type ChatTool, type ReadTool, type ToolContext, type ToolOutput } from "./tools";
import { keyLikeIn, redactSecrets, scrubKeyLike, SECRET_REFUSAL } from "./secrets";
import type { ToolCache } from "./cache";
import { groupOf, isToolGroup, LACKS_TOOL_RE, MORE_TOOLS, MORE_TOOLS_SPEC, routeGroups, TOOL_GROUPS, toolsForGroups, type ToolGroup } from "./routing";
import { StreamRedactor } from "./stream";
import { ChatModelError, type ChatModel, type HistoryItem, type ToolCall, type ToolResultItem, type ToolSpec, type TurnItem } from "./types";

type ReadToolT = ReadTool;

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
  /** [A40] Tool groups active when the turn paused, and whether more_tools was used (absent in older rows). */
  groups?: ToolGroup[];
  expanded?: boolean;
}

export type LoopOutcome =
  | { kind: "complete"; text: string; rounds: number }
  | { kind: "paused"; text: string; actionId: string; pending: PendingState; rounds: number }
  | { kind: "stopped"; text: string; reason: "max_rounds" | "deadline"; rounds: number }
  | { kind: "error"; text: string; code: string; message: string; rounds: number };

/** [A40] A streamed text delta of one model round (`reset`: replace that round's text with `delta`). */
export interface TextDeltaEvent {
  round: number;
  delta: string;
  reset: boolean;
}

/** [A40] What the turn is doing now (the panel shows "Thinking…", "Reading Search Console…"). */
export interface PhaseEvent {
  phase: "model" | "tools";
  round: number;
  /** Tool names about to run (phase "tools"). */
  tools?: string[];
}

export interface LoopDeps {
  model: ChatModel;
  ctx: ToolContext;
  /** System prompt, or (preferred) `buildSystem` for the active tool groups. */
  system: string;
  /** [A40] System prompt for the active tool groups (prompt.ts); falls back to `system`. */
  buildSystem?: (groups: ToolGroup[]) => string;
  history: HistoryItem[];
  maxRounds?: number;
  deadlineAt: number;
  nowMs?: () => number;
  /** A new or updated step (same id = update). */
  onStep: (step: ChatStep) => Promise<void> | void;
  /** Persist a pending action; returns its id. */
  proposeAction: (call: ToolCall, tool: ActionTool, input: unknown, prepared: { title: string; detail: string }) => Promise<string>;
  /** [A40] Initial tool groups (default: routed from the turn's user message). */
  groups?: ToolGroup[];
  /** [A40] more_tools already used in this turn (resume after a confirmation). */
  expanded?: boolean;
  /** [A40] Stream the answer: called with each (masked) text delta. */
  onText?: (ev: TextDeltaEvent) => void;
  /** [A40] Progress for the panel. */
  onPhase?: (ev: PhaseEvent) => void;
  /** [A40] Short-lived read-tool result cache of this chat session (cache.ts). */
  cache?: ToolCache;
  /** [A40] Max read tools of one round running at the same time. */
  readConcurrency?: number;
  /** Test hook: tool lookup (default: the registry). */
  resolveTool?: (name: string) => ChatTool | undefined;
}

/** Read tools of one round that run at the same time [A40]. */
export const CHAT_READ_CONCURRENCY = 4;

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

/** Streamed text of one round: masked (StreamRedactor), restartable, reconciled with the final round text. */
class RoundText {
  private redactor = new StreamRedactor();
  private raw = "";
  constructor(
    private readonly round: number,
    private readonly emit: (ev: TextDeltaEvent) => void,
  ) {}
  private out(r: { delta: string; reset: boolean } | null) {
    if (r && (r.delta || r.reset)) this.emit({ round: this.round, delta: r.delta, reset: r.reset });
  }
  push(delta: string) {
    this.raw += delta;
    this.out(this.redactor.push(delta));
  }
  restart() {
    this.redactor = new StreamRedactor();
    this.raw = "";
    this.emit({ round: this.round, delta: "", reset: true });
  }
  /** End of round: release the rest (or replace with the final text when the stream differed, e.g. no stream). */
  finish(full: string) {
    if (full.startsWith(this.raw)) {
      const rest = full.slice(this.raw.length);
      this.raw = full;
      const a = rest ? this.redactor.push(rest) : null;
      const b = this.redactor.flush();
      // One event: a reset in either part makes the whole a reset.
      if (a && b) this.out(b.reset ? b : { delta: a.delta + b.delta, reset: a.reset });
      else this.out(a ?? b);
    } else if (this.raw.startsWith(full)) this.out(this.redactor.flush());
    else this.emit({ round: this.round, delta: redactSecrets(full, { generic: false }).text, reset: true });
  }
  clear() {
    this.emit({ round: this.round, delta: "", reset: true });
  }
}

/** Promise pool: at most `n` tasks at once, started in call order. */
function limiter(n: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        running++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            running--;
            queue.shift()?.();
          });
      };
      if (running < n) start();
      else queue.push(start);
    });
}

type ReadOutcome =
  | { ok: true; content: string; summary: string; navigate: ToolOutput["navigate"]; download: ToolOutput["download"]; cached: boolean }
  | { ok: false; message: string };

type Plan =
  | { t: "secret" }
  | { t: "fail"; message: string; kind?: ChatStep["kind"] }
  | { t: "more"; groups: ToolGroup[] }
  | { t: "action"; tool: ActionTool; input: unknown }
  | { t: "read"; tool: ChatTool; input: unknown; run: Promise<ReadOutcome> };

const userTextOf = (turn: TurnItem[]) => {
  const u = turn.find((t) => t.role === "user");
  return u && u.role === "user" ? u.text : "";
};

export async function runAgentLoop(deps: LoopDeps, start: { turn: TurnItem[]; rounds: number; texts: string[] }): Promise<LoopOutcome> {
  const maxRounds = deps.maxRounds ?? CHAT_MAX_TOOL_ROUNDS;
  const now = deps.nowMs ?? (() => Date.now());
  const turn = start.turn;
  const texts = [...start.texts];
  let rounds = start.rounds;
  // [A40] Routed tool set: core + groups; it only grows within the turn and keeps registry order.
  const active = new Set<ToolGroup>(deps.groups ?? routeGroups(userTextOf(turn)));
  let expanded = deps.expanded ?? false;
  let specsKey = "";
  let specs: ToolSpec[] = [];
  let system = deps.system;
  const refreshTools = () => {
    const key = TOOL_GROUPS.filter((g) => active.has(g)).join(",");
    if (key === specsKey) return;
    specsKey = key;
    specs = [...toolsForGroups(CHAT_TOOLS, active).map(toolSpec), MORE_TOOLS_SPEC];
    system = deps.buildSystem ? deps.buildSystem(TOOL_GROUPS.filter((g) => active.has(g))) : deps.system;
  };
  const pool = limiter(Math.max(1, deps.readConcurrency ?? CHAT_READ_CONCURRENCY));
  const lookup = deps.resolveTool ?? getTool;

  const runRead = async (tool: ChatTool, input: unknown): Promise<ReadOutcome> => {
    const cacheable = tool.kind === "read" && deps.cache;
    if (cacheable) {
      const hit = deps.cache!.get(tool.name, input);
      if (hit) return { ok: true, content: hit.content, summary: hit.summary, navigate: hit.navigate ?? null, download: null, cached: true };
    }
    try {
      const out = await (tool as ReadToolT).run(deps.ctx, input);
      const content = resultForModel({ ok: true, data: out.data });
      if (cacheable) deps.cache!.set(tool.name, input, { content, summary: out.summary, navigate: out.navigate ?? null });
      return { ok: true, content, summary: out.summary, navigate: out.navigate ?? null, download: out.download ?? null, cached: false };
    } catch (e) {
      return { ok: false, message: toolErrorMessage(e) };
    }
  };

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
    refreshTools();
    deps.onPhase?.({ phase: "model", round: rounds + 1 });
    const stream = deps.onText ? new RoundText(rounds + 1, deps.onText) : null;
    let round;
    try {
      round = await deps.model.round({
        system,
        history: deps.history,
        turn,
        tools: specs,
        timeoutMs: left,
        ...(stream ? { onText: (d: string) => stream.push(d), onRestart: () => stream.restart() } : {}),
      });
    } catch (e) {
      const { code, message } = errorOutcome(e);
      return { kind: "error", code, message, rounds, text: finalText(texts) };
    }
    rounds++;
    const assistantAt = turn.length;
    turn.push({ role: "assistant", provider: deps.model.provider, raw: round.raw });
    if (round.toolCalls.length === 0) {
      // [A40] "I don't have a tool for that": load every group once and ask again (the answer is discarded).
      if (!expanded && round.stop !== "other" && LACKS_TOOL_RE.test(round.text) && active.size < TOOL_GROUPS.length) {
        expanded = true;
        for (const g of TOOL_GROUPS) active.add(g);
        turn.pop();
        stream?.clear();
        continue;
      }
      stream?.finish(round.text);
      // [A35] A key-like string the model wrote is masked before it is shown or stored.
      if (round.text.trim()) texts.push(redactSecrets(round.text, { generic: false }).text);
      if (round.stop === "other") continue; // e.g. pause_turn: re-send with the assistant turn appended
      return { kind: "complete", rounds, text: finalText(texts) || "I could not produce an answer." };
    }
    stream?.finish(round.text);
    if (round.text.trim()) texts.push(redactSecrets(round.text, { generic: false }).text);

    // Plan every call first; reads start right away (bounded pool), actions wait for their turn below.
    let secretRefused = false;
    const plans: Plan[] = round.toolCalls.map((call): Plan => {
      // [A35] Secrets never go through tool input.
      if (keyLikeIn(call.input).length) return { t: "secret" };
      if (call.name === MORE_TOOLS) {
        if (call.invalidJson) return { t: "fail", message: "Arguments were not valid JSON." };
        const raw = (call.input as { groups?: unknown })?.groups;
        const groups = (Array.isArray(raw) ? raw : []).filter(isToolGroup);
        if (!groups.length) return { t: "fail", message: `Name one or more groups: ${TOOL_GROUPS.join(", ")}.` };
        return { t: "more", groups };
      }
      const tool = lookup(call.name);
      if (!tool) return { t: "fail", message: `Unknown tool "${call.name.slice(0, 60)}".` };
      if (call.invalidJson) return { t: "fail", message: "Arguments were not valid JSON.", kind: tool.kind };
      const parsed = tool.schema.safeParse(call.input ?? {});
      if (!parsed.success) return { t: "fail", message: toolErrorMessage(parsed.error), kind: tool.kind };
      // A registered tool that was not sent this round still runs (same validation and gate); its group joins.
      const g = groupOf(tool.name);
      if (g && g !== "core") active.add(g);
      if (isActionTool(tool)) return { t: "action", tool, input: parsed.data };
      return { t: "read", tool, input: parsed.data, run: pool(() => runRead(tool, parsed.data)) };
    });
    const running = round.toolCalls.filter((_, i) => plans[i]!.t === "read" || plans[i]!.t === "action").map((c) => c.name);
    if (running.length) deps.onPhase?.({ phase: "tools", round: rounds, tools: running });

    const results: ToolResultItem[] = [];
    let paused: { actionId: string; callId: string; name: string } | null = null;
    for (let i = 0; i < round.toolCalls.length; i++) {
      const call = round.toolCalls[i]!;
      const plan = plans[i]!;
      const id = stepId(call.id);
      const fail = async (message: string, kind: ChatStep["kind"] = "read") => {
        results.push({ id: call.id, name: call.name, content: JSON.stringify({ ok: false, error: message }), isError: true });
        await deps.onStep({ id, kind, tool: call.name.slice(0, 80), args: summarizeArgs(call.input), result: message.slice(0, 300), status: "error" });
      };
      switch (plan.t) {
        case "secret": {
          secretRefused = true;
          results.push({ id: call.id, name: call.name, content: JSON.stringify({ ok: false, error: SECRET_REFUSAL }), isError: true });
          await deps.onStep({ id, kind: lookup(call.name)?.kind ?? "read", tool: call.name.slice(0, 80), args: "[withheld: looked like a secret]", result: "Refused: a key-like value was in the arguments. Use the secure field.", status: "error" });
          break;
        }
        case "fail":
          await fail(plan.message, plan.kind);
          break;
        case "more": {
          if (expanded) {
            await fail("more_tools was already used in this answer. Answer with the tools you have, or say which data is missing.");
            break;
          }
          expanded = true;
          const before = new Set(toolsForGroups(CHAT_TOOLS, active).map((t) => t.name));
          for (const g of plan.groups) active.add(g);
          const added = toolsForGroups(CHAT_TOOLS, active).map((t) => t.name).filter((n) => !before.has(n));
          results.push({ id: call.id, name: call.name, content: JSON.stringify({ ok: true, loaded: plan.groups, tools: added, note: "These tools are available from your next step." }), isError: false });
          await deps.onStep({ id, kind: "read", tool: MORE_TOOLS, args: `groups=${plan.groups.join(",")}`, result: `Loaded ${added.length} tool(s): ${plan.groups.map((g) => g.replace(/_/g, " ")).join(", ")}`, status: "ok" });
          break;
        }
        case "action": {
          if (paused) {
            await fail("Only one action can wait for confirmation at a time. Propose it again after the user decides on the first one.", "action");
            break;
          }
          try {
            const prepared = await plan.tool.prepare(deps.ctx, plan.input);
            const actionId = await deps.proposeAction(call, plan.tool, plan.input, prepared);
            paused = { actionId, callId: call.id, name: plan.tool.name };
            await deps.onStep({ id, kind: "action", tool: plan.tool.name, args: summarizeArgs(plan.input), result: prepared.title, status: "awaiting_confirmation", actionId });
          } catch (e) {
            await fail(toolErrorMessage(e), "action");
          }
          break;
        }
        case "read": {
          const out = await plan.run;
          if (!out.ok) {
            await fail(out.message, plan.tool.kind);
            break;
          }
          results.push({ id: call.id, name: plan.tool.name, content: out.content, isError: false });
          await deps.onStep({
            id,
            kind: plan.tool.kind,
            tool: plan.tool.name,
            args: summarizeArgs(plan.input),
            result: `${out.summary}${out.cached ? " (reused, under 2 min old)" : ""}`.slice(0, 300),
            status: "ok",
            navigate: out.navigate ?? null,
            download: out.download ?? null,
          });
          break;
        }
      }
    }

    if (secretRefused) turn[assistantAt] = { role: "assistant", provider: deps.model.provider, raw: scrubKeyLike(round.raw) };
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
          groups: TOOL_GROUPS.filter((g) => active.has(g)),
          expanded,
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
