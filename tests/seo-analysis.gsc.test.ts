import { describe, expect, it } from "vitest";
import type { Budget } from "@worker/runs/context";
import type { GscQueryRequest } from "@worker/providers/types";
import { Db } from "@worker/lib/db";
import { GscApiError } from "@worker/platform/gsc-client";
import { daysInWindow, finalizedWindows, followingWindow, precedingWindow } from "@worker/seo/gsc/windows";
import { aggregateRows, excludeIncompleteDays, missingTrailingDays, parseTotalsJson, ratio, toWindowTotals, totalsFromAggregateRow } from "@worker/seo/gsc/aggregate";
import { GSC_LIMITATIONS, GSC_MAX_ROW_LIMIT, syncGsc } from "@worker/seo/gsc/sync";
import { createTestEnv } from "./helpers/env";
import { makeTestContext } from "./helpers/context";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { CURRENT, DEFAULT_GSC_DATA, PREVIOUS, QP_CURRENT, TOTALS, fakeGsc, type FakeGscData } from "./fixtures/gsc/site";

function recordingBudget(): Budget & { log: Array<{ op: string; resource?: string; amount?: number }> } {
  const log: Array<{ op: string; resource?: string; amount?: number }> = [];
  let n = 0;
  return {
    log,
    async reserve(resource, amount) {
      log.push({ op: "reserve", resource, amount });
      return String(n++);
    },
    async settle(_id, amount) {
      log.push({ op: "settle", amount });
    },
    async release() {
      log.push({ op: "release" });
    },
    async markUnknown() {
      log.push({ op: "unknown" });
    },
  };
}

async function setup(projectOverrides: Record<string, unknown> = {}, rowCap?: number) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId, projectOverrides);
  const db = new Db(env.DB);
  if (rowCap !== undefined) await db.run("UPDATE project_limits SET gsc_rows = ? WHERE project_id = ?", rowCap, pid);
  return { env, db, project: { id: pid, workspaceId: u.workspaceId }, workspaceId: u.workspaceId, pid };
}

const syncRow = (db: Db, id: string) =>
  db.first<{ source: string; status: string; truncated: number; rows_fetched: number; row_cap: number; totals_json: string; error: string | null; data_state: string; window_start: string; window_end: string; prev_window_start: string; prev_window_end: string }>(
    "SELECT * FROM gsc_syncs WHERE id = ?",
    id,
  );

describe("GSC windows", () => {
  it("current window is the 28 finalized days ending today UTC - 3; previous is the 28 days before", () => {
    const w = finalizedWindows(FIXED_NOW); // 2026-09-30T12:00Z
    expect(w.current).toEqual({ start: "2026-08-31", end: "2026-09-27" });
    expect(w.previous).toEqual({ start: "2026-08-03", end: "2026-08-30" });
    expect(daysInWindow(w.current)).toBe(28);
    expect(daysInWindow(w.previous)).toBe(28);
    expect(w.lagDays).toBe(3);
  });

  it("uses the UTC day regardless of time of day and crosses month boundaries", () => {
    expect(finalizedWindows(new Date("2026-03-02T00:30:00Z")).current).toEqual({ start: "2026-01-31", end: "2026-02-27" });
    expect(finalizedWindows(new Date("2026-03-02T23:59:59Z")).previous).toEqual({ start: "2026-01-03", end: "2026-01-30" });
    expect(finalizedWindows(new Date("2026-01-02T12:00:00Z")).current.end).toBe("2025-12-30");
  });

  it("preceding/following windows are adjacent and the same length", () => {
    const w = { start: "2026-08-31", end: "2026-09-27" };
    expect(precedingWindow(w)).toEqual({ start: "2026-08-03", end: "2026-08-30" });
    expect(followingWindow(precedingWindow(w))).toEqual(w);
  });
});

describe("GSC aggregation", () => {
  it("CTR is sum(clicks)/sum(impressions), not the mean of row CTRs", () => {
    const rows = [
      { clicks: 10, impressions: 100 }, // 10%
      { clicks: 0, impressions: 900 }, // 0%
    ];
    const a = aggregateRows(rows);
    expect(a.ctr).toEqual({ numerator: 10, denominator: 1000, value: 0.01 });
    expect(a.ctr.value).not.toBe((0.1 + 0) / 2);
  });

  it("zero impressions give a null ratio (unavailable, not 0%)", () => {
    expect(ratio(0, 0).value).toBeNull();
    expect(aggregateRows([]).ctr.value).toBeNull();
    const t = totalsFromAggregateRow({ clicks: 0, impressions: 0, position: 0 });
    expect(t).toMatchObject({ clicks: 0, impressions: 0, ctr: null, position: null });
    expect(toWindowTotals(t)!.ctr.value).toBeNull();
    expect(totalsFromAggregateRow(undefined)).toBeNull();
  });

  it("position comes only from the API aggregate row", () => {
    expect(totalsFromAggregateRow({ clicks: 3, impressions: 100, position: 7.25 })).toMatchObject({ position: 7.25, derivedFrom: "api_aggregate" });
    expect(parseTotalsJson("not json")).toMatchObject({ current: null, previous: null });
  });

  it("excludes incomplete days (outside the finalized window) and counts missing trailing days", () => {
    const w = { start: "2026-09-01", end: "2026-09-05" };
    const daily = [
      { date: "2026-08-31", clicks: 1, impressions: 1 },
      { date: "2026-09-02", clicks: 2, impressions: 2 },
      { date: "2026-09-01", clicks: 1, impressions: 1 },
      { date: "2026-09-03", clicks: 3, impressions: 3 },
      { date: "2026-09-06", clicks: 9, impressions: 9 },
    ];
    expect(excludeIncompleteDays(daily, w).map((d) => d.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(missingTrailingDays(daily, w)).toBe(2);
  });
});

describe("syncGsc", () => {
  it("returns setup_required without any request when GSC is not connected or no property is selected", async () => {
    const a = await setup();
    const none = await syncGsc(makeTestContext(a.env, a.project, { gsc: null }));
    expect(none.status).toBe("setup_required");

    const b = await setup({ gsc_property: null });
    const gsc = fakeGsc();
    const res = await syncGsc(makeTestContext(b.env, b.project, { gsc }));
    expect(res.status).toBe("setup_required");
    expect(gsc.requests).toHaveLength(0);
    expect(await b.db.first("SELECT id FROM gsc_syncs WHERE project_id = ?", b.pid)).toBeNull();
  });

  it("imports finalized windows: separate property totals, current-only daily series, and slices", async () => {
    const s = await setup();
    const gsc = fakeGsc();
    const budget = recordingBudget();
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc, budget }));
    expect(res.status).toBe("completed");

    for (const r of gsc.requests) {
      expect(r.dataState).toBe("final");
      expect(r.type).toBe("web");
      expect(r.property).toBe("sc-domain:example.com");
      expect(r.rowLimit).toBeLessThanOrEqual(GSC_MAX_ROW_LIMIT);
    }
    // Totals: one no-dimension request per window.
    const totalsReqs = gsc.requests.filter((r) => r.dimensions.length === 0);
    expect(totalsReqs.map((r) => [r.startDate, r.endDate])).toEqual([
      [CURRENT.start, CURRENT.end],
      [PREVIOUS.start, PREVIOUS.end],
    ]);
    // Daily: current window only. (The [A25] year-over-year probe is a separate ['date'] request on
    // last year's window, before any last-year page rows are fetched.)
    const dailyReqs = gsc.requests.filter((r) => r.dimensions.join(",") === "date" && r.startDate >= PREVIOUS.start);
    expect(dailyReqs).toHaveLength(1);
    expect(dailyReqs[0]!.startDate).toBe(CURRENT.start);
    // Slices: query+page for both windows.
    expect(gsc.requests.filter((r) => r.dimensions.join(",") === "query,page").map((r) => r.startDate)).toEqual(expect.arrayContaining([CURRENT.start, PREVIOUS.start]));

    const row = (await syncRow(s.db, res.syncId!))!;
    expect(row).toMatchObject({ source: "api", status: "completed", data_state: "final", truncated: 0, row_cap: 5000 });
    expect([row.window_start, row.window_end, row.prev_window_start, row.prev_window_end]).toEqual([CURRENT.start, CURRENT.end, PREVIOUS.start, PREVIOUS.end]);

    // Totals come from the aggregate request, never from summing slices.
    const totals = JSON.parse(row.totals_json);
    expect(totals.current).toMatchObject({ clicks: 300, impressions: 50000, position: 12.3 });
    expect(totals.current.ctr).toBeCloseTo(300 / 50000, 10);
    expect(totals.previous).toMatchObject({ clicks: 400, impressions: 48000, position: 11.9 });
    const sliceSum = QP_CURRENT.reduce((n, r) => n + r.impressions, 0);
    expect(sliceSum).not.toBe(TOTALS.current.impressions);

    // Daily: 26 finalized points; 2 trailing days missing are excluded and noted.
    const daily = await s.db.all<{ date: string }>("SELECT date FROM gsc_daily WHERE sync_id = ? ORDER BY date", res.syncId);
    expect(daily).toHaveLength(26);
    expect(daily.every((d) => d.date >= CURRENT.start && d.date <= CURRENT.end)).toBe(true);
    expect(totals.notes.join(" ")).toMatch(/2 trailing day\(s\)/);

    // Slice rows are labelled by window; page rows have no query.
    const metrics = await s.db.all<{ window: string; query: string | null; page: string | null }>("SELECT window, query, page FROM gsc_metrics WHERE sync_id = ?", res.syncId);
    expect(metrics.filter((m) => m.window === "current" && m.query !== null)).toHaveLength(QP_CURRENT.length);
    expect(metrics.filter((m) => m.window === "current" && m.query === null).length).toBeGreaterThan(0);
    expect(res.rows).toBe(metrics.length);

    // Budget reserved at the row cap and settled to the actual slice rows.
    expect(budget.log[0]).toEqual({ op: "reserve", resource: "gsc_rows", amount: 5000 });
    expect(budget.log.at(-1)).toEqual({ op: "settle", amount: metrics.length });
    // Limitations note anonymized queries.
    expect(GSC_LIMITATIONS.join(" ")).toMatch(/anonymized queries/);
  });

  it("paginates with startRow and rowLimit until Google returns a short page", async () => {
    const s = await setup();
    const gsc = fakeGsc();
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc }), { pageSize: 2 });
    const qp = gsc.requests.filter((r) => r.dimensions.join(",") === "query,page" && r.startDate === CURRENT.start);
    expect(qp.map((r) => [r.startRow, r.rowLimit])).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
      [6, 2],
    ]);
    expect(res.truncated).toBe(false);
    expect(res.status).toBe("completed");
  });

  it("stops at the project row cap and marks the sync truncated", async () => {
    const s = await setup({}, 8); // 4 rows per window: 1 page row + 3 query/page rows
    const gsc = fakeGsc();
    const budget = recordingBudget();
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc, budget }), { pageSize: 2 });
    const cur = (dims: string) => gsc.requests.filter((r) => r.dimensions.join(",") === dims && r.startDate === CURRENT.start).map((r) => [r.startRow, r.rowLimit]);
    expect(cur("page")).toEqual([[0, 1]]);
    expect(cur("query,page")).toEqual([
      [0, 2],
      [2, 1],
    ]);
    expect(res.truncated).toBe(true);
    const row = (await syncRow(s.db, res.syncId!))!;
    expect(row.truncated).toBe(1);
    expect(row.row_cap).toBe(8);
    expect(row.rows_fetched).toBeLessThanOrEqual(8);
    expect(JSON.parse(row.totals_json).notes.join(" ")).toMatch(/Row cap of 8 reached/);
    expect(budget.log.at(-1)).toEqual({ op: "settle", amount: row.rows_fetched });
  });

  it("no rows -> no_data", async () => {
    const s = await setup();
    const empty: FakeGscData = { totals: { current: null, previous: null }, daily: [], page: { current: [], previous: [] }, qp: { current: [], previous: [] } };
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc: fakeGsc(empty) }));
    expect(res.status).toBe("no_data");
    expect(res.rows).toBe(0);
    expect((await syncRow(s.db, res.syncId!))!.status).toBe("no_data");
  });

  it("a property with no previous-window data still completes, with a note", async () => {
    const s = await setup();
    const data: FakeGscData = { ...DEFAULT_GSC_DATA, totals: { current: DEFAULT_GSC_DATA.totals.current, previous: null }, page: { ...DEFAULT_GSC_DATA.page, previous: [] }, qp: { ...DEFAULT_GSC_DATA.qp, previous: [] } };
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc: fakeGsc(data) }));
    expect(res.status).toBe("completed");
    expect(JSON.parse((await syncRow(s.db, res.syncId!))!.totals_json).notes.join(" ")).toMatch(/Previous window returned no data/);
  });

  it("429 on the first request -> failed, and no further requests", async () => {
    const s = await setup();
    const gsc = fakeGsc(DEFAULT_GSC_DATA, () => new GscApiError(429, "quota_exceeded", "Search Console API error 429: Quota exceeded"));
    const budget = recordingBudget();
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc, budget }));
    expect(res.status).toBe("failed");
    expect(gsc.requests).toHaveLength(1);
    const row = (await syncRow(s.db, res.syncId!))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/quota or rate limit/);
    expect(budget.log.at(-1)).toEqual({ op: "settle", amount: 0 });
  });

  it("429 after the current window -> partial, keeps what was fetched, stops immediately", async () => {
    const s = await setup();
    let failedAt = -1;
    const gsc = fakeGsc(DEFAULT_GSC_DATA, (req: GscQueryRequest, n: number) => {
      if (req.startDate === PREVIOUS.start) {
        failedAt = n;
        return { status: 429, message: "rateLimitExceeded" };
      }
      return undefined;
    });
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc }));
    expect(res.status).toBe("partial");
    expect(gsc.requests).toHaveLength(failedAt);
    const row = (await syncRow(s.db, res.syncId!))!;
    const totals = JSON.parse(row.totals_json);
    expect(totals.current).toMatchObject({ clicks: 300 });
    expect(totals.previous).toBeNull();
    expect(row.rows_fetched).toBeGreaterThan(0);
  });

  it("a non-quota error mid-import is partial with the (redacted) error recorded", async () => {
    const s = await setup();
    const gsc = fakeGsc(DEFAULT_GSC_DATA, (req) => (req.dimensions.join(",") === "query,page" && req.startDate === PREVIOUS.start ? new Error("boom Bearer abc.def") : undefined));
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc }));
    expect(res.status).toBe("partial");
    const row = (await syncRow(s.db, res.syncId!))!;
    expect(row.error).toContain("Bearer [redacted]");
    expect(row.error).not.toContain("abc.def");
  });
});
