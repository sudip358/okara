import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { RunActivity } from "@shared/types";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import type { ProjectRow } from "@worker/platform/access";
import { activityRoutes } from "@worker/routes/activity";
import { answerOutcome, buildRunActivity, decodeCursor, encodeCursor } from "@worker/runs/activity";
import { seedDemoProject } from "@worker/demo/seed";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";

function makeApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", activityRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  return async (path: string) => {
    const res = await app.request(path, { method: "GET" }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

const t = (sec: number) => new Date(FIXED_NOW.getTime() - 3_600_000 + sec * 1000).toISOString();

async function project(db: Db, id: string): Promise<ProjectRow> {
  return (await db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", id))!;
}

async function seedRun(db: Db, ws: string, pid: string, agent: "seo" | "geo", status: string, extra: Record<string, unknown> = {}) {
  const id = newId("run");
  await db.insert("agent_runs", {
    id, workspace_id: ws, project_id: pid, agent, trigger: "manual", idempotency_key: `k-${id}`, status,
    created_at: t(0), started_at: t(0), finished_at: status === "running" || status === "pending" ? null : t(600), ...extra,
  });
  return id;
}

async function seedPromptSet(db: Db, ws: string, pid: string, n: number) {
  const setId = newId("gps");
  await db.insert("geo_prompt_sets", { id: setId, workspace_id: ws, project_id: pid, version: 1, active: 1, created_at: t(-100) });
  const prompts: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = newId("gp");
    prompts.push(id);
    await db.insert("geo_prompts", {
      id, workspace_id: ws, project_id: pid, prompt_set_id: setId, text: `best brass pull ${i}`, prompt_type: "discovery",
      locale: "en-US", language: "en", approved: 1, position: i,
    });
  }
  return { setId, prompts };
}

async function seedObs(
  db: Db, ws: string, pid: string, runId: string, o: { promptId: string; setId: string; provider: string; at: string; status?: string; self?: { mentioned: 0 | 1; cited: 0 | 1 } | null; citeHost?: string; latency?: number | null; cost?: number | null },
) {
  const id = newId("obs");
  const req = `req-${id}`;
  await db.insert("geo_observations", {
    id, workspace_id: ws, project_id: pid, run_id: runId, prompt_id: o.promptId, prompt_set_id: o.setId, prompt_text: "best brass pull <b>x</b>",
    prompt_type: "discovery", cohort_key: "c1", provider: o.provider, model: "m", grounding_mode: "g", measurement_type: "api",
    status: o.status ?? "ok", grounded: 1, request_id: req, cost_usd: o.cost ?? null, cost_is_estimate: 1, error: o.status === "failed" ? "timeout" : null, created_at: o.at,
  });
  await db.insert("provider_calls", {
    id: newId("call"), workspace_id: ws, project_id: pid, run_id: runId, provider: o.provider, model: "m", purpose: "geo_answer",
    status: o.status === "failed" ? "timeout" : "ok", request_id: req, cost_usd: o.cost ?? null, cost_is_estimate: 1, latency_ms: o.latency ?? null, created_at: o.at,
  });
  if (o.self) {
    await db.insert("geo_brand_observations", {
      id: newId("gbo"), workspace_id: ws, project_id: pid, observation_id: id, brand_key: "self", is_self: 1, mentioned: o.self.mentioned, cited: o.self.cited,
      recommendation_status: "unknown", sentiment: "unknown", method: "deterministic",
    });
  }
  if (o.citeHost) {
    await db.insert("geo_citations", {
      id: newId("cit"), workspace_id: ws, project_id: pid, observation_id: id, url: `https://${o.citeHost}/a`, host: o.citeHost, position: 1, source_type: "other", source_type_method: "rule",
    });
  }
  return id;
}

describe("answerOutcome", () => {
  it("matches the board's definition", () => {
    expect(answerOutcome({ status: "failed", analysed: true, selfCited: true, selfMentioned: true })).toBe("failed");
    expect(answerOutcome({ status: "incomplete", analysed: false, selfCited: false, selfMentioned: false })).toBe("failed");
    expect(answerOutcome({ status: "ok", analysed: false, selfCited: false, selfMentioned: false })).toBeNull();
    expect(answerOutcome({ status: "ok", analysed: true, selfCited: true, selfMentioned: false })).toBe("cited");
    expect(answerOutcome({ status: "ok", analysed: true, selfCited: false, selfMentioned: true })).toBe("named");
    expect(answerOutcome({ status: "ok", analysed: true, selfCited: false, selfMentioned: false })).toBe("missing");
  });
});

describe("cursor", () => {
  it("round-trips and rejects garbage", () => {
    const c = { at: "2026-09-30T12:00:00.000Z", id: "obs:obs_abc" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(null)).toBeNull();
    expect(() => decodeCursor("!!!")).toThrow(HttpError);
    expect(() => decodeCursor(btoa("x|y"))).toThrow(HttpError);
  });
});

describe("GET /projects/:pid/runs/:runId/activity", () => {
  it("404s for another workspace's run and for a run of another project", async () => {
    const env = createTestEnv();
    const a = await seedUser(env);
    const b = await seedUser(env);
    const pa = await seedProject(env, a.workspaceId);
    const pa2 = await seedProject(env, a.workspaceId);
    const pb = await seedProject(env, b.workspaceId);
    const db = new Db(env.DB);
    const runB = await seedRun(db, b.workspaceId, pb, "seo", "completed");
    const runA2 = await seedRun(db, a.workspaceId, pa2, "seo", "completed");
    const call = makeApp(env, a.userId);
    expect((await call(`/projects/${pb}/runs/${runB}/activity`)).status).toBe(404);
    expect((await call(`/projects/${pa}/runs/${runB}/activity`)).status).toBe(404);
    expect((await call(`/projects/${pa}/runs/${runA2}/activity`)).status).toBe(404);
    expect((await call(`/projects/${pa2}/runs/${runA2}/activity`)).status).toBe(200);
    expect((await call(`/projects/${pb}/activity/current`)).status).toBe(404);
    expect((await call(`/projects/${pa}/runs/${runA2}/activity?after=bogus!`)).status).toBe(400);
  });

  it("pages with the cursor, returning only newer items in (at, id) order", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const run = await seedRun(db, u.workspaceId, pid, "seo", "completed");
    for (let i = 0; i < 7; i++) {
      await db.insert("run_events", { id: newId("evt"), workspace_id: u.workspaceId, project_id: pid, run_id: run, step: "seo.crawl", status: "info", message: `m${i}`, created_at: t(i * 10) });
      await db.insert("decision_records", {
        id: newId("dec"), workspace_id: u.workspaceId, project_id: pid, run_id: run, agent: "seo", candidate_key: `c${i}`, question_id: "seo.q", tier: i % 2 ? "flag" : "act", outcome: "selected", created_at: t(i * 10),
      });
    }
    // Same timestamp across sources: tie broken by id.
    const call = makeApp(env, u.userId);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const q: string = cursor ? `?limit=4&after=${cursor}` : "?limit=4";
      const r = await call(`/projects/${pid}/runs/${run}/activity${q}`);
      expect(r.status).toBe(200);
      const a = r.json.data as RunActivity;
      for (const it of a.items) seen.push(`${it.at}|${it.id}`);
      if (a.items.length === 0) {
        expect(a.cursor).toBe(cursor);
        break;
      }
      expect(a.items.length).toBeLessThanOrEqual(4);
      cursor = a.cursor;
    }
    expect(seen).toHaveLength(14);
    expect(new Set(seen).size).toBe(14);
    expect([...seen].sort()).toEqual(seen);
    // Totals are always full regardless of the cursor.
    const r = await call(`/projects/${pid}/runs/${run}/activity?limit=1&after=${cursor}`);
    expect(r.json.data.totals.decisions).toEqual({ act: 4, flag: 3, drop: 0 });
    // A new row after the cursor shows up alone.
    await db.insert("run_events", { id: newId("evt"), workspace_id: u.workspaceId, project_id: pid, run_id: run, step: "seo.summary", status: "completed", message: "done", created_at: t(500) });
    const r2 = await call(`/projects/${pid}/runs/${run}/activity?after=${cursor}`);
    expect(r2.json.data.items.map((i: any) => i.title)).toEqual(["done"]);
  });

  it("keeps null costs null in spend totals", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const run = await seedRun(db, u.workspaceId, pid, "seo", "completed");
    const base = { workspace_id: u.workspaceId, project_id: pid, run_id: run, model: "m", status: "ok" };
    const p = await project(db, pid);
    let a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    expect(a.totals.spend).toEqual({ usd: 0, isEstimate: false, unknownCalls: 0 });
    await db.insert("provider_calls", { id: newId("call"), ...base, provider: "typesafe", purpose: "seo.q", cost_usd: null, cost_is_estimate: 1, created_at: t(1) });
    a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    expect(a.totals.spend).toEqual({ usd: null, isEstimate: false, unknownCalls: 1 });
    expect(a.items[0]!.costUsd).toBeNull();
    await db.insert("provider_calls", { id: newId("call"), ...base, provider: "writer", purpose: "seo_recommendation", cost_usd: 0.0125, cost_is_estimate: 1, created_at: t(2) });
    await db.insert("provider_calls", { id: newId("call"), ...base, provider: "writer", purpose: "seo_recommendation", cost_usd: 0.002, cost_is_estimate: 0, created_at: t(3) });
    // Another run's call is not counted.
    const other = await seedRun(db, u.workspaceId, pid, "seo", "completed");
    await db.insert("provider_calls", { id: newId("call"), ...base, run_id: other, provider: "writer", purpose: "x", cost_usd: 5, cost_is_estimate: 0, created_at: t(3) });
    a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    expect(a.totals.providerCalls).toBe(3);
    expect(a.totals.spend).toEqual({ usd: 0.0145, isEstimate: true, unknownCalls: 1 });
  });

  it("shows lanes, queued pairs and outcomes for a GEO run mid-way", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    await db.run("UPDATE project_limits SET geo_prompts_per_run = 4 WHERE project_id = ?", pid);
    const { setId, prompts } = await seedPromptSet(db, u.workspaceId, pid, 6);
    const run = await seedRun(db, u.workspaceId, pid, "geo", "running");
    const ev = (step: string, status: string, sec: number) =>
      db.insert("run_events", { id: newId("evt"), workspace_id: u.workspaceId, project_id: pid, run_id: run, step, status, message: `${step} ${status}`, created_at: t(sec) });
    await ev("geo.batch", "started", 1);
    await ev("geo_batch:gemini", "started", 2);
    await seedObs(db, u.workspaceId, pid, run, { promptId: prompts[0]!, setId, provider: "gemini", at: t(3), self: { mentioned: 1, cited: 1 }, citeHost: "shop.example.com", latency: 900, cost: 0.001 });
    await seedObs(db, u.workspaceId, pid, run, { promptId: prompts[1]!, setId, provider: "gemini", at: t(4), self: { mentioned: 1, cited: 0 }, latency: 1100 });
    await seedObs(db, u.workspaceId, pid, run, { promptId: prompts[2]!, setId, provider: "gemini", at: t(5), self: { mentioned: 0, cited: 0 }, citeHost: "forum.example", latency: 1300 });
    await seedObs(db, u.workspaceId, pid, run, { promptId: prompts[3]!, setId, provider: "gemini", at: t(6), status: "failed" });
    await ev("geo_batch:gemini", "completed", 7);
    await ev("geo_batch:perplexity", "started", 8);
    await seedObs(db, u.workspaceId, pid, run, { promptId: prompts[0]!, setId, provider: "perplexity", at: t(9), self: null, latency: 2000 });

    const p = await project(db, pid);
    const a = (await buildRunActivity(db, p, run, { now: FIXED_NOW, configuredEngines: ["gemini", "perplexity", "openai_geo"] }))!;
    expect(a.active).toBe(true);
    expect(a.run.elapsedMs).toBe(3_600_000);
    expect(a.totals.answers).toEqual({ cited: 1, named: 1, missing: 1, failed: 1 });
    const lane = (p: string) => a.lanes.find((l) => l.provider === p)!;
    expect(a.lanes.map((l) => l.provider)).toEqual(["openai_geo", "gemini", "perplexity"]);
    expect(lane("gemini")).toMatchObject({ state: "done", done: 4, planned: 4, lastLatencyMs: 1300 });
    expect(lane("perplexity")).toMatchObject({ state: "asking", done: 1, planned: 4, lastLatencyMs: 2000 });
    expect(lane("openai_geo")).toMatchObject({ state: "queued", done: 0, lastLatencyMs: null });
    // Perplexity's 3 remaining prompts first (asking), then OpenAI's 4; never more than the per-run cap.
    expect(a.queued.map((q) => `${q.provider}:${q.promptText}`)).toEqual([
      "perplexity:best brass pull 1", "perplexity:best brass pull 2", "perplexity:best brass pull 3",
      "openai_geo:best brass pull 0", "openai_geo:best brass pull 1", "openai_geo:best brass pull 2", "openai_geo:best brass pull 3",
    ]);
    const answers = a.items.filter((i) => i.kind === "engine_answer");
    expect(answers.map((i) => i.outcome)).toEqual(["cited", "named", "missing", "failed", null]);
    expect(answers[0]).toMatchObject({ latencyMs: 900, costUsd: 0.001, provider: "gemini", detail: "Cited · shop.example.com" });
    expect(answers[2]!.detail).toBe("Missing · cited instead: forum.example");
    expect(answers[0]!.title).toBe('Gemini answered: "best brass pull <b>x</b>"');
    // geo_answer calls are folded into engine answers, not listed twice.
    expect(a.items.some((i) => i.kind === "provider_call")).toBe(false);
  });

  it("reports nowReading only while the crawl is running", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const run = await seedRun(db, u.workspaceId, pid, "seo", "running");
    const crawlId = newId("crawl");
    await db.insert("crawl_runs", { id: crawlId, workspace_id: u.workspaceId, project_id: pid, run_id: run, status: "running", pages_limit: 50, started_at: t(1) });
    for (let i = 0; i < 3; i++) {
      const pageId = newId("pg");
      await db.insert("pages", { id: pageId, workspace_id: u.workspaceId, project_id: pid, url: `https://shop.example.com/p${i}`, page_type: "other", page_type_method: "url_pattern", first_seen_at: t(1) });
      await db.insert("page_snapshots", {
        id: newId("snap"), workspace_id: u.workspaceId, project_id: pid, page_id: pageId, crawl_run_id: crawlId, status_code: i === 2 ? null : 200,
        skipped_reason: i === 2 ? "robots_disallowed" : null, word_count: i === 2 ? null : 1240, fetched_at: t(10 + i),
      });
    }
    const p = await project(db, pid);
    let a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    expect(a.nowReading).toEqual({ url: "https://shop.example.com/p2", at: t(12) });
    expect(a.totals.pagesRead).toBe(2);
    expect(a.totals.pagesPlanned).toBe(50);
    const reads = a.items.filter((i) => i.kind === "page_read");
    expect(reads.map((r) => r.detail)).toEqual(["200 · 1,240 words", "200 · 1,240 words", "Skipped: robots_disallowed"]);
    expect(reads[0]!.url).toBe("https://shop.example.com/p0");
    expect(a.lanes).toEqual([]);
    await db.run("UPDATE crawl_runs SET status = 'completed' WHERE id = ?", crawlId);
    a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    expect(a.nowReading).toBeNull();
  });

  it("current lists active runs, else the latest finished run per agent", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const call = makeApp(env, u.userId);
    expect((await call(`/projects/${pid}/activity/current`)).json.data).toEqual({ runs: [] });
    await seedRun(db, u.workspaceId, pid, "seo", "completed", { created_at: t(0), finished_at: t(10) });
    const seo2 = await seedRun(db, u.workspaceId, pid, "seo", "failed", { created_at: t(20), finished_at: t(30) });
    const geo = await seedRun(db, u.workspaceId, pid, "geo", "partial", { created_at: t(5), finished_at: t(8) });
    const r = (await call(`/projects/${pid}/activity/current`)).json.data;
    expect(r.runs).toEqual([{ id: seo2, agent: "seo", status: "failed" }, { id: geo, agent: "geo", status: "partial" }]);
    const live = await seedRun(db, u.workspaceId, pid, "geo", "running");
    expect((await call(`/projects/${pid}/activity/current`)).json.data.runs).toEqual([{ id: live, agent: "geo", status: "running" }]);
  });

  it("stays under D1's bound-parameter limit with many answers", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const { setId, prompts } = await seedPromptSet(db, u.workspaceId, pid, 150);
    const run = await seedRun(db, u.workspaceId, pid, "geo", "completed");
    for (let i = 0; i < 150; i++) {
      await seedObs(db, u.workspaceId, pid, run, { promptId: prompts[i]!, setId, provider: "gemini", at: t(i), self: { mentioned: 0, cited: 0 }, citeHost: "forum.example" });
    }
    const p = await project(db, pid);
    const a = (await buildRunActivity(db, p, run, { now: FIXED_NOW, limit: 200 }))!;
    expect(a.items.filter((i) => i.kind === "engine_answer")).toHaveLength(150);
    expect(a.items.every((i) => i.kind !== "engine_answer" || i.detail === "Missing · cited instead: forum.example")).toBe(true);
    expect(a.totals.answers.missing).toBe(150);
  });

  it("replays the demo runs from seeded rows", async () => {
    const env = createTestEnv({ DEMO_MODE: "true" });
    const u = await seedUser(env);
    const db = new Db(env.DB);
    const demo = await seedDemoProject(env, db, u.userId, FIXED_NOW);
    const call = makeApp(env, u.userId);
    const cur = (await call(`/projects/${demo.id}/activity/current`)).json.data.runs as Array<{ id: string; agent: string }>;
    expect(cur.map((r) => r.agent).sort()).toEqual(["geo", "seo"]);
    const geo = (await call(`/projects/${demo.id}/runs/${cur.find((r) => r.agent === "geo")!.id}/activity?limit=200`)).json.data as RunActivity;
    expect(geo.active).toBe(false);
    expect(geo.queued).toEqual([]);
    expect(geo.lanes.map((l) => [l.provider, l.state])).toEqual([["gemini", "done"], ["perplexity", "done"]]);
    const kinds = geo.items.map((i) => i.kind);
    expect(kinds.filter((k) => k === "engine_answer").length).toBe(10);
    expect(kinds.filter((k) => k === "jev_decision").length).toBe(3);
    // Coherent order: every answer precedes the decisions, which precede the summary step.
    expect(kinds.lastIndexOf("engine_answer")).toBeLessThan(kinds.indexOf("jev_decision"));
    expect(geo.items.every((i) => i.at >= geo.run.startedAt! && i.at <= geo.run.finishedAt!)).toBe(true);
    expect(geo.totals.spend.usd).toBeNull();
    expect(geo.totals.answers.failed).toBe(1);
    const seo = (await call(`/projects/${demo.id}/runs/${cur.find((r) => r.agent === "seo")!.id}/activity?limit=200`)).json.data as RunActivity;
    const reads = seo.items.filter((i) => i.kind === "page_read");
    expect(reads.length).toBe(8);
    expect(new Set(reads.map((r) => r.at)).size).toBe(8);
    expect(seo.nowReading).toBeNull();
    expect(seo.items.every((i) => i.at >= seo.run.startedAt! && i.at <= seo.run.finishedAt!)).toBe(true);
  });
});
