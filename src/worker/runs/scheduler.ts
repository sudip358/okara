/**
 * Cron dispatcher (daily cadence; the cron trigger fires more often so failed/locked dispatches are
 * retried within the day). For each non-demo project with schedule_enabled, and each agent still due
 * today (selected in SQL, at most DISPATCH_EXAMINE_PER_TICK pairs per tick):
 *   idempotency_key = `${projectId}:${agent}:${YYYY-MM-DD}` -> INSERT OR IGNORE, so a duplicate tick
 *   can never create a second run. The pending run is then atomically claimed, locked, and started
 *   as a Workflow instance (or inline when the AGENT_RUN binding is absent, e.g. tests/dev).
 * Also sweeps stale work: pending schedule runs from earlier days (never started), dispatched runs
 * that never started, and 'running' runs whose lock has expired are marked failed so history stays
 * honest.
 */
import type { AgentKind } from "@shared/types";
import type { Env } from "../env";
import { Db } from "../lib/db";
import { addSeconds, iso, utcDay } from "../lib/time";
import { LOCK_TTL_SECONDS } from "./locks";
import type { OrchestrateDeps } from "./orchestrate";
import { claimAndLock, createRun, startRun } from "./runs-service";

export const AGENTS: readonly AgentKind[] = ["seo", "geo"];
/** Bound work per tick; remaining projects are picked up by the next tick the same day. */
export const DISPATCH_LIMIT_PER_TICK = 25;
/** Bound (project, agent) pairs examined per tick (about 6 D1 queries each; the Worker caps queries per invocation). */
export const DISPATCH_EXAMINE_PER_TICK = 60;

export const scheduleKey = (projectId: string, agent: AgentKind, now: Date) => `${projectId}:${agent}:${utcDay(now)}`;

export interface DispatchOptions {
  deps?: OrchestrateDeps;
  waitUntil?: (p: Promise<unknown>) => void;
  limit?: number;
  /** Max (project, agent) pairs examined per tick. */
  examineLimit?: number;
}

export interface DispatchResult {
  created: number;
  started: number;
  alreadyDispatched: number;
  locked: number;
  errors: number;
}

export async function dispatchDueRuns(env: Env, now: Date, opts: DispatchOptions = {}): Promise<DispatchResult> {
  const db = new Db(env.DB);
  const result: DispatchResult = { created: 0, started: 0, alreadyDispatched: 0, locked: 0, errors: 0 };
  const limit = opts.limit ?? DISPATCH_LIMIT_PER_TICK;

  await sweepStale(db, now);

  // Only (project, agent) pairs still due today: no run for today's key yet, or a pending run nobody has
  // claimed (it was locked on an earlier tick). Pairs never tried come first, so a locked tail cannot
  // starve them; the LIMIT caps pairs examined (and so D1 queries) per tick, not only runs started.
  const due = await db.all<{ id: string; workspace_id: string; agent: AgentKind }>(
    `SELECT p.id, p.workspace_id, a.agent FROM projects p
       CROSS JOIN (SELECT 'seo' AS agent UNION ALL SELECT 'geo') a
       LEFT JOIN agent_runs r ON r.idempotency_key = p.id || ':' || a.agent || ':' || ? AND r.project_id = p.id
      WHERE p.schedule_enabled = 1 AND p.is_demo = 0
        AND (r.id IS NULL OR (r.status = 'pending' AND r.workflow_instance_id IS NULL))
      ORDER BY (r.id IS NOT NULL), p.id, a.agent
      LIMIT ?`,
    utcDay(now),
    opts.examineLimit ?? DISPATCH_EXAMINE_PER_TICK,
  );
  for (const p of due) {
    const agent = p.agent;
    if (result.started >= limit) return result;
    try {
      const { runId, created } = await createRun(db, {
        workspaceId: p.workspace_id,
        projectId: p.id,
        agent,
        trigger: "schedule",
        idempotencyKey: scheduleKey(p.id, agent, now),
        createdBy: null,
        now,
      });
      if (created) result.created++;
      const claim = await claimAndLock(db, { id: runId, projectId: p.id, agent }, now, Boolean(env.AGENT_RUN));
      if (claim === "already_dispatched") {
        result.alreadyDispatched++;
        continue;
      }
      if (claim === "locked") {
        result.locked++;
        continue;
      }
      await startRun(env, db, { id: runId, projectId: p.id, agent }, now, { deps: opts.deps, waitUntil: opts.waitUntil });
      result.started++;
    } catch (e) {
      result.errors++;
      console.error("dispatch failed", p.id, agent, e instanceof Error ? e.message : "unknown");
    }
  }
  return result;
}

async function sweepStale(db: Db, now: Date): Promise<void> {
  const today = utcDay(now);
  await db.run(
    `UPDATE agent_runs SET status = 'failed', error = 'Not started: another run held the lock for the whole scheduling day.', finished_at = ?
      WHERE trigger = 'schedule' AND status = 'pending' AND workflow_instance_id IS NULL AND substr(created_at, 1, 10) < ?`,
    iso(now),
    today,
  );
  const cutoff = iso(addSeconds(now, -2 * LOCK_TTL_SECONDS));
  // Claimed for dispatch (workflow_instance_id set) but never started, and its lock has expired.
  await db.run(
    `UPDATE agent_runs SET status = 'failed', error = 'Dispatched but never started before its lock expired.', finished_at = ?
      WHERE status = 'pending' AND workflow_instance_id IS NOT NULL AND started_at IS NULL AND created_at < ?
        AND NOT EXISTS (SELECT 1 FROM run_locks l WHERE l.run_id = agent_runs.id AND l.expires_at > ?)`,
    iso(now),
    cutoff,
    iso(now),
  );
  await db.run(
    `UPDATE agent_runs SET status = 'failed', error = 'Run did not finish before its lock expired.', finished_at = ?
      WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?
        AND NOT EXISTS (SELECT 1 FROM run_locks l WHERE l.run_id = agent_runs.id AND l.expires_at > ?)`,
    iso(now),
    cutoff,
    iso(now),
  );
}

/** A manual run still pending with no dispatch claim after this long was orphaned by its request. */
export const ORPHANED_MANUAL_RUN_SECONDS = 10 * 60;
/** A reservation still 'reserved' after this long, with no active run, was stranded by a killed attempt. */
export const STALE_RESERVATION_SECONDS = 60 * 60;

export interface OrphanSweepResult {
  manualRunsRemoved: number;
  reservationsReleased: number;
}

/**
 * Cron-tick cleanup of work stranded by a request or step attempt that died midway (called from the
 * scheduled handler in src/worker/index.ts, before dispatch):
 * - Manual runs left 'pending' with no dispatch claim (the POST died between creating the run and
 *   claiming it) are deleted, as the route does for a run that could not take the lock, so they do not
 *   stay pending forever or use up the manual-run quota. They never started, so there is no history.
 * - Budget reservations left 'reserved' (never settled, released or marked unknown) by a killed step
 *   attempt, older than STALE_RESERVATION_SECONDS and not owned by a pending/running run, are released
 *   and their amounts returned to the project and global counters, so they stop blocking later runs.
 *   Both statements run in one D1 batch (a transaction), so a reservation is released at most once.
 */
export async function sweepOrphans(env: Env, now: Date): Promise<OrphanSweepResult> {
  const db = new Db(env.DB);
  const manual = await db.run(
    `DELETE FROM agent_runs
      WHERE trigger = 'manual' AND status = 'pending' AND workflow_instance_id IS NULL AND started_at IS NULL AND created_at < ?`,
    iso(addSeconds(now, -ORPHANED_MANUAL_RUN_SECONDS)),
  );
  const cutoff = iso(addSeconds(now, -STALE_RESERVATION_SECONDS));
  const stale = (t: string) => `${t}.status = 'reserved' AND ${t}.created_at < ?
      AND (${t}.run_id IS NULL OR NOT EXISTS (SELECT 1 FROM agent_runs a WHERE a.id = ${t}.run_id AND a.status IN ('pending', 'running')))`;
  const found = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_reservations r WHERE ${stale("r")}`, cutoff);
  if (!found?.n) return { manualRunsRemoved: manual.changes, reservationsReleased: 0 };
  await db.batch([
    [
      `UPDATE usage_counters
          SET used = MAX(0, used - (SELECT COALESCE(SUM(r.amount), 0) FROM usage_reservations r
                                     WHERE r.scope_key = usage_counters.scope_key AND r.day = usage_counters.day
                                       AND r.resource = usage_counters.resource AND ${stale("r")}))
        WHERE EXISTS (SELECT 1 FROM usage_reservations r
                       WHERE r.scope_key = usage_counters.scope_key AND r.day = usage_counters.day
                         AND r.resource = usage_counters.resource AND ${stale("r")})`,
      cutoff,
      cutoff,
    ],
    [`UPDATE usage_reservations SET status = 'released', settled_amount = 0, updated_at = ? WHERE ${stale("usage_reservations")}`, iso(now), cutoff],
  ]);
  return { manualRunsRemoved: manual.changes, reservationsReleased: found.n };
}
