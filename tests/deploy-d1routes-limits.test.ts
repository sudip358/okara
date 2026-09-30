/**
 * Deploy readiness (D1 limits and routes): B2 recommendations list/detail stay under D1's 100 bound
 * parameters; L5 the cron dispatcher selects only due (project, agent) pairs with a cap on pairs examined;
 * L6 FK indexes exist; L12 the verification check is rate-limited.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { outbound } from "@worker/platform/projects";
import { projectRoutes, VERIFICATION_CHECK_RATE_LIMIT } from "@worker/routes/projects";
import { recommendationRoutes } from "@worker/routes/recommendations";
import { acquireRunLock } from "@worker/runs/locks";
import { dispatchDueRuns } from "@worker/runs/scheduler";
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
  app.route("/", recommendationRoutes);
  app.route("/", projectRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

function recRow(workspaceId: string, projectId: string, i: number, evidenceIds: string[]) {
  const at = new Date(FIXED_NOW.getTime() - i * 60_000).toISOString();
  return {
    id: newId("rec"),
    workspace_id: workspaceId,
    project_id: projectId,
    agent: "seo",
    scope: "page",
    target_json: JSON.stringify({ kind: "url", url: `https://shop.example.com/p${i}` }),
    issue_type: "weak_ctr",
    trigger: "t",
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
    evidence_ids_json: JSON.stringify(evidenceIds),
    dedup_key: `dk-${i}`,
    status: "open",
    created_at: at,
    updated_at: at,
  };
}

describe("B2: recommendations stay under D1's 100 bound parameters", () => {
  it("lists 150 recommendations with distinct dedup keys and attaches the latest provider per key", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const stmts = Array.from({ length: 150 }, (_, i) => {
      const r = recRow(u.workspaceId, pid, i, []);
      const keys = Object.keys(r);
      return env.DB.prepare(`INSERT INTO recommendations (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map((k) => (r as Record<string, unknown>)[k]));
    });
    await env.DB.batch(stmts);
    const dec = (key: string, provider: string, at: string) =>
      db.insert("decision_records", { id: newId("dec"), workspace_id: u.workspaceId, project_id: pid, agent: "seo", candidate_key: key, provider, outcome: "selected", created_at: at });
    // Keys beyond the first 90-key chunk, with an older and a newer decision.
    await dec("dk-140", "typesafe", "2026-09-01T00:00:00.000Z");
    await dec("dk-140", "fallback-x", "2026-09-02T00:00:00.000Z");
    await dec("dk-3", "typesafe", "2026-09-02T00:00:00.000Z");

    const res = await makeApp(env, u.userId)("GET", `/projects/${pid}/recommendations`);
    expect(res.status).toBe(200);
    const list = res.json.data as Array<{ dedupKey?: string; target: unknown; decision: { provider: string | null } }>;
    expect(list).toHaveLength(150);
    const byUrl = new Map(list.map((r) => [(r.target as { url: string }).url, r.decision.provider]));
    expect(byUrl.get("https://shop.example.com/p140")).toBe("fallback-x");
    expect(byUrl.get("https://shop.example.com/p3")).toBe("typesafe");
    expect(byUrl.get("https://shop.example.com/p50")).toBeNull();
  });

  it("detail loads 100 cited evidence rows", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = newId("ev");
      ids.push(id);
      await db.insert("evidence", { id, workspace_id: u.workspaceId, project_id: pid, source: "gsc", text: `e${i}`, data_json: "{}", hash: `h${i}`, created_at: FIXED_NOW.toISOString() });
    }
    const r = recRow(u.workspaceId, pid, 0, ids);
    await db.insert("recommendations", r);
    const res = await makeApp(env, u.userId)("GET", `/recommendations/${r.id}`);
    expect(res.status).toBe(200);
    expect((res.json.data.evidence as Array<{ id: string }>).map((e) => e.id)).toEqual(ids);
  });
});

describe("L5: cron dispatcher selects only due pairs and caps pairs examined", () => {
  const wf = (env: Env, created: string[]) => ({ ...env, AGENT_RUN: { create: async (o: { id: string }) => (created.push(o.id), {}) } as unknown as Workflow });
  const at = (min: number) => new Date(FIXED_NOW.getTime() + min * 60_000);

  it("never-tried pairs go before locked retries; already dispatched pairs are not re-examined", async () => {
    const base = createTestEnv();
    const u = await seedUser(base);
    const pids = [await seedProject(base, u.workspaceId), await seedProject(base, u.workspaceId), await seedProject(base, u.workspaceId)].sort();
    const db = new Db(base.DB);
    // The first project (in id order) is held by a manual run for an hour.
    await acquireRunLock(db, pids[0]!, "seo", "run_manual_s", FIXED_NOW, 3600);
    await acquireRunLock(db, pids[0]!, "geo", "run_manual_g", FIXED_NOW, 3600);
    const created: string[] = [];
    const env = wf(base, created);

    const t1 = await dispatchDueRuns(env, at(1), { examineLimit: 2 });
    expect(t1).toMatchObject({ created: 2, started: 0, locked: 2 });
    // The locked pairs do not block the rest: fresh pairs come first on later ticks.
    const t2 = await dispatchDueRuns(env, at(2), { examineLimit: 2 });
    expect(t2).toMatchObject({ created: 2, started: 2, locked: 0 });
    const t3 = await dispatchDueRuns(env, at(3), { examineLimit: 2 });
    expect(t3).toMatchObject({ created: 2, started: 2, locked: 0 });
    const t4 = await dispatchDueRuns(env, at(4), { examineLimit: 2 });
    expect(t4).toMatchObject({ created: 0, started: 0, locked: 2 });
    // Manual lock expired: the pending runs are claimed; no second run for the day.
    const t5 = await dispatchDueRuns(env, at(61), { examineLimit: 2 });
    expect(t5).toMatchObject({ created: 0, started: 2 });
    expect(created).toHaveLength(6);

    // Everything is dispatched: a tick examines nothing and issues only its sweep + selection queries.
    let prepared = 0;
    const counting = { ...env, DB: { ...env.DB, prepare: (sql: string) => (prepared++, env.DB.prepare(sql)), batch: env.DB.batch.bind(env.DB) } as unknown as D1Database };
    const t6 = await dispatchDueRuns(counting, at(62));
    expect(t6).toEqual({ created: 0, started: 0, alreadyDispatched: 0, locked: 0, errors: 0 });
    expect(prepared).toBeLessThan(10);
    expect(await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runs")).toEqual({ n: 6 });
  });
});

describe("L6: FK columns used by cascades are indexed", () => {
  it("migration 0004 creates the indexes", async () => {
    const env = createTestEnv();
    const rows = await new Db(env.DB).all<{ tbl: string; name: string; col: string }>(
      "SELECT m.tbl_name AS tbl, m.name AS name, i.name AS col FROM sqlite_master m, pragma_index_info(m.name) i WHERE m.type = 'index' AND i.seqno = 0",
    );
    const leading = new Set(rows.map((r) => `${r.tbl}.${r.col}`));
    for (const c of [
      "link_suggestions.source_page_id",
      "link_suggestions.target_page_id",
      "link_suggestions.link_run_id",
      "link_runs.crawl_run_id",
      "crawl_runs.run_id",
      "gsc_syncs.run_id",
      "evidence.run_id",
      "recommendations.run_id",
      "geo_observations.run_id",
      "geo_observations.prompt_id",
      "recommendation_events.recommendation_id",
      "judgment_feedback.decision_record_id",
      "checklist_manual.page_id",
    ]) {
      expect(leading.has(c), c).toBe(true);
    }
  });
});

describe("L12: verification check is rate-limited per user and project", () => {
  const original = outbound.fetch;
  afterEach(() => {
    outbound.fetch = original;
  });

  it("the 11th check in a minute is refused without an outbound request", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId, { verified_host: null, verification_method: null, verified_at: null });
    let fetches = 0;
    outbound.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200, headers: { "Content-Type": "application/dns-json" } });
    }) as typeof fetch;
    const call = makeApp(env, u.userId);
    const statuses: number[] = [];
    for (let i = 0; i <= VERIFICATION_CHECK_RATE_LIMIT.limit; i++) statuses.push((await call("POST", `/projects/${pid}/verification/check`, { method: "dns" })).status);
    expect(statuses.slice(0, VERIFICATION_CHECK_RATE_LIMIT.limit).every((s) => s === 200)).toBe(true);
    expect(statuses[VERIFICATION_CHECK_RATE_LIMIT.limit]).toBe(429);
    const before = fetches;
    expect((await call("POST", `/projects/${pid}/verification/check`, { method: "dns" })).status).toBe(429);
    expect(fetches).toBe(before);
    // Another member's bucket is separate.
    const other = await seedUser(env);
    await new Db(env.DB).insert("memberships", { workspace_id: u.workspaceId, user_id: other.userId, role: "member", created_at: FIXED_NOW.toISOString() });
    expect((await makeApp(env, other.userId)("POST", `/projects/${pid}/verification/check`, { method: "dns" })).status).toBe(200);
  });
});
