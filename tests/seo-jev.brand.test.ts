/**
 * [A23] Brand / non-brand: the deterministic classifier, the overview split (with its math), the
 * non-brand demand curve, and the weak-CTR / striking-distance exclusions. Labelled fixture data.
 */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import type { GscRow } from "@worker/providers/types";
import { BRAND_METHOD_VERSION, brandSplitOf, brandTermsFrom, createBrandClassifier, normalizeBrandText } from "@worker/seo/gsc/brand";
import { buildSeoOverview } from "@worker/seo/gsc/overview";
import { buildCandidates } from "@worker/seo/recommend/candidates";
import { loadCandidateInputs } from "@worker/seo/recommend/inputs";
import { DEFAULT_GSC_DATA, QP_CURRENT, QP_PREVIOUS, U } from "./fixtures/gsc/site";
import { scenario } from "./fixtures/gsc/scenario";

const row = (keys: string[], clicks: number, impressions: number, position: number): GscRow => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

/** Brand queries (brand "Residence Example", alias "ResEx") and one competitor query ("Brass Co"). */
const BRAND_ROWS = [
  row(["residence example knobs", U.home], 10, 3000, 4), // very low CTR at position 4: would be a weak-CTR row
  row(["resex", U.home], 50, 400, 2),
  row(["residenceexample", U.home], 5, 100, 3),
  row(["resex brass hooks", U.sconces], 2, 500, 12), // would be striking distance
];
const COMPETITOR = row(["brass co knobs", U.knob], 1, 300, 12);
const DATA = { ...DEFAULT_GSC_DATA, qp: { current: [...QP_CURRENT, ...BRAND_ROWS, COMPETITOR], previous: QP_PREVIOUS } };

const terms = brandTermsFrom({ brandName: "Residence Example", brandAliases: ["ResEx"], competitors: [{ name: "Brass Co", aliases: [] }] });
const brand = createBrandClassifier(terms);

describe("brand classifier (" + BRAND_METHOD_VERSION + ")", () => {
  it("matches the brand name and aliases as whole words, NFKC / case / accent / punctuation-insensitively", () => {
    expect(brand.classify("residence example knobs").kind).toBe("self_brand");
    expect(brand.classify("ＲｅｓＥｘ brass").kind).toBe("self_brand"); // fullwidth (NFKC)
    expect(brand.classify("Résidence-Example reviews").kind).toBe("self_brand");
    expect(brand.classify("residenceexample").kind).toBe("self_brand"); // joined multi-word form
    expect(brand.classify("residences examples").kind).toBe("non_brand"); // whole words only
    expect(brand.classify("resexpress hinge").kind).toBe("non_brand");
    expect(normalizeBrandText("  Brass & Co. ")).toBe("brass co");
  });

  it("competitor names are competitor_brand (non-brand for the split), with word boundaries", () => {
    expect(brand.classify("brass co knobs")).toMatchObject({ kind: "competitor_brand", competitorTerm: "brass co" });
    expect(brand.classify("brass cabinet knob").kind).toBe("non_brand");
    expect(brand.classify("brass cobalt finish").kind).toBe("non_brand");
    // A query naming both is self-brand (and still records the competitor).
    expect(brand.classify("resex vs brass co")).toMatchObject({ kind: "self_brand", competitorTerm: "brass co" });
  });

  it("skips too-short terms and terms listed as both brand and competitor", () => {
    const t = brandTermsFrom({ brandName: "Acme", brandAliases: ["AC", "Lumen"], competitors: [{ name: "Lumen", aliases: ["Glow Works"] }] });
    expect(t.self).toEqual(["acme"]);
    expect(t.competitors).toEqual(["glow works"]);
    expect(t.skipped).toEqual(expect.arrayContaining([{ term: "ac", reason: "too_short" }, { term: "lumen", reason: "collision" }]));
  });

  it("split math: per-query sums, CTR = clicks / impressions, competitor queries counted as non-brand", () => {
    const rows = [
      { query: "resex", clicks: 50, impressions: 400 },
      { query: "ResEx ", clicks: 10, impressions: 100 }, // same query after normalization
      { query: "brass co knobs", clicks: 1, impressions: 300 },
      { query: "brass knobs", clicks: 20, impressions: 1000 },
    ];
    const d = brandSplitOf(rows, brand, { window: "2026-08-31..2026-09-27", basis: "query_page_rows" })!;
    expect(d.split.brand).toEqual({ queries: 1, clicks: 60, impressions: 500, ctr: { numerator: 60, denominator: 500, value: 0.12 } });
    expect(d.split.nonBrand).toEqual({ queries: 2, clicks: 21, impressions: 1300, ctr: { numerator: 21, denominator: 1300, value: 21 / 1300 } });
    expect(d.competitorQueries).toBe(1);
    expect(d.split.method).toMatch(/Competitor-name queries count as non-brand \(1 this window\)/);
    expect(d.split.method).toContain(BRAND_METHOD_VERSION);
    // Nothing to split on without brand terms.
    expect(brandSplitOf(rows, createBrandClassifier({ self: [], competitors: [], skipped: [] }), { window: null, basis: "query_rows" })).toBeNull();
    expect(brandSplitOf([], brand, { window: null, basis: "query_rows" })).toBeNull();
  });
});

describe("overview brand split and non-brand demand curve", () => {
  it("SeoOverview.brandSplit sums the current window; the demand curve excludes brand queries and says so", async () => {
    const s = await scenario({ crawl: false, gsc: DATA });
    const db = new Db(s.env.DB);
    const project = (await db.first<{ id: string; workspace_id: string; gsc_property: string | null; is_demo: number; language: string }>(
      "SELECT id, workspace_id, gsc_property, is_demo, language FROM projects WHERE id = ?",
      s.projectId,
    ))!;
    const o = await buildSeoOverview(db, project);
    expect(o.brandSplit).toMatchObject({
      brand: { queries: 4, clicks: 67, impressions: 4000, ctr: { numerator: 67, denominator: 4000, value: 67 / 4000 } },
      nonBrand: { queries: 6, clicks: 186, impressions: 5850, ctr: { numerator: 186, denominator: 5850 } },
    });
    expect(o.brandSplit!.method).toMatch(/whole words/);
    expect(o.demandCurve!.totalQueries).toBe(6);
    expect(o.demandCurve!.note).toMatch(/Non-brand queries only: 4 queries containing your brand name or an alias \(4,000 impressions\) are excluded/);
    expect(o.demandCurve!.segments.flatMap((x) => x.examples)).not.toContain("resex");
    // Property totals are untouched (they never come from slices).
    expect(o.totals.current?.clicks).toBe(300);
  });
});

describe("weak-CTR and striking-distance exclude brand queries", () => {
  it("brand rows are neither flagged nor part of the bucket medians; competitor queries stay and are flagged", async () => {
    const s = await scenario({ gsc: DATA, findings: [] });
    const inputs = await loadCandidateInputs(s.ctx());
    const cands = buildCandidates(inputs);
    const weak = cands.filter((c) => c.kind === "weak_ctr");
    expect(weak.map((c) => c.target.url)).toEqual([U.knob, U.knobLarge]);
    expect(weak[0]!.metrics.bucketMedianCtr).toBe(0.05); // unchanged by the brand row at 0.33%
    const striking = cands.filter((c) => c.kind === "striking_distance");
    expect(striking.some((c) => brand.isSelfBrand(c.query))).toBe(false);
    const comp = striking.find((c) => c.query === "brass co knobs")!;
    expect(comp.metrics.competitorBrand).toBe("yes");

    // Without brand terms the same brand rows WOULD be candidates (the exclusion is what removes them).
    const noBrand = buildCandidates({ ...inputs, project: { ...inputs.project, brandTerms: { self: [], competitors: [], skipped: [] } } });
    expect(noBrand.some((c) => c.kind === "weak_ctr" && c.target.url === U.home)).toBe(true);
    expect(noBrand.some((c) => c.kind === "striking_distance" && c.query === "resex brass hooks")).toBe(true);
  });
});
