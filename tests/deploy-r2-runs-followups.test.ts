/**
 * Deploy readiness, round 2 follow-ups (runs / crawl / recommendations / routes):
 * - sweepOrphans: stale spend reservations become 'unknown' (counters untouched); quota ones are released.
 * - dispatchDueRuns: agent list comes from AGENTS; locked retries rotate per tick.
 * - saveRecommendation: the 0-2/day cap is one atomic conditional INSERT; null when full, no event row.
 * - seo.crawl retries: held reservation is settled in the finished branch, found without a crawl_runs
 *   row, and settled for at least its amount on reuse.
 * - POST /projects/:pid/runs retries the claim of an orphaned pending run (created=false).
 * - verification check rate-limit key falls back to the client key, not a shared 'anon' bucket.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { AGENTS, dispatchDueRuns, scheduleKey, sweepOrphans } from "@worker/runs/scheduler";
import { createBudget } from "@worker/runs/budget";
import { DAILY_CAP, saveRecommendation, type RecommendationDraft } from "@worker/recommendations/store";
import { runCrawlWith } from "@worker/seo/crawl/run";
import { createRunRoutes } from "@worker/routes/runs";
import { projectRoutes } from "@worker/routes/projects";
import { acquireRunLock } from "@worker/runs/locks";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { fakeSite, html, type FakeRoute } from "./fixtures/crawl/fake-site";

async function setup(envOverrides: Record<string, string> = {}) {
  const env = createTestEnv(envOverrides);
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId);
  return { env, db: new Db(env.DB), workspaceId: u.workspaceId, userId: u.userId, projectId };
}

const DAY = FIXED_NOW.toISOString().slice(0, 10);
const minutesAgo = (m: number) => new Date(FIXED_NOW.getTime() - m * 60_000).toISOString();

// ------------------------------------------------------------------ (1) sweepOrphans
describe("sweepOrphans: spend vs quota reservations", () => {
  it("marks stale spend reservations 'unknown' without touching counters, releases stale quota reservations", async () => {
    const s = await setup();
    const pKey = `project:${s.projectId}`;
    await s.db.insert("agent_runs", { id: "run_done", workspace_id: s.workspaceId, project_id: s.projectId, agent: "seo", trigger: "manual", idempotency_key: "k1", status: "failed", created_at: minutesAgo(200) });
    const counter = (scope: string, day: string, resource: string, used: number) => s.db.insert("usage_counters", { scope_key: scope, day, resource, used, limit_value: 100_000 });
    await counter(pKey, DAY, "usd_micros", 5000);
    await counter("global", DAY, "usd_micros", 5000);
    await counter(pKey, DAY, "provider_calls", 4);
    await counter(pKey, DAY, "jev_calls", 2);
    await counter(pKey, DAY, "writer_tokens", 900);
    await counter(pKey, DAY, "crawl_pages", 30);
    await counter(pKey, DAY, "geo_prompts", 6);
    await counter(pKey, "2026-09-01", "crawl_pages", 12); // another day with nothing stale: untouched
    const resv = (id: string, scope: string, resource: string, amount: number, created = minutesAgo(90), status = "reserved") =>
      s.db.insert("usage_reservations", { id, workspace_id: s.workspaceId, project_id: s.projectId, run_id: "run_done", scope_key: scope, day: DAY, resource, amount, status, created_at: created, updated_at: created });
    await resv("s1", pKey, "usd_micros", 3000);
    await resv("s1_g", "global", "usd_micros", 3000);
    await resv("s2", pKey, "provider_calls", 1);
    await resv("s3", pKey, "jev_calls", 1);
    await resv("s4", pKey, "writer_tokens", 500);
    await resv("q1", pKey, "crawl_pages", 20);
    await resv("q2", pKey, "geo_prompts", 4);
    await resv("q3", pKey, "crawl_pages", 5, minutesAgo(10)); // too recent: kept

    const r = await sweepOrphans(s.env, FIXED_NOW);
    expect(r).toEqual({ manualRunsRemoved: 0, reservationsReleased: 2, reservationsMarkedUnknown: 5 });

    const st = await s.db.all<{ id: string; status: string; settled_amount: number | null }>("SELECT id, status, settled_amount FROM usage_reservations ORDER BY id");
    expect(Object.fromEntries(st.map((x) => [x.id, x.status]))).toEqual({
      q1: "released", q2: "released", q3: "reserved", s1: "unknown", s1_g: "unknown", s2: "unknown", s3: "unknown", s4: "unknown",
    });
    expect(st.find((x) => x.id === "s1")!.settled_amount).toBeNull();

    const counters = await s.db.all<{ scope_key: string; day: string; resource: string; used: number }>("SELECT scope_key, day, resource, used FROM usage_counters");
    const used = (scope: string, day: string, resource: string) => counters.find((c) => c.scope_key === scope && c.day === day && c.resource === resource)!.used;
    // Spend counters untouched (the calls may have been billed).
    expect(used(pKey, DAY, "usd_micros")).toBe(5000);
    expect(used("global", DAY, "usd_micros")).toBe(5000);
    expect(used(pKey, DAY, "provider_calls")).toBe(4);
    expect(used(pKey, DAY, "jev_calls")).toBe(2);
    expect(used(pKey, DAY, "writer_tokens")).toBe(900);
    // Quota counters returned.
    expect(used(pKey, DAY, "crawl_pages")).toBe(10);
    expect(used(pKey, DAY, "geo_prompts")).toBe(2);
    expect(used(pKey, "2026-09-01", "crawl_pages")).toBe(12);

    // Idempotent.
    expect(await sweepOrphans(s.env, FIXED_NOW)).toEqual({ manualRunsRemoved: 0, reservationsReleased: 0, reservationsMarkedUnknown: 0 });
    const again = await s.db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND day = ? AND resource = 'crawl_pages'", pKey, DAY);
    expect(again!.used).toBe(10);
  });

  it("migration 0006 creates the partial (scope_key, day, resource) index for reserved rows", async () => {
    const s = await setup();
    const idx = await s.db.first<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_resv_reserved_key'");
    expect(idx?.sql).toMatch(/scope_key, day, resource/);
    expect(idx?.sql).toMatch(/status = 'reserved'/);
  });
});

// ------------------------------------------------------------------ (2) dispatch
/** env whose D1 records the run ids passed to the dispatch claim UPDATE, and every SQL prepared. */
function recordingEnv(env: Env): { env: Env; claimed: string[]; sql: string[] } {
  const claimed: string[] = [];
  const sql: string[] = [];
  const DB = new Proxy(env.DB, {
    get(t, p) {
      if (p === "prepare")
        return (q: string) => {
          sql.push(q);
          const st = t.prepare(q);
          if (!q.startsWith("UPDATE agent_runs SET workflow_instance_id = ? WHERE id = ?")) return st;
          return new Proxy(st, {
            get(ts, pp) {
              if (pp === "bind") return (...a: unknown[]) => (claimed.push(String(a[1])), ts.bind(...a));
              const v = (ts as unknown as Record<string | symbol, unknown>)[pp];
              return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(ts) : v;
            },
          });
        };
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { env: { ...env, DB }, claimed, sql };
}

describe("dispatchDueRuns: AGENTS-derived SQL and per-tick rotation of locked retries", () => {
  async function lockedFleet() {
    const s = await setup();
    // Copy the seeded project under controlled ids (second-to-last char drives the rotation bucket).
    const cols = (await s.db.all<{ name: string }>("PRAGMA table_info(projects)")).map((c) => c.name).filter((c) => c !== "id");
    const ids = ["prj_a2x", "prj_b7x", "prj_ckx", "prj_dsx"];
    for (const id of ids) {
      await s.db.run(`INSERT INTO projects (id, ${cols.join(", ")}) SELECT ?, ${cols.join(", ")} FROM projects WHERE id = ?`, id, s.projectId);
    }
    await s.db.run("UPDATE projects SET schedule_enabled = 0 WHERE id = ?", s.projectId);
    const dayStart = new Date(`${DAY}T00:00:00.000Z`);
    const runIds: Record<string, string> = {};
    for (const id of ids) {
      for (const agent of AGENTS) {
        const runId = `run_${id}_${agent}`;
        runIds[`${id}:${agent}`] = runId;
        await s.db.insert("agent_runs", { id: runId, workspace_id: s.workspaceId, project_id: id, agent, trigger: "schedule", idempotency_key: scheduleKey(id, agent, dayStart), status: "pending", created_at: dayStart.toISOString() });
        // Another run holds the lock all day, so every pair stays locked.
        await s.db.insert("run_locks", { project_id: id, agent, run_id: `other_${id}_${agent}`, expires_at: "2099-01-01T00:00:00.000Z" });
      }
    }
    return { s, dayStart, runIds };
  }

  it("binds the agent list from AGENTS", async () => {
    const { s, dayStart } = await lockedFleet();
    const rec = recordingEnv(s.env);
    await dispatchDueRuns(rec.env, dayStart, { examineLimit: 1 });
    const due = rec.sql.find((q) => q.includes("CROSS JOIN"))!;
    expect(due.match(/SELECT \? AS agent/g)).toHaveLength(AGENTS.length);
    expect(due).not.toMatch(/'seo'|'geo'/);
  });

  it("examines a different slice of locked pairs on different ticks", async () => {
    const { s, dayStart, runIds } = await lockedFleet();
    const at = (minuteOfDay: number) => new Date(dayStart.getTime() + minuteOfDay * 60_000);
    const examined = async (minuteOfDay: number) => {
      const rec = recordingEnv(s.env);
      const r = await dispatchDueRuns(rec.env, at(minuteOfDay), { examineLimit: 2 });
      expect(r.locked).toBe(2);
      return rec.claimed;
    };
    // pivot '2' (minute 0): bucket '2' first -> prj_a2x
    expect(await examined(0)).toEqual([runIds["prj_a2x:geo"], runIds["prj_a2x:seo"]]);
    // pivot 'k' (minute 16): prj_ckx first, then prj_dsx
    expect(await examined(16)).toEqual([runIds["prj_ckx:geo"], runIds["prj_ckx:seo"]]);
    // pivot 's' (minute 24): prj_dsx first
    expect(await examined(24)).toEqual([runIds["prj_dsx:geo"], runIds["prj_dsx:seo"]]);
    // pivot 't' (minute 25): nothing at or above it, so it wraps to the lowest bucket
    expect(await examined(25)).toEqual([runIds["prj_a2x:geo"], runIds["prj_a2x:seo"]]);
    // Nothing was started or removed.
    const n = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'pending' AND workflow_instance_id IS NULL");
    expect(n!.n).toBe(8);
  });

  it("pairs never tried still come before locked retries", async () => {
    const { s, dayStart } = await lockedFleet();
    await s.db.run("UPDATE projects SET schedule_enabled = 1 WHERE id = ?", s.projectId);
    const rec = recordingEnv(s.env);
    const r = await dispatchDueRuns(rec.env, dayStart, { examineLimit: 2 });
    expect(r.created).toBe(2);
    expect(r.started).toBe(2);
  });
});

// ------------------------------------------------------------------ (5) saveRecommendation
const draft = (i: number): RecommendationDraft => ({
  agent: "seo", scope: "site", target: { kind: "site" }, issueType: `t_${i}`, trigger: "t", issue: "i", action: "a", rationale: "r",
  effort: "low", uncertainty: "low", limitations: "l", verified: false, priority: 1, priorityVersion: "v", decisionTier: null, decisionFields: null,
  evidenceIds: [], evidenceBullets: [], confirmPlaceholders: [], dedupKey: `dk:${i}`, writerProvider: null, writerModel: null,
});

describe("saveRecommendation: atomic daily cap", () => {
  it("inserts up to DAILY_CAP with a 'created' event each, then returns null and writes nothing", async () => {
    const s = await setup();
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId });
    const ids: Array<string | null> = [];
    for (let i = 0; i < DAILY_CAP + 2; i++) ids.push(await saveRecommendation(ctx, draft(i)));
    expect(ids.filter((x) => x !== null)).toHaveLength(DAILY_CAP);
    expect(ids.slice(DAILY_CAP)).toEqual([null, null]);
    const recs = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM recommendations WHERE project_id = ?", s.projectId);
    const events = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM recommendation_events WHERE project_id = ?", s.projectId);
    expect(recs!.n).toBe(DAILY_CAP);
    expect(events!.n).toBe(DAILY_CAP);
  });

  it("holds under concurrent saves (the check and the insert are one statement)", async () => {
    const s = await setup();
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => saveRecommendation(ctx, draft(i))));
    expect(results.filter((x) => x !== null)).toHaveLength(DAILY_CAP);
    const recs = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM recommendations WHERE project_id = ?", s.projectId);
    expect(recs!.n).toBe(DAILY_CAP);
  });

  it("the cap is per agent and per day", async () => {
    const s = await setup();
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId });
    for (let i = 0; i < DAILY_CAP; i++) await saveRecommendation(ctx, draft(i));
    expect(await saveRecommendation(ctx, { ...draft(9), agent: "geo" })).not.toBeNull();
    const tomorrow = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { clock: () => new Date(FIXED_NOW.getTime() + 86_400_000) });
    expect(await saveRecommendation(tomorrow, draft(10))).not.toBeNull();
  });
});

// ------------------------------------------------------------------ (4) crawl retries
const H = "shop.example.com";
const U = (p: string) => `https://${H}${p}`;
function site(pages: number) {
  const routes: Record<string, FakeRoute> = {
    [U("/robots.txt")]: { status: 200, contentType: "text/plain", body: `User-agent: *\nAllow: /\nSitemap: ${U("/sitemap.xml")}\n` },
    [U("/sitemap.xml")]: { status: 200, contentType: "application/xml", body: `<urlset>${Array.from({ length: pages }, (_, i) => `<url><loc>${U(`/p/${i}`)}</loc></url>`).join("")}</urlset>` },
  };
  const body = (i: number) => `<html><head><title>Page ${i}</title><meta name="description" content="d${i}"></head><body><main><h1>Page ${i}</h1><p>${"Brass words here. ".repeat(30)}</p></main></body></html>`;
  routes[U("/")] = html(body(9999));
  for (let i = 0; i < pages; i++) routes[U(`/p/${i}`)] = html(body(i));
  return fakeSite(routes);
}

async function crawlSetup(crawlPages = 10) {
  const s = await setup({ APP_ORIGIN: "https://app.okara.example" });
  await s.db.run("UPDATE project_limits SET crawl_pages = ? WHERE project_id = ?", crawlPages, s.projectId);
  const runId = "run_r2_crawl";
  await s.db.insert("agent_runs", { id: runId, workspace_id: s.workspaceId, project_id: s.projectId, agent: "seo", trigger: "manual", idempotency_key: `k:${runId}`, status: "running", created_at: FIXED_NOW.toISOString() });
  const budget = () => createBudget(s.db, s.env, { workspaceId: s.workspaceId, projectId: s.projectId, runId }, () => FIXED_NOW);
  const project = { id: s.projectId, workspaceId: s.workspaceId };
  const reservations = () => s.db.all<{ status: string; amount: number; settled_amount: number | null }>("SELECT status, amount, settled_amount FROM usage_reservations WHERE run_id = ? AND resource = 'crawl_pages' AND id NOT LIKE '%\\_g' ESCAPE '\\'", runId);
  const used = async () => (await s.db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND resource = 'crawl_pages'", `project:${s.projectId}`))!.used;
  return { ...s, runId, budget, project, reservations, used };
}

describe("crawl retries: held reservation handling", () => {
  it("settles the held reservation when the crawl had finished but settle never ran", async () => {
    const c = await crawlSetup(10);
    const b = c.budget();
    // Attempt 1: the result row is recorded, then settle dies (e.g. torn down between the two).
    const dying = { ...b, settle: async () => { throw new Error("Too many subrequests."); } };
    const first = await runCrawlWith(makeTestContext(c.env, c.project, { runId: c.runId, budget: dying, crawlFetch: site(4).fetch }), {});
    // The catch path also fails to settle, so the reservation stays reserved at the full amount.
    expect((await c.reservations())[0]!.status).toBe("reserved");
    expect(await c.used()).toBe(10);
    // The crawl result was recorded as finished before settle ran; make that explicit.
    await c.db.run("UPDATE crawl_runs SET status = 'completed', pages_crawled = 5, pages_skipped = 0 WHERE id = ?", first.crawlRunId);

    const again = site(4);
    const retry = await runCrawlWith(makeTestContext(c.env, c.project, { runId: c.runId, budget: c.budget(), crawlFetch: again.fetch }), {});
    expect(retry).toMatchObject({ crawlRunId: first.crawlRunId, status: "completed", pagesCrawled: 5 });
    expect(again.calls).toHaveLength(0);
    const r = await c.reservations();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: "settled", settled_amount: 5 });
    expect(await c.used()).toBe(5);
  });

  it("reuses a reservation left by an attempt that died before creating its crawl_runs row", async () => {
    const c = await crawlSetup(10);
    // Attempt 1: reserve() succeeds, then the crawl_runs INSERT fails (torn down in between).
    let failInsert = true;
    const DB = new Proxy(c.env.DB, {
      get(t, p) {
        if (p === "prepare")
          return (q: string) => {
            if (failInsert && q.startsWith("INSERT INTO crawl_runs")) throw new Error("D1_ERROR: torn down");
            return t.prepare(q);
          };
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const flaky = { ...c.env, DB };
    await expect(runCrawlWith(makeTestContext(flaky, c.project, { db: new Db(DB), runId: c.runId, budget: c.budget(), crawlFetch: site(4).fetch }), {})).rejects.toThrow(/torn down/);
    expect(await c.db.all("SELECT id FROM crawl_runs WHERE run_id = ?", c.runId)).toHaveLength(0);
    expect(await c.reservations()).toMatchObject([{ status: "reserved", amount: 10 }]);
    failInsert = false;

    const s2 = site(4);
    const retry = await runCrawlWith(makeTestContext(c.env, c.project, { runId: c.runId, budget: c.budget(), crawlFetch: s2.fetch }), {});
    expect(retry.status).toBe("completed");
    const r = await c.reservations();
    expect(r).toHaveLength(1); // not reserved twice
    expect(r[0]!.status).toBe("settled");
    // Nothing was fetched by the first attempt, so only this attempt's fetches count.
    expect(r[0]!.settled_amount).toBeLessThan(10);
    expect(await c.used()).toBe(r[0]!.settled_amount);
  });

  it("on reuse after a started attempt, settles at least the held amount", async () => {
    const c = await crawlSetup(10);
    const dying = makeTestContext(c.env, c.project, {
      runId: c.runId,
      budget: c.budget(),
      crawlFetch: site(4).fetch,
      log: { async event(_s, status) { if (status === "started") throw new Error("Too many subrequests."); } },
    });
    await expect(runCrawlWith(dying, {})).rejects.toThrow(/Too many subrequests/);
    const retry = await runCrawlWith(makeTestContext(c.env, c.project, { runId: c.runId, budget: c.budget(), crawlFetch: site(4).fetch }), {});
    expect(retry.status).toBe("completed");
    const r = await c.reservations();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ status: "settled", settled_amount: 10 });
    expect(await c.used()).toBe(10);
  });
});

// ------------------------------------------------------------------ (6) POST /projects/:pid/runs
function runsApp(env: Env, userId: string, started: string[]) {
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
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

describe("POST /projects/:pid/runs: orphaned pending run for the same key", () => {
  const manualKey = (pid: string, agent: string) => `${pid}:${agent}:manual:${Math.floor(FIXED_NOW.getTime() / 60000)}`;

  it("claims and starts a pending run whose creating request died before claiming it", async () => {
    const s = await setup();
    await s.db.insert("agent_runs", { id: "run_orphan", workspace_id: s.workspaceId, project_id: s.projectId, agent: "seo", trigger: "manual", idempotency_key: manualKey(s.projectId, "seo"), status: "pending", created_by: s.userId, created_at: FIXED_NOW.toISOString() });
    const started: string[] = [];
    const call = runsApp(s.env, s.userId, started);
    const res = await call("POST", `/projects/${s.projectId}/runs`, { agent: "seo" });
    expect(res.status).toBe(200);
    expect(res.json.data.id).toBe("run_orphan");
    expect(started).toEqual(["run_orphan"]);
    const row = await s.db.first<{ workflow_instance_id: string | null }>("SELECT workflow_instance_id FROM agent_runs WHERE id = 'run_orphan'");
    expect(row!.workflow_instance_id).not.toBeNull();
    // A second double-submit does not start it again.
    await call("POST", `/projects/${s.projectId}/runs`, { agent: "seo" });
    expect(started).toEqual(["run_orphan"]);
  });

  it("returns 409 and removes the orphan when another run holds the lock", async () => {
    const s = await setup();
    await s.db.insert("agent_runs", { id: "run_orphan", workspace_id: s.workspaceId, project_id: s.projectId, agent: "geo", trigger: "manual", idempotency_key: manualKey(s.projectId, "geo"), status: "pending", created_by: s.userId, created_at: FIXED_NOW.toISOString() });
    expect(await acquireRunLock(s.db, s.projectId, "geo", "run_other", FIXED_NOW)).toBe(true);
    const started: string[] = [];
    const res = await runsApp(s.env, s.userId, started)("POST", `/projects/${s.projectId}/runs`, { agent: "geo" });
    expect(res.status).toBe(409);
    expect(started).toEqual([]);
    expect(await s.db.first("SELECT id FROM agent_runs WHERE id = 'run_orphan'")).toBeNull();
  });
});

// ------------------------------------------------------------------ (7) verification-check rate-limit key
describe("verification check rate limit key", () => {
  it("rejects unauthenticated requests before the limiter, so they write no rate_limits rows", async () => {
    const s = await setup();
    const app = new Hono<AppEnv>().basePath("/api");
    app.use("*", async (c, next) => {
      c.set("db", new Db(c.env.DB));
      c.set("now", FIXED_NOW);
      c.set("user", null);
      c.set("session", null);
      await next();
    });
    app.route("/", projectRoutes);
    app.onError((err, c) => (err instanceof HttpError ? c.json({ error: { code: err.code } }, err.status as 400) : c.json({ error: String(err) }, 500)));
    const res = await app.request(
      `/api/projects/${s.projectId}/verification/check`,
      { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" }, body: JSON.stringify({ method: "dns" }) },
      s.env,
    );
    expect(res.status).toBe(401);
    const keys = (await s.db.all<{ key: string }>("SELECT key FROM rate_limits")).map((r) => r.key);
    expect(keys).toEqual([]);
  });
});
