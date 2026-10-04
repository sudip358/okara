/**
 * Ask Okara over the workspace's Maton.ai gateway key (platform/maton.ts, the only Maton caller and its strict
 * read-only egress allowlist): live Google Sheets, Search Console and Google Analytics 4 reads.
 *
 * - One grouped read tool (`maton_data`, view enum) to keep the tool list short.
 * - The Maton key reaches the owner's own Google accounts, so every view except `status` is workspace-owner only
 *   (members use the stored Search Console sync tools instead).
 * - Search Console through Maton is limited to this project's own property (or its verified host), never another
 *   site the Maton account can see.
 * - Rate-limited per user (Maton calls are free to Okara but not unlimited upstream); every call is metered in
 *   provider_calls (provider "maton", cost 0) by platform/maton.ts.
 * - Sheet cells, GA dimension values and query strings are untrusted data, clipped, returned as JSON strings.
 * - Every result carries Maton's source label ("Maton (connection …), fetched <ts>"); no number is computed here
 *   beyond what Google returned.
 */
import { z } from "zod";
import { hitRateLimit } from "../platform/rate-limit";
import {
  gaListProperties,
  gaRunReport,
  gscQuery,
  gscSites,
  matonStatus,
  MatonApiError,
  MatonPolicyError,
  MatonSetupRequiredError,
  readSheetTabs,
  readSheetValues,
  type MatonScope,
} from "../platform/maton";
import { ToolError, clip, compact, projectRoute, requireOwnerTool, scoped, type ReadTool, type ToolContext } from "./tool-base";

export const MATON_CHAT_USER_LIMIT = { limit: 20, windowSeconds: 600 } as const;
export const MATON_CHAT_SHEET_ROWS = 200;
export const MATON_CHAT_ROWS = 100;

const DATE = z.string().regex(/^(\d{4}-\d{2}-\d{2}|today|yesterday|\d{1,4}daysAgo)$/);
const GA_NAME = z.string().regex(/^[A-Za-z][A-Za-z0-9_:]{0,99}$/);
const SHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;

/** A spreadsheet id, or the id inside a docs.google.com/spreadsheets/d/<id>/… link. */
export function spreadsheetIdFrom(raw: string): string | null {
  const s = raw.trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})/.exec(s);
  const id = m ? m[1]! : s;
  return SHEET_ID.test(id) ? id : null;
}

const schema = z
  .object({
    view: z.enum(["status", "sheet_tabs", "sheet_values", "gsc_query", "ga_properties", "ga_report"]),
    spreadsheet: z.string().max(400).optional().describe("Spreadsheet id or its docs.google.com link (sheet_tabs, sheet_values)"),
    range: z.string().max(200).optional().describe("A1 range or tab name for sheet_values, e.g. \"Blog Hub Drops\" or \"Blog Hub Drops!A1:G200\""),
    maxRows: z.number().int().min(1).max(MATON_CHAT_SHEET_ROWS).optional(),
    startDate: DATE.optional(),
    endDate: DATE.optional(),
    dimensions: z.array(z.string().max(60)).max(9).optional().describe("gsc_query: query|page|country|device|date; ga_report: GA4 dimension names e.g. landingPagePlusQueryString, sessionSource"),
    metrics: z.array(GA_NAME).max(10).optional().describe("ga_report: GA4 metric names e.g. sessions, totalRevenue, ecommercePurchases, conversions"),
    propertyId: z.string().max(40).optional().describe("ga_report: GA4 property id (from ga_properties)"),
    filter: z
      .object({ dimension: z.string().max(60), contains: z.string().max(200) })
      .optional()
      .describe("Optional single 'contains' filter: gsc_query on query/page, ga_report on a dimension (e.g. sessionSource contains chatgpt)"),
    orderByMetric: GA_NAME.optional().describe("ga_report: sort descending by this metric"),
    rowLimit: z.number().int().min(1).max(MATON_CHAT_ROWS).optional(),
  })
  .strict();

function scopeOf(ctx: ToolContext): MatonScope {
  const [workspaceId, projectId] = scoped(ctx);
  return { env: ctx.env, db: ctx.db, workspaceId, projectId, purpose: "chat_maton", clock: () => ctx.now };
}

async function guarded<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof MatonSetupRequiredError) throw new ToolError(`setup_required: ${e.message}`);
    if (e instanceof MatonPolicyError) throw new ToolError(`Not allowed: ${e.message}`);
    if (e instanceof MatonApiError) throw new ToolError(`Maton/Google answered with an error (${e.code}): ${clip(e.message, 300)}`);
    throw e;
  }
}

/** This project's own Search Console property, or a property that matches its verified host. */
function projectProperty(ctx: ToolContext, sites: Array<{ siteUrl: string }>): string | null {
  const p = ctx.project;
  if (p.gsc_property && sites.some((s) => s.siteUrl === p.gsc_property)) return p.gsc_property;
  const host = (p.verified_host ?? "").toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  const match = sites.find((s) => {
    const u = s.siteUrl.toLowerCase();
    if (u === `sc-domain:${host}`) return true;
    try {
      return new URL(u).hostname.replace(/^www\./, "") === host;
    } catch {
      return false;
    }
  });
  return match?.siteUrl ?? null;
}

export const matonData: ReadTool<typeof schema> = {
  name: "maton_data",
  kind: "read",
  description:
    "LIVE reads through the workspace's Maton.ai gateway (owner only, rate-limited): view status (connected apps, no keys); sheet_tabs / sheet_values (Google Sheets: tabs, or cell values of a tab/range of a spreadsheet id or link, e.g. the master sheet); gsc_query (Search Console for THIS project's property only: any dates, dimensions, one contains-filter); ga_properties (GA4 properties); ga_report (GA4 runReport: dimensions + metrics, e.g. landingPagePlusQueryString × sessions,totalRevenue, or sessionSource contains chatgpt/perplexity for AI referrals). Use stored-sync tools first for Search Console; use this for custom ranges, the live sheet, or GA4. Values are Google's, labelled with Maton source and fetch time.",
  schema,
  async run(ctx, input) {
    const scope = scopeOf(ctx);
    if (input.view === "status") {
      const s = await matonStatus(ctx.env, ctx.db, scope.workspaceId);
      return { data: compact(s, { maxItems: 20 }), summary: "Maton connection status" };
    }
    await requireOwnerTool(ctx, "read live data through Maton");
    const rl = await hitRateLimit(ctx.db, `chat_maton:user:${ctx.userId}`, MATON_CHAT_USER_LIMIT.limit, MATON_CHAT_USER_LIMIT.windowSeconds, ctx.now);
    if (!rl.allowed) throw new ToolError(`Live Maton read limit reached (${MATON_CHAT_USER_LIMIT.limit} per 10 minutes). Try again in ${Math.ceil(rl.retryAfterSeconds / 60)} minute(s).`);

    switch (input.view) {
      case "sheet_tabs":
      case "sheet_values": {
        const id = input.spreadsheet ? spreadsheetIdFrom(input.spreadsheet) : null;
        if (!id) throw new ToolError("Give the spreadsheet id or its docs.google.com/spreadsheets/d/<id> link.");
        if (input.view === "sheet_tabs") {
          const r = await guarded(() => readSheetTabs(scope, id));
          return { data: { source: r.source, truncated: r.truncated, ...(compact(r.data, { maxItems: 100 }) as object) }, summary: `Read the sheet's tabs (${r.source})` };
        }
        if (!input.range) throw new ToolError("sheet_values needs a range or tab name (call view sheet_tabs first to list tabs).");
        const maxRows = input.maxRows ?? 100;
        const r = await guarded(() => readSheetValues(scope, id, input.range!, maxRows));
        const rows = r.data.rows.map((row) => row.slice(0, 30).map((c) => clip(c, 200) ?? ""));
        return { data: { source: r.source, range: clip(r.data.range, 200), rows, rowCount: rows.length, truncated: r.truncated }, summary: `Read ${rows.length} row(s) from ${clip(input.range, 60)} (${r.source})` };
      }
      case "gsc_query": {
        if (!input.startDate || !input.endDate || !/^\d{4}-/.test(input.startDate) || !/^\d{4}-/.test(input.endDate)) throw new ToolError("gsc_query needs startDate and endDate as YYYY-MM-DD.");
        const sites = await guarded(() => gscSites(scope));
        const property = projectProperty(ctx, sites.data);
        if (!property) throw new ToolError("The Maton Search Console connection has no property for this project's verified site.");
        const dims = (input.dimensions ?? []).filter((d): d is "query" | "page" | "country" | "device" | "date" => ["query", "page", "country", "device", "date"].includes(d)).slice(0, 3);
        const filt = input.filter && ["query", "page", "country", "device"].includes(input.filter.dimension)
          ? [{ groupType: "and" as const, filters: [{ dimension: input.filter.dimension, operator: "contains", expression: input.filter.contains }] }]
          : undefined;
        const r = await guarded(() =>
          gscQuery(scope, { siteUrl: property, startDate: input.startDate!, endDate: input.endDate!, dimensions: dims, rowLimit: input.rowLimit ?? 50, dataState: "final", ...(filt ? { dimensionFilterGroups: filt } : {}) }),
        );
        const rows = r.data.rows.slice(0, MATON_CHAT_ROWS).map((x) => ({ keys: x.keys.map((k) => clip(k, 200)), clicks: x.clicks, impressions: x.impressions, ctr: Math.round(x.ctr * 10000) / 10000, position: Math.round(x.position * 10) / 10 }));
        return {
          data: { source: `Search Console via ${r.source}`, property, window: `${input.startDate}..${input.endDate}`, dimensions: dims, rows, note: "Google returns top rows only and omits anonymized queries." },
          summary: `Search Console via Maton: ${rows.length} row(s), ${input.startDate}..${input.endDate}`,
        };
      }
      case "ga_properties": {
        const r = await guarded(() => gaListProperties(scope));
        return { data: { source: r.source, properties: compact(r.data, { maxItems: 50 }), truncated: r.truncated }, summary: `Listed ${r.data.length} GA4 propert${r.data.length === 1 ? "y" : "ies"}` };
      }
      case "ga_report": {
        if (!input.propertyId) throw new ToolError("ga_report needs propertyId (call view ga_properties first).");
        if (!input.metrics?.length) throw new ToolError("ga_report needs at least one metric.");
        const startDate = input.startDate ?? "28daysAgo";
        const endDate = input.endDate ?? "yesterday";
        const dims = (input.dimensions ?? []).filter((d) => /^[A-Za-z][A-Za-z0-9_:]{0,99}$/.test(d)).slice(0, 4);
        const r = await guarded(() =>
          gaRunReport(scope, input.propertyId!, {
            dateRanges: [{ startDate, endDate }],
            metrics: input.metrics!.map((name) => ({ name })),
            dimensions: dims.map((name) => ({ name })),
            ...(input.filter ? { dimensionFilter: { filter: { fieldName: input.filter.dimension, stringFilter: { matchType: "CONTAINS", value: input.filter.contains, caseSensitive: false } } } } : {}),
            ...(input.orderByMetric ? { orderBys: [{ metric: { metricName: input.orderByMetric }, desc: true }] } : {}),
            limit: input.rowLimit ?? 50,
          }),
        );
        const rows = r.data.rows.slice(0, MATON_CHAT_ROWS).map((x) => ({ dimensions: x.dimensions.map((d) => clip(d, 200)), metrics: x.metrics }));
        return {
          data: {
            source: `Google Analytics 4 via ${r.source}`,
            propertyId: input.propertyId,
            window: `${startDate}..${endDate}`,
            dimensionHeaders: r.data.dimensionHeaders,
            metricHeaders: r.data.metricHeaders,
            rows,
            rowCount: r.data.rowCount,
            currencyCode: r.data.currencyCode,
            note: "Metric values are Google's strings; GA4 may under-count (consent, ad blockers).",
          },
          summary: `GA4 report via Maton: ${rows.length} row(s), ${startDate}..${endDate}`,
        };
      }
    }
    return { data: null, summary: "", navigate: { path: projectRoute(ctx.project.id, "integrations"), label: "Integrations" } };
  },
};

export const MATON_CHAT_TOOLS = [matonData];
