/**
 * GSC sync: import finalized current + previous 28-day windows through ctx.gsc.
 *
 * Per window:
 *   (a) property totals: one request with no dimensions (Google's own aggregate incl. position)
 *   (b) daily series: dimensions ['date'] (current window only) -> gsc_daily
 *   (c) slices: dimensions ['page'] then ['query','page'], paginated with rowLimit <= 25,000 and
 *       startRow, stopping at the project row cap (project_limits.gsc_rows). Hitting the cap while a
 *       full page was returned marks the sync truncated.
 *
 * The ['page'] slice (a small share of the row budget) is an addition to the ['query','page'] slice:
 * page rows include traffic from anonymized queries, so per-page heuristics (declining pages,
 * internal links) do not have to sum query rows, which would undercount.
 *
 * Limitations recorded on every sync: pagination does not guarantee complete query data (Google
 * omits anonymized queries and applies its own row limits), so slices never sum to property totals.
 * Quota/429 errors stop further requests immediately (no retry storm); what was fetched is kept and
 * the sync is 'partial' (or 'failed' if nothing usable was fetched). `truncated` means the row cap
 * was reached while Google was still returning full pages, so more rows may exist.
 * Budget: `gsc_rows` is reserved at the project row cap and settled to the slice rows actually
 * imported (the few totals/daily/probe rows are not counted against the cap).
 *
 * [A23]/[A25] extra slices (slices.ts), fetched after both windows and stored in totals_json.extras:
 *   (d) ['query','page','date'] for the current window (10% of the cap), aggregated to weeks for the
 *       top 200 queries by current impressions -> alternating ranking URLs (cannibalisation prefilter);
 *   (e) year-over-year: a ['date'] probe of the same window one year (364 days) earlier; only when the
 *       property has data on >= 90% of those days is the ['page'] slice fetched (10% of the cap)
 *       -> seasonality check for declining pages;
 *   (f) ['country'] (2% of the cap, <= 250 rows) and (g) ['country','page'] (4%) for the current window
 *       -> translation opportunities.
 * Their shares are carved out of the row cap before the base slices, so a sync never exceeds the cap;
 * caps below EXTRA_SLICES_MIN_CAP skip them (noted).
 */
import type { RunContext } from "../../runs/context";
import type { GscQueryRequest, GscRow } from "../../providers/types";
import { BudgetExceededError } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { iso } from "../../lib/time";
import { daysInWindow, finalizedWindows, GSC_DATA_STATE, windowLabel, type WindowOptions } from "./windows";
import { missingTrailingDays, parseTotalsJson, totalsFromAggregateRow, type TotalsJson } from "./aggregate";
import {
  aggregateQueryPageWeeks,
  extraCaps,
  EXTRA_SLICES_MIN_CAP,
  EXTRA_SLICES_VERSION,
  QPD_TOP_QUERIES,
  weekStartsOf,
  YOY_MIN_DAY_COVERAGE,
  yoyWindow,
  type ExtrasJson,
} from "./slices";

export interface GscSyncSummary {
  syncId: string | null;
  rows: number;
  truncated: boolean;
  status: "completed" | "partial" | "failed" | "no_data" | "setup_required";
  note: string;
}

/** Documented GSC maximum rows per request. */
export const GSC_MAX_ROW_LIMIT = 25_000;
export const DEFAULT_GSC_ROW_CAP = 5_000;
/** Share of each window's row budget spent on the page-dimension slice (rest goes to query+page). */
export const PAGE_SLICE_SHARE = 0.2;
/** How many past API syncs keep their slice rows (older slice rows are deleted for retention). */
export const KEEP_SLICE_SYNCS = 3;

export const GSC_LIMITATIONS = [
  "Search Console omits anonymized queries, so query/page slices never add up to property totals; totals come from a separate property-level request.",
  "Pagination (rowLimit/startRow) does not guarantee complete query data; slices stop at the project row cap.",
  "Dates are Search Console's Pacific Time days; only finalized data (dataState=final) is imported.",
  "Metrics combine all devices and countries.",
];

export interface SyncOptions extends WindowOptions {
  /** Rows per request (<= 25,000). Tests use small pages to exercise pagination. */
  pageSize?: number;
}

type Outcome = { kind: "ok" } | { kind: "stopped"; reason: "quota" | "error" | "cancelled"; message: string };

export async function syncGsc(ctx: RunContext, opts: SyncOptions = {}): Promise<GscSyncSummary> {
  const project = await ctx.db.first<{ gsc_property: string | null }>(
    "SELECT gsc_property FROM projects WHERE id = ? AND workspace_id = ?",
    ctx.project.id,
    ctx.project.workspaceId,
  );
  const property = project?.gsc_property ?? null;
  if (!ctx.gsc || !property) {
    const note = !property ? "No Search Console property selected; connect GSC or import a CSV export." : "Search Console is not connected.";
    await ctx.log.event("gsc_sync", "skipped", `Setup required: ${note}`);
    return { syncId: null, rows: 0, truncated: false, status: "setup_required", note };
  }
  const gsc = ctx.gsc;

  const limits = await ctx.db.first<{ gsc_rows: number }>(
    "SELECT gsc_rows FROM project_limits WHERE project_id = ? AND workspace_id = ?",
    ctx.project.id,
    ctx.project.workspaceId,
  );
  const rowCap = Math.max(0, Math.floor(limits?.gsc_rows ?? DEFAULT_GSC_ROW_CAP));
  const pageSize = Math.max(1, Math.min(GSC_MAX_ROW_LIMIT, Math.floor(opts.pageSize ?? GSC_MAX_ROW_LIMIT)));
  const windows = finalizedWindows(ctx.clock(), opts);

  let reservation: string | null = null;
  try {
      reservation = rowCap > 0 ? await ctx.budget.reserve("gsc_rows", rowCap) : null;
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      const note = "GSC row budget for today is used up; sync skipped.";
      await ctx.log.event("gsc_sync", "skipped", note);
      return { syncId: null, rows: 0, truncated: false, status: "failed", note };
    }
    throw e;
  }

  const syncId = newId("gsync");
  const startedAt = iso(ctx.clock());
  await ctx.db.insert("gsc_syncs", {
    id: syncId,
    workspace_id: ctx.project.workspaceId,
    project_id: ctx.project.id,
    run_id: ctx.runId,
    source: "api",
    property,
    window_start: windows.current.start,
    window_end: windows.current.end,
    prev_window_start: windows.previous.start,
    prev_window_end: windows.previous.end,
    data_state: GSC_DATA_STATE,
    rows_fetched: 0,
    row_cap: rowCap,
    truncated: 0,
    totals_json: "{}",
    status: "running",
    synced_at: startedAt,
  });
  await ctx.log.event(
    "gsc_sync",
    "started",
    `Importing ${property}: current ${windowLabel(windows.current)}, previous ${windowLabel(windows.previous)} (final data, row cap ${rowCap})${gsc.transport?.kind === "maton" ? `, via Maton (${gsc.transport.label ?? "default connection"})` : ""}.`,
  );

  let requests = 0;
  let outcome = { kind: "ok" } as Outcome;
  const query = async (req: Omit<GscQueryRequest, "property" | "dataState" | "type">): Promise<GscRow[] | null> => {
    if (outcome.kind !== "ok") return null;
    if (await ctx.isCancelled()) {
      outcome = { kind: "stopped", reason: "cancelled", message: "Run cancelled during GSC import." };
      return null;
    }
    requests++;
    try {
      const res = await gsc.query({ ...req, property, dataState: GSC_DATA_STATE, type: "web" });
      return Array.isArray(res.rows) ? res.rows : [];
    } catch (e) {
      outcome = isQuotaError(e)
        ? { kind: "stopped", reason: "quota", message: "Search Console quota or rate limit reached (HTTP 429); stopped early. Retry later." }
        : { kind: "stopped", reason: "error", message: `Search Console request failed: ${safeMessage(e)}` };
      return null;
    }
  };

  const totals: TotalsJson = { current: null, previous: null, notes: [] };
  const insertedRows: Array<[string, ...unknown[]]> = [];
  let totalRows = 0;
  let truncated = false;
  let dailyRows = 0;
  let missingDays = 0;
  const caps = extraCaps(rowCap);
  const baseCap = rowCap - caps.total;
  const perWindowCap = { current: Math.ceil(baseCap / 2), previous: Math.floor(baseCap / 2) };
  /** Current-window query impressions from the query+page slice (ranks queries for the weekly slice). */
  const currentQueryImpr = new Map<string, number>();

  const flush = async () => {
    for (let i = 0; i < insertedRows.length; i += 200) await ctx.db.batch(insertedRows.slice(i, i + 200));
    insertedRows.length = 0;
  };

  try {
  for (const which of ["current", "previous"] as const) {
    const w = windows[which];
    // (a) property totals
    const agg = await query({ startDate: w.start, endDate: w.end, dimensions: [], rowLimit: 1, startRow: 0 });
    if (agg === null) break;
    totals[which] = totalsFromAggregateRow(agg[0]);

    // (b) daily series (current window only)
    if (which === "current") {
      const daily = await query({ startDate: w.start, endDate: w.end, dimensions: ["date"], rowLimit: 1000, startRow: 0 });
      if (daily === null) break;
      const points = daily
        .map((r) => ({ date: String(r.keys[0] ?? ""), clicks: Math.round(r.clicks), impressions: Math.round(r.impressions) }))
        .filter((p) => p.date >= w.start && p.date <= w.end);
      missingDays = missingTrailingDays(points, w);
      for (const p of points) {
        insertedRows.push([
          "INSERT OR REPLACE INTO gsc_daily (sync_id, workspace_id, project_id, date, clicks, impressions) VALUES (?,?,?,?,?,?)",
          syncId, ctx.project.workspaceId, ctx.project.id, p.date, p.clicks, p.impressions,
        ]);
      }
      dailyRows = points.length;
      await flush();
    }

    // (c) slices within this window's row budget
    const windowCap = perWindowCap[which];
    const pageCap = Math.min(windowCap, Math.max(windowCap > 0 ? 1 : 0, Math.floor(windowCap * PAGE_SLICE_SHARE)));
    const slices: Array<{ dims: Array<"page" | "query">; cap: number }> = [
      { dims: ["page"], cap: pageCap },
      { dims: ["query", "page"], cap: 0 },
    ];
    let windowUsed = 0;
    for (const slice of slices) {
      const cap = slice.dims.length === 1 ? slice.cap : windowCap - windowUsed;
      let fetched = 0;
      let startRow = 0;
      while (fetched < cap) {
        const rowLimit = Math.min(pageSize, cap - fetched);
        const rows = await query({ startDate: w.start, endDate: w.end, dimensions: slice.dims, rowLimit, startRow });
        if (rows === null) break;
        const take = rows.slice(0, rowLimit);
        for (const r of take) {
          const [a, b] = r.keys;
          const q = slice.dims.length === 2 ? String(a ?? "") : null;
          const page = slice.dims.length === 2 ? String(b ?? "") : String(a ?? "");
          if (q && which === "current") currentQueryImpr.set(q, (currentQueryImpr.get(q) ?? 0) + Math.round(r.impressions));
          insertedRows.push([
            "INSERT INTO gsc_metrics (workspace_id, project_id, sync_id, window, query, page, device, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ctx.project.workspaceId, ctx.project.id, syncId, which, q, page || null, null,
            Math.round(r.clicks), Math.round(r.impressions), Number(r.ctr) || 0, Number(r.position) || 0,
          ]);
        }
        fetched += take.length;
        startRow += take.length;
        if (insertedRows.length >= 1000) await flush();
        if (take.length < rowLimit) break; // exhausted
        if (fetched >= cap) {
          truncated = true; // cap reached while Google still returned full pages
          break;
        }
      }
      windowUsed += fetched;
      totalRows += fetched;
      await flush();
      if (outcome.kind !== "ok") break;
    }
    if (outcome.kind !== "ok") break;
  }
  await flush();

  // (d)-(g) extra slices, stored in totals_json.extras.
  if (outcome.kind === "ok") {
    const extras: ExtrasJson = { version: EXTRA_SLICES_VERSION, notes: [] };
    totals.extras = extras;
    if (caps.total === 0) {
      extras.notes.push(`Row cap below ${EXTRA_SLICES_MIN_CAP.toLocaleString("en-US")}: year-over-year, weekly query/page, and country slices were skipped.`);
    } else {
      const fetchSlice = async (dims: GscQueryRequest["dimensions"], w: { start: string; end: string }, cap: number): Promise<{ rows: GscRow[]; truncated: boolean } | null> => {
        const out: GscRow[] = [];
        let startRow = 0;
        let truncatedHere = false;
        while (out.length < cap) {
          const rowLimit = Math.min(pageSize, cap - out.length);
          const rows = await query({ startDate: w.start, endDate: w.end, dimensions: dims, rowLimit, startRow });
          if (rows === null) return out.length ? { rows: out, truncated: true } : null;
          const take = rows.slice(0, rowLimit);
          out.push(...take);
          startRow += take.length;
          if (take.length < rowLimit) break;
          if (out.length >= cap) truncatedHere = true;
        }
        totalRows += out.length;
        return { rows: out, truncated: truncatedHere };
      };
      const cur = windows.current;

      // (d) query + page + date, aggregated to weeks for the top queries.
      const qpd = await fetchSlice(["query", "page", "date"], cur, caps.queryPageDate);
      if (qpd) {
        const rows = qpd.rows.map((r) => ({ query: String(r.keys[0] ?? ""), page: String(r.keys[1] ?? ""), date: String(r.keys[2] ?? ""), clicks: r.clicks, impressions: r.impressions }));
        const rank = currentQueryImpr.size > 0 ? currentQueryImpr : rows.reduce((m, r) => m.set(r.query, (m.get(r.query) ?? 0) + Math.round(r.impressions)), new Map<string, number>());
        const top = new Set([...rank.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, QPD_TOP_QUERIES).map(([q]) => q));
        extras.queryPageWeeks = { window: cur, weekStarts: weekStartsOf(cur), topQueries: top.size, fetchedRows: rows.length, rows: aggregateQueryPageWeeks(rows, cur, top), truncated: qpd.truncated };
      }

      // (e) year-over-year probe, then the page slice only when last year's window is covered.
      if (outcome.kind === "ok") {
        const ly = yoyWindow(cur);
        const windowDays = daysInWindow(ly);
        const probe = await query({ startDate: ly.start, endDate: ly.end, dimensions: ["date"], rowLimit: windowDays, startRow: 0 });
        if (probe !== null) {
          const days = probe.filter((r) => String(r.keys[0] ?? "") >= ly.start && String(r.keys[0] ?? "") <= ly.end && r.impressions > 0);
          const daysWithData = new Set(days.map((r) => String(r.keys[0]))).size;
          const lyTotals = days.length ? { clicks: days.reduce((n, r) => n + Math.round(r.clicks), 0), impressions: days.reduce((n, r) => n + Math.round(r.impressions), 0) } : null;
          const covered = daysWithData >= Math.ceil(windowDays * YOY_MIN_DAY_COVERAGE);
          extras.yoy = { window: ly, status: covered ? "available" : daysWithData > 0 ? "partial_history" : "no_history", daysWithData, windowDays, totals: lyTotals, pages: [], truncated: false };
          if (covered) {
            const pages = await fetchSlice(["page"], ly, caps.yoyPages);
            if (pages) {
              extras.yoy.pages = pages.rows.map((r) => [String(r.keys[0] ?? ""), Math.round(r.clicks), Math.round(r.impressions), Number(r.position) || 0]);
              extras.yoy.truncated = pages.truncated;
            }
          } else {
            extras.notes.push(`Same window last year (${windowLabel(ly)}) has data on ${daysWithData} of ${windowDays} days; year-over-year comparison is unavailable.`);
          }
        }
      }

      // (f) countries and (g) country + page.
      if (outcome.kind === "ok") {
        const countries = await fetchSlice(["country"], cur, caps.countries);
        if (countries) extras.countries = { window: cur, rows: countries.rows.map((r) => [String(r.keys[0] ?? "").toLowerCase(), Math.round(r.clicks), Math.round(r.impressions)]), truncated: countries.truncated };
      }
      if (outcome.kind === "ok") {
        const cp = await fetchSlice(["country", "page"], cur, caps.countryPages);
        if (cp) extras.countryPages = { window: cur, rows: cp.rows.map((r) => [String(r.keys[0] ?? "").toLowerCase(), String(r.keys[1] ?? ""), Math.round(r.clicks), Math.round(r.impressions)]), truncated: cp.truncated };
      }
    }
  }
  } catch (e) {
    // Unexpected failure (e.g. storage): keep what was committed and finalize the sync row below,
    // so it never stays 'running' and the row budget is still settled.
    insertedRows.length = 0;
    outcome = { kind: "stopped", reason: "error", message: `GSC import failed: ${safeMessage(e)}` };
  }

  // Status
  const haveCurrentTotals = totals.current !== null;
  const noData = outcome.kind === "ok" && (!totals.current || totals.current.impressions === 0) && totalRows === 0;
  let status: GscSyncSummary["status"];
  if (noData) status = "no_data";
  // A missing previous window is not an import failure (new properties have no history); it is noted.
  else if (outcome.kind === "ok") status = "completed";
  else status = haveCurrentTotals ? "partial" : "failed";

  const notes: string[] = [];
  if (truncated) notes.push(`Row cap of ${rowCap.toLocaleString("en-US")} reached; lower-traffic query/page rows were not imported.`);
  if (missingDays > 0) notes.push(`${missingDays} trailing day(s) of the current window have no finalized data yet and are excluded.`);
  if (outcome.kind === "ok" && !totals.previous && !noData) notes.push("Previous window returned no data; comparisons are unavailable.");
  if (outcome.kind !== "ok") notes.push(outcome.message);
  totals.notes = notes;

  const error = outcome.kind !== "ok" ? outcome.message : null;
  await ctx.db.run(
    "UPDATE gsc_syncs SET status = ?, rows_fetched = ?, truncated = ?, totals_json = ?, error = ?, synced_at = ? WHERE id = ? AND workspace_id = ?",
    status,
    totalRows,
    truncated ? 1 : 0,
    JSON.stringify(totals),
    error,
    iso(ctx.clock()),
    syncId,
    ctx.project.workspaceId,
  );

  if (reservation !== null) {
    // Rows are the budget unit; a stopped request consumed nothing beyond what was returned.
    await ctx.budget.settle(reservation, totalRows);
  }

  if (status === "completed" || status === "partial") await pruneOldSlices(ctx, syncId);

  const note =
    status === "no_data"
      ? "Search Console returned no rows for the finalized windows."
      : `${totalRows.toLocaleString("en-US")} rows imported in ${requests} requests${truncated ? " (row cap reached)" : ""}; ${dailyRows} daily points.${error ? ` ${error}` : ""}`;
  const logStatus = status === "completed" ? "completed" : status === "no_data" ? "info" : status === "partial" ? "partial" : "failed";
  await ctx.log.event("gsc_sync", logStatus, note);
  return { syncId, rows: totalRows, truncated, status, note };
}

/** Retention: keep slice rows only for the newest KEEP_SLICE_SYNCS API syncs of this project. */
async function pruneOldSlices(ctx: RunContext, keepSyncId: string): Promise<void> {
  const old = await ctx.db.all<{ id: string }>(
    `SELECT id FROM gsc_syncs WHERE workspace_id = ? AND project_id = ? AND source = 'api' AND id != ?
      ORDER BY synced_at DESC LIMIT -1 OFFSET ?`,
    ctx.project.workspaceId,
    ctx.project.id,
    keepSyncId,
    KEEP_SLICE_SYNCS - 1,
  );
  for (const { id } of old) {
    await ctx.db.run("DELETE FROM gsc_metrics WHERE workspace_id = ? AND project_id = ? AND sync_id = ?", ctx.project.workspaceId, ctx.project.id, id);
    // Extra slices live in totals_json.extras: drop them with the slice rows, keep totals and notes.
    const row = await ctx.db.first<{ totals_json: string }>("SELECT totals_json FROM gsc_syncs WHERE id = ? AND workspace_id = ?", id, ctx.project.workspaceId);
    if (row && row.totals_json.includes('"extras"')) {
      const t = parseTotalsJson(row.totals_json);
      delete t.extras;
      await ctx.db.run("UPDATE gsc_syncs SET totals_json = ? WHERE id = ? AND workspace_id = ?", JSON.stringify(t), id, ctx.project.workspaceId);
    }
  }
}

export function isQuotaError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const o = e as { status?: unknown; code?: unknown; message?: unknown };
  if (o.status === 429 || o.code === 429 || o.code === "429" || o.code === "rate_limited" || o.code === "quota_exceeded") return true;
  const msg = typeof o.message === "string" ? o.message : "";
  return /\b429\b|quota|rate ?limit|rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(msg);
}

/** Error text without anything token-like; capped. */
export function safeMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error";
  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/ya29\.[\w.-]+/g, "[redacted]")
    .replace(/(access_token|refresh_token|key)=[^&\s]+/gi, "$1=[redacted]")
    .slice(0, 160);
}
