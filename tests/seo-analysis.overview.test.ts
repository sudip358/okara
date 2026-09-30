import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import type { SeoOverview } from "@shared/types";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { seoOverviewRoutes } from "@worker/routes/seo-overview";
import { CSV_MAX_BYTES, CSV_MAX_ROWS, CsvError, EXPECTED_CSV_HEADERS, importGscCsv, parseCtr, parseGscCsv } from "@worker/seo/gsc/csv";
import { buildSeoOverview } from "@worker/seo/gsc/overview";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { CURRENT, PREVIOUS } from "./fixtures/gsc/site";
import { scenario } from "./fixtures/gsc/scenario";

const fx = (name: string) => readFileSync(join(process.cwd(), "tests/fixtures/gsc", name), "utf8");

function makeApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", seoOverviewRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    throw err;
  });
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

async function projectRow(env: Env, pid: string) {
  return (await new Db(env.DB).first<{ id: string; workspace_id: string; gsc_property: string | null; is_demo: number; language: string }>(
    "SELECT id, workspace_id, gsc_property, is_demo, language FROM projects WHERE id = ?",
    pid,
  ))!;
}

describe("CSV parsing", () => {
  it('parses CTR percentages ("4.5%") and fractions', () => {
    expect(parseCtr("4.5%")).toBeCloseTo(0.045, 12);
    expect(parseCtr("0.045")).toBeCloseTo(0.045, 12);
    expect(parseCtr(" 12 % ")).toBeCloseTo(0.12, 12);
    expect(parseCtr("120%")).toBeNull();
    expect(parseCtr("")).toBeNull();
    expect(parseCtr("abc")).toBeNull();
  });

  it("parses a Queries export with quoted fields", () => {
    const p = parseGscCsv(fx("queries.csv"));
    expect(p.kind).toBe("queries");
    expect(p.rows).toHaveLength(4);
    expect(p.rows[1]).toMatchObject({ key: "cabinet hardware, brass", clicks: 90, impressions: 1500, position: 6.1 });
    expect(p.rows[1]!.ctr).toBeCloseTo(0.06, 12);
    expect(parseGscCsv(fx("pages.csv")).kind).toBe("pages");
    expect(parseGscCsv(fx("chart.csv")).kind).toBe("dates");
  });

  it("rejects unknown or missing headers with the expected headers", () => {
    expect(() => parseGscCsv(fx("bad-headers.csv"))).toThrow(/Expected a Search Console export header/);
    expect(() => parseGscCsv(fx("missing-column.csv"))).toThrow(/Missing "CTR" column/);
  });

  it("rejects invalid rows with row-level details", () => {
    try {
      parseGscCsv(fx("invalid-rows.csv"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CsvError);
      const details = (e as CsvError).details as string[];
      expect(details.join(" | ")).toMatch(/Row 2: .*invalid CTR.*Clicks exceed Impressions/);
      expect(details.join(" | ")).toMatch(/Row 3: empty key/);
    }
  });

  it("enforces the 2 MB and 25,000-row caps", () => {
    const big = `Top queries,Clicks,Impressions,CTR,Position\n${"x".repeat(CSV_MAX_BYTES)},1,1,100%,1\n`;
    expect(() => parseGscCsv(big)).toThrow(/larger than 2 MB/);
    const many = ["Top queries,Clicks,Impressions,CTR,Position", ...Array.from({ length: CSV_MAX_ROWS + 1 }, (_, i) => `q${i},0,1,0%,1`)].join("\n");
    expect(() => parseGscCsv(many)).toThrow(/more than 25,000 rows/);
  });
});

describe("CSV import (provenance)", () => {
  it("imports a Chart export as window totals (position unavailable) and labels it csv_import", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const scope = { workspaceId: u.workspaceId, projectId: pid, userId: u.userId, property: "sc-domain:example.com", now: FIXED_NOW };
    const res = await importGscCsv(db, scope, { csv: fx("chart.csv"), window: "current", start: CURRENT.start, end: CURRENT.end });
    expect(res).toMatchObject({ kind: "dates", rows: 28, window: "current", windows: { current: CURRENT, previous: PREVIOUS } });

    const sync = (await db.first<{ source: string; status: string; totals_json: string }>("SELECT source, status, totals_json FROM gsc_syncs WHERE id = ?", res.syncId))!;
    expect(sync.source).toBe("csv_import");
    expect(sync.status).toBe("completed");
    const totals = JSON.parse(sync.totals_json);
    // Clicks 10..37 and impressions 1000..1270 over 28 days.
    expect(totals.current).toMatchObject({ clicks: 658, impressions: 31780, position: null, derivedFrom: "daily_chart_export" });
    expect(totals.provenance).toMatchObject({ source: "csv_import" });
    expect(totals.provenance.imports[0]).toMatchObject({ kind: "dates", importedBy: u.userId, rows: 28 });

    // A Queries export for the same window joins the same sync and never changes the totals.
    const q = await importGscCsv(db, scope, { csv: fx("queries.csv"), window: "current", start: CURRENT.start, end: CURRENT.end });
    expect(q.syncId).toBe(res.syncId);
    const after = JSON.parse((await db.first<{ totals_json: string }>("SELECT totals_json FROM gsc_syncs WHERE id = ?", res.syncId))!.totals_json);
    expect(after.current).toEqual(totals.current);
    expect(after.provenance.imports).toHaveLength(2);
    expect(q.notes.join(" ")).toMatch(/cannot provide property totals/);

    // Re-import is idempotent (rows replaced, not duplicated).
    await importGscCsv(db, scope, { csv: fx("queries.csv"), window: "current", start: CURRENT.start, end: CURRENT.end });
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM gsc_metrics WHERE sync_id = ?", res.syncId))!.n).toBe(4);
  });

  it("validates the declared window", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    const scope = { workspaceId: u.workspaceId, projectId: pid, userId: u.userId, property: null, now: FIXED_NOW };
    await expect(importGscCsv(db, scope, { csv: fx("queries.csv"), window: "current", start: "2026-09-10", end: "2026-09-30" })).rejects.toThrow(/before today/);
    await expect(importGscCsv(db, scope, { csv: fx("queries.csv"), window: "current", start: "2026-09-10", end: "2026-09-01" })).rejects.toThrow(/not be after/);
    await expect(importGscCsv(db, scope, { csv: fx("chart.csv"), window: "current", start: "2026-09-01", end: "2026-09-27" })).rejects.toThrow(/outside the declared window/);
    await expect(importGscCsv(db, scope, { csv: fx("bad-headers.csv"), window: "current", start: CURRENT.start, end: CURRENT.end })).rejects.toMatchObject({
      status: 400,
      details: { expectedHeaders: EXPECTED_CSV_HEADERS },
    });
  });
});

describe("SEO overview", () => {
  it("setup_required when no GSC or CSV data exists", async () => {
    const s = await scenario({ gsc: null, crawl: false });
    const o = await buildSeoOverview(new Db(s.env.DB), await projectRow(s.env, s.projectId));
    expect(o.state).toBe("setup_required");
    expect(o.totals).toEqual({ current: null, previous: null });
    expect(o.visitsRevenue).toEqual({ state: "not_connected" });
    expect(o.completeness.note).toMatch(/Connect Search Console or import a CSV/);
    expect(o.demandCurve).toBeNull();
  });

  it("shows API totals from the aggregate request, finalized daily points, completeness, limitations, and the demand curve", async () => {
    const s = await scenario({ crawl: false });
    const o = await buildSeoOverview(new Db(s.env.DB), await projectRow(s.env, s.projectId));
    expect(o.state).toBe("ready");
    expect(o.source).toBe("api");
    expect(o.current).toEqual(CURRENT);
    expect(o.previous).toEqual(PREVIOUS);
    expect(o.totals.current).toEqual({ clicks: 300, impressions: 50000, ctr: { numerator: 300, denominator: 50000, value: 300 / 50000 }, position: 12.3 });
    expect(o.totals.previous?.position).toBe(11.9);
    expect(o.daily).toHaveLength(26);
    expect(o.completeness.note).toMatch(/26 of 28 days in 2026-08-31\.\.2026-09-27/);
    expect(o.completeness.note).toMatch(/anonymized queries excluded/);
    expect(o.limitations.join(" ")).toMatch(/anonymized queries/);
    expect(o.visitsRevenue.state).toBe("not_connected");
    expect(o.truncated).toBe(false);
    expect(o.demandCurve).toMatchObject({ source: "api", window: CURRENT, basis: "first_party_impressions", truncated: false });
    expect(o.demandCurve!.segments.map((x) => x.segment)).toEqual(["head", "middle", "long_tail"]);
    expect(o.limitations.join(" ")).toMatch(/Demand curve: query totals are summed from query\+page rows/);
  });

  it("labels CSV imports (no position) and annotates the source change", async () => {
    const s = await scenario({ crawl: false });
    const db = new Db(s.env.DB);
    // A later CSV import for the same windows becomes the latest data.
    await importGscCsv(db, { workspaceId: s.workspaceId, projectId: s.projectId, userId: s.userId, property: null, now: new Date(FIXED_NOW.getTime() + 60_000) }, {
      csv: fx("chart.csv"),
      window: "current",
      start: CURRENT.start,
      end: CURRENT.end,
    });
    const o = await buildSeoOverview(db, await projectRow(s.env, s.projectId));
    expect(o.source).toBe("csv_import");
    expect(o.totals.current?.position).toBeNull();
    expect(o.limitations.join(" ")).toMatch(/CSV export, not an API sync/);
    expect(o.annotations.some((a) => /API sync to CSV import/.test(a.label))).toBe(true);
    expect(o.demandCurve).toBeNull(); // chart export has no query rows
  });

  it("demo projects report the demo state", async () => {
    const s = await scenario({ crawl: false, project: { is_demo: 1 } });
    await new Db(s.env.DB).run("UPDATE gsc_syncs SET source = 'demo' WHERE project_id = ?", s.projectId);
    const o = await buildSeoOverview(new Db(s.env.DB), await projectRow(s.env, s.projectId));
    expect(o.state).toBe("demo");
    expect(o.source).toBe("demo");
    expect(o.completeness.note).toMatch(/demo data/);
  });

  it("error state when the only sync failed", async () => {
    const s = await scenario({ crawl: false, gsc: null });
    await new Db(s.env.DB).insert("gsc_syncs", {
      id: newId("gsync"), workspace_id: s.workspaceId, project_id: s.projectId, source: "api", property: "sc-domain:example.com",
      window_start: CURRENT.start, window_end: CURRENT.end, prev_window_start: PREVIOUS.start, prev_window_end: PREVIOUS.end,
      row_cap: 5000, status: "failed", error: "Search Console quota or rate limit reached (HTTP 429)", synced_at: FIXED_NOW.toISOString(),
    });
    const o = await buildSeoOverview(new Db(s.env.DB), await projectRow(s.env, s.projectId));
    expect(o.state).toBe("error");
    expect(o.completeness.note).toMatch(/429/);
  });
});

describe("seo-overview routes", () => {
  it("GET overview returns the SeoOverview; another workspace's project is 404", async () => {
    const s = await scenario({ crawl: false });
    const call = makeApp(s.env, s.userId);
    const ok = await call("GET", `/projects/${s.projectId}/seo/overview`);
    expect(ok.status).toBe(200);
    expect((ok.json.data as SeoOverview).totals.current?.clicks).toBe(300);

    const other = await seedUser(s.env);
    const denied = await makeApp(s.env, other.userId)("GET", `/projects/${s.projectId}/seo/overview`);
    expect(denied.status).toBe(404);
    const deniedImport = await makeApp(s.env, other.userId)("POST", `/projects/${s.projectId}/seo/import-csv`, { csv: fx("queries.csv"), window: "current", start: CURRENT.start, end: CURRENT.end });
    expect(deniedImport.status).toBe(404);
  });

  it("POST import-csv returns 201 {syncId, rows, window}; invalid CSV is 400 with the expected headers", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const call = makeApp(env, u.userId);
    const res = await call("POST", `/projects/${pid}/seo/import-csv`, { csv: fx("queries.csv"), window: "previous", start: PREVIOUS.start, end: PREVIOUS.end });
    expect(res.status).toBe(201);
    expect(res.json.data).toEqual({ syncId: expect.stringMatching(/^gsync_/), rows: 4, window: "previous" });
    const row = await new Db(env.DB).first<{ source: string; window_start: string; prev_window_start: string }>("SELECT source, window_start, prev_window_start FROM gsc_syncs WHERE id = ?", res.json.data.syncId);
    expect(row).toEqual({ source: "csv_import", window_start: CURRENT.start, prev_window_start: PREVIOUS.start });

    const bad = await call("POST", `/projects/${pid}/seo/import-csv`, { csv: fx("bad-headers.csv"), window: "current", start: CURRENT.start, end: CURRENT.end });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.expectedHeaders.metricColumns).toEqual(["Clicks", "Impressions", "CTR", "Position"]);
    expect(bad.json.error.message).toMatch(/Expected a Search Console export header/);

    const badBody = await call("POST", `/projects/${pid}/seo/import-csv`, { csv: "", window: "later", start: "x", end: "y" });
    expect(badBody.status).toBe(400);
    expect(badBody.json.error.details.expectedHeaders).toBeDefined();
  });
});
