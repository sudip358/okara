/**
 * The site's own search demand curve ("fat head / chunky middle / long tail"), built only from
 * first-party Search Console impressions in the current window. Pure: rows in, DemandCurve out.
 * It describes where this site is already visible, not market search volume.
 *
 * Method (DEMAND_METHOD_VERSION):
 *  1. Aggregate current-window query rows by normalized query (trimmed, lowercased, whitespace
 *     collapsed): Σclicks, Σimpressions. For API syncs these are ['query','page'] rows summed across
 *     pages (Search Console aggregates those by page, so a search that showed two of the site's URLs
 *     counts once per URL); CSV "Queries" exports are already one row per query.
 *  2. Drop queries with zero impressions (nothing observed); if none remain, there is no curve (null).
 *  3. Rank by impressions desc; ties by clicks desc, then query text asc (deterministic).
 *  4. Segment by the cumulative impression share BEFORE each query (integer arithmetic, exact):
 *       head      cumBefore < 50% of total    -> the top queries needed to reach 50% of impressions
 *                                                (the query that crosses 50% is still head)
 *       middle    cumBefore < 80% of total    -> the next 30%
 *       long_tail otherwise                   -> the remaining 20%
 *     Edge cases: rank 1 is always head (a single query is a head-only curve); segments with no
 *     queries are still returned with zero counts and null ratios; a query larger than 50% on its
 *     own leaves the next query in the middle.
 *  5. Per segment: query count, Σimpressions, Σclicks, CTR = Σclicks/Σimpressions (null at 0),
 *     share of all impressions, median words per query, strong-intent share (see below), and up to
 *     five example queries (highest impressions first).
 *  6. Points for a log-scale chart: at most 200 (rank, impressions) pairs at log-spaced ranks, always
 *     including rank 1 and the last rank.
 *
 * Strong intent (STRONG_INTENT_VERSION) is a small heuristic list of commercial/transactional
 * modifiers ("buy", "price", "best", "vs", "review", "near me", "for <something>", "sale", ...). It is
 * English-only: for other languages strongIntentShare is unavailable (0/0 -> null), never guessed.
 * The share counts queries (not impressions) in the segment that contain a modifier.
 */
import type { DateWindow, DemandCurve, DemandSegment } from "@shared/types";
import { ratio } from "./aggregate";

export const DEMAND_METHOD_VERSION = "seo-demand-2026-09-30.1";
export const STRONG_INTENT_VERSION = "strong-intent-en-2026-09-30.1";
/** Cumulative impression-share cut points, in whole percent. */
export const HEAD_PCT = 50;
export const MIDDLE_PCT = 30;
export const MAX_DEMAND_POINTS = 200;
export const MAX_SEGMENT_EXAMPLES = 5;

export const DEMAND_SEGMENTATION =
  "Head: top queries up to 50% of impressions; middle: next 30%; long tail: remaining 20% (cut by cumulative share of this site's Search Console impressions).";
export const DEMAND_NOTE =
  "Impressions from your Search Console data for the stated window — not market search volume. Search volume and keyword difficulty need a separately enabled keyword data source.";

export const SEGMENT_LABEL: Record<DemandSegment, string> = { head: "head", middle: "middle", long_tail: "long-tail" };

// ------------------------------------------------------------------ strong-intent heuristic (English)
/** Single-word commercial/transactional modifiers (lowercase). */
export const STRONG_INTENT_WORDS: ReadonlySet<string> = new Set([
  "buy", "buying", "purchase", "order",
  "price", "prices", "pricing", "cost", "costs", "cheap", "cheapest", "affordable",
  "best", "top", "vs", "versus", "compare", "comparison",
  "review", "reviews",
  "discount", "discounts", "coupon", "coupons", "deal", "deals", "sale", "clearance",
  "shop", "shopping", "store", "wholesale",
]);
/** Multi-word modifiers and patterns. "for <word>" marks a use-case qualifier ("sconces for bathroom"). */
export const STRONG_INTENT_PATTERNS: readonly RegExp[] = [/\bnear me\b/u, /\bfor sale\b/u, /\bfor\s+\p{L}{2,}/u];

export function isEnglish(language: string | null | undefined): boolean {
  return /^en\b/i.test((language ?? "en").trim() || "en");
}

/** true/false for English queries; null (unavailable) for other languages. */
export function hasStrongIntentModifier(query: string, language: string | null | undefined = "en"): boolean | null {
  if (!isEnglish(language)) return null;
  const q = normalizeDemandQuery(query);
  for (const w of q.split(/[^\p{L}\p{N}]+/u)) if (w && STRONG_INTENT_WORDS.has(w)) return true;
  return STRONG_INTENT_PATTERNS.some((re) => re.test(q));
}

// ------------------------------------------------------------------ ranking
export interface DemandRow {
  query: string | null;
  clicks: number;
  impressions: number;
  /** When present, only 'current' rows are used. */
  window?: "current" | "previous";
}

export interface RankedQuery {
  query: string;
  key: string;
  clicks: number;
  impressions: number;
  rank: number;
  segment: DemandSegment;
  words: number;
  strongIntent: boolean | null;
}

export function normalizeDemandQuery(q: string): string {
  return q.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

const wordCount = (q: string) => q.split(" ").filter(Boolean).length;

/** Aggregate, drop zero-impression queries, rank, and segment. Pure. */
export function rankQueries(rows: DemandRow[], language: string | null | undefined = "en"): RankedQuery[] {
  const agg = new Map<string, { query: string; clicks: number; impressions: number }>();
  for (const r of rows) {
    if (r.window && r.window !== "current") continue;
    if (typeof r.query !== "string") continue;
    const key = normalizeDemandQuery(r.query);
    if (!key) continue;
    const a = agg.get(key) ?? { query: key, clicks: 0, impressions: 0 };
    a.clicks += Math.max(0, Math.round(Number(r.clicks) || 0));
    a.impressions += Math.max(0, Math.round(Number(r.impressions) || 0));
    agg.set(key, a);
  }
  const list = [...agg.values()]
    .filter((a) => a.impressions > 0)
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0));
  const total = list.reduce((s, a) => s + a.impressions, 0);
  let cumBefore = 0;
  return list.map((a, i) => {
    const segment: DemandSegment =
      cumBefore * 100 < total * HEAD_PCT ? "head" : cumBefore * 100 < total * (HEAD_PCT + MIDDLE_PCT) ? "middle" : "long_tail";
    cumBefore += a.impressions;
    return {
      query: a.query,
      key: a.query,
      clicks: a.clicks,
      impressions: a.impressions,
      rank: i + 1,
      segment,
      words: wordCount(a.query),
      strongIntent: hasStrongIntentModifier(a.query, language),
    };
  });
}

/** Query -> segment lookup for tagging candidates (keyed by normalizeDemandQuery). */
export function demandLookup(rows: DemandRow[], language: string | null | undefined = "en"): Map<string, RankedQuery> {
  return new Map(rankQueries(rows, language).map((r) => [r.key, r]));
}

// ------------------------------------------------------------------ curve
export interface DemandCurveOptions {
  source: DemandCurve["source"];
  window: DateWindow | null;
  truncated: boolean;
  language?: string | null;
  maxPoints?: number;
}

export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Log-spaced downsampling over ranks 1..n: at most `max` points, always including the first and the
 * last rank, ascending by rank. Keeps the head (few, large queries) visible on a log-scale chart.
 */
export function downsampleRanks(n: number, max = MAX_DEMAND_POINTS): number[] {
  if (n <= 0) return [];
  const cap = Math.max(2, Math.floor(max));
  if (n <= cap) return Array.from({ length: n }, (_, i) => i + 1);
  // k log-spaced samples from rank 1 to rank n; rounding merges neighbours near the head, so grow k
  // while the number of distinct ranks still fits the cap (k samples never exceed k distinct ranks).
  const sample = (k: number) => {
    const s = new Set<number>([1, n]);
    for (let j = 0; j < k; j++) s.add(Math.min(n, Math.max(1, Math.round(Math.exp((Math.log(n) * j) / (k - 1))))));
    return s;
  };
  let best = sample(cap);
  for (let k = cap + 1; k <= Math.min(n, cap * 4); k++) {
    const s = sample(k);
    if (s.size > cap) break;
    best = s;
  }
  return [...best].sort((a, b) => a - b);
}

export function buildDemandCurve(rows: DemandRow[], opts: DemandCurveOptions): DemandCurve | null {
  const language = opts.language ?? "en";
  const ranked = rankQueries(rows, language);
  if (ranked.length === 0) return null;
  const total = ranked.reduce((s, r) => s + r.impressions, 0);
  const english = isEnglish(language);
  const segments = (["head", "middle", "long_tail"] as const).map((segment) => {
    const qs = ranked.filter((r) => r.segment === segment);
    const impressions = qs.reduce((s, r) => s + r.impressions, 0);
    const clicks = qs.reduce((s, r) => s + r.clicks, 0);
    const strong = english ? qs.filter((r) => r.strongIntent === true).length : 0;
    return {
      segment,
      queryCount: qs.length,
      impressions,
      clicks,
      ctr: ratio(clicks, impressions),
      shareOfImpressions: ratio(impressions, total),
      medianWords: medianOf(qs.map((r) => r.words)),
      strongIntentShare: english ? ratio(strong, qs.length) : ratio(0, 0),
      examples: qs.slice(0, MAX_SEGMENT_EXAMPLES).map((r) => (r.query.length > 100 ? `${r.query.slice(0, 99)}…` : r.query)),
    };
  });
  const points = downsampleRanks(ranked.length, opts.maxPoints ?? MAX_DEMAND_POINTS).map((rank) => ({ rank, impressions: ranked[rank - 1]!.impressions }));
  return {
    source: opts.source,
    window: opts.window,
    basis: "first_party_impressions",
    methodVersion: DEMAND_METHOD_VERSION,
    segmentation: english ? DEMAND_SEGMENTATION : `${DEMAND_SEGMENTATION} Strong-intent share is English-only (${STRONG_INTENT_VERSION}) and unavailable for this language.`,
    totalQueries: ranked.length,
    truncated: opts.truncated,
    segments,
    points,
    note: DEMAND_NOTE,
  };
}

/** Plain-language tag for recommendation text, e.g. "a long-tail query with a commercial modifier". */
export function demandPhrase(r: Pick<RankedQuery, "segment" | "strongIntent">): string {
  const base = `a ${SEGMENT_LABEL[r.segment]} query`;
  return r.strongIntent === true ? `${base} with a commercial modifier` : base;
}
