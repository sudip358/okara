/**
 * Backlink monitor routes and jobs: tenancy (404 for non-members, 401 without a session), starting a check (202,
 * first batch inline in tests), batches bounded to <= 20 external fetches and <= 8 backlinks per invocation, the
 * lease, change events across two checks and the Overview attention item, manual-run (3/day) and recheck (30 rows/hour)
 * limits, demo refusal, list filters / sort / CSV export (formula-safe), detail and events, the cron (weekly schedule +
 * one batch), and D1 limits with 2,000 backlinks (no statement over 100 bound parameters).
 */
import { afterEach, describe, expect, it } from "vitest";
import { FETCHES_PER_INVOCATION, ITEMS_PER_INVOCATION, MANUAL_CHECKS_PER_DAY, RECHECK_ROWS_PER_HOUR, type BacklinkDetail, type BacklinkEventsResponse, type BacklinkFeed, type BacklinkListResponse, type BacklinkSummary, type StartBacklinkCheckResult } from "@shared/backlinks";
import { linkUrlKey } from "@shared/import";
import type { AttentionFeed } from "@shared/types";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { loadProjectRow } from "@worker/platform/projects";
import { insertBacklinkStmt } from "@worker/backlinks/store";
import { createJob, processBatch, processDueBacklinkChecks, setBacklinkFetch } from "@worker/backlinks/jobs";
import { backlinkSummary, backlinksCsv, listBacklinks } from "@worker/backlinks/service";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { OUR_HOST, T, article, fakeFetch, type Route } from "./backlinks-fixtures";

const app = createApp();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const noSleep = async () => undefined;

async function call(env: Env, u: { sessionToken: string; csrfToken: string }, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, { method, headers: authHeaders(u.sessionToken, u.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  let json: { data?: Json; error?: { code: string; message: string } } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function setup(projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId, projectOverrides);
  const db = new Db(env.DB);
  return { env, u, pid, db, base: `/projects/${pid}/backlinks` };
}

const liveUrl = (i: number) => `https://site${i}.example.net/post-${i}`;

async function seedBacklinks(db: Db, ws: string, pid: string, n: number, opts: { vendor?: (i: number) => string; anchor?: string } = {}) {
  const p = (await loadProjectRow(db, ws, pid))!;
  const stmts: Array<[string, ...unknown[]]> = [];
  const now = new Date("2026-10-04T10:00:00Z");
  for (let i = 0; i < n; i++) {
    const live = liveUrl(i);
    const target = T(`/collections/c${i % 40}`);
    stmts.push(
      insertBacklinkStmt(p, newId("bl"), `${linkUrlKey(live)}>${linkUrlKey(target)}`, {
        liveUrl: live,
        liveUrlKey: linkUrlKey(live),
        liveHost: `site${i}.example.net`,
        targetUrl: target,
        targetUrlKey: linkUrlKey(target),
        anchorExpected: opts.anchor ?? "brass pulls",
        vendor: opts.vendor ? opts.vendor(i) : i % 2 ? "VendorA" : "=HYPERLINK(\"x\")",
        linkType: i % 3 ? "Guest Post" : "Niche Edit",
        placedDate: "2026-09-01",
        da: 30 + (i % 10),
        traffic: 100 * i,
        priceText: "$100",
        sourceRow: i + 2,
      }, "imp_seed", "csv:seed", now),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

/** Every article links to its target with the given rel (or not at all); our targets answer 200. */
function siteRoutes(n: number, rel: (i: number) => string | null, overrides: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {};
  for (let i = 0; i < n; i++) {
    const r = rel(i);
    routes[liveUrl(i)] = { status: 200, body: article(r === null ? "<p>No link here.</p>" : `<a ${r ? `rel="${r}" ` : ""}href="${T(`/collections/c${i % 40}`)}">brass pulls</a>`) };
    routes[T(`/collections/c${i % 40}`)] = { status: 200, body: "<html></html>" };
  }
  return { ...routes, ...overrides };
}

afterEach(() => setBacklinkFetch(null));

describe("tenancy", () => {
  it("404 for non-members and 401/403 without a session on every endpoint", async () => {
    const s = await setup();
    await seedBacklinks(s.db, s.u.workspaceId, s.pid, 1);
    const id = (await s.db.first<{ id: string }>("SELECT id FROM backlinks WHERE project_id = ?", s.pid))!.id;
    const intruder = await seedUser(s.env);
    const endpoints: Array<[string, string, unknown?]> = [
      ["GET", ""],
      ["GET", "?format=csv"],
      ["GET", "/summary"],
      ["GET", "/events"],
      ["GET", "/feed"],
      ["GET", `/${id}`],
      ["POST", "/check", {}],
      ["POST", "/check/advance", {}],
    ];
    for (const [method, path, body] of endpoints) {
      const r = await call(s.env, intruder, method, `${s.base}${path}`, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      const anon = await app.request(`/api${s.base}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }, s.env);
      if (method === "GET") expect(anon.status).toBe(401);
      else expect([401, 403]).toContain(anon.status);
    }
    // A backlink id of another project is not found through this project.
    const other = await seedProject(s.env, intruder.workspaceId);
    expect((await call(s.env, intruder, "GET", `/projects/${other}/backlinks/${id}`)).status).toBe(404);
  });
});

describe("check jobs", () => {
  it("starts a check (202), processes bounded batches, records statuses, then detects changes on the next check", async () => {
    const s = await setup();
    await seedBacklinks(s.db, s.u.workspaceId, s.pid, 10);
    let ff = fakeFetch(siteRoutes(10, () => ""));
    setBacklinkFetch(ff.fetch, noSleep);

    const start = await call(s.env, s.u, "POST", `${s.base}/check`, {});
    expect(start.status).toBe(202);
    const res = start.json!.data as StartBacklinkCheckResult;
    expect(res.existing).toBe(false);
    expect(res.job).toMatchObject({ trigger: "manual", scope: "all", total: 10 });
    // First batch ran inline (tests have no execution context): at most 8 backlinks and 20 requests.
    const afterFirst = (await call(s.env, s.u, "GET", `${s.base}/feed`)).json!.data as BacklinkFeed;
    expect(afterFirst.job!.done).toBeLessThanOrEqual(ITEMS_PER_INVOCATION);
    expect(ff.calls.length).toBeLessThanOrEqual(FETCHES_PER_INVOCATION);
    expect(afterFirst.items.length).toBe(afterFirst.job!.done);

    // Advance until done; every invocation stays within the budget.
    for (let i = 0; i < 10; i++) {
      const before = ff.calls.length;
      const adv = await call(s.env, s.u, "POST", `${s.base}/check/advance`, { after: null });
      expect(adv.status).toBe(200);
      expect(ff.calls.length - before).toBeLessThanOrEqual(FETCHES_PER_INVOCATION);
      if (adv.json!.data.job.status === "completed") break;
    }
    const sum1 = (await call(s.env, s.u, "GET", `${s.base}/summary`)).json!.data as BacklinkSummary;
    expect(sum1.job).toBeNull();
    expect(sum1.lastJob).toMatchObject({ status: "completed", done: 10, total: 10 });
    expect(sum1.byStatus.dofollow).toBe(10);
    expect(sum1.dofollow).toEqual({ n: 10, m: 10 });
    expect(sum1.changes.last7).toBe(0); // first check is the baseline
    // Owner setting: robots.txt is not consulted for backlink checks (never requested); each target once per job.
    expect(ff.calls.filter((c) => c.endsWith("/robots.txt") && !c.includes(OUR_HOST))).toHaveLength(0);
    expect(ff.calls.filter((c) => c === T("/collections/c0"))).toHaveLength(1);

    // Second check: two links become nofollow, one page 404, one link removed, one target 404.
    ff = fakeFetch(
      siteRoutes(10, (i) => (i === 3 ? null : i < 2 ? "nofollow" : ""), {
        [liveUrl(5)]: { status: 404, body: "" },
        [T("/collections/c6")]: { status: 404, body: "" },
      }),
    );
    setBacklinkFetch(ff.fetch, noSleep);
    const again = await call(s.env, s.u, "POST", `${s.base}/check`, {});
    expect(again.status).toBe(202);
    for (let i = 0; i < 10; i++) {
      const adv = await call(s.env, s.u, "POST", `${s.base}/check/advance`, {});
      if (adv.json!.data.job.status === "completed") break;
    }
    const events = (await call(s.env, s.u, "GET", `${s.base}/events`)).json!.data as BacklinkEventsResponse;
    const messages = events.events.map((e) => e.message);
    expect(messages.filter((m) => m === "dofollow → nofollow")).toHaveLength(2);
    expect(messages).toContain("Page now 404");
    expect(messages.some((m) => m.startsWith("Link removed"))).toBe(true);
    expect(messages).toContain("Target now 404");
    expect(events.events.every((e) => e.liveUrl && e.targetUrl)).toBe(true);

    const list = (await call(s.env, s.u, "GET", `${s.base}?status=nofollow`)).json!.data as BacklinkListResponse;
    expect(list.total).toBe(2);
    expect(list.rows[0]!.lastChangeText).toBe("dofollow → nofollow");
    expect(list.rows[0]!.lastChangeNegative).toBe(true);
    const changed = (await call(s.env, s.u, "GET", `${s.base}?changed=7`)).json!.data as BacklinkListResponse;
    expect(changed.total).toBe(5);
    const broken = (await call(s.env, s.u, "GET", `${s.base}?status=target_broken`)).json!.data as BacklinkListResponse;
    expect(broken.total).toBe(1);

    const detail = (await call(s.env, s.u, "GET", `${s.base}/${list.rows[0]!.id}`)).json!.data as BacklinkDetail;
    expect(detail.checks).toHaveLength(2);
    expect(detail.events[0]!.kind).toBe("rel_changed");

    const attention = (await call(s.env, s.u, "GET", `/projects/${s.pid}/attention`)).json!.data as AttentionFeed;
    expect(attention.backlinkChanges?.negative).toBe(5);
    expect(attention.backlinkChanges?.examples.length).toBeGreaterThan(0);
  });

  it("a held lease makes a second invocation a no-op (busy)", async () => {
    const s = await setup();
    await seedBacklinks(s.db, s.u.workspaceId, s.pid, 2);
    const p = (await loadProjectRow(s.db, s.u.workspaceId, s.pid))!;
    const { job } = await createJob(s.db, p, { userId: s.u.userId, trigger: "manual", now: new Date() });
    await s.db.run("UPDATE backlink_jobs SET lease_until = ? WHERE id = ?", new Date(Date.now() + 60_000).toISOString(), job.id);
    const out = await processBatch(s.env, s.db, job.id, s.u.workspaceId);
    expect(out.status).toBe("busy");
  });

  it("a page needing more requests than a full batch allows is recorded (fetch_budget), so the job never stalls", async () => {
    const s = await setup();
    await seedBacklinks(s.db, s.u.workspaceId, s.pid, 1);
    setBacklinkFetch(fakeFetch(siteRoutes(1, () => "")).fetch, noSleep);
    const p = (await loadProjectRow(s.db, s.u.workspaceId, s.pid))!;
    const { job } = await createJob(s.db, p, { userId: null, trigger: "manual", now: new Date() });
    const out = await processBatch(s.env, s.db, job.id, s.u.workspaceId, { fetchLimit: 2 });
    expect(out.fetches).toBe(2);
    expect(out.job?.status).toBe("completed");
    const row = await s.db.first<Json>("SELECT status FROM backlinks WHERE project_id = ?", s.pid);
    expect(row.status).toBe("fetch_failed");
    const chk = await s.db.first<Json>("SELECT error_code FROM backlink_checks WHERE project_id = ?", s.pid);
    expect(chk.error_code).toBe("fetch_budget");
  });

  it("returns the running job instead of a second full check; demo projects are refused", async () => {
    const s = await setup();
    await seedBacklinks(s.db, s.u.workspaceId, s.pid, 2);
    const p = (await loadProjectRow(s.db, s.u.workspaceId, s.pid))!;
    await createJob(s.db, p, { userId: s.u.userId, trigger: "scheduled", now: new Date() });
    await s.db.run("UPDATE backlink_jobs SET lease_until = ? WHERE project_id = ?", new Date(Date.now() + 60_000).toISOString(), s.pid);
    const r = await call(s.env, s.u, "POST", `${s.base}/check`, {});
    expect(r.status).toBe(202);
    expect(r.json!.data.existing).toBe(true);
    expect(r.json!.data.job.trigger).toBe("scheduled");

    const demo = await setup({ is_demo: 1 });
    await seedBacklinks(demo.db, demo.u.workspaceId, demo.pid, 1);
    const d = await call(demo.env, demo.u, "POST", `${demo.base}/check`, {});
    expect(d.status).toBe(409);
    expect(d.json!.error!.code).toBe("demo_project");
  });

  it(`limits manual full checks to ${MANUAL_CHECKS_PER_DAY} per UTC day`, async () => {
    const s = await setup();
    await seedBacklinks(s.db, s.u.workspaceId, s.pid, 2);
    setBacklinkFetch(fakeFetch(siteRoutes(2, () => "")).fetch, noSleep);
    for (let i = 0; i < MANUAL_CHECKS_PER_DAY; i++) {
      const r = await call(s.env, s.u, "POST", `${s.base}/check`, {});
      expect(r.status).toBe(202);
      expect(r.json!.data.existing).toBe(false);
      const feed = (await call(s.env, s.u, "GET", `${s.base}/feed`)).json!.data as BacklinkFeed;
      expect(feed.job!.status).toBe("completed");
    }
    const over = await call(s.env, s.u, "POST", `${s.base}/check`, {});
    expect(over.status).toBe(429);
    expect(over.json!.error!.message).toMatch(/3 per project per UTC day/);
  });

  it(`limits rechecks to ${RECHECK_ROWS_PER_HOUR} rows per project per hour and 30 ids per request`, async () => {
    const s = await setup();
    await seedBacklinks(s.db, s.u.workspaceId, s.pid, 35);
    setBacklinkFetch(fakeFetch(siteRoutes(35, () => "")).fetch, noSleep);
    const ids = (await s.db.all<{ id: string }>("SELECT id FROM backlinks WHERE project_id = ? ORDER BY id", s.pid)).map((r) => r.id);
    expect((await call(s.env, s.u, "POST", `${s.base}/check`, { ids: ids.slice(0, 31) })).status).toBe(400);
    const first = await call(s.env, s.u, "POST", `${s.base}/check`, { ids: ids.slice(0, 20) });
    expect(first.status).toBe(202);
    expect(first.json!.data.job).toMatchObject({ trigger: "recheck", scope: "ids", total: 20 });
    // Finish it, then ask for 11 more: only 10 are left this hour.
    for (let i = 0; i < 5; i++) await call(s.env, s.u, "POST", `${s.base}/check/advance`, {});
    const over = await call(s.env, s.u, "POST", `${s.base}/check`, { ids: ids.slice(20, 31) });
    expect(over.status).toBe(429);
    expect(over.json!.error!.message).toMatch(/10 left this hour/);
    // Unknown ids (another project's or made up) are not found.
    expect((await call(s.env, s.u, "POST", `${s.base}/check`, { ids: ["bl_nope"] })).status).toBe(404);
  });
});

describe("reads", () => {
  it("list filters, sort, paging and a formula-safe CSV export", async () => {
    const s = await setup();
    await seedBacklinks(s.db, s.u.workspaceId, s.pid, 12);
    const all = (await call(s.env, s.u, "GET", `${s.base}?limit=5&sort=da&dir=desc`)).json!.data as BacklinkListResponse;
    expect(all.total).toBe(12);
    expect(all.rows).toHaveLength(5);
    expect(all.rows[0]!.da).toBe(39);
    expect(all.vendors).toContain("VendorA");
    const vendor = (await call(s.env, s.u, "GET", `${s.base}?vendor=VendorA`)).json!.data as BacklinkListResponse;
    expect(vendor.total).toBe(6);
    const unchecked = (await call(s.env, s.u, "GET", `${s.base}?status=unchecked`)).json!.data as BacklinkListResponse;
    expect(unchecked.total).toBe(12);
    expect((await call(s.env, s.u, "GET", `${s.base}?status=bogus`)).status).toBe(400);
    const csv = await call(s.env, s.u, "GET", `${s.base}?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    const lines = csv.text.trim().split("\r\n");
    expect(lines[0]).toMatch(/^Live URL,Target,Expected anchor/);
    expect(lines).toHaveLength(13);
    expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.text).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it("summary for an empty project; events since a date; bad parameters refused", async () => {
    const s = await setup();
    const sum = (await call(s.env, s.u, "GET", `${s.base}/summary`)).json!.data as BacklinkSummary;
    expect(sum.state).toBe("empty");
    expect(sum.totals.active).toBe(0);
    expect(sum.nextCheckAt).toBeNull();
    expect((await call(s.env, s.u, "GET", `${s.base}/events?since=yesterday-ish`)).status).toBe(400);
    expect((await call(s.env, s.u, "POST", `${s.base}/check`, {})).status).toBe(409);
  });
});

describe("cron", () => {
  it("schedules a weekly check for projects with backlinks (schedule on, not demo) and processes one batch", async () => {
    const s = await setup();
    await seedBacklinks(s.db, s.u.workspaceId, s.pid, 3);
    const off = await setup({ schedule_enabled: 0 });
    await seedBacklinks(off.db, off.u.workspaceId, off.pid, 1);
    setBacklinkFetch(fakeFetch(siteRoutes(3, () => "ugc")).fetch, noSleep);
    const now = new Date();
    const r = await processDueBacklinkChecks(s.env, now);
    expect(r).toEqual({ scheduled: 1, processed: 3, browser: "idle" });
    const jobs = await s.db.all<Json>("SELECT trigger, status, done FROM backlink_jobs WHERE project_id = ?", s.pid);
    expect(jobs).toEqual([{ trigger: "scheduled", status: "completed", done: 3 }]);
    expect((await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM backlinks WHERE project_id = ? AND status = 'ugc'", s.pid))?.n).toBe(3);
    // Within 7 days: nothing new is scheduled.
    const again = await processDueBacklinkChecks(s.env, new Date(now.getTime() + 3600_000));
    expect(again.scheduled).toBe(0);
    const sum = (await call(s.env, s.u, "GET", `${s.base}/summary`)).json!.data as BacklinkSummary;
    expect(sum.nextCheckAt).not.toBeNull();
    expect(Date.parse(sum.nextCheckAt!) - Date.parse(jobs.length ? sum.lastJob!.createdAt : "")).toBe(7 * 86_400_000);
  });
});

describe("D1 limits with 2,000 backlinks", () => {
  it("list, summary, CSV export and a batch stay within D1's per-statement limits", async () => {
    const s = await setup();
    await seedBacklinks(s.db, s.u.workspaceId, s.pid, 2000);
    const p = (await loadProjectRow(s.db, s.u.workspaceId, s.pid))!;
    const now = new Date();
    const list = await listBacklinks(s.db, p, { limit: 100, offset: 1100, q: "site1" }, now);
    expect(list.total).toBe(1111);
    expect(list.rows).toHaveLength(11);
    const sum = await backlinkSummary(s.db, p, now);
    expect(sum.totals.active).toBe(2000);
    const csv = await backlinksCsv(s.db, p, {}, now);
    expect(csv.trim().split("\r\n")).toHaveLength(2001);
    setBacklinkFetch(fakeFetch(siteRoutes(2000, () => "")).fetch, noSleep);
    const { job } = await createJob(s.db, p, { userId: null, trigger: "manual", now });
    const out = await processBatch(s.env, s.db, job.id, s.u.workspaceId);
    expect(out.checked).toBeGreaterThan(0);
    expect(out.fetches).toBeLessThanOrEqual(FETCHES_PER_INVOCATION);
    const feed = (await call(s.env, s.u, "GET", `${s.base}/feed`)).json!.data as BacklinkFeed;
    expect(feed.job!.status).toBe("running");
    expect(feed.job!.total).toBe(2000);
  });
});

export { OUR_HOST };
