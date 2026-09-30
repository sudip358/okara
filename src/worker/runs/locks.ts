/**
 * Per-project + per-agent active-run lock with expiry (run_locks). Acquisition is a single
 * INSERT OR IGNORE, or a conditional UPDATE that only takes over an expired lock (or re-enters a
 * lock already held by the same run). Release only deletes the caller's own lock.
 */
import type { AgentKind } from "@shared/types";
import type { Db } from "../lib/db";
import { addSeconds, iso } from "../lib/time";

/** Long enough for a full run with step retries; a crashed run frees the lock after this. */
export const LOCK_TTL_SECONDS = 60 * 60;

export async function acquireRunLock(db: Db, projectId: string, agent: AgentKind, runId: string, now: Date, ttlSeconds = LOCK_TTL_SECONDS): Promise<boolean> {
  const expires = iso(addSeconds(now, ttlSeconds));
  const ins = await db.run(
    "INSERT OR IGNORE INTO run_locks (project_id, agent, run_id, expires_at) VALUES (?, ?, ?, ?)",
    projectId,
    agent,
    runId,
    expires,
  );
  if (ins.changes === 1) return true;
  const upd = await db.run(
    `UPDATE run_locks SET run_id = ?, expires_at = ?
      WHERE project_id = ? AND agent = ? AND (expires_at <= ? OR run_id = ?)`,
    runId,
    expires,
    projectId,
    agent,
    iso(now),
    runId,
  );
  return upd.changes === 1;
}

/** Extend a held lock (e.g. between long steps). Returns false if the lock is no longer ours. */
export async function renewRunLock(db: Db, projectId: string, agent: AgentKind, runId: string, now: Date, ttlSeconds = LOCK_TTL_SECONDS): Promise<boolean> {
  const r = await db.run(
    "UPDATE run_locks SET expires_at = ? WHERE project_id = ? AND agent = ? AND run_id = ?",
    iso(addSeconds(now, ttlSeconds)),
    projectId,
    agent,
    runId,
  );
  return r.changes === 1;
}

export async function releaseRunLock(db: Db, projectId: string, agent: AgentKind, runId: string): Promise<void> {
  await db.run("DELETE FROM run_locks WHERE project_id = ? AND agent = ? AND run_id = ?", projectId, agent, runId);
}

export async function currentLockHolder(db: Db, projectId: string, agent: AgentKind, now: Date): Promise<string | null> {
  const row = await db.first<{ run_id: string; expires_at: string }>(
    "SELECT run_id, expires_at FROM run_locks WHERE project_id = ? AND agent = ?",
    projectId,
    agent,
  );
  if (!row || row.expires_at <= iso(now)) return null;
  return row.run_id;
}
