/**
 * [A23] New SEO Jev questions: authoring rules (section 2.1), primitives (Noul for binary decisions,
 * Choice for page action), escape options, backticked state paths, templated question versions, and the
 * question_version snapshot. Changing any wording without updating SEO_QUESTIONS_REVISION and the
 * snapshot in tests/seo-analysis.questions.test.ts fails there; this file pins the new ids.
 */
import { describe, expect, it } from "vitest";
import type { DecisionQuestion } from "@worker/providers/types";
import { questionVersion } from "@worker/runs/policy";
import { questionFor, SEO_EVAL_QUESTION_IDS } from "@worker/eval/harness";
import {
  buyerQueryQuestion,
  buyerReadyQuestion,
  coversTopicQuestion,
  PAGE_ACTION,
  QUERY_INTENT,
  queryIntentQuestion,
  queryRelevanceQuestion,
  QUESTION,
  SEO_QUESTIONS_REVISION,
  SEO_STATIC_QUESTIONS,
  staticQuestionVersions,
  thinContentQuestion,
  versionFor,
} from "@worker/seo/questions";

const NEW_IDS = [
  QUESTION.queryRelevance,
  QUESTION.thinContent,
  QUESTION.pageAction,
  QUESTION.schemaContentMatch,
  QUESTION.titleMatchesQuery,
  QUESTION.metaMatchesQuery,
  QUESTION.coversTopic,
  QUESTION.outdatedInformation,
  QUESTION.answerIsDirect,
  QUESTION.buyerQuery,
  QUESTION.buyerReady,
];

const NEW_VERSIONS: Record<string, string> = {
  "seo.query_intent": "bdaaf715d381a5e8",
  "seo.query_relevance": "64f826eee4af2677",
  "seo.thin_content": "433ba1367b1e757e",
  "seo.page_action": "8d8b7ce5cab7cdb0",
  "seo.schema_content_match": "c8cb4b91f99a86c5",
  "seo.title_matches_query": "683966db4ba0ba23",
  "seo.meta_matches_query": "4ca6a9e8713cd4c8",
  "seo.covers_topic": "091371863c776b57",
  "seo.outdated_information": "cc1edf19f47bd025",
  "seo.answer_is_direct": "de865ff7c298b1ae",
  "seo.buyer_query": "c5446230343fcea8",
  "seo.buyer_ready": "a86244b3ed78ac94",
};

/** Filled form used for text checks (templates carry a `{q}`/`{p}`/`{t}` placeholder). */
function filled(id: string): DecisionQuestion {
  if (id === QUESTION.thinContent) return thinContentQuestion("thin_pages.e1");
  if (id === QUESTION.coversTopic) return coversTopicQuestion("topics.t1");
  if (id === QUESTION.queryRelevance) return queryRelevanceQuestion("queries.q1");
  if (id === QUESTION.buyerQuery) return buyerQueryQuestion("queries.q1");
  if (id === QUESTION.buyerReady) return buyerReadyQuestion("queries.q1");
  return SEO_STATIC_QUESTIONS[id]!;
}

function texts(q: DecisionQuestion): string[] {
  if (q.type === "choice") return Object.values(q.criteria);
  if (q.type === "score") return [...q.criteria];
  return [q.criteria?.true ?? "", q.criteria?.false ?? ""];
}

const isSentence = (t: string) => t.trim().split(/\s+/).length >= 6 && /[.]$/.test(t.trim());

describe("[A23] SEO Jev questions", () => {
  it("question_version snapshot for the new questions (revision .2)", async () => {
    expect(SEO_QUESTIONS_REVISION).toBe("seo-questions-2026-09-30.2");
    const v = await staticQuestionVersions();
    for (const [id, version] of Object.entries(NEW_VERSIONS)) expect(v[id], id).toBe(version);
  });

  it("binary decisions are Noul (no confidence field); page action is a Choice with an escape option", () => {
    for (const id of NEW_IDS.filter((x) => x !== QUESTION.pageAction)) expect(SEO_STATIC_QUESTIONS[id]!.type, id).toBe("noul");
    expect(PAGE_ACTION.type).toBe("choice");
    expect(PAGE_ACTION.type === "choice" && Object.keys(PAGE_ACTION.criteria)).toEqual(["keep", "update", "merge", "remove", "insufficient_context"]);
  });

  it("every option and Noul criterion is a full descriptive sentence; state is referenced by backticked path", () => {
    for (const id of NEW_IDS) {
      const q = filled(id);
      for (const t of texts(q)) expect(isSentence(t), `${id}: "${t}"`).toBe(true);
      expect(q.instructions, id).toMatch(/`[a-z_]+(\.[a-z0-9_]+)*`/);
      expect(q.instructions, id).not.toMatch(/\{[a-z]\}/);
    }
  });

  it("query intent has `mixed` distinct from insufficient_context and names brand terms, country, and language", () => {
    expect(QUERY_INTENT.type === "choice" && QUERY_INTENT.criteria.mixed).toMatch(/^Mixed\. .*two or more of the intents/);
    expect(QUERY_INTENT.type === "choice" && QUERY_INTENT.criteria.insufficient_context).toMatch(/^Insufficient context\./);
    for (const path of ["`brand_terms.self`", "`brand_terms.competitors`", "`country`", "`language`", "`locale`"]) expect(QUERY_INTENT.instructions).toContain(path);
  });

  it("templated questions share one version across state paths (single candidate vs batch)", async () => {
    const single = await versionFor(QUESTION.queryIntent, queryIntentQuestion("query"));
    const batched = await versionFor(`${QUESTION.queryIntent}#q7`, queryIntentQuestion("queries.q7"));
    expect(single).toBe(batched);
    expect(queryIntentQuestion("queries.q7").instructions).toContain("`queries.q7`");
    expect(await versionFor(`${QUESTION.coversTopic}#t3`, coversTopicQuestion("topics.t3"))).toBe(NEW_VERSIONS["seo.covers_topic"]);
    expect(() => queryIntentQuestion("queries.q1; drop")).toThrow();
    // A wording change changes the version.
    const edited = { ...PAGE_ACTION, instructions: `${PAGE_ACTION.instructions} ` } as DecisionQuestion;
    expect(await questionVersion(edited)).not.toBe(NEW_VERSIONS["seo.page_action"]);
  });

  it("the eval harness knows every SEO question id, including the new ones", () => {
    for (const id of [...NEW_IDS, QUESTION.queryIntent]) {
      expect(SEO_EVAL_QUESTION_IDS).toContain(id);
      expect(questionFor({ id: "x", question_id: id, state: {}, human_answer: "yes" })).not.toBeNull();
    }
    expect(questionFor({ id: "x", question_id: QUESTION.buyerQuery, state: {}, human_answer: "yes", ref: "queries.q2" })!.instructions).toContain("`queries.q2`");
  });
});
