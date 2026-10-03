/**
 * Partial ("section") runs: step-subset validation, dependency 409s, setup 412s, engine filter, quota + lock
 * behaviour, scope persisted on agent_runs and shown in run summaries / activity, orchestration of only the
 * scoped steps (src/worker/runs/scope.ts, docs/api.md "Runs", build-kit amendment 2026-10-03).
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { createRunRoutes, MANUAL_RUNS_PER_PROJECT_PER_DAY } from "@worker/routes/runs";
import { AGENT_STEPS, executeRun, type StepFns } from "@worker/runs/orchestrate";
import { parseRunScope, stepsForScope } from "@worker/runs/scope";
import { buildRunContext } from "@worker/runs/runtime";
import { buildRunActivity } from "@worker/runs/activity";
import { createRun } from "@worker/runs/runs-service";
import type { ProjectRow } from "@worker/platform/access";
import { MANUAL_RUNS_PER_DAY, parseScope, scopeLabel } from "@shared/run-scope";

const GEMINI_ENV = { GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-test" } as Partial<Env>;

function makeApp(env: Env, userId: string, started: string[] = []) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", createRunRoutes({ start: async (run) => void started.push(run.id) }));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
  return { call, started };
}

async function setup(envOverrides: Partial<Env> = {}, projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv(envOverrides);
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId, projectOverrides);
  return { env, u, pid, db: new Db(env.DB) };
}

const manualCount = async (db: Db) => (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runs WHERE trigger = 'manual'"))!.n;

describe("parseRunScope", () => {
  it("accepts short or prefixed step ids, keeps run order, and treats every step as a full run", () => {
    expect(parseRunScope("seo", ["recommend", "seo.crawl"], undefined)).toEqual({ steps: ["crawl", "recommend"], engines: null });
    expect(parseRunScope("seo", ["crawl", "gsc_sync", "recommend"], undefined)).toBeNull();
    expect(parseRunScope("seo", undefined, undefined)).toBeNull();
    expect(parseRunScope("geo", ["batch"], ["gemini", "gemini"])).toEqual({ steps: ["batch"], engines: ["gemini"] });
    // Every GEO step but limited to one engine is still a partial run (the engine filter is the scope).
    expect(parseRunScope("geo", ["batch", "proposals"], ["perplexity"])).toEqual({ steps: ["batch", "proposals"], engines: ["perplexity"] });
    expect(parseRunScope("geo", ["batch"], ["custom_geo:abc"])?.engines).toEqual(["custom_geo:abc"]);
  });

  it("rejects unknown steps, steps of the other agent, and misplaced or unknown engines", () => {
    expect(() => parseRunScope("seo", ["batch"], undefined)).toThrow(/Unknown SEO step "batch"/);
    expect(() => parseRunScope("seo", ["validate"], undefined)).toThrow(/Valid steps: crawl, gsc_sync, recommend/);
    expect(() => parseRunScope("seo", [], undefined)).toThrow(/at least one step/);
    expect(() => parseRunScope("seo", ["crawl"], ["gemini"])).toThrow(/GEO runs only/);
    expect(() => parseRunScope("geo", ["proposals"], ["gemini"])).toThrow(/include "batch"/);
    expect(() => parseRunScope("geo", undefined, ["gemini"])).toThrow(/include "batch"/);
    expect(() => parseRunScope("geo", ["batch"], ["chatgpt_app"])).toThrow(/Unknown engine/);
    expect(() => parseRunScope("geo", ["batch"], [])).toThrow(/at least one engine/);
  });

  it("selects validate + scoped steps + summary; no scope (scheduled runs) keeps every step", () => {
    expect(stepsForScope("seo", AGENT_STEPS.seo, { steps: ["crawl"], engines: null })).toEqual(["seo.validate", "seo.crawl", "seo.summary"]);
    expect(stepsForScope("geo", AGENT_STEPS.geo, { steps: ["proposals"], engines: null })).toEqual(["geo.validate", "geo.proposals", "geo.summary"]);
    expect(stepsForScope("seo", AGENT_STEPS.seo, null)).toEqual(AGENT_STEPS.seo);
  });

  it("labels scopes for Runs and Live", () => {
    expect(scopeLabel({ steps: ["crawl"], engines: null })).toBe("Partial run: crawl only");
    expect(scopeLabel({ steps: ["crawl", "gsc_sync"], engines: null })).toBe("Partial run: crawl + Search Console sync");
    expect(scopeLabel({ steps: ["batch"], engines: ["gemini"] }, (id) => (id === "gemini" ? "Gemini" : id))).toBe("Partial run: ask AI engines (Gemini) only");
    expect(scopeLabel(null)).toBeNull();
    expect(parseScope("not json")).toBeNull();
    expect(parseScope('{"steps":["crawl","nope"]}')).toEqual({ steps: ["crawl"], engines: null });
  });
});

describe("POST /projects/:pid/runs with steps", () => {
  it("starts a partial run, persists its scope and returns it in run summaries", async () => {
    const { env, u, pid, db } = await setup();
    const { call, started } = makeApp(env, u.userId);
    const r = await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["crawl"] });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ agent: "seo", trigger: "manual", scope: { steps: ["crawl"], engines: null } });
    expect(started).toEqual([r.json.data.id]);
    const row = await db.first<{ scope_json: string | null }>("SELECT scope_json FROM agent_runs WHERE id = ?", r.json.data.id);
    expect(JSON.parse(row!.scope_json!)).toEqual({ steps: ["crawl"], engines: null });
    const list = await call("GET", `/projects/${pid}/runs`);
    expect(list.json.data[0].scope).toEqual({ steps: ["crawl"], engines: null });
    // A full manual run stores no scope.
    await db.run("DELETE FROM run_locks");
    const full = await call("POST", `/projects/${pid}/runs`, { agent: "geo" });
    expect(full.status).toBe(201);
    expect(full.json.data.scope).toBeNull();
  });

  it("rejects invalid bodies with 400 and uses no quota", async () => {
    const { env, u, pid, db } = await setup();
    const { call } = makeApp(env, u.userId);
    expect((await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["batch"] })).status).toBe(400);
    expect((await call("POST", `/projects/${pid}/runs`, { agent: "seo", step: ["crawl"] })).status).toBe(400);
    expect((await call("POST", `/projects/${pid}/runs`, { agent: "geo", steps: ["proposals"], engines: ["gemini"] })).status).toBe(400);
    expect(await manualCount(db)).toBe(0);
  });

  it("recommend alone needs stored crawl or Search Console data: 409 'Run the crawl first', then uses the latest", async () => {
    const { env, u, pid, db } = await setup();
    const { call } = makeApp(env, u.userId);
    const r = await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["recommend"] });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/^Run the crawl first/);
    expect(await manualCount(db)).toBe(0);
    // With the crawl in the same run there is no dependency.
    expect((await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["crawl", "recommend"] })).status).toBe(201);
    await db.run("DELETE FROM run_locks");
    await db.insert("crawl_runs", { id: newId("crawl"), workspace_id: u.workspaceId, project_id: pid, status: "partial", pages_limit: 50, started_at: FIXED_NOW.toISOString() });
    const ok = await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["recommend"] });
    expect(ok.status).toBe(201);
    expect(ok.json.data.scope.steps).toEqual(["recommend"]);
  });

  it("proposals alone need stored AI answers: 409 'Ask the AI engines first'", async () => {
    const { env, u, pid } = await setup();
    const { call } = makeApp(env, u.userId);
    const r = await call("POST", `/projects/${pid}/runs`, { agent: "geo", steps: ["proposals"] });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/^Ask the AI engines first/);
  });

  it("answers 412 setup_required for a crawl without a verified host or a sync without a property", async () => {
    const { env, u, pid } = await setup({}, { verified_host: null, gsc_property: null });
    const { call } = makeApp(env, u.userId);
    const crawl = await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["crawl"] });
    expect(crawl.status).toBe(412);
    expect(crawl.json.error.code).toBe("setup_required");
    expect((await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["gsc_sync"] })).status).toBe(412);
  });

  it("engine filter: validated against configured engines and stored", async () => {
    const none = await setup();
    const a = makeApp(none.env, none.u.userId);
    const r0 = await a.call("POST", `/projects/${none.pid}/runs`, { agent: "geo", steps: ["batch"], engines: ["gemini"] });
    expect(r0.status).toBe(412);

    const { env, u, pid, db } = await setup(GEMINI_ENV);
    const { call } = makeApp(env, u.userId);
    const wrong = await call("POST", `/projects/${pid}/runs`, { agent: "geo", steps: ["batch"], engines: ["perplexity"] });
    expect(wrong.status).toBe(412);
    expect(wrong.json.error.message).toMatch(/perplexity is not configured/);
    const ok = await call("POST", `/projects/${pid}/runs`, { agent: "geo", steps: ["batch"], engines: ["gemini"] });
    expect(ok.status).toBe(201);
    expect(ok.json.data.scope).toEqual({ steps: ["batch"], engines: ["gemini"] });
    const row = await db.first<{ idempotency_key: string }>("SELECT idempotency_key FROM agent_runs WHERE id = ?", ok.json.data.id);
    expect(row!.idempotency_key).toContain(":manual:batch@gemini:");
  });

  it("section runs share the daily manual cap (1 each); a locked agent refuses without using quota", async () => {
    const { env, u, pid, db } = await setup();
    expect(MANUAL_RUNS_PER_PROJECT_PER_DAY).toBe(MANUAL_RUNS_PER_DAY);
    const { call } = makeApp(env, u.userId);
    const crawl = await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["crawl"] });
    expect(crawl.status).toBe(201);
    // Same minute, same scope: the same run (double submit).
    const dup = await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["crawl"] });
    expect(dup.status).toBe(200);
    expect(dup.json.data.id).toBe(crawl.json.data.id);
    // Same minute, other scope, while the crawl run holds the SEO lock: 409, removed, no quota used.
    const locked = await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["gsc_sync"] });
    expect(locked.status).toBe(409);
    expect(locked.json.error.message).toMatch(/already in progress/);
    expect(await manualCount(db)).toBe(1);
    // The other agent is not locked (one lock per project + agent).
    expect((await call("POST", `/projects/${pid}/runs`, { agent: "geo" })).status).toBe(201);
    await db.run("DELETE FROM run_locks");
    expect((await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["gsc_sync"] })).status).toBe(201);
    await db.run("DELETE FROM run_locks");
    expect(await manualCount(db)).toBe(3);
    const q = await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["crawl", "gsc_sync"] });
    expect(q.status).toBe(429);
    expect(q.json.error.code).toBe("quota_exceeded");
  });

  it("demo projects refuse partial runs", async () => {
    const { env, u, pid } = await setup({}, { is_demo: 1 });
    const { call } = makeApp(env, u.userId);
    expect((await call("POST", `/projects/${pid}/runs`, { agent: "seo", steps: ["crawl"] })).status).toBe(409);
  });
});

describe("orchestration of a partial run", () => {
  function deps(env: Env, project: { id: string; workspaceId: string }) {
    const calls: string[] = [];
    const wrap = (name: keyof StepFns) => async () => {
      calls.push(name);
      return { status: "completed", note: `${name} ok` };
    };
    return {
      calls,
      clock: () => FIXED_NOW,
      buildContext: async (e: Env, runId: string) => makeTestContext(e, project, { runId }),
      steps: { runCrawl: wrap("runCrawl"), syncGsc: wrap("syncGsc"), generateSeoRecommendations: wrap("generateSeoRecommendations"), runGeoBatch: wrap("runGeoBatch"), generateGeoProposals: wrap("generateGeoProposals") },
    };
  }

  it("runs only the scoped work steps and logs the partial scope", async () => {
    const { env, u, pid, db } = await setup();
    const { runId } = await createRun(db, { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: "k1", createdBy: null, now: FIXED_NOW });
    await db.run("UPDATE agent_runs SET scope_json = ? WHERE id = ?", JSON.stringify({ steps: ["crawl"], engines: null }), runId);
    const d = deps(env, { id: pid, workspaceId: u.workspaceId });
    expect(await executeRun(env, runId, d)).toBe("completed");
    expect(d.calls).toEqual(["runCrawl"]);
    const evs = await db.all<{ step: string; status: string; message: string }>("SELECT step, status, message FROM run_events WHERE run_id = ? ORDER BY created_at, rowid", runId);
    expect(evs[0]!.message).toContain("Partial run: crawl only");
    expect(evs.some((e) => e.step === "seo.gsc_sync" || e.step === "seo.recommend")).toBe(false);
    const row = await db.first<{ summary_json: string }>("SELECT summary_json FROM agent_runs WHERE id = ?", runId);
    expect(Object.keys(JSON.parse(row!.summary_json).steps)).toEqual(["seo.validate", "seo.crawl"]);
  });

  it("scheduled runs (no scope) still run every step", async () => {
    const { env, u, pid, db } = await setup();
    const { runId } = await createRun(db, { workspaceId: u.workspaceId, projectId: pid, agent: "geo", trigger: "schedule", idempotencyKey: "s1", createdBy: null, now: FIXED_NOW });
    const d = deps(env, { id: pid, workspaceId: u.workspaceId });
    await executeRun(env, runId, d);
    expect(d.calls).toEqual(["runGeoBatch", "generateGeoProposals"]);
  });

  it("the engine filter limits the run's GEO providers and the activity lanes", async () => {
    const { env: base, u, pid, db } = await setup();
    const env = { ...base, ...GEMINI_ENV, PERPLEXITY_API_KEY: "p", PERPLEXITY_MODEL: "perplexity/sonar" } as Env;
    const { runId } = await createRun(db, { workspaceId: u.workspaceId, projectId: pid, agent: "geo", trigger: "manual", idempotencyKey: "g1", createdBy: null, now: FIXED_NOW });
    const full = await buildRunContext(env, runId, { fetchImpl: (async () => new Response("{}")) as typeof fetch });
    expect(full.geoProviders.map((p) => p.id)).toEqual(["gemini", "perplexity"]);
    await db.run("UPDATE agent_runs SET scope_json = ? WHERE id = ?", JSON.stringify({ steps: ["batch"], engines: ["perplexity"] }), runId);
    const ctx = await buildRunContext(env, runId, { fetchImpl: (async () => new Response("{}")) as typeof fetch });
    expect(ctx.geoProviders.map((p) => p.id)).toEqual(["perplexity"]);

    const project = (await db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", pid))!;
    const act = await buildRunActivity(db, project, runId, { now: FIXED_NOW, configuredEngines: ["gemini", "perplexity"] });
    expect(act!.run.scope).toEqual({ steps: ["batch"], engines: ["perplexity"] });
    expect(act!.lanes.map((l) => l.provider)).toEqual(["perplexity"]);
  });
});
