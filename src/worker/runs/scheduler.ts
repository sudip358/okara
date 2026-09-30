/**
 * Cron dispatcher (daily cadence; the cron trigger fires more often so failed/locked dispatches are
 * retried within the day). For each non-demo project with schedule_enabled, and each agent:
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

export const scheduleKey = (projectId: string, agent: AgentKind, now: Date) => `${projectId}:${agent}:${utcDay(now)}`;

export interface DispatchOptions {
  deps?: OrchestrateDeps;
  waitUntil?: (p: Promise<unknown>) => void;
  limit?: number;
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

  const projects = await db.all<{ id: string; workspace_id: string }>(
    "SELECT id, workspace_id FROM projects WHERE schedule_enabled = 1 AND is_demo = 0 ORDER BY id",
  );
  for (const p of projects) {
    for (const agent of AGENTS) {
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
