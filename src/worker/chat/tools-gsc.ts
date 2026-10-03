/**
 * Ask Okara Search Console tools (first-party, measured data). Stored-sync tools read only this project's rows of
 * the latest usable gsc_syncs row (workspace_id + project_id + sync_id on every query) and always return the
 * windows and "stored sync of <date>". `search_console_live_query` is the one live call: Google's
 * searchanalytics.query for the project's own connected property (never a property the model names), read-only and
 * free, bounded by a row cap, a 16-month lookback, a per-user and a per-project rate limit, and Google's quota
 * guidance (https://developers.google.com/webmaster-tools/limits, read 2026-10-03: 1,200 QPM per site and per user;
 * page/query grouping and long ranges are the expensive queries; on a load-quota error wait 15 minutes).
 * Query strings and URLs in results are third-party text: clipped data, never instructions.
 */
import { z } from "zod";
import { BRAND_METHOD_VERSION } from "../seo/gsc/brand";
import { brandSplitOf } from "../seo/gsc/brand";
import { excludeIncompleteDays, parseTotalsJson, toWindowTotals } from "../seo/gsc/aggregate";
import { hasStrongIntentModifier, isEnglish, normalizeDemandQuery, STRONG_INTENT_VERSION } from "../seo/gsc/demand";
import { latestUsableSync, projectBrandClassifier, type SyncRow } from "../seo/gsc/overview";
import { createGscProvider, GscApiError } from "../platform/gsc-client";
import { hitRateLimit } from "../platform/rate-limit";
import type { GscFilterDimension, GscFilterOperator, GscQueryRequest } from "../providers/types";
import { createApiFetch } from "../runs/runtime";
import { createCallRecorder } from "../runs/calls";
import { utcDay } from "../lib/time";
import { buildBuyerQueries, buyerQueryCap } from "../seo/recommend/buyer-queries";
import { buildDecisionsForWorkspace } from "../redirects/decisions";
import { createBudget } from "../runs/budget";
import { ToolError, clip, ctrOf, pct, projectRoute, ratioValue, round1, scoped, type ReadTool, type ToolContext } from "./tool-base";

// ------------------------------------------------------------------ limits
/** Rows returned by one live query (Google allows up to 25,000; chat answers need far fewer). */
export const GSC_LIVE_MAX_ROWS = 1000;
export const GSC_LIVE_DEFAULT_ROWS = 100;
/** Search Console keeps 16 months of data. */
export const GSC_LIVE_MAX_MONTHS = 16;
/** Live queries per user per 10 minutes, and per project per UTC day (engineering defaults, well under Google's quotas). */
export const GSC_LIVE_USER_LIMIT = { limit: 10, windowSeconds: 600 } as const;
export const GSC_LIVE_PROJECT_LIMIT = { limit: 100, windowSeconds: 86_400 } as const;
export const GSC_LIVE_PROVIDER = "google_search_console";
/** Search Console API calls are not billed; recorded at a known cost of 0 for the usage log. */
export const GSC_LIVE_RATE_VERSION = "gsc-api-no-charge-2026-10-03";
/** Rows of the stored sync read by the compare tool (bounded by the project's gsc_rows cap anyway). */
const COMPARE_MAX_KEYS = 20_000;

const FIRST_PARTY = "Google Search Console (first-party, measured)";

/** "Google Search Console (first-party, measured), stored sync of 2026-09-30 (API)". */
export function storedSyncLabel(sync: Pick<SyncRow, "synced_at" | "source">): string {
  const src = sync.source === "csv_import" ? "CSV import" : sync.source === "demo" ? "demo data" : "API";
  return `${FIRST_PARTY}, stored sync of ${sync.synced_at.slice(0, 10)} (${src})`;
}

const NO_DATA = {
  state: "no_data" as const,
  message: "No Search Console data is stored for this project yet (connect Search Console on Integrations or import a CSV, then run the SEO agent).",
};

const windowsOf = (s: SyncRow) => ({ currentWindow: `${s.window_start}..${s.window_end}`, previousWindow: `${s.prev_window_start}..${s.prev_window_end}` });

// ------------------------------------------------------------------ trend
const trendSchema = z.object({});

const searchConsoleTrend: ReadTool<typeof trendSchema> = {
  name: "search_console_trend",
  kind: "read",
  description:
    "Daily Search Console clicks, impressions and CTR for the current 28-day window of the latest STORED sync, plus Google's property totals (clicks, impressions, CTR, average position) for the current and previous window. Daily position is not stored: use search_console_live_query with dimensions [\"date\"] for daily position or other ranges.",
  schema: trendSchema,
  async run(ctx) {
    const [ws, pid] = scoped(ctx);
    const sync = await latestUsableSync(ctx.db, ws, pid);
    if (!sync) return { data: NO_DATA, summary: "No Search Console data stored" };
    const daily = await ctx.db.all<{ date: string; clicks: number; impressions: number }>(
      "SELECT date, clicks, impressions FROM gsc_daily WHERE workspace_id = ? AND project_id = ? AND sync_id = ? ORDER BY date",
      ws,
      pid,
      sync.id,
    );
    const days = excludeIncompleteDays(daily, { start: sync.window_start, end: sync.window_end });
    const totals = parseTotalsJson(sync.totals_json);
    const t = (w: "current" | "previous") => {
      const x = toWindowTotals(totals[w]);
      return x ? { clicks: x.clicks, impressions: x.impressions, ctr: ratioValue(x.ctr), averagePosition: round1(x.position) } : null;
    };
    const cur = t("current");
    const prev = t("previous");
    const data = {
      state: "ready" as const,
      dataSource: storedSyncLabel(sync),
      ...windowsOf(sync),
      totals: {
        current: cur,
        previous: prev,
        clickChangePct: cur && prev ? pct(cur.clicks, prev.clicks) : null,
        impressionChangePct: cur && prev ? pct(cur.impressions, prev.impressions) : null,
        basis: "Google's own property aggregate for each window (includes anonymized queries).",
      },
      daily: days.map((d) => ({ date: d.date, clicks: d.clicks, impressions: d.impressions, ctr: ctrOf(d.clicks, d.impressions) })),
      dailyNote:
        days.length === 0
          ? "No daily series stored for this sync (CSV imports may not include one)."
          : "Daily rows cover the current window only; daily average position is not stored (ask search_console_live_query with dimensions [\"date\"]).",
    };
    return { data, summary: `${days.length} day(s) · ${data.currentWindow} · stored sync of ${sync.synced_at.slice(0, 10)}` };
  },
};

// ------------------------------------------------------------------ compare (lost / gained)
const compareSchema = z.object({
  dimension: z.enum(["query", "page"]).optional().describe("Compare per search query (default) or per page URL."),
  metric: z.enum(["clicks", "impressions"]).optional().describe("Metric to compare (default clicks)."),
  segment: z.enum(["all", "brand", "non_brand"]).optional().describe("Queries only: restrict to brand or non-brand queries (project brand name/aliases)."),
  contains: z.string().trim().min(1).max(100).optional().describe("Only rows whose query or URL contains this text (case-insensitive)."),
  limit: z.number().int().min(1).max(25).optional().describe("Rows per bucket (1-25, default 10)."),
});

interface KeyAgg {
  key: string;
  c_clicks: number;
  c_impr: number;
  p_clicks: number;
  p_impr: number;
  c_posw: number;
  p_posw: number;
}

async function aggregateByKey(ctx: ToolContext, sync: SyncRow, dimension: "query" | "page", contains: string | undefined): Promise<{ rows: KeyAgg[]; basis: string }> {
  const [ws, pid] = scoped(ctx);
  let where = "workspace_id = ? AND project_id = ? AND sync_id = ?";
  let basis: string;
  if (dimension === "query") {
    where += " AND query IS NOT NULL";
    basis = "Query rows (summed from query+page rows; Google omits anonymized queries, so sums are lower bounds).";
  } else {
    const hasPageSlice = await ctx.db.first<{ n: number }>(
      "SELECT 1 AS n FROM gsc_metrics WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND page IS NOT NULL AND query IS NULL LIMIT 1",
      ws,
      pid,
      sync.id,
    );
    where += hasPageSlice ? " AND page IS NOT NULL AND query IS NULL" : " AND page IS NOT NULL";
    basis = hasPageSlice ? "Page-dimension rows (include anonymized-query traffic)." : "Summed query+page rows (no page-dimension slice stored): lower bounds.";
  }
  const params: unknown[] = [ws, pid, sync.id];
  if (contains) {
    where += ` AND instr(lower(${dimension}), ?) > 0`;
    params.push(contains.toLowerCase());
  }
  const rows = await ctx.db.all<KeyAgg>(
    `SELECT ${dimension} AS key,
            SUM(CASE WHEN window = 'current' THEN clicks ELSE 0 END) AS c_clicks,
            SUM(CASE WHEN window = 'current' THEN impressions ELSE 0 END) AS c_impr,
            SUM(CASE WHEN window = 'previous' THEN clicks ELSE 0 END) AS p_clicks,
            SUM(CASE WHEN window = 'previous' THEN impressions ELSE 0 END) AS p_impr,
            SUM(CASE WHEN window = 'current' THEN position * impressions ELSE 0 END) AS c_posw,
            SUM(CASE WHEN window = 'previous' THEN position * impressions ELSE 0 END) AS p_posw
       FROM gsc_metrics WHERE ${where} GROUP BY ${dimension} LIMIT ?`,
    ...params,
    COMPARE_MAX_KEYS,
  );
  return { rows, basis };
}

const searchConsoleCompare: ReadTool<typeof compareSchema> = {
  name: "search_console_compare",
  kind: "read",
  description:
    "Compare the current 28-day window with the previous 28 days from the latest STORED Search Console sync, per query or page: which LOST all clicks/impressions, DECLINED, GAINED (new) or IMPROVED, with deltas and bucket totals. Optional brand/non-brand filter for queries. For custom windows (e.g. calendar months) call search_console_live_query once per window.",
  schema: compareSchema,
  async run(ctx, input) {
    const [ws, pid] = scoped(ctx);
    const sync = await latestUsableSync(ctx.db, ws, pid);
    if (!sync) return { data: NO_DATA, summary: "No Search Console data stored" };
    const dimension = input.dimension ?? "query";
    const metric = input.metric ?? "clicks";
    const segment = dimension === "query" ? (input.segment ?? "all") : "all";
    const limit = input.limit ?? 10;
    const agg = await aggregateByKey(ctx, sync, dimension, input.contains);
    let rows = agg.rows;
    let segmentNote: string | null = null;
    if (segment !== "all") {
      const classifier = await projectBrandClassifier(ctx.db, ctx.project);
      if (classifier.terms.self.length === 0) throw new ToolError("This project has no usable brand name or aliases, so queries cannot be split into brand and non-brand.");
      rows = rows.filter((r) => classifier.isSelfBrand(r.key) === (segment === "brand"));
      segmentNote = `Brand = query contains the project brand name or an alias as whole words (${BRAND_METHOD_VERSION}).`;
    }
    const cur = (r: KeyAgg) => (metric === "clicks" ? r.c_clicks : r.c_impr);
    const prev = (r: KeyAgg) => (metric === "clicks" ? r.p_clicks : r.p_impr);
    const buckets = { lost: [] as KeyAgg[], declined: [] as KeyAgg[], gained: [] as KeyAgg[], improved: [] as KeyAgg[] };
    for (const r of rows) {
      const c = cur(r);
      const p = prev(r);
      if (p > 0 && c === 0) buckets.lost.push(r);
      else if (p > c) buckets.declined.push(r);
      else if (p === 0 && c > 0) buckets.gained.push(r);
      else if (c > p) buckets.improved.push(r);
    }
    const shape = (r: KeyAgg) => ({
      [dimension]: clip(r.key, 400),
      [metric]: cur(r),
      [`previous${metric === "clicks" ? "Clicks" : "Impressions"}`]: prev(r),
      change: cur(r) - prev(r),
      changePct: pct(cur(r), prev(r)),
      ...(metric === "clicks" ? { impressions: r.c_impr, previousImpressions: r.p_impr } : { clicks: r.c_clicks, previousClicks: r.p_clicks }),
      approxPosition: r.c_impr > 0 ? round1(r.c_posw / r.c_impr) : null,
      previousApproxPosition: r.p_impr > 0 ? round1(r.p_posw / r.p_impr) : null,
    });
    const summarize = (list: KeyAgg[]) => {
      const sorted = [...list].sort((a, b) => Math.abs(cur(b) - prev(b)) - Math.abs(cur(a) - prev(a)) || (a.key < b.key ? -1 : 1));
      return { count: list.length, totalChange: list.reduce((s, r) => s + cur(r) - prev(r), 0), top: sorted.slice(0, limit).map(shape) };
    };
    const data = {
      state: "ready" as const,
      dataSource: storedSyncLabel(sync),
      ...windowsOf(sync),
      dimension,
      metric,
      segment,
      segmentNote,
      basis: agg.basis,
      truncatedSync: sync.truncated === 1,
      keysCompared: rows.length,
      lost: summarize(buckets.lost),
      declined: summarize(buckets.declined),
      gained: summarize(buckets.gained),
      improved: summarize(buckets.improved),
      definitions: `lost = ${metric} > 0 in the previous window and 0 now; declined = fewer but not 0; gained = 0 before and > 0 now; improved = more than before. Rows outside the stored slices (anonymized or beyond the row cap) are not compared.`,
    };
    return {
      data,
      summary: `${buckets.lost.length} lost · ${buckets.declined.length} declined · ${buckets.gained.length} gained · ${buckets.improved.length} improved ${dimension === "query" ? "queries" : "pages"} · ${data.currentWindow} vs ${data.previousWindow}`,
    };
  },
};

// ------------------------------------------------------------------ brand split
const brandSchema = z.object({ limit: z.number().int().min(1).max(25).optional().describe("Top brand and non-brand queries to list (1-25, default 10).") });

async function queryTotals(ctx: ToolContext, sync: SyncRow) {
  const [ws, pid] = scoped(ctx);
  return ctx.db.all<{ query: string; window: "current" | "previous"; clicks: number; impressions: number; posw: number }>(
    `SELECT query, window, SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(position * impressions) AS posw FROM gsc_metrics
      WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND query IS NOT NULL GROUP BY query, window LIMIT ?`,
    ws,
    pid,
    sync.id,
    COMPARE_MAX_KEYS * 2,
  );
}

const searchConsoleBrandSplit: ReadTool<typeof brandSchema> = {
  name: "search_console_brand_split",
  kind: "read",
  description:
    "Brand vs non-brand Search Console queries from the latest STORED sync (current and previous 28-day windows): query counts, clicks, impressions, CTR per segment, and the top brand and non-brand queries. Brand = the project's brand name or aliases (deterministic match); competitor-name queries count as non-brand.",
  schema: brandSchema,
  async run(ctx, input) {
    const [ws, pid] = scoped(ctx);
    const sync = await latestUsableSync(ctx.db, ws, pid);
    if (!sync) return { data: NO_DATA, summary: "No Search Console data stored" };
    const classifier = await projectBrandClassifier(ctx.db, ctx.project);
    if (classifier.terms.self.length === 0) {
      return { data: { state: "setup_required", message: "Add the brand name or aliases in project Settings to split brand and non-brand queries.", path: projectRoute(pid, "settings") }, summary: "No brand terms" };
    }
    const rows = await queryTotals(ctx, sync);
    const basis = sync.source === "csv_import" ? "query_rows" : "query_page_rows";
    const split = (w: "current" | "previous") =>
      brandSplitOf(
        rows.filter((r) => r.window === w),
        classifier,
        { window: w === "current" ? `${sync.window_start}..${sync.window_end}` : `${sync.prev_window_start}..${sync.prev_window_end}`, basis },
      );
    const part = (p: { queries: number; clicks: number; impressions: number; ctr: { numerator: number; denominator: number; value: number | null } }) => ({
      queries: p.queries,
      clicks: p.clicks,
      impressions: p.impressions,
      ctr: ratioValue(p.ctr),
    });
    const cur = split("current");
    const prev = split("previous");
    const limit = input.limit ?? 10;
    const current = rows.filter((r) => r.window === "current");
    const top = (brand: boolean) =>
      current
        .filter((r) => classifier.isSelfBrand(r.query) === brand)
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
        .slice(0, limit)
        .map((r) => ({ query: clip(r.query, 200), clicks: r.clicks, impressions: r.impressions, approxPosition: r.impressions > 0 ? round1(r.posw / r.impressions) : null }));
    const data = {
      state: "ready" as const,
      dataSource: storedSyncLabel(sync),
      ...windowsOf(sync),
      current: cur ? { brand: part(cur.split.brand), nonBrand: part(cur.split.nonBrand), competitorNameQueries: cur.competitorQueries } : null,
      previous: prev ? { brand: part(prev.split.brand), nonBrand: part(prev.split.nonBrand) } : null,
      nonBrandClickChangePct: cur && prev ? pct(cur.split.nonBrand.clicks, prev.split.nonBrand.clicks) : null,
      brandClickChangePct: cur && prev ? pct(cur.split.brand.clicks, prev.split.brand.clicks) : null,
      topBrandQueries: top(true),
      topNonBrandQueries: top(false),
      method: clip(cur?.split.method ?? null, 700),
    };
    return { data, summary: `brand ${cur?.split.brand.clicks ?? 0} / non-brand ${cur?.split.nonBrand.clicks ?? 0} clicks · ${data.currentWindow}` };
  },
};

// ------------------------------------------------------------------ buyer queries
const buyerSchema = z.object({
  includeBrand: z.boolean().optional().describe("Include queries containing the project's brand (default false)."),
  limit: z.number().int().min(1).max(50).optional().describe("Rows (1-50, default 20)."),
});

const searchConsoleBuyerQueries: ReadTool<typeof buyerSchema> = {
  name: "search_console_buyer_queries",
  kind: "read",
  description:
    "Buyer-intent Search Console queries from the latest STORED sync. (1) jevClassified: the SEO buyer-query view's stored Jev classifications (transactional / commercial investigation, cached; this tool never asks Jev, the SEO page does). (2) modifierMatches: current-window queries with a commercial/transactional modifier (buy, price, best, vs, review, sale, near me, 'for <use>'...; deterministic English list), ranked by impressions, with clicks, CTR, approximate position and change vs the previous window.",
  schema: buyerSchema,
  async run(ctx, input) {
    const [ws, pid] = scoped(ctx);
    const sync = await latestUsableSync(ctx.db, ws, pid);
    if (!sync) return { data: NO_DATA, summary: "No Search Console data stored" };
    const limit = input.limit ?? 20;
    const jevClassified = await cachedBuyerView(ctx, limit);
    if (!isEnglish(ctx.project.language)) {
      return {
        data: { state: "unavailable", message: `The buyer-intent word list is English only; this project's language is "${clip(ctx.project.language, 16)}".`, dataSource: storedSyncLabel(sync), jevClassified },
        summary: "Buyer-intent list is English only",
      };
    }
    const classifier = input.includeBrand ? null : await projectBrandClassifier(ctx.db, ctx.project);
    const rows = await queryTotals(ctx, sync);
    const byKey = new Map<string, { query: string; c: number; ci: number; cp: number; p: number; pi: number }>();
    for (const r of rows) {
      const key = normalizeDemandQuery(r.query);
      if (!key) continue;
      const a = byKey.get(key) ?? { query: key, c: 0, ci: 0, cp: 0, p: 0, pi: 0 };
      if (r.window === "current") {
        a.c += r.clicks;
        a.ci += r.impressions;
        a.cp += r.posw;
      } else {
        a.p += r.clicks;
        a.pi += r.impressions;
      }
      byKey.set(key, a);
    }
    const matches = [...byKey.values()].filter((a) => a.ci > 0 && hasStrongIntentModifier(a.query, ctx.project.language) === true && !(classifier && classifier.isSelfBrand(a.query)));
    matches.sort((a, b) => b.ci - a.ci || b.c - a.c || (a.query < b.query ? -1 : 1));
    const data = {
      state: "ready" as const,
      dataSource: storedSyncLabel(sync),
      ...windowsOf(sync),
      jevClassified,
      method: `Queries containing a commercial/transactional modifier (${STRONG_INTENT_VERSION}); ${input.includeBrand ? "brand queries included" : "brand queries excluded"}. Impressions are from this site's Search Console data, not market search volume.`,
      matchingQueries: matches.length,
      totals: { clicks: matches.reduce((s, a) => s + a.c, 0), impressions: matches.reduce((s, a) => s + a.ci, 0), previousClicks: matches.reduce((s, a) => s + a.p, 0) },
      modifierMatches: matches.slice(0, limit).map((a) => ({
        query: clip(a.query, 200),
        clicks: a.c,
        impressions: a.ci,
        ctr: ctrOf(a.c, a.ci),
        approxPosition: a.ci > 0 ? round1(a.cp / a.ci) : null,
        previousClicks: a.p,
        previousImpressions: a.pi,
        clickChange: a.c - a.p,
      })),
    };
    return { data, summary: `${matches.length} modifier match(es) · ${jevClassified.rows.length} Jev-classified (stored) · ${data.currentWindow}` };
  },
};

/** The SEO buyer-query view from cached Jev decisions only (classify=false: never calls Jev, spends nothing). */
async function cachedBuyerView(ctx: ToolContext, limit: number) {
  const [ws, pid] = scoped(ctx);
  const decisions =
    ctx.project.is_demo === 1 ? null : await (ctx.hooks?.competitorDecisions ?? ((env, d, w, p) => buildDecisionsForWorkspace(env, d, w, p)))(ctx.env, ctx.db, ws, pid);
  const clock = () => ctx.now;
  const scope = { workspaceId: ws, projectId: pid, runId: null };
  const view = await buildBuyerQueries({
    db: ctx.db,
    project: ctx.project,
    now: ctx.now,
    decisions,
    budget: createBudget(ctx.db, ctx.env, scope, clock),
    calls: createCallRecorder(ctx.db, scope, clock),
    classify: false,
    maxQueries: buyerQueryCap(ctx.env.BUYER_QUERIES_MAX),
  });
  return {
    state: view.state,
    completeness: clip(view.completeness?.note ?? null, 300),
    labels: view.labels.slice(0, 3).map((l) => clip(l, 200)),
    rows: view.rows.slice(0, limit).map((r) => ({
      query: clip(r.query, 200),
      intent: r.intent,
      tier: r.intentTier,
      impressions: r.impressions,
      clicks: r.clicks,
      approxPosition: round1(r.position),
      topPage: clip(r.topPage, 400),
    })),
    path: projectRoute(pid, "seo"),
  };
}

// ------------------------------------------------------------------ live query
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const liveDimension = z.enum(["query", "page", "country", "device", "date"]);
const liveSchema = z.object({
  startDate: z.string().regex(DATE).describe("First day, YYYY-MM-DD (Pacific time dates, as Search Console reports them)."),
  endDate: z.string().regex(DATE).describe("Last day, YYYY-MM-DD, inclusive."),
  dimensions: z.array(liveDimension).max(3).optional().describe('Group by up to 3 of: query, page, country, device, date. Omit (or []) for window totals. ["date"] gives a daily series.'),
  filters: z
    .array(
      z.object({
        dimension: z.enum(["query", "page", "country", "device"]),
        operator: z.enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"]).optional().describe("Default equals."),
        expression: z.string().trim().min(1).max(200).describe("country: ISO 3166-1 alpha-3 lowercase (e.g. usa); device: DESKTOP, MOBILE or TABLET; regex: RE2 syntax."),
      }),
    )
    .max(5)
    .optional()
    .describe("All filters must match (AND)."),
  searchType: z.enum(["web", "image", "video", "news"]).optional().describe("Default web."),
  dataState: z.enum(["final", "all"]).optional().describe("final (default) = finalized data only; all = include fresh, incomplete days."),
  rowLimit: z.number().int().min(1).max(GSC_LIVE_MAX_ROWS).optional().describe(`Rows (1-${GSC_LIVE_MAX_ROWS}, default ${GSC_LIVE_DEFAULT_ROWS}); Google returns the top rows by clicks (or by date).`),
});
type LiveInput = z.infer<typeof liveSchema>;

/** Earliest date Search Console can still return (16 months back from `today`, UTC calendar). */
export function earliestGscDate(today: Date): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - GSC_LIVE_MAX_MONTHS, today.getUTCDate()));
  return utcDay(d);
}

function validDay(s: string): boolean {
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && utcDay(new Date(t)) === s;
}

export function validateLiveRange(input: Pick<LiveInput, "startDate" | "endDate">, now: Date): void {
  if (!validDay(input.startDate) || !validDay(input.endDate)) throw new ToolError("startDate and endDate must be real calendar dates (YYYY-MM-DD).");
  if (input.endDate < input.startDate) throw new ToolError("endDate is before startDate.");
  const today = utcDay(now);
  if (input.endDate > today) throw new ToolError(`endDate ${input.endDate} is in the future (today is ${today} UTC).`);
  const earliest = earliestGscDate(now);
  if (input.startDate < earliest) throw new ToolError(`Search Console keeps ${GSC_LIVE_MAX_MONTHS} months of data: startDate must be on or after ${earliest}.`);
}

const searchConsoleLiveQuery: ReadTool<typeof liveSchema> = {
  name: "search_console_live_query",
  kind: "read",
  description:
    `LIVE Google Search Console API call (searchanalytics.query) for this project's connected property: any date range within the last ${GSC_LIVE_MAX_MONTHS} months, up to 3 dimensions (query, page, country, device, date) and filters by query/page/country/device. Read-only and free but rate-limited (${GSC_LIVE_USER_LIMIT.limit} per user per 10 minutes); use it only when the stored-sync tools cannot answer (custom range, filters, country/device, daily position). Returns at most ${GSC_LIVE_MAX_ROWS} rows; Google returns top rows only and omits anonymized queries.`,
  schema: liveSchema,
  async run(ctx, input) {
    validateLiveRange(input, ctx.now);
    const [ws, pid] = scoped(ctx);
    if (ctx.project.is_demo === 1) {
      return { data: { state: "demo", message: "Demo projects use stored fixture data; the live Search Console API is not called." }, summary: "Demo project: no live call" };
    }
    const property = ctx.project.gsc_property;
    const setup = (message: string) => ({
      data: { state: "setup_required", message, path: projectRoute(pid, "integrations") },
      summary: "Search Console not connected (setup required)",
    });
    if (!property) return setup("No Search Console property is selected for this project. Connect Search Console and choose a property on Integrations.");
    let gsc;
    try {
      gsc = await createGscProvider(ctx.env, ctx.db, { id: pid, workspaceId: ws }, createApiFetch(ctx.env, ctx.hooks?.gscFetch ?? fetch), () => ctx.now);
    } catch {
      return setup("The stored Search Console connection could not be loaded. Reconnect Search Console on Integrations.");
    }
    if (!gsc) return setup("Search Console is not connected for this project (or Google OAuth is not configured). Connect it on Integrations.");

    const user = await hitRateLimit(ctx.db, `chat_gsc_live:user:${ctx.userId}`, GSC_LIVE_USER_LIMIT.limit, GSC_LIVE_USER_LIMIT.windowSeconds, ctx.now);
    if (!user.allowed) throw new ToolError(`Live Search Console query limit reached (${GSC_LIVE_USER_LIMIT.limit} per 10 minutes). Try again in ${Math.ceil(user.retryAfterSeconds / 60)} minute(s), or use the stored-sync tools.`);
    const proj = await hitRateLimit(ctx.db, `chat_gsc_live:project:${pid}`, GSC_LIVE_PROJECT_LIMIT.limit, GSC_LIVE_PROJECT_LIMIT.windowSeconds, ctx.now);
    if (!proj.allowed) throw new ToolError(`This project's live Search Console query limit for today is reached (${GSC_LIVE_PROJECT_LIMIT.limit} per day). Use the stored-sync tools.`);

    const dimensions = [...new Set(input.dimensions ?? [])] as GscQueryRequest["dimensions"];
    const filters = (input.filters ?? []).map((f) => ({
      dimension: f.dimension as GscFilterDimension,
      operator: (f.operator ?? "equals") as GscFilterOperator,
      expression: f.dimension === "device" ? f.expression.toUpperCase() : f.dimension === "country" ? f.expression.toLowerCase() : f.expression,
    }));
    const rowLimit = Math.min(input.rowLimit ?? GSC_LIVE_DEFAULT_ROWS, GSC_LIVE_MAX_ROWS);
    const req: GscQueryRequest = {
      property,
      startDate: input.startDate,
      endDate: input.endDate,
      dimensions,
      rowLimit,
      startRow: 0,
      dataState: input.dataState ?? "final",
      type: input.searchType ?? "web",
      ...(filters.length ? { dimensionFilterGroups: [{ groupType: "and" as const, filters }] } : {}),
    };
    const calls = createCallRecorder(ctx.db, { workspaceId: ws, projectId: pid, runId: null }, () => ctx.now);
    const started = Date.now();
    let res;
    try {
      res = await gsc.query(req);
    } catch (e) {
      const latencyMs = Date.now() - started;
      const status = e instanceof GscApiError && e.code === "network" ? "unknown" : "error";
      await calls.record({ provider: GSC_LIVE_PROVIDER, model: "searchanalytics.query", purpose: "chat_gsc_live", status, costUsd: 0, costIsEstimate: false, rateVersion: GSC_LIVE_RATE_VERSION, latencyMs, error: e instanceof Error ? e.message : "error" });
      if (e instanceof GscApiError) {
        if (e.code === "invalid_grant") return setup("Google rejected the stored Search Console authorization. Reconnect Search Console on Integrations.");
        if (e.status === 429 || e.code === "quota_exceeded") throw new ToolError("Search Console quota exceeded. Google asks to wait about 15 minutes before querying again; the stored-sync tools still work.");
        if (e.status === 403) throw new ToolError("The connected Google account has no access to this Search Console property. Check the property on Integrations.");
        if (e.status === 400) throw new ToolError(`Search Console rejected the query: ${clip(e.message, 200)}`);
        throw new ToolError(`Search Console API request failed (${e.status || "network"}).`);
      }
      throw e;
    }
    await calls.record({ provider: GSC_LIVE_PROVIDER, model: "searchanalytics.query", purpose: "chat_gsc_live", status: "ok", costUsd: 0, costIsEstimate: false, rateVersion: GSC_LIVE_RATE_VERSION, latencyMs: Date.now() - started });
    const rows = res.rows.slice(0, rowLimit).map((r) => {
      const keys: Record<string, string | null> = {};
      dimensions.forEach((d, i) => (keys[d] = clip(r.keys?.[i], 400)));
      return {
        ...keys,
        clicks: Math.round(Number(r.clicks) || 0),
        impressions: Math.round(Number(r.impressions) || 0),
        ctr: typeof r.ctr === "number" ? Math.round(r.ctr * 10000) / 10000 : null,
        position: round1(r.position),
      };
    });
    const data = {
      state: "ready" as const,
      dataSource: `${FIRST_PARTY}, live API call (searchanalytics.query) at ${ctx.now.toISOString().slice(0, 16)}Z`,
      property: clip(property, 300),
      window: `${input.startDate}..${input.endDate}`,
      searchType: req.type,
      dataState: req.dataState,
      dimensions,
      filters: filters.map((f) => ({ ...f, expression: clip(f.expression, 200) })),
      rowLimit,
      rowsReturned: rows.length,
      possiblyMoreRows: rows.length >= rowLimit,
      firstIncompleteDate: res.metadata?.first_incomplete_date ?? null,
      notes: [
        "Dates are Pacific time days, as Search Console reports them.",
        "Google returns top rows only and omits anonymized queries; query/page rows do not sum to property totals.",
        ...(dimensions.length === 0 ? ["No dimensions: one row of property totals for the range."] : []),
      ],
      rows,
    };
    return {
      data,
      summary: `Called Search Console API (live): ${rows.length} row(s) · ${data.window}${dimensions.length ? ` · by ${dimensions.join("+")}` : ""}`,
    };
  },
};

export const GSC_CHAT_TOOLS = [searchConsoleTrend, searchConsoleCompare, searchConsoleBrandSplit, searchConsoleBuyerQueries, searchConsoleLiveQuery] as ReadTool[];
