/**
 * Ask Okara turn orchestration: persistence, the session lease, the agent loop, and the confirmation gate.
 *
 * Two-phase API so the route can refuse a request with a normal JSON error (setup_required, busy, rate limit)
 * before it starts streaming: `prepareSend` / `prepareDecision` validate, take the session lease and write the
 * messages, then return a `run(emit)` that does the work and always releases the lease.
 *
 * Confirmation is enforced here, not by the prompt: the loop only records pending chat_actions rows; an action
 * executes only in `prepareDecision(..., "confirm")`, after the user's own POST, exactly once (pending ->
 * executing is a conditional UPDATE, so a second confirm, a cancel, or a new message cannot run it again).
 * A new message while an action waits expires that action.
 */
import type { ChatStep, ChatStreamEvent, ChatTurnResult } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { HttpError, setupRequired } from "../lib/errors";
import { utcDay } from "../lib/time";
import type { ProjectRow, SessionUser } from "../platform/access";
import { buildSystemPrompt } from "./prompt";
import { CHAT_MAX_TOOL_ROUNDS, CHAT_TURN_DEADLINE_MS, errorOutcome, orderResults, runAgentLoop, type LoopOutcome, type PendingState, type PhaseEvent, type TextDeltaEvent } from "./loop";
import { clearSessionCache, REFRESH_RE, sessionCacheScope, sessionToolCache } from "./cache";
import { isToolGroup, routeGroups, type ToolGroup } from "./routing";
import { resolveChatModel } from "./model";
import {
  acquireLease,
  actionsForMessage,
  CHAT_MAX_MESSAGE_CHARS,
  CHAT_MAX_MESSAGES_PER_SESSION,
  getAction,
  getMessage,
  historyFor,
  insertAction,
  insertTurnMessages,
  pendingActions,
  previousAnswerTools,
  releaseLease,
  requireSession,
  toSummary,
  transitionAction,
  updateMessage,
  type ActionRow,
  type SessionRow,
} from "./store";
import { getTool, isActionTool, resultForModel, toolErrorMessage, type ChatToolHooks, type ToolContext } from "./tools";
import type { ChatModel, ToolResultItem } from "./types";
import { secretFieldFor } from "./secret-fields";
import { redactSecrets } from "./secrets";

export interface ChatDeps {
  env: Env;
  db: Db;
  project: ProjectRow;
  user: SessionUser;
  now: Date;
  waitUntil?: (p: Promise<unknown>) => void;
  fetchImpl?: typeof fetch;
  hooks?: ChatToolHooks;
  /** Wall clock for the turn deadline (tests). */
  nowMs?: () => number;
}

export type Emit = (ev: ChatStreamEvent) => void;
export interface PreparedTurn {
  run(emit?: Emit): Promise<ChatTurnResult>;
}

const owner = (d: ChatDeps) => ({ project: d.project, userId: d.user.id });

function toolContext(d: ChatDeps): ToolContext {
  return { env: d.env, db: d.db, project: d.project, userId: d.user.id, now: d.now, waitUntil: d.waitUntil, hooks: d.hooks };
}

async function readyModel(d: ChatDeps): Promise<ChatModel> {
  const r = await resolveChatModel(d.env, d.db, d.project.workspace_id, d.project.id, { fetchImpl: d.fetchImpl, clock: () => d.now });
  if (r.status !== "ready") throw setupRequired(r.message);
  return r.model;
}

/** Expire actions still waiting in this session (a new message replaced them). Caller holds the lease. */
async function expirePending(d: ChatDeps, s: SessionRow): Promise<void> {
  for (const a of await pendingActions(d.db, s)) {
    if (!(await transitionAction(d.db, a, "pending", "expired", d.now, { summary: "Not confirmed (a new message was sent)." }))) continue;
    const msg = await getMessage(d.db, s, a.message_id).catch(() => null);
    if (!msg) continue;
    const steps = msg.steps.map((st) => (st.actionId === a.id ? { ...st, status: "expired" as const, result: "Not confirmed (a new message was sent)." } : st));
    await updateMessage(d.db, s, msg.id, d.now, { steps, status: "complete", content: msg.content || "The proposed action was not confirmed." });
  }
}

/** [A40] The session's read-tool cache scope (workspace, project, user, session). */
const cacheScope = (d: ChatDeps, s: SessionRow) => sessionCacheScope(s.workspace_id, d.project.id, d.user.id, s.id);

/** Run the loop for one assistant message, persisting steps as they land; returns the loop outcome. */
async function runForMessage(
  d: ChatDeps,
  s: SessionRow,
  model: ChatModel,
  messageId: string,
  initialSteps: ChatStep[],
  start: {
    history: Array<{ role: "user" | "assistant"; text: string }>;
    turn: PendingState["turn"];
    rounds: number;
    maxRounds: number;
    /** [A40] Routed tool groups and whether more_tools was used. */
    groups: ToolGroup[];
    expanded: boolean;
    userText: string;
  },
  emit: Emit,
  streaming: boolean,
): Promise<{ outcome: LoopOutcome; steps: ChatStep[] }> {
  const steps = [...initialSteps];
  const nowMs = d.nowMs ?? (() => Date.now());
  const day = utcDay(d.now);
  const prompts = new Map<string, string>();
  const outcome = await runAgentLoop(
    {
      model,
      ctx: toolContext(d),
      system: buildSystemPrompt(d.project, day),
      buildSystem(groups) {
        const key = groups.join(",");
        let p = prompts.get(key);
        if (p === undefined) prompts.set(key, (p = buildSystemPrompt(d.project, day, groups)));
        return p;
      },
      groups: start.groups,
      expanded: start.expanded,
      cache: sessionToolCache(cacheScope(d, s), nowMs, { bypassLive: REFRESH_RE.test(start.userText) }),
      ...(streaming
        ? {
            onText: (ev: TextDeltaEvent) => emit({ type: "text_delta", round: ev.round, delta: ev.delta, ...(ev.reset ? { reset: true } : {}) }),
            onPhase: (ev: PhaseEvent) => emit({ type: "phase", phase: ev.phase, round: ev.round, ...(ev.tools ? { tools: ev.tools } : {}) }),
          }
        : {}),
      history: start.history,
      maxRounds: start.maxRounds,
      deadlineAt: nowMs() + CHAT_TURN_DEADLINE_MS,
      nowMs,
      async onStep(step) {
        const i = steps.findIndex((x) => x.id === step.id);
        if (i >= 0) steps[i] = step;
        else steps.push(step);
        await updateMessage(d.db, s, messageId, d.now, { steps });
        emit({ type: "step", step });
      },
      proposeAction: (call, tool, input, prepared) =>
        insertAction(d.db, s, messageId, d.now, { toolCallId: call.id, name: tool.name, args: input, title: prepared.title, detail: prepared.detail }),
    },
    { turn: start.turn, rounds: start.rounds, texts: [] },
  );
  return { outcome, steps };
}

/** Persist the loop outcome on the assistant message and release the lease. */
async function finish(d: ChatDeps, s: SessionRow, messageId: string, prefix: string, outcome: LoopOutcome, steps: ChatStep[]): Promise<void> {
  const join = (t: string) => [prefix.trim(), t.trim()].filter(Boolean).join("\n\n");
  if (outcome.kind === "paused") {
    await updateMessage(d.db, s, messageId, d.now, { content: join(outcome.text), status: "awaiting_confirmation", steps, error: null });
    await releaseLease(d.db, s, d.now, { status: "awaiting_confirmation", pending: outcome.pending });
    return;
  }
  const status = outcome.kind === "complete" ? "complete" : outcome.kind === "stopped" ? "stopped" : "error";
  const error = outcome.kind === "error" ? outcome.message : null;
  const content = join(outcome.kind === "error" ? outcome.text : outcome.text);
  await updateMessage(d.db, s, messageId, d.now, { content, status, steps, error });
  await releaseLease(d.db, s, d.now, { status: "idle", pending: null });
}

async function result(d: ChatDeps, s: SessionRow, userMessageId: string | null, messageId: string): Promise<ChatTurnResult> {
  const fresh = await requireSession(d.db, owner(d), s.id);
  return {
    session: toSummary(fresh),
    userMessage: userMessageId ? await getMessage(d.db, fresh, userMessageId) : null,
    message: await getMessage(d.db, fresh, messageId),
    actions: await actionsForMessage(d.db, fresh, messageId),
  };
}

/** Wrap a run so the lease is always released and failures become an error message, not a stuck session. */
async function guarded(d: ChatDeps, s: SessionRow, messageId: string, prefix: string, steps: () => ChatStep[], work: () => Promise<void>, emit: Emit): Promise<void> {
  try {
    await work();
  } catch (e) {
    const { code, message } = errorOutcome(e);
    try {
      await updateMessage(d.db, s, messageId, d.now, { content: prefix, status: "error", steps: steps(), error: message });
      await releaseLease(d.db, s, d.now, { status: "idle", pending: null });
    } catch {
      // the lease expires on its own (CHAT_LEASE_MS)
    }
    emit({ type: "error", code, message });
  }
}

// ------------------------------------------------------------------ send
export async function prepareSend(d: ChatDeps, sessionId: string, rawText: string): Promise<PreparedTurn> {
  const typed = rawText.replace(/\r\n/g, "\n").trim();
  if (!typed) throw new HttpError(400, "bad_request", "Message is empty.");
  if (typed.length > CHAT_MAX_MESSAGE_CHARS) throw new HttpError(400, "bad_request", `Message is longer than ${CHAT_MAX_MESSAGE_CHARS} characters.`);
  // [A35] A pasted API key is masked before anything is stored or sent to the model: both see the placeholder.
  const text = redactSecrets(typed).text;
  const s = await requireSession(d.db, owner(d), sessionId);
  if (s.message_count + 2 > CHAT_MAX_MESSAGES_PER_SESSION) throw new HttpError(409, "chat_full", "This chat is full. Start a new chat.");
  const model = await readyModel(d);
  if (!(await acquireLease(d.db, s, d.now, ["idle", "awaiting_confirmation"]))) {
    throw new HttpError(409, "chat_busy", "Ask Okara is still answering in this chat. Wait for it to finish.");
  }
  let ids: Awaited<ReturnType<typeof insertTurnMessages>>;
  try {
    await expirePending(d, s);
    ids = await insertTurnMessages(d.db, s, d.now, { text }, { provider: model.provider, model: model.model });
  } catch (e) {
    await releaseLease(d.db, s, d.now, { status: "idle", pending: null });
    throw e;
  }
  return {
    async run(emitArg?: Emit) {
      const streaming = emitArg !== undefined;
      const emit: Emit = emitArg ?? (() => {});
      const userMessage = ids.userMessageId ? await getMessage(d.db, s, ids.userMessageId) : null;
      emit({ type: "started", sessionId: s.id, userMessage, messageId: ids.assistantMessageId });
      let steps: ChatStep[] = [];
      await guarded(
        d,
        s,
        ids.assistantMessageId,
        "",
        () => steps,
        async () => {
          const history = await historyFor(d.db, s, ids.userSeq);
          // [A40] Tools for this turn: groups the message asks for plus those the previous answer used.
          const groups = routeGroups(text, await previousAnswerTools(d.db, s, ids.userSeq));
          const r = await runForMessage(
            d,
            s,
            model,
            ids.assistantMessageId,
            [],
            { history, turn: [{ role: "user", text }], rounds: 0, maxRounds: CHAT_MAX_TOOL_ROUNDS, groups, expanded: false, userText: text },
            emit,
            streaming,
          );
          steps = r.steps;
          await finish(d, s, ids.assistantMessageId, "", r.outcome, r.steps);
        },
        emit,
      );
      const out = await result(d, s, ids.userMessageId, ids.assistantMessageId);
      emit({ type: "done", result: out });
      return out;
    },
  };
}

// ------------------------------------------------------------------ confirm / cancel
export type SecretReport = { ok: boolean; keyHint: string | null } | null;

export async function prepareDecision(d: ChatDeps, sessionId: string, actionId: string, decision: "confirm" | "cancel", secret: SecretReport = null): Promise<PreparedTurn> {
  const s = await requireSession(d.db, owner(d), sessionId);
  const action = await getAction(d.db, s, actionId);
  // [A35] Secure-field actions are confirmed only with the browser's {ok, keyHint} report (the key itself went to
  // the credential route); every other action is confirmed without one.
  if (decision === "confirm" && action.status === "pending") {
    const needs = secretFieldFor(action.name, JSON.parse(action.args_json || "{}") as Record<string, unknown>, action.workspace_id) !== null;
    if (needs && !secret) throw new HttpError(400, "secret_required", "Type the key into the secure field on the card, then confirm.");
    if (!needs && secret) throw new HttpError(400, "bad_request", "This action does not take a secure field.");
  }
  const settled = (): PreparedTurn => ({
    async run(emit = () => {}) {
      // Already decided (double click, retry, or expired): report the current state, never execute again.
      const out = await result(d, s, null, action.message_id);
      emit({ type: "done", result: out });
      return out;
    },
  });
  if (action.status !== "pending") return settled();
  const pending = parsePending(s.pending_json);
  if (!pending || pending.actionCallId !== action.tool_call_id || s.status !== "awaiting_confirmation") {
    // Inconsistent state (e.g. a crashed turn): expire the action rather than run it outside its turn.
    if (s.status !== "running" && (await transitionAction(d.db, action, "pending", "expired", d.now, { summary: "Expired (the conversation moved on)." }))) return settled();
    throw new HttpError(409, "chat_busy", "This action can no longer be confirmed.");
  }
  if (!(await acquireLease(d.db, s, d.now, ["awaiting_confirmation"]))) {
    throw new HttpError(409, "chat_busy", "Ask Okara is busy in this chat. Try again in a moment.");
  }
  // Exactly once: only the caller that moves pending -> executing|cancelled proceeds.
  const claimed = await transitionAction(d.db, action, "pending", decision === "confirm" ? "executing" : "cancelled", d.now, decision === "cancel" ? { summary: "Cancelled by the user." } : undefined);
  if (!claimed) {
    await releaseLease(d.db, s, d.now, { status: "idle", pending: null });
    return settled();
  }
  return {
    async run(emitArg?: Emit) {
      const streaming = emitArg !== undefined;
      const emit: Emit = emitArg ?? (() => {});
      const msg = await getMessage(d.db, s, action.message_id);
      emit({ type: "started", sessionId: s.id, userMessage: null, messageId: msg.id });
      let steps = [...msg.steps];
      await guarded(
        d,
        s,
        msg.id,
        msg.content,
        () => steps,
        async () => {
          const actionResult = await executeDecision(d, action, decision, secret);
          steps = steps.map((st) =>
            st.actionId === action.id ? { ...st, status: actionResult.status, result: actionResult.summary.slice(0, 300), navigate: actionResult.navigate ?? null } : st,
          );
          await updateMessage(d.db, s, msg.id, d.now, { steps, status: "running" });
          const stepNow = steps.find((st) => st.actionId === action.id);
          if (stepNow) emit({ type: "step", step: stepNow });

          // Resume the paused tool round: every call of that round gets its result, in call order.
          const results: ToolResultItem[] = [...pending.results, { id: pending.actionCallId, name: pending.actionName, content: actionResult.forModel, isError: actionResult.status !== "executed" }];
          let model: ChatModel | null = null;
          try {
            model = await readyModel(d);
          } catch {
            model = null;
          }
          if (!model || model.provider !== pending.provider || model.model !== pending.model) {
            const note = `${actionResult.summary}. (The chat model changed or is unavailable, so I can't continue this answer; ask again to go on.)`;
            await updateMessage(d.db, s, msg.id, d.now, { content: [msg.content, note].filter(Boolean).join("\n\n"), status: "complete", steps });
            await releaseLease(d.db, s, d.now, { status: "idle", pending: null });
            return;
          }
          const history = await historyFor(d.db, s, await seqOf(d, s, msg.id));
          const turn = [...pending.turn, { role: "tool_results" as const, results: orderResults(pending.callOrder, results) }];
          const first = pending.turn.find((t) => t.role === "user");
          const userText = first && first.role === "user" ? first.text : "";
          const groups = Array.isArray(pending.groups) ? pending.groups.filter(isToolGroup) : routeGroups(userText);
          const r = await runForMessage(
            d,
            s,
            model,
            msg.id,
            steps,
            { history, turn, rounds: pending.rounds, maxRounds: Math.max(CHAT_MAX_TOOL_ROUNDS, pending.rounds + 2), groups, expanded: pending.expanded === true, userText },
            emit,
            streaming,
          );
          steps = r.steps;
          await finish(d, s, msg.id, msg.content, r.outcome, r.steps);
        },
        emit,
      );
      const out = await result(d, s, null, msg.id);
      emit({ type: "done", result: out });
      return out;
    },
  };
}

async function seqOf(d: ChatDeps, s: SessionRow, messageId: string): Promise<number> {
  const r = await d.db.first<{ seq: number }>("SELECT seq FROM chat_messages WHERE id = ? AND workspace_id = ? AND session_id = ?", messageId, s.workspace_id, s.id);
  // History stops before the user message of this turn (the message right before the assistant one).
  return (r?.seq ?? 1) - 1;
}

interface DecisionResult {
  status: "executed" | "failed" | "cancelled";
  summary: string;
  forModel: string;
  navigate?: { path: string; label: string } | null;
}

/** Runs the confirmed action (the only place an action tool's execute() is called). */
async function executeDecision(d: ChatDeps, action: ActionRow, decision: "confirm" | "cancel", secret: SecretReport): Promise<DecisionResult> {
  if (decision === "cancel") {
    return { status: "cancelled", summary: "Cancelled by the user", forModel: JSON.stringify({ ok: false, cancelled: true, message: "The user cancelled this action. Do not propose it again unless they ask." }) };
  }
  const tool = getTool(action.name);
  const finishAs = async (status: "executed" | "failed", summary: string, data?: unknown) => {
    await transitionAction(d.db, action, "executing", status, d.now, { summary, data });
  };
  if (!tool || !isActionTool(tool)) {
    await finishAs("failed", "Unknown action");
    return { status: "failed", summary: "Unknown action", forModel: JSON.stringify({ ok: false, error: "Unknown action." }) };
  }
  const parsed = tool.schema.safeParse(JSON.parse(action.args_json || "{}"));
  if (!parsed.success) {
    await finishAs("failed", "Invalid arguments");
    return { status: "failed", summary: "Invalid arguments", forModel: JSON.stringify({ ok: false, error: toolErrorMessage(parsed.error) }) };
  }
  try {
    const out = await tool.execute(toolContext(d), parsed.data, { proposedAt: action.created_at, secret });
    await finishAs("executed", out.summary, out.data);
    // [A40] The action may have changed what cached reads returned.
    clearSessionCache(sessionCacheScope(action.workspace_id, d.project.id, d.user.id, action.session_id));
    return { status: "executed", summary: out.summary, navigate: out.navigate ?? null, forModel: resultForModel({ ok: true, executed: true, data: out.data }) };
  } catch (e) {
    const message = toolErrorMessage(e);
    await finishAs("failed", message);
    return { status: "failed", summary: `Failed: ${message}`, forModel: JSON.stringify({ ok: false, executed: false, error: message }) };
  }
}

function parsePending(json: string | null): PendingState | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as PendingState;
    return p && p.v === 1 && Array.isArray(p.turn) && typeof p.actionCallId === "string" ? p : null;
  } catch {
    return null;
  }
}
