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
 *   { query?, locale, country, language, site_type, brand_terms?: {self, competitors},
 *     page?: {url, page_type, title, h1, excerpt, meta_description?, headings?, text?, opening?,
 *             structured_data_types?, dated_references?},
 *     issue: {type, description, metrics, evidence_ids, page_type?, affected_url_count?, gsc_impressions?},
 *     pillars?: string[], top_query?, queries?: string[], today?, thin_pages?: {<key>: page} }
 * Pair batches ([A15]): { pairs: { <key>: { page_a, page_b, shared_queries } } }
 * Query batches ([A23] buyer queries, query relevance): { locale, country, language, site_type,
 *   brand_terms, business?, queries: { q1: "...", ... } } with one keyed question per query.
 *
 * Templated questions (query intent, query relevance, thin content) carry a `{q}` / `{p}` placeholder
 * for the state path they point at; question_version hashes the TEMPLATE, so the single-candidate form
 * (`query`) and the batched form (`queries.q7`) share one version and one cache cohort.
 *
 * [A23] questions added in revision .2 (binary decisions are Noul, per the product owner's direction;
 * Noul is tiered by the policy's probability bands, never by a confidence field):
 *   seo.query_intent        gains `mixed` (routed to human review) and brand terms, country, language
 *   seo.query_relevance     Noul, batched per query before candidates (drop confident no, flag middle)
 *   seo.buyer_query         Noul, batched per query for the buyer-query view (include yes / flag middle)
 *   seo.buyer_ready         Noul, same batch: ready to buy now (transactional) vs still comparing
 *                           (commercial_investigation); only labels rows the buyer_query gate kept
 *   seo.thin_content        Noul per example page, confirms SEO-CONTENT-THIN before a recommendation
 *   seo.page_action         Choice keep/update/merge/remove/insufficient_context (genuinely categorical)
 *   seo.schema_content_match Noul, structured data vs visible content
 *   seo.title_matches_query / seo.meta_matches_query  Noul each, snippet vs the page's top GSC query
 *   seo.covers_topic        Noul per topic (`seo.covers_topic#t<n>`), aggregated in code
 *   seo.outdated_information Noul with today's date in state
 *   seo.answer_is_direct    Noul, the opening answers the top query in its first two sentences (AEO)
 */
import type { DecisionQuestion } from "../providers/types";
import { questionVersion } from "../runs/policy";

export const SEO_QUESTIONS_REVISION = "seo-questions-2026-09-30.2";

export const QUESTION = {
  queryPageRelevance: "seo.query_page_relevance",
  queryIntent: "seo.query_intent",
  intentPageFit: "seo.intent_page_fit",
  actionChoice: "seo.action_choice",
  issueSeverity: "seo.issue_severity",
  pillarFit: "seo.pillar_fit",
  pageOverlap: "seo.page_overlap",
  queryRelevance: "seo.query_relevance",
  thinContent: "seo.thin_content",
  pageAction: "seo.page_action",
  schemaContentMatch: "seo.schema_content_match",
  titleMatchesQuery: "seo.title_matches_query",
  metaMatchesQuery: "seo.meta_matches_query",
  coversTopic: "seo.covers_topic",
  outdatedInformation: "seo.outdated_information",
  answerIsDirect: "seo.answer_is_direct",
  buyerQuery: "seo.buyer_query",
  buyerReady: "seo.buyer_ready",
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

export const QUERY_INTENT_OPTIONS = ["informational", "commercial_investigation", "transactional", "navigational", "local", "mixed", "insufficient_context"] as const;
export type QueryIntent = (typeof QUERY_INTENT_OPTIONS)[number];

/**
 * Canonical (versioned) intent question. `{q}` is the state path of the query: `query` for one
 * candidate, `queries.q<n>` in a batch. The state also carries `locale`, `country`, `language`,
 * `site_type`, and `brand_terms` ({self: brand name + aliases, competitors: competitor names + aliases}).
 */
export const QUERY_INTENT_TEMPLATE: DecisionQuestion = {
  type: "choice",
  instructions:
    "What is the dominant intent of the search query in `{q}`, for a searcher in `country` using `locale` and `language` who finds a site of type `site_type`? `brand_terms.self` lists this site's own brand name and aliases, and `brand_terms.competitors` lists competing brands.",
  criteria: {
    informational: "Informational. The searcher mainly wants to learn or understand something (how, what, why, ideas, care) and is not yet evaluating specific products or vendors.",
    commercial_investigation: "Commercial investigation. The searcher is comparing options, styles, brands, or reviews to decide what to buy, but is not yet ready to purchase a specific item.",
    transactional: "Transactional. The searcher wants to buy, order, or get a specific product or service now, for example a query naming a product with a variant, size, or purchase intent.",
    navigational: "Navigational. The searcher wants to reach a specific website, brand, or page they already have in mind, such as one of the names in `brand_terms`.",
    local: "Local. The searcher wants a physical location, showroom, installer, or service near a place.",
    mixed: "Mixed. The wording of `{q}` supports two or more of the intents above about equally, for example a bare product name that could mean researching or buying, so no single intent clearly dominates.",
    insufficient_context: "Insufficient context. `{q}` is too short, ambiguous, or unclear to tell what the searcher wants at all.",
  },
};

const STATE_PATH = /^[a-z_]+(?:\.[a-z0-9_]+)*$/;

function fillTemplate(t: DecisionQuestion, placeholder: string, path: string): DecisionQuestion {
  if (!STATE_PATH.test(path)) throw new Error("state path must be lowercase dotted identifiers");
  const fill = (x: string) => x.replaceAll(placeholder, path);
  if (t.type === "choice") return { type: "choice", instructions: fill(t.instructions), criteria: Object.fromEntries(Object.entries(t.criteria).map(([k, v]) => [k, fill(v)])) };
  if (t.type === "score") return { type: "score", instructions: fill(t.instructions), criteria: t.criteria.map(fill) as unknown as readonly [string, string, ...string[]] };
  return { type: "noul", instructions: fill(t.instructions), criteria: t.criteria ? { true: fill(t.criteria.true ?? ""), false: fill(t.criteria.false ?? "") } : undefined };
}

/** Intent question pointing at `path` (default `query`). */
export function queryIntentQuestion(path = "query"): DecisionQuestion {
  return fillTemplate(QUERY_INTENT_TEMPLATE, "{q}", path);
}

/** The single-candidate form (state path `query`). */
export const QUERY_INTENT: DecisionQuestion = queryIntentQuestion("query");

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

// ------------------------------------------------------------------ [A23] query relevance (batched pre-filter)
/**
 * Asked for GSC and engine search queries before candidates are built; `{q}` is `queries.q<n>`.
 * State: { business: {name, products, audience, site_type, locale, language}, queries: {...} }.
 */
export const QUERY_RELEVANCE_TEMPLATE: DecisionQuestion = {
  type: "noul",
  instructions:
    "Is the search query in `{q}` about this business's products, services, or audience, as described by `business.name`, `business.products`, `business.audience`, and `business.site_type`?",
  criteria: {
    true: "The query asks about the kinds of products or services this business offers, or about a need its audience has that those products or services address, so a searcher typing it could reasonably be served by this site.",
    false: "The query only shares words with the business, for example a lookalike product, an unrelated meaning of the same word, a job search, or a topic the business does not serve, so it should not drive recommendations for this site.",
  },
};

export function queryRelevanceQuestion(path: string): DecisionQuestion {
  return fillTemplate(QUERY_RELEVANCE_TEMPLATE, "{q}", path);
}

// ------------------------------------------------------------------ [A23] thin content (confirms SEO-CONTENT-THIN)
/** `{p}` is the state path of one page (e.g. `thin_pages.e1`); up to three example pages per candidate. */
export const THIN_CONTENT_TEMPLATE: DecisionQuestion = {
  type: "noul",
  instructions:
    "Is the page in `{p}` thin, meaning its main content, shown by `{p}.title`, `{p}.h1`, `{p}.page_type`, `{p}.word_count`, and `{p}.excerpt`, is too little to satisfy what a visitor to this kind of page needs?",
  criteria: {
    true: "The page offers too little substantive content for its purpose, for example a guide that stops after a sentence or a landing page with only a heading, so adding or consolidating content would help visitors.",
    false: "The page is short but complete for its purpose, for example a product page with its key details, a contact page, or a focused answer, so its length is not a problem worth fixing.",
  },
};

export function thinContentQuestion(path: string): DecisionQuestion {
  return fillTemplate(THIN_CONTENT_TEMPLATE, "{p}", path);
}

// ------------------------------------------------------------------ [A23] page action (declining / thin pages)
export const PAGE_ACTION_OPTIONS = ["keep", "update", "merge", "remove", "insufficient_context"] as const;
export type PageAction = (typeof PAGE_ACTION_OPTIONS)[number];

export const PAGE_ACTION: DecisionQuestion = {
  type: "choice",
  instructions:
    "Given the page in `page` and the evidence in `issue.description` and `issue.metrics`, what should happen to this page as a whole?",
  criteria: {
    keep: "Keep. The page still serves its purpose and the evidence does not point to a problem the page itself can fix, so it should be left as it is for now.",
    update: "Update. The page is worth keeping, but its content, snippet, or structure should be refreshed or improved so it serves searchers better.",
    merge: "Merge. The page overlaps with another page on the site closely enough that combining the two into one stronger page would serve searchers better.",
    remove: "Remove. The page no longer serves a useful purpose for visitors or the business, so a human should consider retiring it with a redirect to the closest relevant page.",
    insufficient_context: "Insufficient context. The page summary and the evidence are too thin to choose between keeping, updating, merging, or removing the page.",
  },
};

// ------------------------------------------------------------------ [A23] schema-content match
export const SCHEMA_CONTENT_MATCH: DecisionQuestion = {
  type: "noul",
  instructions:
    "Do the structured-data types in `page.structured_data_types` accurately describe what the page visibly is and shows, judging by `page.title`, `page.h1`, `page.page_type`, `page.headings`, and `page.excerpt`?",
  criteria: {
    true: "The structured data describes what the page visibly presents, for example Product markup on a page that shows one product with its details, so the markup and the visible content agree.",
    false: "The structured data describes something the page does not visibly show, for example Product markup on a blog article or FAQ markup without visible questions and answers, so the markup and the content disagree.",
  },
};

// ------------------------------------------------------------------ [A23]/[A25] snippet vs the page's top GSC query
export const TITLE_MATCHES_QUERY: DecisionQuestion = {
  type: "noul",
  instructions:
    "Does the page title in `page.title` clearly promise what someone searching `top_query` wants? `top_query` is the query that brings this page the most Search Console impressions.",
  criteria: {
    true: "The title names what `top_query` asks for in words a searcher would recognize, so the page reads as a match for that search from its title alone.",
    false: "The title buries, rewords beyond recognition, or leaves out what `top_query` asks for, so a searcher would not expect this page to answer that search.",
  },
};

export const META_MATCHES_QUERY: DecisionQuestion = {
  type: "noul",
  instructions:
    "Does the meta description in `page.meta_description` clearly promise what someone searching `top_query` wants? `top_query` is the query that brings this page the most Search Console impressions.",
  criteria: {
    true: "The description tells a searcher of `top_query` that this page answers or offers what they are looking for, in plain and specific words.",
    false: "The description is generic, off-topic, or about something else, so it gives a searcher of `top_query` no clear reason to choose this page.",
  },
};

// ------------------------------------------------------------------ [A23] topic coverage (one Noul per topic)
/** `{t}` is the state path of one topic (`topics.t<n>`: a GSC gap query or an engine search query). */
export const COVERS_TOPIC_TEMPLATE: DecisionQuestion = {
  type: "noul",
  instructions:
    "Does the page described by `page.title`, `page.h1`, `page.headings`, and `page.text` cover the topic in `{t}` with substantive content?",
  criteria: {
    true: "The page gives real, specific information about the topic in `{t}`, even where it uses different words, so a searcher asking about it would find an answer on this page.",
    false: "The page does not address the topic in `{t}`, or mentions it only in passing without useful detail, so a searcher asking about it would not find an answer here.",
  },
};

export function coversTopicQuestion(path: string): DecisionQuestion {
  return fillTemplate(COVERS_TOPIC_TEMPLATE, "{t}", path);
}

// ------------------------------------------------------------------ [A23] freshness (with the deterministic stale-year detector)
export const OUTDATED_INFORMATION: DecisionQuestion = {
  type: "noul",
  instructions:
    "As of the date in `today`, does the page described by `page.title`, `page.h1`, and `page.excerpt` present information as current that is likely out of date, such as the dated references listed in `page.dated_references`?",
  criteria: {
    true: "The page presents dated facts, prices, years, rankings, or recommendations as if they were still current, so a reader on the date in `today` would likely get stale information.",
    false: "The dated references are historical context or still accurate, for example a founding year or a past event described as past, so the page does not present outdated information as current.",
  },
};

// ------------------------------------------------------------------ [A23] answer clarity (AEO)
export const ANSWER_IS_DIRECT: DecisionQuestion = {
  type: "noul",
  instructions:
    "Does the opening section in `page.opening` directly answer the search query in `top_query` within its first two sentences? `top_query` is the query that brings this page the most Search Console impressions.",
  criteria: {
    true: "The first one or two sentences answer `top_query` clearly and on their own, so a reader or an answer engine could quote them as the answer.",
    false: "The opening does not answer `top_query` in its first two sentences, for example it starts with general introduction or marketing copy, or the answer is buried further down the page.",
  },
};

// ------------------------------------------------------------------ [A23] buyer queries (batched per query)
/** `{q}` is the state path of one query (`queries.q<n>`). */
export const BUYER_QUERY_TEMPLATE: DecisionQuestion = {
  type: "noul",
  instructions:
    "Is the search query in `{q}` typed by someone looking to buy, hire, or compare options before buying, for a searcher in `country` using `language` on a site of type `site_type`? `brand_terms.competitors` lists competing brands.",
  criteria: {
    true: "The wording shows purchase or hiring intent, such as naming a product with a variant, asking for prices, stores, or services, or comparing brands, models, or reviews before a purchase.",
    false: "The wording shows no buying or hiring intent, for example a how-to, a definition, general ideas, care advice, or a search for a specific website, so the searcher is not evaluating a purchase.",
  },
};

export const BUYER_READY_TEMPLATE: DecisionQuestion = {
  type: "noul",
  instructions:
    "Is the search query in `{q}` typed by someone ready to buy, order, or hire now, rather than someone still comparing options, reading reviews, or deciding what to buy?",
  criteria: {
    true: "The searcher wants to purchase, order, book, or hire a specific product or service now, for example a query naming an item with a size or finish, or asking where to buy it.",
    false: "The searcher is still comparing or researching before a purchase, for example asking for the best options, reviews, alternatives, or a comparison between brands or models.",
  },
};

export function buyerQueryQuestion(path: string): DecisionQuestion {
  return fillTemplate(BUYER_QUERY_TEMPLATE, "{q}", path);
}

export function buyerReadyQuestion(path: string): DecisionQuestion {
  return fillTemplate(BUYER_READY_TEMPLATE, "{q}", path);
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

/** Templated questions: keyed ids (`<id>#<key>`) and filled paths version on the canonical template. */
const TEMPLATES: Record<string, DecisionQuestion> = {
  [QUESTION.pageOverlap]: PAGE_OVERLAP_TEMPLATE,
  [QUESTION.queryIntent]: QUERY_INTENT_TEMPLATE,
  [QUESTION.queryRelevance]: QUERY_RELEVANCE_TEMPLATE,
  [QUESTION.thinContent]: THIN_CONTENT_TEMPLATE,
  [QUESTION.coversTopic]: COVERS_TOPIC_TEMPLATE,
  [QUESTION.buyerQuery]: BUYER_QUERY_TEMPLATE,
  [QUESTION.buyerReady]: BUYER_READY_TEMPLATE,
};

/** Base question id without a `#key` suffix. */
export const baseQuestionId = (questionId: string) => questionId.split("#")[0]!;

/** question_version for a question id; templated questions version on the canonical template. */
export async function versionFor(questionId: string, q: DecisionQuestion): Promise<string> {
  const t = TEMPLATES[baseQuestionId(questionId)];
  if (t) return questionVersion(t);
  return questionVersion(q);
}

/** Every static (or template) SEO question, keyed by id: the eval harness and the snapshot test use this. */
export const SEO_STATIC_QUESTIONS: Readonly<Record<string, DecisionQuestion>> = {
  [QUESTION.queryPageRelevance]: QUERY_PAGE_RELEVANCE,
  [QUESTION.queryIntent]: QUERY_INTENT,
  [QUESTION.intentPageFit]: INTENT_PAGE_FIT,
  [QUESTION.actionChoice]: ACTION_CHOICE,
  [QUESTION.issueSeverity]: ISSUE_SEVERITY,
  [QUESTION.pageOverlap]: PAGE_OVERLAP_TEMPLATE,
  [QUESTION.queryRelevance]: QUERY_RELEVANCE_TEMPLATE,
  [QUESTION.thinContent]: THIN_CONTENT_TEMPLATE,
  [QUESTION.pageAction]: PAGE_ACTION,
  [QUESTION.schemaContentMatch]: SCHEMA_CONTENT_MATCH,
  [QUESTION.titleMatchesQuery]: TITLE_MATCHES_QUERY,
  [QUESTION.metaMatchesQuery]: META_MATCHES_QUERY,
  [QUESTION.coversTopic]: COVERS_TOPIC_TEMPLATE,
  [QUESTION.outdatedInformation]: OUTDATED_INFORMATION,
  [QUESTION.answerIsDirect]: ANSWER_IS_DIRECT,
  [QUESTION.buyerQuery]: BUYER_QUERY_TEMPLATE,
  [QUESTION.buyerReady]: BUYER_READY_TEMPLATE,
};

/** Versions of the static questions (snapshot-tested). */
export async function staticQuestionVersions(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [id, q] of Object.entries(SEO_STATIC_QUESTIONS)) out[id] = await versionFor(id, q);
  return out;
}
