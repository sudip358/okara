import { describe, expect, it } from "vitest";
import { ACTION_CHOICE_OPTIONS, QUESTION, SEO_STATIC_QUESTIONS } from "@worker/seo/questions";
import { getRule } from "@worker/seo/rules/registry";
import {
  isQueryQuestion,
  judgeElement,
  judgeLinkSuggestion,
  judgeRule,
  LIVE_SEO_ELEMENT_MAP,
  parseCandidateKey,
  queryBand,
  storedAnswer,
} from "@worker/live/elements";

const noul = (n: number) => ({ answer: { type: "noul", noul: n }, candidate: "weak_ctr:https://x.test/a", questionTier: "act" });
const choice = (c: string, confidence = 0.9) => ({ answer: { type: "choice", choice: c, confidence, probabilities: { [c]: confidence } }, candidate: "declining:https://x.test/a" });

describe("live elements map", () => {
  it("maps only real SEO question ids", () => {
    for (const id of Object.keys(LIVE_SEO_ELEMENT_MAP.questions)) expect(SEO_STATIC_QUESTIONS[id], id).toBeDefined();
    for (const id of LIVE_SEO_ELEMENT_MAP.queryQuestions) expect(SEO_STATIC_QUESTIONS[id], id).toBeDefined();
  });

  it("covers every action_choice option", () => {
    const spec = LIVE_SEO_ELEMENT_MAP.questions[QUESTION.actionChoice]!;
    expect(spec.type).toBe("choice");
    if (spec.type !== "choice") return;
    for (const o of ACTION_CHOICE_OPTIONS) expect(spec.options[o], o).toBeDefined();
  });

  it("maps only rule ids that exist in the registry", () => {
    for (const id of Object.keys(LIVE_SEO_ELEMENT_MAP.rules)) {
      if (id.startsWith("SEO-SITEMAP-")) continue; // sitemap-health rules live outside the registry list
      expect(getRule(id), id).toBeTruthy();
    }
  });
});

describe("judgeElement", () => {
  it("uses polarity and the stored act tier for Noul answers", () => {
    expect(judgeElement(QUESTION.titleMatchesQuery, noul(0.92), "act")).toMatchObject({ element: "Title", verdict: "keep", role: "element" });
    expect(judgeElement(QUESTION.titleMatchesQuery, noul(0.08), "act")).toMatchObject({ verdict: "change" });
    expect(judgeElement(QUESTION.outdatedInformation, noul(0.9), "act")).toMatchObject({ element: "Freshness", verdict: "change" });
    expect(judgeElement(`${QUESTION.thinContent}#e1`, noul(0.1), "act")).toMatchObject({ element: "Content", verdict: "keep" });
  });

  it("never turns an unsure or missing answer into keep/change", () => {
    expect(judgeElement(QUESTION.metaMatchesQuery, noul(0.55), "flag")).toMatchObject({ verdict: "review" });
    expect(judgeElement(QUESTION.metaMatchesQuery, { answer: null, questionTier: "drop" }, "drop")).toMatchObject({ verdict: "review" });
    expect(judgeElement(QUESTION.pageAction, choice("update", 0.6), "flag")).toMatchObject({ verdict: "review" });
  });

  it("maps Choice options, including the labelled demo fixtures (bare answers)", () => {
    expect(judgeElement(QUESTION.pageAction, choice("keep"), "act")).toMatchObject({ element: "Page", verdict: "keep" });
    expect(judgeElement(QUESTION.actionChoice, choice("rewrite_title_meta"), "act")).toMatchObject({ element: "Title + meta", verdict: "change", role: "action" });
    const demo = { type: "choice", choice: "add_offer_markup", confidence: 0.86, probabilities: { add_offer_markup: 0.86 } };
    expect(judgeElement(QUESTION.actionChoice, demo, "act")).toMatchObject({ element: "Schema", verdict: "change" });
    expect(judgeElement(QUESTION.actionChoice, choice("something_new"), "act")).toMatchObject({ verdict: "review" });
  });

  it("ignores questions that are not page elements", () => {
    expect(judgeElement(QUESTION.queryRelevance, noul(0.9), "act")).toBeNull();
    expect(judgeElement(QUESTION.issueSeverity, choice("2"), "act")).toBeNull();
    expect(judgeElement(null, noul(0.9), "act")).toBeNull();
  });
});

describe("other rows", () => {
  it("reuses a link suggestion's stored tier and Noul", () => {
    const j = judgeLinkSuggestion({ candidate: "internal_link_suggestion:a|b", kind: "internal_link_suggestion", linkSuggestionId: "ls_1", suggestionTier: "act", shouldExist: 0.91 });
    expect(j).toMatchObject({ element: "Links", verdict: "change", noul: 0.91, tier: "act", linkSuggestionId: "ls_1" });
    expect(judgeLinkSuggestion({ candidate: "technical:x", kind: "technical" })).toBeNull();
  });

  it("maps rule findings by class", () => {
    expect(judgeRule("SEO-META-DESC-MISSING", "fact")).toMatchObject({ element: "Meta", verdict: "change" });
    expect(judgeRule("SEO-H1-MULTIPLE", "heuristic")).toMatchObject({ element: "H1", verdict: "review" });
    expect(judgeRule("AI-SEARCH-CRAWLER-BLOCKED", "fact")).toBeNull();
  });

  it("bands query answers from the stored tier", () => {
    expect(isQueryQuestion(QUESTION.queryRelevance)).toBe(true);
    expect(isQueryQuestion(QUESTION.titleMatchesQuery)).toBe(false);
    expect(queryBand(storedAnswer({ answer: { type: "noul", noul: 0.9 }, query: "q" }), "act")).toBe("yes");
    expect(queryBand(storedAnswer({ answer: { type: "noul", noul: 0.5 }, query: "q" }), "flag")).toBe("middle");
    expect(queryBand(storedAnswer({ answer: null, query: "q" }), "drop")).toBeNull();
  });

  it("recovers URL and query from readable candidate keys without guessing", () => {
    expect(parseCandidateKey("striking_distance:oak table|https://x.test/oak")).toEqual({ kind: "striking_distance", url: "https://x.test/oak", query: "oak table" });
    expect(parseCandidateKey("weak_ctr:https://x.test/a")).toEqual({ kind: "weak_ctr", url: "https://x.test/a", query: null });
    expect(parseCandidateKey("template:collection:intro")).toEqual({ kind: "template", url: null, query: null });
    expect(parseCandidateKey(null)).toEqual({ kind: null, url: null, query: null });
  });
});
