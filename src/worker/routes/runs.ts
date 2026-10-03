/**
 * Runs + usage routes (runtime module).
 *   GET  /projects/:pid/runs        RunSummary[]
 *   GET  /runs/:id                  RunDetail (events + decisions)
 *   POST /projects/:pid/runs        manual run {agent, steps?, engines?}; max 3 manual runs per project per UTC day
 *                                   (a partial run of some steps counts as one manual run; src/worker/runs/scope.ts)
 *   POST /runs/:id/cancel           sets cancel_requested; pending runs are cancelled immediately
 *   GET  /projects/:pid/usage       UsageSummary
 * Access always resolves through requireProject (membership check), including for /runs/:id.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AgentKind, DecisionRecord, RunDetail, RunEvent, UsageSummary } from "@shared/types";
import type { AppEnv } from "../app";
import { requireUser } from "../platform/require-user";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors";
import { iso, utcDay } from "../lib/time";
import { requireProject, type ProjectRow } from "../platform/access";
import type { Env } from "../env";
import { loadProjectLimits } from "../runs/budget";
import { releaseRunLock } from "../runs/locks";
import type { OrchestrateDeps } from "../runs/orchestrate";
import type { RunRow } from "../runs/runtime";
import { claimAndLock, createManualRun, startRun, toRunSummary } from "../runs/runs-service";
import { checkScopeReady, parseRunScope } from "../runs/scope";
import { MANUAL_RUNS_PER_DAY, type RunScope } from "@shared/run-scope";

export const MANUAL_RUNS_PER_PROJECT_PER_DAY = MANUAL_RUNS_PER_DAY;

const manualRunBody = z
  .object({
    agent: z.enum(["seo", "geo"]),
    /** Partial run: work steps to run ("crawl", "gsc_sync", "recommend" | "batch", "proposals"); omit = all. */
    steps: z.array(z.string().max(40)).max(10).optional(),
    /** GEO batch only: engine lanes to ask ("gemini", "custom_geo:<id>", ...). */
    engines: z.array(z.string().max(100)).max(20).optional(),
  })
  .strict();

export interface RunRouteDeps {
  orchestrate?: OrchestrateDeps;
  /** Test hook to replace how a claimed run is started. */
  start?: (run: { id: string; projectId: string; agent: AgentKind }) => Promise<void>;
}

async function loadRunForUser(db: Db, userId: string, runId: string): Promise<RunRow> {
  const row = await db.first<RunRow>(
    `SELECT r.* FROM agent_runs r JOIN memberships m ON m.workspace_id = r.workspace_id AND m.user_id = ? WHERE r.id = ?`,
    userId,
    runId,
  );
  if (!row) throw notFound("Run");
  await requireProject(db, userId, row.project_id);
  return row;
}

export function mapDecision(r: Record<string, unknown>): DecisionRecord {
  return {
    id: String(r.id),
    runId: (r.run_id as string | null) ?? null,
    agent: r.agent as AgentKind,
    candidateKey: String(r.candidate_key),
    questionId: (r.question_id as string | null) ?? null,
    questionVersion: (r.question_version as string | null) ?? null,
    policyVersion: (r.policy_version as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    answer: parseJson<unknown>(r.answer_json, null),
    tier: (r.tier as DecisionRecord["tier"]) ?? null,
    outcome: r.outcome as DecisionRecord["outcome"],
    reasonCode: (r.reason_code as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

export function mapEvent(r: Record<string, unknown>): RunEvent {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    ...(r.agent === "seo" || r.agent === "geo" ? { agent: r.agent } : {}),
    step: String(r.step),
    status: r.status as RunEvent["status"],
    message: String(r.message),
    createdAt: String(r.created_at),
  };
}

/**
 * Manual run for a member (route POST /projects/:pid/runs and Ask Okara's confirmed run_agent_now action):
 * per-project daily quota, same-minute double-submit returns the existing run, demo projects refused, a run
 * refused because another run holds the lock is removed so it does not consume quota. Throws HttpError.
 * `scope` (already parsed with parseRunScope) makes it a partial run: pre-checked (409 missing stored data,
 * 412 missing setup) before any quota is used; it counts as one manual run in the same daily cap.
 */
export async function requestManualRun(
  env: Env,
  db: Db,
  project: ProjectRow,
  userId: string,
  agent: AgentKind,
  now: Date,
  opts: { deps?: RunRouteDeps; waitUntil?: (p: Promise<unknown>) => void; scope?: RunScope | null } = {},
): Promise<{ row: RunRow; created: boolean }> {
  const deps = opts.deps ?? {};
  const scope = opts.scope ?? null;
  if (project.is_demo === 1) throw new HttpError(409, "demo_project", "Demo projects use fixture data; runs are disabled.");
  await checkScopeReady(env, db, project, agent, scope, now);

  // Same project + agent (+ same scope) within the same minute (double submit) returns the existing run.
  const scopeKey = scope ? `:${scope.steps.join("+")}${scope.engines ? `@${scope.engines.join("+")}` : ""}` : "";
  const key = `${project.id}:${agent}:manual${scopeKey}:${Math.floor(now.getTime() / 60000)}`;
  const result = await createManualRun(db, {
    workspaceId: project.workspace_id,
    projectId: project.id,
    agent,
    idempotencyKey: key,
    createdBy: userId,
    now,
    perDay: MANUAL_RUNS_PER_PROJECT_PER_DAY,
    scope,
  });
  if (result.quotaExceeded || !result.runId) {
    throw new HttpError(429, "quota_exceeded", `Manual run limit reached (${MANUAL_RUNS_PER_PROJECT_PER_DAY} per project per UTC day). Scheduled runs continue daily.`);
  }
  const { runId, created } = result;
  const ref = { id: runId, projectId: project.id, agent };
  const claimAndStart = async () => {
    const claim = await claimAndLock(db, ref, now, Boolean(env.AGENT_RUN));
    if (claim === "locked") {
      // Never started: remove it so it does not consume the manual-run quota.
      await db.run("DELETE FROM agent_runs WHERE id = ? AND status = 'pending' AND started_at IS NULL", runId);
      throw conflict("A run for this project and agent is already in progress.");
    }
    if (claim === "claimed") {
      if (deps.start) await deps.start(ref);
      else await startRun(env, db, ref, now, { deps: deps.orchestrate, waitUntil: opts.waitUntil });
    }
  };
  if (created) {
    await claimAndStart();
  } else {
    // An existing run for this key (double submit). If it is still pending with no dispatch claim, the
    // request that created it died before claiming it (or lost the lock race): claim and start it now
    // instead of returning a run that would never start. claimAndLock is a conditional UPDATE, so a
    // concurrent request still inside its own claim cannot start it twice.
    const existing = await db.first<{ status: string; workflow_instance_id: string | null }>(
      "SELECT status, workflow_instance_id FROM agent_runs WHERE id = ? AND workspace_id = ?",
      runId,
      project.workspace_id,
    );
    if (existing?.status === "pending" && existing.workflow_instance_id === null) await claimAndStart();
  }
  const row = await db.first<RunRow>("SELECT * FROM agent_runs WHERE id = ?", runId);
  // Removed by a concurrent request that found the project + agent locked.
  if (!row) throw conflict("A run for this project and agent is already in progress.");
  return { row, created };
}

export function createRunRoutes(deps: RunRouteDeps = {}) {
  const routes = new Hono<AppEnv>();

  routes.get("/projects/:pid/runs", async (c) => {
    const user = requireUser(c);
    const db = c.get("db");
    const project = await requireProject(db, user.id, c.req.param("pid"));
    const rows = await db.all<RunRow>(
      "SELECT * FROM agent_runs WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC, id DESC LIMIT 100",
      project.workspace_id,
      project.id,
    );
    return c.json({ data: rows.map(toRunSummary) });
  });

  routes.get("/runs/:id", async (c) => {
    const user = requireUser(c);
    const db = c.get("db");
    const run = await loadRunForUser(db, user.id, c.req.param("id"));
    const events = await db.all(
      `SELECT e.*, r.agent FROM run_events e JOIN agent_runs r ON r.id = e.run_id
        WHERE e.workspace_id = ? AND e.project_id = ? AND e.run_id = ? ORDER BY e.created_at, e.rowid`,
      run.workspace_id,
      run.project_id,
      run.id,
    );
    const decisions = await db.all(
      "SELECT * FROM decision_records WHERE workspace_id = ? AND project_id = ? AND run_id = ? ORDER BY created_at, id LIMIT 500",
      run.workspace_id,
      run.project_id,
      run.id,
    );
    const detail: RunDetail = { ...toRunSummary(run), events: events.map(mapEvent), decisions: decisions.map(mapDecision) };
    return c.json({ data: detail });
  });

  routes.post("/projects/:pid/runs", async (c) => {
    const user = requireUser(c);
    const db = c.get("db");
    const now = c.get("now");
    const project = await requireProject(db, user.id, c.req.param("pid"));
    const parsed = manualRunBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw badRequest("Body must be {agent: 'seo' | 'geo', steps?: string[], engines?: string[]}.");
    const scope = parseRunScope(parsed.data.agent, parsed.data.steps, parsed.data.engines);
    let waitUntil: ((p: Promise<unknown>) => void) | undefined;
    try {
      const ec = c.executionCtx;
      waitUntil = (p) => ec.waitUntil(p);
    } catch {
      waitUntil = undefined;
    }
    const { row, created } = await requestManualRun(c.env, db, project, user.id, parsed.data.agent, now, { deps, waitUntil, scope });
    return c.json({ data: toRunSummary(row) }, created ? 201 : 200);
  });

  routes.post("/runs/:id/cancel", async (c) => {
    const user = requireUser(c);
    const db = c.get("db");
    const now = c.get("now");
    const run = await loadRunForUser(db, user.id, c.req.param("id"));
    if (run.status === "pending" || run.status === "running") {
      await db.run("UPDATE agent_runs SET cancel_requested = 1 WHERE id = ? AND workspace_id = ?", run.id, run.workspace_id);
      if (run.status === "pending" && run.started_at === null) {
        const r = await db.run(
          "UPDATE agent_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'pending' AND started_at IS NULL",
          iso(now),
          run.id,
        );
        if (r.changes === 1) await releaseRunLock(db, run.project_id, run.agent, run.id);
      }
    }
    const row = await db.first<RunRow>("SELECT * FROM agent_runs WHERE id = ?", run.id);
    return c.json({ data: toRunSummary(row!) });
  });

  routes.get("/projects/:pid/usage", async (c) => {
    const user = requireUser(c);
    const db = c.get("db");
    const now = c.get("now");
    const project = await requireProject(db, user.id, c.req.param("pid"));
    const day = utcDay(now);
    const limits = await loadProjectLimits(db, project.workspace_id, project.id);
    const calls = await db.all<{
      provider: string;
      model: string | null;
      purpose: string;
      status: string;
      cost_usd: number | null;
      cost_is_estimate: number;
      created_at: string;
    }>(
      `SELECT provider, model, purpose, status, cost_usd, cost_is_estimate, created_at FROM provider_calls
        WHERE workspace_id = ? AND project_id = ? AND substr(created_at, 1, 10) = ?
        ORDER BY created_at DESC`,
      project.workspace_id,
      project.id,
      day,
    );
    const actual = calls.filter((x) => x.cost_usd !== null && x.cost_is_estimate === 0);
    const estimated = calls.filter((x) => x.cost_usd !== null && x.cost_is_estimate === 1);
    const unknown = calls.filter((x) => x.cost_usd === null).length;
    const sum = (xs: typeof calls) => Math.round(xs.reduce((a, x) => a + (x.cost_usd ?? 0), 0) * 1e6) / 1e6;
    const notes = [
      `Counts are for ${day} (UTC). Every HTTP attempt, including retries and failures, counts as a provider call.`,
      "Actual cost is shown only when a provider returned it. Estimates use versioned configured rates and are labelled as estimates.",
      unknown > 0
        ? `${unknown} call(s) have unknown cost (no verified rate configured, e.g. TypeSafe/Jev and writer models); they are not counted as $0.`
        : "No calls with unknown cost today.",
      `Daily caps: ${limits.provider_calls_per_day} provider calls and $${(limits.usd_micros_per_day / 1e6).toFixed(2)} of priced spend per project, plus a global operator allowance. Spend on providers without returned or configured prices is bounded by call and token caps only.`,
    ];
    const summary: UsageSummary = {
      day,
      limits: {
        crawlPages: limits.crawl_pages,
        gscRows: limits.gsc_rows,
        geoPromptsPerRun: limits.geo_prompts_per_run,
        providerCallsPerDay: limits.provider_calls_per_day,
        usdPerDay: limits.usd_micros_per_day / 1e6,
      },
      used: {
        providerCalls: calls.length,
        usdActual: actual.length ? sum(actual) : null,
        usdEstimated: estimated.length ? sum(estimated) : null,
        usdUnknownCalls: unknown,
      },
      calls: calls.slice(0, 200).map((x) => ({
        provider: x.provider,
        model: x.model,
        purpose: x.purpose,
        status: x.status,
        costUsd: x.cost_usd,
        costIsEstimate: x.cost_usd === null ? true : x.cost_is_estimate === 1,
        createdAt: x.created_at,
      })),
      notes,
    };
    return c.json({ data: summary });
  });

  return routes;
}

export const runRoutes = createRunRoutes();
