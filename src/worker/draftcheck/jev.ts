/**
 * [A23] Draft check: Jev Noul questions for the otherwise-manual/heuristic on-page items and for
 * suspicious excerpts, asked in ONE batched systemOne call.
 *
 * Item questions (Noul; yes = the practice is met):
 *   item_answer_early    -> page.while_write.answer_early
 *   item_topic_coverage  -> page.before_write.topic_coverage
 *   item_unique_angle    -> page.before_write.unique_angle
 *   item_first_hand      -> page.before_write.first_hand
 *   item_terms_entities  -> page.while_write.terms_entities
 *   (2026-10-01, draft-check-only items, src/worker/draftcheck/items.ts)
 *   item_faq_when_useful           -> page.while_write.faq_when_useful
 *   item_compare_table             -> page.while_write.compare_table
 *   item_headings_match_questions  -> page.while_write.headings_match_questions   (>= 2 subheadings)
 *   item_clear_next_step           -> page.while_write.clear_next_step            (full text only)
 *   item_author_credentials        -> page.before_write.author_credentials
 *   item_numbers_sourced           -> page.publish_check.numbers_sourced          (text has numbers)
 *   item_product_facts             -> page.publish_check.product_facts            (product fields given)
 *   item_schema_fit                -> page.publish_check.schema_fit               (JSON-LD types found)
 *   "Answer in the first 40 words" and "internal links present" are measured in code, never asked.
 * At most 13 item questions + MAX_JEV_CANDIDATES (8) excerpt questions = 21 questions in one call (one
 * jev_calls reservation), well under QUESTIONS_PER_CALL_MAX.
 * Excerpt questions (Noul; yes = needs a source the draft does not give): claim_0..claim_7, each over one
 * unsourced sentence that the deterministic rules did not flag.
 *
 * State (deduplicated, capped): { target_query, draft: { title, meta_description, headings (<= 40),
 * opening (<= 600 chars), text (<= 6,000 chars), word_count, page_type, schema_types (<= 10), author,
 * closing (last <= 600 chars; drafts only), table_count, source_count }, product_facts (<= 20 fields),
 * claims: { claim_<n>: { excerpt } } }.
 * Questions reference state by path. Questions whose inputs are absent are omitted (no opening -> no
 * answer_early question; no claims -> no claim questions).
 *
 * Tiering: runs/policy.tierFor per question id (Noul probability bands; no confidence field).
 *   act + yes -> met (items) / flag (excerpts); act + no -> not_met (items) / nothing (excerpts);
 *   flag -> partial with "Check this yourself" (items) / flag when leaning yes (excerpts);
 *   drop or missing -> the Jev value is withheld and the deterministic result stands.
 * Budget: the DecisionProvider reserves provider_calls + jev_calls (providers/typesafe.ts). A
 * BudgetExceededError or any call failure leaves the check deterministic (labelled). Every question
 * asked or skipped gets a decision_records row (agent 'seo', candidate_key 'draftcheck:<hash>',
 * question_version, POLICY_VERSION, raw answer).
 */
import type { Tier } from "@shared/types";
import type { Db } from "../lib/db";
import { BudgetExceededError } from "../lib/errors";
import { hashJson } from "../lib/hash";
import { newId } from "../lib/ids";
import { iso, type Clock } from "../lib/time";
import type { DecisionAnswer, DecisionProvider, DecisionQuestion, DecisionResult } from "../providers/types";
import { POLICY_VERSION, questionVersion, tierFor } from "../runs/policy";

export const DRAFTCHECK_QUESTIONS_REVISION = "draftcheck-questions-2026-10-01.1";
/** Upper bound on questions in the single draft-check call (13 items + 8 excerpts = 21). */
export const QUESTIONS_PER_CALL_MAX = 30;
export const DRAFTCHECK_PURPOSE = "seo.draft_check";
export const STATE_CAPS = { text: 6000, opening: 600, closing: 600, headings: 40, heading: 200, title: 300, meta: 500, excerpt: 300, query: 200, author: 150, schemaTypes: 10, schemaType: 60, facts: 20, factKey: 60, factValue: 300 } as const;

export type ItemQuestionKey =
  | "answer_early"
  | "topic_coverage"
  | "unique_angle"
  | "first_hand"
  | "terms_entities"
  | "faq_when_useful"
  | "compare_table"
  | "headings_match_questions"
  | "clear_next_step"
  | "author_credentials"
  | "numbers_sourced"
  | "product_facts"
  | "schema_fit";

export const ITEM_QUESTIONS: Record<ItemQuestionKey, { itemId: string; questionId: string; question: DecisionQuestion }> = {
  answer_early: {
    itemId: "page.while_write.answer_early",
    questionId: "seo.draft.answer_early",
    question: {
      type: "noul",
      instructions:
        "Does the opening paragraph `draft.opening` directly answer the main question behind the search query `target_query`? Judge only the opening paragraph, using `draft.title` and `draft.headings` for context.",
      criteria: {
        true: "Yes. The opening paragraph gives a direct, specific answer to what someone searching `target_query` wants to know, so a reader gets the core answer without reading further.",
        false: "No. The opening only introduces the topic, restates the question, tells a story, or delays the answer, so a reader must keep reading to find what they searched for.",
      },
    },
  },
  topic_coverage: {
    itemId: "page.before_write.topic_coverage",
    questionId: "seo.draft.topic_coverage",
    question: {
      type: "noul",
      instructions:
        "Does the draft (`draft.headings` and `draft.text`) cover the subtopics that someone searching `target_query` would expect, with sections that actually answer them? Judge coverage of the topic, not length.",
      criteria: {
        true: "Yes. The draft addresses the main subtopics and follow-up questions a searcher for `target_query` would expect, each with a substantive answer rather than a passing mention.",
        false: "No. Important subtopics or follow-up questions for `target_query` are missing or only mentioned in passing, so a searcher would need another page to complete the picture.",
      },
    },
  },
  unique_angle: {
    itemId: "page.before_write.unique_angle",
    questionId: "seo.draft.unique_angle",
    question: {
      type: "noul",
      instructions:
        "Does the draft (`draft.text`) contain original information or a distinct angle on `target_query`, such as the author's own data, measurements, tests, worked examples, photos described in the text, or a clearly argued point of view?",
      criteria: {
        true: "Yes. The draft includes specific information or a perspective that is its own (for example its own measurements, examples, or a reasoned recommendation), not only statements that could be copied from many other pages.",
        false: "No. The draft only restates generic information that is widely available, with no own data, examples, or distinct point of view.",
      },
    },
  },
  first_hand: {
    itemId: "page.before_write.first_hand",
    questionId: "seo.draft.first_hand",
    question: {
      type: "noul",
      instructions:
        "Does the draft (`draft.text`) show first-hand experience with the subject of `target_query`, describing what the author or business actually did, used, tested, installed, or observed, with concrete details?",
      criteria: {
        true: "Yes. The draft describes real use or testing in concrete terms (what was done, how, and what happened), in a way that only someone with direct experience could write.",
        false: "No. The draft speaks only in general terms, with no description of anything the author actually did, used, tested, or observed.",
      },
    },
  },
  terms_entities: {
    itemId: "page.while_write.terms_entities",
    questionId: "seo.draft.terms_entities",
    question: {
      type: "noul",
      instructions:
        "Does the draft (`draft.title`, `draft.headings`, and `draft.text`) naturally use the specific terms and named entities (products, materials, standards, places, brands, measurements) that someone searching `target_query` would expect, without repeating the query unnaturally?",
      criteria: {
        true: "Yes. The draft uses the relevant specific terms and entities where they fit, in natural sentences, and does not stuff or repeat the query.",
        false: "No. The draft relies on vague wording and misses the specific terms and entities a searcher would expect, or it repeats the query unnaturally.",
      },
    },
  },
  faq_when_useful: {
    itemId: "page.while_write.faq_when_useful",
    questionId: "seo.draft.faq_when_useful",
    question: {
      type: "noul",
      instructions:
        "Is the FAQ practice met for this draft: where people searching `target_query` commonly have follow-up questions, does the draft (`draft.headings` and `draft.text`) answer them in a question-and-answer form? Answer yes when the topic has no common follow-up questions.",
      criteria: {
        true: "Yes. The draft answers the common follow-up questions about `target_query` in an FAQ or question-led sections, or the topic has no common follow-up questions so an FAQ would add nothing.",
        false: "No. Searchers for `target_query` commonly have follow-up questions that the draft does not answer in a question-and-answer form.",
      },
    },
  },
  compare_table: {
    itemId: "page.while_write.compare_table",
    questionId: "seo.draft.compare_table",
    question: {
      type: "noul",
      instructions:
        "Is the comparison-table practice met: where the draft (`draft.text`) compares two or more products, materials, or options, does it present that comparison in a table (`draft.table_count` tables found)? Answer yes when the draft does not compare options.",
      criteria: {
        true: "Yes. The draft's comparisons are laid out in a table with the same attributes for each option, or the draft does not compare options at all.",
        false: "No. The draft compares options in running text only, so a reader cannot see the differences side by side.",
      },
    },
  },
  headings_match_questions: {
    itemId: "page.while_write.headings_match_questions",
    questionId: "seo.draft.headings_match_questions",
    question: {
      type: "noul",
      instructions:
        "Do the subheadings in `draft.headings` match the questions and subtopics that someone searching `target_query` has, so a reader scanning only the headings finds where each of their questions is answered?",
      criteria: {
        true: "Yes. The subheadings name the reader's questions or subtopics in plain, specific words, and each one leads into the answer to it.",
        false: "No. The subheadings are vague, clever, or generic (such as 'Introduction' or 'More info'), or they do not correspond to what a searcher for `target_query` wants to know.",
      },
    },
  },
  clear_next_step: {
    itemId: "page.while_write.clear_next_step",
    questionId: "seo.draft.clear_next_step",
    question: {
      type: "noul",
      instructions:
        "Does the draft give the reader a clear next step, such as buying, booking, contacting, or reading a specific next guide? Use `draft.closing` (the end of the draft) and `draft.text`.",
      criteria: {
        true: "Yes. The draft tells the reader plainly what to do next and how (for example a named product, a contact route, or a specific next page).",
        false: "No. The draft ends without telling the reader what to do next, or the next step is vague (such as 'learn more') with no clear action.",
      },
    },
  },
  author_credentials: {
    itemId: "page.before_write.author_credentials",
    questionId: "seo.draft.author_credentials",
    question: {
      type: "noul",
      instructions:
        "Does the draft name an author or reviewer (`draft.author`, or a byline in `draft.text`) and state experience or credentials that are relevant to `target_query`?",
      criteria: {
        true: "Yes. A named author or reviewer is given together with relevant experience, role, or credentials on this topic.",
        false: "No. No author or reviewer is named, or one is named without any relevant experience or credentials.",
      },
    },
  },
  numbers_sourced: {
    itemId: "page.publish_check.numbers_sourced",
    questionId: "seo.draft.numbers_sourced",
    question: {
      type: "noul",
      instructions:
        "Are the specific numbers in `draft.text` (statistics, prices, measurements, percentages, dates of findings) each attributed to a source, the business's own data, or a described measurement? `draft.source_count` counts the outbound source links found.",
      criteria: {
        true: "Yes. Each specific number is attributed: a named or linked source, the business's own records, or a measurement the draft describes. Plain product specifications count as attributed to the business.",
        false: "No. At least one statistic or comparative number is stated without saying where it comes from.",
      },
    },
  },
  product_facts: {
    itemId: "page.publish_check.product_facts",
    questionId: "seo.draft.product_facts",
    question: {
      type: "noul",
      instructions:
        "Are the product facts stated in `draft.text` (price, dimensions, materials, finish, availability, and similar) consistent with the provided product fields in `product_facts`? Judge only facts that appear in both.",
      criteria: {
        true: "Yes. Every product fact in the draft that is also in `product_facts` matches it, and the draft states no product fact that contradicts the fields.",
        false: "No. At least one product fact in the draft contradicts `product_facts` (for example a different price, size, or material).",
      },
    },
  },
  schema_fit: {
    itemId: "page.publish_check.schema_fit",
    questionId: "seo.draft.schema_fit",
    question: {
      type: "noul",
      instructions:
        "Do the structured data types in `draft.schema_types` fit a page of type `draft.page_type` with this content (`draft.title`, `draft.headings`)? For example Product fits a product page and Article fits an article.",
      criteria: {
        true: "Yes. The main structured data type describes what the page actually is, and no type claims content the page does not have.",
        false: "No. The main type does not match the page (for example Article on a product page, or Product on a guide), or a type claims content the page does not show (such as reviews or an FAQ that are not on the page).",
      },
    },
  },
};

export const CLAIM_QUESTION_ID = "seo.draft.claim_needs_source";

export function buildClaimQuestion(key: string): DecisionQuestion {
  return {
    type: "noul",
    instructions: `Is \`claims.${key}.excerpt\` a claim that needs a source or evidence that the draft (\`draft.text\`) does not provide?`,
    criteria: {
      true: "Yes. The excerpt states a fact, statistic, comparison, superlative, testimonial, or guarantee that a careful reader would expect to be backed by a source, data, or named evidence, and the draft does not provide it.",
      false: "No. The excerpt is an opinion clearly framed as one, a plain description, or common knowledge, or it is backed by a source, data, or evidence that the draft provides.",
    },
  };
}

/** Templates used for question_version (the claim question with a placeholder key). */
export const DRAFTCHECK_QUESTION_TEMPLATES: Record<string, DecisionQuestion> = {
  ...Object.fromEntries(Object.values(ITEM_QUESTIONS).map((q) => [q.questionId, q.question])),
  [CLAIM_QUESTION_ID]: buildClaimQuestion("claim_<n>"),
};

export async function draftQuestionVersions(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [id, q] of Object.entries(DRAFTCHECK_QUESTION_TEMPLATES)) out[id] = await questionVersion(q);
  return out;
}

/** Text for Jev state: no control characters, backticks, or double quotes; collapsed; capped. */
export function sanitizeForState(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const t = text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/[`"“”]/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface DraftJevInput {
  targetQuery: string;
  /** Page type the text is evaluated as (drafts default to article). */
  pageType?: string | null;
  /** JSON-LD @type values found (HTML drafts and crawled pages). */
  schemaTypes?: string[];
  author?: string | null;
  /** True when the whole text is available (the end of the text is then sent as `closing`). */
  fullText?: boolean;
  tableCount?: number;
  sourceCount?: number;
  /** Provided product fields (name -> value) to compare the text against. */
  productFacts?: Record<string, string> | null;
  title: string | null;
  metaDescription: string | null;
  headings: Array<{ level: number; text: string }>;
  opening: string | null;
  text: string;
  wordCount: number;
  claims: string[];
}

export interface JevItemAnswer {
  key: ItemQuestionKey;
  itemId: string;
  questionId: string;
  noul: number | null;
  tier: Tier | null;
}

export interface JevClaimAnswer {
  excerpt: string;
  noul: number | null;
  tier: Tier | null;
}

export interface DraftJevRun {
  status: "answered" | "budget" | "error";
  items: JevItemAnswer[];
  claims: JevClaimAnswer[];
  asked: number;
  answered: number;
  provider: string | null;
  model: string | null;
}

export interface DraftJevDeps {
  decisions: DecisionProvider;
  db: Db;
  workspaceId: string;
  projectId: string;
  candidateKey: string;
  clock: Clock;
}

export function buildJevState(input: DraftJevInput) {
  const claims: Record<string, { excerpt: string }> = {};
  input.claims.forEach((c, i) => {
    const e = sanitizeForState(c, STATE_CAPS.excerpt);
    if (e) claims[`claim_${i}`] = { excerpt: e };
  });
  const facts: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.productFacts ?? {}).slice(0, STATE_CAPS.facts)) {
    const key = sanitizeForState(k, STATE_CAPS.factKey);
    const value = sanitizeForState(v, STATE_CAPS.factValue);
    if (key && value) facts[key] = value;
  }
  // The end of the full text (pasted drafts only: a crawled page's stored excerpt stops at 2,000 characters).
  const full = input.fullText ? (sanitizeForState(input.text, Number.MAX_SAFE_INTEGER) ?? "") : "";
  return {
    target_query: sanitizeForState(input.targetQuery, STATE_CAPS.query) ?? "",
    draft: {
      title: sanitizeForState(input.title, STATE_CAPS.title),
      meta_description: sanitizeForState(input.metaDescription, STATE_CAPS.meta),
      headings: input.headings.slice(0, STATE_CAPS.headings).map((h) => `h${h.level}: ${sanitizeForState(h.text, STATE_CAPS.heading) ?? ""}`),
      opening: sanitizeForState(input.opening, STATE_CAPS.opening),
      text: sanitizeForState(input.text, STATE_CAPS.text) ?? "",
      word_count: input.wordCount,
      page_type: sanitizeForState(input.pageType ?? null, 40),
      schema_types: (input.schemaTypes ?? []).map((t) => sanitizeForState(t, STATE_CAPS.schemaType)).filter((t): t is string => !!t).slice(0, STATE_CAPS.schemaTypes),
      author: sanitizeForState(input.author ?? null, STATE_CAPS.author),
      closing: full ? (full.length > STATE_CAPS.closing ? `…${full.slice(-(STATE_CAPS.closing - 1)).trimStart()}` : full) : null,
      table_count: input.tableCount ?? 0,
      source_count: input.sourceCount ?? 0,
    },
    product_facts: facts,
    claims,
  };
}

const noulOf = (a: DecisionAnswer | undefined): number | null => (a && a.type === "noul" && Number.isFinite(a.noul) ? a.noul : null);

/** Whether a question's inputs exist in the state (questions over absent inputs are not asked). Pure. */
export function hasInputs(key: ItemQuestionKey, state: ReturnType<typeof buildJevState>): boolean {
  switch (key) {
    case "answer_early":
      return !!state.draft.opening;
    case "headings_match_questions":
      return state.draft.headings.filter((h) => !h.startsWith("h1:")).length >= 2;
    case "clear_next_step":
      return !!state.draft.closing;
    case "numbers_sourced":
      return /\d/.test(state.draft.text);
    case "product_facts":
      return Object.keys(state.product_facts).length > 0;
    case "schema_fit":
      return state.draft.schema_types.length > 0 && !!state.draft.page_type;
    default:
      return true;
  }
}

/** Ask all item + claim questions in one call and record every question in decision_records. */
export async function askDraftJev(input: DraftJevInput, deps: DraftJevDeps): Promise<DraftJevRun> {
  const state = buildJevState(input);
  const questions: Record<string, DecisionQuestion> = {};
  const itemKeys: ItemQuestionKey[] = [];
  for (const key of Object.keys(ITEM_QUESTIONS) as ItemQuestionKey[]) {
    if (!state.draft.text || !hasInputs(key, state)) continue; // absent input: do not ask
    questions[`item_${key}`] = ITEM_QUESTIONS[key].question;
    itemKeys.push(key);
  }
  const claimKeys = Object.keys(state.claims);
  for (const k of claimKeys) questions[k] = buildClaimQuestion(k);

  const versions = await draftQuestionVersions();
  const stateHash = await hashJson(state);
  let res: DecisionResult | null = null;
  let status: DraftJevRun["status"] = "answered";
  if (Object.keys(questions).length > 0) {
    try {
      res = await deps.decisions.decide({ purpose: DRAFTCHECK_PURPOSE, state, questions });
    } catch (e) {
      status = e instanceof BudgetExceededError ? "budget" : "error";
    }
  }

  const items: JevItemAnswer[] = [];
  const claims: JevClaimAnswer[] = [];
  const now = iso(deps.clock());
  const stmts: Array<[string, ...unknown[]]> = [];
  const record = (questionId: string, key: string, answer: DecisionAnswer | undefined, tier: Tier | null, outcome: "selected" | "rejected", reason: string | null) => {
    stmts.push([
      `INSERT INTO decision_records (id, workspace_id, project_id, run_id, agent, candidate_key, question_id, question_version, policy_version, provider, model, state_hash, answer_json, tier, outcome, reason_code, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId("dec"), deps.workspaceId, deps.projectId, null, "seo", deps.candidateKey, questionId, versions[questionId] ?? null, POLICY_VERSION,
      res?.provider ?? deps.decisions.name, res?.model ?? null, stateHash,
      JSON.stringify({ answer: answer ?? null, question: key, revision: DRAFTCHECK_QUESTIONS_REVISION, ...(key.startsWith("claim_") ? { excerpt: state.claims[key]?.excerpt ?? null } : {}) }),
      tier, outcome, reason,
      now,
    ]);
  };
  const skippedReason = status === "budget" ? "budget" : "decision_unavailable";

  let answered = 0;
  for (const key of itemKeys) {
    const q = ITEM_QUESTIONS[key];
    const answer = res?.answers[`item_${key}`];
    const noul = noulOf(answer);
    if (!res || noul === null) {
      items.push({ key, itemId: q.itemId, questionId: q.questionId, noul: null, tier: null });
      record(q.questionId, `item_${key}`, answer, res ? "drop" : null, "rejected", res ? "decision_unavailable" : skippedReason);
      continue;
    }
    answered++;
    const tier = tierFor(q.questionId, answer);
    items.push({ key, itemId: q.itemId, questionId: q.questionId, noul, tier });
    record(q.questionId, `item_${key}`, answer, tier, tier === "drop" ? "rejected" : "selected", tier === "drop" ? "insufficient_evidence" : null);
  }
  for (const k of claimKeys) {
    const answer = res?.answers[k];
    const noul = noulOf(answer);
    const excerpt = input.claims[Number(k.slice("claim_".length))] ?? state.claims[k]!.excerpt;
    if (!res || noul === null) {
      claims.push({ excerpt, noul: null, tier: null });
      record(CLAIM_QUESTION_ID, k, answer, res ? "drop" : null, "rejected", res ? "decision_unavailable" : skippedReason);
      continue;
    }
    answered++;
    const tier = tierFor(CLAIM_QUESTION_ID, answer);
    claims.push({ excerpt, noul, tier });
    const flagged = tier !== "drop" && noul >= 0.5;
    record(CLAIM_QUESTION_ID, k, answer, tier, flagged ? "selected" : "rejected", flagged ? null : tier === "drop" ? "insufficient_evidence" : "low_fit");
  }
  if (stmts.length) await deps.db.batch(stmts);

  return {
    status: res ? "answered" : status === "answered" ? "answered" : status,
    items,
    claims,
    asked: Object.keys(questions).length,
    answered,
    provider: res?.provider ?? null,
    model: res?.model ?? null,
  };
}
