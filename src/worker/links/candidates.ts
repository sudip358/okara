/**
 * [A25] Candidate targets per source page (deterministic, code-owned; Jev never does this arithmetic).
 *
 * Eligibility (within the latest crawl of the verified host):
 *   source: 2xx, not skipped, not a redirect, on the verified host, not canonicalised to another URL, with
 *           at least one link-context sentence.
 *   target: 2xx, not skipped, not a redirect, on the verified host, not noindex (meta robots or
 *           X-Robots-Tag), and not canonicalised to another URL.
 * Pairs excluded: the page itself, and targets the source already links to (internal_links_json,
 * normalized; a link to a URL that redirects to the target also counts).
 *
 * Inlinks: distinct analyzable crawled pages linking to the page (self-links excluded; links to a
 * redirecting URL credited to its target). Orphan = 0 inlinks within crawl coverage (home page excluded).
 *
 * Score (CANDIDATES_VERSION):
 *   overlap = target defining terms whose stem appears in any source link-context sentence
 *   base    = sum of overlap term weights (target TF-IDF score / the target's top score, 0..1 each)
 *   link    = x1.5 when the target is an orphan, else x1.25 when it has exactly one inlink, else x1
 *   gsc     = 1 + min(0.5, log10(1 + current-window impressions) / 10) when GSC data exists, else 1
 *   score   = base x link x gsc (rounded to 4 decimals)
 *   relevance = base x link (the workbench priority multiplies it by its own Search Console impact, priority.ts,
 *               instead of the gsc factor)
 * Pairs need base >= MIN_BASE_SCORE. The top MAX_TARGETS_PER_SOURCE targets per source are kept
 * (score desc, then target URL).
 *
 * Full-site scale (workbench 2026-10-03): candidates are found through an inverted index (target term -> targets),
 * so a source only scores targets sharing at least one term; inlinks and "already links" can come from the full link
 * graph (union of the latest snapshots) instead of the pages passed in. `topicalCandidates` finds pairs whose topics
 * overlap (source title/H1/headings and defining terms vs target terms) where no sentence mentions the target: the
 * pool for drafted sentences ("insert PK sentence", draft.ts).
 */
import { normalizeHost } from "../seo/ssrf";
import { normalizeUrlKey } from "../seo/rules/registry";
import { round, type DefiningTerm } from "./terms";

export const CANDIDATES_VERSION = "links-candidates-2026-10-01.1";
/**
 * Raised from 8 to 15 (2026-10-01, "7 workflows" reference). Jev spend is unchanged: pairs are still
 * capped per run at MAX_PAIRS_PER_RUN (run.ts), so a run stays at most 40 calls of 10 pairs x 4 questions,
 * inside the default 60 jev_calls per project per day.
 */
export const MAX_TARGETS_PER_SOURCE = 15;
export const MIN_BASE_SCORE = 0.5;
export const ORPHAN_BOOST = 1.5;
export const LOW_INLINK_BOOST = 1.25;
export const GSC_BOOST_CAP = 0.5;

export interface LinkPage {
  pageId: string;
  url: string;
  pageType: string;
  statusCode: number | null;
  finalUrl: string | null;
  skippedReason: string | null;
  robotsMeta: string | null;
  canonical: string | null;
  title: string | null;
  h1s: string[];
  /** Headings other than H1 (text only). */
  headings: string[];
  sentences: string[];
  internalLinks: string[];
  /** Current-window GSC impressions for this URL; null when there is no GSC data for the project. */
  gscImpressions: number | null;
}

export const urlKey = (u: string) => normalizeUrlKey(u);

export function isOk(p: LinkPage): boolean {
  return p.statusCode !== null && p.statusCode >= 200 && p.statusCode < 300 && !p.skippedReason;
}

export function isRedirected(p: LinkPage): boolean {
  return (p.statusCode !== null && p.statusCode >= 300 && p.statusCode < 400) || (!!p.finalUrl && urlKey(p.finalUrl) !== urlKey(p.url));
}

export function onHost(url: string, host: string): boolean {
  try {
    return normalizeHost(new URL(url).hostname) === normalizeHost(host);
  } catch {
    return false;
  }
}

export function isNoindex(p: LinkPage): boolean {
  return /\bnoindex\b|\bnone\b/i.test(p.robotsMeta ?? "");
}

export function canonicalElsewhere(p: LinkPage): boolean {
  if (!p.canonical) return false;
  try {
    return urlKey(new URL(p.canonical, p.url).toString()) !== urlKey(p.url);
  } catch {
    return false;
  }
}

/** Why a page cannot be a link target, or null when it can. */
export function targetExclusion(p: LinkPage, host: string): string | null {
  if (!onHost(p.url, host)) return "off_host";
  if (isRedirected(p)) return "redirect";
  if (!isOk(p)) return p.skippedReason ? `skipped_${p.skippedReason}` : "non_2xx";
  if (isNoindex(p)) return "noindex";
  if (canonicalElsewhere(p)) return "canonical_elsewhere";
  return null;
}

/** Sources: crawled 2xx pages on the host with sentences; a page canonicalised elsewhere is a duplicate, not a source. */
export function canBeSource(p: LinkPage, host: string): boolean {
  return onHost(p.url, host) && isOk(p) && !isRedirected(p) && !canonicalElsewhere(p) && p.sentences.length > 0;
}

/** Analyzable page (2xx, not skipped, not a redirect): its links count as inlinks. */
export function isAnalyzable(p: LinkPage): boolean {
  return isOk(p) && !isRedirected(p);
}

/** Map of URL key -> key of the URL it redirects to (from redirect snapshots in the crawl). */
export function redirectTargets(pages: readonly LinkPage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of pages) {
    if (p.finalUrl && urlKey(p.finalUrl) !== urlKey(p.url)) out.set(urlKey(p.url), urlKey(p.finalUrl));
  }
  return out;
}

/** Keys of every page `p` links to, including the final target of links that redirect. */
export function linkedKeys(p: LinkPage, redirects: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>();
  for (const l of p.internalLinks) {
    const k = urlKey(l);
    out.add(k);
    const r = redirects.get(k);
    if (r) out.add(r);
  }
  return out;
}

/** Inlink sources per page key (analyzable sources only; self-links excluded). */
export function computeInlinks(pages: readonly LinkPage[]): Map<string, Set<string>> {
  const redirects = redirectTargets(pages);
  const map = new Map<string, Set<string>>();
  for (const s of pages) {
    if (!isAnalyzable(s)) continue;
    const src = urlKey(s.url);
    for (const k of linkedKeys(s, redirects)) {
      if (k === src) continue;
      const set = map.get(k) ?? new Set<string>();
      set.add(src);
      map.set(k, set);
    }
  }
  return map;
}

export function isOrphan(p: LinkPage, inlinks: number): boolean {
  return inlinks === 0 && p.pageType !== "home";
}

export function linkBoost(p: LinkPage, inlinks: number): number {
  if (isOrphan(p, inlinks)) return ORPHAN_BOOST;
  if (inlinks === 1 && p.pageType !== "home") return LOW_INLINK_BOOST;
  return 1;
}

export function gscBoost(impressions: number | null): number {
  if (impressions === null || !Number.isFinite(impressions) || impressions <= 0) return 1;
  return 1 + Math.min(GSC_BOOST_CAP, Math.log10(1 + impressions) / 10);
}

export interface Candidate {
  sourcePageId: string;
  targetPageId: string;
  score: number;
  /** base x link boost (no Search Console factor): the relevance input of the workbench priority. */
  relevance: number;
  base: number;
  overlap: DefiningTerm[];
  inlinks: number;
  orphan: boolean;
  linkBoost: number;
  gscBoost: number;
  gscImpressions: number | null;
}

export interface CandidateInput {
  pages: readonly LinkPage[];
  /** Defining terms by page id. */
  terms: ReadonlyMap<string, DefiningTerm[]>;
  /** Term stems present in each source page's sentences, by page id (a map, or computed on demand). */
  sentenceStems: ReadonlyMap<string, ReadonlySet<string>> | ((pageId: string) => ReadonlySet<string> | undefined);
  host: string;
  maxTargets?: number;
  /** Inlinks per URL key from the full link graph; default: computed from `pages`. */
  inlinks?: (key: string) => number;
  /** Keys a source already links to (any link, through redirects/canonicals); default: from `pages`. */
  linked?: (source: LinkPage) => ReadonlySet<string>;
}

interface Posting {
  target: LinkPage;
  term: DefiningTerm;
  /** Index of the term in the target's defining-term list (keeps the original overlap order). */
  index: number;
}

function invertedIndex(targets: readonly LinkPage[], terms: ReadonlyMap<string, DefiningTerm[]>): Map<string, Posting[]> {
  const out = new Map<string, Posting[]>();
  for (const t of targets) {
    (terms.get(t.pageId) ?? []).forEach((term, index) => {
      const list = out.get(term.term) ?? [];
      list.push({ target: t, term, index });
      out.set(term.term, list);
    });
  }
  return out;
}

function makeCandidate(src: LinkPage, t: LinkPage, overlap: DefiningTerm[], n: number): Candidate | null {
  const base = overlap.reduce((a, term) => a + term.weight, 0);
  if (base < MIN_BASE_SCORE) return null;
  const lb = linkBoost(t, n);
  const gb = gscBoost(t.gscImpressions);
  return {
    sourcePageId: src.pageId,
    targetPageId: t.pageId,
    score: round(base * lb * gb),
    relevance: round(base * lb),
    base: round(base),
    overlap,
    inlinks: n,
    orphan: isOrphan(t, n),
    linkBoost: lb,
    gscBoost: round(gb),
    gscImpressions: t.gscImpressions,
  };
}

/** Candidate targets per source page id, best first. */
export function candidateTargets(input: CandidateInput): Map<string, Candidate[]> {
  const { pages, terms, host } = input;
  const maxTargets = input.maxTargets ?? MAX_TARGETS_PER_SOURCE;
  let inlinksOf = input.inlinks;
  let linkedOf = input.linked;
  if (!inlinksOf || !linkedOf) {
    const inlinks = computeInlinks(pages);
    const redirects = redirectTargets(pages);
    inlinksOf ??= (key) => inlinks.get(key)?.size ?? 0;
    linkedOf ??= (src) => linkedKeys(src, redirects);
  }
  const stemsOf = typeof input.sentenceStems === "function" ? input.sentenceStems : (id: string) => (input.sentenceStems as ReadonlyMap<string, ReadonlySet<string>>).get(id);
  const targets = pages.filter((p) => targetExclusion(p, host) === null && (terms.get(p.pageId)?.length ?? 0) > 0);
  const index = invertedIndex(targets, terms);
  const out = new Map<string, Candidate[]>();

  for (const src of pages) {
    if (!canBeSource(src, host)) continue;
    const stems = stemsOf(src.pageId);
    if (!stems || stems.size === 0) continue;
    const srcKey = urlKey(src.url);
    const hits = new Map<string, Posting[]>();
    for (const stem of stems) {
      for (const p of index.get(stem) ?? []) {
        if (p.target.pageId === src.pageId) continue;
        const list = hits.get(p.target.pageId) ?? [];
        list.push(p);
        hits.set(p.target.pageId, list);
      }
    }
    if (hits.size === 0) continue;
    const linked = linkedOf(src);
    const list: Candidate[] = [];
    for (const postings of hits.values()) {
      const t = postings[0]!.target;
      const tKey = urlKey(t.url);
      if (tKey === srcKey || linked.has(tKey)) continue;
      const overlap = postings.sort((a, b) => a.index - b.index).map((p) => p.term);
      const c = makeCandidate(src, t, overlap, inlinksOf(tKey));
      if (c) list.push(c);
    }
    list.sort((a, b) => b.score - a.score || cmp(pagesUrl(pages, a.targetPageId, hits), pagesUrl(pages, b.targetPageId, hits)));
    if (list.length) out.set(src.pageId, list.slice(0, maxTargets));
  }
  return out;
}

function pagesUrl(_pages: readonly LinkPage[], id: string, hits: Map<string, Posting[]>): string {
  return hits.get(id)?.[0]?.target.url ?? "";
}

export interface TopicalInput {
  pages: readonly LinkPage[];
  terms: ReadonlyMap<string, DefiningTerm[]>;
  /** Page-level topic stems per source (title, H1, headings, defining terms). */
  topicStems: (pageId: string) => ReadonlySet<string>;
  host: string;
  /** Pairs to skip (`<source page id>><target page id>`): sentence candidates, existing links. */
  exclude: ReadonlySet<string>;
  inlinks: (key: string) => number;
  linked: (source: LinkPage) => ReadonlySet<string>;
  maxPerSource?: number;
}

/**
 * Topic-overlap pairs for drafted sentences: the source's page-level topic stems contain target defining terms
 * (same base formula and MIN_BASE_SCORE), the pair does not link yet, and it is not a sentence candidate. Sources need
 * not have link-context sentences. At most `maxPerSource` per source (default 3).
 */
export function topicalCandidates(input: TopicalInput): Candidate[] {
  const maxPer = input.maxPerSource ?? 3;
  const targets = input.pages.filter((p) => targetExclusion(p, input.host) === null && (input.terms.get(p.pageId)?.length ?? 0) > 0);
  const index = invertedIndex(targets, input.terms);
  const out: Candidate[] = [];
  for (const src of input.pages) {
    if (!(onHost(src.url, input.host) && isOk(src) && !isRedirected(src) && !canonicalElsewhere(src))) continue;
    const stems = input.topicStems(src.pageId);
    if (stems.size === 0) continue;
    const srcKey = urlKey(src.url);
    const hits = new Map<string, Posting[]>();
    for (const stem of stems) {
      for (const p of index.get(stem) ?? []) {
        if (p.target.pageId === src.pageId || input.exclude.has(`${src.pageId}>${p.target.pageId}`)) continue;
        const list = hits.get(p.target.pageId) ?? [];
        list.push(p);
        hits.set(p.target.pageId, list);
      }
    }
    if (!hits.size) continue;
    const linked = input.linked(src);
    const list: Candidate[] = [];
    for (const postings of hits.values()) {
      const t = postings[0]!.target;
      const tKey = urlKey(t.url);
      if (tKey === srcKey || linked.has(tKey)) continue;
      const c = makeCandidate(src, t, postings.sort((a, b) => a.index - b.index).map((p) => p.term), input.inlinks(tKey));
      if (c) list.push(c);
    }
    list.sort((a, b) => b.relevance - a.relevance || cmp(pagesUrl(input.pages, a.targetPageId, hits), pagesUrl(input.pages, b.targetPageId, hits)));
    out.push(...list.slice(0, maxPer));
  }
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
