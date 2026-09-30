/**
 * SEO Jev questions (docs/build-kit.md section 2.1). Authoring rules applied:
 *  - state fields are named and referenced by backticked path in the question text;
 *  - every Choice option, Score level, and Noul criterion is a full descriptive sentence;
 *  - every Choice has an escape option (insufficient_context / none / no_action);
 *  - questions whose inputs are absent are omitted by `questionsForState` (never placeholders).
 * question_version = policy.questionVersion(question) (a hash of text/options/levels); the snapshot
 * test in tests/seo-analysis-questions.test.ts fails if wording changes without updating it.
 *
 * State shape (built in recommend/decide.ts):
 *   { query?, locale, site_type, page?: {url, page_type, title, h1, excerpt}, issue: {type, description,
 *     metrics, evidence_ids, page_type?, affected_url_count?, gsc_impressions?}, pillars?: string[] }
 * Pair batches ([A15]): { pairs: { <key>: { page_a, page_b, shared_queries } } }
 */
import type { DecisionQuestion } from "../providers/types";
import { questionVersion } from "../runs/policy";

export const SEO_QUESTIONS_REVISION = "seo-questions-2026-09-30.1";

export const QUESTION = {
  queryPageRelevance: "seo.query_page_relevance",
  queryIntent: "seo.query_intent",
  intentPageFit: "seo.intent_page_fit",
  actionChoice: "seo.action_choice",
  issueSeverity: "seo.issue_severity",
  pillarFit: "seo.pillar_fit",
  pageOverlap: "seo.page_overlap",
} as const;
export type SeoQuestionId = (typeof QUESTION)[keyof typeof QUESTION];

export const QUERY_PAGE_RELEVANCE: DecisionQuestion = {
  type: "noul",
  instructions:
    "Is the search query in `query` a good match for the primary topic of the page described by `page.title`, `page.h1`, `page.excerpt` (the first 300 characters of its main text), and `page.page_type`?",
  criteria: {
    true: "The page's primary topic, as shown by its title, H1, and opening text, directly addresses what someone searching `query` wants, so this page is an appropriate result for that query.",
    false: "The page's primary topic is different from what `query` asks for, or it mentions the query's subject only in passing, so another existing page or a new page would serve the query better.",
  },
};

export const QUERY_INTENT_OPTIONS = ["informational", "commercial_investigation", "transactional", "navigational", "local", "insufficient_context"] as const;

export const QUERY_INTENT: DecisionQuestion = {
  type: "choice",
  instructions: "What is the dominant intent of the search query in `query`, for a searcher using `locale` who finds a site of type `site_type`?",
  criteria: {
    informational: "Informational. The searcher mainly wants to learn or understand something (how, what, why, ideas, care) and is not yet evaluating specific products or vendors.",
    commercial_investigation: "Commercial investigation. The searcher is comparing options, styles, brands, or reviews to decide what to buy, but is not yet ready to purchase a specific item.",
    transactional: "Transactional. The searcher wants to buy, order, or get a specific product or service now, for example a query naming a product with a variant, size, or purchase intent.",
    navigational: "Navigational. The searcher wants to reach a specific website, brand, or page they already have in mind.",
    local: "Local. The searcher wants a physical location, showroom, installer, or service near a place.",
    insufficient_context: "Insufficient context. `query` is too short, ambiguous, or unclear to tell which of the other intents dominates.",
  },
};

export const INTENT_PAGE_FIT_OPTIONS = ["fits", "partial_fit", "mismatch", "insufficient_context"] as const;

export const INTENT_PAGE_FIT: DecisionQuestion = {
  type: "choice",
  instructions:
    "Considering the dominant intent behind `query`, does a page of type `page.page_type` whose content is summarized by `page.title`, `page.h1`, and `page.excerpt` serve that intent?",
  criteria: {
    fits: "Fits. This type of page, with this content, directly serves the dominant intent of `query`, for example a product page for a buying query or a guide for a how-to query.",
    partial_fit: "Partial fit. The page serves part of the intent of `query` but leaves an important part unaddressed, for example a product page for a comparison query that lacks any comparison.",
    mismatch: "Mismatch. This type of page cannot reasonably serve the intent of `query`, for example a category listing for a detailed how-to question.",
    insufficient_context: "Insufficient context. The page summary or `query` is too thin or ambiguous to judge whether the page serves the intent.",
  },
};

export const ACTION_CHOICE_OPTIONS = [
  "rewrite_title_meta",
  "improve_intro_answer",
  "add_section",
  "add_comparison_or_spec_table",
  "add_internal_links",
  "fix_structured_data",
  "fix_canonical_or_indexing",
  "consolidate_duplicate",
  "new_page_candidate",
  "no_action",
] as const;
export type ActionChoice = (typeof ACTION_CHOICE_OPTIONS)[number];

export const ACTION_CHOICE: DecisionQuestion = {
  type: "choice",
  instructions:
    "Given the issue described in `issue` (its `issue.type`, `issue.description`, and `issue.metrics`) and, when present, the page in `page` and the search query in `query`, what single change best addresses this evidence?",
  criteria: {
    rewrite_title_meta: "Rewrite the title and meta description. The page already covers the topic, but its search snippet does not clearly reflect what searchers look for, so clearer wording could earn more clicks.",
    improve_intro_answer: "Improve the introduction. The page covers the topic, but its opening does not directly answer what the searcher wants, so a clearer first paragraph is the most useful change.",
    add_section: "Add a section. The page is the right destination, but it lacks content on a subtopic that the evidence shows searchers look for.",
    add_comparison_or_spec_table: "Add a comparison or specification table. Searchers are comparing options or looking for specifics that a structured table on this page would answer best.",
    add_internal_links: "Add internal links. The page is relevant but poorly connected from related pages on the site, so contextual internal links are the most useful change.",
    fix_structured_data: "Fix structured data. The evidence points to missing or invalid structured data on the page or template rather than to a content problem.",
    fix_canonical_or_indexing: "Fix canonical or indexing signals. The evidence points to canonical, noindex, or status problems that affect which URL search engines index or show.",
    consolidate_duplicate: "Consolidate duplicates. Two or more pages compete for the same intent, so one should absorb the other through merging content and redirecting or canonicalizing.",
    new_page_candidate: "Consider a new page. No existing page is a good destination for this search demand, so a human should review whether a new page is warranted.",
    no_action: "No action. The evidence is weak, already addressed, or better left alone, so no change is recommended now.",
  },
};

export const ISSUE_SEVERITY_LEVELS = 5;

export const ISSUE_SEVERITY: DecisionQuestion = {
  type: "score",
  instructions:
    "How severe is the technical issue described in `issue` for the search visibility of the affected pages, considering `issue.page_type`, `issue.affected_url_count`, and, when present, `issue.gsc_impressions`?",
  criteria: [
    "Cosmetic. The issue is a tidiness or consistency matter; search engines can crawl, index, understand, and show the affected pages normally.",
    "Minor. The issue may slightly weaken how the pages are understood or presented in results, but crawling, indexing, and serving are unaffected.",
    "Moderate. The issue plausibly reduces how well the pages are understood or how useful their search results look, for example missing descriptions or weak headings across important pages.",
    "Major. The issue likely causes the wrong URL to be indexed or shown, loses structured-data eligibility, or breaks internal discovery of important pages.",
    "Critical. The issue blocks indexing or serving of pages that should rank, for example a declared noindex, server errors, or canonicals pointing to unavailable URLs.",
  ],
};

/** Pillar fit: options are the project's pillar names plus `none`. */
export function pillarFitQuestion(pillars: string[]): DecisionQuestion | null {
  const names = [...new Set(pillars.map((p) => p.trim()).filter((p) => p.length > 0 && p.toLowerCase() !== "none"))].slice(0, 12);
  if (names.length === 0) return null;
  const criteria: Record<string, string> = {};
  for (const n of names) criteria[n] = `The search demand in \`query\` belongs to the content pillar "${n}" listed in \`pillars\`.`;
  criteria.none = "None. The search demand in `query` does not clearly belong to any of the content pillars listed in `pillars`.";
  return {
    type: "choice",
    instructions: "Which of the project's content pillars in `pillars` does the search demand in `query` belong to?",
    criteria,
  };
}

/** Canonical (versioned) pair question; `{pair}` is replaced by the pair key when batched. */
export const PAGE_OVERLAP_TEMPLATE: DecisionQuestion = {
  type: "noul",
  instructions:
    "Do `pairs.{pair}.page_a` and `pairs.{pair}.page_b` compete for the same search intent, so that one should absorb the other? Use each page's title, H1, opening text, and the queries in `pairs.{pair}.shared_queries` that both pages received impressions for.",
  criteria: {
    true: "Both pages target the same searcher need with substantially the same topic, so searchers and search engines would reasonably treat them as interchangeable and one should absorb the other.",
    false: "The pages serve different needs, products, variants, or stages of the search, so both deserve to exist even though they share some words or queries.",
  },
};

export function pageOverlapQuestion(pairKey: string): DecisionQuestion {
  if (!/^[A-Za-z0-9_]+$/.test(pairKey)) throw new Error("pair key must be alphanumeric");
  const q = PAGE_OVERLAP_TEMPLATE as Extract<DecisionQuestion, { type: "noul" }>;
  return { type: "noul", instructions: q.instructions.replaceAll("{pair}", pairKey), criteria: q.criteria };
}

/** Inputs available for one candidate's state. */
export interface QuestionInputs {
  hasQuery: boolean;
  /** Page with a title or H1 (not a legal/policy page). */
  hasPage: boolean;
  hasPageType: boolean;
  isTechnical: boolean;
  wantsIntent: boolean;
  pillars: string[];
  wantsPillar: boolean;
}

/** Only the questions whose inputs exist and that are relevant to this candidate. */
export function questionsForState(i: QuestionInputs): Record<string, DecisionQuestion> {
  const out: Record<string, DecisionQuestion> = {};
  if (i.isTechnical) {
    out[QUESTION.issueSeverity] = ISSUE_SEVERITY;
    return out;
  }
  if (i.hasQuery && i.hasPage) out[QUESTION.queryPageRelevance] = QUERY_PAGE_RELEVANCE;
  if (i.hasQuery && i.wantsIntent) out[QUESTION.queryIntent] = QUERY_INTENT;
  if (i.hasQuery && i.wantsIntent && i.hasPage && i.hasPageType) out[QUESTION.intentPageFit] = INTENT_PAGE_FIT;
  out[QUESTION.actionChoice] = ACTION_CHOICE;
  if (i.hasQuery && i.wantsPillar) {
    const p = pillarFitQuestion(i.pillars);
    if (p) out[QUESTION.pillarFit] = p;
  }
  return out;
}

/** question_version for a question id; pair questions version on the canonical template. */
export async function versionFor(questionId: string, q: DecisionQuestion): Promise<string> {
  if (questionId === QUESTION.pageOverlap || questionId.startsWith(`${QUESTION.pageOverlap}#`)) return questionVersion(PAGE_OVERLAP_TEMPLATE);
  return questionVersion(q);
}

/** Versions of the static questions (snapshot-tested). */
export async function staticQuestionVersions(): Promise<Record<string, string>> {
  return {
    [QUESTION.queryPageRelevance]: await questionVersion(QUERY_PAGE_RELEVANCE),
    [QUESTION.queryIntent]: await questionVersion(QUERY_INTENT),
    [QUESTION.intentPageFit]: await questionVersion(INTENT_PAGE_FIT),
    [QUESTION.actionChoice]: await questionVersion(ACTION_CHOICE),
    [QUESTION.issueSeverity]: await questionVersion(ISSUE_SEVERITY),
    [QUESTION.pageOverlap]: await questionVersion(PAGE_OVERLAP_TEMPLATE),
  };
}
