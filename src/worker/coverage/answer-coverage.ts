/**
 * [A22] GEO · Answer coverage: each APPROVED prompt of the active prompt set, the best-matching page of
 * your site, who the API-sampled answers cited, and a gap label.
 *
 * Matched page (method labelled per row):
 *   (a) engine_search_query - engine search queries the provider exposed for this prompt's observations
 *       ([A6]; never inferred). Each query maps to a page by, in order:
 *         1. your Search Console current window: the page with the most impressions for the same
 *            normalized query (strength 1.0);
 *         2. crawled pages: title/H1 token overlap with the query (strength = Jaccard, same thresholds as b).
 *       The page matched by the most queries wins (then strength, impressions, URL); score = its strength.
 *   (b) title_heading_overlap - otherwise, the prompt text vs each analysable crawled page's title + H1
 *       tokens: non-stopword tokens (seo/recommend/text.tokens, light plural folding), brand name/alias
 *       tokens removed from both sides; Jaccard = |shared| / |union|. A page matches when
 *       Jaccard >= MATCH_THRESHOLDS.minJaccard (0.2) AND shared tokens >= MATCH_THRESHOLDS.minSharedTokens (2).
 *       Heuristic; score = Jaccard.
 * AI source (latest cohort per provider, API measurements only):
 *   your_site  a grounded successful answer cites a URL whose parsed host is your site (see geo-data.ts)
 *   other_site grounded successful answers cite sources, none of them yours
 *   none       grounded successful answers cite no sources
 *   not_run    no successful answer, or only ungrounded answers (citations were not measured)
 * Gap:
 *   covered      your_site
 *   improve      a matched page exists and the answers cited other sites or no one
 *   create_page  no matched page and other sites were cited
 *   check        not_run, citation hosts that could not be resolved, or no page and no citations
 * Gaps are review prompts; they never predict that a change will cause a citation.
 */
import type { AnswerCoverageRow, CoverageResponse, GeoPrompt } from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { getActivePromptSet } from "../geo/prompts";
import { tokens } from "../seo/recommend/text";
import { DEMO_LABEL, isAnalyzable, loadGscPageData, loadLatestCrawl, pageKey, type CrawlAbsence, type CrawlData, type GscPageData } from "./common";
import { dominantSourceType, loadGeoSample, observationsForPrompt, type CovCitation, type CovObservation, type GeoSample } from "./geo-data";

export const MATCH_THRESHOLDS = { minJaccard: 0.2, minSharedTokens: 2 } as const;

export const ANSWER_COVERAGE_LABELS = {
  apiSampled: "API-sampled answers; not consumer apps.",
  cohort: "Uses each provider's latest configuration (prompt-set version, model, grounding); manual imports are excluded.",
  match: `Best page: engine search queries the provider exposed, matched to your Search Console queries or to crawled titles/H1s; otherwise prompt-to-title/H1 token overlap (Jaccard >= ${MATCH_THRESHOLDS.minJaccard} with >= ${MATCH_THRESHOLDS.minSharedTokens} shared non-stopword terms; brand terms ignored). A heuristic, labelled on each row.`,
  self: "Your site = a citation whose parsed hostname is your site or verified domain (including subdomains); mentions in answer text do not count.",
  gap: "Gap: covered = your site cited; improve = a matching page exists but was not cited; create page = other sites cited and no matching page; check = not run, ungrounded, or ambiguous. Gaps are review prompts, not predictions of citation.",
} as const;

// ------------------------------------------------------------------ token matching
export interface CandidatePage {
  pageId: string | null;
  url: string;
  key: string;
  tokens: Set<string>;
}

export function brandTokenSet(project: Pick<ProjectRow, "brand_name" | "brand_aliases_json">): Set<string> {
  const aliases = parseJson<unknown[]>(project.brand_aliases_json, []).filter((a): a is string => typeof a === "string");
  return new Set([project.brand_name, ...aliases].flatMap((t) => tokens(t)));
}

export function contentTokens(text: string | null | undefined, brand: Set<string>): Set<string> {
  return new Set(tokens(text).filter((t) => !brand.has(t)));
}

export function overlap(a: Set<string>, b: Set<string>): { jaccard: number; shared: string[] } {
  const shared = [...a].filter((t) => b.has(t));
  const union = new Set([...a, ...b]).size;
  return { jaccard: union === 0 ? 0 : shared.length / union, shared };
}

export function bestOverlap(text: Set<string>, pages: CandidatePage[]): { page: CandidatePage; jaccard: number; shared: string[] } | null {
  let best: { page: CandidatePage; jaccard: number; shared: string[] } | null = null;
  for (const page of pages) {
    const o = overlap(text, page.tokens);
    if (o.shared.length < MATCH_THRESHOLDS.minSharedTokens || o.jaccard < MATCH_THRESHOLDS.minJaccard) continue;
    if (
      !best ||
      o.jaccard > best.jaccard ||
      (o.jaccard === best.jaccard && (o.shared.length > best.shared.length || (o.shared.length === best.shared.length && page.url < best.page.url)))
    ) {
      best = { page, jaccard: o.jaccard, shared: o.shared };
    }
  }
  return best;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const q = (s: string) => `"${s.length > 80 ? `${s.slice(0, 79)}…` : s}"`;

export interface PromptMatch {
  page: CandidatePage;
  method: "engine_search_query" | "title_heading_overlap";
  score: number;
  basis: string;
}

/** Match one prompt to a page: engine search queries first, then title/H1 overlap. */
export function matchPrompt(promptText: string, engineQueries: string[], gsc: GscPageData | null, pages: CandidatePage[], brand: Set<string>): PromptMatch | null {
  const byKey = new Map(pages.map((p) => [p.key, p]));
  type Hit = { page: CandidatePage; queries: string[]; strength: number; impressions: number; first: string; via: "gsc" | "crawl"; jaccard: number; shared: string[] };
  const hits = new Map<string, Hit>();
  for (const query of engineQueries) {
    let page: CandidatePage | null = null;
    let strength = 0;
    let impressions = 0;
    let via: Hit["via"] = "gsc";
    let jaccard = 0;
    let shared: string[] = [];
    const gscPages = gsc?.queryPages.get(query);
    if (gscPages && gscPages.size > 0) {
      let top: [string, { url: string; impressions: number; clicks: number }] | null = null;
      for (const e of gscPages) {
        if (!top || e[1].impressions > top[1].impressions || (e[1].impressions === top[1].impressions && e[1].clicks > top[1].clicks)) top = e;
      }
      if (top) {
        page = byKey.get(top[0]) ?? { pageId: null, url: top[1].url, key: top[0], tokens: new Set() };
        strength = 1;
        impressions = top[1].impressions;
      }
    }
    if (!page) {
      const o = bestOverlap(contentTokens(query, brand), pages);
      if (o) {
        page = o.page;
        strength = o.jaccard;
        via = "crawl";
        jaccard = o.jaccard;
        shared = o.shared;
      }
    }
    if (!page) continue;
    const h = hits.get(page.key);
    if (h) {
      h.queries.push(query);
      h.impressions = Math.max(h.impressions, impressions);
      if (strength > h.strength) Object.assign(h, { strength, via, first: query, jaccard, shared });
    } else {
      hits.set(page.key, { page, queries: [query], strength, impressions, first: query, via, jaccard, shared });
    }
  }
  const ranked = [...hits.values()].sort(
    (a, b) => b.queries.length - a.queries.length || b.strength - a.strength || b.impressions - a.impressions || a.page.url.localeCompare(b.page.url),
  );
  const top = ranked[0];
  if (top) {
    const lead = top.queries.length > 1 ? `${top.queries.length} of ${engineQueries.length} captured engine search queries point to this page; e.g. ` : "Engine search query ";
    const why =
      top.via === "gsc"
        ? `${lead}${q(top.first)} has Search Console impressions on it (${top.impressions} in the current window).`
        : `${lead}${q(top.first)} overlaps its title/H1 (Jaccard ${round2(top.jaccard)}; shared: ${top.shared.join(", ")}).`;
    return { page: top.page, method: "engine_search_query", score: round2(top.strength), basis: why };
  }
  const o = bestOverlap(contentTokens(promptText, brand), pages);
  if (!o) return null;
  const pre = engineQueries.length > 0 ? `None of ${engineQueries.length} captured engine search queries matched a page; the` : "No engine search queries were captured; the";
  return {
    page: o.page,
    method: "title_heading_overlap",
    score: round2(o.jaccard),
    basis: `${pre} prompt overlaps this page's title/H1 (Jaccard ${round2(o.jaccard)}; shared: ${o.shared.join(", ")}).`,
  };
}

// ------------------------------------------------------------------ who was cited
export interface CitedStatus {
  aiSource: AnswerCoverageRow["aiSource"];
  providersRun: number;
  okCount: number;
  groundedCount: number;
  selfAnswers: number;
  otherCitations: CovCitation[];
  /** Other sources were cited but none of their hosts could be resolved. */
  unresolvedOnly: boolean;
  topOtherSource: AnswerCoverageRow["topOtherSource"];
}

export function citedStatus(obs: CovObservation[], citations: Map<string, CovCitation[]>): CitedStatus {
  const ok = obs.filter((o) => o.status === "ok");
  const grounded = ok.filter((o) => o.grounded);
  const providersRun = new Set(ok.map((o) => o.provider)).size;
  let selfAnswers = 0;
  const other: CovCitation[] = [];
  for (const o of grounded) {
    const cits = citations.get(o.id) ?? [];
    if (cits.some((c) => c.self)) selfAnswers++;
    other.push(...cits.filter((c) => !c.self));
  }
  let aiSource: AnswerCoverageRow["aiSource"];
  if (grounded.length === 0) aiSource = "not_run";
  else if (selfAnswers > 0) aiSource = "your_site";
  else if (other.length > 0) aiSource = "other_site";
  else aiSource = "none";

  const byHost = new Map<string, CovCitation[]>();
  for (const c of other) {
    if (!c.host) continue;
    const list = byHost.get(c.host) ?? [];
    list.push(c);
    byHost.set(c.host, list);
  }
  let top: [string, CovCitation[]] | null = null;
  const minPos = (cs: CovCitation[]) => Math.min(...cs.map((c) => c.position ?? Number.MAX_SAFE_INTEGER));
  for (const e of byHost) {
    if (!top || e[1].length > top[1].length || (e[1].length === top[1].length && (minPos(e[1]) < minPos(top[1]) || (minPos(e[1]) === minPos(top[1]) && e[0] < top[0])))) top = e;
  }
  const topOtherSource = top
    ? { host: top[0], sourceType: dominantSourceType(top[1]), url: top[1].find((c) => c.via === "url")?.url ?? null }
    : null;
  return {
    aiSource,
    providersRun,
    okCount: ok.length,
    groundedCount: grounded.length,
    selfAnswers,
    otherCitations: other,
    unresolvedOnly: other.length > 0 && byHost.size === 0,
    topOtherSource,
  };
}

export function gapFor(aiSource: AnswerCoverageRow["aiSource"], matched: boolean, unresolvedOnly: boolean): AnswerCoverageRow["gap"] {
  if (aiSource === "your_site") return "covered";
  if (aiSource === "not_run") return "check";
  if (aiSource === "other_site" && unresolvedOnly) return "check";
  if (matched) return "improve";
  if (aiSource === "other_site") return "create_page";
  return "check";
}

function sourceBasis(s: CitedStatus): string {
  switch (s.aiSource) {
    case "not_run":
      return s.okCount > 0
        ? `${s.okCount} successful answer(s) were not grounded, so citations were not measured.`
        : "No successful API-sampled answer for this prompt in the latest configuration.";
    case "your_site":
      return `Your site was cited in ${s.selfAnswers} of ${s.groundedCount} grounded answer(s) from ${s.providersRun} provider(s).`;
    case "other_site":
      return s.unresolvedOnly
        ? `${s.groundedCount} grounded answer(s) cited sources whose host could not be resolved (provider redirect links); check manually.`
        : `${s.groundedCount} grounded answer(s) cited ${s.otherCitations.length} other source(s), none on your site.`;
    case "none":
      return `${s.groundedCount} grounded answer(s) cited no sources.`;
  }
}

// ------------------------------------------------------------------ build
export interface AnswerCoverageResult {
  response: CoverageResponse<AnswerCoverageRow>;
  sample: GeoSample;
  crawl: CrawlData | CrawlAbsence;
  /** Prompt -> matched crawled page (pageId set only for crawled pages), with the measured AI source. */
  matches: Array<{ promptId: string; text: string; pageId: string | null; url: string | null; aiSource: AnswerCoverageRow["aiSource"] }>;
}

export async function computeAnswerCoverage(db: Db, project: ProjectRow, now: Date): Promise<AnswerCoverageResult> {
  const ws = project.workspace_id;
  const pid = project.id;
  const generatedAt = now.toISOString();
  const [set, sample, crawl, gsc] = await Promise.all([getActivePromptSet(db, ws, pid), loadGeoSample(db, project), loadLatestCrawl(db, project), loadGscPageData(db, ws, pid)]);
  const labels: string[] = [];
  if (project.is_demo) labels.push(DEMO_LABEL);
  labels.push(ANSWER_COVERAGE_LABELS.apiSampled, ANSWER_COVERAGE_LABELS.cohort, ANSWER_COVERAGE_LABELS.match, ANSWER_COVERAGE_LABELS.self, ANSWER_COVERAGE_LABELS.gap);

  const approved: GeoPrompt[] = set?.prompts.filter((p) => p.approved) ?? [];
  if (approved.length === 0) {
    return {
      response: {
        state: project.is_demo ? "demo" : "setup_required",
        generatedAt,
        rows: [],
        completeness: { note: set ? "No approved prompts in the active prompt set." : "No prompt set yet. Create and approve prompts first.", covered: 0, total: 0 },
        labels,
      },
      sample,
      crawl,
      matches: [],
    };
  }

  const brand = brandTokenSet(project);
  const pages: CandidatePage[] = [];
  if (typeof crawl !== "string") {
    for (const s of crawl.snaps) {
      if (!isAnalyzable(s)) continue;
      const key = pageKey(s.url);
      if (!key) continue;
      pages.push({ pageId: s.pageId, url: s.url, key, tokens: contentTokens([s.title ?? "", ...s.h1s].join(" "), brand) });
    }
  } else {
    labels.push("No completed crawl of a verified site: pages can only be matched through Search Console data for captured engine search queries.");
  }
  if (!gsc) labels.push("No Search Console data: engine search queries are matched to crawled titles/H1s only.");

  const rows: AnswerCoverageRow[] = [];
  const matches: AnswerCoverageResult["matches"] = [];
  for (const p of approved) {
    const obs = observationsForPrompt(sample, p);
    const engineQueries = [...new Set(obs.filter((o) => o.status === "ok").flatMap((o) => sample.queries.get(o.id) ?? []))];
    const m = matchPrompt(p.text, engineQueries, gsc, pages, brand);
    const cited = citedStatus(obs, sample.citations);
    const gap = gapFor(cited.aiSource, !!m, cited.unresolvedOnly);
    const matchBasis = m
      ? m.basis
      : `No page matched${engineQueries.length ? ` (${engineQueries.length} engine search queries captured)` : ""}; ${pages.length ? "title/H1 overlap was below the threshold" : "no crawled pages are available to compare"}.`;
    rows.push({
      promptId: p.id,
      text: p.text,
      promptType: p.promptType,
      matchedPage: m ? { url: m.page.url, method: m.method, score: m.score } : null,
      aiSource: cited.aiSource,
      topOtherSource: cited.topOtherSource,
      gap,
      providersRun: cited.providersRun,
      basis: `${matchBasis} ${sourceBasis(cited)}`,
    });
    matches.push({ promptId: p.id, text: p.text, pageId: m?.page.pageId ?? null, url: m?.page.url ?? null, aiSource: cited.aiSource });
  }

  const measured = rows.filter((r) => r.aiSource !== "not_run").length;
  const providers = new Set(sample.observations.map((o) => o.provider)).size;
  if (sample.manualObservationCount > 0) labels.push(`${sample.manualObservationCount} manual import(s) are not included; they are reported by you, not API-sampled.`);
  const noObs = sample.observations.length === 0;
  if (noObs) labels.push("No API-sampled answers yet: configure a GEO provider and wait for the next batch (or run it manually).");
  return {
    response: {
      state: project.is_demo ? "demo" : noObs ? "setup_required" : "ready",
      generatedAt,
      rows,
      completeness: {
        note: `${measured} of ${approved.length} approved prompt(s) have a grounded, successful API-sampled answer in the latest configuration (${providers} provider(s)).`,
        covered: measured,
        total: approved.length,
      },
      labels,
    },
    sample,
    crawl,
    matches,
  };
}

export async function buildAnswerCoverage(db: Db, project: ProjectRow, now: Date): Promise<CoverageResponse<AnswerCoverageRow>> {
  return (await computeAnswerCoverage(db, project, now)).response;
}
