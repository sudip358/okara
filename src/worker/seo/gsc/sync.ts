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
 * Limitations recorded on every sync: pagination does not guarantee complete query data (Google
 * omits anonymized queries and applies its own row limits), so slices never sum to property totals.
 * Quota/429 errors stop further requests immediately (no retry storm); what was fetched is kept and
 * the sync is 'partial' (or 'failed' if nothing usable was fetched).
 */
import type { RunContext } from "../../runs/context";
import type { GscQueryRequest, GscRow } from "../../providers/types";
import { BudgetExceededError } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { iso } from "../../lib/time";
import { finalizedWindows, GSC_DATA_STATE, windowLabel, type WindowOptions } from "./windows";
import { missingTrailingDays, totalsFromAggregateRow, type TotalsJson } from "./aggregate";

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
    `Importing ${property}: current ${windowLabel(windows.current)}, previous ${windowLabel(windows.previous)} (final data, row cap ${rowCap}).`,
  );

  let requests = 0;
  let outcome: Outcome = { kind: "ok" };
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
  const perWindowCap = { current: Math.ceil(rowCap / 2), previous: Math.floor(rowCap / 2) };

  const flush = async () => {
    for (let i = 0; i < insertedRows.length; i += 200) await ctx.db.batch(insertedRows.slice(i, i + 200));
    insertedRows.length = 0;
  };

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

  // Status
  const haveCurrentTotals = totals.current !== null;
  const noData = outcome.kind === "ok" && (!totals.current || totals.current.impressions === 0) && totalRows === 0;
  let status: GscSyncSummary["status"];
  if (noData) status = "no_data";
  else if (outcome.kind === "ok") status = totals.previous ? "completed" : "partial";
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
