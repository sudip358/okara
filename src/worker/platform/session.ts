/**
 * Server-side sessions. The cookie holds a random token; D1 stores only its SHA-256.
 * Login/logout/rotation flows live in routes/auth.ts (platform-auth module).
 */
import type { Db } from "../lib/db";
import { sha256Hex } from "../lib/hash";
import { newId, randomToken } from "../lib/ids";
import { addSeconds, iso } from "../lib/time";
import type { SessionUser } from "./access";

export const SESSION_COOKIE = "__Host-okara_session";
export const SESSION_COOKIE_DEV = "okara_session"; // __Host- requires https; used only in development
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
export const SESSION_IDLE_SECONDS = 60 * 60 * 24 * 3;

export interface SessionRecord {
  id: string;
  user_id: string;
  csrf_token: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export async function createSession(db: Db, userId: string, now: Date, userAgent?: string | null, rotatedFrom?: string | null) {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const csrf = randomToken(24);
  await db.insert("sessions", {
    id,
    user_id: userId,
    csrf_token: csrf,
    created_at: iso(now),
    last_seen_at: iso(now),
    expires_at: iso(addSeconds(now, SESSION_TTL_SECONDS)),
    rotated_from: rotatedFrom ?? null,
    user_agent: userAgent?.slice(0, 200) ?? null,
  });
  return { token, id, csrfToken: csrf };
}

/** Resolve a session token to its user, enforcing absolute and idle expiry. */
export async function lookupSession(db: Db, token: string, now: Date): Promise<{ session: SessionRecord; user: SessionUser } | null> {
  if (!token || token.length > 200) return null;
  const id = await sha256Hex(token);
  const row = await db.first<SessionRecord & { email: string; name: string | null }>(
    `SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    id,
  );
  if (!row) return null;
  const expired = new Date(row.expires_at) <= now;
  const idle = addSeconds(new Date(row.last_seen_at), SESSION_IDLE_SECONDS) <= now;
  if (expired || idle) {
    await db.run("DELETE FROM sessions WHERE id = ?", id);
    return null;
  }
  // Touch at most every 5 minutes to limit writes.
  if (now.getTime() - new Date(row.last_seen_at).getTime() > 5 * 60 * 1000) {
    await db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", iso(now), id);
  }
  const { email, name, ...session } = row;
  return { session, user: { id: row.user_id, email, name } };
}

export async function deleteSession(db: Db, sessionId: string) {
  await db.run("DELETE FROM sessions WHERE id = ?", sessionId);
}

export { newId };
