/**
 * [A7] "Why <engine> skips our page": observable attributes of one of our pages, measured from the latest
 * stored crawl snapshot (docs/api.md "GET /projects/:pid/geo/pages/:pageId/skip-factors"). Read-only:
 * never calls Jev, never fetches a page, no budget. There is NO aggregate score and no predicted citation
 * rate; each factor is an observable fact with a status.
 *
 * Factors (FACTORS_VERSION). Thresholds are engineering defaults, labelled on the response:
 *   answer_first   heuristic. With a prompt: 1-based word index of the first sentence of the stored
 *                  opening/excerpt that shares >= min(2, |question terms|) non-stopword, non-brand terms
 *                  with the prompt: present <= 60, partial <= 150, else missing ("not found in the first N
 *                  stored words" is missing). Without a prompt: first-paragraph length (present 1..60 words,
 *                  partial > 60, missing when no first paragraph was found).
 *   faq_schema     measured. FAQPage (or QAPage) JSON-LD type present; partial when >= 2 question-style
 *                  headings exist without that markup; else missing.
 *   author         measured. Byline from meta author / JSON-LD author; missing when none was found.
 *   freshness      measured. Visible last-updated date (meta modified / JSON-LD dateModified): present
 *                  <= 180 days, partial 181..365 days or a future date, missing > 365 days or no date.
 *   sources_cited  measured. Outbound links to other sites: present >= 3, partial 1..2, missing 0.
 *   entity_facts   heuristic. Numeric/spec facts in the stored text (numbers with units, currency,
 *                  percentages, dimensions, model numbers) plus Product/Organization-style JSON-LD:
 *                  present >= 5 facts (or >= 3 with such JSON-LD), partial >= 1, missing 0.
 *   compare_table  measured. HTML tables: present >= 1, missing 0.
 *   internal_links measured. Internal links IN from other pages of the same crawl: present >= 3,
 *                  partial 1..2, missing 0 (not linked from any crawled page).
 * A signal the crawler did not store is `unknown` with measured "not collected".
 */
import type { FactorStatus, GeoEngineProviderId, PageSkipFactors, SkipFactor, SkipFactorKey } from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { badRequest, notFound } from "../lib/errors";
import type { ProjectRow } from "../platform/access";
import { brandTokenSet, contentTokens } from "../coverage/answer-coverage";
import { DEMO_LABEL, pageKey } from "../coverage/common";
import { parseVisibleDate } from "../coverage/content-evidence";
import { loadGeoSample, observationsForPrompt } from "../coverage/geo-data";
import { countWords, splitSentences } from "../seo/crawl/extract";
import { tokens } from "../seo/recommend/text";

export const FACTORS_VERSION = "skip-factors-2026-09-30.1";

export const FACTOR_THRESHOLDS = {
  answerFirstPresent: 60,
  answerFirstPartial: 150,
  freshPresentDays: 180,
  freshPartialDays: 365,
  sourcesPresent: 3,
  entityPresent: 5,
  entityPresentWithSchema: 3,
  inlinksPresent: 3,
  questionHeadingsPartial: 2,
} as const;

export const FACTOR_LABELS: Record<SkipFactorKey, string> = {
  answer_first: "Answer first",
  faq_schema: "FAQ schema",
  author: "Author byline",
  freshness: "Freshness",
  sources_cited: "Sources cited",
  entity_facts: "Entity facts",
  compare_table: "Compare table",
  internal_links: "Internal links",
};

export const FACTOR_ORDER: readonly SkipFactorKey[] = ["answer_first", "faq_schema", "author", "freshness", "sources_cited", "entity_facts", "compare_table", "internal_links"];

export const SKIP_FACTOR_LABELS = {
  measured: "Measured from crawl",
  heuristic: "Heuristic: answer first and entity facts are text heuristics over the stored excerpt, not judgments.",
  correlational: "Correlational, not causal: these are observable differences; engines do not publish ranking factors.",
  noScore: "No aggregate score and no predicted citation rate.",
  thresholds: `Thresholds (${FACTORS_VERSION}, engineering defaults): answer within ${FACTOR_THRESHOLDS.answerFirstPresent} words; updated within ${FACTOR_THRESHOLDS.freshPresentDays} days; ${FACTOR_THRESHOLDS.sourcesPresent}+ outbound sources; ${FACTOR_THRESHOLDS.entityPresent}+ numeric/spec facts; ${FACTOR_THRESHOLDS.inlinksPresent}+ internal links in.`,
} as const;

const DAY_MS = 86_400_000;
const FAQ_TYPES = new Set(["faqpage", "qapage"]);
const ENTITY_TYPES = new Set(["product", "organization", "localbusiness", "store", "brand", "offer", "aggregateoffer", "softwareapplication", "service", "person"]);

/** Observable page evidence, from our crawl snapshot or from an approved competitor page's extraction. */
export interface PageEvidence {
  wordCount: number | null;
  firstParagraph: string | null;
  /** Stored main-text excerpt (plain text, capped). null = not collected. */
  excerpt: string | null;
  headings: Array<{ level: number; text: string }>;
  jsonldTypes: string[];
  author: string | null;
  lastUpdated: string | null;
  outboundCitations: number | null;
  tableCount: number | null;
  /** Internal links in from other crawled pages; null = not measurable (e.g. a single fetched page). */
  inlinks: number | null;
}

// ------------------------------------------------------------------ pure measurements
export interface AnswerPosition {
  /** 1-based word index where the first matching sentence starts; null when none matched. */
  word: number | null;
  /** Words scanned in the stored text. */
  scanned: number;
  sentence: string | null;
}

/** First sentence sharing the question's content terms (brand terms removed). */
export function answerPosition(text: string | null, questionTokens: Set<string>): AnswerPosition {
  if (!text) return { word: null, scanned: 0, sentence: null };
  const need = Math.min(2, questionTokens.size);
  let before = 0;
  for (const s of splitSentences(text)) {
    const words = countWords(s);
    if (need > 0) {
      const st = new Set(tokens(s));
      let shared = 0;
      for (const t of questionTokens) if (st.has(t)) shared++;
      if (shared >= need) return { word: before + 1, scanned: countWords(text), sentence: s };
    }
    before += words;
  }
  return { word: null, scanned: before, sentence: null };
}

/** Currency amounts, percentages, dimensions, and numbers with a unit (attached, or spaced for unambiguous units). */
const NUMERIC_FACT =
  /(?:[$€£¥]\s?\d[\d,.]*|\b\d[\d,.]*(?:%|mm|cm|m|km|in|ft|lbs?|kg|g|mg|mcg|ml|l|oz|w|kw|v|mah|gb|tb|mb|hz|ghz|mph)\b|\b\d[\d,.]*\s(?:percent|mm|cm|km|inch(?:es)?|feet|ft|lbs?|kg|mg|mcg|ml|oz|kw|mah|gb|tb|mb|hz|ghz|mph|watts?|volts?|years?|months?|days?|hours?|minutes?)\b|\b\d+\s?[x×]\s?\d+\b)/giu;
/** Model / part numbers such as "CJC-1295" or "XR500" (case-sensitive: capital letters then digits). */
const MODEL_NUMBER = /\b[A-Z]{1,5}-?\d{2,6}[A-Z]?\b/gu;

/** Heuristic count of numeric/spec facts in plain text (numbers with units, currency, %, dimensions, model numbers). */
export function countNumericFacts(text: string | null): number {
  if (!text) return 0;
  return (text.match(NUMERIC_FACT) ?? []).length + (text.match(MODEL_NUMBER) ?? []).length;
}

export function isQuestionHeading(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.endsWith("?") || /^(what|how|why|when|where|which|who|can|does|do|is|are|should|will)\b/.test(t);
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

const unknown = (key: SkipFactorKey, method: SkipFactor["method"], what: string): SkipFactor => ({
  key,
  label: FACTOR_LABELS[key],
  status: "unknown",
  measured: `${what}: not collected`,
  value: null,
  method,
  citedPage: null,
});

/** Evaluate every factor over one page's evidence. `question` is the prompt text (or null). */
export function evaluateFactors(e: PageEvidence, question: string | null, brand: Set<string>, now: Date, snapshotAt: string | null): SkipFactor[] {
  const out: SkipFactor[] = [];
  const f = (key: SkipFactorKey, status: FactorStatus, measured: string, value: number | null, method: SkipFactor["method"]): SkipFactor => ({
    key,
    label: FACTOR_LABELS[key],
    status,
    measured,
    value,
    method,
    citedPage: null,
  });

  // answer_first (heuristic)
  const text = e.excerpt ?? e.firstParagraph;
  if (question !== null) {
    const qt = contentTokens(question, brand);
    if (!text) out.push(unknown("answer_first", "heuristic", "Page text"));
    else if (qt.size === 0) out.push(f("answer_first", "unknown", "The question has no content terms to match", null, "heuristic"));
    else {
      const p = answerPosition(text, qt);
      if (p.word === null) out.push(f("answer_first", "missing", `No sentence sharing the question's terms in the first ${fmt(p.scanned)} stored words`, null, "heuristic"));
      else {
        const status: FactorStatus = p.word <= FACTOR_THRESHOLDS.answerFirstPresent ? "present" : p.word <= FACTOR_THRESHOLDS.answerFirstPartial ? "partial" : "missing";
        out.push(f("answer_first", status, `Answer at word ${fmt(p.word)}`, p.word, "heuristic"));
      }
    }
  } else if (e.firstParagraph === null && e.excerpt === null) {
    out.push(unknown("answer_first", "heuristic", "First paragraph"));
  } else if (!e.firstParagraph) {
    out.push(f("answer_first", "missing", "No first paragraph found", null, "heuristic"));
  } else {
    const n = countWords(e.firstParagraph);
    out.push(f("answer_first", n <= FACTOR_THRESHOLDS.answerFirstPresent ? "present" : "partial", `First paragraph ${fmt(n)} words`, n, "heuristic"));
  }

  // faq_schema (measured)
  const types = e.jsonldTypes.map((t) => t.toLowerCase());
  const faqType = e.jsonldTypes.find((t) => FAQ_TYPES.has(t.toLowerCase()));
  const qHeadings = e.headings.filter((h) => h.level >= 2 && isQuestionHeading(h.text)).length;
  if (faqType) out.push(f("faq_schema", "present", `${faqType} JSON-LD present`, qHeadings, "measured"));
  else if (qHeadings >= FACTOR_THRESHOLDS.questionHeadingsPartial) out.push(f("faq_schema", "partial", `${qHeadings} question headings; FAQPage JSON-LD absent`, qHeadings, "measured"));
  else out.push(f("faq_schema", "missing", "FAQPage JSON-LD absent", qHeadings, "measured"));

  // author (measured)
  if (e.author && e.author.trim()) out.push(f("author", "present", `Byline: ${e.author.trim().slice(0, 80)}`, null, "measured"));
  else out.push(f("author", "missing", "No author or byline markup found", null, "measured"));

  // freshness (measured)
  const d = parseVisibleDate(e.lastUpdated);
  if (!e.lastUpdated) out.push(f("freshness", "missing", "No last-updated date found", null, "measured"));
  else if (!d) out.push(f("freshness", "unknown", `Last-updated value not a date: ${e.lastUpdated.slice(0, 40)}`, null, "measured"));
  else {
    const age = Math.floor((now.getTime() - d.getTime()) / DAY_MS);
    const day = d.toISOString().slice(0, 10);
    if (age < -1) out.push(f("freshness", "partial", `Last-updated date ${day} is in the future`, age, "measured"));
    else {
      const a = Math.max(0, age);
      const status: FactorStatus = a <= FACTOR_THRESHOLDS.freshPresentDays ? "present" : a <= FACTOR_THRESHOLDS.freshPartialDays ? "partial" : "missing";
      out.push(f("freshness", status, `Updated ${day} (${fmt(a)} days ago)`, a, "measured"));
    }
  }

  // sources_cited (measured)
  if (e.outboundCitations === null) out.push(unknown("sources_cited", "measured", "Outbound source links"));
  else {
    const n = e.outboundCitations;
    const status: FactorStatus = n >= FACTOR_THRESHOLDS.sourcesPresent ? "present" : n > 0 ? "partial" : "missing";
    out.push(f("sources_cited", status, `${fmt(n)} outbound source link${n === 1 ? "" : "s"}`, n, "measured"));
  }

  // entity_facts (heuristic)
  if (!text && types.length === 0) out.push(unknown("entity_facts", "heuristic", "Page text"));
  else {
    const facts = countNumericFacts(text);
    const schema = e.jsonldTypes.filter((t) => ENTITY_TYPES.has(t.toLowerCase()));
    const threshold = schema.length > 0 ? FACTOR_THRESHOLDS.entityPresentWithSchema : FACTOR_THRESHOLDS.entityPresent;
    const status: FactorStatus = facts >= threshold ? "present" : facts > 0 || schema.length > 0 ? "partial" : "missing";
    const parts = [`${fmt(facts)} numeric/spec fact${facts === 1 ? "" : "s"} in the stored text`];
    if (schema.length > 0) parts.push(`${schema.slice(0, 3).join(", ")} JSON-LD`);
    out.push(f("entity_facts", status, parts.join("; "), facts, "heuristic"));
  }

  // compare_table (measured)
  if (e.tableCount === null) out.push(unknown("compare_table", "measured", "HTML tables"));
  else out.push(f("compare_table", e.tableCount > 0 ? "present" : "missing", e.tableCount > 0 ? `${fmt(e.tableCount)} HTML table${e.tableCount === 1 ? "" : "s"}` : "No HTML table", e.tableCount, "measured"));

  // internal_links (measured)
  if (e.inlinks === null) out.push(f("internal_links", "unknown", "Internal links in: not measurable for a single fetched page", null, "measured"));
  else {
    const n = e.inlinks;
    const status: FactorStatus = n >= FACTOR_THRESHOLDS.inlinksPresent ? "present" : n > 0 ? "partial" : "missing";
    out.push(f("internal_links", status, `${fmt(n)} internal link${n === 1 ? "" : "s"} in from crawled pages${snapshotAt ? ` (crawl of ${snapshotAt.slice(0, 10)})` : ""}`, n, "measured"));
  }
  return out;
}

// ------------------------------------------------------------------ loaders
interface SnapshotRow {
  id: string;
  crawl_run_id: string;
  status_code: number | null;
  skipped_reason: string | null;
  headings_json: string;
  jsonld_types_json: string;
  word_count: number | null;
  main_text_excerpt: string | null;
  first_paragraph: string | null;
  author: string | null;
  last_updated: string | null;
  outbound_citations: number | null;
  table_count: number | null;
  fetched_at: string;
}

export interface OurPageEvidence {
  pageId: string;
  url: string;
  snapshotAt: string | null;
  evidence: PageEvidence | null;
  /** Why evidence is null (no crawl / skipped), plain text. */
  basis: string | null;
}

/** Latest snapshot of one page (+ internal links in from the same crawl). The page must belong to the project. */
export async function loadOurPageEvidence(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, pageId: string): Promise<OurPageEvidence | null> {
  const ws = project.workspace_id;
  const pid = project.id;
  const page = await db.first<{ id: string; url: string }>("SELECT id, url FROM pages WHERE workspace_id = ? AND project_id = ? AND id = ?", ws, pid, pageId);
  if (!page) return null;
  const snap = await db.first<SnapshotRow>(
    `SELECT id, crawl_run_id, status_code, skipped_reason, headings_json, jsonld_types_json, word_count, main_text_excerpt, first_paragraph,
            author, last_updated, outbound_citations, table_count, fetched_at
       FROM page_snapshots WHERE workspace_id = ? AND project_id = ? AND page_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1`,
    ws,
    pid,
    pageId,
  );
  if (!snap) return { pageId: page.id, url: page.url, snapshotAt: null, evidence: null, basis: "No crawl yet" };
  if (snap.skipped_reason) return { pageId: page.id, url: page.url, snapshotAt: snap.fetched_at, evidence: null, basis: `Skipped by the crawler: ${snap.skipped_reason}` };
  if (snap.status_code === null || snap.status_code < 200 || snap.status_code >= 300) {
    return { pageId: page.id, url: page.url, snapshotAt: snap.fetched_at, evidence: null, basis: `Not analysed: HTTP ${snap.status_code ?? "no response"}` };
  }
  const target = pageKey(page.url);
  const others = await db.all<{ page_id: string; internal_links_json: string }>(
    "SELECT page_id, internal_links_json FROM page_snapshots WHERE workspace_id = ? AND project_id = ? AND crawl_run_id = ? AND page_id <> ?",
    ws,
    pid,
    snap.crawl_run_id,
    pageId,
  );
  const sources = new Set<string>();
  for (const o of others) {
    const links = parseJson<unknown[]>(o.internal_links_json, []);
    if (links.some((l) => typeof l === "string" && target !== null && pageKey(l) === target)) sources.add(o.page_id);
  }
  return {
    pageId: page.id,
    url: page.url,
    snapshotAt: snap.fetched_at,
    evidence: {
      wordCount: snap.word_count,
      firstParagraph: snap.first_paragraph,
      excerpt: snap.main_text_excerpt,
      headings: parseJson<unknown[]>(snap.headings_json, []).filter(
        (h): h is { level: number; text: string } => !!h && typeof h === "object" && typeof (h as { level?: unknown }).level === "number" && typeof (h as { text?: unknown }).text === "string",
      ),
      jsonldTypes: [...new Set(parseJson<unknown[]>(snap.jsonld_types_json, []).filter((t): t is string => typeof t === "string"))],
      author: snap.author,
      lastUpdated: snap.last_updated,
      outboundCitations: snap.outbound_citations,
      tableCount: snap.table_count,
      inlinks: sources.size,
    },
    basis: null,
  };
}

/**
 * Host cited most often, instead of our site, in the latest-cohort answers to one prompt (optionally one
 * engine): counted over successful grounded answers that cite no own-site URL; ties by host name.
 */
export async function citedInsteadForPrompt(
  db: Db,
  project: ProjectRow,
  prompt: { id: string; text: string },
  engine: string | null,
): Promise<{ host: string; url: string; observationIds: string[] } | null> {
  const sample = await loadGeoSample(db, project);
  const obs = observationsForPrompt(sample, prompt).filter((o) => o.status === "ok" && o.grounded && (engine === null || o.provider === engine));
  const counts = new Map<string, { n: number; url: string; obs: string[] }>();
  for (const o of obs) {
    const cits = sample.citations.get(o.id) ?? [];
    if (cits.some((c) => c.self)) continue;
    const seen = new Set<string>();
    for (const c of cits) {
      if (c.self || !c.host || seen.has(c.host)) continue;
      seen.add(c.host);
      const cur = counts.get(c.host) ?? { n: 0, url: c.url, obs: [] };
      cur.n++;
      cur.obs.push(o.id);
      counts.set(c.host, cur);
    }
  }
  let best: { host: string; url: string; observationIds: string[]; n: number } | null = null;
  for (const [host, v] of counts) {
    if (!best || v.n > best.n || (v.n === best.n && host < best.host)) best = { host, url: v.url, observationIds: v.obs, n: v.n };
  }
  return best ? { host: best.host, url: best.url, observationIds: best.observationIds } : null;
}

export interface SkipFactorsQuery {
  promptId: string | null;
  engine: GeoEngineProviderId | null;
}

/** Hook for the cited-page column: the latest assessed competitor assessment for a host (see competitor-pages.ts). */
export type CitedPageLookup = (
  db: Db,
  project: ProjectRow,
  host: string,
  question: string | null,
  now: Date,
) => Promise<{ id: string; factors: Map<SkipFactorKey, { status: FactorStatus; measured: string; value: number | null }> } | null>;

export async function buildPageSkipFactors(db: Db, project: ProjectRow, pageId: string, q: SkipFactorsQuery, now: Date, citedPage: CitedPageLookup | null): Promise<PageSkipFactors> {
  const ws = project.workspace_id;
  const pid = project.id;
  const page = await loadOurPageEvidence(db, project, pageId);
  if (!page) throw notFound("Page");

  let prompt: { id: string; text: string } | null = null;
  if (q.promptId) {
    prompt = await db.first<{ id: string; text: string }>(
      "SELECT id, text FROM geo_prompts WHERE workspace_id = ? AND project_id = ? AND id = ? AND approved = 1",
      ws,
      pid,
      q.promptId,
    );
    if (!prompt) throw badRequest("promptId must be an approved prompt of this project.", { reason: "prompt_not_approved" });
  }

  const labels: string[] = [];
  if (project.is_demo) labels.push(DEMO_LABEL);
  labels.push(SKIP_FACTOR_LABELS.measured, SKIP_FACTOR_LABELS.heuristic, SKIP_FACTOR_LABELS.correlational, SKIP_FACTOR_LABELS.noScore, SKIP_FACTOR_LABELS.thresholds);

  const instead = prompt ? await citedInsteadForPrompt(db, project, prompt, q.engine) : null;
  const brand = brandTokenSet(project);
  const state = project.is_demo ? "demo" : "ready";

  const base = {
    state,
    page: { pageId: page.pageId, url: page.url, snapshotAt: page.snapshotAt, wordCount: page.evidence?.wordCount ?? null },
    promptId: prompt?.id ?? null,
    promptText: prompt?.text ?? null,
    engine: q.engine,
    citedInsteadHost: instead?.host ?? null,
  } as const;

  if (!page.evidence) {
    return {
      ...base,
      competitorAssessmentId: null,
      factors: FACTOR_ORDER.map((key) => ({
        key,
        label: FACTOR_LABELS[key],
        status: "unknown" as const,
        measured: page.basis ?? "No crawl yet",
        value: null,
        method: key === "answer_first" || key === "entity_facts" ? ("heuristic" as const) : ("measured" as const),
        citedPage: null,
      })),
      basis: page.basis ?? "No crawl yet",
      labels,
    };
  }

  const factors = evaluateFactors(page.evidence, prompt?.text ?? null, brand, now, page.snapshotAt);
  let competitorAssessmentId: string | null = null;
  if (instead && citedPage) {
    const cp = await citedPage(db, project, instead.host, prompt?.text ?? null, now);
    if (cp) {
      competitorAssessmentId = cp.id;
      for (const fct of factors) fct.citedPage = cp.factors.get(fct.key) ?? null;
    }
  }
  const basisParts = [`Latest crawl snapshot of this page (${page.snapshotAt?.slice(0, 10) ?? "unknown date"}).`];
  if (prompt) basisParts.push(instead ? `Cited instead: ${instead.host}, the host most often cited by ${q.engine ?? "the engines"} for this prompt when your site was not cited (latest cohort).` : "No other host was cited for this prompt in the latest cohort.");
  if (competitorAssessmentId) basisParts.push("Cited-page column from the competitor page you approved reading.");
  else if (instead) basisParts.push("Approve reading the cited page to compare it here.");
  return { ...base, competitorAssessmentId, factors, basis: basisParts.join(" "), labels };
}
