import { describe, expect, it } from "vitest";
import type { DecisionQuestion } from "@worker/providers/types";
import { questionVersion } from "@worker/runs/policy";
import {
  ACTION_CHOICE,
  INTENT_PAGE_FIT,
  ISSUE_SEVERITY,
  PAGE_OVERLAP_TEMPLATE,
  QUERY_INTENT,
  QUERY_PAGE_RELEVANCE,
  QUESTION,
  SEO_QUESTIONS_REVISION,
  pageOverlapQuestion,
  pillarFitQuestion,
  questionsForState,
  staticQuestionVersions,
  versionFor,
} from "@worker/seo/questions";

/**
 * [A13] Snapshot: question_version is a hash of the exact question text, options, and levels. Changing
 * any wording changes these hashes; update SEO_QUESTIONS_REVISION and this snapshot together (a new
 * question version starts a new cohort for trends and threshold calibration).
 */
const SNAPSHOT = {
  revision: "seo-questions-2026-09-30.1",
  versions: {
    "seo.query_page_relevance": "9887765bd0d8cfd8",
    "seo.query_intent": "470d869166554bc0",
    "seo.intent_page_fit": "dedc628d2ce4b140",
    "seo.action_choice": "0ab65020b5b33251",
    "seo.issue_severity": "1d113e300446e68a",
    "seo.page_overlap": "e4466038c2296720",
  },
};

const ALL: Array<[string, DecisionQuestion]> = [
  [QUESTION.queryPageRelevance, QUERY_PAGE_RELEVANCE],
  [QUESTION.queryIntent, QUERY_INTENT],
  [QUESTION.intentPageFit, INTENT_PAGE_FIT],
  [QUESTION.actionChoice, ACTION_CHOICE],
  [QUESTION.issueSeverity, ISSUE_SEVERITY],
  [QUESTION.pageOverlap, PAGE_OVERLAP_TEMPLATE],
];

function criteriaTexts(q: DecisionQuestion): string[] {
  if (q.type === "choice") return Object.values(q.criteria);
  if (q.type === "score") return [...q.criteria];
  return [q.criteria?.true ?? "", q.criteria?.false ?? ""];
}

const isSentence = (t: string) => t.trim().split(/\s+/).length >= 6 && /[.]$/.test(t.trim());

describe("SEO Jev questions (build kit 2.1)", () => {
  it("question versions match the snapshot for this revision (wording change without a version bump fails)", async () => {
    expect(SEO_QUESTIONS_REVISION).toBe(SNAPSHOT.revision);
    expect(await staticQuestionVersions()).toEqual(SNAPSHOT.versions);
  });

  it("any wording change produces a different question_version", async () => {
    const edited = { ...QUERY_INTENT, instructions: `${QUERY_INTENT.instructions} ` } as DecisionQuestion;
    expect(await questionVersion(edited)).not.toBe(await questionVersion(QUERY_INTENT));
  });

  it("uses the documented primitives and options", () => {
    expect(QUERY_PAGE_RELEVANCE.type).toBe("noul");
    expect(PAGE_OVERLAP_TEMPLATE.type).toBe("noul");
    expect(QUERY_INTENT.type === "choice" && Object.keys(QUERY_INTENT.criteria)).toEqual([
      "informational",
      "commercial_investigation",
      "transactional",
      "navigational",
      "local",
      "insufficient_context",
    ]);
    expect(INTENT_PAGE_FIT.type === "choice" && Object.keys(INTENT_PAGE_FIT.criteria)).toEqual(["fits", "partial_fit", "mismatch", "insufficient_context"]);
    expect(ACTION_CHOICE.type === "choice" && Object.keys(ACTION_CHOICE.criteria)).toContain("no_action");
    expect(ISSUE_SEVERITY.type === "score" && ISSUE_SEVERITY.criteria.length).toBe(5);
    expect(ISSUE_SEVERITY.type === "score" && ISSUE_SEVERITY.criteria[4]).toMatch(/^Critical\. .*blocks indexing or serving/);
  });

  it("writes every option, level, and Noul criterion as a full descriptive sentence", () => {
    for (const [id, q] of ALL) {
      for (const t of criteriaTexts(q)) expect(isSentence(t), `${id}: "${t}"`).toBe(true);
    }
    const pillar = pillarFitQuestion(["Cabinet hardware", "Lighting"])!;
    for (const t of criteriaTexts(pillar)) expect(isSentence(t)).toBe(true);
  });

  it("points at named state fields by backticked path", () => {
    for (const [id, q] of ALL) expect(q.instructions, id).toMatch(/`[a-z_]+(\.[a-z_{}]+)*`/);
    expect(QUERY_PAGE_RELEVANCE.instructions).toContain("`page.title`");
    expect(ISSUE_SEVERITY.instructions).toContain("`issue.affected_url_count`");
  });

  it("every Choice has an escape option", () => {
    const escapes = ["insufficient_context", "none", "no_action"];
    for (const [, q] of ALL) if (q.type === "choice") expect(Object.keys(q.criteria).some((k) => escapes.includes(k))).toBe(true);
    const pillar = pillarFitQuestion(["Lighting"])!;
    expect(pillar.type === "choice" && Object.keys(pillar.criteria)).toContain("none");
  });

  it("omits questions whose inputs are absent", () => {
    const base = { hasQuery: false, hasPage: false, hasPageType: false, isTechnical: false, wantsIntent: true, pillars: [], wantsPillar: true };
    expect(Object.keys(questionsForState(base))).toEqual([QUESTION.actionChoice]);
    expect(Object.keys(questionsForState({ ...base, hasQuery: true }))).toEqual([QUESTION.queryIntent, QUESTION.actionChoice]);
    expect(Object.keys(questionsForState({ ...base, hasQuery: true, hasPage: true, hasPageType: true }))).toEqual([
      QUESTION.queryPageRelevance,
      QUESTION.queryIntent,
      QUESTION.intentPageFit,
      QUESTION.actionChoice,
    ]);
    // Pillar question only with a pillar list; technical asks severity only.
    expect(Object.keys(questionsForState({ ...base, hasQuery: true, pillars: ["Lighting"] }))).toContain(QUESTION.pillarFit);
    expect(Object.keys(questionsForState({ ...base, isTechnical: true, hasQuery: true }))).toEqual([QUESTION.issueSeverity]);
    expect(pillarFitQuestion([])).toBeNull();
    expect(pillarFitQuestion(["  ", "none"])).toBeNull();
  });

  it("pair questions are versioned on the canonical template", async () => {
    const q = pageOverlapQuestion("p7");
    expect(q.instructions).toContain("`pairs.p7.page_a`");
    expect(q.instructions).not.toContain("{pair}");
    expect(await versionFor(`${QUESTION.pageOverlap}#p7`, q)).toBe(SNAPSHOT.versions["seo.page_overlap"]);
    expect(() => pageOverlapQuestion("p-1; drop")).toThrow();
  });
});
