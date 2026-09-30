import { describe, expect, it } from "vitest";
import {
  DEMAND_METHOD_VERSION,
  DEMAND_NOTE,
  MAX_DEMAND_POINTS,
  buildDemandCurve,
  demandLookup,
  downsampleRanks,
  hasStrongIntentModifier,
  rankQueries,
  type DemandRow,
} from "@worker/seo/gsc/demand";

const W = { start: "2026-08-31", end: "2026-09-27" };
const opts = { source: "api" as const, window: W, truncated: false };
const q = (query: string, impressions: number, clicks = 0, window?: "current" | "previous"): DemandRow => ({ query, impressions, clicks, window });

const seg = (curve: ReturnType<typeof buildDemandCurve>, name: string) => curve!.segments.find((s) => s.segment === name)!;

describe("demand curve segmentation", () => {
  it("cuts head / middle / long tail by cumulative impression share (50% / next 30% / rest)", () => {
    const curve = buildDemandCurve([q("a", 50, 5), q("b", 20, 2), q("c", 10, 1), q("d", 10, 0), q("e", 5, 0), q("f", 5, 0)], opts)!;
    expect(curve.totalQueries).toBe(6);
    expect(seg(curve, "head")).toMatchObject({ queryCount: 1, impressions: 50, clicks: 5, examples: ["a"] });
    expect(seg(curve, "middle")).toMatchObject({ queryCount: 2, impressions: 30, examples: ["b", "c"] });
    expect(seg(curve, "long_tail")).toMatchObject({ queryCount: 3, impressions: 20, examples: ["d", "e", "f"] });
    expect(seg(curve, "head").shareOfImpressions).toEqual({ numerator: 50, denominator: 100, value: 0.5 });
    expect(seg(curve, "middle").shareOfImpressions.value).toBeCloseTo(0.3, 12);
    expect(seg(curve, "long_tail").shareOfImpressions.value).toBeCloseTo(0.2, 12);
    expect(seg(curve, "head").ctr).toEqual({ numerator: 5, denominator: 50, value: 0.1 });
  });

  it("the query that crosses 50% stays in the head", () => {
    const curve = buildDemandCurve([q("a", 40), q("b", 30), q("c", 20), q("d", 10)], opts)!;
    expect(curve.segments.map((s) => s.queryCount)).toEqual([2, 1, 1]);
    expect(seg(curve, "head").shareOfImpressions.value).toBeCloseTo(0.7, 12);
  });

  it("aggregates a query across pages, ignores the previous window, and normalizes case/whitespace", () => {
    const ranked = rankQueries([q("Brass Knob", 30, 3, "current"), q("brass  knob ", 20, 1, "current"), q("brass knob", 999, 9, "previous"), { query: null, clicks: 5, impressions: 500 }]);
    expect(ranked).toEqual([expect.objectContaining({ query: "brass knob", impressions: 50, clicks: 4, rank: 1, segment: "head", words: 2 })]);
  });

  it("ranks ties deterministically (impressions, then clicks, then query text)", () => {
    const ranked = rankQueries([q("b", 10, 1), q("a", 10, 1), q("c", 10, 2)]);
    expect(ranked.map((r) => r.query)).toEqual(["c", "a", "b"]);
  });

  it("a single query is a head-only curve; empty segments have zero counts and null ratios", () => {
    const curve = buildDemandCurve([q("only query", 120, 6)], opts)!;
    expect(curve.totalQueries).toBe(1);
    expect(seg(curve, "head")).toMatchObject({ queryCount: 1, impressions: 120, medianWords: 2 });
    for (const name of ["middle", "long_tail"]) {
      const s = seg(curve, name);
      expect(s).toMatchObject({ queryCount: 0, impressions: 0, clicks: 0, medianWords: null, examples: [] });
      expect(s.ctr.value).toBeNull();
      expect(s.strongIntentShare.value).toBeNull();
      expect(s.shareOfImpressions).toEqual({ numerator: 0, denominator: 120, value: 0 });
    }
    expect(curve.points).toEqual([{ rank: 1, impressions: 120 }]);
  });

  it("zero impressions: zero-impression queries are dropped; no impressions at all means no curve", () => {
    expect(buildDemandCurve([q("a", 0), q("b", 0)], opts)).toBeNull();
    expect(buildDemandCurve([], opts)).toBeNull();
    const curve = buildDemandCurve([q("a", 10), q("zero", 0)], opts)!;
    expect(curve.totalQueries).toBe(1);
  });

  it("reports median words, examples (max 5), labels, note, and the sync's truncation flag", () => {
    const rows = Array.from({ length: 12 }, (_, i) => q(`query number ${"x ".repeat(i % 3)}${i}`.trim(), 100 - i));
    const curve = buildDemandCurve(rows, { ...opts, source: "csv_import", truncated: true })!;
    expect(curve.truncated).toBe(true);
    expect(curve.source).toBe("csv_import");
    expect(curve.window).toEqual(W);
    expect(curve.basis).toBe("first_party_impressions");
    expect(curve.methodVersion).toBe(DEMAND_METHOD_VERSION);
    expect(curve.note).toBe(DEMAND_NOTE);
    expect(curve.note).toBe(
      "Impressions from your Search Console data for the stated window — not market search volume. Search volume and keyword difficulty need a separately enabled keyword data source.",
    );
    expect(curve.segmentation).toMatch(/Head: top queries up to 50% of impressions; middle: next 30%; long tail: remaining 20%/);
    for (const s of curve.segments) expect(s.examples.length).toBeLessThanOrEqual(5);
    expect(seg(curve, "head").medianWords).not.toBeNull();
  });
});

describe("demand curve points", () => {
  it("keeps every point up to the cap", () => {
    expect(downsampleRanks(150)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    expect(downsampleRanks(0)).toEqual([]);
  });

  it("downsamples to at most 200 log-spaced points, keeping the first and last rank", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => q(`q${i}`, 100000 - i * 7));
    const curve = buildDemandCurve(rows, opts)!;
    const pts = curve.points;
    expect(pts.length).toBeLessThanOrEqual(MAX_DEMAND_POINTS);
    expect(pts.length).toBeGreaterThan(150);
    expect(pts[0]).toEqual({ rank: 1, impressions: 100000 });
    expect(pts.at(-1)).toEqual({ rank: 5000, impressions: 100000 - 4999 * 7 });
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]!.rank).toBeGreaterThan(pts[i - 1]!.rank);
      expect(pts[i]!.impressions).toBeLessThanOrEqual(pts[i - 1]!.impressions);
    }
    // Head detail is preserved: the first ten ranks are all present.
    expect(pts.slice(0, 10).map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(downsampleRanks(1000, 50).length).toBeLessThanOrEqual(50);
  });
});

describe("strong-intent heuristic (English, versioned)", () => {
  it.each([
    ["buy brass cabinet knobs", true],
    ["brass knob price", true],
    ["best cabinet pulls", true],
    ["brass vs chrome hardware", true],
    ["unlacquered brass reviews", true],
    ["lighting store near me", true],
    ["wall sconces for bathroom", true],
    ["brass hardware discount", true],
    ["hardware on sale", true],
    ["how to clean unlacquered brass", false],
    ["cabinet hardware", false],
    ["brass patina", false],
  ])("%s -> %s", (query, expected) => {
    expect(hasStrongIntentModifier(query as string, "en")).toBe(expected);
  });

  it("is unavailable (null) for non-English projects, never guessed", () => {
    expect(hasStrongIntentModifier("kaufen messing knauf", "de")).toBeNull();
    const curve = buildDemandCurve([q("messing knauf kaufen", 100), q("messing griff", 50)], { ...opts, language: "de" })!;
    for (const s of curve.segments) expect(s.strongIntentShare.value).toBeNull();
    expect(curve.segmentation).toMatch(/English-only/);
  });

  it("shares count queries in the segment with a modifier", () => {
    const curve = buildDemandCurve([q("buy knobs", 60), q("knob ideas", 10), q("best pulls", 10), q("pull ideas", 10), q("hinge ideas", 10)], opts)!;
    expect(seg(curve, "head").strongIntentShare).toEqual({ numerator: 1, denominator: 1, value: 1 });
    // Ties at 10 rank by query text: "best pulls", "hinge ideas" (middle: cumBefore 60, 70), then long tail.
    expect(seg(curve, "middle").examples).toEqual(["best pulls", "hinge ideas"]);
    expect(seg(curve, "middle").strongIntentShare).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(seg(curve, "long_tail").strongIntentShare).toEqual({ numerator: 0, denominator: 2, value: 0 });
  });

  it("lookup tags a query with its segment", () => {
    const m = demandLookup([q("buy knobs", 60), q("knob ideas", 25), q("rare query", 15)]);
    expect(m.get("buy knobs")).toMatchObject({ segment: "head", strongIntent: true });
    expect(m.get("rare query")).toMatchObject({ segment: "long_tail", strongIntent: false });
  });
});
