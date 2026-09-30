import { describe, expect, it } from "vitest";
import { detailMessages, groupTrendByCohort, normalizeSuggestions, segmentText } from "./lib";
import { answerSummary, decisionFieldPairs, runnerUpFromAnswer } from "../recommendations/lib";
import { groupFindings } from "../seo/lib";
import type { AuditFinding } from "@shared/types";

describe("segmentText", () => {
  it("splits text into plain and highlighted segments without HTML", () => {
    const text = "Try <b>Acme</b> or Globex today";
    const segs = segmentText(text, [
      { brandKey: "acme", isSelf: true, spans: [{ start: 7, end: 11 }] },
      { brandKey: "globex", isSelf: false, spans: [{ start: 19, end: 25 }] },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs.filter((s) => s.brandKey).map((s) => s.text)).toEqual(["Acme", "Globex"]);
  });
  it("clips overlapping and out-of-range spans", () => {
    const segs = segmentText("abcdef", [
      { brandKey: "a", isSelf: true, spans: [{ start: 1, end: 4 }] },
      { brandKey: "b", isSelf: false, spans: [{ start: 2, end: 99 }] },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe("abcdef");
    expect(segs.map((s) => [s.text, s.brandKey])).toEqual([
      ["a", null],
      ["bcd", "a"],
      ["ef", "b"],
    ]);
  });
});

describe("groupTrendByCohort", () => {
  it("never merges non-consecutive cohorts", () => {
    const r = { numerator: 1, denominator: 2, value: 0.5 };
    const g = groupTrendByCohort([
      { cohortKey: "a", runAt: "2026-09-01", mentionRate: r, citationRate: r, annotation: null },
      { cohortKey: "b", runAt: "2026-09-03", mentionRate: r, citationRate: r, annotation: "model changed" },
      { cohortKey: "a", runAt: "2026-09-02", mentionRate: r, citationRate: r, annotation: null },
    ]);
    expect(g.map((x) => [x.cohortKey, x.points.length])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });
});

describe("decision display", () => {
  it("uses the provider's real field names and never invents confidence for noul", () => {
    expect(decisionFieldPairs({ noul: 0.91 })).toEqual([{ name: "noul", value: "0.91" }]);
    expect(answerSummary({ type: "noul", noul: 0.9 })).toBe("noul 0.90");
    expect(answerSummary({ type: "noul", noul: 0.9 })).not.toContain("confidence");
    expect(runnerUpFromAnswer({ type: "noul", noul: 0.5 })).toBeNull();
    expect(runnerUpFromAnswer({ type: "choice", choice: "a", confidence: 0.6, probabilities: { a: 0.6, b: 0.3, c: 0.1 } })).toEqual({
      label: "b",
      probability: 0.3,
    });
  });
});

describe("misc", () => {
  it("normalizes suggestion shapes", () => {
    expect(normalizeSuggestions([{ prompt: "Where to buy x?", stage: "buying", rationale: "r" }])).toEqual([
      { text: "Where to buy x?", stage: "buying", rationale: "r", promptType: "discovery" },
    ]);
    expect(normalizeSuggestions({ suggestions: [{ text: "Q" }] })[0]?.text).toBe("Q");
    expect(normalizeSuggestions(null)).toEqual([]);
  });
  it("flattens error details", () => {
    expect(detailMessages([{ index: 0, message: "names a competitor" }])).toEqual(["Prompt 1: names a competitor"]);
  });
  it("groups findings by area with most severe first", () => {
    const f = (id: string, area: string, severity: AuditFinding["severity"]): AuditFinding => ({
      id,
      ruleId: "r",
      ruleName: id,
      area,
      class: "fact",
      severity,
      url: null,
      template: null,
      detail: "",
      applicability: "",
    });
    const g = groupFindings([f("1", "Meta", "minor"), f("2", "Indexing", "critical"), f("3", "Meta", "major")]);
    expect(g.map((x) => x.area)).toEqual(["Indexing", "Meta"]);
    expect(g[1]?.bySeverity.map((s) => s.severity)).toEqual(["major", "minor"]);
  });
});
