/**
 * Builds the SeoOverview API shape from stored syncs. Totals come only from totals_json (never from
 * summed slices). States: 'demo' for demo projects; 'setup_required' whenever no GSC/CSV data has
 * been imported (whether or not Search Console is connected; the completeness note says which);
 * 'error' when the only syncs failed; otherwise 'ready'.
 */
import type { CapabilityState, DateWindow, DemandCurve, SeoOverview } from "@shared/types";
import type { Db } from "../../lib/db";
import { excludeIncompleteDays, parseTotalsJson, toWindowTotals } from "./aggregate";
import { buildDemandCurve } from "./demand";
import { GSC_LIMITATIONS } from "./sync";
import { daysInWindow, windowLabel } from "./windows";

export interface SyncRow {
  id: string;
  source: "api" | "csv_import" | "demo";
  property: string | null;
  window_start: string;
  window_end: string;
  prev_window_start: string;
  prev_window_end: string;
  data_state: string;
  rows_fetched: number;
  row_cap: number;
  truncated: number;
  totals_json: string;
  status: "running" | "completed" | "partial" | "failed" | "no_data";
  error: string | null;
  synced_at: string;
}

const SYNC_COLUMNS =
  "id, source, property, window_start, window_end, prev_window_start, prev_window_end, data_state, rows_fetched, row_cap, truncated, totals_json, status, error, synced_at";

/** Latest sync with usable data (completed or partial), or null. */
export async function latestUsableSync(db: Db, workspaceId: string, projectId: string): Promise<SyncRow | null> {
  return db.first<SyncRow>(
    `SELECT ${SYNC_COLUMNS} FROM gsc_syncs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial')
      ORDER BY synced_at DESC LIMIT 1`,
    workspaceId,
    projectId,
  );
}

export async function buildSeoOverview(
  db: Db,
  project: { id: string; workspace_id: string; gsc_property: string | null; is_demo: number; language?: string | null },
): Promise<SeoOverview> {
  const ws = project.workspace_id;
  const history = await db.all<SyncRow>(
    `SELECT ${SYNC_COLUMNS} FROM gsc_syncs WHERE workspace_id = ? AND project_id = ? ORDER BY synced_at DESC LIMIT 50`,
    ws,
    project.id,
  );
  const latestAny = history[0] ?? null;
  const latest = history.find((s) => s.status === "completed" || s.status === "partial" || s.status === "no_data") ?? null;
  const connection = await db.first<{ status: string }>(
    "SELECT status FROM oauth_connections WHERE workspace_id = ? AND project_id = ? AND provider = 'google_gsc'",
    ws,
    project.id,
  );
  const connected = connection?.status === "connected" && !!project.gsc_property;

  const limitations = [...GSC_LIMITATIONS];
  const empty: SeoOverview = {
    state: "setup_required",
    source: null,
    property: project.gsc_property,
    syncedAt: null,
    current: null,
    previous: null,
    totals: { current: null, previous: null },
    daily: [],
    annotations: [],
    truncated: false,
    completeness: { note: "No Search Console data imported yet.", covered: null, total: null },
    visitsRevenue: { state: "not_connected" },
    limitations,
    demandCurve: null,
  };

  const isDemo = project.is_demo === 1;
  if (!latest) {
    if (latestAny?.status === "failed") {
      return {
        ...empty,
        state: isDemo ? "demo" : "error",
        syncedAt: latestAny.synced_at,
        completeness: { note: `Last Search Console sync failed: ${latestAny.error ?? "unknown error"}`, covered: null, total: null },
      };
    }
    return {
      ...empty,
      state: isDemo ? "demo" : "setup_required",
      completeness: {
        note: connected
          ? "Search Console is connected; no data has been imported yet (waiting for the first sync)."
          : "Connect Search Console or import a CSV export to see search performance.",
        covered: null,
        total: null,
      },
    };
  }

  const totals = parseTotalsJson(latest.totals_json);
  const current: DateWindow = { start: latest.window_start, end: latest.window_end };
  const previous: DateWindow = { start: latest.prev_window_start, end: latest.prev_window_end };
  const dailyRows = await db.all<{ date: string; clicks: number; impressions: number }>(
    "SELECT date, clicks, impressions FROM gsc_daily WHERE workspace_id = ? AND project_id = ? AND sync_id = ? ORDER BY date",
    ws,
    project.id,
    latest.id,
  );
  const daily = excludeIncompleteDays(dailyRows, current).map((d) => ({ date: d.date, clicks: d.clicks, impressions: d.impressions }));

  const rows = latest.rows_fetched;
  const truncated = latest.truncated === 1;
  const rowsText = `${rows.toLocaleString("en-US")} rows imported`;
  const detail = truncated ? "row cap reached; anonymized queries excluded" : "anonymized queries excluded";
  const sourceText = latest.source === "csv_import" ? " from a CSV export" : latest.source === "demo" ? " (demo data)" : "";
  const completenessNote =
    latest.status === "no_data"
      ? `Search Console returned no data for ${windowLabel(current)}.`
      : `${rowsText}${sourceText} (${detail}); ${daily.length} of ${daysInWindow(current)} days in ${windowLabel(current)}.`;

  for (const n of totals.notes ?? []) if (!limitations.includes(n)) limitations.push(n);
  if (latest.source === "csv_import") {
    limitations.push("Source: user-uploaded Search Console CSV export, not an API sync. Average position is unavailable for CSV imports.");
  }
  if (latestAny && latestAny.id !== latest.id && latestAny.status === "failed") {
    limitations.push(`The most recent sync (${latestAny.synced_at}) failed: ${latestAny.error ?? "unknown error"}. Showing the previous successful sync.`);
  }

  const state: CapabilityState = latest.source === "demo" || isDemo ? "demo" : "ready";
  const demandCurve = latest.status === "no_data" ? null : await loadDemandCurve(db, ws, project.id, latest, project.language ?? "en");
  if (demandCurve && latest.source !== "csv_import") {
    limitations.push(
      "Demand curve: query totals are summed from query+page rows, which Search Console aggregates by page, so a search that showed two of your URLs counts once per URL.",
    );
  }

  return {
    state,
    source: latest.source,
    property: latest.property ?? project.gsc_property,
    syncedAt: latest.synced_at,
    current,
    previous,
    totals: { current: toWindowTotals(totals.current), previous: toWindowTotals(totals.previous) },
    daily,
    annotations: configAnnotations(history),
    truncated,
    completeness: { note: completenessNote, covered: rows, total: null },
    visitsRevenue: { state: "not_connected" },
    limitations,
    demandCurve,
  };
}

/** Current-window query-level demand curve for a sync; null when the sync has no query rows. */
export async function loadDemandCurve(db: Db, workspaceId: string, projectId: string, sync: SyncRow, language: string): Promise<DemandCurve | null> {
  const rows = await db.all<{ query: string; clicks: number; impressions: number }>(
    `SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM gsc_metrics
      WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'current' AND query IS NOT NULL
      GROUP BY query`,
    workspaceId,
    projectId,
    sync.id,
  );
  return buildDemandCurve(rows, {
    source: sync.source,
    window: { start: sync.window_start, end: sync.window_end },
    truncated: sync.truncated === 1,
    language,
  });
}

/** Annotate configuration changes between consecutive syncs: property or source switches. */
export function configAnnotations(historyDesc: SyncRow[]): Array<{ date: string; label: string }> {
  const asc = historyDesc.filter((s) => s.status !== "running").slice().reverse();
  const out: Array<{ date: string; label: string }> = [];
  for (let i = 1; i < asc.length; i++) {
    const prev = asc[i - 1]!;
    const cur = asc[i]!;
    const date = cur.synced_at.slice(0, 10);
    if ((prev.property ?? null) !== (cur.property ?? null) && prev.property && cur.property) {
      out.push({ date, label: `Search Console property changed from ${prev.property} to ${cur.property}` });
    }
    if (prev.source !== cur.source) {
      out.push({ date, label: `Data source changed from ${sourceLabel(prev.source)} to ${sourceLabel(cur.source)}` });
    }
  }
  return out;
}

const sourceLabel = (s: SyncRow["source"]) => (s === "api" ? "API sync" : s === "csv_import" ? "CSV import" : "demo data");

