/**
 * Live view feed cursors and merge (docs/api.md "Live view"). Same approach as runs/activity.ts: writers
 * stamp rows with times taken before the insert (per-batch Jev clocks, findings written at the end of a
 * crawl), so `at` is not insertion order and an (at, id) keyset would drop late rows. A cursor therefore
 * holds one insertion high-water mark (SQLite rowid) per source:
 *   SEO feed  {d: decision_records, f: audit_findings, r: recommendations, k?: crawl attempt}
 *   GEO feed  {o: geo_observations, r: recommendations, p?: rowids of answers sent before their analysis}
 * Each source reads rows with rowid above its mark, in rowid order, LIMITed. `mergeMarked` takes heads by the
 * smallest (at, id), so every source contributes a rowid prefix and its mark advances exactly over the rows
 * taken. Rows read but not shown (payload null) advance their mark without counting toward the limit.
 * The key set identifies the route: a cursor of one feed (or of the activity feed) is 400 on the other.
 */
import { badRequest } from "../lib/errors";

export const LIVE_DEFAULT_LIMIT = 100;
export const LIVE_MAX_LIMIT = 200;
const CURSOR_MAX_CHARS = 400;

export type Marks<K extends string> = Record<K, number>;

export function encodeLiveCursor(marks: Record<string, number | number[]>): string {
  return btoa(JSON.stringify(marks)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Longest integer list a cursor may carry (`lists` keys of decodeLiveCursor). */
export const CURSOR_LIST_MAX = 20;

/**
 * Decodes an opaque live cursor whose keys must be exactly `keys` (plus any of `optional` and `lists`); every
 * value a non-negative safe integer, and every `lists` value an array of at most CURSOR_LIST_MAX of them.
 * Returns null when absent; throws 400 on anything else.
 */
export function decodeLiveCursor<K extends string, O extends string = never, L extends string = never>(
  raw: string | null | undefined,
  keys: readonly K[],
  optional: readonly O[] = [],
  lists: readonly L[] = [],
): (Marks<K> & Partial<Marks<O>> & Partial<Record<L, number[]>>) | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const invalid = () => badRequest("Invalid live cursor.");
  let parsed: unknown;
  try {
    if (raw.length > CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("bad");
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    parsed = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid();
  const obj = parsed as Record<string, unknown>;
  const present = Object.keys(obj);
  const allowed = new Set<string>([...keys, ...optional, ...lists]);
  if (!keys.every((k) => present.includes(k)) || present.some((k) => !allowed.has(k))) throw invalid();
  const isMark = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const out: Record<string, number | number[]> = {};
  for (const k of present) {
    const v = obj[k];
    if ((lists as readonly string[]).includes(k)) {
      if (!Array.isArray(v) || v.length > CURSOR_LIST_MAX || !v.every(isMark)) throw invalid();
      out[k] = v as number[];
    } else {
      if (!isMark(v)) throw invalid();
      out[k] = v;
    }
  }
  return out as Marks<K> & Partial<Marks<O>> & Partial<Record<L, number[]>>;
}

export function parseLiveLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return LIVE_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest("limit must be a positive integer.", { field: "limit" });
  return Math.min(n, LIVE_MAX_LIMIT);
}

/** One row read from a source: `payload` null = read but not shown (still advances the mark). */
export interface MarkedEntry<P> {
  rid: number;
  at: string;
  id: string;
  payload: P | null;
}

export function compareAtId(a: { at: string; id: string }, b: { at: string; id: string }): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merges per-source streams (each in rowid order) into at most `limit` shown rows, always taking the head
 * with the smallest (at, id). Hidden rows (payload null) are consumed without counting. Returns the shown
 * rows in merge order with their source, the new marks, and whether every stream was consumed.
 */
export function mergeMarked<K extends string, P>(
  streams: Partial<Record<K, Array<MarkedEntry<P>>>>,
  from: Marks<K>,
  limit: number,
): { taken: Array<{ source: K; entry: MarkedEntry<P> & { payload: P } }>; marks: Marks<K>; exhausted: boolean } {
  const marks = { ...from };
  const keys = Object.keys(streams) as K[];
  const pos = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const taken: Array<{ source: K; entry: MarkedEntry<P> & { payload: P } }> = [];
  for (;;) {
    let best: K | null = null;
    for (const k of keys) {
      const head = streams[k]![pos[k]];
      if (!head) continue;
      if (best === null || compareAtId(head, streams[best]![pos[best]]!) < 0) best = k;
    }
    if (best === null) return { taken, marks, exhausted: true };
    const entry = streams[best]![pos[best]]!;
    if (entry.payload !== null && taken.length >= limit) return { taken, marks, exhausted: false };
    pos[best]++;
    marks[best] = Math.max(marks[best], entry.rid);
    if (entry.payload !== null) taken.push({ source: best, entry: entry as MarkedEntry<P> & { payload: P } });
  }
}
