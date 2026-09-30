import { describe, expect, it } from "vitest";
import { agrees, parseJsonl, percentile, questionFor, runEval, type LabelRow } from "@worker/eval/harness";
import type { DecisionProvider, DecisionRequest } from "@worker/providers/types";

const rows: LabelRow[] = [
  { id: "a", question_id: "seo.query_intent", state: { query: "buy brass pulls" }, human_answer: "transactional" },
  { id: "b", question_id: "seo.query_intent", state: { query: "how to clean brass" }, human_answer: "informational" },
  { id: "c", question_id: "seo.page_overlap", state: {}, human_answer: "yes" },
  { id: "d", question_id: "nope.unknown", state: {}, human_answer: "x" },
];

function fakeProvider(): DecisionProvider {
  return {
    name: "fake",
    async decide(req: DecisionRequest) {
      const [qid] = Object.keys(req.questions);
      if (qid === "seo.query_intent") {
        const q = JSON.stringify(req.state);
        const choice = q.includes("buy") ? "transactional" : "commercial_investigation";
        return { provider: "fake", model: "fake-1", answers: { [qid]: { type: "choice", choice, confidence: q.includes("buy") ? 0.9 : 0.5, probabilities: { [choice]: 0.9 } } }, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return { provider: "fake", model: "fake-1", answers: { [qid!]: { type: "noul", noul: 0.95 } }, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async test() { return { ok: true, detail: "" }; },
  };
}

describe("eval harness [A5]", () => {
  it("scores agreement overall and by tier, skips unknown questions, reports unknown cost", async () => {
    const report = await runEval(rows, fakeProvider(), { recordedCalls: [{ provider: "typesafe", model: "fake-1", purpose: "eval", status: "ok", costUsd: null, costIsEstimate: true }] });
    const intent = report.perQuestion["seo.query_intent"]!;
    expect(intent.agreement).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(intent.byTier.act).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(intent.byTier.flag).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(report.perQuestion["seo.page_overlap"]!.agreement.value).toBe(1);
    expect(report.results.find((r) => r.id === "d")!.status).toBe("unknown_question");
    expect(report.cost.unknownCostCalls).toBe(1);
    expect(report.notes.join(" ")).toContain("never shown as $0");
  });

  it("agreement rules per primitive and helpers", () => {
    expect(agrees({ type: "noul", noul: 0.2 }, "no")).toBe(true);
    expect(agrees({ type: "score", score: 2.6, confidence: 0.8, probabilities: {} }, 3)).toBe(true);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([], 95)).toBeNull();
    expect(questionFor({ id: "g", question_id: "geo.brand_sentiment", state: {}, human_answer: "positive", ref: "passage", brand: "Acme" })?.type).toBe("choice");
    expect(() => parseJsonl('{"id":"x"}')).toThrow();
  });

  it("seed label file parses", async () => {
    const { readFileSync } = await import("node:fs");
    expect(parseJsonl(readFileSync("eval/labels/seo.query_intent.jsonl", "utf8")).length).toBeGreaterThan(0);
  });
});
