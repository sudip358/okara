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
 * Excerpt questions (Noul; yes = needs a source the draft does not give): claim_0..claim_7, each over one
 * unsourced sentence that the deterministic rules did not flag.
 *
 * State (deduplicated, capped): { target_query, draft: { title, meta_description, headings (<= 40),
 * opening (<= 600 chars), text (<= 6,000 chars), word_count }, claims: { claim_<n>: { excerpt } } }.
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

export const DRAFTCHECK_QUESTIONS_REVISION = "draftcheck-questions-2026-09-30.1";
export const DRAFTCHECK_PURPOSE = "seo.draft_check";
export const STATE_CAPS = { text: 6000, opening: 600, headings: 40, heading: 200, title: 300, meta: 500, excerpt: 300, query: 200 } as const;

export type ItemQuestionKey = "answer_early" | "topic_coverage" | "unique_angle" | "first_hand" | "terms_entities";

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
  return {
    target_query: sanitizeForState(input.targetQuery, STATE_CAPS.query) ?? "",
    draft: {
      title: sanitizeForState(input.title, STATE_CAPS.title),
      meta_description: sanitizeForState(input.metaDescription, STATE_CAPS.meta),
      headings: input.headings.slice(0, STATE_CAPS.headings).map((h) => `h${h.level}: ${sanitizeForState(h.text, STATE_CAPS.heading) ?? ""}`),
      opening: sanitizeForState(input.opening, STATE_CAPS.opening),
      text: sanitizeForState(input.text, STATE_CAPS.text) ?? "",
      word_count: input.wordCount,
    },
    claims,
  };
}

const noulOf = (a: DecisionAnswer | undefined): number | null => (a && a.type === "noul" && Number.isFinite(a.noul) ? a.noul : null);

/** Ask all item + claim questions in one call and record every question in decision_records. */
export async function askDraftJev(input: DraftJevInput, deps: DraftJevDeps): Promise<DraftJevRun> {
  const state = buildJevState(input);
  const questions: Record<string, DecisionQuestion> = {};
  const itemKeys: ItemQuestionKey[] = [];
  for (const key of Object.keys(ITEM_QUESTIONS) as ItemQuestionKey[]) {
    if (key === "answer_early" && !state.draft.opening) continue; // absent input: do not ask
    if (!state.draft.text) continue;
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
