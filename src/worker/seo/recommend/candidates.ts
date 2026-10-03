/**
 * Deterministic candidate shortlist (pure: CandidateInputs -> Candidate[]). All thresholds are
 * configurable heuristics, not promises of ranking gains; CANDIDATE_RULES_VERSION changes whenever a
 * default or rule changes. Candidates carry their metrics and evidence specs; generate.ts turns
 * evidence specs into evidence rows.
 *
 * Kinds:
 *  weak_ctr             page/query rows with impressions >= minImpressions whose CTR is below
 *                       ctrBelowMedianFactor x the project median CTR of the same position bucket
 *                       (1-3, 4-10, 11-20; all devices combined) -> title/meta candidate (one per page)
 *  striking_distance    queries with (impression-weighted) position 4-20 and impressions >= min
 *  declining            pages whose clicks fell >= 30% vs the previous window, previous clicks >= 20
 *  query_page_mismatch  a query's top page differs from the crawled page whose title/H1 best matches it
 *  coverage_gap         GSC queries for a page whose words are mostly absent from its title/headings/excerpt
 *  internal_link        high-impression page with <= maxInlinks internal inlinks among crawled pages
 *  engine_query  [A6]   GEO engine search queries matched against GSC and crawled pages:
 *                       reinforce | improve | no_matching_page (human review; never auto-verified)
 *  technical     [A9]   audit findings; >= templateMinUrls URLs sharing rule + page type (or template)
 *                       -> ONE template-scope candidate; else page-scope
 *  duplicate     [A15]  title-token prefilter (>= 2 shared non-stopword tokens AND >= 50% of the
 *                       shorter title; brand name/alias tokens excluded) OR GSC queries where both URLs
 *                       received impressions; <= 40 pairs
 *  checklist     [A21]  readiness-checklist gaps (checklists/bridge.ts) that fit the SEO agent, plus the
 *                       robots.txt advisor for blocked search-engine crawlers; built asynchronously by
 *                       checklist-candidates.ts (not by buildCandidates, which stays pure)
 *  freshness     [A23]  pages whose title, H1, or first paragraph carries a stale year (freshness.ts);
 *                       seo.outdated_information (Noul, today's date in state) decides
 *  schema_mismatch [A23] JSON-LD types that conflict with the crawled page (schema-match.ts);
 *                       seo.schema_content_match (Noul) decides; severity moderate
 *  answer_clarity [A23] (AEO) pages whose top non-brand GSC query is question-like (or article pages)
 *                       with >= answerMinImpressions; seo.answer_is_direct (Noul) decides
 *
 * [A23] brand: queries containing the brand name or an alias (gsc/brand.ts) are excluded from weak_ctr
 * (flagged rows AND the bucket medians, since brand CTR is not comparable) and striking_distance.
 * Competitor-name queries stay in and carry metrics.competitorBrand = "yes".
 * [A23] query relevance: `inputs.queryFilter` (set by generate.ts after the Noul pre-filter) removes
 * confident "not about this business" queries from every query-based candidate; middle-band queries cap
 * the candidate at Flag (tierCap).
 * [A25] declining: when the sync holds last year's page slice, a dip that is not down against the same
 * window last year is suppressed as seasonal (decay.ts); every declining candidate lists its likely
 * causes (demand_or_season, ranking_loss, ctr_drop, content_changed) in evidence and text.
 * [A25] internal links: the top act-tier suggestions of the internal link suggester become concrete
 * page-scope internal_link candidates (source -> target, sentence, anchor, role; no Jev re-ask); the
 * few-inlinks candidate stays only for targets with no such suggestion.
 * [A25] duplicates: queries whose top page alternates between URLs across weeks (gsc/slices.ts) add
 * their page pairs to the [A15] prefilter.
 *
 * Technical grouping uses the rule registry: only rules marked `templateable` become template-scope
 * candidates (one per rule + template); a non-templateable rule on >= templateMinUrls URLs (for
 * example 4xx responses) becomes one site-scope candidate instead of claiming a template cause.
 *
 * Demand tagging: candidates with a GSC query carry that query's demand segment (head | middle |
 * long_tail of this site's own impressions, gsc/demand.ts) and strong-intent flag, in candidate
 * metrics and in the GSC evidence (text + data). It describes first-party visibility only, never
 * market search volume.
 */
import type { EvidenceSource, Level, PageType, Scope, Severity, Tier } from "@shared/types";
import { EVIDENCE_TEXT_MAX } from "../../recommendations/evidence";
import type { RecommendationDraft } from "../../recommendations/store";
import { pageMetrics, weightedPosition, type EntityMetrics, type SliceRow } from "../gsc/aggregate";
import { createBrandClassifier, type BrandClassifier } from "../gsc/brand";
import { DEMAND_METHOD_VERSION, demandLookup, demandPhrase, normalizeDemandQuery, type RankedQuery } from "../gsc/demand";
import { detectAlternatingUrls, type AlternatingQuery } from "../gsc/slices";
import { windowLabel } from "../gsc/windows";
import { getRule } from "../rules/registry";
import type { ActionChoice } from "../questions";
import { classifyDecay, DECAY_CAUSE_LABEL, DECAY_CAUSE_VERSION, yoyVerdict, type WindowMetric } from "./decay";
import { detectStaleYears, STALE_YEAR_VERSION } from "./freshness";
import type { CandidateInputs, PageInfo } from "./inputs";
import { SEVERITY_WEIGHT, type PriorityInputs } from "./priority";
import { offerPriceCheck, schemaConflicts, SCHEMA_CONFLICT_TEXT, SCHEMA_MATCH_VERSION } from "./schema-match";
import { clip, coverage, fmtInt, fmtPct, fmtPos, looksLikeInstructions, normalizeUrl, queryKey, sharedCount, tokenSet } from "./text";

export const CANDIDATE_RULES_VERSION = "seo-candidates-2026-09-30.3";

export interface CandidateConfig {
  minImpressions: number;
  medianMinImpressions: number;
  ctrBucketMinRows: number;
  ctrBelowMedianFactor: number;
  strikingMinPosition: number;
  strikingMaxPosition: number;
  decliningMinPrevClicks: number;
  decliningMinDrop: number;
  matchMinCoverage: number;
  mismatchMargin: number;
  coverageGapMinQueryImpressions: number;
  coverageGapMaxCoverage: number;
  internalLinkMinImpressions: number;
  internalLinkMaxInlinks: number;
  internalLinkMinCrawled: number;
  engineReinforceMaxPosition: number;
  maxEngineQueries: number;
  templateMinUrls: number;
  technicalMinSeverity: Severity;
  duplicateMinSharedTokens: number;
  duplicateMinShorterShare: number;
  maxDuplicatePairs: number;
  maxPerKind: number;
  /** [A23] answer_clarity: minimum impressions of the page's top query. */
  answerMinImpressions: number;
  /** [A25] internal link suggestions turned into candidates per run (act tier only). */
  maxLinkSuggestions: number;
}

export const DEFAULT_CANDIDATE_CONFIG: CandidateConfig = {
  minImpressions: 100,
  medianMinImpressions: 20,
  ctrBucketMinRows: 3,
  ctrBelowMedianFactor: 0.8,
  strikingMinPosition: 4,
  strikingMaxPosition: 20,
  decliningMinPrevClicks: 20,
  decliningMinDrop: 0.3,
  matchMinCoverage: 0.6,
  mismatchMargin: 0.2,
  coverageGapMinQueryImpressions: 50,
  coverageGapMaxCoverage: 0.5,
  internalLinkMinImpressions: 200,
  internalLinkMaxInlinks: 1,
  internalLinkMinCrawled: 3,
  engineReinforceMaxPosition: 10,
  maxEngineQueries: 10,
  templateMinUrls: 3,
  technicalMinSeverity: "minor",
  duplicateMinSharedTokens: 2,
  duplicateMinShorterShare: 0.5,
  maxDuplicatePairs: 40,
  maxPerKind: 10,
  answerMinImpressions: 50,
  maxLinkSuggestions: 5,
};

export type CandidateKind =
  | "weak_ctr"
  | "striking_distance"
  | "declining"
  | "query_page_mismatch"
  | "coverage_gap"
  | "internal_link"
  | "engine_query"
  | "technical"
  | "duplicate"
  | "checklist"
  | "freshness"
  | "schema_mismatch"
  | "answer_clarity";

export interface EvidenceSpec {
  source: EvidenceSource;
  refId: string | null;
  window: string | null;
  text: string;
  data: unknown;
  tainted?: boolean;
}

export interface Candidate {
  /** Readable, stable key (decision_records.candidate_key). */
  key: string;
  kind: CandidateKind;
  issueType: string;
  /** Content opportunities need Jev; technical findings do not. */
  jevDependent: boolean;
  scope: Scope;
  target: RecommendationDraft["target"];
  trigger: string;
  issue: string;
  query: string | null;
  page: PageInfo | null;
  pageB: PageInfo | null;
  sharedQueries: string[];
  pageType: PageType | null;
  severity: Severity | null;
  metrics: Record<string, number | string | null>;
  priority: PriorityInputs;
  defaultAction: ActionChoice | null;
  evidence: EvidenceSpec[];
  /** Stable identity for the dedup key (not metrics, so reruns match). */
  identity: unknown;
  engineMatch: "reinforce" | "improve" | "no_matching_page" | null;
  wantsIntent: boolean;
  wantsPillar: boolean;
  /** Crawl evidence exists for the target. */
  verified: boolean;
  /** Human review required regardless of Jev tier (tier capped at flag). */
  reviewRequired: boolean;
  limitations: string;
  /** Demand segment of `query` in this site's own GSC impressions (null without a GSC query). */
  demand: CandidateDemand | null;
  /** [A21] Set for kind 'checklist': the checklist item and the code-owned draft parts. */
  checklist?: ChecklistCandidateMeta;
  /** [A23] Tier cap from a pre-filter (query relevance middle band): the result is shown with "Check this yourself". */
  tierCap?: Extract<Tier, "flag"> | null;
  /** [A23]/[A25] Code-owned action text (freshness, schema mismatch, link suggestions); the draft appends citations. */
  actionText?: string | null;
  /** Draft with the deterministic template only (code-owned text; the writer is not asked). */
  deterministicOnly?: boolean;
  /** [A25] Extra rationale sentence and the index (in `evidence`) of the evidence it is drawn from. */
  rationaleNote?: { text: string; evidenceIndex: number } | null;
  /** [A23] Topics for seo.covers_topic: GSC gap queries plus engine search queries matched to the page. */
  coverageQueries?: string[];
  /** [A23] Freshness: dated references found by the stale-year detector (for Jev state). */
  datedReferences?: string[];
  /** [A23] Schema mismatch: deterministic conflict descriptions. */
  schemaConflicts?: string[];
  /** [A25] The internal link suggestion this candidate came from (its Jev tier is reused, never re-asked). */
  linkSuggestion?: LinkSuggestionMeta;
}

export interface LinkSuggestionMeta {
  id: string;
  sourceUrl: string;
  targetUrl: string;
  anchor: string;
  sentence: string;
  role: string | null;
  tier: Tier;
  /** Noul from the suggester's links.should_exist question. */
  shouldExist: number | null;
  provider: string | null;
  model: string | null;
}

/** Checklist provenance and code-owned draft parts for a 'checklist' candidate (see checklist-candidates.ts). */
export interface ChecklistCandidateMeta {
  itemId: string;
  checklistKind: "seo" | "geo" | "page";
  checklistVersion: string;
  label: string;
  status: "not_met" | "partial";
  method: "measured" | "heuristic";
  /** Deterministic action text (the draft step appends evidence citations); null = use the Jev action's template. */
  actionText: string | null;
  rationale: string;
  /** Code-owned snippet (robots.txt advisor suggestion); never produced or changed by the writer. */
  snippet: string | null;
  /** Draft with the deterministic template only (the snippet and its limitations are code-owned). */
  deterministicOnly: boolean;
  effort: Level;
}

export interface CandidateDemand {
  query: string;
  segment: RankedQuery["segment"];
  strongIntent: boolean | null;
  methodVersion: string;
}

const SEVERITY_RANK: Record<Severity, number> = { advisory: 0, minor: 1, moderate: 2, major: 3, critical: 4 };
const TEMPLATE_PAGE_TYPES = new Set<PageType>(["product", "collection", "article"]);

export function positionBucket(position: number): "1-3" | "4-10" | "11-20" | null {
  const p = Math.round(position);
  if (p < 1) return null;
  if (p <= 3) return "1-3";
  if (p <= 10) return "4-10";
  if (p <= 20) return "11-20";
  return null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const rowCtr = (r: { clicks: number; impressions: number }) => (r.impressions > 0 ? r.clicks / r.impressions : 0);

export function buildCandidates(inputs: CandidateInputs, config: Partial<CandidateConfig> = {}): Candidate[] {
  const cfg = { ...DEFAULT_CANDIDATE_CONFIG, ...config };
  const b = new Builder(inputs, cfg);
  const out: Candidate[] = [];
  const cap = (list: Candidate[]) => list.slice(0, cfg.maxPerKind);
  const weak = b.weakCtr();
  out.push(...cap(weak));
  out.push(...cap(b.strikingDistance(new Set(weak.map((c) => `${c.query}|${c.page?.norm ?? c.target.url}`)))));
  out.push(...cap(b.declining()));
  out.push(...cap(b.queryPageMismatch()));
  out.push(...cap(b.coverageGap()));
  const links = b.linkSuggestions().slice(0, cfg.maxLinkSuggestions);
  out.push(...links);
  out.push(...cap(b.internalLinks(new Set(links.map((c) => normalizeUrl(c.linkSuggestion!.targetUrl))))));
  out.push(...b.engineQueries());
  out.push(...b.technical());
  out.push(...b.duplicates());
  out.push(...cap(b.freshness()));
  out.push(...cap(b.schemaMismatch()));
  out.push(...cap(b.answerClarity()));
  return out.map((c) => b.finalize(c));
}

/** [A25] Declining pages whose dip matches the same window last year (not emitted as candidates). */
export function seasonalSuppressions(inputs: CandidateInputs, config: Partial<CandidateConfig> = {}): Array<{ url: string; currentClicks: number; lastYearClicks: number }> {
  const b = new Builder(inputs, { ...DEFAULT_CANDIDATE_CONFIG, ...config });
  b.declining();
  return b.seasonal;
}

const EMPTY_TERMS = { self: [], competitors: [], skipped: [] };
const LEGAL_PATH = /\/(privacy|terms|legal|policy|policies|cookie|cookies|imprint|gdpr|accessibility)(\/|$|[-_.])/i;
/** Question-like query (answer_clarity shortlist; English). */
export const QUESTION_QUERY = /\?|^(how|what|why|which|when|where|who|can|does|do|is|are|should|will|best way)\b/i;

function isLegalUrl(url: string): boolean {
  try {
    return LEGAL_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Evidence sentence for a query's demand segment (first-party impressions only). */
export function demandSentence(d: CandidateDemand): string {
  return `Demand: "${clip(d.query, 80)}" is ${demandPhrase(d)} in this site's own Search Console impressions, not market search volume.`;
}

class Builder {
  readonly pagesByNorm = new Map<string, PageInfo>();
  readonly cur: SliceRow[];
  readonly qp: SliceRow[];
  readonly win: string | null;
  readonly prevWin: string | null;
  readonly gscSource: EvidenceSource;
  readonly gscLabel: string;
  readonly totalImpr: number | null;
  readonly totalClicks: number | null;
  readonly pageMetricsCur: Map<string, EntityMetrics>;
  readonly pageMetricsPrev: Map<string, EntityMetrics>;
  readonly demand: Map<string, RankedQuery>;
  readonly brandTokens: Set<string>;
  readonly brand: BrandClassifier;
  readonly rows: SliceRow[];
  readonly dropped: Set<string>;
  /** [A25] Declining pages suppressed as seasonal by the YoY check (filled by declining()). */
  seasonal: Array<{ url: string; currentClicks: number; lastYearClicks: number }> = [];

  constructor(readonly inp: CandidateInputs, readonly cfg: CandidateConfig) {
    for (const p of inp.pages) this.pagesByNorm.set(p.norm, p);
    this.brand = createBrandClassifier(inp.project.brandTerms ?? EMPTY_TERMS);
    this.dropped = inp.queryFilter?.dropped ?? new Set<string>();
    // [A23] Queries Jev confidently judged "not about this business" never drive candidates.
    this.rows = this.dropped.size ? inp.rows.filter((r) => !(r.query && this.dropped.has(normalizeDemandQuery(r.query)))) : inp.rows;
    this.cur = this.rows.filter((r) => r.window === "current");
    this.qp = this.cur.filter((r) => r.query && r.page);
    this.win = inp.sync ? windowLabel(inp.sync.current) : null;
    this.prevWin = inp.sync ? windowLabel(inp.sync.previous) : null;
    this.gscSource = inp.sync?.source === "csv_import" ? "manual_import" : "gsc";
    this.gscLabel = inp.sync?.source === "csv_import" ? "GSC CSV import" : inp.sync?.source === "demo" ? "GSC (demo data)" : "GSC";
    // Denominators: property totals when present; otherwise the current slice sum (ranking signal only, never displayed).
    const t = inp.sync?.totals.current;
    const sliceImpr = this.cur.reduce((s, r) => s + (r.query && r.page ? r.impressions : 0), 0);
    const sliceClicks = this.cur.reduce((s, r) => s + (r.query && r.page ? r.clicks : 0), 0);
    this.totalImpr = t ? t.impressions : sliceImpr > 0 ? sliceImpr : null;
    this.totalClicks = t ? t.clicks : sliceClicks > 0 ? sliceClicks : null;
    this.pageMetricsCur = pageMetrics(this.rows, "current", normalizeUrl);
    this.pageMetricsPrev = pageMetrics(this.rows, "previous", normalizeUrl);
    // Demand segments come from the non-brand curve (the overview's default), before the relevance filter.
    this.demand = demandLookup(
      inp.rows.filter((r) => r.window === "current" && !(r.query && this.brand.isSelfBrand(r.query))),
      inp.project.language,
    );
    this.brandTokens = new Set(inp.project.brandTokens ?? []);
  }

  demandOf(query: string | null | undefined): CandidateDemand | null {
    if (!query) return null;
    const r = this.demand.get(normalizeDemandQuery(query));
    return r ? { query: r.query, segment: r.segment, strongIntent: r.strongIntent, methodVersion: DEMAND_METHOD_VERSION } : null;
  }

  /** Title tokens without the brand name/aliases (a shared "| Brand" suffix is not topical overlap). */
  titleTokens(p: PageInfo): Set<string> {
    const t = tokenSet(p.title);
    for (const b of this.brandTokens) t.delete(b);
    return t;
  }

  // ---------------------------------------------------------------- evidence helpers
  gscRowEvidence(rows: SliceRow[], label: string, focusQuery: string | null = null): EvidenceSpec {
    const lines = rows.slice(0, 5).map((r) => {
      const who = r.query && r.page ? `query "${clip(r.query, 80)}" on ${r.page}` : r.query ? `query "${clip(r.query, 80)}"` : `page ${r.page}`;
      return `${who}: ${fmtInt(r.impressions)} impressions, ${fmtInt(r.clicks)} clicks, CTR ${fmtPct(rowCtr(r))}, average position ${fmtPos(r.position)}`;
    });
    const demand = this.demandOf(focusQuery ?? rows.find((r) => r.query)?.query ?? null);
    const prefix = `${this.gscLabel} ${this.win} (${label}): `;
    const suffix = demand ? ` ${demandSentence(demand)}` : "";
    // Whole rows only, so the stored (capped) text never cuts a number and the demand note survives.
    const kept: string[] = [];
    for (const l of lines) {
      if (kept.length > 0 && prefix.length + [...kept, l].join("; ").length + 1 + suffix.length > EVIDENCE_TEXT_MAX) break;
      kept.push(l);
    }
    return {
      source: this.gscSource,
      refId: this.inp.sync?.id ?? null,
      window: this.win,
      text: `${prefix}${kept.join("; ")}.${suffix}`,
      data: {
        rows: rows.slice(0, 5).map((r) => ({ query: r.query, page: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position })),
        ...(demand ? { demand } : {}),
      },
    };
  }

  pageMetricEvidence(url: string, m: EntityMetrics, which: "current" | "previous"): EvidenceSpec {
    const w = which === "current" ? this.win : this.prevWin;
    const basis = m.basis === "page_rows" ? "page totals" : "sum of query/page rows, a lower bound";
    return {
      source: this.gscSource,
      refId: this.inp.sync?.id ?? null,
      window: w,
      text: `${this.gscLabel} ${w} (${which} window, ${basis}): page ${url}: ${fmtInt(m.impressions)} impressions, ${fmtInt(m.clicks)} clicks, CTR ${fmtPct(m.ctr.value)}.`,
      data: { page: url, window: which, clicks: m.clicks, impressions: m.impressions, basis: m.basis },
    };
  }

  crawlEvidence(p: PageInfo, extra = ""): EvidenceSpec {
    const parts = [`title "${clip(p.title, 120) || "(none)"}"`, `H1 "${clip(p.h1, 120) || "(none)"}"`];
    if (p.metaDescription !== null) parts.push(`meta description "${clip(p.metaDescription, 160)}"`);
    return {
      source: "crawl",
      refId: p.snapshotId,
      window: p.fetchedAt.slice(0, 10),
      text: `Crawled ${p.url} (${p.pageType}) on ${p.fetchedAt.slice(0, 10)}: ${parts.join("; ")}${extra ? `; ${extra}` : ""}.`,
      data: { url: p.url, pageType: p.pageType, title: p.title, h1: p.h1, metaDescription: p.metaDescription },
      tainted: p.tainted,
    };
  }

  ruleEvidence(rule: string, text: string, data: unknown, refId: string | null = null): EvidenceSpec {
    return { source: "rule", refId, window: this.win, text: `Rule ${rule} (${CANDIDATE_RULES_VERSION}): ${text}`, data };
  }

  gscLimitations(extra = ""): string {
    const trunc = this.inp.sync?.truncated ? " Rows were truncated at the project row cap." : "";
    return `${this.gscLabel} data for ${this.win}; anonymized queries are excluded and all devices are combined.${trunc}${extra ? ` ${extra}` : ""} Heuristic candidate; no ranking or traffic change is promised.`.slice(0, 400);
  }

  priorityFor(impressions: number | null, clicks: number | null, effort: Level, severity: number | null = null, reach: number | null = null): PriorityInputs {
    return { impressions, clicks, totalImpressions: this.totalImpr, totalClicks: this.totalClicks, severity, reach, effort };
  }

  bestMatchingPage(query: string): { page: PageInfo; score: number } | null {
    const q = tokenSet(query);
    let best: { page: PageInfo; score: number } | null = null;
    for (const p of this.inp.pages) {
      const score = coverage(q, tokenSet(`${p.title ?? ""} ${p.h1 ?? ""}`));
      if (!best || score > best.score) best = { page: p, score };
    }
    return best;
  }

  base(kind: CandidateKind, partial: Partial<Candidate> & Pick<Candidate, "key" | "issueType" | "trigger" | "issue" | "evidence" | "identity" | "priority">): Candidate {
    return {
      kind,
      jevDependent: kind !== "technical",
      scope: "page",
      target: { kind: "url" },
      query: null,
      page: null,
      pageB: null,
      sharedQueries: [],
      pageType: partial.page?.pageType ?? null,
      severity: null,
      metrics: {},
      defaultAction: null,
      engineMatch: null,
      wantsIntent: false,
      wantsPillar: false,
      verified: !!partial.page,
      reviewRequired: false,
      limitations: this.gscLimitations(),
      demand: null,
      ...partial,
    };
  }

  /** withDemand() plus the relevance tier cap and the competitor-brand flag. */
  finalize(c: Candidate): Candidate {
    let out = this.withDemand(c);
    const flagged = this.inp.queryFilter?.flagged;
    if (out.query && flagged?.has(normalizeDemandQuery(out.query))) {
      out = {
        ...out,
        tierCap: "flag",
        limitations: clip(`${out.limitations} Jev was unsure whether this query is about the business (query relevance middle band); check it yourself.`, 400),
      };
    }
    if (out.query && this.brand.classify(out.query).kind === "competitor_brand") out = { ...out, metrics: { ...out.metrics, competitorBrand: "yes" } };
    return out;
  }

  /** base() plus demand tagging from the candidate's query (metrics carry the segment for Jev state). */
  withDemand(c: Candidate): Candidate {
    const demand = c.demand ?? this.demandOf(c.query);
    if (!demand) return c;
    return { ...c, demand, metrics: { ...c.metrics, demandSegment: demand.segment, strongIntent: demand.strongIntent === null ? null : demand.strongIntent ? "yes" : "no" } };
  }

  // ---------------------------------------------------------------- weak_ctr
  weakCtr(): Candidate[] {
    if (!this.inp.sync) return [];
    // [A23] Brand queries are excluded from the medians and the flagged rows (brand CTR is not comparable).
    const units = (this.qp.length ? this.qp : this.cur.filter((r) => r.page && !r.query)).filter((r) => !(r.query && this.brand.isSelfBrand(r.query)));
    const byBucket = new Map<string, number[]>();
    for (const r of units) {
      const bkt = positionBucket(r.position);
      if (!bkt || r.impressions < this.cfg.medianMinImpressions) continue;
      const list = byBucket.get(bkt) ?? [];
      list.push(rowCtr(r));
      byBucket.set(bkt, list);
    }
    const medians = new Map<string, { median: number; n: number }>();
    for (const [bkt, list] of byBucket) {
      const m = median(list);
      if (m !== null && m > 0 && list.length >= this.cfg.ctrBucketMinRows) medians.set(bkt, { median: m, n: list.length });
    }
    const byPage = new Map<string, Array<{ r: SliceRow; bkt: string; med: { median: number; n: number } }>>();
    for (const r of units) {
      const bkt = positionBucket(r.position);
      const med = bkt ? medians.get(bkt) : undefined;
      if (!bkt || !med || r.impressions < this.cfg.minImpressions) continue;
      if (rowCtr(r) >= med.median * this.cfg.ctrBelowMedianFactor) continue;
      const k = normalizeUrl(r.page!);
      const list = byPage.get(k) ?? [];
      list.push({ r, bkt, med });
      byPage.set(k, list);
    }
    const out: Candidate[] = [];
    for (const [norm, list] of byPage) {
      list.sort((a, b) => b.r.impressions - a.r.impressions);
      const top = list[0]!;
      const page = this.pagesByNorm.get(norm) ?? null;
      const impressions = list.reduce((s, x) => s + x.r.impressions, 0);
      const clicks = list.reduce((s, x) => s + x.r.clicks, 0);
      const ev: EvidenceSpec[] = [
        this.gscRowEvidence(list.map((x) => x.r), "rows with CTR below their position-bucket median"),
        this.ruleEvidence(
          "weak_ctr",
          `median CTR for position bucket ${top.bkt} across ${top.med.n} query/page rows with at least ${this.cfg.medianMinImpressions} impressions is ${fmtPct(top.med.median)}; flagged rows are below ${fmtPct(top.med.median * this.cfg.ctrBelowMedianFactor)}.`,
          { bucket: top.bkt, median: top.med.median, rows: top.med.n, factor: this.cfg.ctrBelowMedianFactor },
        ),
      ];
      if (page) ev.push(this.crawlEvidence(page));
      out.push(
        this.base("weak_ctr", {
          key: `weak_ctr:${norm}`,
          issueType: "weak_ctr",
          trigger: `From GSC query "${clip(top.r.query ?? top.r.page, 80)}"`,
          issue: `Search results for ${top.r.page} get fewer clicks than similar positions on this site.`,
          query: top.r.query,
          page,
          target: { kind: "url", url: top.r.page! },
          metrics: { impressions, clicks, ctr: impressions ? clicks / impressions : null, position: top.r.position, bucket: top.bkt, bucketMedianCtr: top.med.median },
          priority: this.priorityFor(impressions, clicks, "low"),
          defaultAction: "rewrite_title_meta",
          evidence: ev,
          identity: { page: norm },
          wantsIntent: !!top.r.query,
        }),
      );
    }
    return out.sort((a, b) => Number(b.metrics.impressions) - Number(a.metrics.impressions));
  }

  // ---------------------------------------------------------------- striking_distance
  strikingDistance(exclude: Set<string>): Candidate[] {
    if (!this.inp.sync) return [];
    const byQuery = new Map<string, SliceRow[]>();
    const src = this.qp.length ? this.qp : this.cur.filter((r) => r.query && !r.page);
    for (const r of src) {
      const list = byQuery.get(r.query!) ?? [];
      list.push(r);
      byQuery.set(r.query!, list);
    }
    const out: Candidate[] = [];
    for (const [query, rows] of byQuery) {
      if (this.brand.isSelfBrand(query)) continue; // [A23] brand queries are not striking-distance opportunities
      const impressions = rows.reduce((s, r) => s + r.impressions, 0);
      const clicks = rows.reduce((s, r) => s + r.clicks, 0);
      const pos = weightedPosition(rows);
      if (pos === null || impressions < this.cfg.minImpressions) continue;
      if (pos < this.cfg.strikingMinPosition - 0.5 || pos >= this.cfg.strikingMaxPosition + 0.5) continue;
      const top = [...rows].sort((a, b) => b.impressions - a.impressions)[0]!;
      let pageUrl = top.page;
      let page = pageUrl ? (this.pagesByNorm.get(normalizeUrl(pageUrl)) ?? null) : null;
      if (!pageUrl) {
        const best = this.bestMatchingPage(query);
        if (!best || best.score < this.cfg.matchMinCoverage) continue;
        page = best.page;
        pageUrl = best.page.url;
      }
      if (exclude.has(`${query}|${normalizeUrl(pageUrl)}`)) continue;
      const ev: EvidenceSpec[] = [
        this.gscRowEvidence(rows, "query in striking distance"),
        this.ruleEvidence(
          "striking_distance",
          `query "${clip(query, 80)}" has ${fmtInt(impressions)} impressions at an impression-weighted average position of ${fmtPos(pos)} (window ${this.cfg.strikingMinPosition}-${this.cfg.strikingMaxPosition}).`,
          { query, impressions, position: pos },
        ),
      ];
      if (page) ev.push(this.crawlEvidence(page));
      out.push(
        this.base("striking_distance", {
          key: `striking_distance:${queryKey(query)}|${normalizeUrl(pageUrl)}`,
          issueType: "striking_distance",
          trigger: `From GSC query "${clip(query, 80)}"`,
          issue: `The query "${clip(query, 80)}" ranks just off the top results for ${pageUrl}.`,
          query,
          page,
          target: { kind: "url", url: pageUrl },
          metrics: { impressions, clicks, position: pos },
          priority: this.priorityFor(impressions, clicks, "medium"),
          defaultAction: "add_section",
          evidence: ev,
          identity: { query: queryKey(query), page: normalizeUrl(pageUrl) },
          wantsIntent: true,
        }),
      );
    }
    return out.sort((a, b) => Number(b.metrics.impressions) - Number(a.metrics.impressions));
  }

  // ---------------------------------------------------------------- declining
  declining(): Candidate[] {
    if (!this.inp.sync) return [];
    this.seasonal = [];
    const yoy = this.inp.sync.extras?.yoy?.status === "available" ? this.inp.sync.extras.yoy : null;
    const lyWin = yoy ? windowLabel(yoy.window) : null;
    const lyPages = new Map<string, WindowMetric>();
    if (yoy) {
      for (const [page, clicks, impressions, position] of yoy.pages) {
        const k = normalizeUrl(page);
        const cur = lyPages.get(k);
        lyPages.set(k, cur ? { clicks: cur.clicks + clicks, impressions: cur.impressions + impressions, position: cur.position } : { clicks, impressions, position: position > 0 ? position : null });
      }
    }
    const out: Candidate[] = [];
    for (const [norm, prev] of this.pageMetricsPrev) {
      const cur = this.pageMetricsCur.get(norm);
      if (prev.clicks < this.cfg.decliningMinPrevClicks) continue;
      const curClicks = cur?.clicks ?? 0;
      const drop = (prev.clicks - curClicks) / prev.clicks;
      if (drop < this.cfg.decliningMinDrop) continue;
      const page = this.pagesByNorm.get(norm) ?? null;
      const url = page?.url ?? norm;
      // [A25] Seasonality: not down against the same window last year -> suppressed.
      const ly = yoy ? (lyPages.get(norm) ?? null) : null;
      const verdict = yoy ? yoyVerdict(curClicks, ly, { minPrevClicks: this.cfg.decliningMinPrevClicks, minDrop: this.cfg.decliningMinDrop }) : "no_comparison";
      if (verdict === "seasonal") {
        this.seasonal.push({ url, currentClicks: curClicks, lastYearClicks: ly!.clicks });
        continue;
      }
      const ev: EvidenceSpec[] = [this.pageMetricEvidence(url, prev, "previous")];
      if (cur) ev.push(this.pageMetricEvidence(url, cur, "current"));
      ev.push(
        this.ruleEvidence(
          "declining",
          `clicks for ${url} changed from ${fmtInt(prev.clicks)} (${this.prevWin}) to ${fmtInt(curClicks)} (${this.win}), a drop of ${fmtPct(drop)}; threshold is a ${fmtPct(this.cfg.decliningMinDrop)} drop with at least ${this.cfg.decliningMinPrevClicks} previous clicks.`,
          { page: url, previousClicks: prev.clicks, currentClicks: curClicks, drop },
        ),
      );
      if (ly && lyWin) {
        ev.push({
          source: this.gscSource,
          refId: this.inp.sync.id,
          window: lyWin,
          text: `${this.gscLabel} ${lyWin} (same window last year, page totals): page ${url}: ${fmtInt(ly.impressions)} impressions, ${fmtInt(ly.clicks)} clicks. This window is ${verdict === "down_yoy" ? "also down against last year" : "not comparable (too few clicks last year)"}.`,
          data: { page: url, window: "last_year", clicks: ly.clicks, impressions: ly.impressions, position: ly.position, verdict },
        });
      }
      // [A25] Likely causes (deterministic; decay.ts).
      const changed = page && page.contentHash && page.previousContentHash ? page.contentHash !== page.previousContentHash : null;
      const decay = classifyDecay(
        { clicks: prev.clicks, impressions: prev.impressions, position: prev.approxPosition },
        { clicks: curClicks, impressions: cur?.impressions ?? 0, position: cur?.approxPosition ?? null },
        { changed },
      );
      let rationaleNote: Candidate["rationaleNote"] = null;
      if (decay.causes.length) {
        rationaleNote = {
          text: `Likely cause from the project's own Search Console and crawl data: ${decay.causes.map((c) => DECAY_CAUSE_LABEL[c]).join("; ")}.`,
          evidenceIndex: ev.length,
        };
        ev.push(
          this.ruleEvidence(
            "decay_cause",
            `likely cause for ${url} (${DECAY_CAUSE_VERSION}): ${decay.causes.map((c) => DECAY_CAUSE_LABEL[c]).join("; ")}: ${decay.details.join("; ")}.`,
            {
              page: url,
              causes: decay.causes,
              details: decay.details,
              previous: { clicks: prev.clicks, impressions: prev.impressions, position: prev.approxPosition },
              current: { clicks: curClicks, impressions: cur?.impressions ?? 0, position: cur?.approxPosition ?? null },
              contentChanged: changed,
              yoy: verdict,
              version: DECAY_CAUSE_VERSION,
            },
            page?.snapshotId ?? null,
          ),
        );
      }
      if (page) ev.push(this.crawlEvidence(page));
      const yoyText =
        verdict === "down_yoy"
          ? "Clicks are also down against the same window last year, so this is not only seasonal."
          : yoy
            ? "Last year's data for this page was too thin to rule out seasonality; check before editing."
            : "A click drop can have causes outside the page (seasonality, SERP changes); check before editing.";
      out.push(
        this.base("declining", {
          key: `declining:${norm}`,
          issueType: "declining_page",
          trigger: `Clicks down ${fmtPct(drop)} vs the previous window`,
          issue: `Search clicks to ${url} dropped compared with the previous window.`,
          page,
          target: { kind: "url", url },
          metrics: {
            clicks: curClicks,
            previousClicks: prev.clicks,
            drop,
            impressions: cur?.impressions ?? 0,
            decayCauses: decay.causes.join(",") || null,
            yoy: verdict,
          },
          priority: this.priorityFor(null, prev.clicks - curClicks, "medium"),
          defaultAction: "improve_intro_answer",
          evidence: ev,
          identity: { page: norm },
          rationaleNote,
          limitations: this.gscLimitations(yoyText),
        }),
      );
    }
    return out.sort((a, b) => Number(b.metrics.previousClicks) - Number(a.metrics.previousClicks));
  }

  // ---------------------------------------------------------------- query_page_mismatch
  queryPageMismatch(): Candidate[] {
    if (!this.inp.sync || this.inp.pages.length < 2) return [];
    const byQuery = new Map<string, SliceRow[]>();
    for (const r of this.qp) {
      const list = byQuery.get(r.query!) ?? [];
      list.push(r);
      byQuery.set(r.query!, list);
    }
    const out: Candidate[] = [];
    for (const [query, rows] of byQuery) {
      const impressions = rows.reduce((s, r) => s + r.impressions, 0);
      if (impressions < this.cfg.minImpressions) continue;
      const top = [...rows].sort((a, b) => b.impressions - a.impressions)[0]!;
      const topPage = this.pagesByNorm.get(normalizeUrl(top.page!));
      if (!topPage) continue;
      const q = tokenSet(query);
      const topScore = coverage(q, tokenSet(`${topPage.title ?? ""} ${topPage.h1 ?? ""}`));
      const best = this.bestMatchingPage(query);
      if (!best || best.page.norm === topPage.norm) continue;
      if (best.score < this.cfg.matchMinCoverage || best.score < topScore + this.cfg.mismatchMargin) continue;
      const clicks = rows.reduce((s, r) => s + r.clicks, 0);
      out.push(
        this.base("query_page_mismatch", {
          key: `query_page_mismatch:${queryKey(query)}|${best.page.norm}`,
          issueType: "query_page_mismatch",
          trigger: `From GSC query "${clip(query, 80)}"`,
          issue: `Search Console shows ${topPage.url} for "${clip(query, 80)}", but ${best.page.url} matches the query more closely.`,
          query,
          page: best.page,
          pageB: topPage,
          target: { kind: "url", url: best.page.url, exampleUrls: [best.page.url, topPage.url] },
          metrics: { impressions, clicks, bestCoverage: best.score, topCoverage: topScore },
          priority: this.priorityFor(impressions, clicks, "low"),
          defaultAction: "add_internal_links",
          evidence: [
            this.gscRowEvidence([top], "page Search Console shows for the query"),
            this.ruleEvidence(
              "query_page_mismatch",
              `"${clip(query, 80)}": ${fmtPct(best.score)} of its words appear in the title/H1 of ${best.page.url}, versus ${fmtPct(topScore)} for ${topPage.url}.`,
              { query, best: best.page.url, bestCoverage: best.score, top: topPage.url, topCoverage: topScore },
            ),
            this.crawlEvidence(best.page),
            this.crawlEvidence(topPage),
          ],
          identity: { query: queryKey(query), best: best.page.norm, top: topPage.norm },
          wantsIntent: true,
        }),
      );
    }
    return out.sort((a, b) => Number(b.metrics.impressions) - Number(a.metrics.impressions));
  }

  // ---------------------------------------------------------------- coverage_gap
  coverageGap(): Candidate[] {
    if (!this.inp.sync) return [];
    const byPage = new Map<string, SliceRow[]>();
    for (const r of this.qp) {
      if (r.impressions < this.cfg.coverageGapMinQueryImpressions) continue;
      const k = normalizeUrl(r.page!);
      const list = byPage.get(k) ?? [];
      list.push(r);
      byPage.set(k, list);
    }
    const out: Candidate[] = [];
    for (const [norm, rows] of byPage) {
      const page = this.pagesByNorm.get(norm);
      if (!page) continue;
      const hay = tokenSet([page.title, page.h1, page.metaDescription, ...page.headings, page.excerpt].filter(Boolean).join(" "));
      const gaps = rows
        .filter((r) => coverage(tokenSet(r.query!), hay) < this.cfg.coverageGapMaxCoverage)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 5);
      if (gaps.length === 0) continue;
      const impressions = gaps.reduce((s, r) => s + r.impressions, 0);
      if (impressions < this.cfg.minImpressions) continue;
      const clicks = gaps.reduce((s, r) => s + r.clicks, 0);
      const engineTopics = this.engineQueriesForPage(norm).filter((q) => !gaps.some((g) => queryKey(g.query!) === queryKey(q)));
      out.push(
        this.base("coverage_gap", {
          coverageQueries: [...gaps.map((g) => g.query!), ...engineTopics].slice(0, 8),
          key: `coverage_gap:${norm}`,
          issueType: "coverage_gap",
          trigger: `From GSC query "${clip(gaps[0]!.query, 80)}"`,
          issue: `${page.url} receives impressions for queries whose words are mostly missing from its title, headings, and opening text.`,
          query: gaps[0]!.query,
          page,
          target: { kind: "url", url: page.url },
          metrics: { impressions, clicks, queries: gaps.length },
          priority: this.priorityFor(impressions, clicks, "medium"),
          defaultAction: "add_section",
          evidence: [
            this.gscRowEvidence(gaps, "queries not covered by the page's headings or text"),
            this.crawlEvidence(page, `headings: ${clip(page.headings.slice(0, 8).join(" | "), 200) || "(none)"}`),
          ],
          identity: { page: norm },
          wantsIntent: true,
          wantsPillar: true,
          limitations: this.gscLimitations("Coverage is checked against the crawled title, headings, and a capped text excerpt only."),
        }),
      );
    }
    return out.sort((a, b) => Number(b.metrics.impressions) - Number(a.metrics.impressions));
  }

  // ---------------------------------------------------------------- internal_link
  internalLinks(suggestedTargets: Set<string> = new Set()): Candidate[] {
    if (!this.inp.sync || !this.inp.crawl || this.inp.pages.length < this.cfg.internalLinkMinCrawled) return [];
    const inlinks = new Map<string, Set<string>>();
    for (const p of this.inp.pages) {
      for (const l of p.internalLinks) {
        if (l === p.norm) continue;
        const set = inlinks.get(l) ?? new Set<string>();
        set.add(p.norm);
        inlinks.set(l, set);
      }
    }
    const crawled = this.inp.pages.length;
    const out: Candidate[] = [];
    for (const p of this.inp.pages) {
      if (p.pageType === "home") continue;
      if (suggestedTargets.has(p.norm)) continue; // [A25] a concrete link suggestion covers this target
      const m = this.pageMetricsCur.get(p.norm);
      if (!m || m.impressions < this.cfg.internalLinkMinImpressions) continue;
      const count = inlinks.get(p.norm)?.size ?? 0;
      if (count > this.cfg.internalLinkMaxInlinks) continue;
      out.push(
        this.base("internal_link", {
          key: `internal_link:${p.norm}`,
          issueType: "internal_link",
          trigger: `High-impression page with ${count} internal inlinks`,
          issue: `${p.url} gets search impressions but few crawled pages link to it.`,
          page: p,
          target: { kind: "url", url: p.url },
          metrics: { impressions: m.impressions, clicks: m.clicks, inlinks: count, crawled },
          priority: this.priorityFor(m.impressions, m.clicks, "low"),
          defaultAction: "add_internal_links",
          evidence: [
            this.pageMetricEvidence(p.url, m, "current"),
            {
              source: "crawl",
              refId: this.inp.crawl.id,
              window: this.inp.crawl.day,
              text: `Crawl on ${this.inp.crawl.day}: ${count} of ${crawled} crawled pages link to ${p.url}.`,
              data: { inlinks: count, crawled, linkedFrom: [...(inlinks.get(p.norm) ?? [])].slice(0, 5) },
            },
          ],
          identity: { page: p.norm },
          limitations: this.gscLimitations(`Inlinks are counted only within the ${crawled} crawled pages.`),
        }),
      );
    }
    return out.sort((a, b) => Number(b.metrics.impressions) - Number(a.metrics.impressions));
  }

  // ---------------------------------------------------------------- engine_query [A6]
  /** Engine search queries whose best-matching crawled page (title/H1 coverage) is `norm`. */
  engineQueriesForPage(norm: string): string[] {
    const out: string[] = [];
    for (const g of this.inp.engineQueries.slice(0, this.cfg.maxEngineQueries)) {
      if (this.dropped.has(normalizeDemandQuery(g.normalized))) continue;
      const best = this.bestMatchingPage(g.normalized);
      if (best && best.page.norm === norm && best.score >= this.cfg.matchMinCoverage) out.push(g.example);
    }
    return out.slice(0, 5);
  }

  engineQueries(): Candidate[] {
    const groups = this.inp.engineQueries.filter((g) => !this.dropped.has(normalizeDemandQuery(g.normalized))).slice(0, this.cfg.maxEngineQueries);
    if (groups.length === 0) return [];
    const gscByKey = new Map<string, SliceRow[]>();
    const querySrc = this.cur.filter((r) => r.query);
    for (const r of querySrc) {
      const k = queryKey(r.query!);
      const list = gscByKey.get(k) ?? [];
      list.push(r);
      gscByKey.set(k, list);
    }
    const out: Candidate[] = [];
    for (const g of groups) {
      const k = queryKey(g.normalized);
      if (!k) continue;
      const rows = gscByKey.get(k) ?? [];
      const engineEv: EvidenceSpec = {
        source: "geo_observation",
        refId: g.observationIds[0] ?? null,
        window: null,
        text: `Engine search query "${clip(g.example, 100)}" captured ${g.count} time(s) from ${g.providers.join(", ")} (${g.models.join(", ")}), API-sampled.`,
        data: { normalized: g.normalized, count: g.count, providers: g.providers, models: g.models, observationIds: g.observationIds },
      };
      let match: Candidate["engineMatch"];
      let page: PageInfo | null = null;
      let pageUrl: string | null = null;
      const ev: EvidenceSpec[] = [engineEv];
      let impressions: number | null = null;
      let clicks: number | null = null;
      let position: number | null = null;
      let engineDemand: CandidateDemand | null = null;
      if (rows.length) {
        impressions = rows.reduce((s, r) => s + r.impressions, 0);
        clicks = rows.reduce((s, r) => s + r.clicks, 0);
        position = weightedPosition(rows);
        match = position !== null && position <= this.cfg.engineReinforceMaxPosition ? "reinforce" : "improve";
        const top = [...rows].filter((r) => r.page).sort((a, b) => b.impressions - a.impressions)[0];
        engineDemand = this.demandOf(([...rows].sort((a, b) => b.impressions - a.impressions)[0]!).query);
        if (top?.page) {
          pageUrl = top.page;
          page = this.pagesByNorm.get(normalizeUrl(top.page)) ?? null;
        }
        ev.push(this.gscRowEvidence(rows, "GSC rows matching the engine query"));
      } else {
        const best = this.bestMatchingPage(g.normalized);
        if (best && best.score >= this.cfg.matchMinCoverage) {
          match = "improve";
          page = best.page;
          pageUrl = best.page.url;
          ev.push(
            this.ruleEvidence(
              "engine_query_match",
              `no GSC rows match "${clip(g.example, 80)}"; ${fmtPct(best.score)} of its words appear in the title/H1 of ${best.page.url}.`,
              { query: g.normalized, page: best.page.url, coverage: best.score },
            ),
          );
        } else {
          match = "no_matching_page";
          ev.push(
            this.ruleEvidence(
              "engine_query_match",
              `no GSC rows match "${clip(g.example, 80)}" and no crawled page title/H1 contains at least ${fmtPct(this.cfg.matchMinCoverage)} of its words (${this.inp.pages.length} crawled pages checked).`,
              { query: g.normalized, crawled: this.inp.pages.length },
            ),
          );
        }
      }
      if (page) ev.push(this.crawlEvidence(page));
      const noPage = match === "no_matching_page";
      out.push(
        this.base("engine_query", {
          key: `engine_query:${k}`,
          issueType: `engine_query_${match}`,
          trigger: `Engine search query "${clip(g.example, 80)}" (API-sampled)`,
          issue: noPage
            ? `AI engines searched for "${clip(g.example, 80)}" and no crawled page clearly covers it.`
            : match === "reinforce"
              ? `AI engines searched for "${clip(g.example, 80)}", which this site already ranks for.`
              : `AI engines searched for "${clip(g.example, 80)}"; this site has a related page but weak or no search visibility for it.`,
          query: g.example,
          page,
          scope: noPage ? "site" : "page",
          target: noPage ? { kind: "site" } : { kind: "url", url: pageUrl ?? undefined },
          metrics: { engineCount: g.count, impressions, clicks, position },
          priority: this.priorityFor(impressions, clicks, noPage ? "high" : "medium"),
          defaultAction: noPage ? "new_page_candidate" : match === "reinforce" ? "add_internal_links" : "improve_intro_answer",
          evidence: ev,
          identity: { query: k, match },
          engineMatch: match,
          demand: engineDemand,
          wantsIntent: true,
          wantsPillar: true,
          verified: !!page,
          reviewRequired: noPage,
          limitations: `Engine queries are those the provider exposed in API-sampled answers; they are not consumer-app measurements.${this.inp.sync ? ` GSC data for ${this.win}.` : " No GSC data imported."} No ranking or citation change is promised.`,
        }),
      );
    }
    return out;
  }

  // ---------------------------------------------------------------- technical [A9]
  technical(): Candidate[] {
    if (!this.inp.crawl) return [];
    const crawled = Math.max(1, this.inp.crawl.crawledCount);
    const minRank = SEVERITY_RANK[this.cfg.technicalMinSeverity];
    const findings = this.inp.findings.filter((f) => SEVERITY_RANK[f.severity] >= minRank);
    const groups = new Map<string, { ruleId: string; pageType: PageType | null; template: string | null; templateAffectedUrls: number | null; items: typeof findings; types: Set<PageType> }>();
    for (const f of findings) {
      const pageType = f.url ? (f.pageType ?? this.pagesByNorm.get(normalizeUrl(f.url))?.pageType ?? "other") : null;
      // Registered non-templateable rules (4xx, sitemap health, thin content, ...) group across page types:
      // >= templateMinUrls URLs sharing the rule become one site-scope candidate, never a template claim.
      const rule = getRule(f.ruleId);
      const byRule = !!rule && !rule.templateable && !f.template;
      const gk = f.url === null ? `${f.ruleId}|site` : f.template ? `${f.ruleId}|tpl:${f.template}` : byRule ? `${f.ruleId}|rule` : `${f.ruleId}|type:${pageType}`;
      const g = groups.get(gk) ?? { ruleId: f.ruleId, pageType, template: f.template, templateAffectedUrls: f.templateAffectedUrls, items: [], types: new Set<PageType>() };
      g.items.push(f);
      if (pageType) g.types.add(pageType);
      if (g.types.size > 1) g.pageType = null;
      groups.set(gk, g);
    }
    const out: Candidate[] = [];
    for (const [groupKey, g] of groups) {
      // Stable identity (dedup): a rule-level group on one page type keeps the per-type key used before.
      const gk = groupKey.endsWith("|rule") && g.types.size === 1 ? `${g.ruleId}|type:${[...g.types][0]}` : groupKey;
      const worst = g.items.reduce<Severity>((w, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[w] ? f.severity : w), "advisory");
      const urls = [...new Set(g.items.map((f) => f.url).filter((u): u is string => !!u))];
      const pageImpr = urls.reduce((s, u) => s + (this.pageMetricsCur.get(normalizeUrl(u))?.impressions ?? 0), 0);
      const pageClicks = urls.reduce((s, u) => s + (this.pageMetricsCur.get(normalizeUrl(u))?.clicks ?? 0), 0);
      const hasGsc = this.inp.sync !== null && this.pageMetricsCur.size > 0;
      const action = defaultTechnicalAction(g.ruleId);
      const crawlDay = this.inp.crawl.day;
      const siteLevel = gk.endsWith("|site");
      const grouped = !siteLevel && urls.length >= this.cfg.templateMinUrls;
      if (siteLevel || grouped) {
        // Template scope only for rules the registry marks templateable (the crawler labels those);
        // unknown rule ids fall back to the templated page types.
        const rule = getRule(g.ruleId);
        const templateable = rule ? rule.templateable : g.pageType !== null && TEMPLATE_PAGE_TYPES.has(g.pageType);
        const isTemplate = grouped && templateable && (g.template !== null || (g.pageType !== null && TEMPLATE_PAGE_TYPES.has(g.pageType)));
        const templateName = g.template ?? (g.pageType ? `${g.pageType} template` : "site-wide");
        const examples = g.items.filter((f) => f.url).slice(0, 3);
        const affected = siteLevel ? crawled : urls.length;
        const ev: EvidenceSpec[] = [
          {
            source: "rule",
            refId: g.items[0]!.id,
            window: crawlDay,
            text: siteLevel
              ? `Rule ${g.ruleId} (${worst}) in crawl on ${crawlDay}: ${clip(g.items[0]!.detail, 300)}`
              : `Rule ${g.ruleId} (${worst}) affects ${urls.length} of ${this.inp.crawl.crawledCount} crawled URLs${g.pageType ? ` of type ${g.pageType}` : ""} in crawl on ${crawlDay}.`,
            data: {
              ruleId: g.ruleId,
              severity: worst,
              affected: urls.length,
              crawled: this.inp.crawl.crawledCount,
              template: g.template,
              pageType: g.pageType,
              templateAffectedUrls: g.templateAffectedUrls,
            },
          },
          ...examples.map((f) => ({
            source: "crawl" as const,
            refId: f.id,
            window: crawlDay,
            text: `Rule ${f.ruleId} on ${f.url}: ${clip(f.detail, 300)}`,
            data: { findingId: f.id, url: f.url },
          })),
        ];
        if (ev.length < 2) {
          ev.push({ source: "crawl", refId: this.inp.crawl.id, window: crawlDay, text: `Crawl on ${crawlDay} checked ${this.inp.crawl.crawledCount} pages.`, data: { crawled: this.inp.crawl.crawledCount } });
        }
        if (hasGsc && pageImpr > 0) {
          ev.push({
            source: this.gscSource,
            refId: this.inp.sync!.id,
            window: this.win,
            text: `${this.gscLabel} ${this.win}: the ${urls.length} affected URLs received ${fmtInt(pageImpr)} impressions and ${fmtInt(pageClicks)} clicks combined (page rows; lower bound).`,
            data: { impressions: pageImpr, clicks: pageClicks, urls: urls.length },
          });
        }
        const scope: Scope = isTemplate ? "template" : "site";
        out.push(
          this.base("technical", {
            key: `technical:${gk}`,
            issueType: `technical:${g.ruleId}`,
            jevDependent: false,
            scope,
            target: isTemplate
              ? { kind: "template", template: templateName, affectedUrlCount: urls.length, exampleUrls: examples.map((f) => f.url!) }
              : { kind: "site", affectedUrlCount: affected, exampleUrls: examples.map((f) => f.url!) },
            trigger: siteLevel ? `Site-level issue: ${g.ruleId}` : `Template issue on ${urls.length} URLs`,
            issue: siteLevel ? clip(g.items[0]!.detail, 400) : `Rule ${g.ruleId} fails on ${urls.length} ${g.pageType ?? ""} URLs that share one ${isTemplate ? "template" : "pattern"}.`.replace(/\s+/g, " "),
            page: null,
            pageType: g.pageType,
            severity: worst,
            metrics: { affected, crawled: this.inp.crawl.crawledCount, impressions: hasGsc ? pageImpr : null },
            priority: this.priorityFor(hasGsc ? pageImpr : null, hasGsc ? pageClicks : null, "medium", SEVERITY_WEIGHT[worst], affected / crawled),
            defaultAction: action,
            actionText: sitemapActionText(g.ruleId, isTemplate ? `the ${templateName}` : "the site", siteLevel ? 1 : urls.length, examples[0] ? { url: examples[0].url, detail: examples[0].detail } : (g.items[0] ? { url: g.items[0].url, detail: g.items[0].detail } : null)),
            evidence: ev,
            identity: { rule: g.ruleId, group: gk },
            verified: true,
            limitations: `Based on crawl of ${this.inp.crawl.crawledCount} pages on ${crawlDay}; pages outside the crawl may also be affected. Findings describe observed HTML only, not index status.`,
          }),
        );
        continue;
      }
      for (const f of g.items) {
        const page = f.url ? (this.pagesByNorm.get(normalizeUrl(f.url)) ?? null) : null;
        const m = f.url ? this.pageMetricsCur.get(normalizeUrl(f.url)) : undefined;
        const ev: EvidenceSpec[] = [
          { source: "rule", refId: f.id, window: crawlDay, text: `Rule ${f.ruleId} (${f.severity}) on ${f.url}: ${clip(f.detail, 300)}`, data: { ruleId: f.ruleId, severity: f.severity, url: f.url } },
        ];
        if (page) ev.push(this.crawlEvidence(page));
        if (m) ev.push(this.pageMetricEvidence(f.url!, m, "current"));
        if (ev.length < 2) ev.push({ source: "crawl", refId: this.inp.crawl.id, window: crawlDay, text: `Crawl on ${crawlDay} checked ${this.inp.crawl.crawledCount} pages.`, data: { crawled: this.inp.crawl.crawledCount } });
        out.push(
          this.base("technical", {
            key: `technical:${f.ruleId}|${normalizeUrl(f.url!)}`,
            issueType: `technical:${f.ruleId}`,
            jevDependent: false,
            scope: "page",
            target: { kind: "url", url: f.url! },
            trigger: `Crawl finding ${f.ruleId}`,
            issue: clip(f.detail, 400),
            page,
            pageType: g.pageType,
            severity: f.severity,
            metrics: { affected: 1, crawled: this.inp.crawl.crawledCount, impressions: m?.impressions ?? null },
            priority: this.priorityFor(m ? m.impressions : hasGsc ? 0 : null, m ? m.clicks : hasGsc ? 0 : null, "low", SEVERITY_WEIGHT[f.severity], 1 / crawled),
            defaultAction: action,
            actionText: sitemapActionText(f.ruleId, f.url!, 1, { url: f.url, detail: f.detail }),
            evidence: ev,
            identity: { rule: f.ruleId, url: normalizeUrl(f.url!) },
            verified: true,
            limitations: `Based on crawl on ${crawlDay}; describes observed HTML only, not index status.`,
          }),
        );
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- duplicates [A15]
  duplicates(): Candidate[] {
    const pages = this.inp.pages.filter((p) => p.title);
    if (pages.length < 2) return [];
    const titleTokens = new Map(pages.map((p) => [p.norm, this.titleTokens(p)]));
    const pairs = new Map<string, { a: PageInfo; b: PageInfo; sharedTokens: number; titleMatch: boolean; queries: Map<string, number>; alternating: AlternatingQuery[] }>();
    const pairKey = (x: PageInfo, y: PageInfo) => (x.norm < y.norm ? `${x.norm}||${y.norm}` : `${y.norm}||${x.norm}`);
    for (let i = 0; i < pages.length; i++) {
      for (let j = i + 1; j < pages.length; j++) {
        const a = pages[i]!;
        const b = pages[j]!;
        const ta = titleTokens.get(a.norm)!;
        const tb = titleTokens.get(b.norm)!;
        const shared = sharedCount(ta, tb);
        const shorter = Math.min(ta.size, tb.size);
        if (shorter > 0 && shared >= this.cfg.duplicateMinSharedTokens && shared >= this.cfg.duplicateMinShorterShare * shorter) {
          pairs.set(pairKey(a, b), { a, b, sharedTokens: shared, titleMatch: true, queries: new Map(), alternating: [] });
        }
      }
    }
    const pagesByQuery = new Map<string, Map<string, number>>();
    for (const r of this.qp) {
      if (r.impressions <= 0) continue;
      const k = normalizeUrl(r.page!);
      if (!this.pagesByNorm.has(k)) continue;
      const m = pagesByQuery.get(r.query!) ?? new Map<string, number>();
      m.set(k, (m.get(k) ?? 0) + r.impressions);
      pagesByQuery.set(r.query!, m);
    }
    for (const [q, m] of pagesByQuery) {
      const list = [...m.keys()];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = this.pagesByNorm.get(list[i]!)!;
          const b = this.pagesByNorm.get(list[j]!)!;
          const key = pairKey(a, b);
          const entry = pairs.get(key) ?? { a, b, sharedTokens: sharedCount(this.titleTokens(a), this.titleTokens(b)), titleMatch: false, queries: new Map<string, number>(), alternating: [] };
          entry.queries.set(q, Math.min(m.get(list[i]!)!, m.get(list[j]!)!));
          pairs.set(key, entry);
        }
      }
    }
    // [A25] Queries whose top page alternates between URLs across weeks feed the same pair prefilter.
    const weeks = this.inp.sync?.extras?.queryPageWeeks;
    if (weeks) {
      for (const alt of detectAlternatingUrls(weeks, normalizeUrl)) {
        if (this.dropped.has(normalizeDemandQuery(alt.query))) continue;
        const pgs = alt.pages.map((n) => this.pagesByNorm.get(n)).filter((x): x is PageInfo => !!x);
        for (let i = 0; i < pgs.length; i++) {
          for (let j = i + 1; j < pgs.length; j++) {
            const a = pgs[i]!;
            const b = pgs[j]!;
            const key = pairKey(a, b);
            const entry = pairs.get(key) ?? { a, b, sharedTokens: sharedCount(this.titleTokens(a), this.titleTokens(b)), titleMatch: false, queries: new Map<string, number>(), alternating: [] };
            const impr = alt.weeks.filter((w) => w.page === a.norm || w.page === b.norm).reduce((n, w) => n + w.impressions, 0);
            if (!entry.queries.has(alt.query)) entry.queries.set(alt.query, impr);
            entry.alternating.push(alt);
            pairs.set(key, entry);
          }
        }
      }
    }
    const ranked = [...pairs.entries()]
      .map(([key, p]) => ({ key, ...p, sharedImpr: [...p.queries.values()].reduce((s, v) => s + v, 0) }))
      .sort((x, y) => y.sharedImpr - x.sharedImpr || y.sharedTokens - x.sharedTokens)
      .slice(0, this.cfg.maxDuplicatePairs);
    return ranked.map((p) => {
      const ca = this.pageMetricsCur.get(p.a.norm)?.clicks ?? 0;
      const cb = this.pageMetricsCur.get(p.b.norm)?.clicks ?? 0;
      const [strong, weak] = ca >= cb ? [p.a, p.b] : [p.b, p.a];
      const queries = [...p.queries.entries()].sort((x, y) => y[1] - x[1]).map(([q]) => q);
      const qRows = this.qp.filter((r) => queries.slice(0, 3).includes(r.query!) && [p.a.norm, p.b.norm].includes(normalizeUrl(r.page!)));
      const ev: EvidenceSpec[] = [this.crawlEvidence(strong), this.crawlEvidence(weak)];
      if (qRows.length) ev.push(this.gscRowEvidence(qRows, "queries where both URLs received impressions"));
      for (const alt of p.alternating.slice(0, 2)) {
        const seq = alt.weeks.map((w) => `week of ${w.weekStart ?? `#${w.week + 1}`}: ${w.page}`).join("; ");
        ev.push(
          this.ruleEvidence(
            "alternating_urls",
            `"${clip(alt.query, 80)}": the top page by clicks changed ${alt.changes} times across weeks of ${this.win} (${seq}).`,
            { query: alt.query, changes: alt.changes, weeks: alt.weeks, pages: alt.pages },
          ),
        );
      }
      ev.push(
        this.ruleEvidence(
          "duplicate_prefilter",
          `${strong.url} and ${weak.url} share ${p.sharedTokens} title words${queries.length ? ` and ${queries.length} GSC queries with impressions for both` : ""}.`,
          { a: strong.url, b: weak.url, sharedTitleTokens: p.sharedTokens, sharedQueries: queries.slice(0, 10), titleMatch: p.titleMatch },
        ),
      );
      const impressions = queries.length ? p.sharedImpr : null;
      return this.base("duplicate", {
        key: `duplicate:${p.key}`,
        issueType: "consolidate_duplicate",
        trigger: p.alternating.length
          ? `Two URLs alternate as the top result for GSC query "${clip(p.alternating[0]!.query, 80)}"`
          : queries.length
            ? `Two URLs share GSC query "${clip(queries[0], 80)}"`
            : "Two URLs with overlapping titles",
        issue: `${strong.url} and ${weak.url} may compete for the same search intent.`,
        page: strong,
        pageB: weak,
        sharedQueries: queries.slice(0, 10),
        target: { kind: "url", url: strong.url, exampleUrls: [strong.url, weak.url] },
        metrics: { sharedTitleTokens: p.sharedTokens, sharedQueries: queries.length, impressions, alternatingQueries: p.alternating.length || null },
        priority: this.priorityFor(impressions, null, "high"),
        defaultAction: "consolidate_duplicate",
        evidence: ev,
        identity: { pair: p.key },
        limitations: `Overlap is judged from titles, H1s, opening text${queries.length ? `, and shared GSC queries in ${this.win}` : ""}; confirm before merging or redirecting.`,
      });
    });
  }

  // ---------------------------------------------------------------- [A25] internal link suggestions
  /** Act-tier suggestions of the latest suggester run -> concrete page-scope link candidates. */
  linkSuggestions(): Candidate[] {
    const list = this.inp.linkSuggestions ?? [];
    const out: Candidate[] = [];
    const crawled = Math.max(1, this.inp.crawl?.crawledCount ?? this.inp.pages.length);
    for (const s of list) {
      if (s.status !== "suggested" || s.userStatus !== "open" || s.method !== "jev" || s.decision?.tier !== "act") continue;
      if (!s.sentence || !s.anchor) continue;
      if (looksLikeInstructions(s.sentence.text) || looksLikeInstructions(s.anchor.text)) continue; // [A14]
      const srcNorm = normalizeUrl(s.source.url);
      const tgtNorm = normalizeUrl(s.target.url);
      const source = this.pagesByNorm.get(srcNorm) ?? null;
      const m = this.pageMetricsCur.get(tgtNorm);
      const day = this.inp.crawl?.day ?? null;
      const sentence = clip(s.sentence.text, 240);
      const anchor = clip(s.anchor.text, 100);
      const ev: EvidenceSpec[] = [
        {
          source: "crawl",
          refId: s.id,
          window: day,
          text: `Internal link suggestion (Jev act tier): add a link from ${s.source.url} to ${s.target.url} with the anchor "${anchor}" in the sentence "${sentence}"${s.role ? ` (role: ${s.role.replace(/_/g, " ")})` : ""}.${
            s.cluster?.gap ? ` It closes a cluster gap: ${s.cluster.gap === "hub_to_spoke" ? "the hub page does not link to this spoke yet" : "the spoke does not link back to its hub yet"} (hub ${s.cluster.hubUrl}).` : ""
          }`,
          data: {
            linkSuggestionId: s.id,
            sourceUrl: s.source.url,
            targetUrl: s.target.url,
            anchor: s.anchor.text,
            sentence: s.sentence.text,
            role: s.role,
            tier: s.decision.tier,
            shouldExist: s.decision.shouldExist,
            ...(s.cluster?.gap ? { clusterGap: s.cluster.gap, hub: s.cluster.hubUrl } : {}),
            ...(s.priority ? { priority: s.priority.value, priorityVersion: s.priority.version } : {}),
          },
        },
      ];
      if (m) ev.push(this.pageMetricEvidence(s.target.url, m, "current"));
      ev.push({
        source: "crawl",
        refId: this.inp.crawl?.id ?? null,
        window: day,
        text: `Crawl${day ? ` on ${day}` : ""}: ${s.target.url} has ${s.target.inlinks} internal inlinks among crawled pages${s.target.orphan ? " (orphan)" : ""}, and ${s.source.url} does not link to it yet.`,
        data: { target: s.target.url, inlinks: s.target.inlinks, orphan: s.target.orphan },
      });
      out.push(
        this.base("internal_link", {
          key: `internal_link_suggestion:${srcNorm}|${tgtNorm}`,
          issueType: "internal_link",
          jevDependent: false,
          deterministicOnly: true,
          trigger: clip(`Internal link suggestion: ${s.source.url} to ${s.target.url}`, 200),
          issue: clip(`${s.source.url} does not link to ${s.target.url}; the internal link suggester found a sentence and anchor for the link.`, 400),
          page: source,
          target: { kind: "url", url: s.source.url, exampleUrls: [s.source.url, s.target.url] },
          metrics: { impressions: m?.impressions ?? null, clicks: m?.clicks ?? null, targetInlinks: s.target.inlinks, suggestionScore: s.score },
          priority: this.priorityFor(m ? m.impressions : null, m ? m.clicks : null, "low", null, 1 / crawled),
          defaultAction: "add_internal_links",
          actionText: `Add a link from ${s.source.url} to ${s.target.url} using the anchor "${anchor}" in the sentence: "${sentence}"; [confirm: the sentence and anchor still read naturally on the live page].`,
          evidence: ev,
          identity: { source: srcNorm, target: tgtNorm },
          verified: !!source,
          limitations: `From the internal link suggester's latest run over the crawl${day ? ` of ${day}` : ""}; Okara never edits pages. Inlinks are counted only within crawled pages. No ranking change is promised.`,
          linkSuggestion: {
            id: s.id,
            sourceUrl: s.source.url,
            targetUrl: s.target.url,
            anchor: s.anchor.text,
            sentence: s.sentence.text,
            role: s.role,
            tier: s.decision.tier,
            shouldExist: s.decision.shouldExist,
            provider: s.decision.provider,
            model: s.decision.model,
          },
        }),
      );
    }
    return out;
  }

  // ---------------------------------------------------------------- [A23] freshness
  freshness(): Candidate[] {
    const today = this.inp.today;
    if (!today || !this.inp.crawl) return [];
    const out: Candidate[] = [];
    for (const p of this.inp.pages) {
      if (p.tainted || isLegalUrl(p.url)) continue;
      const refs = detectStaleYears({ title: p.title, h1: p.h1, firstParagraph: p.firstParagraph ?? (p.excerpt ? p.excerpt.slice(0, 400) : null) }, today);
      if (refs.length === 0) continue;
      const years = [...new Set(refs.map((r) => r.year))].sort((a, b) => a - b);
      const m = this.pageMetricsCur.get(p.norm);
      const refText = refs.slice(0, 4).map((r) => `${r.year} in the ${r.field.replace("_", " ")} ("${clip(r.context, 70)}")`).join("; ");
      const ev: EvidenceSpec[] = [
        { ...this.ruleEvidence("stale_years", `dated references on ${p.url} (${STALE_YEAR_VERSION}; years at least 2 years before ${today}): ${refText}.`, { url: p.url, references: refs, today }, p.snapshotId), window: this.inp.crawl.day, tainted: p.tainted },
        this.crawlEvidence(p),
      ];
      if (m) ev.push(this.pageMetricEvidence(p.url, m, "current"));
      out.push(
        this.base("freshness", {
          key: `freshness:${p.norm}`,
          issueType: "freshness_outdated",
          trigger: clip(`Dated reference ${years.join(", ")} on the page`, 200),
          issue: clip(`${p.url} shows dated references (${years.join(", ")}) in its title, H1, or opening text that may present outdated information as current.`, 400),
          page: p,
          target: { kind: "url", url: p.url },
          metrics: { years: years.join(", "), impressions: m?.impressions ?? null, clicks: m?.clicks ?? null },
          priority: this.priorityFor(m ? m.impressions : null, m ? m.clicks : null, "medium"),
          defaultAction: null,
          actionText: `Review the dated references on ${p.url} (${years.join(", ")}) and update any fact, price, or recommendation that is no longer current, or label it clearly as historical; [confirm: the current facts or dates to use].`,
          datedReferences: refs.map((r) => `${r.year} (${r.field}): ${r.context}`),
          evidence: ev,
          identity: { page: p.norm, years },
          limitations: `Years detected in the crawled title, H1, and first paragraph only (${STALE_YEAR_VERSION}); historical mentions (a year after "since", "est.", "founded", or a copyright sign) are excluded. Jev judges whether the page presents them as current. No ranking change is promised.`,
        }),
      );
    }
    return out.sort((a, b) => Number(b.metrics.impressions ?? 0) - Number(a.metrics.impressions ?? 0));
  }

  // ---------------------------------------------------------------- [A23] schema-content mismatch
  schemaMismatch(): Candidate[] {
    if (!this.inp.crawl) return [];
    const crawled = Math.max(1, this.inp.crawl.crawledCount);
    const out: Candidate[] = [];
    for (const p of this.inp.pages) {
      const types = p.jsonLdTypes ?? [];
      if (types.length === 0 || p.tainted) continue;
      const conflicts = schemaConflicts({ pageType: p.pageType, jsonLdTypes: types, headings: p.headings, h1: p.h1 });
      // Offer price values are not stored by the crawler yet, so the price check is skipped (never guessed).
      const price = offerPriceCheck(null, p.excerpt);
      const reasons = conflicts.map((c) => SCHEMA_CONFLICT_TEXT[c]);
      if (price.status === "mismatch") reasons.push(price.reason);
      if (reasons.length === 0) continue;
      const m = this.pageMetricsCur.get(p.norm);
      out.push(
        this.base("schema_mismatch", {
          key: `schema_mismatch:${p.norm}`,
          issueType: "schema_content_mismatch",
          trigger: clip(`Structured data may not match the page: ${reasons[0]}`, 200),
          issue: clip(`The structured data on ${p.url} (${types.join(", ")}) may describe something the page does not visibly show.`, 400),
          page: p,
          target: { kind: "url", url: p.url },
          severity: "moderate",
          metrics: { jsonLdTypes: types.join(", "), conflicts: conflicts.join(","), priceCheck: price.status, impressions: m?.impressions ?? null },
          priority: this.priorityFor(m ? m.impressions : null, m ? m.clicks : null, "medium", SEVERITY_WEIGHT.moderate, 1 / crawled),
          defaultAction: "fix_structured_data",
          actionText: `Make the structured data on ${p.url} describe what the page visibly shows (${reasons.join("; ")}): change or remove the markup that does not match; [confirm: which schema type fits this page].`,
          schemaConflicts: reasons,
          evidence: [
            this.ruleEvidence(
              "schema_match",
              `${p.url} (${p.pageType}) has JSON-LD types ${types.join(", ")}: ${reasons.join("; ")} (${SCHEMA_MATCH_VERSION}). Offer price check: ${price.status} (${price.reason})`,
              { url: p.url, pageType: p.pageType, jsonLdTypes: types, conflicts, priceCheck: price },
              p.snapshotId,
            ),
            this.crawlEvidence(p, `headings: ${clip(p.headings.slice(0, 8).join(" | "), 200) || "(none)"}`),
          ],
          identity: { page: p.norm, conflicts },
          verified: true,
          limitations: `Based on the JSON-LD types and text stored from the crawl on ${this.inp.crawl.day}; Offer price values are not stored, so no price comparison was made. Structured data never guarantees rich results.`,
        }),
      );
    }
    return out;
  }

  // ---------------------------------------------------------------- [A23] answer clarity (AEO)
  answerClarity(): Candidate[] {
    if (!this.inp.sync || !this.inp.crawl) return [];
    const byPage = new Map<string, SliceRow[]>();
    for (const r of this.qp) {
      if (this.brand.isSelfBrand(r.query)) continue;
      const k = normalizeUrl(r.page!);
      const list = byPage.get(k) ?? [];
      list.push(r);
      byPage.set(k, list);
    }
    const out: Candidate[] = [];
    for (const [norm, rows] of byPage) {
      const page = this.pagesByNorm.get(norm);
      if (!page || page.tainted || isLegalUrl(page.url)) continue;
      const opening = page.firstParagraph ?? page.excerpt;
      if (!opening) continue;
      const byQuery = new Map<string, SliceRow[]>();
      for (const r of rows) byQuery.set(r.query!, [...(byQuery.get(r.query!) ?? []), r]);
      const [top, topRows] = [...byQuery.entries()].sort((a, b) => b[1].reduce((n, r) => n + r.impressions, 0) - a[1].reduce((n, r) => n + r.impressions, 0))[0]!;
      const impressions = topRows.reduce((n, r) => n + r.impressions, 0);
      if (impressions < this.cfg.answerMinImpressions) continue;
      if (!QUESTION_QUERY.test(top.trim()) && page.pageType !== "article") continue;
      const clicks = topRows.reduce((n, r) => n + r.clicks, 0);
      out.push(
        this.base("answer_clarity", {
          key: `answer_clarity:${norm}`,
          issueType: "answer_clarity",
          trigger: `From GSC query "${clip(top, 80)}"`,
          issue: clip(`The opening of ${page.url} may not answer "${top}", the query that brings it the most impressions, in its first sentences.`, 400),
          query: top,
          page,
          target: { kind: "url", url: page.url },
          metrics: { impressions, clicks, position: weightedPosition(topRows) },
          priority: this.priorityFor(impressions, clicks, "medium"),
          defaultAction: "improve_intro_answer",
          evidence: [this.gscRowEvidence(topRows, "the page's top query"), this.crawlEvidence(page, `opening "${clip(opening, 200)}"`)],
          identity: { page: norm, query: queryKey(top) },
          limitations: this.gscLimitations("A direct opening answer helps readers and answer engines quote the page; it does not guarantee a snippet, ranking, or AI citation."),
        }),
      );
    }
    return out.sort((a, b) => Number(b.metrics.impressions) - Number(a.metrics.impressions));
  }
}

/**
 * Sitemap health rules (seo/rules/sitemap-health.ts): every one is fixed in the sitemap (which URLs it
 * lists and their lastmod), so all map explicitly to fix_canonical_or_indexing; the finding's own
 * "Fix: ..." text becomes the code-owned action (see sitemapActionText).
 */
export const SITEMAP_RULE_ACTIONS: Readonly<Record<string, ActionChoice>> = {
  "SEO-SITEMAP-URL-ERROR": "fix_canonical_or_indexing",
  "SEO-SITEMAP-URL-REDIRECT": "fix_canonical_or_indexing",
  "SEO-SITEMAP-URL-NOINDEX": "fix_canonical_or_indexing",
  "SEO-SITEMAP-URL-NONCANONICAL": "fix_canonical_or_indexing",
  "SEO-SITEMAP-LASTMOD-INVALID": "fix_canonical_or_indexing",
  "SEO-SITEMAP-OFFHOST": "fix_canonical_or_indexing",
};

/** The fix sentence a finding carries in its detail ("... Fix: <text>"), or null. */
export function findingFixText(detail: string): string | null {
  const i = detail.indexOf(" Fix: ");
  const t = i >= 0 ? detail.slice(i + 6).trim() : "";
  return t ? t.replace(/[.;]\s*$/, "") : null;
}

/** Code-owned action for sitemap-health candidates, quoting the finding's exact fix. */
export function sitemapActionText(ruleId: string, target: string, count: number, example: { url: string | null; detail: string } | null): string | null {
  if (!SITEMAP_RULE_ACTIONS[ruleId]) return null;
  const fix = example ? findingFixText(example.detail) : null;
  const lead =
    count > 1
      ? `Correct the ${count} sitemap entries reported by ${ruleId} for ${target}, so the sitemap lists only final, indexable, canonical URLs on the verified host with valid lastmod dates`
      : `Correct the sitemap entry reported by ${ruleId} for ${target}`;
  const eg = fix ? `${count > 1 && example?.url ? ` (for example ${example.url}: ${fix})` : `: ${fix}`}` : "";
  return `${lead}${eg}; [confirm: where your platform generates the sitemap].`;
}

/** Deterministic default action for a rule id (used when no Jev action_choice is available). */
export function defaultTechnicalAction(ruleId: string): ActionChoice | null {
  const mapped = SITEMAP_RULE_ACTIONS[ruleId];
  if (mapped) return mapped;
  const r = ruleId.toLowerCase();
  if (/canonical|noindex|index|status|robots|redirect|4xx|5xx|broken/.test(r)) return "fix_canonical_or_indexing";
  if (/json|schema|structured|offer|product_data|rich/.test(r)) return "fix_structured_data";
  if (/title|meta|description/.test(r)) return "rewrite_title_meta";
  if (/internal_link|orphan|inlink/.test(r)) return "add_internal_links";
  if (/duplicate|variant/.test(r)) return "consolidate_duplicate";
  if (/thin|intro|copy|content/.test(r)) return "add_section";
  if (/h1|heading/.test(r)) return "improve_intro_answer";
  return null;
}
