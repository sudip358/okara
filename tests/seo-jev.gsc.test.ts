/**
 * [A23]/[A25] Search Console upgrades: extra sync slices within the row cap, year-over-year suppression
 * of seasonal dips, deterministic decay causes, alternating ranking URLs feeding the [A15] pair prefilter,
 * and translation opportunities. Labelled fixture data (tests/fixtures/gsc/site.ts), not live data.
 */
import { describe, expect, it } from "vitest";
import type { Budget } from "@worker/runs/context";
import type { GscRow } from "@worker/providers/types";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { addDays } from "@worker/lib/time";
import { parseTotalsJson } from "@worker/seo/gsc/aggregate";
import { detectAlternatingUrls, EXTRA_SLICES_VERSION, extraCaps, weekStartsOf, yoyWindow, type QueryPageWeeksJson } from "@worker/seo/gsc/slices";
import { syncGsc } from "@worker/seo/gsc/sync";
import { buildTranslationOpportunities, TRANSLATION_MIN_SHARE, translationRows } from "@worker/seo/gsc/translation";
import { localeCountryAlpha3 } from "@worker/seo/gsc/countries";
import { buildCandidates, seasonalSuppressions } from "@worker/seo/recommend/candidates";
import { classifyDecay, yoyVerdict } from "@worker/seo/recommend/decay";
import { draftDeterministic } from "@worker/seo/recommend/draft";
import { loadCandidateInputs } from "@worker/seo/recommend/inputs";
import { makeTestContext } from "./helpers/context";
import { FIXED_NOW } from "./helpers/fixtures";
import { CURRENT, DEFAULT_GSC_DATA, fakeGsc, PAGE_CURRENT, PAGE_PREVIOUS, QP_CURRENT, QP_PREVIOUS, U, type FakeGscData } from "./fixtures/gsc/site";
import { scenario } from "./fixtures/gsc/scenario";
import { patchSnapshot } from "./seo-jev.fixtures";

const row = (keys: string[], clicks: number, impressions: number, position: number): GscRow => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const LY = yoyWindow(CURRENT);
const lyDaily = (days: number) => Array.from({ length: days }, (_, i) => row([addDays(LY.start, i)], 8, 1500, 11));

/** "cabinet knob": top page alternates knob -> sconces -> knob -> sconces across the four weeks. */
const QPD: GscRow[] = [
  row(["cabinet knob", U.knob, "2026-09-01"], 5, 60, 7),
  row(["cabinet knob", U.sconces, "2026-09-02"], 1, 40, 9),
  row(["cabinet knob", U.sconces, "2026-09-08"], 6, 70, 7),
  row(["cabinet knob", U.knob, "2026-09-09"], 1, 30, 9),
  row(["cabinet knob", U.knob, "2026-09-15"], 4, 50, 8),
  row(["cabinet knob", U.sconces, "2026-09-22"], 5, 55, 8),
  row(["brass cabinet knob", U.knob, "2026-09-01"], 3, 500, 5),
  row(["brass cabinet knob", U.knob, "2026-09-10"], 3, 500, 5),
];
const COUNTRY = [row(["usa"], 250, 40000, 12), row(["gbr"], 30, 5000, 14), row(["deu"], 10, 3000, 18), row(["can"], 5, 1500, 15), row(["zzz"], 0, 100, 30), row(["fra"], 0, 50, 40)];
const COUNTRY_PAGE = [
  row(["gbr", U.knob], 20, 3000, 12),
  row(["gbr", U.hardware], 5, 1500, 15),
  row(["gbr", U.sconces], 3, 400, 16),
  row(["gbr", U.guide], 0, 10, 40),
  row(["deu", U.hardware], 8, 2000, 17),
];

function data(opts: { lastYearPages?: GscRow[]; lastYearDays?: number } = {}): FakeGscData {
  return {
    ...DEFAULT_GSC_DATA,
    // "cabinet knob" shows only on the knob page in the (truncated) query+page slice.
    qp: { current: [...QP_CURRENT, row(["cabinet knob", U.knob], 10, 400, 7)], previous: QP_PREVIOUS },
    qpd: QPD,
    country: COUNTRY,
    countryPage: COUNTRY_PAGE,
    lastYear: { daily: lyDaily(opts.lastYearDays ?? 28), page: opts.lastYearPages ?? [row([U.hardware], 110, 1650, 5), row([U.knob], 12, 2000, 6)] },
  };
}

function recordingBudget(): Budget & { log: Array<{ op: string; amount?: number }> } {
  const log: Array<{ op: string; amount?: number }> = [];
  return {
    log,
    async reserve(_r, amount) {
      log.push({ op: "reserve", amount });
      return "1";
    },
    async settle(_id, amount) {
      log.push({ op: "settle", amount });
    },
    async release() {},
    async markUnknown() {},
  };
}

// ------------------------------------------------------------------ sync
describe("GSC sync: extra slices (" + EXTRA_SLICES_VERSION + ")", () => {
  it("fetches weekly query+page, a YoY probe then last year's pages, countries, and country+page, within the row cap", async () => {
    const s = await scenario({ crawl: false, gsc: null });
    const gsc = fakeGsc(data());
    const budget = recordingBudget();
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc, budget }));
    expect(res.status).toBe("completed");
    const caps = extraCaps(5000);
    expect(caps).toMatchObject({ queryPageDate: 500, yoyPages: 500, countries: 100, countryPages: 200 });
    const req = (dims: string, start = CURRENT.start) => gsc.requests.filter((r) => r.dimensions.join(",") === dims && r.startDate === start);
    expect(req("query,page,date")[0]!.rowLimit).toBeLessThanOrEqual(caps.queryPageDate);
    expect(req("date", LY.start)).toHaveLength(1); // the probe
    expect(req("page", LY.start)[0]!.rowLimit).toBeLessThanOrEqual(caps.yoyPages);
    expect(req("country")[0]!.rowLimit).toBeLessThanOrEqual(caps.countries);
    expect(req("country,page")[0]!.rowLimit).toBeLessThanOrEqual(caps.countryPages);
    // Base slices got the rest of the cap.
    expect(req("query,page")[0]!.rowLimit).toBeLessThanOrEqual((5000 - caps.total) / 2);

    const db = new Db(s.env.DB);
    const sync = (await db.first<{ totals_json: string; rows_fetched: number }>("SELECT totals_json, rows_fetched FROM gsc_syncs WHERE id = ?", res.syncId))!;
    const x = parseTotalsJson(sync.totals_json).extras!;
    expect(x.version).toBe(EXTRA_SLICES_VERSION);
    expect(x.yoy).toMatchObject({ window: LY, status: "available", daysWithData: 28, windowDays: 28, totals: { clicks: 224, impressions: 42000 } });
    expect(x.yoy!.pages).toEqual([[U.hardware, 110, 1650, 5], [U.knob, 12, 2000, 6]]);
    expect(x.queryPageWeeks!.weekStarts).toEqual(weekStartsOf(CURRENT));
    expect(x.queryPageWeeks!.rows.filter((r) => r[0] === "cabinet knob").map((r) => [r[1], r[2]])).toEqual([
      [0, U.knob],
      [0, U.sconces],
      [1, U.sconces],
      [1, U.knob],
      [2, U.knob],
      [3, U.sconces],
    ]);
    expect(x.countries!.rows[0]).toEqual(["usa", 250, 40000]);
    expect(x.countryPages!.rows).toHaveLength(COUNTRY_PAGE.length);
    // Every extra row counts against the row budget (settled to the rows actually imported).
    const extraRows = QPD.length + 2 + COUNTRY.length + COUNTRY_PAGE.length;
    const metrics = (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM gsc_metrics WHERE sync_id = ?", res.syncId))!.n;
    expect(res.rows).toBe(metrics + extraRows);
    expect(budget.log.at(-1)).toEqual({ op: "settle", amount: res.rows });
    expect(res.rows).toBeLessThanOrEqual(5000);
  });

  it("no last-year data: the probe says no_history and last year's pages are not requested", async () => {
    const s = await scenario({ crawl: false, gsc: null });
    const gsc = fakeGsc({ ...data(), lastYear: { daily: [], page: [row([U.hardware], 110, 1650, 5)] } });
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc }));
    expect(gsc.requests.some((r) => r.dimensions.join(",") === "page" && r.startDate === LY.start)).toBe(false);
    const x = parseTotalsJson((await new Db(s.env.DB).first<{ totals_json: string }>("SELECT totals_json FROM gsc_syncs WHERE id = ?", res.syncId))!.totals_json).extras!;
    expect(x.yoy).toMatchObject({ status: "no_history", daysWithData: 0, pages: [] });
    expect(x.notes.join(" ")).toMatch(/0 of 28 days; year-over-year comparison is unavailable/);
  });

  it("partial last-year coverage is not treated as history; a small row cap skips every extra slice", async () => {
    const s = await scenario({ crawl: false, gsc: null });
    const gsc = fakeGsc(data({ lastYearDays: 10 }));
    const res = await syncGsc(makeTestContext(s.env, s.project, { gsc }));
    const x = parseTotalsJson((await new Db(s.env.DB).first<{ totals_json: string }>("SELECT totals_json FROM gsc_syncs WHERE id = ?", res.syncId))!.totals_json).extras!;
    expect(x.yoy!.status).toBe("partial_history");

    const s2 = await scenario({ crawl: false, gsc: null });
    await new Db(s2.env.DB).run("UPDATE project_limits SET gsc_rows = 800 WHERE project_id = ?", s2.projectId);
    const gsc2 = fakeGsc(data());
    const res2 = await syncGsc(makeTestContext(s2.env, s2.project, { gsc: gsc2 }));
    expect(gsc2.requests.some((r) => ["country", "query,page,date"].includes(r.dimensions.join(",")) || r.startDate === LY.start)).toBe(false);
    const x2 = parseTotalsJson((await new Db(s2.env.DB).first<{ totals_json: string }>("SELECT totals_json FROM gsc_syncs WHERE id = ?", res2.syncId))!.totals_json).extras!;
    expect(x2.notes.join(" ")).toMatch(/Row cap below 1,000/);
  });
});

// ------------------------------------------------------------------ YoY + decay causes
describe("content decay: year-over-year and likely causes", () => {
  it("a dip that matches the same window last year is suppressed as seasonal", async () => {
    const s = await scenario({ findings: [], gsc: data() }); // hardware: 200 -> 100 clicks; last year 110
    const inputs = await loadCandidateInputs(s.ctx());
    expect(buildCandidates(inputs).some((c) => c.kind === "declining")).toBe(false);
    expect(seasonalSuppressions(inputs)).toEqual([{ url: U.hardware, currentClicks: 100, lastYearClicks: 110 }]);
  });

  it("down against last year too: proposed, with the YoY evidence", async () => {
    const s = await scenario({ findings: [], gsc: data({ lastYearPages: [row([U.hardware], 300, 2500, 4)] }) });
    const c = buildCandidates(await loadCandidateInputs(s.ctx())).find((x) => x.kind === "declining")!;
    expect(c.metrics.yoy).toBe("down_yoy");
    const ly = c.evidence.find((e) => (e.data as { window?: string }).window === "last_year")!;
    expect(ly.window).toBe(`${LY.start}..${LY.end}`);
    expect(ly.text).toMatch(/same window last year.*300 clicks.*also down against last year/);
  });

  it("classifies each cause deterministically (several can apply)", () => {
    const prev = { clicks: 100, impressions: 2000, position: 5 };
    expect(classifyDecay(prev, { clicks: 60, impressions: 1400, position: 5.5 }, { changed: null }).causes).toEqual(["demand_or_season"]);
    expect(classifyDecay({ ...prev, position: 4 }, { clicks: 60, impressions: 1900, position: 7.5 }, { changed: null }).causes).toEqual(["ranking_loss"]);
    expect(classifyDecay(prev, { clicks: 50, impressions: 1900, position: 5.2 }, { changed: null }).causes).toEqual(["ctr_drop"]);
    expect(classifyDecay(prev, { clicks: 90, impressions: 1950, position: 5 }, { changed: true }).causes).toEqual(["content_changed"]);
    expect(classifyDecay({ ...prev, position: 3 }, { clicks: 40, impressions: 1900, position: 6 }, { changed: true }).causes).toEqual(["ranking_loss", "content_changed"]);
    // Unknown position: no cause that needs a stable position is claimed.
    expect(classifyDecay({ ...prev, position: null }, { clicks: 50, impressions: 1000, position: null }, { changed: null }).causes).toEqual([]);
    expect(yoyVerdict(100, { clicks: 110, impressions: 1, position: null }, { minPrevClicks: 20, minDrop: 0.3 })).toBe("seasonal");
    expect(yoyVerdict(100, { clicks: 300, impressions: 1, position: null }, { minPrevClicks: 20, minDrop: 0.3 })).toBe("down_yoy");
    expect(yoyVerdict(100, { clicks: 10, impressions: 1, position: null }, { minPrevClicks: 20, minDrop: 0.3 })).toBe("no_comparison");
    expect(yoyVerdict(100, null, { minPrevClicks: 20, minDrop: 0.3 })).toBe("no_comparison");
  });

  it("the fixture's declining page: CTR drop + content change between the last two crawls, in evidence and text", async () => {
    const s = await scenario({ findings: [] });
    const db = new Db(s.env.DB);
    const page = (await db.first<{ id: string }>("SELECT id FROM pages WHERE url = ? AND project_id = ?", U.hardware, s.projectId))!;
    await patchSnapshot(s, U.hardware, { content_hash: "hash-new" }); // current crawl
    const oldCrawl = newId("crawl");
    await db.insert("crawl_runs", { id: oldCrawl, workspace_id: s.workspaceId, project_id: s.projectId, status: "completed", pages_limit: 20, pages_crawled: 1, started_at: "2026-09-01T08:00:00.000Z", finished_at: "2026-09-01T08:05:00.000Z" });
    await db.insert("page_snapshots", { id: newId("snap"), workspace_id: s.workspaceId, project_id: s.projectId, page_id: page.id, crawl_run_id: oldCrawl, status_code: 200, final_url: U.hardware, content_hash: "hash-old", fetched_at: "2026-09-01T08:01:00.000Z" });
    const c = buildCandidates(await loadCandidateInputs(s.ctx())).find((x) => x.kind === "declining")!;
    expect(c.metrics.decayCauses).toBe("ctr_drop,content_changed");
    expect(c.metrics.yoy).toBe("no_comparison");
    const cause = c.evidence.find((e) => (e.data as { causes?: string[] }).causes)!;
    expect(cause.text).toMatch(/decay-causes-2026-09-30\.1/);
    expect(cause.data).toMatchObject({ causes: ["ctr_drop", "content_changed"], contentChanged: true });
    const d = draftDeterministic({ candidate: c, action: "improve_intro_answer", tier: "act", intent: null, severityScore: null, evidence: c.evidence.map((spec, i) => ({ id: `ev_d${i}`, spec })), contextDocs: [] });
    expect(d.ok, d.ok ? "" : d.errors.join("; ")).toBe(true);
    if (d.ok) expect(d.draft.rationale).toMatch(/Likely cause from the project's own Search Console and crawl data: click-through drop .*; content changed between the last two crawls\. \[ev_d\d\]/);
  });
});

// ------------------------------------------------------------------ alternating URLs
describe("alternating ranking URLs -> [A15] pair prefilter", () => {
  it("flags a query whose weekly top page changes at least twice", () => {
    const json: QueryPageWeeksJson = {
      window: CURRENT,
      weekStarts: weekStartsOf(CURRENT),
      topQueries: 3,
      fetchedRows: 0,
      truncated: false,
      rows: [
        ["alt", 0, "/a", 5, 50], ["alt", 0, "/b", 1, 40],
        ["alt", 1, "/b", 4, 50], ["alt", 2, "/a", 3, 30],
        ["once", 0, "/a", 5, 50], ["once", 1, "/b", 5, 50], ["once", 2, "/b", 5, 50],
        ["tie", 0, "/a", 0, 10], ["tie", 0, "/b", 0, 20], ["tie", 1, "/a", 0, 30], ["tie", 2, "/b", 0, 40],
        ["gap", 0, "/a", 1, 10], ["gap", 3, "/a", 1, 10],
      ],
    };
    const alt = detectAlternatingUrls(json);
    expect(alt.map((a) => [a.query, a.changes])).toEqual([
      ["alt", 2],
      ["tie", 2],
    ]);
    expect(alt[0]!.weeks.map((w) => [w.weekStart, w.page])).toEqual([
      [CURRENT.start, "/a"],
      [addDays(CURRENT.start, 7), "/b"],
      [addDays(CURRENT.start, 14), "/a"],
    ]);
  });

  it("pages that alternate for a query become a duplicate pair even without shared rows in the query+page slice", async () => {
    const s = await scenario({ findings: [], gsc: data() });
    const dups = buildCandidates(await loadCandidateInputs(s.ctx())).filter((c) => c.kind === "duplicate");
    const pair = dups.find((c) => c.target.exampleUrls!.slice().sort().join("|") === [U.knob, U.sconces].sort().join("|"))!;
    expect(pair).toBeDefined();
    expect(pair.trigger).toBe('Two URLs alternate as the top result for GSC query "cabinet knob"');
    expect(pair.sharedQueries).toEqual(["cabinet knob"]);
    expect(pair.metrics.alternatingQueries).toBe(1);
    expect(pair.evidence.some((e) => /the top page by clicks changed 3 times across weeks/.test(e.text))).toBe(true);
    // Without the weekly slice the pair does not exist (knob and sconces share no title words or slice rows).
    const s2 = await scenario({ findings: [], gsc: { ...data(), qpd: [] } });
    const dups2 = buildCandidates(await loadCandidateInputs(s2.ctx())).filter((c) => c.kind === "duplicate");
    expect(dups2.some((c) => c.target.exampleUrls!.includes(U.sconces))).toBe(false);
  });
});

// ------------------------------------------------------------------ translation opportunities
describe("translation opportunities", () => {
  it("rows for other countries at or above the share threshold, with top pages; served language unknown", () => {
    expect(localeCountryAlpha3("en-US")).toBe("usa");
    expect(localeCountryAlpha3("de_de")).toBe("deu");
    expect(localeCountryAlpha3("en")).toBeNull();
    const countries = COUNTRY.map((r) => [r.keys[0]!, r.clicks, r.impressions] as [string, number, number]);
    const pages = COUNTRY_PAGE.map((r) => [r.keys[0]!, r.keys[1]!, r.clicks, r.impressions] as [string, string, number, number]);
    const rows = translationRows(countries, pages, "usa", "2026-08-31..2026-09-27");
    const total = 40000 + 5000 + 3000 + 1500 + 100 + 50;
    expect(TRANSLATION_MIN_SHARE).toBe(0.05);
    expect(rows.map((r) => r.country)).toEqual(["gbr", "deu"]); // can = 3.0% (below), usa = home, zzz = unknown
    expect(rows[0]).toMatchObject({ impressions: 5000, clicks: 30, shareOfImpressions: { numerator: 5000, denominator: total }, topPages: [U.knob, U.hardware, U.sconces], servedLanguage: null });
    expect(rows[0]!.note).toMatch(/United Kingdom.*not a promise of rankings or traffic/);
    // Without a locale country, the home market is not excluded.
    expect(translationRows(countries, pages, null, "w").map((r) => r.country)).toEqual(["usa", "gbr", "deu"]);
  });

  it("service: ready with rows after an API sync; setup_required without country data", async () => {
    const s = await scenario({ crawl: false, gsc: data() });
    const project = { id: s.projectId, workspace_id: s.workspaceId, locale: "en-US", is_demo: 0 };
    const res = await buildTranslationOpportunities(new Db(s.env.DB), project, FIXED_NOW);
    expect(res.state).toBe("ready");
    expect(res.rows.map((r) => r.country)).toEqual(["gbr", "deu"]);
    expect(res.labels.join(" ")).toMatch(/not a promise of rankings/);
    expect(res.labels.join(" ")).toMatch(/Served language: unknown/);
    expect(res.completeness).toMatchObject({ covered: 2, total: 6 });

    const s2 = await scenario({ crawl: false }); // no country rows in the fixture sync -> empty slice
    const res2 = await buildTranslationOpportunities(new Db(s2.env.DB), { id: s2.projectId, workspace_id: s2.workspaceId, locale: "en-US", is_demo: 0 }, FIXED_NOW);
    expect(res2).toMatchObject({ state: "ready", rows: [] });
    const s3 = await scenario({ crawl: false, gsc: null });
    const res3 = await buildTranslationOpportunities(new Db(s3.env.DB), { id: s3.projectId, workspace_id: s3.workspaceId, locale: "en-US", is_demo: 0 }, FIXED_NOW);
    expect(res3).toMatchObject({ state: "setup_required", rows: [] });
  });

  it("the page slice rows are not double counted into the translation denominator", () => {
    const rows = translationRows([["gbr", 1, 100], ["usa", 1, 1900]], [["gbr", U.knob, 1, 100]], "usa", "w");
    expect(rows[0]!.shareOfImpressions).toEqual({ numerator: 100, denominator: 2000, value: 0.05 });
    expect(PAGE_CURRENT.length + PAGE_PREVIOUS.length).toBeGreaterThan(0);
  });
});
