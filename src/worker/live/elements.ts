/**
 * Live view (docs/live-view-design.md section 6): THE map from stored judgments to SEO elements and
 * keep / change / review verdicts. Pure (no DB, no provider): the live SEO feed (GET /live/seo) and its
 * tests use it.
 *
 * Rules:
 * - The verdict is computed by code from the STORED tier (the policy's tier when Jev answered) and the raw
 *   stored answer, plus a per-question polarity. Jev never supplies verdict text and nothing is re-asked.
 *   Noul: act tier = confident yes (noul >= 0.5) or confident no; flag/drop = review. Choice: act tier =
 *   the option's mapped verdict; flag/drop = review. Noul has no confidence field.
 * - Audit findings (deterministic rules of the run's crawl) become rule rows: class fact = change,
 *   heuristic = review. Rules not listed here produce no element row (e.g. AI crawler access, which is a
 *   site setting shown on the GEO checklist).
 * - Questions not listed here (relevance gates, severity, pillar fit) produce no element row; they still
 *   count in the pipeline totals.
 * - Demo fixtures (src/worker/demo/seed.ts) store bare Choice answers with fixture options; they are mapped
 *   under DEMO_ACTION_OPTIONS so the labelled demo replay fills the panel.
 *
 * What "keep" means per question (keep = the stored answer says no change is needed for that element):
 *   title_matches_query, meta_matches_query  confident yes: the snippet already matches the page's top query
 *   answer_is_direct                         confident yes: the opening already answers the top query
 *   schema_content_match                     confident yes: structured data matches the visible content
 *   covers_topic#t<n>                        confident yes: the page already covers the topic
 *   outdated_information                     confident NO: nothing on the page is out of date
 *   thin_content#e<n>                        confident NO: the page is not thin
 *   page_overlap#<k>                         confident NO: the pages do not compete
 *   intent_page_fit                          option fits
 *   page_action                              option keep
 *   action_choice                            option no_action (demo fixture: none)
 * A confident answer the other way is "change"; a flag tier, a drop tier (no usable answer), an n/a tier or
 * an unmapped option is "review", never keep. The decision OUTCOME (selected / rejected with budget,
 * duplicate, low_fit, ...) is a pipeline result about the candidate, not about the element, so it never
 * changes the verdict. A candidate whose judgment is not stored yet produces no row at all: the feed only
 * returns stored rows (the client shows its own "waiting for the next stored judgment" placeholders).
 */
import type { LiveQueryQuestion, LiveSeoElement, LiveSeoVerdict, Tier } from "@shared/types";
import { QUESTION } from "../seo/questions";

export const LIVE_ELEMENTS_VERSION = "live-elements-2026-10-01.1";

type Verdict = LiveSeoVerdict;
interface OptionSpec {
  verdict: Verdict;
  element?: LiveSeoElement;
}
export interface NoulElementSpec {
  type: "noul";
  role: "element";
  element: LiveSeoElement;
  /** Verdict of a confident yes; a confident no gives the other one. */
  yes: "keep" | "change";
}
export interface ChoiceElementSpec {
  type: "choice";
  role: "element" | "action";
  element: LiveSeoElement;
  options: Readonly<Record<string, OptionSpec>>;
  /** Unknown option (or a fixture option not listed): review, never a guess. */
  otherwise: OptionSpec;
}
export type ElementSpec = NoulElementSpec | ChoiceElementSpec;

/** seo.action_choice options (seo/questions.ts ACTION_CHOICE_OPTIONS) -> element and verdict. */
const ACTION_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  rewrite_title_meta: { element: "Title + meta", verdict: "change" },
  improve_intro_answer: { element: "Intro", verdict: "change" },
  add_section: { element: "Section", verdict: "change" },
  add_comparison_or_spec_table: { element: "Compare table", verdict: "change" },
  add_internal_links: { element: "Links", verdict: "change" },
  fix_structured_data: { element: "Schema", verdict: "change" },
  fix_canonical_or_indexing: { element: "Canonical", verdict: "change" },
  consolidate_duplicate: { element: "Duplicate", verdict: "change" },
  new_page_candidate: { element: "New page", verdict: "change" },
  no_action: { element: "Page", verdict: "keep" },
};

/** Options used only by the labelled demo fixtures (demo/seed.ts). */
export const DEMO_ACTION_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  add_offer_markup: { element: "Schema", verdict: "change" },
  rewrite_snippet: { element: "Title + meta", verdict: "change" },
  add_intro: { element: "Intro", verdict: "change" },
  none: { element: "Page", verdict: "keep" },
  insufficient_context: { element: "Page", verdict: "review" },
};

/**
 * The ONE exported mapping (described in docs/live-view-design.md section 6). Keys of `questions` are base
 * question ids (decision_records.question_id); keyed variants (`seo.covers_topic#t2`,
 * `seo.thin_content#e1`, `seo.page_overlap#<k>`) are stored under their base id.
 */
export const LIVE_SEO_ELEMENT_MAP = {
  version: LIVE_ELEMENTS_VERSION,
  questions: {
    [QUESTION.titleMatchesQuery]: { type: "noul", role: "element", element: "Title", yes: "keep" },
    [QUESTION.metaMatchesQuery]: { type: "noul", role: "element", element: "Meta", yes: "keep" },
    [QUESTION.answerIsDirect]: { type: "noul", role: "element", element: "Intro", yes: "keep" },
    [QUESTION.schemaContentMatch]: { type: "noul", role: "element", element: "Schema", yes: "keep" },
    [QUESTION.coversTopic]: { type: "noul", role: "element", element: "Topics", yes: "keep" },
    [QUESTION.outdatedInformation]: { type: "noul", role: "element", element: "Freshness", yes: "change" },
    [QUESTION.thinContent]: { type: "noul", role: "element", element: "Content", yes: "change" },
    [QUESTION.pageOverlap]: { type: "noul", role: "element", element: "Duplicate", yes: "change" },
    [QUESTION.intentPageFit]: {
      type: "choice",
      role: "element",
      element: "Intent",
      options: {
        fits: { verdict: "keep" },
        partial_fit: { verdict: "review" },
        mismatch: { verdict: "change" },
        insufficient_context: { verdict: "review" },
      },
      otherwise: { verdict: "review" },
    },
    [QUESTION.pageAction]: {
      type: "choice",
      role: "element",
      element: "Page",
      options: {
        keep: { verdict: "keep" },
        update: { verdict: "change" },
        merge: { verdict: "change" },
        remove: { verdict: "change" },
        insufficient_context: { verdict: "review" },
      },
      otherwise: { verdict: "review" },
    },
    [QUESTION.actionChoice]: {
      type: "choice",
      role: "action",
      element: "Page",
      options: { ...ACTION_OPTIONS, ...DEMO_ACTION_OPTIONS },
      otherwise: { element: "Page", verdict: "review" },
    },
  } as Readonly<Record<string, ElementSpec>>,
  /**
   * Decision rows without a question that reused an internal link suggestion: answer_json carries
   * `linkSuggestionId` and `kind` "internal_link" (the candidate kind recommend/candidates.ts stores for
   * suggestion candidates; "internal_link_suggestion" is accepted too), plus the suggester's stored Noul
   * (links should-exist) and tier.
   */
  linkSuggestion: { kinds: ["internal_link", "internal_link_suggestion"] as readonly string[], element: "Links" as LiveSeoElement, questionId: "links.should_exist" },
  /** Audit rule id -> element (seo/rules/registry.ts, sitemap-health.ts). */
  rules: {
    "SEO-TITLE-MISSING": "Title",
    "SEO-TITLE-DUPLICATE": "Title",
    "SEO-META-DESC-MISSING": "Meta",
    "SEO-META-DESC-DUPLICATE": "Meta",
    "SEO-H1-MISSING": "H1",
    "SEO-H1-MULTIPLE": "H1",
    "SEO-HEADING-SKIP": "Headings",
    "SEO-CANONICAL-MISSING": "Canonical",
    "SEO-CANONICAL-OFFHOST": "Canonical",
    "SEO-CANONICAL-TARGET-BAD": "Canonical",
    "ECOM-FACETED-NO-CANONICAL": "Canonical",
    "ECOM-VARIANT-NO-CANONICAL": "Canonical",
    "SEO-NOINDEX": "Indexing",
    "SEO-ROBOTS-SITEMAP-CONFLICT": "Indexing",
    "SEO-STATUS-4XX": "Status",
    "SEO-STATUS-5XX": "Status",
    "SEO-LINK-BROKEN-INTERNAL": "Links",
    "SEO-CONTENT-THIN": "Content",
    "SEO-CONTENT-DUPLICATE": "Duplicate",
    "SEO-JSONLD-INVALID": "Schema",
    "ECOM-PRODUCT-JSONLD-MISSING": "Schema",
    "ECOM-PRODUCT-OFFER-INCOMPLETE": "Schema",
    "ECOM-COLLECTION-NO-INTRO": "Intro",
    "SEO-SITEMAP-URL-ERROR": "Sitemap",
    "SEO-SITEMAP-URL-REDIRECT": "Sitemap",
    "SEO-SITEMAP-URL-NOINDEX": "Sitemap",
    "SEO-SITEMAP-URL-NONCANONICAL": "Sitemap",
    "SEO-SITEMAP-LASTMOD-INVALID": "Sitemap",
    "SEO-SITEMAP-OFFHOST": "Sitemap",
  } as Readonly<Record<string, LiveSeoElement>>,
  /** Questions about one search query (panel "Queries classified by Jev"), not about a page element. */
  queryQuestions: [QUESTION.queryRelevance, QUESTION.buyerQuery, QUESTION.buyerReady, QUESTION.queryIntent] as readonly LiveQueryQuestion[],
} as const;

// ------------------------------------------------------------------ stored answer parsing

export interface StoredAnswer {
  type: "noul" | "choice" | "score";
  noul: number | null;
  choice: string | null;
  confidence: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The raw answer of a decision row: `answer_json` is `{answer, candidate, questionTier, key?}` for agent
 * runs, `{answer, query, questionTier}` for query batches, and a bare answer in demo fixtures.
 */
export function storedAnswer(answerJson: unknown): StoredAnswer | null {
  if (!answerJson || typeof answerJson !== "object") return null;
  const o = answerJson as Record<string, unknown>;
  const a = (typeof o.type === "string" ? o : o.answer) as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== "object") return null;
  if (a.type === "noul") {
    const n = num(a.noul);
    return n === null ? null : { type: "noul", noul: n, choice: null, confidence: null };
  }
  if (a.type === "choice") {
    return typeof a.choice === "string" ? { type: "choice", noul: null, choice: a.choice, confidence: num(a.confidence) } : null;
  }
  if (a.type === "score") return { type: "score", noul: null, choice: null, confidence: num(a.confidence) };
  return null;
}

const fmt = (n: number) => n.toFixed(2);
const opposite = (v: "keep" | "change"): "keep" | "change" => (v === "keep" ? "change" : "keep");

export interface ElementJudgment {
  role: "element" | "action";
  element: LiveSeoElement;
  verdict: Verdict;
  basis: string;
  answer: StoredAnswer | null;
}

/** Element and verdict of one stored decision row; null when the question is not an element question. */
export function judgeElement(questionId: string | null, answerJson: unknown, tier: Tier | null): ElementJudgment | null {
  if (!questionId) return null;
  const spec = LIVE_SEO_ELEMENT_MAP.questions[questionId.split("#")[0]!];
  if (!spec) return null;
  const answer = storedAnswer(answerJson);
  const unusable = !answer || tier === null || tier === "drop" || tier === "n/a";
  if (spec.type === "noul") {
    if (unusable || answer.type !== "noul" || answer.noul === null) {
      return { role: spec.role, element: spec.element, verdict: "review", basis: "No usable answer stored (drop tier)", answer };
    }
    if (tier === "flag") return { role: spec.role, element: spec.element, verdict: "review", basis: `Noul ${fmt(answer.noul)}, flag tier: unsure`, answer };
    const yes = answer.noul >= 0.5;
    return {
      role: spec.role,
      element: spec.element,
      verdict: yes ? spec.yes : opposite(spec.yes),
      basis: `Noul ${fmt(answer.noul)}, act tier: confident ${yes ? "yes" : "no"}`,
      answer,
    };
  }
  const opt = answer?.type === "choice" && answer.choice !== null ? (spec.options[answer.choice] ?? null) : null;
  const element = opt?.element ?? spec.otherwise.element ?? spec.element;
  if (unusable || answer.type !== "choice" || answer.choice === null) {
    return { role: spec.role, element, verdict: "review", basis: "No usable answer stored (drop tier)", answer };
  }
  const conf = answer.confidence === null ? "" : ` (confidence ${fmt(answer.confidence)})`;
  if (!opt) return { role: spec.role, element, verdict: spec.otherwise.verdict, basis: `Choice "${answer.choice}"${conf}: option not mapped`, answer };
  if (tier === "flag") return { role: spec.role, element, verdict: "review", basis: `Choice "${answer.choice}"${conf}, flag tier: unsure`, answer };
  return { role: spec.role, element, verdict: opt.verdict, basis: `Choice "${answer.choice}"${conf}, act tier`, answer };
}

/** A question-less decision row that reused an internal link suggestion; null for any other row. */
export function judgeLinkSuggestion(answerJson: unknown): { element: LiveSeoElement; verdict: Verdict; basis: string; noul: number | null; tier: Tier | null; linkSuggestionId: string } | null {
  if (!answerJson || typeof answerJson !== "object") return null;
  const o = answerJson as Record<string, unknown>;
  if (typeof o.kind !== "string" || !LIVE_SEO_ELEMENT_MAP.linkSuggestion.kinds.includes(o.kind) || typeof o.linkSuggestionId !== "string") return null;
  const tier = o.suggestionTier === "act" || o.suggestionTier === "flag" || o.suggestionTier === "drop" || o.suggestionTier === "n/a" ? o.suggestionTier : null;
  const noul = num(o.shouldExist);
  const verdict: Verdict = tier === "act" ? "change" : "review";
  const basis = `Link suggestion, ${tier ?? "no"} tier${noul === null ? "" : `, should-exist Noul ${fmt(noul)}`}`;
  return { element: LIVE_SEO_ELEMENT_MAP.linkSuggestion.element, verdict, basis, noul, tier, linkSuggestionId: o.linkSuggestionId };
}

/** Element and verdict of one audit finding; null when the rule is not a page element. */
export function judgeRule(ruleId: string, ruleClass: "fact" | "heuristic"): { element: LiveSeoElement; verdict: Verdict; basis: string } | null {
  const element = LIVE_SEO_ELEMENT_MAP.rules[ruleId];
  if (!element) return null;
  return ruleClass === "fact" ? { element, verdict: "change", basis: "Rule (fact)" } : { element, verdict: "review", basis: "Rule (heuristic)" };
}

/** Base question ids of element rows (role element), action rows (role action) and query rows. */
export const ELEMENT_QUESTION_IDS: readonly string[] = Object.entries(LIVE_SEO_ELEMENT_MAP.questions)
  .filter(([, s]) => s.role === "element")
  .map(([id]) => id);
export const ACTION_QUESTION_IDS: readonly string[] = Object.entries(LIVE_SEO_ELEMENT_MAP.questions)
  .filter(([, s]) => s.role === "action")
  .map(([id]) => id);
export const QUERY_QUESTION_IDS: readonly string[] = LIVE_SEO_ELEMENT_MAP.queryQuestions;
/** Rule ids that become rule rows. */
export const ELEMENT_RULE_IDS: readonly string[] = Object.keys(LIVE_SEO_ELEMENT_MAP.rules);

/**
 * Elements a drafted snippet can be shown against when the candidate's action maps to `actionElement`:
 * "Title + meta" covers Title and Meta rows; any other element covers only itself.
 */
export function actionFamily(actionElement: LiveSeoElement): readonly LiveSeoElement[] {
  return actionElement === "Title + meta" ? ["Title + meta", "Title", "Meta"] : [actionElement];
}

export function isQueryQuestion(questionId: string | null): questionId is LiveQueryQuestion {
  return !!questionId && (LIVE_SEO_ELEMENT_MAP.queryQuestions as readonly string[]).includes(questionId);
}

/** Noul band of a query answer under the stored tier: act -> yes/no, flag -> middle; null otherwise. */
export function queryBand(answer: StoredAnswer | null, tier: Tier | null): "yes" | "no" | "middle" | null {
  if (!answer || answer.type !== "noul" || answer.noul === null) return null;
  if (tier === "act") return answer.noul >= 0.5 ? "yes" : "no";
  if (tier === "flag") return "middle";
  return null;
}

/** Candidate kinds whose readable key (seo/recommend/candidates.ts) starts with the query. */
const QUERY_FIRST_KINDS = new Set(["striking_distance", "query_page_mismatch", "engine_query"]);

/**
 * URL and query recoverable from a readable candidate key (`answer_json.candidate`, e.g.
 * `striking_distance:<query>|<url>`, `weak_ctr:<url>`, `technical:<rule>|<url>`). Never guesses: the URL is
 * the first `|` segment that parses as http(s); the query only for kinds whose key starts with it.
 * Note: recommend/candidates.ts writes that query segment with text.ts `queryKey` (sorted, de-duplicated
 * tokens without stopwords), not the text the searcher typed, so the live feed never displays it as a query.
 */
export function parseCandidateKey(readable: string | null | undefined): { kind: string | null; url: string | null; query: string | null } {
  if (!readable) return { kind: null, url: null, query: null };
  const i = readable.indexOf(":");
  if (i <= 0) return { kind: null, url: null, query: null };
  const kind = readable.slice(0, i);
  const parts = readable.slice(i + 1).split("|");
  let url: string | null = null;
  for (const p of parts) {
    try {
      const u = new URL(p);
      if (u.protocol === "http:" || u.protocol === "https:") {
        url = p;
        break;
      }
    } catch {
      // not a URL segment
    }
  }
  const first = parts[0] ?? "";
  const query = QUERY_FIRST_KINDS.has(kind) && first && first !== url ? first : null;
  return { kind, url, query };
}
