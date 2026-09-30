import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { createRunRoutes } from "@worker/routes/runs";
import { recommendationRoutes, ZERO_STATE_MESSAGE } from "@worker/routes/recommendations";
import { acquireRunLock } from "@worker/runs/locks";

/** Minimal app: routes under test with a fixed signed-in user (auth middleware is another module's). */
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
  app.route("/", recommendationRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
  return { app, call, started };
}

async function seedRec(env: Env, workspaceId: string, projectId: string, overrides: Record<string, unknown> = {}) {
  const db = new Db(env.DB);
  const evId = newId("ev");
  await db.insert("evidence", { id: evId, workspace_id: workspaceId, project_id: projectId, source: "gsc", window: "2026-08-30..2026-09-26", text: "1,234 impressions", data_json: "{}", hash: "h", created_at: FIXED_NOW.toISOString() });
  const id = newId("rec");
  await db.insert("recommendations", {
    id,
    workspace_id: workspaceId,
    project_id: projectId,
    agent: "seo",
    scope: "page",
    target_json: JSON.stringify({ kind: "url", url: "https://shop.example.com/a" }),
    issue_type: "weak_ctr",
    trigger: "From GSC query x",
    issue: "Weak CTR",
    action: "Rewrite title",
    rationale: "r",
    effort: "low",
    uncertainty: "medium",
    limitations: "l",
    verified: 1,
    priority: 0.5,
    priority_version: "p1",
    decision_label: "act",
    decision_score_json: JSON.stringify({ confidence: 0.91, provider: "typesafe", invented_metric: 3 }),
    evidence_ids_json: JSON.stringify([evId]),
    dedup_key: `dk-${id}`,
    status: "open",
    created_at: FIXED_NOW.toISOString(),
    updated_at: FIXED_NOW.toISOString(),
    ...overrides,
  });
  return { id, evId };
}

describe("runs routes", () => {
  it("manual runs are quota-limited to 3 per project per day and idempotent within a minute", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const { call, started } = makeApp(env, u.userId);

    const first = await call("POST", `/projects/${pid}/runs`, { agent: "seo" });
    expect(first.status).toBe(201);
    expect(first.json.data).toMatchObject({ agent: "seo", trigger: "manual", status: "pending" });
    // Same minute + agent -> same run, not a new one.
    const dup = await call("POST", `/projects/${pid}/runs`, { agent: "seo" });
    expect(dup.status).toBe(200);
    expect(dup.json.data.id).toBe(first.json.data.id);
    expect(started).toHaveLength(1);

    // Two more manual runs from earlier today (other minutes) fill the quota.
    for (let i = 1; i <= 2; i++) {
      await db.insert("agent_runs", { id: newId("run"), workspace_id: u.workspaceId, project_id: pid, agent: "geo", trigger: "manual", idempotency_key: `old-${i}`, status: "completed", created_at: "2026-09-30T01:0" + i + ":00.000Z" });
    }
    const over = await call("POST", `/projects/${pid}/runs`, { agent: "geo" });
    expect(over.status).toBe(429);
    expect(over.json.error.code).toBe("quota_exceeded");
  });

  it("rejects a manual run while another run holds the lock, without consuming quota", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await acquireRunLock(new Db(env.DB), pid, "geo", "run_active", FIXED_NOW);
    const { call } = makeApp(env, u.userId);
    const r = await call("POST", `/projects/${pid}/runs`, { agent: "geo" });
    expect(r.status).toBe(409);
    const n = await new Db(env.DB).first<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runs");
    expect(n?.n).toBe(0);
  });

  it("refuses runs on demo projects and validates the body", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const demo = await seedProject(env, u.workspaceId, { is_demo: 1 });
    const pid = await seedProject(env, u.workspaceId);
    const { call } = makeApp(env, u.userId);
    const r = await call("POST", `/projects/${demo}/runs`, { agent: "seo" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("demo_project");
    expect((await call("POST", `/projects/${pid}/runs`, { agent: "reddit" })).status).toBe(400);
  });

  it("cancel sets cancel_requested; a pending run is cancelled immediately; cross-tenant is 404", async () => {
    const env = createTestEnv();
    const a = await seedUser(env);
    const b = await seedUser(env);
    const pid = await seedProject(env, a.workspaceId);
    const { call } = makeApp(env, a.userId);
    const created = await call("POST", `/projects/${pid}/runs`, { agent: "seo" });
    const runId = created.json.data.id;
    const other = makeApp(env, b.userId);
    expect((await other.call("POST", `/runs/${runId}/cancel`)).status).toBe(404);
    expect((await other.call("GET", `/runs/${runId}`)).status).toBe(404);
    const res = await call("POST", `/runs/${runId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.json.data.status).toBe("cancelled");
  });

  it("run detail includes events (with agent) and decisions", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const runId = newId("run");
    await db.insert("agent_runs", { id: runId, workspace_id: u.workspaceId, project_id: pid, agent: "geo", trigger: "schedule", idempotency_key: "k", status: "completed", created_at: FIXED_NOW.toISOString() });
    await db.insert("run_events", { id: newId("evt"), workspace_id: u.workspaceId, project_id: pid, run_id: runId, step: "geo.batch", status: "completed", message: "ok", created_at: FIXED_NOW.toISOString() });
    await db.insert("decision_records", { id: newId("dec"), workspace_id: u.workspaceId, project_id: pid, run_id: runId, agent: "geo", candidate_key: "c1", outcome: "rejected", reason_code: "low_fit", answer_json: JSON.stringify({ type: "noul", noul: 0.1 }), created_at: FIXED_NOW.toISOString() });
    const { call } = makeApp(env, u.userId);
    const r = await call("GET", `/runs/${runId}`);
    expect(r.status).toBe(200);
    expect(r.json.data.events[0]).toMatchObject({ step: "geo.batch", agent: "geo" });
    expect(r.json.data.decisions[0]).toMatchObject({ candidateKey: "c1", reasonCode: "low_fit", answer: { type: "noul", noul: 0.1 } });
    const list = await call("GET", `/projects/${pid}/runs`);
    expect(list.json.data).toHaveLength(1);
  });

  it("usage separates actual, estimated, and unknown costs", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const base = { workspace_id: u.workspaceId, project_id: pid, purpose: "t", status: "ok", created_at: FIXED_NOW.toISOString() };
    await db.insert("provider_calls", { ...base, id: newId("pc"), provider: "gemini", cost_usd: 0.01, cost_is_estimate: 0 });
    await db.insert("provider_calls", { ...base, id: newId("pc"), provider: "perplexity", cost_usd: 0.005, cost_is_estimate: 1 });
    await db.insert("provider_calls", { ...base, id: newId("pc"), provider: "typesafe", cost_usd: null, cost_is_estimate: 1 });
    await db.insert("provider_calls", { ...base, id: newId("pc"), provider: "typesafe", cost_usd: null, created_at: "2026-09-29T10:00:00.000Z" });
    const { call } = makeApp(env, u.userId);
    const r = await call("GET", `/projects/${pid}/usage`);
    expect(r.json.data.used).toEqual({ providerCalls: 3, usdActual: 0.01, usdEstimated: 0.005, usdUnknownCalls: 1 });
    expect(r.json.data.limits).toMatchObject({ crawlPages: 20, providerCallsPerDay: 60, usdPerDay: 0.5 });
    expect(r.json.data.calls.find((c: any) => c.provider === "typesafe")).toMatchObject({ costUsd: null, costIsEstimate: true });
    expect(r.json.data.notes.join(" ")).toContain("not counted as $0");
  });
});

describe("recommendation routes", () => {
  it("PATCH transitions: open -> approved -> implemented; invalid transitions are 409", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const { id } = await seedRec(env, u.workspaceId, pid);
    const { call } = makeApp(env, u.userId);

    expect((await call("PATCH", `/recommendations/${id}`, { status: "implemented" })).status).toBe(409);
    const approved = await call("PATCH", `/recommendations/${id}`, { status: "approved" });
    expect(approved.status).toBe(200);
    expect(approved.json.data).toMatchObject({ id, status: "approved" });
    const done = await call("PATCH", `/recommendations/${id}`, { status: "implemented" });
    expect(done.json.data).toMatchObject({ status: "implemented", stage: "marked_implemented" });
    expect((await call("PATCH", `/recommendations/${id}`, { status: "open" })).status).toBe(409);
    expect((await call("PATCH", `/recommendations/${id}`, { action: "Changed" })).status).toBe(409);

    const detail = await call("GET", `/recommendations/${id}`);
    const events = detail.json.data.events.map((e: any) => e.event);
    expect(events).toEqual(["approved", "implemented"]);
    const implNote = detail.json.data.events[1].note as string;
    expect(implNote).toContain("Marked implemented");
    expect(implNote).toContain("not verified");
  });

  it("dismiss and reopen; edits are recorded as 'edited' events", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const { id } = await seedRec(env, u.workspaceId, pid);
    const { call } = makeApp(env, u.userId);
    const edited = await call("PATCH", `/recommendations/${id}`, { action: "Rewrite the title to match the query", suggestedSnippet: "Solid Brass Knobs", note: "tightened" });
    expect(edited.json.data).toMatchObject({ action: "Rewrite the title to match the query", suggestedSnippet: "Solid Brass Knobs", status: "open" });
    expect((await call("PATCH", `/recommendations/${id}`, { status: "dismissed" })).json.data.status).toBe("dismissed");
    expect((await call("PATCH", `/recommendations/${id}`, { status: "open" })).json.data.status).toBe("open");
    const detail = await call("GET", `/recommendations/${id}`);
    expect(detail.json.data.events.map((e: any) => e.event)).toEqual(["edited", "dismissed", "reopened"]);
    expect(detail.json.data.events[0].note).toContain("Edited action and suggested snippet");
    expect((await call("PATCH", `/recommendations/${id}`, { bogus: 1 })).status).toBe(400);
  });

  it("cross-tenant access to recommendations, details, and feedback is 404", async () => {
    const env = createTestEnv();
    const a = await seedUser(env);
    const b = await seedUser(env);
    const pid = await seedProject(env, a.workspaceId);
    const { id } = await seedRec(env, a.workspaceId, pid);
    const decisionId = newId("dec");
    await new Db(env.DB).insert("decision_records", { id: decisionId, workspace_id: a.workspaceId, project_id: pid, agent: "seo", candidate_key: "x", outcome: "selected", created_at: FIXED_NOW.toISOString() });
    const other = makeApp(env, b.userId);
    expect((await other.call("GET", `/recommendations/${id}`)).status).toBe(404);
    expect((await other.call("PATCH", `/recommendations/${id}`, { status: "dismissed" })).status).toBe(404);
    expect((await other.call("GET", `/projects/${pid}/recommendations`)).status).toBe(404);
    expect((await other.call("GET", `/projects/${pid}/attention`)).status).toBe(404);
    expect((await other.call("POST", `/decisions/${decisionId}/feedback`, { humanAnswer: "no" })).status).toBe(404);
    const row = await new Db(env.DB).first<{ status: string }>("SELECT status FROM recommendations WHERE id = ?", id);
    expect(row?.status).toBe("open");
  });

  it("list filters and maps decision fields to real provider field names only", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const { id, evId } = await seedRec(env, u.workspaceId, pid);
    await seedRec(env, u.workspaceId, pid, { agent: "geo", status: "dismissed" });
    const { call } = makeApp(env, u.userId);
    const seo = await call("GET", `/projects/${pid}/recommendations?agent=seo&status=open`);
    expect(seo.json.data).toHaveLength(1);
    expect(seo.json.data[0].decision).toEqual({ tier: "act", fields: { confidence: 0.91 }, provider: "typesafe" });
    expect((await call("GET", `/projects/${pid}/recommendations?status=bogus`)).status).toBe(400);
    const detail = await call("GET", `/recommendations/${id}`);
    expect(detail.json.data.evidence.map((e: any) => e.id)).toEqual([evId]);
  });

  it("[A18] feedback creates a labelled row", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const decisionId = newId("dec");
    const db = new Db(env.DB);
    await db.insert("decision_records", { id: decisionId, workspace_id: u.workspaceId, project_id: pid, agent: "seo", candidate_key: "x", question_id: "seo.query_intent", outcome: "selected", created_at: FIXED_NOW.toISOString() });
    const { call } = makeApp(env, u.userId);
    const r = await call("POST", `/decisions/${decisionId}/feedback`, { humanAnswer: "transactional", reason: "Query names a product" });
    expect(r.status).toBe(201);
    expect(r.json.data).toEqual({ ok: true });
    const fb = await db.first<{ human_answer: string; user_id: string }>("SELECT human_answer, user_id FROM judgment_feedback WHERE decision_record_id = ?", decisionId);
    expect(fb).toEqual({ human_answer: "transactional", user_id: u.userId });
  });

  it("attention feed shows the zero state and setup_required without credentials", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const { call } = makeApp(env, u.userId);
    const r = await call("GET", `/projects/${pid}/attention`);
    expect(r.status).toBe(200);
    for (const a of r.json.data.agents) {
      expect(a).toMatchObject({ newToday: 0, openApprovals: 0, lastRun: null, state: "setup_required", zeroStateMessage: ZERO_STATE_MESSAGE });
    }
    expect(r.json.data.recentEvents).toEqual([]);
  });

  it("attention feed counts today's recommendations and is ready with configured providers", async () => {
    const env = createTestEnv({ WRITER_API_KEY: "k", WRITER_PROVIDER: "anthropic", WRITER_MODEL: "configured-model", GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-test-model" });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await seedRec(env, u.workspaceId, pid);
    await seedRec(env, u.workspaceId, pid, { created_at: "2026-09-29T09:00:00.000Z" });
    const { call } = makeApp(env, u.userId);
    const r = await call("GET", `/projects/${pid}/attention`);
    const seo = r.json.data.agents.find((a: any) => a.agent === "seo");
    expect(seo).toMatchObject({ newToday: 1, openApprovals: 2, state: "ready", zeroStateMessage: null });
    const geo = r.json.data.agents.find((a: any) => a.agent === "geo");
    expect(geo).toMatchObject({ newToday: 0, state: "ready", zeroStateMessage: ZERO_STATE_MESSAGE });
    const demo = await seedProject(env, u.workspaceId, { is_demo: 1 });
    const d = await call("GET", `/projects/${demo}/attention`);
    expect(d.json.data.agents.every((a: any) => a.state === "demo")).toBe(true);
  });
});
