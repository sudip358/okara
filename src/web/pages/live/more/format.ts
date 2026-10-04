/**
 * Labels for the Live view's project containers (docs/live-view-design.md section 17). Pure string helpers,
 * unit-tested. Counts are "n of m" with both numbers; differences are measured differences between two stored
 * windows (never arrows or projections); every caption says where the data comes from and that it is not
 * part of the run on screen when it is not.
 */
import type { LiveGscMetrics, LiveHistoryCell, LiveSheetSyncRow } from "@shared/types";
import { fmtInt, fmtUsd, shortDate } from "../text";

/** "4 of 12" */
export const nOfM = (n: number, m: number) => `${fmtInt(n)} of ${fmtInt(m)}`;

/** "+4", "−3", "0" (a measured difference). */
export function signed(n: number, digits = 0): string {
  if (!Number.isFinite(n) || Math.abs(n) < 10 ** -digits / 2) return "0";
  const v = digits ? Math.abs(n).toFixed(digits) : fmtInt(Math.abs(n));
  return `${n > 0 ? "+" : "−"}${v}`;
}

/** usage_counters usd_micros → "$0.12" (or "$0.0012"). */
export const usdMicros = (micros: number) => fmtUsd(micros / 1_000_000);

/**
 * "pos 12.3 · 340 impr." for a query row; "pos ≈ 12.3 · 340 impr." for sums over the query's query+page rows
 * (the position is then impression-weighted across your pages; the caption says how impressions were summed).
 */
export function gscMatchText(gsc: LiveGscMetrics): string {
  const pos = gsc.position === null ? "pos —" : `pos ${gsc.basis === "query_rows" ? "" : "≈ "}${gsc.position.toFixed(1)}`;
  return `${pos} · ${fmtInt(gsc.impressions)} impr.`;
}

/** "4 Sep–3 Oct" for an ISO instant window. */
export function instantRange(from: string, to: string): string {
  return `${shortDate(from)}–${shortDate(to)}`;
}

// ------------------------------------------------------------------ prompt history cells
export const HISTORY_CELL: Record<LiveHistoryCell, { letter: string; word: string; cls: string }> = {
  cited: { letter: "C", word: "cited", cls: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-zinc-950" },
  named: { letter: "N", word: "mentioned, site not cited", cls: "bg-amber-400 text-zinc-950 dark:bg-amber-400" },
  missing: { letter: "M", word: "absent", cls: "bg-rose-600 text-white dark:bg-rose-500 dark:text-zinc-950" },
  failed: { letter: "F", word: "no answer (call failed)", cls: "bg-zinc-500 text-white dark:bg-zinc-500" },
  not_analysed: { letter: "?", word: "stored, not analysed", cls: "lv-hatch border border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300" },
  none: { letter: "–", word: "no answer stored", cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
};

/** Accessible name of one engine's history cells: "Gemini, last 3 runs: 29 Sep cited, 30 Sep absent, 1 Oct cited". */
export function historyLabel(engine: string, cells: readonly LiveHistoryCell[], runs: ReadonlyArray<{ at: string }>): string {
  if (cells.length === 0) return `${engine}: no runs with stored answers`;
  const parts = cells.map((c, i) => `${shortDate(runs[i]?.at)} ${HISTORY_CELL[c].word}`);
  return `${engine}, last ${cells.length} run${cells.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

// ------------------------------------------------------------------ sheet syncs
/** Also labels a "backlinks" sync (backlink monitor [A38]); the shared row type lists the original three. */
export const DESTINATION_LABEL: Record<LiveSheetSyncRow["destination"], string> & Partial<Record<string, string>> = {
  competitors: "Competitors",
  geo_prompts: "AI questions (GEO prompts)",
  implemented_links: "Placed internal links",
  backlinks: "Backlinks to monitor",
};

export function syncState(row: Pick<LiveSheetSyncRow, "enabled" | "lastStatus" | "lastErrorCode">): { label: string; tone: "keep" | "change" | "review" | "none" } {
  if (row.lastStatus === "error") return { label: `Error${row.lastErrorCode ? `: ${row.lastErrorCode.replace(/_/g, " ")}` : ""}`, tone: "change" };
  if (!row.enabled) return { label: row.lastStatus === "ok" ? "Paused (last sync OK)" : "Paused", tone: "none" };
  if (row.lastStatus === "never") return { label: "Not synced yet", tone: "review" };
  return { label: "OK", tone: "keep" };
}

/** "+2 · ~1 · −1 in 7 days (1 sync import)" or "No changes in 7 days". */
export function recentText(r: LiveSheetSyncRow["recent"]): string {
  if (r.added + r.updated + r.removed === 0) return `No changes in ${r.days} days`;
  return `+${fmtInt(r.added)} · ~${fmtInt(r.updated)} · −${fmtInt(r.removed)} in ${r.days} days (${fmtInt(r.imports)} sync import${r.imports === 1 ? "" : "s"})`;
}

// ------------------------------------------------------------------ freshness captions
/**
 * "From this run's Search Console sync (29 Sep)" when the shown run produced the data, else
 * "From your latest Search Console sync (29 Sep), not part of this run".
 */
export function sourceCaption(what: string, at: string | null | undefined, producedBy: string | null | undefined, shownRunId: string | null | undefined): string {
  const date = at ? ` (${shortDate(at)})` : "";
  if (producedBy && shownRunId && producedBy === shownRunId) return `From this run's ${what}${date}`;
  return `From your latest ${what}${date}, not part of this run`;
}

/** Budget, sheets and other "today / current" containers: always project-level. */
export function projectCaption(what: string, at?: string | null): string {
  return `From your ${what}${at ? ` (${shortDate(at)})` : ""}, not part of this run`;
}
