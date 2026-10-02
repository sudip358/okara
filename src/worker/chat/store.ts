/**
 * Ask Okara persistence (migration 0013_chat.sql). Sessions are private to their user within one project:
 * every statement filters by workspace_id and, for sessions, by project_id + user_id.
 */
import type { ChatAction, ChatMessage, ChatMessageStatus, ChatSessionDetail, ChatSessionSummary, ChatStep } from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";

/** Newest sessions kept per (project, user); older ones are deleted when a session is created. */
export const CHAT_SESSIONS_KEPT = 50;
/** Messages per session (user + assistant); then the user starts a new chat. */
export const CHAT_MAX_MESSAGES_PER_SESSION = 200;
/** Max characters of one user message. */
export const CHAT_MAX_MESSAGE_CHARS = 4000;
/** A running turn's lease; a crashed turn frees the session after this. */
export const CHAT_LEASE_MS = 180_000;
/** Earlier turns replayed to the model (text only). */
export const CHAT_HISTORY_MESSAGES = 12;
export const CHAT_HISTORY_MAX_CHARS = 24_000;
/** Steps kept per message (download rows included); oversized step payloads are trimmed. */
export const CHAT_STEPS_MAX_CHARS = 400_000;

export interface SessionRow {
  id: string;
  workspace_id: string;
  project_id: string;
  user_id: string;
  title: string;
  status: "idle" | "running" | "awaiting_confirmation";
  busy_until: string | null;
  pending_json: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  status: ChatMessageStatus;
  steps_json: string;
  error: string | null;
  model_provider: string | null;
  model: string | null;
  created_at: string;
}

export interface ActionRow {
  id: string;
  workspace_id: string;
  project_id: string;
  session_id: string;
  message_id: string;
  user_id: string;
  tool_call_id: string;
  name: string;
  args_json: string;
  title: string;
  detail: string;
  status: ChatAction["status"];
  result_json: string | null;
  created_at: string;
  decided_at: string | null;
}

type Owner = { project: Pick<ProjectRow, "id" | "workspace_id">; userId: string };

export const toSummary = (r: SessionRow): ChatSessionSummary => ({
  id: r.id,
  title: r.title,
  status: r.status,
  messageCount: r.message_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const toMessage = (r: MessageRow): ChatMessage => ({
  id: r.id,
  role: r.role,
  content: r.content,
  status: r.status,
  steps: parseJson<ChatStep[]>(r.steps_json, []),
  error: r.error,
  model: r.model_provider && r.model ? { provider: r.model_provider, model: r.model } : null,
  createdAt: r.created_at,
});

export const toAction = (r: ActionRow): ChatAction => ({
  id: r.id,
  messageId: r.message_id,
  name: r.name,
  title: r.title,
  detail: r.detail,
  args: parseJson<Record<string, unknown>>(r.args_json, {}),
  status: r.status,
  result: r.result_json ? (parseJson<{ summary?: string }>(r.result_json, {}).summary ?? null) : null,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

export async function createSession(db: Db, o: Owner, now: Date): Promise<SessionRow> {
  const id = newId("chs");
  const at = iso(now);
  await db.insert("chat_sessions", {
    id,
    workspace_id: o.project.workspace_id,
    project_id: o.project.id,
    user_id: o.userId,
    title: "New chat",
    status: "idle",
    message_count: 0,
    created_at: at,
    updated_at: at,
  });
  // Retention: keep the newest CHAT_SESSIONS_KEPT sessions of this user in this project.
  await db.run(
    `DELETE FROM chat_sessions WHERE workspace_id = ? AND project_id = ? AND user_id = ? AND id NOT IN (
       SELECT id FROM chat_sessions WHERE workspace_id = ? AND project_id = ? AND user_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ?)`,
    o.project.workspace_id,
    o.project.id,
    o.userId,
    o.project.workspace_id,
    o.project.id,
    o.userId,
    CHAT_SESSIONS_KEPT,
  );
  return (await getSession(db, o, id))!;
}

export async function listSessions(db: Db, o: Owner): Promise<ChatSessionSummary[]> {
  const rows = await db.all<SessionRow>(
    "SELECT * FROM chat_sessions WHERE workspace_id = ? AND project_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
    o.project.workspace_id,
    o.project.id,
    o.userId,
    CHAT_SESSIONS_KEPT,
  );
  return rows.map(toSummary);
}

export async function getSession(db: Db, o: Owner, id: string): Promise<SessionRow | null> {
  return db.first<SessionRow>("SELECT * FROM chat_sessions WHERE id = ? AND workspace_id = ? AND project_id = ? AND user_id = ?", id, o.project.workspace_id, o.project.id, o.userId);
}

export async function requireSession(db: Db, o: Owner, id: string): Promise<SessionRow> {
  const s = await getSession(db, o, id);
  if (!s) throw notFound("Chat");
  return s;
}

export async function deleteSession(db: Db, o: Owner, id: string): Promise<boolean> {
  const r = await db.run("DELETE FROM chat_sessions WHERE id = ? AND workspace_id = ? AND project_id = ? AND user_id = ?", id, o.project.workspace_id, o.project.id, o.userId);
  return r.changes > 0;
}

export async function sessionDetail(db: Db, s: SessionRow): Promise<ChatSessionDetail> {
  const messages = await db.all<MessageRow>(
    "SELECT * FROM chat_messages WHERE workspace_id = ? AND session_id = ? ORDER BY seq DESC LIMIT ?",
    s.workspace_id,
    s.id,
    CHAT_MAX_MESSAGES_PER_SESSION,
  );
  const actions = await db.all<ActionRow>("SELECT * FROM chat_actions WHERE workspace_id = ? AND session_id = ? ORDER BY created_at, id", s.workspace_id, s.id);
  return { ...toSummary(s), messages: messages.reverse().map(toMessage), actions: actions.map(toAction) };
}

export async function getMessage(db: Db, s: SessionRow, id: string): Promise<ChatMessage> {
  const r = await db.first<MessageRow>("SELECT * FROM chat_messages WHERE id = ? AND workspace_id = ? AND session_id = ?", id, s.workspace_id, s.id);
  if (!r) throw notFound("Message");
  return toMessage(r);
}

/** Earlier complete turns as text (oldest first), within CHAT_HISTORY_MESSAGES / CHAT_HISTORY_MAX_CHARS. */
export async function historyFor(db: Db, s: SessionRow, beforeSeq: number): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  const rows = await db.all<{ role: "user" | "assistant"; content: string; status: string; seq: number }>(
    "SELECT role, content, status, seq FROM chat_messages WHERE workspace_id = ? AND session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
    s.workspace_id,
    s.id,
    beforeSeq,
    CHAT_HISTORY_MESSAGES * 2,
  );
  // Pair user -> assistant; skip pairs without an answer so roles alternate.
  const asc = rows.reverse();
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < asc.length; i++) {
    const u = asc[i]!;
    const a = asc[i + 1];
    if (u.role === "user" && a && a.role === "assistant") {
      if (a.content.trim()) pairs.push([u.content, a.content]);
      i++;
    }
  }
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  let chars = 0;
  for (const [u, a] of pairs.reverse()) {
    chars += u.length + a.length;
    if (out.length / 2 >= CHAT_HISTORY_MESSAGES / 2 || chars > CHAT_HISTORY_MAX_CHARS) break;
    out.unshift({ role: "assistant", text: a.slice(0, 6000) });
    out.unshift({ role: "user", text: u });
  }
  return out;
}

/** Take the session's turn lease: from idle, awaiting_confirmation (when allowed), or an expired running lease. */
export async function acquireLease(db: Db, s: SessionRow, now: Date, from: Array<"idle" | "awaiting_confirmation">): Promise<boolean> {
  const states = from.map(() => "?").join(", ");
  const r = await db.run(
    `UPDATE chat_sessions SET status = 'running', busy_until = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND user_id = ? AND (status IN (${states}) OR (status = 'running' AND (busy_until IS NULL OR busy_until < ?)))`,
    iso(new Date(now.getTime() + CHAT_LEASE_MS)),
    iso(now),
    s.id,
    s.workspace_id,
    s.user_id,
    ...from,
    iso(now),
  );
  return r.changes === 1;
}

export async function releaseLease(db: Db, s: SessionRow, now: Date, next: { status: "idle" | "awaiting_confirmation"; pending: unknown | null }): Promise<void> {
  await db.run(
    "UPDATE chat_sessions SET status = ?, busy_until = NULL, pending_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND user_id = ?",
    next.status,
    next.pending === null ? null : JSON.stringify(next.pending),
    iso(now),
    s.id,
    s.workspace_id,
    s.user_id,
  );
}

export async function insertTurnMessages(
  db: Db,
  s: SessionRow,
  now: Date,
  user: { text: string } | null,
  model: { provider: string; model: string },
): Promise<{ userMessageId: string | null; assistantMessageId: string; userSeq: number }> {
  const at = iso(now);
  const base = s.message_count;
  const statements: Array<[string, ...unknown[]]> = [];
  let userMessageId: string | null = null;
  let seq = base;
  if (user) {
    userMessageId = newId("chm");
    seq++;
    statements.push([
      "INSERT INTO chat_messages (id, workspace_id, project_id, session_id, user_id, seq, role, content, status, steps_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      userMessageId,
      s.workspace_id,
      s.project_id,
      s.id,
      s.user_id,
      seq,
      "user",
      user.text,
      "complete",
      "[]",
      at,
      at,
    ]);
  }
  const assistantMessageId = newId("chm");
  seq++;
  statements.push([
    "INSERT INTO chat_messages (id, workspace_id, project_id, session_id, user_id, seq, role, content, status, steps_json, model_provider, model, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    assistantMessageId,
    s.workspace_id,
    s.project_id,
    s.id,
    s.user_id,
    seq,
    "assistant",
    "",
    "running",
    "[]",
    model.provider,
    model.model.slice(0, 200),
    at,
    at,
  ]);
  const title = user && base === 0 ? titleFrom(user.text) : null;
  statements.push([
    `UPDATE chat_sessions SET message_count = ?, updated_at = ?${title ? ", title = ?" : ""} WHERE id = ? AND workspace_id = ?`,
    seq,
    at,
    ...(title ? [title] : []),
    s.id,
    s.workspace_id,
  ]);
  await db.batch(statements);
  s.message_count = seq;
  return { userMessageId, assistantMessageId, userSeq: user ? base + 1 : base };
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return (t.length > 60 ? `${t.slice(0, 59)}…` : t) || "New chat";
}

/** Steps JSON within CHAT_STEPS_MAX_CHARS (download rows are trimmed first). */
export function stepsJson(steps: ChatStep[]): string {
  let json = JSON.stringify(steps);
  if (json.length <= CHAT_STEPS_MAX_CHARS) return json;
  const trimmed = steps.map((st) => (st.download ? { ...st, download: { ...st.download, rows: st.download.rows.slice(0, 100), truncated: true } } : st));
  json = JSON.stringify(trimmed);
  if (json.length <= CHAT_STEPS_MAX_CHARS) return json;
  return JSON.stringify(trimmed.map((st) => ({ ...st, download: null })));
}

export async function updateMessage(
  db: Db,
  s: SessionRow,
  id: string,
  now: Date,
  patch: { content?: string; status?: ChatMessageStatus; steps?: ChatStep[]; error?: string | null },
): Promise<void> {
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [iso(now)];
  if (patch.content !== undefined) {
    sets.push("content = ?");
    params.push(patch.content);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.steps !== undefined) {
    sets.push("steps_json = ?");
    params.push(stepsJson(patch.steps));
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    params.push(patch.error);
  }
  await db.run(`UPDATE chat_messages SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ? AND session_id = ?`, ...params, id, s.workspace_id, s.id);
}

export async function insertAction(
  db: Db,
  s: SessionRow,
  messageId: string,
  now: Date,
  a: { toolCallId: string; name: string; args: unknown; title: string; detail: string },
): Promise<string> {
  const id = newId("cha");
  await db.insert("chat_actions", {
    id,
    workspace_id: s.workspace_id,
    project_id: s.project_id,
    session_id: s.id,
    message_id: messageId,
    user_id: s.user_id,
    tool_call_id: a.toolCallId.slice(0, 200),
    name: a.name,
    args_json: JSON.stringify(a.args ?? {}),
    title: a.title.slice(0, 300),
    detail: a.detail.slice(0, 1000),
    status: "pending",
    created_at: iso(now),
  });
  return id;
}

export async function getAction(db: Db, s: SessionRow, id: string): Promise<ActionRow> {
  const r = await db.first<ActionRow>("SELECT * FROM chat_actions WHERE id = ? AND workspace_id = ? AND session_id = ? AND user_id = ?", id, s.workspace_id, s.id, s.user_id);
  if (!r) throw notFound("Action");
  return r;
}

export async function pendingActions(db: Db, s: SessionRow): Promise<ActionRow[]> {
  return db.all<ActionRow>("SELECT * FROM chat_actions WHERE workspace_id = ? AND session_id = ? AND status = 'pending'", s.workspace_id, s.id);
}

/** Conditional status change; true when this caller made it (exactly-once claim). */
export async function transitionAction(db: Db, a: ActionRow, from: ActionRow["status"], to: ActionRow["status"], now: Date, result?: { summary: string; data?: unknown }): Promise<boolean> {
  const r = await db.run(
    "UPDATE chat_actions SET status = ?, decided_at = COALESCE(decided_at, ?), result_json = COALESCE(?, result_json) WHERE id = ? AND workspace_id = ? AND status = ?",
    to,
    iso(now),
    result ? JSON.stringify(result).slice(0, 20_000) : null,
    a.id,
    a.workspace_id,
    from,
  );
  return r.changes === 1;
}

export async function actionsForMessage(db: Db, s: SessionRow, messageId: string): Promise<ChatAction[]> {
  const rows = await db.all<ActionRow>("SELECT * FROM chat_actions WHERE workspace_id = ? AND session_id = ? AND message_id = ? ORDER BY created_at, id", s.workspace_id, s.id, messageId);
  return rows.map(toAction);
}
