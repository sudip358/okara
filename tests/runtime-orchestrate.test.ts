import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { Db } from "@worker/lib/db";
import { BudgetExceededError, SetupRequiredError } from "@worker/lib/errors";
import type { Env } from "@worker/env";
import { computeFinalStatus, executeRun, type OrchestrateDeps, type StepFns } from "@worker/runs/orchestrate";
import { acquireRunLock, currentLockHolder } from "@worker/runs/locks";
import { dispatchDueRuns, scheduleKey } from "@worker/runs/scheduler";
import { createRun } from "@worker/runs/runs-service";

async function setup() {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  return { env, db, u, projectId };
}

function deps(env: Env, project: { id: string; workspaceId: string }, steps: Partial<StepFns>, cancelAfter?: string): OrchestrateDeps & { calls: string[] } {
  const calls: string[] = [];
  const wrap = (name: keyof StepFns): StepFns[keyof StepFns] => async (ctx) => {
    calls.push(name);
    const fn = steps[name];
    const r = fn ? await fn(ctx) : { status: "completed", note: `${name} ok` };
    if (cancelAfter === name) await new Db(env.DB).run("UPDATE agent_runs SET cancel_requested = 1");
    return r;
  };
  return {
    calls,
    clock: () => FIXED_NOW,
    buildContext: async (e, runId) => makeTestContext(e, project, { runId }),
    steps: {
      runCrawl: wrap("runCrawl"),
      syncGsc: wrap("syncGsc"),
      generateSeoRecommendations: wrap("generateSeoRecommendations"),
      runGeoBatch: wrap("runGeoBatch"),
      generateGeoProposals: wrap("generateGeoProposals"),
    },
  };
}

async function newRun(db: Db, workspaceId: string, projectId: string, agent: "seo" | "geo", key = `k-${Math.random()}`) {
  const { runId } = await createRun(db, { workspaceId, projectId, agent, trigger: "manual", idempotencyKey: key, createdBy: null, now: FIXED_NOW });
  return runId;
}

async function runRow(db: Db, id: string) {
  return (await db.first<{ status: string; error: string | null; summary_json: string; started_at: string | null; finished_at: string | null }>("SELECT * FROM agent_runs WHERE id = ?", id))!;
}

async function events(db: Db, id: string) {
  return db.all<{ step: string; status: string; message: string }>("SELECT step, status, message FROM run_events WHERE run_id = ? ORDER BY created_at, rowid", id);
}

describe("orchestrate", () => {
  it("runs all SEO steps in order and completes", async () => {
    const { env, db, u, projectId } = await setup();
    const runId = await newRun(db, u.workspaceId, projectId, "seo");
    const d = deps(env, { id: projectId, workspaceId: u.workspaceId }, {});
    expect(await executeRun(env, runId, d)).toBe("completed");
    expect(d.calls).toEqual(["runCrawl", "syncGsc", "generateSeoRecommendations"]);
    const r = await runRow(db, runId);
    expect(r.status).toBe("completed");
    expect(r.started_at).not.toBeNull();
    expect(r.finished_at).not.toBeNull();
    const evs = await events(db, runId);
    expect(evs.map((e) => `${e.step}:${e.status}`)).toEqual([
      "seo.run:started",
      "seo.validate:started",
      "seo.validate:completed",
      "seo.crawl:started",
      "seo.crawl:completed",
      "seo.gsc_sync:started",
      "seo.gsc_sync:completed",
      "seo.recommend:started",
      "seo.recommend:completed",
      "seo.summary:completed",
    ]);
    expect(await currentLockHolder(db, projectId, "seo", FIXED_NOW)).toBeNull();
  });

  it("partial completion: a failing step keeps earlier results and later steps still run", async () => {
    const { env, db, u, projectId } = await setup();
    const runId = await newRun(db, u.workspaceId, projectId, "seo");
    const d = deps(env, { id: projectId, workspaceId: u.workspaceId }, {
      runCrawl: async () => ({ status: "completed", note: "20 of 20 pages crawled", crawlRunId: "cr_1" }),
      syncGsc: async () => {
        throw new Error("GSC quota exceeded");
      },
    });
    expect(await executeRun(env, runId, d)).toBe("partial");
    expect(d.calls).toEqual(["runCrawl", "syncGsc", "generateSeoRecommendations"]);
    const r = await runRow(db, runId);
    const summary = JSON.parse(r.summary_json);
    expect(summary.steps["seo.crawl"]).toMatchObject({ status: "completed", summary: { crawlRunId: "cr_1" } });
    expect(summary.steps["seo.gsc_sync"]).toMatchObject({ status: "failed", reason: "error" });
    expect(r.error).toContain("GSC quota exceeded");
    const evs = await events(db, runId);
    expect(evs).toContainEqual({ step: "seo.gsc_sync", status: "failed", message: "GSC quota exceeded" });
  });

  it("setup_required steps are skipped with a reason; all-skipped run is setup_required", async () => {
    const { env, db, u, projectId } = await setup();
    const runId = await newRun(db, u.workspaceId, projectId, "geo");
    const d = deps(env, { id: projectId, workspaceId: u.workspaceId }, {
      runGeoBatch: async () => ({ status: "setup_required", note: "No GEO provider configured." }),
      generateGeoProposals: async () => {
        throw new SetupRequiredError("writer", "Writing provider not configured.");
      },
    });
    expect(await executeRun(env, runId, d)).toBe("setup_required");
    const evs = await events(db, runId);
    expect(evs).toContainEqual({ step: "geo.batch", status: "skipped", message: "Skipped (setup required): No GEO provider configured." });
    expect(evs).toContainEqual({ step: "geo.proposals", status: "skipped", message: "Skipped (setup required): Writing provider not configured." });
  });

  it("a partly configured run completes with skipped steps noted", async () => {
    const { env, db, u, projectId } = await setup();
    const runId = await newRun(db, u.workspaceId, projectId, "seo");
    const d = deps(env, { id: projectId, workspaceId: u.workspaceId }, { syncGsc: async () => ({ status: "setup_required", note: "GSC not connected." }) });
    expect(await executeRun(env, runId, d)).toBe("completed");
    expect(JSON.parse((await runRow(db, runId)).summary_json).final.counts).toMatchObject({ skipped: 1 });
  });

  it("cancellation stops future steps", async () => {
    const { env, db, u, projectId } = await setup();
    const runId = await newRun(db, u.workspaceId, projectId, "seo");
    const d = deps(env, { id: projectId, workspaceId: u.workspaceId }, {}, "runCrawl");
    expect(await executeRun(env, runId, d)).toBe("cancelled");
    expect(d.calls).toEqual(["runCrawl"]);
    const evs = await events(db, runId);
    expect(evs.filter((e) => e.status === "skipped").map((e) => e.step)).toEqual(["seo.gsc_sync", "seo.recommend", "seo.summary"]);
    expect((await runRow(db, runId)).status).toBe("cancelled");
    expect(await currentLockHolder(db, projectId, "seo", FIXED_NOW)).toBeNull();
  });

  it("releases the lock when steps fail and the run fails", async () => {
    const { env, db, u, projectId } = await setup();
    const runId = await newRun(db, u.workspaceId, projectId, "geo");
    const boom = async () => {
      throw new Error("boom");
    };
    const d = deps(env, { id: projectId, workspaceId: u.workspaceId }, { runGeoBatch: boom, generateGeoProposals: boom });
    expect(await executeRun(env, runId, d)).toBe("failed");
    expect(await currentLockHolder(db, projectId, "geo", FIXED_NOW)).toBeNull();
  });

  it("releases the lock even when building the context throws", async () => {
    const { env, db, u, projectId } = await setup();
    const runId = await newRun(db, u.workspaceId, projectId, "seo");
    const d: OrchestrateDeps = { clock: () => FIXED_NOW, buildContext: async () => { throw new Error("D1 unavailable"); } };
    expect(await executeRun(env, runId, d)).toBe("failed");
    expect(await currentLockHolder(db, projectId, "seo", FIXED_NOW)).toBeNull();
  });

  it("does not start when another run holds the lock", async () => {
    const { env, db, u, projectId } = await setup();
    await acquireRunLock(db, projectId, "seo", "run_other", FIXED_NOW);
    const runId = await newRun(db, u.workspaceId, projectId, "seo");
    const d = deps(env, { id: projectId, workspaceId: u.workspaceId }, {});
    expect(await executeRun(env, runId, d)).toBeNull();
    expect(d.calls).toEqual([]);
    expect((await runRow(db, runId)).status).toBe("failed");
    expect(await currentLockHolder(db, projectId, "seo", FIXED_NOW)).toBe("run_other");
  });

  it("budget failures on every step produce rate_limited", () => {
    const rec = (step: any, status: any, reason: any) => ({ step, status, reason, message: "", summary: null });
    expect(
      computeFinalStatus([rec("geo.validate", "completed", null), rec("geo.batch", "failed", "budget"), rec("geo.proposals", "failed", "budget")], false),
    ).toBe("rate_limited");
    expect(BudgetExceededError).toBeTruthy();
  });
});

describe("scheduler", () => {
  it("two dispatches on the same day create exactly one run per agent", async () => {
    const { env, db, u, projectId } = await setup();
    await seedProject(env, u.workspaceId, { is_demo: 1 }); // never scheduled
    await seedProject(env, u.workspaceId, { schedule_enabled: 0 }); // never scheduled
    const d = deps(env, { id: projectId, workspaceId: u.workspaceId }, {});
    const first = await dispatchDueRuns(env, FIXED_NOW, { deps: d });
    const second = await dispatchDueRuns(env, new Date(FIXED_NOW.getTime() + 15 * 60_000), { deps: d });
    expect(first.created).toBe(2);
    expect(second.created).toBe(0);
    const rows = await db.all<{ agent: string; idempotency_key: string; status: string; trigger: string }>("SELECT agent, idempotency_key, status, trigger FROM agent_runs ORDER BY agent");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotency_key)).toEqual([scheduleKey(projectId, "geo", FIXED_NOW), scheduleKey(projectId, "seo", FIXED_NOW)]);
    expect(rows.every((r) => r.status === "completed" && r.trigger === "schedule")).toBe(true);
    // Next day: new runs.
    const next = await dispatchDueRuns(env, new Date("2026-10-01T00:05:00Z"), { deps: d });
    expect(next.created).toBe(2);
  });

  it("starts a Workflow instance when the binding exists", async () => {
    const { env, db, projectId } = await setup();
    const created: Array<{ id?: string; params?: unknown }> = [];
    const wfEnv = { ...env, AGENT_RUN: { create: async (o: { id?: string; params?: unknown }) => (created.push(o), {}) } as unknown as Workflow };
    const r = await dispatchDueRuns(wfEnv, FIXED_NOW);
    expect(r.started).toBe(2);
    expect(created).toHaveLength(2);
    const rows = await db.all<{ id: string; workflow_instance_id: string; status: string }>("SELECT id, workflow_instance_id, status FROM agent_runs");
    for (const row of rows) {
      expect(row.workflow_instance_id).toBe(row.id);
      expect(created.some((c) => c.id === row.id && (c.params as { runId: string }).runId === row.id)).toBe(true);
    }
    // A duplicate tick does not create another instance.
    await dispatchDueRuns(wfEnv, FIXED_NOW);
    expect(created).toHaveLength(2);
    expect(await currentLockHolder(db, projectId, "seo", FIXED_NOW)).not.toBeNull();
  });

  it("a locked project+agent is retried on a later tick", async () => {
    const { env, db, u, projectId } = await setup();
    await acquireRunLock(db, projectId, "seo", "run_manual", FIXED_NOW, 600);
    const d = deps(env, { id: projectId, workspaceId: u.workspaceId }, {});
    const first = await dispatchDueRuns(env, FIXED_NOW, { deps: d });
    expect(first.locked).toBe(1);
    const later = new Date(FIXED_NOW.getTime() + 20 * 60_000); // lock expired
    const second = await dispatchDueRuns(env, later, { deps: d });
    expect(second.created).toBe(0);
    expect(second.started).toBe(1);
    const seo = await db.first<{ status: string }>("SELECT status FROM agent_runs WHERE agent = 'seo'");
    expect(seo?.status).toBe("completed");
  });
});
