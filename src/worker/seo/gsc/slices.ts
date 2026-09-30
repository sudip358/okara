/**
 * Extra Search Console slices [A23]/[A25], stored compactly in `gsc_syncs.totals_json.extras` (so they
 * are exported and deleted with their sync and pruned with old slices; no schema change):
 *
 *   yoy             same 28 days one year earlier (current window shifted back YOY_SHIFT_DAYS = 364 days,
 *                   52 whole weeks so weekdays line up): a cheap ['date'] probe first; only when the
 *                   property has data on >= YOY_MIN_DAY_COVERAGE of those days is the ['page'] slice fetched.
 *   queryPageWeeks  ['query','page','date'] for the current window, aggregated to 7-day weeks from the
 *                   window start and kept only for the top QPD_TOP_QUERIES queries by current impressions.
 *   countries       ['country'] for the current window.
 *   countryPages    ['country','page'] for the current window.
 *
 * Row budget: extras are carved out of the project row cap before the base slices (EXTRA_SHARES, only
 * when the cap is at least EXTRA_SLICES_MIN_CAP), so a sync never exceeds the cap. Rows are stored as
 * tuples to keep the JSON small. Every slice records whether it was truncated at its cap.
 */
import type { DateWindow } from "@shared/types";
import { addDays } from "../../lib/time";
import { daysInWindow } from "./windows";

export const EXTRA_SLICES_VERSION = "gsc-extra-slices-2026-09-30.1";
export const YOY_SHIFT_DAYS = 364;
export const YOY_MIN_DAY_COVERAGE = 0.9;
export const QPD_TOP_QUERIES = 200;
/** Extras run only when the row cap leaves room for them; smaller caps go to the base slices. */
export const EXTRA_SLICES_MIN_CAP = 1000;
/** Shares of the project row cap reserved for each extra slice (documented engineering defaults). */
export const EXTRA_SHARES = { queryPageDate: 0.1, yoyPages: 0.1, countries: 0.02, countryPages: 0.04 } as const;
/** Countries are few; never reserve more rows than there are country codes. */
export const MAX_COUNTRY_ROWS = 250;

export type PageTuple = [page: string, clicks: number, impressions: number, position: number];
export type WeekTuple = [query: string, week: number, page: string, clicks: number, impressions: number];
export type CountryTuple = [country: string, clicks: number, impressions: number];
export type CountryPageTuple = [country: string, page: string, clicks: number, impressions: number];

export interface YoyJson {
  window: DateWindow;
  status: "available" | "no_history" | "partial_history" | "skipped";
  daysWithData: number;
  windowDays: number;
  /** Sum of the probe's per-day property rows (clicks/impressions only; position is not re-aggregated). */
  totals: { clicks: number; impressions: number } | null;
  pages: PageTuple[];
  truncated: boolean;
}

export interface QueryPageWeeksJson {
  window: DateWindow;
  weekStarts: string[];
  topQueries: number;
  fetchedRows: number;
  rows: WeekTuple[];
  truncated: boolean;
}

export interface CountriesJson {
  window: DateWindow;
  rows: CountryTuple[];
  truncated: boolean;
}

export interface CountryPagesJson {
  window: DateWindow;
  rows: CountryPageTuple[];
  truncated: boolean;
}

export interface ExtrasJson {
  version: string;
  yoy?: YoyJson;
  queryPageWeeks?: QueryPageWeeksJson;
  countries?: CountriesJson;
  countryPages?: CountryPagesJson;
  notes: string[];
}

export function yoyWindow(current: DateWindow): DateWindow {
  return { start: addDays(current.start, -YOY_SHIFT_DAYS), end: addDays(current.end, -YOY_SHIFT_DAYS) };
}

/** Row caps for the extra slices under a project row cap (0 = slice skipped). */
export function extraCaps(rowCap: number): { queryPageDate: number; yoyPages: number; countries: number; countryPages: number; total: number } {
  if (rowCap < EXTRA_SLICES_MIN_CAP) return { queryPageDate: 0, yoyPages: 0, countries: 0, countryPages: 0, total: 0 };
  const queryPageDate = Math.floor(rowCap * EXTRA_SHARES.queryPageDate);
  const yoyPages = Math.floor(rowCap * EXTRA_SHARES.yoyPages);
  const countries = Math.min(MAX_COUNTRY_ROWS, Math.floor(rowCap * EXTRA_SHARES.countries));
  const countryPages = Math.floor(rowCap * EXTRA_SHARES.countryPages);
  return { queryPageDate, yoyPages, countries, countryPages, total: queryPageDate + yoyPages + countries + countryPages };
}

// ------------------------------------------------------------------ parsing (defensive: old syncs have no extras)
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isWindow = (v: unknown): v is DateWindow => !!v && typeof v === "object" && isStr((v as DateWindow).start) && isStr((v as DateWindow).end);

function tuples<T extends unknown[]>(v: unknown, shape: Array<"s" | "n">): T[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is T => Array.isArray(t) && t.length === shape.length && shape.every((k, i) => (k === "s" ? isStr(t[i]) : isNum(t[i]))));
}

export function parseExtras(raw: unknown): ExtrasJson | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const out: ExtrasJson = { version: isStr(o.version) ? o.version : "unknown", notes: Array.isArray(o.notes) ? o.notes.filter(isStr) : [] };
  const y = o.yoy as Record<string, unknown> | undefined;
  if (y && isWindow(y.window) && isStr(y.status)) {
    const t = y.totals as { clicks?: unknown; impressions?: unknown } | null | undefined;
    out.yoy = {
      window: y.window,
      status: (["available", "no_history", "partial_history", "skipped"].includes(y.status) ? y.status : "skipped") as YoyJson["status"],
      daysWithData: isNum(y.daysWithData) ? y.daysWithData : 0,
      windowDays: isNum(y.windowDays) ? y.windowDays : 0,
      totals: t && isNum(t.clicks) && isNum(t.impressions) ? { clicks: t.clicks, impressions: t.impressions } : null,
      pages: tuples<PageTuple>(y.pages, ["s", "n", "n", "n"]),
      truncated: y.truncated === true,
    };
  }
  const w = o.queryPageWeeks as Record<string, unknown> | undefined;
  if (w && isWindow(w.window)) {
    out.queryPageWeeks = {
      window: w.window,
      weekStarts: Array.isArray(w.weekStarts) ? w.weekStarts.filter(isStr) : [],
      topQueries: isNum(w.topQueries) ? w.topQueries : 0,
      fetchedRows: isNum(w.fetchedRows) ? w.fetchedRows : 0,
      rows: tuples<WeekTuple>(w.rows, ["s", "n", "s", "n", "n"]),
      truncated: w.truncated === true,
    };
  }
  const c = o.countries as Record<string, unknown> | undefined;
  if (c && isWindow(c.window)) out.countries = { window: c.window, rows: tuples<CountryTuple>(c.rows, ["s", "n", "n"]), truncated: c.truncated === true };
  const cp = o.countryPages as Record<string, unknown> | undefined;
  if (cp && isWindow(cp.window)) out.countryPages = { window: cp.window, rows: tuples<CountryPageTuple>(cp.rows, ["s", "s", "n", "n"]), truncated: cp.truncated === true };
  return out;
}

// ------------------------------------------------------------------ weekly aggregation (query + page + date)
/** Start dates of the 7-day weeks of a window (the last week may be shorter). */
export function weekStartsOf(window: DateWindow): string[] {
  const n = daysInWindow(window);
  const out: string[] = [];
  for (let i = 0; i < n; i += 7) out.push(addDays(window.start, i));
  return out;
}

export function weekIndexOf(date: string, window: DateWindow): number | null {
  if (date < window.start || date > window.end) return null;
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${window.start}T00:00:00Z`)) / 86400_000);
  return Math.floor(days / 7);
}

/**
 * Sum ['query','page','date'] rows into (query, week, page) tuples, keeping only `keepQueries` when given
 * (keys compared as-is; Search Console returns the same query string in every slice).
 */
export function aggregateQueryPageWeeks(
  rows: Array<{ query: string; page: string; date: string; clicks: number; impressions: number }>,
  window: DateWindow,
  keepQueries: Set<string> | null,
): WeekTuple[] {
  const acc = new Map<string, WeekTuple>();
  for (const r of rows) {
    if (keepQueries && !keepQueries.has(r.query)) continue;
    const w = weekIndexOf(r.date, window);
    if (w === null || !r.query || !r.page) continue;
    const k = `${r.query}\u0000${w}\u0000${r.page}`;
    const t = acc.get(k) ?? [r.query, w, r.page, 0, 0];
    t[3] += Math.round(r.clicks);
    t[4] += Math.round(r.impressions);
    acc.set(k, t);
  }
  return [...acc.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || b[4] - a[4]));
}

// ------------------------------------------------------------------ alternating ranking URLs [A25] -> [A15]
export const ALTERNATING_METHOD_VERSION = "alternating-urls-2026-09-30.1";
export const ALTERNATING_MIN_CHANGES = 2;

export interface AlternatingQuery {
  query: string;
  /** Winning page per week that had impressions, in week order. */
  weeks: Array<{ week: number; weekStart: string | null; page: string; clicks: number; impressions: number }>;
  changes: number;
  pages: string[];
}

/**
 * Method (ALTERNATING_METHOD_VERSION): per query and 7-day week, the "top page" is the page with the
 * most clicks (ties: more impressions, then URL order). Weeks without impressions are skipped. A query
 * is flagged when the top page changes at least ALTERNATING_MIN_CHANGES times across consecutive weeks
 * with data (for example A, B, A), i.e. different URLs alternate as the ranking URL.
 */
export function detectAlternatingUrls(json: QueryPageWeeksJson, normalize: (u: string) => string = (u) => u): AlternatingQuery[] {
  const byQuery = new Map<string, Map<number, Map<string, { clicks: number; impressions: number; raw: string }>>>();
  for (const [q, w, p, c, i] of json.rows) {
    if (i <= 0) continue;
    const weeks = byQuery.get(q) ?? new Map();
    const pages = weeks.get(w) ?? new Map();
    const k = normalize(p);
    const cur = pages.get(k) ?? { clicks: 0, impressions: 0, raw: p };
    cur.clicks += c;
    cur.impressions += i;
    pages.set(k, cur);
    weeks.set(w, pages);
    byQuery.set(q, weeks);
  }
  const out: AlternatingQuery[] = [];
  for (const [query, weeks] of byQuery) {
    const seq: AlternatingQuery["weeks"] = [];
    for (const w of [...weeks.keys()].sort((a, b) => a - b)) {
      const best = [...weeks.get(w)!.entries()].sort((a, b) => b[1].clicks - a[1].clicks || b[1].impressions - a[1].impressions || (a[0] < b[0] ? -1 : 1))[0]!;
      seq.push({ week: w, weekStart: json.weekStarts[w] ?? null, page: best[0], clicks: best[1].clicks, impressions: best[1].impressions });
    }
    let changes = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i]!.page !== seq[i - 1]!.page) changes++;
    const pages = [...new Set(seq.map((s) => s.page))];
    if (changes >= ALTERNATING_MIN_CHANGES && pages.length >= 2) out.push({ query, weeks: seq, changes, pages });
  }
  return out.sort((a, b) => b.changes - a.changes || (a.query < b.query ? -1 : 1));
}
