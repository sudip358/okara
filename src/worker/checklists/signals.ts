/**
 * Derived, memoized signals over a ChecklistData snapshot (crawl coverage, inlinks, GSC opportunity
 * lists, GEO source aggregation). Thresholds are labelled heuristics and versioned with CHECKLIST_VERSION.
 */
import type { Completeness } from "@shared/types";
import { completenessNote } from "../seo/crawl/run";
import { normalizeUrlKey } from "../seo/rules/registry";
import type { ChecklistData, Finding, GeoCitation, GeoObservation, GscRow, Snap } from "./data";
import { hostIs, plural } from "./text";

export const THRESHOLDS = {
  /** GSC rows need this many impressions to count as an opportunity (mirrors the SEO candidate default). */
  minImpressions: 100,
  /** Rows used to compute a position-bucket median CTR. */
  medianMinImpressions: 20,
  ctrBucketMinRows: 3,
  /** Flag rows whose CTR is below this factor x the bucket median. */
  ctrBelowMedianFactor: 0.8,
  page2Min: 10.5,
  page2Max: 20.5,
  decliningMinPrevClicks: 20,
  decliningMinDrop: 0.3,
  /** Key pages with fewer internal inlinks than this (from other crawled pages) are weakly linked. */
  keyPageMinInlinks: 2,
  staleMonths: 12,
  titleMin: 50,
  titleMax: 60,
  answerCoverage: 0.6,
  thinWords: 150,
} as const;

export interface PageMetric {
  url: string;
  clicks: number;
  impressions: number;
  /** Impression-weighted average when aggregated from query x page rows (an approximation). */
  position: number | null;
}

export interface WeakCtrRow {
  query: string | null;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  bucket: string;
  median: number;
}

function bucketOf(position: number): string | null {
  if (position < 3.5) return "1-3";
  if (position < 10.5) return "4-10";
  if (position < 20.5) return "11-20";
  return null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function memo<T>(fn: () => T): () => T {
  let done = false;
  let v: T;
  return () => {
    if (!done) {
      v = fn();
      done = true;
    }
    return v;
  };
}

export const MENTION_SOURCES = {
  forum: { label: "Reddit and forum threads", match: (c: GeoCitation) => c.sourceType === "forum_ugc" || hostIs(c.host, "reddit.com") },
  listicle: { label: "listicles and roundups", match: (c: GeoCitation) => c.sourceType === "listicle_roundup" },
  review: { label: "review sites", match: (c: GeoCitation) => c.sourceType === "review_site" },
  reviewOrMarketplace: { label: "review sites and marketplaces", match: (c: GeoCitation) => c.sourceType === "review_site" || c.sourceType === "marketplace" },
  youtube: { label: "YouTube videos", match: (c: GeoCitation) => hostIs(c.host, "youtube.com") || hostIs(c.host, "youtu.be") },
  publisher: { label: "news and publisher sites", match: (c: GeoCitation) => c.sourceType === "publisher" },
  thirdParty: { label: "third-party pages", match: (c: GeoCitation) => c.sourceType !== "brand_page" },
} as const;
export type MentionSourceKey = keyof typeof MENTION_SOURCES;

export interface MentionAggregate {
  validAnswers: number;
  answersCiting: number;
  answersWithBrand: number;
  answersWithoutBrand: number;
  /** URLs cited in answers that did not mention the brand, most frequent first. */
  gapUrls: Array<{ url: string; host: string; title: string | null; count: number; entities: string[] }>;
  /** URLs cited in answers that did mention the brand. */
  withBrandUrls: Array<{ url: string; host: string; title: string | null; count: number }>;
}

export class Signals {
  constructor(readonly d: ChecklistData) {}

  // ------------------------------------------------------------------ crawl
  get hasCrawl(): boolean {
    return this.d.crawl !== null;
  }

  /** 2xx, not skipped, not redirected. */
  readonly analyzable = memo(() =>
    this.d.snapshots.filter((s) => {
      const ok = s.statusCode !== null && s.statusCode >= 200 && s.statusCode < 300 && !s.skippedReason;
      const redirected = !!s.finalUrl && normalizeUrlKey(s.finalUrl) !== normalizeUrlKey(s.url);
      return ok && !redirected;
    }),
  );

  readonly byKey = memo(() => new Map(this.d.snapshots.map((s) => [normalizeUrlKey(s.url), s])));

  /** target key -> distinct source page keys (analyzable pages only; self-links excluded; redirects credited to their target). */
  readonly inlinks = memo(() => {
    const map = new Map<string, Set<string>>();
    const byKey = this.byKey();
    const add = (target: string, source: string) => {
      if (target === source) return;
      const set = map.get(target) ?? new Set<string>();
      set.add(source);
      map.set(target, set);
    };
    for (const s of this.analyzable()) {
      const src = normalizeUrlKey(s.url);
      for (const l of s.internalLinks) {
        const k = normalizeUrlKey(l);
        add(k, src);
        const t = byKey.get(k);
        if (t?.finalUrl && normalizeUrlKey(t.finalUrl) !== k) add(normalizeUrlKey(t.finalUrl), src);
      }
    }
    return map;
  });

  inlinkCount(url: string): number {
    return this.inlinks().get(normalizeUrlKey(url))?.size ?? 0;
  }

  readonly skipped = memo(() => {
    const byReason: Record<string, number> = {};
    for (const s of this.d.snapshots) if (s.skippedReason) byReason[s.skippedReason] = (byReason[s.skippedReason] ?? 0) + 1;
    return byReason;
  });

  /** True when the crawl stopped at its page limit (so link-based checks are coverage-limited). */
  get limitReached(): boolean {
    return (this.d.crawl?.notes ?? []).some((n) => /page limit \d+ reached/i.test(n));
  }

  crawlCompleteness(extra?: string): Completeness {
    const c = this.d.crawl;
    if (!c) return { note: "No completed crawl yet.", covered: null, total: null };
    const crawled = this.d.snapshots.filter((s) => !s.skippedReason).length;
    const total = this.d.snapshots.length;
    const note = completenessNote(crawled, this.skipped(), c.pagesLimit, this.limitReached);
    return { note: extra ? `${note}; ${extra}` : note, covered: crawled, total };
  }

  findings(ruleIds: readonly string[]): Finding[] {
    const set = new Set(ruleIds);
    return this.d.findings.filter((f) => set.has(f.ruleId));
  }

  findingUrls(ruleIds: readonly string[]): string[] {
    return [...new Set(this.findings(ruleIds).map((f) => f.url).filter((u): u is string => !!u))];
  }

  isHome(s: Snap): boolean {
    return s.pageType === "home";
  }

  // ------------------------------------------------------------------ GSC
  get hasGsc(): boolean {
    return this.d.gsc.sync !== null;
  }

  gscCompleteness(): Completeness {
    const s = this.d.gsc.sync;
    if (!s) return { note: "No Search Console data synced.", covered: null, total: null };
    const src = s.source === "api" ? "Search Console API" : s.source === "csv_import" ? "CSV import" : "demo fixture";
    return {
      note: `GSC ${s.windowStart}..${s.windowEnd} vs ${s.prevStart}..${s.prevEnd} (${src}); ${plural(s.rowsFetched, "row")}${s.truncated ? ", truncated at the project row cap" : ""}; anonymized queries are omitted by Google`,
      covered: null,
      total: null,
    };
  }

  /** query x page rows for a window (device-less rows preferred when present). */
  qp(window: "current" | "previous"): GscRow[] {
    const rows = this.d.gsc.rows.filter((r) => r.window === window && r.query && r.page);
    const noDevice = rows.filter((r) => !r.device);
    return noDevice.length ? noDevice : rows;
  }

  readonly qpCurrent = memo(() => this.qp("current"));

  /** Page-level metrics: page-dimension rows when synced, else aggregated from query x page rows. */
  pageMetrics(window: "current" | "previous"): Map<string, PageMetric> {
    const out = new Map<string, PageMetric>();
    const pageRows = this.d.gsc.rows.filter((r) => r.window === window && r.page && !r.query && !r.device);
    if (pageRows.length) {
      for (const r of pageRows) out.set(normalizeUrlKey(r.page!), { url: r.page!, clicks: r.clicks, impressions: r.impressions, position: r.position });
      return out;
    }
    const acc = new Map<string, { url: string; clicks: number; impressions: number; posW: number }>();
    for (const r of this.qp(window)) {
      const k = normalizeUrlKey(r.page!);
      const a = acc.get(k) ?? { url: r.page!, clicks: 0, impressions: 0, posW: 0 };
      a.clicks += r.clicks;
      a.impressions += r.impressions;
      a.posW += r.position * r.impressions;
      acc.set(k, a);
    }
    for (const [k, a] of acc) out.set(k, { url: a.url, clicks: a.clicks, impressions: a.impressions, position: a.impressions > 0 ? a.posW / a.impressions : null });
    return out;
  }

  readonly pageMetricsCurrent = memo(() => this.pageMetrics("current"));
  readonly pageMetricsPrevious = memo(() => this.pageMetrics("previous"));

  /** Top query (by impressions) per page key, current window. */
  readonly topQueryByPage = memo(() => {
    const out = new Map<string, GscRow>();
    for (const r of this.qpCurrent()) {
      const k = normalizeUrlKey(r.page!);
      const cur = out.get(k);
      if (!cur || r.impressions > cur.impressions) out.set(k, r);
    }
    return out;
  });

  queriesForPage(url: string): GscRow[] {
    const k = normalizeUrlKey(url);
    return this.qpCurrent()
      .filter((r) => normalizeUrlKey(r.page!) === k)
      .sort((a, b) => b.impressions - a.impressions);
  }

  /** Position-bucket CTR medians over query x page rows (or page rows when no query rows). */
  readonly ctrMedians = memo(() => {
    const units = this.ctrUnits();
    const byBucket = new Map<string, number[]>();
    for (const r of units) {
      const b = bucketOf(r.position);
      if (!b || r.impressions < THRESHOLDS.medianMinImpressions) continue;
      const list = byBucket.get(b) ?? [];
      list.push(r.clicks / r.impressions);
      byBucket.set(b, list);
    }
    const medians = new Map<string, { median: number; n: number }>();
    for (const [b, list] of byBucket) {
      const m = median(list);
      if (m !== null && m > 0 && list.length >= THRESHOLDS.ctrBucketMinRows) medians.set(b, { median: m, n: list.length });
    }
    return medians;
  });

  private ctrUnits(): Array<{ query: string | null; page: string; clicks: number; impressions: number; position: number }> {
    const qp = this.qpCurrent();
    if (qp.length) return qp.map((r) => ({ query: r.query, page: r.page!, clicks: r.clicks, impressions: r.impressions, position: r.position }));
    return [...this.pageMetricsCurrent().values()]
      .filter((m) => m.position !== null)
      .map((m) => ({ query: null, page: m.url, clicks: m.clicks, impressions: m.impressions, position: m.position! }));
  }

  /** High-impression rows whose CTR is below the factor x median of their position bucket. */
  readonly weakCtr = memo((): WeakCtrRow[] => {
    const medians = this.ctrMedians();
    const out: WeakCtrRow[] = [];
    for (const r of this.ctrUnits()) {
      const b = bucketOf(r.position);
      const m = b ? medians.get(b) : undefined;
      if (!b || !m || r.impressions < THRESHOLDS.minImpressions) continue;
      const ctr = r.clicks / r.impressions;
      if (ctr >= m.median * THRESHOLDS.ctrBelowMedianFactor) continue;
      out.push({ ...r, ctr, bucket: b, median: m.median });
    }
    return out.sort((a, b) => b.impressions - a.impressions);
  });

  /** Pages whose (page-level) average position is on page 2 (about 11-20) with enough impressions. */
  readonly page2 = memo(() =>
    [...this.pageMetricsCurrent().values()]
      .filter((m) => m.position !== null && m.position >= THRESHOLDS.page2Min && m.position < THRESHOLDS.page2Max && m.impressions >= THRESHOLDS.minImpressions)
      .sort((a, b) => b.impressions - a.impressions),
  );

  /** Pages whose clicks fell by at least the threshold vs the previous window. */
  readonly declining = memo(() => {
    const cur = this.pageMetricsCurrent();
    const out: Array<{ url: string; prevClicks: number; curClicks: number; drop: number }> = [];
    for (const [k, prev] of this.pageMetricsPrevious()) {
      if (prev.clicks < THRESHOLDS.decliningMinPrevClicks) continue;
      const curClicks = cur.get(k)?.clicks ?? 0;
      const drop = (prev.clicks - curClicks) / prev.clicks;
      if (drop >= THRESHOLDS.decliningMinDrop) out.push({ url: prev.url, prevClicks: prev.clicks, curClicks, drop });
    }
    return out.sort((a, b) => b.drop - a.drop);
  });

  /** Queries where two or more distinct crawled-or-GSC pages received impressions ([A15] prefilter input). */
  readonly sharedQueries = memo(() => {
    const byQuery = new Map<string, Map<string, string>>();
    for (const r of this.qpCurrent()) {
      if (r.impressions <= 0) continue;
      const m = byQuery.get(r.query!) ?? new Map<string, string>();
      m.set(normalizeUrlKey(r.page!), r.page!);
      byQuery.set(r.query!, m);
    }
    return [...byQuery.entries()]
      .filter(([, m]) => m.size > 1)
      .map(([query, m]) => ({ query, pages: [...m.values()] }));
  });

  // ------------------------------------------------------------------ GEO
  /** Automated API observations that returned a valid answer. Manual imports are reported separately. */
  readonly validObs = memo((): GeoObservation[] => this.d.geo.observations.filter((o) => o.measurementType === "api" && o.status === "ok"));
  readonly manualImports = memo(() => this.d.geo.observations.filter((o) => o.measurementType === "manual_import"));

  get hasGeo(): boolean {
    return this.d.geo.observations.length > 0;
  }

  readonly selfMentioned = memo(() => new Set(this.d.geo.brandObs.filter((b) => b.isSelf && b.mentioned).map((b) => b.observationId)));

  readonly citationsByObs = memo(() => {
    const m = new Map<string, GeoCitation[]>();
    for (const c of this.d.geo.citations) {
      const list = m.get(c.observationId) ?? [];
      list.push(c);
      m.set(c.observationId, list);
    }
    return m;
  });

  geoCompleteness(): Completeness {
    const all = this.d.geo.observations.filter((o) => o.measurementType === "api");
    const valid = this.validObs().length;
    const grounded = this.validObs().filter((o) => o.grounded).length;
    const failed = all.filter((o) => o.status !== "ok").length;
    const manual = this.manualImports().length;
    return {
      note: `${valid} valid API-sampled answers (${grounded} grounded, ${failed} failed or incomplete, not counted as absences)${manual ? `; ${manual} labelled manual imports excluded` : ""}`,
      covered: valid,
      total: all.length,
    };
  }

  mentionAggregate(key: MentionSourceKey): MentionAggregate {
    const match = MENTION_SOURCES[key].match;
    const valid = this.validObs();
    const cits = this.citationsByObs();
    const self = this.selfMentioned();
    const dispByObs = new Map<string, string[]>();
    for (const d of this.d.geo.displacements) {
      const list = dispByObs.get(d.observationId) ?? [];
      list.push(d.entity);
      dispByObs.set(d.observationId, list);
    }
    let citing = 0;
    let withBrand = 0;
    const gap = new Map<string, { url: string; host: string; title: string | null; count: number; entities: Set<string> }>();
    const hit = new Map<string, { url: string; host: string; title: string | null; count: number }>();
    for (const o of valid) {
      const matched = (cits.get(o.id) ?? []).filter((c) => match(c) && c.brandKey !== "self");
      if (matched.length === 0) continue;
      citing++;
      const mentioned = self.has(o.id);
      if (mentioned) withBrand++;
      const seen = new Set<string>();
      for (const c of matched) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        if (mentioned) {
          const e = hit.get(c.url) ?? { url: c.url, host: c.host, title: c.title, count: 0 };
          e.count++;
          hit.set(c.url, e);
        } else {
          const e = gap.get(c.url) ?? { url: c.url, host: c.host, title: c.title, count: 0, entities: new Set<string>() };
          e.count++;
          for (const ent of dispByObs.get(o.id) ?? []) e.entities.add(ent);
          gap.set(c.url, e);
        }
      }
    }
    const sortByCount = <T extends { count: number; url: string }>(xs: T[]) => xs.sort((a, b) => b.count - a.count || a.url.localeCompare(b.url));
    return {
      validAnswers: valid.length,
      answersCiting: citing,
      answersWithBrand: withBrand,
      answersWithoutBrand: citing - withBrand,
      gapUrls: sortByCount([...gap.values()]).map((g) => ({ url: g.url, host: g.host, title: g.title, count: g.count, entities: [...g.entities] })),
      withBrandUrls: sortByCount([...hit.values()]),
    };
  }
}
