/**
 * Shared run lifecycle helpers used by the cron dispatcher and the manual-run route:
 * idempotent creation (INSERT OR IGNORE on agent_runs.idempotency_key), an atomic dispatch claim,
 * lock acquisition, and starting either a Workflow instance or an inline execution.
 */
import type { AgentKind, RunStatus, RunSummary } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import { POLICY_VERSION } from "./policy";
import { acquireRunLock, releaseRunLock } from "./locks";
import { executeRun, type OrchestrateDeps } from "./orchestrate";
import type { RunRow } from "./runtime";
import { parseScope, type RunScope } from "@shared/run-scope";

export interface CreateRunInput {
  workspaceId: string;
  projectId: string;
  agent: AgentKind;
  trigger: "schedule" | "manual" | "demo";
  idempotencyKey: string;
  createdBy: string | null;
  now: Date;
}

/** Insert a pending run unless one with the same idempotency key exists. */
export async function createRun(db: Db, input: CreateRunInput): Promise<{ runId: string; created: boolean }> {
  const id = newId("run");
  const r = await db.run(
    `INSERT OR IGNORE INTO agent_runs (id, workspace_id, project_id, agent, trigger, idempotency_key, status, policy_version, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    id,
    input.workspaceId,
    input.projectId,
    input.agent,
    input.trigger,
    input.idempotencyKey,
    POLICY_VERSION,
    input.createdBy,
    iso(input.now),
  );
  if (r.changes === 1) return { runId: id, created: true };
  const existing = await db.first<{ id: string }>(
    "SELECT id FROM agent_runs WHERE idempotency_key = ? AND workspace_id = ? AND project_id = ?",
    input.idempotencyKey,
    input.workspaceId,
    input.projectId,
  );
  if (!existing) throw new Error("Idempotency key collision across projects.");
  return { runId: existing.id, created: false };
}

/**
 * Manual run with an atomic per-project daily quota: one conditional INSERT ... SELECT whose WHERE
 * counts today's manual runs, so concurrent requests (e.g. seo and geo at once) cannot exceed the quota.
 * Returns the existing run for a repeated idempotency key; `quotaExceeded` when the insert was refused.
 */
export async function createManualRun(
  db: Db,
  input: Omit<CreateRunInput, "trigger"> & { perDay: number; scope?: RunScope | null },
): Promise<{ runId: string | null; created: boolean; quotaExceeded: boolean }> {
  const existing = await db.first<{ id: string }>(
    "SELECT id FROM agent_runs WHERE idempotency_key = ? AND workspace_id = ? AND project_id = ?",
    input.idempotencyKey,
    input.workspaceId,
    input.projectId,
  );
  if (existing) return { runId: existing.id, created: false, quotaExceeded: false };
  const id = newId("run");
  const nowIso = iso(input.now);
  // Partial runs share the same daily cap: each counts as one manual run. scope_json (migration 0016) is only
  // written for a partial run, so full runs keep working on a database without that column.
  const scoped = input.scope ? JSON.stringify(input.scope) : null;
  const r = await db.run(
    `INSERT OR IGNORE INTO agent_runs (id, workspace_id, project_id, agent, trigger, idempotency_key, status, policy_version, created_by, created_at${scoped ? ", scope_json" : ""})
     SELECT ?, ?, ?, ?, 'manual', ?, 'pending', ?, ?, ?${scoped ? ", ?" : ""}
      WHERE (SELECT COUNT(*) FROM agent_runs
              WHERE workspace_id = ? AND project_id = ? AND trigger = 'manual' AND substr(created_at, 1, 10) = ?) < ?`,
    id,
    input.workspaceId,
    input.projectId,
    input.agent,
    input.idempotencyKey,
    POLICY_VERSION,
    input.createdBy,
    nowIso,
    ...(scoped ? [scoped] : []),
    input.workspaceId,
    input.projectId,
    nowIso.slice(0, 10),
    input.perDay,
  );
  if (r.changes === 1) return { runId: id, created: true, quotaExceeded: false };
  const dup = await db.first<{ id: string }>(
    "SELECT id FROM agent_runs WHERE idempotency_key = ? AND workspace_id = ? AND project_id = ?",
    input.idempotencyKey,
    input.workspaceId,
    input.projectId,
  );
  if (dup) return { runId: dup.id, created: false, quotaExceeded: false };
  return { runId: null, created: false, quotaExceeded: true };
}

/**
 * Atomically claim a pending run for dispatch and take the project+agent lock. Returns false when
 * another dispatcher already claimed it, or when another run holds the lock (claim is undone so a
 * later tick can retry).
 */
export async function claimAndLock(db: Db, run: { id: string; projectId: string; agent: AgentKind }, now: Date, useWorkflow: boolean): Promise<"claimed" | "already_dispatched" | "locked"> {
  const marker = useWorkflow ? run.id : `inline:${run.id}`;
  const claim = await db.run(
    "UPDATE agent_runs SET workflow_instance_id = ? WHERE id = ? AND status = 'pending' AND workflow_instance_id IS NULL",
    marker,
    run.id,
  );
  if (claim.changes !== 1) return "already_dispatched";
  if (!(await acquireRunLock(db, run.projectId, run.agent, run.id, now))) {
    await db.run("UPDATE agent_runs SET workflow_instance_id = NULL WHERE id = ? AND status = 'pending'", run.id);
    return "locked";
  }
  return "claimed";
}

export interface StartOptions {
  deps?: OrchestrateDeps;
  /** Keeps an inline run alive after the response (ExecutionContext.waitUntil). Absent: awaited. */
  waitUntil?: (p: Promise<unknown>) => void;
}

/** Start a claimed + locked run: Workflow instance when bound, otherwise inline. */
export async function startRun(env: Env, db: Db, run: { id: string; projectId: string; agent: AgentKind }, now: Date, opts: StartOptions = {}): Promise<"workflow" | "inline"> {
  if (env.AGENT_RUN) {
    try {
      await env.AGENT_RUN.create({ id: run.id, params: { runId: run.id } });
      return "workflow";
    } catch (e) {
      await db.run(
        "UPDATE agent_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'pending'",
        `Could not start the workflow: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`,
        iso(now),
        run.id,
      );
      await releaseRunLock(db, run.projectId, run.agent, run.id);
      throw e;
    }
  }
  const p = executeRun(env, run.id, opts.deps).catch((e) => {
    console.error("inline run failed", e instanceof Error ? e.message : "unknown");
  });
  if (opts.waitUntil) opts.waitUntil(p);
  else await p;
  return "inline";
}

// ------------------------------------------------------------------ mapping
export function toRunSummary(row: Pick<RunRow, "id" | "agent" | "trigger" | "status" | "created_at" | "started_at" | "finished_at" | "error" | "summary_json" | "scope_json">): RunSummary {
  return {
    id: row.id,
    agent: row.agent,
    trigger: row.trigger,
    status: row.status as RunStatus,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    summary: parseJson<Record<string, unknown>>(row.summary_json, {}),
    scope: parseScope(row.scope_json ?? null),
  };
}
