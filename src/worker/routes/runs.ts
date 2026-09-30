/**
 * Runs + usage routes (runtime module).
 *   GET  /projects/:pid/runs        RunSummary[]
 *   GET  /runs/:id                  RunDetail (events + decisions)
 *   POST /projects/:pid/runs        manual run {agent}; max 3 manual runs per project per UTC day
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
import { requireProject } from "../platform/access";
import { loadProjectLimits } from "../runs/budget";
import { releaseRunLock } from "../runs/locks";
import type { OrchestrateDeps } from "../runs/orchestrate";
import type { RunRow } from "../runs/runtime";
import { claimAndLock, createRun, startRun, toRunSummary } from "../runs/runs-service";

export const MANUAL_RUNS_PER_PROJECT_PER_DAY = 3;

const manualRunBody = z.object({ agent: z.enum(["seo", "geo"]) });

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
    if (!parsed.success) throw badRequest("Body must be {agent: 'seo' | 'geo'}.");
    const agent = parsed.data.agent;
    if (project.is_demo === 1) throw new HttpError(409, "demo_project", "Demo projects use fixture data; runs are disabled.");

    const day = utcDay(now);
    const used = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agent_runs
        WHERE workspace_id = ? AND project_id = ? AND trigger = 'manual' AND substr(created_at, 1, 10) = ?`,
      project.workspace_id,
      project.id,
      day,
    );
    const key = `${project.id}:${agent}:manual:${Math.floor(now.getTime() / 60000)}`;
    const dup = await db.first<RunRow>("SELECT * FROM agent_runs WHERE idempotency_key = ? AND project_id = ?", key, project.id);
    if (dup) return c.json({ data: toRunSummary(dup) });
    if ((used?.n ?? 0) >= MANUAL_RUNS_PER_PROJECT_PER_DAY) {
      throw new HttpError(429, "quota_exceeded", `Manual run limit reached (${MANUAL_RUNS_PER_PROJECT_PER_DAY} per project per day). Scheduled runs continue daily.`);
    }

    const { runId, created } = await createRun(db, {
      workspaceId: project.workspace_id,
      projectId: project.id,
      agent,
      trigger: "manual",
      idempotencyKey: key,
      createdBy: user.id,
      now,
    });
    const ref = { id: runId, projectId: project.id, agent };
    if (created) {
      const claim = await claimAndLock(db, ref, now, Boolean(c.env.AGENT_RUN));
      if (claim === "locked") {
        // Never started: remove it so it does not consume the manual-run quota.
        await db.run("DELETE FROM agent_runs WHERE id = ? AND status = 'pending' AND started_at IS NULL", runId);
        throw conflict("A run for this project and agent is already in progress.");
      }
      if (claim === "claimed") {
        if (deps.start) await deps.start(ref);
        else {
          let waitUntil: ((p: Promise<unknown>) => void) | undefined;
          try {
            const ec = c.executionCtx;
            waitUntil = (p) => ec.waitUntil(p);
          } catch {
            waitUntil = undefined;
          }
          await startRun(c.env, db, ref, now, { deps: deps.orchestrate, waitUntil });
        }
      }
    }
    const row = await db.first<RunRow>("SELECT * FROM agent_runs WHERE id = ?", runId);
    return c.json({ data: toRunSummary(row!) }, created ? 201 : 200);
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
