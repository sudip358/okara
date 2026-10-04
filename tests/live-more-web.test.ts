/**
 * Live view project containers (docs/live-view-design.md section 17), web side: server-rendered markup of each
 * container's setup, empty and data states from contract fixtures; the "Containers" menu and its stored
 * show/hide state; the boards honouring it; the run-button mapping of the new containers (partial runs, the
 * paid DataForSEO refresh with its domain picker and cost text, per-row sheet "Sync now"); and honesty rules
 * (no projections, plain text, n of m counts, fixed-layout tables).
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { CompetitorDataPanel, CompetitorDomainDetail } from "../src/shared/competitor-data";
import type {
  LiveBrandsInsight,
  LiveBudgetInsight,
  LiveCitedDomainsInsight,
  LiveEngineQueriesInsight,
  LiveMoversInsight,
  LivePromptHistoryInsight,
  LiveSheetSyncRow,
  LiveSheetsInsight,
  LiveStrikingInsight,
  LiveTechnicalInsight,
} from "../src/shared/types";
import { buildTimeline } from "../src/web/pages/live/engine";
import {
  DEMO_REASON,
  OWNER_REASON_DFS,
  OWNER_REASON_SYNC,
  QUOTA_REASON,
  competitorRefreshAction,
  moreGeoActions,
  moreSeoActions,
  sheetSyncAction,
  type ActionEnv,
  type SectionAction,
} from "../src/web/pages/live/run-actions";
import { gscMatchText, historyLabel, nOfM, recentText, signed, sourceCaption, syncState, usdMicros } from "../src/web/pages/live/more/format";
import {
  GEO_CONTAINERS,
  SEO_CONTAINERS,
  hiddenStorageKey,
  parseHidden,
  readHidden,
  serializeHidden,
  toggleHidden,
  writeHidden,
} from "../src/web/pages/live/more/registry";
import { assessment, plan } from "./geo-batch-board-fixtures";
import { HOSTILE, activity, at, coverageRow, evidenceRow, geoFeed, linkReport, overview, run, seoFeed } from "./live-web-fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const seo = await load<Record<"StrikingPanel" | "MoversPanel" | "TechnicalPanel" | "CompetitorGapPanel", FC>>("../src/web/pages/live/more/SeoContainers.tsx");
const geo = await load<Record<"EngineQueriesPanel" | "BrandsPanel" | "CitedDomainsPanel" | "PromptHistoryPanel", FC>>("../src/web/pages/live/more/GeoContainers.tsx");
const shared = await load<Record<"SheetsPanel" | "BudgetPanel", FC>>("../src/web/pages/live/more/SharedContainers.tsx");
const { ContainersMenu } = await load<Record<"ContainersMenu", FC>>("../src/web/pages/live/more/ContainersMenu.tsx");
const common = await load<Record<"LazyMount", FC>>("../src/web/pages/live/more/common.tsx");
const moreData = await load<{ LiveMoreContext: { Provider: FC } }>("../src/web/pages/live/more/data.ts");
const ra = await load<{ PanelActionsContext: { Provider: FC }; RunActionsProvider: FC; ConfirmDialog: FC; syncFailure: (r: unknown) => string | null }>("../src/web/pages/live/RunActions.tsx");
const { SeoBoard } = await load<Record<"SeoBoard", FC>>("../src/web/pages/live/SeoBoard.tsx");
const { GeoBoard } = await load<Record<"GeoBoard", FC>>("../src/web/pages/live/GeoBoard.tsx");

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const text = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
const st = <T,>(data: T | null, error: unknown = null) => ({ data, error, loading: data === null && !error, reload: () => {}, setData: () => {} });
const NONE: ReadonlySet<string> = new Set();
const GEN = "2026-10-03T12:00:00.000Z";
const WINDOW = { from: "2026-09-03T12:00:00.000Z", to: GEN, days: 30 };
const SYNC = { syncId: "gs1", runId: "run1", source: "api" as const, syncedAt: "2026-09-29T14:03:00.000Z", current: { start: "2026-09-01", end: "2026-09-28" }, previous: { start: "2026-08-04", end: "2026-08-31" }, truncated: false };

/** Words the reference videos used that must never render (honest replacements are used instead). */
const FORBIDDEN: RegExp[] = [/Simulated run/, /Prompts\s*\/\s*sec/i, /citability/i, /\bsteal/i, /\bAfter\b/, /\bchance\b/i, /\d\s*\/\s*10\b/, /\bTraffic\b/, /\bRevenue\b/, /ChatGPT/, /\bConfidence\b/, /share of voice/i, /\bforecast/i];
function expectHonest(html: string) {
  const t = text(html);
  for (const re of FORBIDDEN) expect(re.test(t), `forbidden ${re}`).toBe(false);
  expect(html).not.toContain("<script>");
  expect(html).not.toMatch(/<img[^>]*onerror/);
  expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+="/i);
  for (const m of html.matchAll(/<table class="([^"]*)"/g)) expect(m[1]).toMatch(/w-full table-fixed/);
}

// ------------------------------------------------------------------ fixtures
function striking(over: Partial<LiveStrikingInsight> = {}): LiveStrikingInsight {
  return {
    kind: "striking", state: "ready", message: null, generatedAt: GEN, labels: [], truncated: false, sync: SYNC,
    thresholds: { minPosition: 8, maxPosition: 20, minImpressions: 1, maxRows: 50 },
    rows: [
      { query: HOSTILE, page: "https://shop.example/products/oak", clicks: 12, impressions: 1340, ctr: 12 / 1340, position: 9.3, previous: { clicks: 15, impressions: 1290, position: 8.8 } },
      { query: "brass knobs", page: "https://shop.example/c/knobs", clicks: 4, impressions: 960, ctr: 4 / 960, position: 17.4, previous: null },
    ],
    total: 132,
    ...over,
  };
}
function movers(over: Partial<LiveMoversInsight> = {}): LiveMoversInsight {
  return {
    kind: "movers", state: "ready", message: null, generatedAt: GEN, labels: ["Sums of query+page rows per page (a lower bound: anonymized queries are omitted), current vs previous window; only pages present in both windows are ranked."], truncated: false, sync: SYNC, basis: "query_page_rows", top: 8,
    gainers: [{ page: "https://shop.example/blog/guide", current: { clicks: 83, impressions: 4390, position: 5.62 }, previous: { clicks: 66, impressions: 3640, position: 6.1 }, clickDelta: 17 }],
    losers: [{ page: "https://shop.example/c/sofas", current: { clicks: 38, impressions: 4120, position: 6.8 }, previous: { clicks: 44, impressions: 3610, position: 7.4 }, clickDelta: -6 }],
    counts: { both: 7, unchanged: 0, newPages: 2, lostPages: 1 },
    ...over,
  };
}
function technical(over: Partial<LiveTechnicalInsight> = {}): LiveTechnicalInsight {
  return {
    kind: "technical", state: "ready", message: null, generatedAt: GEN, labels: [], truncated: false,
    crawl: { id: "c1", runId: "other-run", status: "completed", startedAt: "2026-09-28T10:00:00.000Z", finishedAt: "2026-09-28T10:05:00.000Z", pagesCrawled: 38, pagesSkipped: 2, pagesLimit: 50 },
    newer: { status: "running", startedAt: "2026-10-03T11:00:00.000Z" },
    bySeverity: { critical: 0, major: 1, moderate: 3, minor: 0, advisory: 0 },
    total: 4,
    groups: [
      { severity: "major", ruleId: "SEO-TITLE-MISSING", ruleName: "Missing title", area: "metadata", class: "fact", count: 1, examples: [{ url: "https://shop.example/a", template: null, detail: HOSTILE }] },
      { severity: "moderate", ruleId: "ECOM-PRODUCT-OFFER-INCOMPLETE", ruleName: "Product offer incomplete", area: "ecommerce", class: "fact", count: 3, examples: [{ url: null, template: "product template", detail: "No offers" }] },
    ],
    ...over,
  };
}
function engineQueries(over: Partial<LiveEngineQueriesInsight> = {}): LiveEngineQueriesInsight {
  return {
    kind: "engine_queries", state: "ready", message: null, generatedAt: GEN, labels: ["API-sampled answers; consumer apps may answer differently."], truncated: false, window: WINDOW,
    rows: [
      { query: "oak side table", engines: ["gemini", "openai_geo"], answers: 3, lastSeen: "2026-10-02T10:00:00.000Z", gsc: { clicks: 22, impressions: 340, position: 12.34, window: SYNC.current, basis: "query_page_rows" } },
      { query: HOSTILE, engines: ["gemini"], answers: 1, lastSeen: "2026-10-01T10:00:00.000Z", gsc: null },
    ],
    total: 75, gscSync: { syncedAt: SYNC.syncedAt, window: SYNC.current }, limit: 50,
    ...over,
  };
}
function brands(over: Partial<LiveBrandsInsight> = {}): LiveBrandsInsight {
  const c = (answers: number, mentioned: number, cited: number, recommended: number, negative: number) => ({ answers, mentioned, cited, recommended, negative });
  return {
    kind: "brands", state: "ready", message: null, generatedAt: GEN, labels: [], truncated: false, window: WINDOW, engines: ["openai_geo", "gemini"],
    brands: [
      { brandKey: "self", name: "Shop", isSelf: true, engines: [{ provider: "openai_geo", ...c(2, 2, 2, 0, 0) }, { provider: "gemini", ...c(4, 2, 1, 1, 1) }], total: c(6, 4, 3, 1, 1) },
      { brandKey: HOSTILE, name: HOSTILE, isSelf: false, engines: [{ provider: "gemini", ...c(4, 4, 0, 4, 0) }], total: c(4, 4, 0, 4, 0) },
    ],
    ...over,
  };
}
function citedDomains(over: Partial<LiveCitedDomainsInsight> = {}): LiveCitedDomainsInsight {
  return {
    kind: "cited_domains", state: "ready", message: null, generatedAt: GEN, labels: [], truncated: false, window: WINDOW,
    rows: [
      { host: "reviews.example", answers: 3, citations: 6, engines: ["gemini", "perplexity"], sourceTypes: ["review_site"], brand: null, rank: 1 },
      { host: "acme.example", answers: 2, citations: 2, engines: ["gemini"], sourceTypes: ["brand_page"], brand: { key: "Acme", isSelf: false }, rank: 2 },
    ],
    own: { host: "shop.example", answers: 1, citations: 1, engines: ["gemini"], sourceTypes: ["brand_page"], brand: { key: "self", isSelf: true }, rank: 31 },
    answersWithCitations: 12, totalHosts: 40, unresolved: 2, limit: 25,
    ...over,
  };
}
function history(over: Partial<LivePromptHistoryInsight> = {}): LivePromptHistoryInsight {
  return {
    kind: "prompt_history", state: "ready", message: null, generatedAt: GEN, labels: [], truncated: false, maxRuns: 8, promptSet: { version: 3, label: "Synced from sheet 2026-10-02" },
    engines: [{ provider: "gemini", runs: [{ runId: "r1", at: "2026-09-29T10:00:00.000Z" }, { runId: "r2", at: "2026-09-30T10:00:00.000Z" }, { runId: "r3", at: "2026-10-01T10:00:00.000Z" }] }],
    rows: [
      { promptId: "p1", text: "Best brass knobs?", cells: { gemini: ["cited", "named", "missing"] } },
      { promptId: "p2", text: HOSTILE, cells: { gemini: ["failed", "not_analysed", "none"] } },
    ],
    ...over,
  };
}
function syncRow(over: Partial<LiveSheetSyncRow> = {}): LiveSheetSyncRow {
  return {
    id: "isync_1", spreadsheetTitle: "Plan <b>2026</b>", tab: "Competitors", destination: "competitors", enabled: true, frequencyHours: 24,
    lastRunAt: "2026-10-03T09:00:00.000Z", lastStatus: "ok", lastErrorCode: null, lastError: null, lastWarning: null, nextRunAt: "2026-10-04T09:00:00.000Z",
    recent: { days: 7, imports: 2, added: 3, updated: 1, removed: 1 }, prompts: null,
    ...over,
  };
}
function sheets(over: Partial<LiveSheetsInsight> = {}): LiveSheetsInsight {
  return {
    kind: "sheets", state: "ready", message: null, generatedAt: GEN, labels: [], truncated: false, canManage: true, sheets: "ready", syncNowPerHour: 6,
    activePromptSet: { version: 3, label: "Synced from sheet 2026-10-02", approved: 9, prompts: 12 },
    syncs: [
      syncRow(),
      syncRow({ id: "isync_2", tab: "AI questions", destination: "geo_prompts", lastStatus: "error", lastErrorCode: "header_changed", lastError: HOSTILE, prompts: { inSet: 4, setFull: 1, archived: 2, approved: 3, lastAskedAt: "2026-10-02T08:00:00.000Z" } }),
    ],
    ...over,
  };
}
function budget(over: Partial<LiveBudgetInsight> = {}): LiveBudgetInsight {
  const line = (resource: LiveBudgetInsight["project"][number]["resource"], label: string, used: number, limit: number) => ({ resource, label, used, limit, counted: used > 0 });
  return {
    kind: "budget", state: "ready", message: null, generatedAt: GEN, labels: [], truncated: false, day: "2026-10-03",
    project: [line("usd_micros", "Priced spend", 120000, 500000), line("provider_calls", "Provider calls", 12, 60), line("jev_calls", "Jev calls", 60, 60)],
    global: [line("jev_calls", "Jev calls", 15, 2000)],
    manualRuns: { used: 1, limit: 3 },
    keys: [{ provider: "typesafe", label: "Jev (TypeSafe)", source: "operator_key" }, { provider: "gemini", label: "Gemini (GEO engine)", source: "workspace_key" }, { provider: "writer", label: "Writer", source: null }],
    notes: ["Spend on your workspace's own keys is bounded by these project limits only."],
    ...over,
  };
}
function dfsPanel(over: Partial<CompetitorDataPanel> = {}): CompetitorDataPanel {
  return {
    state: "ready", message: null, credentialSource: "workspace_key", canManage: true,
    location: { locationCode: 2840, locationName: "United States", languageCode: "en", languageName: "English" }, locationSource: "auto", autoFetch: true,
    caps: { refreshesPerDomainPerDay: 2, fetchesPerProjectPerDay: 10, fetchesToday: 3, keepSnapshotsPerDomain: 3 },
    pricing: { perTaskUsd: 0.01, perItemUsd: 0.0001, maxRefreshUsd: 0.0522, readOn: "2026-10-02", sourceUrl: "https://dataforseo.com/pricing" },
    limits: { topKeywords: 100, keywordGap: 100, topPages: 20 }, ownDomain: "shop.example",
    domains: [
      { competitorName: "Acme", domain: "acme.example", latestFetch: { id: "f1", status: "completed", trigger: "manual", createdAt: "2026-10-02T10:00:00.000Z", startedAt: null, finishedAt: "2026-10-02T10:01:00.000Z", costUsd: 0.0312, error: null }, snapshot: { fetchId: "f1", fetchedAt: "2026-10-02T10:01:00.000Z", location: { locationCode: 2840, locationName: "United States", languageCode: "en", languageName: "English" }, costUsd: 0.0312, overview: null, endpoints: [{ endpoint: "domain_intersection", status: "ok", fetchedAt: "2026-10-02T10:01:00.000Z", costUsd: 0.011, totalCount: 1284, itemCount: 100, error: null }] }, refreshesToday: 1 },
      { competitorName: "Bolt", domain: "bolt.example", latestFetch: null, snapshot: null, refreshesToday: 2 },
    ],
    ...over,
  };
}
function dfsDetail(): CompetitorDomainDetail {
  const s = dfsPanel().domains[0]!;
  return { ...s, ownDomain: "shop.example", topKeywords: [], topPages: [], keywordGap: [
    { keyword: "brass cabinet pulls", searchVolume: 880, competitorPosition: 4, competitorUrl: "https://acme.example/pulls", etv: 51.2, keywordDifficulty: 30, cpc: 1.2 },
    { keyword: HOSTILE, searchVolume: 1300, competitorPosition: 9, competitorUrl: null, etv: null, keywordDifficulty: null, cpc: null },
  ] };
}

// ------------------------------------------------------------------ SEO containers
describe("SEO 10 striking distance", () => {
  const props = { reduced: false, projectId: "p1", runId: "run1", replaying: false };
  it("data: measured rows with previous window, thresholds and the source caption; plain text", () => {
    const html = render(h(seo.StrikingPanel, { ...props, state: st(striking()) }));
    const t = text(html);
    expect(t).toContain("10 Striking-distance queries");
    expect(t).toContain("132 in reach");
    expect(t).toContain("query+page rows at positions 8–20");
    expect(t).toContain("From this run's Search Console sync (29 Sep) · 1–28 Sep vs 4–31 Aug");
    expect(t).toContain("1,340");
    expect(t).toContain("prev 1,290");
    expect(t).toContain("−3 vs prev");
    expect(t).toContain("prev 8.8");
    expect(t).toContain("Showing 2 of 132 rows");
    expect(html).toContain("&lt;script&gt;");
    expectHonest(html);
  });
  it("from another run's sync it says so; during a replay it is current state", () => {
    const t = text(render(h(seo.StrikingPanel, { ...props, runId: "run9", replaying: true, state: st(striking()) })));
    expect(t).toContain("From your latest Search Console sync (29 Sep), not part of this run");
    expect(t).toContain("Current state, not replayed");
  });
  it("setup and empty states never show zeros as data", () => {
    const setup = text(render(h(seo.StrikingPanel, { ...props, state: st(striking({ state: "setup_required", message: "No Search Console data is stored yet.", sync: null, rows: [], total: 0 })) })));
    expect(setup).toContain("Setup required");
    expect(setup).toContain("Connect Search Console in Integrations");
    expect(setup).not.toContain("in reach");
    const empty = text(render(h(seo.StrikingPanel, { ...props, state: st(striking({ rows: [], total: 0 })) })));
    expect(empty).toContain("No query+page row at positions 8–20");
    expect(text(render(h(seo.StrikingPanel, { ...props, state: st(null) })))).toContain("Loading striking-distance queries…");
  });
});

describe("SEO 11 pages gaining and losing clicks", () => {
  it("lists gainers and losers with measured differences, impressions and position; counts new and lost pages", () => {
    const html = render(h(seo.MoversPanel, { reduced: false, projectId: "p1", runId: "run1", replaying: false, state: st(movers()) }));
    const t = text(html);
    expect(t).toContain("11 Pages gaining and losing clicks");
    expect(t).toContain("7 pages compared");
    expect(t).toContain("2 new · 1 lost");
    expect(t).toContain("+17 clicks");
    expect(t).toContain("−6 clicks");
    expect(t).toContain("83 vs 66 clicks");
    expect(t).toContain("4,390 impr. · pos ≈ 5.6");
    expect(t).toContain("2 pages only in the current window · 1 only in the previous window");
    expect(t).toContain("lower bound");
    expectHonest(html);
  });
  it("setup state links to Integrations", () => {
    const t = text(render(h(seo.MoversPanel, { reduced: false, projectId: "p1", runId: null, replaying: false, state: st(movers({ state: "setup_required", message: "Connect Search Console.", sync: null, basis: null, gainers: [], losers: [], counts: { both: 0, unchanged: 0, newPages: 0, lostPages: 0 } })) })));
    expect(t).toContain("Setup required");
    expect(t).not.toContain("pages compared");
  });
});

describe("SEO 12 technical issues", () => {
  it("groups by severity and rule with counts, examples behind a disclosure, crawl date and pages read, a newer crawl note", () => {
    const html = render(h(seo.TechnicalPanel, { reduced: false, projectId: "p1", runId: "run1", replaying: false, state: st(technical()) }));
    const t = text(html);
    expect(t).toContain("12 Technical issues from the latest crawl");
    expect(t).toContain("4 findings");
    expect(t).toContain("on 38 pages read");
    expect(t).toContain("From your latest crawl (28 Sep), not part of this run · 38 pages read, 2 skipped");
    expect(t).toContain("A newer crawl is running");
    expect(t).toContain("Major 1");
    expect(t).toContain("Moderate 3");
    expect(t).toContain("SEO-TITLE-MISSING · fact");
    expect(html).toContain('aria-expanded="false"');
    expectHonest(html);
  });
  it("setup and no-crawl states", () => {
    const setup = text(render(h(seo.TechnicalPanel, { reduced: false, projectId: "p1", runId: null, replaying: false, state: st(technical({ state: "setup_required", message: "Verify site ownership first.", crawl: null, newer: null, groups: [], total: 0 })) })));
    expect(setup).toContain("Verify the site in Settings");
    const none = text(render(h(seo.TechnicalPanel, { reduced: false, projectId: "p1", runId: null, replaying: false, state: st(technical({ crawl: null, newer: null, groups: [], total: 0 })) })));
    expect(none).toContain("No completed crawl yet.");
  });
});

describe("SEO 13 competitor keyword gap", () => {
  const base = { reduced: false, projectId: "p1", demo: false, replaying: false, onDomain: () => {} };
  it("shows DataForSEO's own fields labelled as estimates with the fetch date, and a refresh button with a domain picker", () => {
    const html = render(h(ra.RunActionsProvider, { projectId: "p1", onStarted: () => {}, onReload: () => {} }, h(seo.CompetitorGapPanel, { ...base, panel: st(dfsPanel()), domain: "acme.example", detail: { data: dfsDetail(), error: null } })));
    const t = text(html);
    expect(t).toContain("13 Competitor keyword gap (DataForSEO)");
    expect(t).toContain("DataForSEO estimate, fetched 2 Oct · United States · English · cost $0.0312 · 1,284 gap keywords in DataForSEO's results");
    expect(t).toContain("From your latest DataForSEO refresh (2 Oct), not part of this run");
    expect(t.indexOf(HOSTILE)).toBeLessThan(t.indexOf("brass cabinet pulls"));
    expect(t).toContain("1,300");
    expect(html).toContain('data-action="competitor-refresh"');
    expect(html).toContain("Refresh competitor data");
    expect(html).toContain("&lt;script&gt;");
    expectHonest(html);
  });
  it("setup state without credentials links to Integrations; no competitors links to Settings", () => {
    const setup = text(render(h(seo.CompetitorGapPanel, { ...base, panel: st(dfsPanel({ state: "setup_required", message: "Add DataForSEO API credentials on the Integrations page." })), domain: null, detail: null })));
    expect(setup).toContain("Add DataForSEO credentials in Integrations");
    const none = text(render(h(seo.CompetitorGapPanel, { ...base, panel: st(dfsPanel({ domains: [] })), domain: null, detail: null })));
    expect(none).toContain("No competitor domain is tracked");
  });
  it("a domain without stored data says so", () => {
    const t = text(render(h(seo.CompetitorGapPanel, { ...base, panel: st(dfsPanel()), domain: "bolt.example", detail: null })));
    expect(t).toContain("No DataForSEO data stored for bolt.example yet.");
  });
});

// ------------------------------------------------------------------ GEO containers
describe("GEO 06 engine searches", () => {
  it("lists searches with engines, answers, last seen and an exact Search Console match only", () => {
    const html = render(h(geo.EngineQueriesPanel, { reduced: false, replaying: false, state: st(engineQueries()) }));
    const t = text(html);
    expect(t).toContain("06 What the AI engines searched for");
    expect(t).toContain("75 searches");
    expect(t).toContain("pos ≈ 12.3 · 340 impr.");
    expect(t).toContain("Search Console: exact matches, sync of 29 Sep (1–28 Sep)");
    expect(t).toContain("From your stored answers, 3 Sep–3 Oct (30 days), not only this run");
    expect(t).toContain("Showing 2 of 75 searches");
    expect(html).toContain("&lt;script&gt;");
    expectHonest(html);
    const empty = text(render(h(geo.EngineQueriesPanel, { reduced: false, replaying: false, state: st(engineQueries({ rows: [], total: 0, gscSync: null })) })));
    expect(empty).toContain("No engine searches stored in the last 30 days.");
    expect(empty).toContain("No Search Console sync: matches not checked");
  });
});

describe("GEO 07 brands", () => {
  it("you first, then each competitor, per engine as n of m answers (no share)", () => {
    const html = render(h(geo.BrandsPanel, { reduced: false, replaying: false, state: st(brands()) }));
    const t = text(html);
    expect(t).toContain("07 Brands in AI answers");
    expect(t).toContain("4 of 6 answers name you");
    expect(t).toContain("You · Shop");
    expect(t).toContain("2 of 4");
    expect(t).toContain("All engines");
    expect(html).toContain('scope="rowgroup"');
    expect(t).not.toMatch(/\d%/);
    expect(html).toContain("&lt;script&gt;");
    expectHonest(html);
    expect(text(render(h(geo.BrandsPanel, { reduced: false, replaying: false, state: st(brands({ brands: [], engines: [] })) })))).toContain("No analysed answers to discovery prompts");
  });
});

describe("GEO 08 most-cited domains", () => {
  it("ranks hosts by answers (n of m), tags competitors, highlights your site and keeps it when below the cut", () => {
    const html = render(h(geo.CitedDomainsPanel, { reduced: false, replaying: false, state: st(citedDomains()) }));
    const t = text(html);
    expect(t).toContain("08 Most-cited domains, last 30 days");
    expect(t).toContain("40 domains cited");
    expect(t).toContain("3 of 12");
    expect(t).toContain("Competitor: Acme");
    expect(t).toContain("Your site");
    expect(t).toContain("31 shop.example");
    expect(t).toContain("2 citations were provider redirect links without a domain title");
    expectHonest(html);
  });
});

describe("GEO 09 prompt history", () => {
  it("cells carry letter + colour and a full accessible name per engine; legend words", () => {
    const html = render(h(geo.PromptHistoryPanel, { reduced: false, projectId: "p1", replaying: false, state: st(history()) }));
    const t = text(html);
    expect(t).toContain("09 Prompt history");
    expect(t).toContain("2 approved prompts");
    expect(html).toContain('aria-label="Gemini, last 3 runs: 29 Sep cited, 30 Sep mentioned, site not cited, 1 Oct absent. Prompt: Best brass knobs?"');
    expect(html).toMatch(/aria-label="Gemini, last 3 runs: 29 Sep no answer \(call failed\), 30 Sep stored, not analysed, 1 Oct no answer stored\. Prompt: &lt;script&gt;/);
    expect(t).toContain("prompt set v3, Synced from sheet 2026-10-02");
    expectHonest(html);
    const setup = text(render(h(geo.PromptHistoryPanel, { reduced: false, projectId: "p1", replaying: false, state: st(history({ state: "setup_required", message: "No prompt set yet.", promptSet: null, engines: [], rows: [] })) })));
    expect(setup).toContain("Approve prompts");
    const noRuns = text(render(h(geo.PromptHistoryPanel, { reduced: false, projectId: "p1", replaying: false, state: st(history({ engines: [] })) })));
    expect(noRuns).toContain("No stored answers yet");
  });
});

// ------------------------------------------------------------------ shared containers
describe("SEO 14 / GEO 10 sheet syncs", () => {
  const wrap = (el: ReactElement) => render(h(ra.RunActionsProvider, { projectId: "p1", onStarted: () => {}, onReload: () => {} }, el));
  it("SEO: every synced tab with status, last and next run, recent changes and a per-row Sync now", () => {
    const html = wrap(h(shared.SheetsPanel, { state: st(sheets()), mode: "seo", reduced: false, projectId: "p1", demo: false, replaying: false }));
    const t = text(html);
    expect(t).toContain("14 Master sheet sync");
    expect(t).toContain("2 synced tabs");
    expect(t).toContain("1 with an error");
    expect(t).toContain("Plan <b>2026</b> → Competitors");
    expect(t).toContain("+3 · ~1 · −1 in 7 days (2 sync imports)");
    expect(t).toContain("Error: header changed");
    expect(html).toContain('data-action="sync:isync_1"');
    expect(html).toContain('data-action="sync:isync_2"');
    expect(html).toContain("&lt;script&gt;");
    expectHonest(html);
  });
  it("GEO: only the AI-question tabs, with what they feed in the prompt set", () => {
    const t = text(wrap(h(shared.SheetsPanel, { state: st(sheets()), mode: "geo", reduced: false, projectId: "p1", demo: false, replaying: false })));
    expect(t).toContain("10 AI questions from your sheet");
    expect(t).toContain("3 approved questions");
    expect(t).not.toContain("Plan <b>2026</b> → Competitors");
    expect(t).toContain("4 questions in the active set (3 approved) · 1 not added (set full) · 2 archived · last asked 2 Oct");
    expect(t).toContain("Feeds prompt set v3");
  });
  it("empty state links to the Import page; demo disables Sync now", () => {
    const empty = wrap(h(shared.SheetsPanel, { state: st(sheets({ syncs: [] })), mode: "seo", reduced: false, projectId: "p1", demo: false, replaying: false }));
    expect(text(empty)).toContain("No sheet tab is kept in sync.");
    expect(empty).toContain('href="/projects/p1/import"');
    const demo = wrap(h(shared.SheetsPanel, { state: st(sheets()), mode: "seo", reduced: false, projectId: "p1", demo: true, replaying: false }));
    expect(demo).toMatch(/data-action="sync:isync_1"[^>]*aria-disabled="true"/);
  });
});

describe("SEO 15 / GEO 11 budget and quotas", () => {
  it("meters of today's counters (n of cap), manual runs of 3, operator allowance and key sources; no run button", () => {
    const html = render(h(shared.BudgetPanel, { state: st(budget()), mode: "seo", reduced: false, replaying: false }));
    const t = text(html);
    expect(t).toContain("15 Budget and quotas today");
    expect(t).toContain("$0.12");
    expect(t).toContain("of $0.50");
    expect(t).toContain("Manual runs: 1 of 3 used today");
    expect(t).toContain("12 of 60");
    expect(t).toContain("Operator's global allowance");
    expect(t).toContain("Jev (TypeSafe): operator key");
    expect(t).toContain("Gemini (GEO engine): your key");
    expect(t).toContain("Writer: not set up");
    expect(html).toContain('role="meter"');
    expect(html).not.toContain("data-action=");
    expectHonest(html);
    expect(text(render(h(shared.BudgetPanel, { state: st(budget()), mode: "geo", reduced: false, replaying: false })))).toContain("11 Budget and quotas today");
    expect(text(render(h(shared.BudgetPanel, { state: st(budget({ global: [] })), mode: "geo", reduced: false, replaying: false })))).not.toContain("Operator's global allowance");
  });
});

// ------------------------------------------------------------------ lazy mount, menu, boards
describe("lazy mount", () => {
  it("mounts at once without IntersectionObserver; otherwise renders a quiet placeholder with the heading", () => {
    const def = SEO_CONTAINERS.find((c) => c.key === "striking")!;
    expect(render(h(common.LazyMount, { def, reduced: false }, h("p", null, "mounted")))).toContain("mounted");
    const g = globalThis as { IntersectionObserver?: unknown };
    g.IntersectionObserver = class {};
    try {
      const html = render(h(common.LazyMount, { def, reduced: false }, h("p", null, "mounted")));
      expect(html).not.toContain("mounted");
      expect(text(html)).toContain("10 Striking-distance queries");
      expect(text(html)).toContain("Loads when it scrolls into view.");
      expect(html).not.toContain("lv-shimmer");
    } finally {
      delete g.IntersectionObserver;
    }
  });
});

describe("Containers menu", () => {
  it("is a keyboard menu button of checkbox items per container of the mode, all on by default", () => {
    const closed = render(h(ContainersMenu, { defs: SEO_CONTAINERS, hidden: NONE, onToggle: () => {}, onShowAll: () => {} }));
    expect(closed).toContain('aria-haspopup="menu"');
    expect(closed).toContain('aria-expanded="false"');
    expect(text(closed)).toContain("Containers");
    const open = render(h(ContainersMenu, { defs: GEO_CONTAINERS, hidden: new Set(["brands"]), onToggle: () => {}, onShowAll: () => {}, defaultOpen: true }));
    expect(open).toContain('role="menu"');
    expect((open.match(/role="menuitemcheckbox"/g) ?? []).length).toBe(GEO_CONTAINERS.length);
    expect(open).toMatch(/aria-checked="false"[^>]*data-container="brands"/);
    expect((open.match(/aria-checked="true"/g) ?? []).length).toBe(GEO_CONTAINERS.length - 1);
    expect(text(open)).toContain("1 hidden");
    expect(text(open)).toContain("Show all");
  });
  it("stores per mode, known keys only; broken or blocked storage means everything shown", () => {
    expect(hiddenStorageKey("seo")).toBe("okara.live.hidden.seo");
    expect([...parseHidden('["budget","nope","striking","budget"]', "seo")]).toEqual(["budget", "striking"]);
    expect(parseHidden("{bad json", "seo").size).toBe(0);
    expect(parseHidden('{"a":1}', "geo").size).toBe(0);
    expect(serializeHidden(new Set(["budget", "pages"]), "seo")).toBe('["pages","budget"]');
    expect([...toggleHidden(new Set(["a"]), "a")]).toEqual([]);
    expect([...toggleHidden(new Set(), "lanes")]).toEqual(["lanes"]);
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    writeHidden(storage, "geo", new Set(["lanes", "brands"]));
    expect(mem.get("okara.live.hidden.geo")).toBe('["lanes","brands"]');
    expect([...readHidden(storage, "geo")]).toEqual(["lanes", "brands"]);
    const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
    expect(readHidden(throwing, "seo").size).toBe(0);
    expect(() => writeHidden(throwing, "seo", new Set(["pages"]))).not.toThrow();
    expect(readHidden(null, "seo").size).toBe(0);
  });
  it("numbers continue the existing panels: SEO 10-15 and GEO 06-11", () => {
    expect(SEO_CONTAINERS.filter((c) => c.more).map((c) => `${c.num} ${c.title}`)).toEqual([
      "10 Striking-distance queries",
      "11 Pages gaining and losing clicks",
      "12 Technical issues from the latest crawl",
      "13 Competitor keyword gap (DataForSEO)",
      "14 Master sheet sync",
      "15 Budget and quotas today",
    ]);
    expect(GEO_CONTAINERS.filter((c) => c.more).map((c) => `${c.num} ${c.title}`)).toEqual([
      "06 What the AI engines searched for",
      "07 Brands in AI answers",
      "08 Most-cited domains, last 30 days",
      "09 Prompt history",
      "10 AI questions from your sheet",
      "11 Budget and quotas today",
      "12 Question queries from Search Console", // [A37]
    ]);
  });
});

function env(over: Partial<ActionEnv> = {}): ActionEnv {
  return {
    projectId: "p1", demo: false, verifiedHost: "shop.example", gscProperty: "sc-domain:shop.example", running: { seo: false, geo: false }, manualToday: 0,
    engines: [{ provider: "gemini", name: "Gemini", ready: true, detail: null }], promptCount: 4, buyer: { state: "ready", labels: [] }, links: { state: "ready", labels: [] },
    path: (sub) => `/projects/p1/${sub}`,
    ...over,
  };
}
const seoBoardProps = () => {
  const a = activity();
  const feed = seoFeed();
  return {
    projectId: "p1", runId: "run1", ownHost: "shop.example", verified: true, activity: a,
    revealed: buildTimeline(a.items, { elements: feed.elements, queries: feed.queries, recommendations: feed.recommendations }), upcoming: [], replaying: false, atEnd: true, mode: "finished", fresh: NONE, reduced: false, seo: feed, feedError: null,
    data: {
      overview: st(overview()), buyer: st({ state: "ready", generatedAt: at(0), rows: [], completeness: null, labels: [] }), links: st(linkReport()), competitors: st([assessment()]),
      coverage: st({ state: "ready", generatedAt: at(0), rows: [coverageRow()], completeness: null, labels: [] }), evidence: st({ state: "ready", generatedAt: at(0), rows: [evidenceRow()], completeness: null, labels: [] }),
    },
  };
};
const moreValue = (hidden: string[]) => ({ runId: "run1", demo: false, replaying: false, keys: { gsc: "", crawl: "", batch: "", budget: "" }, reloads: { sheets: 0, gap: 0 }, hidden: new Set(hidden) });

describe("boards", () => {
  it("SEO board renders 01-15 with the new containers' run buttons, and leaves hidden ones out", () => {
    const actions = { ...moreSeoActions(env()) };
    const html = render(h(ra.RunActionsProvider, { projectId: "p1", onStarted: () => {}, onReload: () => {} }, h(ra.PanelActionsContext.Provider, { value: actions }, h(SeoBoard, seoBoardProps()))));
    for (const k of ["striking", "movers", "technical", "competitor-gap", "sheets", "budget"]) expect(html, k).toContain(`data-panel="${k}"`);
    expect(html).toContain('data-action="gsc_sync-striking"');
    expect(html).toContain('data-action="gsc_sync-movers"');
    expect(html).toContain('data-action="crawl-technical"');
    const hidden = render(h(moreData.LiveMoreContext.Provider, { value: moreValue(["striking", "budget", "pages"]) }, h(SeoBoard, seoBoardProps())));
    expect(hidden).not.toContain('data-panel="striking"');
    expect(hidden).not.toContain('data-panel="budget"');
    expect(hidden).not.toContain('data-panel="pages"');
    expect(hidden).toContain('data-panel="movers"');
    const all = render(h(moreData.LiveMoreContext.Provider, { value: moreValue(SEO_CONTAINERS.map((c) => c.key)) }, h(SeoBoard, seoBoardProps())));
    expect(text(all)).toContain("Every container is hidden.");
  });
  it("GEO board renders 06-11 after 01-05 and can hide the engine columns", () => {
    const feed = geoFeed();
    const a = activity({ run: run({ agent: "geo" }), lanes: [{ provider: "gemini", label: "Gemini API · google_search", state: "done", done: 2, planned: 3, lastLatencyMs: 377 }], items: [] });
    const props = {
      projectId: "p1", ownHost: "shop.example", demo: false, activity: a, revealed: buildTimeline(a.items, { answers: feed.answers, recommendations: [] }), upcoming: [], replaying: false, atEnd: true, mode: "finished", fresh: NONE, reduced: false,
      geo: { answers: feed.answers, plannedPrompts: feed.plannedPrompts, recommendations: [], totals: feed.totals, labels: feed.labels }, feedError: null,
      data: {
        board: st({ state: "ready", promptSetVersion: 1, generatedAt: at(0), lanes: [], labels: [] }), competitors: st([assessment()]),
        plans: st({ state: "ready", generatedAt: at(0), plans: [plan()], labels: [] }), coverage: st({ state: "ready", generatedAt: at(0), rows: [coverageRow()], completeness: null, labels: [] }),
      },
    };
    const html = render(h(ra.PanelActionsContext.Provider, { value: moreGeoActions(env()) }, h(GeoBoard, props)));
    const order = ["heatmap", "recs", "engine-queries", "brands", "cited-domains", "prompt-history", "sheet-prompts", "budget", "gsc-questions"].map((k) => html.indexOf(`data-panel="${k}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual(order.slice().sort((x, y) => x - y));
    expect(html).toContain('data-action="geo-batch-queries"');
    expect(html).toContain('data-action="geo-batch-history"');
    expect(text(html)).toContain("Gemini API");
    const noLanes = render(h(moreData.LiveMoreContext.Provider, { value: moreValue(["lanes"]) }, h(GeoBoard, props)));
    expect(noLanes).not.toContain("Answers from Gemini");
    expect(noLanes).toContain('data-panel="heatmap"');
  });
});

// ------------------------------------------------------------------ run buttons of the new containers
describe("run buttons (section 17 mapping)", () => {
  const runOf = (a: SectionAction | undefined) => (a && a.kind === "run" ? a : null);
  it("SEO 10/11 run the Search Console sync, 12 the crawl, with the section 16 reasons", () => {
    const m = moreSeoActions(env());
    expect(Object.keys(m).sort()).toEqual(["movers", "striking", "technical"]);
    expect(runOf(m.striking)?.runs).toEqual([{ agent: "seo", steps: ["gsc_sync"] }]);
    expect(runOf(m.movers)?.runs).toEqual([{ agent: "seo", steps: ["gsc_sync"] }]);
    expect(runOf(m.technical)?.runs).toEqual([{ agent: "seo", steps: ["crawl"] }]);
    expect(m.striking!.label).toBe("Run Search Console sync");
    expect(m.technical!.label).toBe("Run crawl");
    expect(moreSeoActions(env({ demo: true })).striking!.disabled).toBe(DEMO_REASON);
    expect(moreSeoActions(env({ manualToday: 3 })).technical!.disabled).toBe(QUOTA_REASON);
    expect(moreSeoActions(env({ gscProperty: null })).movers!.disabled).toMatch(/Connect Search Console/);
    expect(moreSeoActions(env({ running: { seo: true, geo: false } })).striking!.busyLabel).toBe("Running…");
  });
  it("GEO 06-09 ask every configured engine; 10 and 11 have no header button", () => {
    const m = moreGeoActions(env());
    expect(Object.keys(m).sort()).toEqual(["brands", "cited-domains", "engine-queries", "prompt-history"]);
    for (const a of Object.values(m)) {
      expect(runOf(a)?.runs).toEqual([{ agent: "geo", steps: ["batch"] }]);
      expect(a.label).toBe("Ask AI engines");
      expect(runOf(a)!.confirm.lines[1]).toContain("uses your daily GEO budget");
    }
    expect(m["sheet-prompts"]).toBeUndefined();
    expect(m.budget).toBeUndefined();
    expect(moreGeoActions(env({ engines: [{ provider: "gemini", name: "Gemini", ready: false, detail: null }] })).brands!.disabled).toMatch(/No AI engine is set up/);
  });
  it("SEO 13 refresh: paid call with a domain picker, cost from the published-price ceiling, caps and account; honest reasons", () => {
    expect(competitorRefreshAction({ projectId: "p1", demo: false }, null)).toBeNull();
    const a = competitorRefreshAction({ projectId: "p1", demo: false }, dfsPanel())!;
    expect(a).toMatchObject({ kind: "call", key: "competitor-refresh", label: "Refresh competitor data", path: "/projects/p1/competitors/dataforseo/refresh", reload: "competitor-gap", disabled: null });
    if (a.kind !== "call") throw new Error("call");
    expect(a.choice!.field).toBe("domain");
    expect(a.choice!.options.map((o) => [o.value, o.disabled])).toEqual([
      ["acme.example", null],
      ["bolt.example", "Daily limit reached (2 refreshes per domain per UTC day)."],
    ]);
    const lines = a.confirm.lines.join(" ");
    expect(lines).toContain("Paid call");
    expect(lines).toContain("at most $0.0522 at DataForSEO's published price");
    expect(lines).toContain("2 refreshes per domain and 10 per project per UTC day (3 used today)");
    expect(lines).toContain("Uses your workspace's DataForSEO account.");
    expect(lines).toContain("no manual run is used");
    const op = competitorRefreshAction({ projectId: "p1", demo: false }, dfsPanel({ credentialSource: "operator_key" }))!;
    if (op.kind !== "call") throw new Error("call");
    expect(op.confirm.lines.join(" ")).toContain("operator's global daily allowance");
    expect(competitorRefreshAction({ projectId: "p1", demo: true }, dfsPanel())!.disabled).toBe(DEMO_REASON);
    expect(competitorRefreshAction({ projectId: "p1", demo: false }, dfsPanel({ canManage: false }))!.disabled).toBe(OWNER_REASON_DFS);
    expect(competitorRefreshAction({ projectId: "p1", demo: false }, dfsPanel({ state: "setup_required", message: "Add DataForSEO API credentials." }))!.disabled).toBe("Add DataForSEO API credentials.");
    expect(competitorRefreshAction({ projectId: "p1", demo: false }, dfsPanel({ caps: { ...dfsPanel().caps, fetchesToday: 10 } }))!.disabled).toBe("Project limit reached (10 refreshes per UTC day).");
  });
  it("SEO 14 / GEO 10 Sync now: owner-only call with the sync outcome checked; demo, member and connection reasons", () => {
    const opts = { canManage: true, sheets: "ready", perHour: 6 };
    const a = sheetSyncAction({ projectId: "p1", demo: false }, syncRow(), opts);
    expect(a).toMatchObject({ kind: "call", key: "sync:isync_1", label: "Sync now", path: "/projects/p1/import/syncs/isync_1/run", reload: "sheets", expect: "sync_outcome", disabled: null });
    if (a.kind !== "call") throw new Error("call");
    expect(a.confirm.title).toBe('Sync tab "Competitors" now?');
    expect(a.confirm.lines.join(" ")).toContain("queues a paid DataForSEO refresh within its daily caps");
    expect(a.confirm.lines.join(" ")).toContain("at most 6 per tab per hour");
    const q = sheetSyncAction({ projectId: "p1", demo: false }, syncRow({ destination: "geo_prompts" }), opts);
    if (q.kind !== "call") throw new Error("call");
    expect(q.confirm.lines.join(" ")).toContain("pending your approval");
    expect(sheetSyncAction({ projectId: "p1", demo: true }, syncRow(), opts).disabled).toBe(DEMO_REASON);
    expect(sheetSyncAction({ projectId: "p1", demo: false }, syncRow(), { ...opts, canManage: false }).disabled).toBe(OWNER_REASON_SYNC);
    expect(sheetSyncAction({ projectId: "p1", demo: false }, syncRow(), { ...opts, sheets: "setup_required" }).disabled).toMatch(/Connect Google Sheets/);
    expect(sheetSyncAction({ projectId: "p1", demo: false }, syncRow(), { ...opts, sheets: "error" }).disabled).toMatch(/Reconnect Google Sheets/);
  });
  it("a sync that answered with an error outcome is shown as an error", () => {
    expect(ra.syncFailure({ outcome: { status: "ok", message: null } })).toBeNull();
    expect(ra.syncFailure({ outcome: { status: "error", message: "Tab gone" } })).toBe("Sync failed: Tab gone");
    expect(ra.syncFailure({ outcome: { status: "busy", message: "A sync of this tab is already running." } })).toBe("A sync of this tab is already running.");
    expect(ra.syncFailure(null)).toBeNull();
  });
  it("the confirm dialog asks for the domain (disabled options say why) and starts with the first available one", () => {
    const a = competitorRefreshAction({ projectId: "p1", demo: false }, dfsPanel())!;
    const html = render(h(ra.ConfirmDialog, { action: a, busy: false, error: null, onCancel: () => {}, onConfirm: () => {} }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Competitor domain to refresh");
    expect(html).toMatch(/<input type="radio"(?=[^>]*value="acme.example")(?=[^>]*checked="")[^>]*>/);
    expect(html).toMatch(/<input type="radio"(?=[^>]*value="bolt.example")(?=[^>]*disabled="")[^>]*>/);
    expect(text(html)).toContain("Daily limit reached (2 refreshes per domain per UTC day).");
    expect(text(html)).toContain("Acme · 1 of 2 refreshes today");
  });
});

describe("labels", () => {
  it("n of m, measured differences, spend, Search Console match and captions", () => {
    expect(nOfM(3, 12)).toBe("3 of 12");
    expect(signed(4)).toBe("+4");
    expect(signed(-3)).toBe("−3");
    expect(signed(0)).toBe("0");
    expect(signed(1.26, 1)).toBe("+1.3");
    expect(usdMicros(120000)).toBe("$0.12");
    expect(usdMicros(1200)).toBe("$0.0012");
    expect(gscMatchText({ clicks: 1, impressions: 340, position: 12.34, window: SYNC.current, basis: "query_page_rows" })).toBe("pos ≈ 12.3 · 340 impr.");
    expect(gscMatchText({ clicks: 1, impressions: 340, position: 12.34, window: SYNC.current, basis: "query_rows" })).toBe("pos 12.3 · 340 impr.");
    expect(gscMatchText({ clicks: 0, impressions: 0, position: null, window: SYNC.current, basis: "query_rows" })).toBe("pos — · 0 impr.");
    expect(sourceCaption("crawl", "2026-09-28T10:00:00.000Z", "r1", "r1")).toBe("From this run's crawl (28 Sep)");
    expect(sourceCaption("crawl", "2026-09-28T10:00:00.000Z", "r0", "r1")).toBe("From your latest crawl (28 Sep), not part of this run");
    expect(syncState({ enabled: false, lastStatus: "ok", lastErrorCode: null })).toEqual({ label: "Paused (last sync OK)", tone: "none" });
    expect(syncState({ enabled: true, lastStatus: "error", lastErrorCode: "tab_missing" })).toEqual({ label: "Error: tab missing", tone: "change" });
    expect(syncState({ enabled: true, lastStatus: "never", lastErrorCode: null }).label).toBe("Not synced yet");
    expect(recentText({ days: 7, imports: 0, added: 0, updated: 0, removed: 0 })).toBe("No changes in 7 days");
    expect(historyLabel("Gemini", [], [])).toBe("Gemini: no runs with stored answers");
  });
});
