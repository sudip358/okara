/**
 * GSC aggregation rules (documented, tested):
 *  - CTR for any aggregate = sum(clicks) / sum(impressions). Never the mean of row CTRs.
 *    Zero impressions -> Ratio.value null (unavailable, not 0%).
 *  - Average position is taken only from the API's property-level aggregate request (no dimensions),
 *    which Google computes itself. We never derive a property position from page/query slices.
 *  - Page/query slices are never summed into a property total: anonymized queries and the row cap
 *    make slices incomplete by design. Property totals come from `totals_json` only.
 *  - Daily points outside the finalized window (incomplete days) are excluded, not shown as zero.
 *
 * `gsc_syncs.totals_json` format (owned by this module; demo seeds must follow it):
 *   { current: WindowTotalsJson | null, previous: WindowTotalsJson | null,
 *     notes?: string[], provenance?: {...} }
 *   WindowTotalsJson = { clicks, impressions, ctr, position: number | null, derivedFrom?: string }
 */
import type { DateWindow, Ratio } from "@shared/types";

export interface WindowTotals {
  clicks: number;
  impressions: number;
  ctr: Ratio;
  position: number | null;
}

export interface WindowTotalsJson {
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  /** 'api_aggregate' (no-dimension request) or 'daily_chart_export' (sum of per-day property totals). */
  derivedFrom?: string;
}

export interface TotalsJson {
  current: WindowTotalsJson | null;
  previous: WindowTotalsJson | null;
  notes?: string[];
  provenance?: Record<string, unknown>;
}

export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator > 0 ? numerator / denominator : null };
}

export interface MetricRow {
  clicks: number;
  impressions: number;
}

/** Sum clicks/impressions and compute CTR as a ratio of sums. No position (see module note). */
export function aggregateRows(rows: MetricRow[]): { clicks: number; impressions: number; ctr: Ratio } {
  let clicks = 0;
  let impressions = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
  }
  return { clicks, impressions, ctr: ratio(clicks, impressions) };
}

/** Totals from the API's property aggregate row (request with no dimensions). */
export function totalsFromAggregateRow(row: { clicks: number; impressions: number; position: number } | undefined): WindowTotalsJson | null {
  if (!row) return null;
  const clicks = Math.round(row.clicks);
  const impressions = Math.round(row.impressions);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: impressions > 0 && Number.isFinite(row.position) ? row.position : null,
    derivedFrom: "api_aggregate",
  };
}

export function toWindowTotals(t: WindowTotalsJson | null | undefined): WindowTotals | null {
  if (!t || typeof t !== "object") return null;
  const clicks = Number(t.clicks) || 0;
  const impressions = Number(t.impressions) || 0;
  const position = typeof t.position === "number" && Number.isFinite(t.position) ? t.position : null;
  return { clicks, impressions, ctr: ratio(clicks, impressions), position };
}

export function parseTotalsJson(raw: unknown): TotalsJson {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      v = {};
    }
  }
  const o = (v && typeof v === "object" ? v : {}) as Partial<TotalsJson>;
  return {
    current: o.current ?? null,
    previous: o.previous ?? null,
    notes: Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === "string") : [],
    provenance: o.provenance && typeof o.provenance === "object" ? o.provenance : undefined,
  };
}

/** Keep only days inside the finalized window, sorted ascending, one point per date. */
export function excludeIncompleteDays<T extends { date: string }>(daily: T[], window: DateWindow): T[] {
  const byDate = new Map<string, T>();
  for (const d of daily) if (d.date >= window.start && d.date <= window.end) byDate.set(d.date, d);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Trailing dates of the window with no data: likely not finalized yet. */
export function missingTrailingDays(daily: Array<{ date: string }>, window: DateWindow): number {
  const kept = excludeIncompleteDays(daily, window);
  if (kept.length === 0) return 0;
  const last = kept[kept.length - 1]!.date;
  const ms = Date.parse(`${window.end}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86400_000));
}

// ------------------------------------------------------------------ slice helpers used by candidates
export interface SliceRow {
  window: "current" | "previous";
  query: string | null;
  page: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface EntityMetrics {
  clicks: number;
  impressions: number;
  ctr: Ratio;
  /** Impression-weighted mean of slice positions; a labelled approximation for candidate heuristics only. */
  approxPosition: number | null;
  rows: number;
  /** 'page_rows' (page-dimension slice) or 'query_page_rows' (lower bound: anonymized queries omitted). */
  basis: "page_rows" | "query_page_rows" | "query_rows";
}

/** Impression-weighted position across rows; used only inside heuristics, never as a property total. */
export function weightedPosition(rows: Array<{ impressions: number; position: number }>): number | null {
  let w = 0;
  let s = 0;
  for (const r of rows) {
    if (r.impressions > 0 && Number.isFinite(r.position)) {
      w += r.impressions;
      s += r.position * r.impressions;
    }
  }
  return w > 0 ? s / w : null;
}

function metricsOf(rows: SliceRow[], basis: EntityMetrics["basis"]): EntityMetrics {
  const a = aggregateRows(rows);
  return { ...a, approxPosition: weightedPosition(rows), rows: rows.length, basis };
}

/**
 * Per-page metrics for one window. Prefers page-dimension rows (which include anonymized-query
 * traffic); falls back to summing query+page rows, labelled as a lower bound.
 */
export function pageMetrics(rows: SliceRow[], window: "current" | "previous", normalize: (u: string) => string): Map<string, EntityMetrics> {
  const pageRows = new Map<string, SliceRow[]>();
  const qpRows = new Map<string, SliceRow[]>();
  for (const r of rows) {
    if (r.window !== window || !r.page) continue;
    const key = normalize(r.page);
    const target = r.query === null ? pageRows : qpRows;
    const list = target.get(key) ?? [];
    list.push(r);
    target.set(key, list);
  }
  const out = new Map<string, EntityMetrics>();
  const hasPageSlice = pageRows.size > 0;
  if (hasPageSlice) for (const [k, list] of pageRows) out.set(k, metricsOf(list, "page_rows"));
  else for (const [k, list] of qpRows) out.set(k, metricsOf(list, "query_page_rows"));
  return out;
}
