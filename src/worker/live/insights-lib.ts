/**
 * Live view project containers (docs/live-view-design.md section 17): pure helpers and the ONE place their
 * thresholds and caps live. No database, no provider calls; the SQL in insights-seo.ts / insights-geo.ts
 * applies the same constants, and these functions turn the bounded rows it reads into the response rows.
 * Everything here is a count or a measured difference of stored rows: nothing is projected or scored.
 */
import type {
  LiveBrandCounts,
  LiveBrandRow,
  LiveCitedDomainRow,
  LiveHistoryCell,
  LivePageMover,
  LiveStrikingRow,
  SourceType,
} from "@shared/types";
import { promptKey } from "@shared/import";
import { brandForHost, resolveCitationHost, type BrandDef } from "../geo/detect";
import { BOARD_LANES } from "../geo/board";
import { isSourceType } from "../geo/source-type";
import { answerOutcome } from "../runs/activity";

// ------------------------------------------------------------------ thresholds and caps (documented in section 17)

/**
 * SEO 10 "Striking-distance queries": current-window query+page rows of the latest usable Search Console sync
 * whose Search Console average position is in [minPosition, maxPosition] (inclusive) and that have at least
 * minImpressions impressions, listed by impressions (then query, page), at most maxRows.
 */
export interface StrikingThresholds {
  minPosition: number;
  maxPosition: number;
  minImpressions: number;
  maxRows: number;
}
export const STRIKING_DISTANCE: Readonly<StrikingThresholds> = { minPosition: 8, maxPosition: 20, minImpressions: 1, maxRows: 50 };

/** SEO 11 "Pages gaining and losing clicks": gainers / losers listed, and the page groups read at most. */
export const MOVERS = { top: 8, groupCap: 5_000 } as const;

/** SEO 12 "Technical issues": example findings per (rule, severity) and (rule, severity) groups read at most. */
export const TECHNICAL = { examples: 5, groupCap: 500 } as const;

/** GEO 06-08 read stored answers of the last N days (by the answer's stored time). */
export const INSIGHT_WINDOW_DAYS = 30;
/** GEO 06: distinct engine search queries listed (most answers first). */
export const ENGINE_QUERIES_LIMIT = 50;
/** GEO 08: hosts listed, and citation rows read at most (truncated beyond: counts are lower bounds). */
export const CITED_DOMAINS = { limit: 25, rowCap: 20_000 } as const;
/** GEO 09: runs shown per engine, GEO runs scanned, and answers read at most. */
export const PROMPT_HISTORY = { runsPerEngine: 8, runScan: 40, observationCap: 6_000, prompts: 100 } as const;
/** SEO 14 / GEO 10: syncs listed and the window of "recent changes". */
export const SHEETS = { syncs: 50, recentDays: 7 } as const;

/** ISO instant `days` days before `now`. */
export function sinceIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** Engine lanes in the Live view's lane order: built-in engines in board order (geo/board.ts BOARD_LANES), then the rest by id. */
export function engineOrder(providers: Iterable<string>): string[] {
  const set = new Set(providers);
  const builtIn = BOARD_LANES.filter((p) => set.has(p));
  const rest = [...set].filter((p) => !(BOARD_LANES as readonly string[]).includes(p)).sort();
  return [...builtIn, ...rest];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ SEO 10 striking distance

export interface MetricRowLite {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

/** Inclusive position range and the impressions floor of STRIKING_DISTANCE. */
export function inStrikingDistance(row: { position: number; impressions: number }, t: Omit<StrikingThresholds, "maxRows"> = STRIKING_DISTANCE): boolean {
  return Number.isFinite(row.position) && row.position >= t.minPosition && row.position <= t.maxPosition && row.impressions >= t.minImpressions;
}

/**
 * Rows in striking distance, by impressions (then query, page), at most `maxRows`, each joined to the same
 * query+page of the previous window when it is stored (exact strings, as Search Console returned them).
 */
export function strikingRows(current: MetricRowLite[], previous: MetricRowLite[], t: StrikingThresholds = STRIKING_DISTANCE): LiveStrikingRow[] {
  const prev = new Map<string, MetricRowLite>();
  for (const r of previous) prev.set(`${r.query}\u0000${r.page}`, r);
  return current
    .filter((r) => inStrikingDistance(r, t))
    .sort((a, b) => b.impressions - a.impressions || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0) || (a.page < b.page ? -1 : a.page > b.page ? 1 : 0))
    .slice(0, t.maxRows)
    .map((r) => {
      const p = prev.get(`${r.query}\u0000${r.page}`);
      return {
        query: r.query,
        page: r.page,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.impressions > 0 ? r.clicks / r.impressions : null,
        position: round2(r.position),
        previous: p ? { clicks: p.clicks, impressions: p.impressions, position: round2(p.position) } : null,
      };
    });
}

// ------------------------------------------------------------------ SEO 11 pages gaining and losing clicks

/** One page's sums per window (from a GROUP BY page read; wpos = sum(position × impressions), wimp = sum(impressions)). */
export interface PageWindowGroup {
  page: string;
  inCur: boolean;
  inPrev: boolean;
  cur: { clicks: number; impressions: number; wpos: number; wimp: number };
  prev: { clicks: number; impressions: number; wpos: number; wimp: number };
}

const windowMetrics = (w: PageWindowGroup["cur"]) => ({ clicks: w.clicks, impressions: w.impressions, position: w.wimp > 0 ? round2(w.wpos / w.wimp) : null });

/**
 * Gainers and losers by click difference among pages present in BOTH windows (top `top` each, ties by current
 * clicks then page); pages present in only one window are counted as new / lost, never ranked.
 */
export function pageMovers(groups: PageWindowGroup[], top: number = MOVERS.top): {
  gainers: LivePageMover[];
  losers: LivePageMover[];
  counts: { both: number; unchanged: number; newPages: number; lostPages: number };
} {
  const both: LivePageMover[] = [];
  let newPages = 0;
  let lostPages = 0;
  for (const g of groups) {
    if (g.inCur && g.inPrev) both.push({ page: g.page, current: windowMetrics(g.cur), previous: windowMetrics(g.prev), clickDelta: g.cur.clicks - g.prev.clicks });
    else if (g.inCur) newPages++;
    else if (g.inPrev) lostPages++;
  }
  const byPage = (a: LivePageMover, b: LivePageMover) => (a.page < b.page ? -1 : a.page > b.page ? 1 : 0);
  const gainers = both
    .filter((m) => m.clickDelta > 0)
    .sort((a, b) => b.clickDelta - a.clickDelta || b.current.clicks - a.current.clicks || byPage(a, b))
    .slice(0, top);
  const losers = both
    .filter((m) => m.clickDelta < 0)
    .sort((a, b) => a.clickDelta - b.clickDelta || b.previous.clicks - a.previous.clicks || byPage(a, b))
    .slice(0, top);
  return { gainers, losers, counts: { both: both.length, unchanged: both.filter((m) => m.clickDelta === 0).length, newPages, lostPages } };
}

// ------------------------------------------------------------------ GEO 07 brands in AI answers

/** One (engine, brand) group of a read over analysed answers (one brand row per answer and brand). */
export interface BrandGroup extends LiveBrandCounts {
  provider: string;
  brandKey: string;
  isSelf: boolean;
}

const zero = (): LiveBrandCounts => ({ answers: 0, mentioned: 0, cited: 0, recommended: 0, negative: 0 });
const addCounts = (a: LiveBrandCounts, b: LiveBrandCounts): LiveBrandCounts => ({
  answers: a.answers + b.answers,
  mentioned: a.mentioned + b.mentioned,
  cited: a.cited + b.cited,
  recommended: a.recommended + b.recommended,
  negative: a.negative + b.negative,
});

/**
 * Your brand first, then competitors by answers mentioning them (then name). Per engine and in total, each
 * count is "n of m answers" where m = analysed answers that checked that brand: never a share across brands.
 */
export function brandTable(groups: BrandGroup[], names: { self: string }): { engines: string[]; brands: LiveBrandRow[] } {
  const engines = engineOrder(groups.map((g) => g.provider));
  const byBrand = new Map<string, { isSelf: boolean; per: Map<string, LiveBrandCounts> }>();
  for (const g of groups) {
    const b = byBrand.get(g.brandKey) ?? { isSelf: g.isSelf, per: new Map<string, LiveBrandCounts>() };
    b.isSelf ||= g.isSelf;
    b.per.set(g.provider, addCounts(b.per.get(g.provider) ?? zero(), g));
    byBrand.set(g.brandKey, b);
  }
  const brands: LiveBrandRow[] = [...byBrand].map(([brandKey, b]) => {
    const per = engines.filter((e) => b.per.has(e)).map((provider) => ({ provider, ...b.per.get(provider)! }));
    return { brandKey, name: b.isSelf ? names.self : brandKey, isSelf: b.isSelf, engines: per, total: per.reduce<LiveBrandCounts>((a, x) => addCounts(a, x), zero()) };
  });
  brands.sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || b.total.mentioned - a.total.mentioned || a.name.localeCompare(b.name));
  return { engines, brands };
}

// ------------------------------------------------------------------ GEO 08 most-cited domains

export interface CitationLite {
  observationId: string;
  provider: string;
  url: string;
  title: string | null;
  sourceType: string;
}

/**
 * Groups stored citations by resolved host (geo/detect resolveCitationHost: a provider redirect link counts by
 * its bare-domain title, else it is "unresolved" and not a domain). answers = distinct answers citing the host.
 * Tags your site ("self") and tracked competitors by their configured domains (brandForHost). Ranked by
 * answers, then citations, then host; `own` is your row when it is cited but not among the first `limit`.
 */
export function groupCitedDomains(
  rows: CitationLite[],
  brands: BrandDef[],
  limit: number = CITED_DOMAINS.limit,
): { rows: LiveCitedDomainRow[]; own: LiveCitedDomainRow | null; answersWithCitations: number; totalHosts: number; unresolved: number } {
  const hosts = new Map<string, { obs: Set<string>; citations: number; engines: Set<string>; types: Map<SourceType, number> }>();
  const answers = new Set<string>();
  let unresolved = 0;
  for (const r of rows) {
    answers.add(r.observationId);
    const { host } = resolveCitationHost(r.url, r.title);
    if (!host) {
      unresolved++;
      continue;
    }
    const h = hosts.get(host) ?? { obs: new Set<string>(), citations: 0, engines: new Set<string>(), types: new Map<SourceType, number>() };
    h.obs.add(r.observationId);
    h.citations++;
    h.engines.add(r.provider);
    const st: SourceType = isSourceType(r.sourceType) ? r.sourceType : "other";
    h.types.set(st, (h.types.get(st) ?? 0) + 1);
    hosts.set(host, h);
  }
  const ranked: LiveCitedDomainRow[] = [...hosts]
    .map(([host, h]) => {
      const key = brandForHost(host, brands);
      const brand = key ? { key, isSelf: brands.some((b) => b.key === key && b.isSelf) } : null;
      return {
        host,
        answers: h.obs.size,
        citations: h.citations,
        engines: engineOrder(h.engines),
        sourceTypes: [...h.types].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([t]) => t),
        brand,
        rank: 0,
      };
    })
    .sort((a, b) => b.answers - a.answers || b.citations - a.citations || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const shown = ranked.slice(0, limit);
  const own = shown.some((r) => r.brand?.isSelf) ? null : (ranked.find((r) => r.brand?.isSelf) ?? null);
  return { rows: shown, own, answersWithCitations: answers.size, totalHosts: ranked.length, unresolved };
}

// ------------------------------------------------------------------ GEO 09 prompt history

export interface HistoryObservation {
  runId: string;
  provider: string;
  promptText: string;
  status: string;
  analysed: boolean;
  selfCited: boolean;
  selfMentioned: boolean;
  createdAt: string;
}

/** Outcome of one stored answer as a history cell (the AI engine board's definition, runs/activity answerOutcome). */
export function historyCell(o: Pick<HistoryObservation, "status" | "analysed" | "selfCited" | "selfMentioned">): LiveHistoryCell {
  return answerOutcome(o) ?? "not_analysed";
}

/**
 * The prompt × engine × run grid. For each engine: the newest `maxRuns` runs (by run time) in which that engine
 * stored at least one answer, shown oldest first. A prompt matches an answer by its text (promptKey: case,
 * spacing and a trailing "?" ignored), so a prompt kept across prompt-set versions keeps its history. A run
 * that stored no answer for the pair is "none"; when a run stored several, the newest counts.
 */
export function promptHistoryGrid(
  prompts: Array<{ id: string; text: string }>,
  observations: HistoryObservation[],
  runs: Array<{ id: string; createdAt: string }>,
  maxRuns: number = PROMPT_HISTORY.runsPerEngine,
): { engines: Array<{ provider: string; runs: Array<{ runId: string; at: string }> }>; rows: Array<{ promptId: string; text: string; cells: Record<string, LiveHistoryCell[]> }> } {
  const runAt = new Map(runs.map((r) => [r.id, r.createdAt]));
  const byEngine = new Map<string, Set<string>>();
  const answer = new Map<string, HistoryObservation>();
  for (const o of observations) {
    if (!runAt.has(o.runId)) continue;
    if (!byEngine.has(o.provider)) byEngine.set(o.provider, new Set());
    byEngine.get(o.provider)!.add(o.runId);
    const k = `${o.provider}\u0000${o.runId}\u0000${promptKey(o.promptText)}`;
    const prev = answer.get(k);
    if (!prev || o.createdAt > prev.createdAt) answer.set(k, o);
  }
  const engines = engineOrder(byEngine.keys()).map((provider) => {
    const ids = [...byEngine.get(provider)!].sort((a, b) => (runAt.get(b)! < runAt.get(a)! ? -1 : runAt.get(b)! > runAt.get(a)! ? 1 : b < a ? -1 : 1));
    return { provider, runs: ids.slice(0, maxRuns).reverse().map((runId) => ({ runId, at: runAt.get(runId)! })) };
  });
  const rows = prompts.map((p) => {
    const key = promptKey(p.text);
    const cells: Record<string, LiveHistoryCell[]> = {};
    for (const e of engines) {
      cells[e.provider] = e.runs.map((r) => {
        const o = answer.get(`${e.provider}\u0000${r.runId}\u0000${key}`);
        return o ? historyCell(o) : "none";
      });
    }
    return { promptId: p.id, text: p.text, cells };
  });
  return { engines, rows };
}
