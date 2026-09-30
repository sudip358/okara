/**
 * [A22] GEO · Citation evidence: per URL of your site cited in API-sampled answers (latest cohort per
 * provider, successful grounded observations), plus crawled pages matched to a prompt where your site
 * was not cited.
 *
 *   url             cited URL normalized (lowercase host, no fragment, no tracking parameters, no trailing
 *                   slash); mapped to the crawled page (pages.id) when the pageKey matches, and then shown
 *                   as the crawled URL.
 *   citedCount      distinct answers citing the URL (one answer citing it twice counts once)
 *   citedInPrompts  distinct prompt texts of those answers; providers: distinct providers
 *   lastCitedAt     newest observation time
 *   citedAlongside  up to 5 non-self hosts cited in the same answers, by number of shared answers
 *   nextStep        compare when other sources were cited alongside, else none
 *   add_proof rows  crawled pages matched to an approved prompt (answer coverage) whose grounded answers
 *                   cited other sites or no one, and that were never cited in the sample: citedCount 0.
 * Self citations delivered through provider redirect links (host known from the title only) cannot be
 * tied to a page; they are counted in a label. Next steps are review prompts: nothing here claims that a
 * change will cause a citation.
 */
import type { CitationEvidenceRow, CoverageResponse, SourceType } from "@shared/types";
import type { Db } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { DEMO_LABEL, displayUrl, isAnalyzable, pageKey } from "./common";
import { computeAnswerCoverage } from "./answer-coverage";
import { dominantSourceType, type CovCitation } from "./geo-data";

export const ALONGSIDE_MAX = 5;

export const CITATION_EVIDENCE_LABELS = {
  apiSampled: "API-sampled answers; not consumer apps.",
  counts: "Cited count = distinct API-sampled answers (latest configuration per provider) citing the URL. URLs are normalized (fragment, tracking parameters, and trailing slash removed).",
  noCausal: "Next steps are prompts for review: compare = other sources were cited alongside your page; add proof = your page matched a prompt where the site was not cited. No change is shown or predicted to cause a citation.",
  noCrawl: "Other sources are listed by host only; Okara does not crawl them automatically.",
} as const;

interface Agg {
  key: string;
  url: string;
  pageId: string | null;
  observations: Set<string>;
  prompts: Set<string>;
  providers: Set<string>;
  lastCitedAt: string | null;
  alongside: Map<string, { obs: Set<string>; cits: CovCitation[] }>;
}

export async function buildCitationEvidence(db: Db, project: ProjectRow, now: Date): Promise<CoverageResponse<CitationEvidenceRow>> {
  const generatedAt = now.toISOString();
  const { response: coverage, sample, matches, crawl } = await computeAnswerCoverage(db, project, now);
  const pagesByKey = new Map<string, { id: string; url: string }>();
  if (typeof crawl !== "string") {
    for (const s of crawl.snaps) {
      const k = pageKey(s.url);
      if (k && !pagesByKey.has(k)) pagesByKey.set(k, { id: s.pageId, url: s.url });
    }
  }

  const labels: string[] = [];
  if (project.is_demo) labels.push(DEMO_LABEL);
  labels.push(CITATION_EVIDENCE_LABELS.apiSampled, CITATION_EVIDENCE_LABELS.counts, CITATION_EVIDENCE_LABELS.noCausal, CITATION_EVIDENCE_LABELS.noCrawl);

  const grounded = sample.observations.filter((o) => o.status === "ok" && o.grounded);
  const aggs = new Map<string, Agg>();
  let redirectSelf = 0;
  const citingSelf = new Set<string>();
  for (const o of grounded) {
    const cits = sample.citations.get(o.id) ?? [];
    const others = cits.filter((c) => !c.self && c.host);
    const selfKeysHere = new Set<string>();
    for (const c of cits) {
      if (!c.self) continue;
      citingSelf.add(o.id);
      if (c.via !== "url") {
        redirectSelf++;
        continue;
      }
      const key = pageKey(c.url);
      if (!key || selfKeysHere.has(key)) continue;
      selfKeysHere.add(key);
      const page = pagesByKey.get(key) ?? null;
      let a = aggs.get(key);
      if (!a) {
        a = {
          key,
          url: page?.url ?? displayUrl(c.url),
          pageId: page?.id ?? null,
          observations: new Set(),
          prompts: new Set(),
          providers: new Set(),
          lastCitedAt: null,
          alongside: new Map(),
        };
        aggs.set(key, a);
      }
      a.observations.add(o.id);
      a.prompts.add(o.promptText);
      a.providers.add(o.provider);
      if (!a.lastCitedAt || o.createdAt > a.lastCitedAt) a.lastCitedAt = o.createdAt;
      for (const oc of others) {
        const host = oc.host!;
        const e = a.alongside.get(host) ?? { obs: new Set<string>(), cits: [] };
        e.obs.add(o.id);
        e.cits.push(oc);
        a.alongside.set(host, e);
      }
    }
  }

  const rows: CitationEvidenceRow[] = [...aggs.values()]
    .map((a): CitationEvidenceRow => {
      const alongside: Array<{ host: string; sourceType: SourceType }> = [...a.alongside.entries()]
        .sort((x, y) => y[1].obs.size - x[1].obs.size || x[0].localeCompare(y[0]))
        .slice(0, ALONGSIDE_MAX)
        .map(([host, e]) => ({ host, sourceType: dominantSourceType(e.cits) }));
      const n = a.observations.size;
      const reason =
        alongside.length > 0
          ? `Cited in ${n} API-sampled answer(s) alongside ${a.alongside.size} other source host(s), e.g. ${alongside[0]!.host}. Compare what those sources cover; fetching any other URL needs your explicit approval.`
          : `Cited in ${n} API-sampled answer(s) with no other sources alongside.`;
      return {
        url: a.url,
        pageId: a.pageId,
        citedCount: n,
        citedInPrompts: [...a.prompts].sort(),
        providers: [...a.providers].sort(),
        lastCitedAt: a.lastCitedAt,
        citedAlongside: alongside,
        nextStep: alongside.length > 0 ? "compare" : "none",
        reason,
      };
    })
    .sort((x, y) => y.citedCount - x.citedCount || x.url.localeCompare(y.url));

  // Crawled pages matched to a prompt where the site was not cited, never cited in the sample.
  const citedPageIds = new Set(rows.map((r) => r.pageId).filter((id): id is string => !!id));
  const citedKeys = new Set(aggs.keys());
  const analysableIds = new Set(typeof crawl !== "string" ? crawl.snaps.filter(isAnalyzable).map((s) => s.pageId) : []);
  const addProof = new Map<string, { url: string; prompts: string[] }>();
  for (const m of matches) {
    if (!m.pageId || !m.url || !analysableIds.has(m.pageId)) continue;
    if (m.aiSource !== "other_site" && m.aiSource !== "none") continue;
    const key = pageKey(m.url);
    if (citedPageIds.has(m.pageId) || (key && citedKeys.has(key))) continue;
    const e = addProof.get(m.pageId) ?? { url: m.url, prompts: [] };
    e.prompts.push(m.text);
    addProof.set(m.pageId, e);
  }
  const proofRows: CitationEvidenceRow[] = [...addProof.entries()]
    .map(([pageId, e]): CitationEvidenceRow => ({
      url: e.url,
      pageId,
      citedCount: 0,
      citedInPrompts: [],
      providers: [],
      lastCitedAt: null,
      citedAlongside: [],
      nextStep: "add_proof",
      reason: `Matched to a prompt where the site was not cited: ${e.prompts
        .slice(0, 2)
        .map((t) => `"${t.length > 90 ? `${t.slice(0, 89)}…` : t}"`)
        .join("; ")}${e.prompts.length > 2 ? ` (+${e.prompts.length - 2} more)` : ""}. Review whether the page states the facts and sources those answers relied on.`,
    }))
    .sort((x, y) => x.url.localeCompare(y.url));

  if (redirectSelf > 0) {
    labels.push(`${redirectSelf} citation(s) of your domain came through provider redirect links without a page URL; they count in answer coverage but cannot be tied to a page here.`);
  }
  if (typeof crawl === "string") labels.push("No completed crawl of a verified site: cited URLs are not mapped to crawled pages and no add-proof rows are produced.");
  if (sample.manualObservationCount > 0) labels.push(`${sample.manualObservationCount} manual import(s) are not included; they are reported by you, not API-sampled.`);

  const noObs = sample.observations.length === 0;
  if (noObs) labels.push("No API-sampled answers yet: configure a GEO provider and wait for the next batch (or run it manually).");
  return {
    state: project.is_demo ? "demo" : noObs ? "setup_required" : "ready",
    generatedAt,
    rows: [...rows, ...proofRows],
    completeness: {
      note: `${citingSelf.size} of ${grounded.length} grounded, successful API-sampled answer(s) in the latest configuration cite your site; ${rows.length} distinct URL(s) of your site cited.${coverage.state === "setup_required" && coverage.rows.length === 0 ? " No approved prompts, so no add-proof rows." : ""}`,
      covered: citingSelf.size,
      total: grounded.length,
    },
    labels,
  };
}
