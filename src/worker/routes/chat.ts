/**
 * Ask Okara routes (docs/api.md "Ask Okara (chat)"). Every handler: requireUser + requireProject; sessions are
 * private to their user. POSTs are state-changing: the app-wide csrfProtection middleware enforces same-origin
 * Origin + X-CSRF-Token.
 *
 *   GET    /projects/:pid/chat/status                                  -> ChatStatus
 *   GET    /projects/:pid/chat/sessions                                -> ChatSessionSummary[] (history, newest first)
 *   POST   /projects/:pid/chat/sessions                                -> 201 ChatSessionSummary
 *   GET    /projects/:pid/chat/sessions/:sid                           -> ChatSessionDetail
 *   DELETE /projects/:pid/chat/sessions/:sid                           -> {deleted: true}
 *   POST   /projects/:pid/chat/sessions/:sid/messages  {content}       -> ChatTurnResult (?stream=1: ndjson ChatStreamEvent lines)
 *   POST   /projects/:pid/chat/sessions/:sid/actions/:aid/confirm      -> ChatTurnResult (?stream=1 likewise); body empty or
 *                                                                     {secret: {ok, keyHint}} for a secure-field action [A35]
 *   POST   /projects/:pid/chat/sessions/:sid/actions/:aid/cancel       -> ChatTurnResult (?stream=1 likewise)
 *
 * Errors before a turn starts are JSON: 400, 404, 409 chat_busy | chat_full, 412 setup_required, 429 rate_limited.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ChatStatus, ChatStreamEvent } from "@shared/types";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { badRequest, HttpError } from "../lib/errors";
import { requireProject } from "../platform/access";
import { hitRateLimit } from "../platform/rate-limit";
import { requireUser } from "../platform/require-user";
import { CHAT_MAX_TOOL_ROUNDS } from "../chat/loop";
import { chatModelStatus } from "../chat/model";
import { prepareDecision, prepareSend, type ChatDeps, type PreparedTurn } from "../chat/service";
import { CHAT_MAX_MESSAGE_CHARS, CHAT_SESSIONS_KEPT, createSession, deleteSession, listSessions, requireSession, sessionDetail, toSummary } from "../chat/store";
import type { ChatToolHooks } from "../chat/tools";

export const CHAT_SEND_RATE_LIMIT = { limit: 20, windowSeconds: 600 } as const;
export const CHAT_ACTION_RATE_LIMIT = { limit: 30, windowSeconds: 600 } as const;
export const CHAT_NEW_SESSION_RATE_LIMIT = { limit: 30, windowSeconds: 600 } as const;
/** JSON body cap for a message (4,000 characters, escaped). */
export const CHAT_MAX_BODY_BYTES = 64 * 1024;

const messageBody = z.object({ content: z.string().min(1).max(CHAT_MAX_MESSAGE_CHARS) }).strict();
/**
 * [A35] Confirm body: empty, or the secure-field report {secret: {ok, keyHint}} (last 4 characters only). Any other
 * field (e.g. apiKey) is refused: keys go to the credential routes, never to the chat.
 */
export const confirmBody = z
  .object({ secret: z.object({ ok: z.boolean(), keyHint: z.string().regex(/^[\x21-\x7e]{1,4}$/).nullable().optional() }).strict().optional() })
  .strict();
export const CHAT_CONFIRM_MAX_BODY_BYTES = 512;

// ------------------------------------------------------------------ test hooks
let toolHooks: ChatToolHooks | undefined;
let fetchOverride: typeof fetch | undefined;
/** Test hook: tool dependencies (manual-run start, competitor fetch) and the provider fetch. Pass {} to restore. */
export function setChatRouteHooks(h: { tools?: ChatToolHooks; fetch?: typeof fetch }): void {
  toolHooks = h.tools;
  fetchOverride = h.fetch;
}

async function limited(db: Db, key: string, rl: { limit: number; windowSeconds: number }, now: Date) {
  const r = await hitRateLimit(db, key, rl.limit, rl.windowSeconds, now);
  if (!r.allowed) throw new HttpError(429, "rate_limited", "Too many Ask Okara requests. Try again in a few minutes.", { retryAfterSeconds: r.retryAfterSeconds });
}

async function deps(c: Context<AppEnv>): Promise<ChatDeps> {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid")!);
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    const ec = c.executionCtx;
    waitUntil = (p) => ec.waitUntil(p);
  } catch {
    waitUntil = undefined;
  }
  return { env: c.env as Env, db, project, user, now: c.get("now"), waitUntil, hooks: toolHooks, fetchImpl: fetchOverride };
}

/** JSON (default) or an ndjson stream of ChatStreamEvent lines (?stream=1). */
async function respond(c: Context<AppEnv>, d: ChatDeps, prepared: PreparedTurn, status: 200 | 201 = 200) {
  if (c.req.query("stream") !== "1") return c.json({ data: await prepared.run() }, status);
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let open = true;
  const emit = (ev: ChatStreamEvent) => {
    if (!open) return;
    writer.write(enc.encode(`${JSON.stringify(ev)}\n`)).catch(() => {
      open = false; // client went away; the turn still finishes and is stored
    });
  };
  const work = prepared
    .run(emit)
    .catch(() => emit({ type: "error", code: "internal", message: "Something went wrong while answering." }))
    .finally(() => {
      open = false;
      writer.close().catch(() => {});
    });
  d.waitUntil?.(work);
  return new Response(readable, { status, headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export const chatRoutes = new Hono<AppEnv>();

chatRoutes.get("/projects/:pid/chat/status", async (c) => {
  const d = await deps(c);
  const s = await chatModelStatus(d.env, d.db, d.project.workspace_id);
  const data: ChatStatus = {
    state: s.ready ? "ready" : "setup_required",
    model: s.provider && s.model ? { provider: s.provider, model: s.model } : null,
    message: s.ready ? null : s.message,
    limits: { maxMessageChars: CHAT_MAX_MESSAGE_CHARS, maxToolRounds: CHAT_MAX_TOOL_ROUNDS, sessionsKept: CHAT_SESSIONS_KEPT },
  };
  return c.json({ data });
});

chatRoutes.get("/projects/:pid/chat/sessions", async (c) => {
  const d = await deps(c);
  return c.json({ data: await listSessions(d.db, { project: d.project, userId: d.user.id }) });
});

chatRoutes.post("/projects/:pid/chat/sessions", async (c) => {
  const d = await deps(c);
  await limited(d.db, `chat_new:${d.user.id}`, CHAT_NEW_SESSION_RATE_LIMIT, d.now);
  const s = await createSession(d.db, { project: d.project, userId: d.user.id }, d.now);
  return c.json({ data: toSummary(s) }, 201);
});

chatRoutes.get("/projects/:pid/chat/sessions/:sid", async (c) => {
  const d = await deps(c);
  const s = await requireSession(d.db, { project: d.project, userId: d.user.id }, c.req.param("sid"));
  return c.json({ data: await sessionDetail(d.db, s) });
});

chatRoutes.delete("/projects/:pid/chat/sessions/:sid", async (c) => {
  const d = await deps(c);
  const s = await requireSession(d.db, { project: d.project, userId: d.user.id }, c.req.param("sid"));
  if (s.status === "running") throw new HttpError(409, "chat_busy", "Wait for the current answer to finish before deleting this chat.");
  await deleteSession(d.db, { project: d.project, userId: d.user.id }, s.id);
  return c.json({ data: { deleted: true } });
});

chatRoutes.post("/projects/:pid/chat/sessions/:sid/messages", async (c) => {
  const d = await deps(c);
  const declared = Number(c.req.header("Content-Length") ?? NaN);
  if (Number.isFinite(declared) && declared > CHAT_MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Message is too large.");
  const raw = await c.req.text();
  if (raw.length > CHAT_MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Message is too large.");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  const parsed = messageBody.safeParse(json);
  if (!parsed.success) throw badRequest(`Send {content}: 1 to ${CHAT_MAX_MESSAGE_CHARS} characters.`);
  await limited(d.db, `chat_send:${d.user.id}`, CHAT_SEND_RATE_LIMIT, d.now);
  const prepared = await prepareSend(d, c.req.param("sid"), parsed.data.content);
  return respond(c, d, prepared);
});

for (const decision of ["confirm", "cancel"] as const) {
  chatRoutes.post(`/projects/:pid/chat/sessions/:sid/actions/:aid/${decision}`, async (c) => {
    const d = await deps(c);
    await limited(d.db, `chat_action:${d.user.id}`, CHAT_ACTION_RATE_LIMIT, d.now);
    let secret: { ok: boolean; keyHint: string | null } | null = null;
    if (decision === "confirm") {
      const raw = await c.req.text();
      if (raw.length > CHAT_CONFIRM_MAX_BODY_BYTES) throw badRequest("Confirm takes only {secret: {ok, keyHint}}; never send a key to the chat.");
      if (raw.trim()) {
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          throw badRequest("Request body must be JSON.");
        }
        // Never echo the body (it might hold a key sent by mistake).
        const parsed = confirmBody.safeParse(json);
        if (!parsed.success) throw badRequest("Confirm takes only {secret: {ok, keyHint}}; never send a key to the chat.");
        if (parsed.data.secret) secret = { ok: parsed.data.secret.ok, keyHint: parsed.data.secret.keyHint ?? null };
      }
    }
    const prepared = await prepareDecision(d, c.req.param("sid")!, c.req.param("aid")!, decision, secret);
    return respond(c, d, prepared);
  });
}
