/**
 * Deploy readiness (H1, H3, L8): Workflow step retries must not redo finished work, step bookkeeping
 * is best-effort, the recommendation cap holds at save time, and the cron tick sweeps orphans.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@worker/geo/analyze", async (orig) => ({ ...(await orig<typeof import("@worker/geo/analyze")>()), analyzeObservation: vi.fn(async () => undefined) }));

import { Db } from "@worker/lib/db";
import type { Env } from "@worker/env";
import { executeRun, executeStep, type OrchestrateDeps, type StepFns } from "@worker/runs/orchestrate";
import { createRun } from "@worker/runs/runs-service";
import { sweepOrphans } from "@worker/runs/scheduler";
import { runGeoBatch } from "@worker/geo/batch";
import type { GeoProvider, WritingProvider } from "@worker/providers/types";
import { generateSeoRecommendations } from "@worker/seo/recommend/generate";
import { generateGeoProposals } from "@worker/geo/proposals";
import { saveRecommendation, type RecommendationDraft } from "@worker/recommendations/store";
import type { RunContext } from "@worker/runs/context";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { scenario } from "./fixtures/gsc/scenario";
import { fixture, seedObservation, seedPromptSet } from "./fixtures/geo-analysis/seed";

async function setup() {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId);
  return { env, db: new Db(env.DB), workspaceId: u.workspaceId, projectId, project: { id: projectId, workspaceId: u.workspaceId } };
}

async function newRun(db: Db, workspaceId: string, projectId: string, agent: "seo" | "geo", trigger: "manual" | "schedule" = "manual", now = FIXED_NOW) {
  const { runId } = await createRun(db, { workspaceId, projectId, agent, trigger, idempotencyKey: `k-${Math.random()}`, createdBy: null, now });
  return runId;
}

function countingDeps(project: { id: string; workspaceId: string }): OrchestrateDeps & { calls: string[] } {
  const calls: string[] = [];
  const step = (name: keyof StepFns) => async () => {
    calls.push(name);
    return { status: "completed", note: `${name} ok` };
  };
  return {
    calls,
    clock: () => FIXED_NOW,
    buildContext: async (e, runId) => makeTestContext(e, project, { runId }),
    steps: { runCrawl: step("runCrawl"), syncGsc: step("syncGsc"), generateSeoRecommendations: step("generateSeoRecommendations"), runGeoBatch: step("runGeoBatch"), generateGeoProposals: step("generateGeoProposals") },
  };
}

/** env whose D1 throws on statements matching `pattern` while `fail.on` is true. */
function flakyEnv(env: Env, pattern: RegExp): { env: Env; fail: { on: boolean } } {
  const fail = { on: false };
  const db = env.DB;
  const DB = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (fail.on && pattern.test(sql)) throw new Error("D1_ERROR: transient write failure");
          return target.prepare(sql);
        };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { env: { ...env, DB } as Env, fail };
}

// ------------------------------------------------------------------ H1: executeStep
describe("H1: executeStep is idempotent per (run, step)", () => {
  it("a retried step whose record is already saved returns it without re-running the work", async () => {
    const s = await setup();
    const runId = await newRun(s.db, s.workspaceId, s.projectId, "geo");
    const d = countingDeps(s.project);
    expect(await executeRun(s.env, runId, d)).toBe("completed");
    expect(d.calls).toEqual(["runGeoBatch", "generateGeoProposals"]);

    // Workflows retries step.do (e.g. the attempt timed out after saving): same runId, same step.
    const rec = await executeStep(s.env, runId, "geo.batch", d);
    expect(rec).toMatchObject({ step: "geo.batch", status: "completed", message: "runGeoBatch ok" });
    expect(d.calls).toEqual(["runGeoBatch", "generateGeoProposals"]);
  });

  it("a D1 error in the bookkeeping after the work does not throw (which would make Workflows redo the work)", async () => {
    const s = await setup();
    const runId = await newRun(s.db, s.workspaceId, s.projectId, "geo");
    const flaky = flakyEnv(s.env, /INSERT INTO run_events|UPDATE agent_runs SET summary_json|UPDATE run_locks/);
    const d = countingDeps(s.project);
    d.steps!.runGeoBatch = async () => {
      d.calls.push("runGeoBatch");
      flaky.fail.on = true; // the paid work is done; every write after it fails
      return { status: "completed", note: "sampled" };
    };
    const rec = await executeStep(flaky.env, runId, "geo.batch", d);
    expect(rec).toMatchObject({ status: "completed", message: "sampled" });
    expect(d.calls).toEqual(["runGeoBatch"]);
  });
});

// ------------------------------------------------------------------ H1: geo.batch dedup
function fakeProvider(id: string, seen: string[], onAsk?: () => Promise<void>): GeoProvider {
  return {
    id,
    label: id,
    model: `${id}-model-x`,
    groundingMode: "fake_search",
    async ask(prompt) {
      seen.push(prompt);
      await onAsk?.();
      return {
        provider: id, model: `${id}-model-x`, groundingMode: "fake_search", status: "ok", grounded: true, text: `answer to ${prompt}`,
        citations: [{ url: "https://brassco.example/p", title: "Brass Co", position: 1 }], searchQueries: ["q"], requestId: null,
        usage: { inputTokens: 1, outputTokens: 1, searchRequests: 1 }, costUsd: 0.001, costIsEstimate: true, rateVersion: "test", error: null, latencyMs: 1,
      };
    },
    async test() { return { ok: true, detail: "fake" }; },
  };
}

async function seedPrompts(db: Db, workspaceId: string, projectId: string, texts: string[]) {
  const setId = `gps_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert("geo_prompt_sets", { id: setId, workspace_id: workspaceId, project_id: projectId, version: 1, active: 1, created_at: FIXED_NOW.toISOString() });
  const ids: string[] = [];
  for (const [i, text] of texts.entries()) {
    const id = `gp_${Math.random().toString(36).slice(2, 10)}`;
    ids.push(id);
    await db.insert("geo_prompts", { id, workspace_id: workspaceId, project_id: projectId, prompt_set_id: setId, text, prompt_type: "discovery", stage: null, locale: "en-US", language: "en", approved: 1, position: i });
  }
  return ids;
}

describe("H1: geo.batch samples each prompt x provider once per run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a re-run of the step for the same run skips pairs already observed (no paid call, no second row)", async () => {
    const s = await setup();
    await seedPrompts(s.db, s.workspaceId, s.projectId, ["A", "B"]);
    const runId = await newRun(s.db, s.workspaceId, s.projectId, "geo");
    const seen: string[] = [];
    const ctx = () => makeTestContext(s.env, s.project, { runId, geoProviders: [fakeProvider("gemini", seen)] });
    expect(await runGeoBatch(ctx())).toMatchObject({ status: "completed", observations: 2 });
    const again = await runGeoBatch(ctx());
    expect(again).toMatchObject({ status: "completed", observations: 0 });
    expect(again.note).toMatch(/2 already sampled earlier in this run/);
    expect(seen).toEqual(["A", "B"]);
    const n = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM geo_observations WHERE run_id = ?", runId);
    expect(n?.n).toBe(2);
  });

  it("an overlapping attempt that stored the pair first wins; the late answer is not stored twice", async () => {
    const s = await setup();
    const [pid] = await seedPrompts(s.db, s.workspaceId, s.projectId, ["A"]);
    const runId = await newRun(s.db, s.workspaceId, s.projectId, "geo");
    const seen: string[] = [];
    const concurrent = async () => {
      await s.db.insert("geo_observations", {
        id: "gobs_other_attempt", workspace_id: s.workspaceId, project_id: s.projectId, run_id: runId, prompt_id: pid!, prompt_text: "A",
        prompt_type: "discovery", cohort_key: "c", provider: "gemini", model: "gemini-model-x", grounding_mode: "fake_search",
        measurement_type: "api", status: "ok", created_at: FIXED_NOW.toISOString(),
      });
    };
    const r = await runGeoBatch(makeTestContext(s.env, s.project, { runId, geoProviders: [fakeProvider("gemini", seen, concurrent)] }));
    expect(r.status).toBe("completed");
    const rows = await s.db.all<{ id: string }>("SELECT id FROM geo_observations WHERE run_id = ?", runId);
    expect(rows.map((x) => x.id)).toEqual(["gobs_other_attempt"]);
  });

  it("the unique index leaves manual imports (run_id NULL) unconstrained", async () => {
    const s = await setup();
    const row = (id: string) => ({
      id, workspace_id: s.workspaceId, project_id: s.projectId, run_id: null, prompt_id: null, prompt_text: "p", prompt_type: "discovery",
      cohort_key: "c", provider: "manual", model: "m", grounding_mode: "none", measurement_type: "manual_import", status: "ok", created_at: FIXED_NOW.toISOString(),
    });
    await s.db.insert("geo_observations", row("gobs_m1"));
    await s.db.insert("geo_observations", row("gobs_m2"));
    const n = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM geo_observations WHERE project_id = ?", s.projectId);
    expect(n?.n).toBe(2);
  });
});

// ------------------------------------------------------------------ H3: cap at save time, deadline
const foreignDraft = (agent: "seo" | "geo", i: number): RecommendationDraft => ({
  agent, scope: "site", target: { kind: "site" }, issueType: `other_attempt_${i}`, trigger: "t", issue: "i", action: "a", rationale: "r",
  effort: "low", uncertainty: "low", limitations: "l", verified: false, priority: 1, priorityVersion: "v", decisionTier: null, decisionFields: null,
  evidenceIds: [], evidenceBullets: [], confirmPlaceholders: [], dedupKey: `other:${agent}:${i}`, writerProvider: null, writerModel: null,
});

const ENGINE_QUERIES = ["brass cabinet knob", "how to clean unlacquered brass", "outdoor brass lantern price"];

describe("H3: seo.recommend", () => {
  it("re-checks the 0-2/day cap right before saving (another attempt saved while this one drafted)", async () => {
    const s = await scenario({ engineQueries: ENGINE_QUERIES });
    let raced = false;
    const ctx: RunContext = s.ctx({ decisions: null, writer: null });
    ctx.isCancelled = async () => {
      if (!raced) {
        raced = true;
        await saveRecommendation(ctx, foreignDraft("seo", 1));
        await saveRecommendation(ctx, foreignDraft("seo", 2));
      }
      return false;
    };
    const res = await generateSeoRecommendations(ctx);
    expect(res.created).toBe(0);
    const n = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM recommendations WHERE project_id = ? AND agent = 'seo'", s.projectId);
    expect(n?.n).toBe(2);
  });

  it("starts no new draft once the in-step deadline has passed (the step stays under its Workflow timeout)", async () => {
    const s = await scenario({ engineQueries: ENGINE_QUERIES });
    let first = true;
    // 23 minutes pass after the step starts (e.g. slow Jev/writer); same UTC day.
    const clock = () => {
      if (first) {
        first = false;
        return FIXED_NOW;
      }
      return new Date(FIXED_NOW.getTime() + 23 * 60_000);
    };
    const res = await generateSeoRecommendations(s.ctx({ decisions: null, writer: null, clock }));
    expect(res.created).toBe(0);
    const control = await scenario({ engineQueries: ENGINE_QUERIES });
    expect((await generateSeoRecommendations(control.ctx({ decisions: null, writer: null }))).created).toBe(2);
  });
});

describe("H3: geo.proposals", () => {
  it("re-checks the 0-2/day cap right before saving (another attempt saved while this one drafted)", async () => {
    const s = await setup();
    const { analyzeObservation } = await vi.importActual<typeof import("@worker/geo/analyze")>("@worker/geo/analyze");
    const base = makeTestContext(s.env, s.project);
    const prompts = ["Where can I buy solid brass cabinet hardware?", "Best brass knobs for a kitchen"];
    const { promptIds } = await seedPromptSet(s.env, s.project, prompts);
    for (const [i, prompt] of prompts.entries()) {
      for (const provider of ["gemini", "perplexity"]) {
        const id = await seedObservation(s.env, s.project, { ...fixture("competitor_only"), prompt }, { provider, promptId: promptIds[i]!, createdAt: new Date(FIXED_NOW.getTime() - 3600_000).toISOString() });
        await analyzeObservation(base, id);
      }
    }
    let raced = false;
    const writer: WritingProvider = {
      name: "fake",
      model: "fake-writer-1",
      async write() {
        if (!raced) {
          raced = true;
          await saveRecommendation(base, foreignDraft("geo", 1));
          await saveRecommendation(base, foreignDraft("geo", 2));
        }
        throw new Error("writer call failed: slow");
      },
      async test() { return { ok: true, detail: "" }; },
    };
    const summary = await generateGeoProposals(makeTestContext(s.env, s.project, { writer }));
    expect(summary.created).toBe(0);
    const n = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM recommendations WHERE project_id = ? AND agent = 'geo'", s.projectId);
    expect(n?.n).toBe(2);
    const cap = await s.db.all("SELECT id FROM decision_records WHERE project_id = ? AND reason_code = 'daily_cap'", s.projectId);
    expect(cap.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ L8: orphan sweep
describe("L8: sweepOrphans (cron tick)", () => {
  it("removes manual runs orphaned in 'pending' with no dispatch claim, after 10 minutes only", async () => {
    const s = await setup();
    const old = await newRun(s.db, s.workspaceId, s.projectId, "seo", "manual", new Date(FIXED_NOW.getTime() - 11 * 60_000));
    const fresh = await newRun(s.db, s.workspaceId, s.projectId, "geo", "manual", new Date(FIXED_NOW.getTime() - 60_000));
    const claimed = await newRun(s.db, s.workspaceId, s.projectId, "geo", "manual", new Date(FIXED_NOW.getTime() - 60 * 60_000));
    await s.db.run("UPDATE agent_runs SET workflow_instance_id = id WHERE id = ?", claimed);
    const r = await sweepOrphans(s.env, FIXED_NOW);
    expect(r.manualRunsRemoved).toBe(1);
    const left = await s.db.all<{ id: string }>("SELECT id FROM agent_runs WHERE project_id = ? ORDER BY id", s.projectId);
    expect(left.map((x) => x.id).sort()).toEqual([fresh, claimed].sort());
    expect(left.some((x) => x.id === old)).toBe(false);
  });

  it("releases stale 'reserved' reservations of finished runs and returns their amounts to the counters", async () => {
    const s = await setup();
    const day = FIXED_NOW.toISOString().slice(0, 10);
    const pKey = `project:${s.projectId}`;
    const finished = await newRun(s.db, s.workspaceId, s.projectId, "geo");
    await s.db.run("UPDATE agent_runs SET status = 'failed' WHERE id = ?", finished);
    const active = await newRun(s.db, s.workspaceId, s.projectId, "seo");
    await s.db.run("UPDATE agent_runs SET status = 'running' WHERE id = ?", active);
    const at = (minAgo: number) => new Date(FIXED_NOW.getTime() - minAgo * 60_000).toISOString();
    await s.db.insert("usage_counters", { scope_key: pKey, day, resource: "provider_calls", used: 10, limit_value: 60 });
    await s.db.insert("usage_counters", { scope_key: "global", day, resource: "provider_calls", used: 10, limit_value: 3000 });
    const resv = (id: string, scope: string, runId: string | null, amount: number, status: string, created: string) =>
      s.db.insert("usage_reservations", { id, workspace_id: s.workspaceId, project_id: s.projectId, run_id: runId, scope_key: scope, day, resource: "provider_calls", amount, status, created_at: created, updated_at: created });
    await resv("r1", pKey, finished, 3, "reserved", at(90)); // stranded: released
    await resv("r1_g", "global", finished, 3, "reserved", at(90)); // its global twin: released
    await resv("r2", pKey, active, 2, "reserved", at(90)); // run still active: kept
    await resv("r3", pKey, finished, 4, "reserved", at(30)); // too recent: kept
    await resv("r4", pKey, finished, 1, "unknown", at(90)); // conservatively counted: kept
    await resv("r5", pKey, null, 1, "reserved", at(120)); // route-scoped, long gone: released

    const r = await sweepOrphans(s.env, FIXED_NOW);
    expect(r.reservationsReleased).toBe(3);
    const st = await s.db.all<{ id: string; status: string }>("SELECT id, status FROM usage_reservations ORDER BY id");
    expect(Object.fromEntries(st.map((x) => [x.id, x.status]))).toEqual({ r1: "released", r1_g: "released", r2: "reserved", r3: "reserved", r4: "unknown", r5: "released" });
    const counters = await s.db.all<{ scope_key: string; used: number }>("SELECT scope_key, used FROM usage_counters WHERE day = ? ORDER BY scope_key", day);
    expect(Object.fromEntries(counters.map((c) => [c.scope_key, c.used]))).toEqual({ global: 7, [pKey]: 6 });

    // Idempotent: a second tick releases nothing more.
    expect((await sweepOrphans(s.env, FIXED_NOW)).reservationsReleased).toBe(0);
    const again = await s.db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND day = ?", pKey, day);
    expect(again?.used).toBe(6);
  });
});
