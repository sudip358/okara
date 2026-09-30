import { describe, expect, it } from "vitest";
import {
  brandForHost,
  detectBrands,
  listRankFor,
  normalizeDomain,
  parseOrderedLists,
  projectBrands,
  registrableDomain,
  resolveCitationHost,
  selfDomains,
  type BrandDef,
} from "@worker/geo/detect";
import { classifySourceByRules } from "@worker/geo/source-type";
import {
  CrossCohortError,
  METRICS_VERSION,
  buildTrend,
  citationRate,
  compareRates,
  mentionRate,
  ratio,
  shareOfVoice,
  smallSampleWarning,
  type MetricObservation,
} from "@worker/geo/metrics";
import { GEO_QUESTION_TEMPLATES, geoQuestionVersion, type GeoQuestionId } from "@worker/geo/questions";
import { brandBlindViolations } from "@worker/geo/prompts";
import { fixture } from "./fixtures/geo-analysis/seed";

const project = {
  brand_name: "Residence Example",
  brand_aliases_json: JSON.stringify(["ResEx"]),
  competitors_json: JSON.stringify([{ name: "Brass Co", domains: ["brassco.example"], aliases: [] }]),
  site_url: "https://shop.example.com",
  verified_host: "shop.example.com",
  gsc_property: "sc-domain:example.com",
};
const brands = projectBrands(project);

function spansOf(text: string, key = "self", b: BrandDef[] = brands) {
  return detectBrands(text, b).get(key) ?? [];
}

describe("geo-analysis: brand detection (response body only)", () => {
  it("detects a mention with exact original-text spans", () => {
    const text = fixture("mention").answer!;
    const s = spansOf(text);
    expect(s).toHaveLength(1);
    expect(text.slice(s[0]!.start, s[0]!.end)).toBe("Residence Example");
    expect(s[0]!.ambiguous).toBe(false);
  });

  it("finds nothing when no brand is named", () => {
    expect(spansOf(fixture("no_mention").answer!)).toEqual([]);
  });

  it("is case-insensitive and word-bounded; handles possessives and punctuation", () => {
    expect(spansOf("I like RESEX's pulls.")).toHaveLength(1);
    expect(spansOf("I like ResEx’s pulls.")).toHaveLength(1);
    expect(spansOf("(ResEx) sells knobs")).toHaveLength(1);
    expect(spansOf("ResExtra is a different shop")).toHaveLength(0);
    expect(spansOf("PreResEx is not it")).toHaveLength(0);
    expect(spansOf("Residence\n  Example ships worldwide")).toHaveLength(1);
  });

  it("brand named only in the prompt is not a response mention", () => {
    const c = fixture("brand_only_in_prompt");
    expect(spansOf(c.prompt)).toHaveLength(1);
    expect(spansOf(c.answer!)).toHaveLength(0);
  });

  it("flags self/competitor alias collisions as ambiguous", () => {
    const colliding = projectBrands({ ...project, competitors_json: JSON.stringify([{ name: "Brass Co", domains: ["brassco.example"], aliases: ["ResEx"] }]) });
    const m = detectBrands(fixture("alias_collision").answer!, colliding);
    expect(m.get("self")![0]!.ambiguous).toBe(true);
    expect(m.get("Brass Co")![0]!.ambiguous).toBe(true);
    expect(m.get("self")![0]!.collidesWith).toEqual(["Brass Co"]);
  });

  it("longer match wins when one brand's match contains another's", () => {
    const b = projectBrands({ ...project, brand_aliases_json: JSON.stringify(["Brass"]) });
    const m = detectBrands("Brass Co makes pulls.", b);
    expect(m.get("self")).toEqual([]);
    expect(m.get("Brass Co")).toHaveLength(1);
  });

  it("handles multilingual text: German genitive and Japanese (no spaces, full-width)", () => {
    const de = fixture("multilingual_de").answer!;
    const sde = spansOf(de);
    expect(sde).toHaveLength(2);
    for (const s of sde) expect(de.slice(s.start, s.end)).toBe("Residence Example");

    const ja = fixture("multilingual_ja").answer!;
    const jb = projectBrands({ ...project, brand_aliases_json: JSON.stringify(["ResEx", "レジデンス"]) });
    const sja = spansOf(ja, "self", jb);
    expect(sja.map((s) => ja.slice(s.start, s.end))).toEqual(["Residence Example", "レジデンス", "ＲｅｓＥｘ"]);
    for (const s of sja) expect(s.text).toBe(ja.slice(s.start, s.end));
  });
});

describe("geo-analysis: citations by parsed hostname", () => {
  it("self domains include the verified host's registrable domain but not shared hosting parents", () => {
    expect(selfDomains(project).sort()).toEqual(["example.com", "shop.example.com"]);
    expect(registrableDomain("store.myshopify.com")).toBeNull();
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
  });

  it("matches subdomains; never substrings", () => {
    const host = (u: string, t: string | null = null) => resolveCitationHost(u, t).host;
    expect(brandForHost(host("https://shop.example.com/p"), brands)).toBe("self");
    expect(brandForHost(host("https://blog.example.com/x"), brands)).toBe("self");
    expect(brandForHost(host("https://WWW.Example.com/"), brands)).toBe("self");
    expect(brandForHost(host("https://evil-example.com.attacker.net/shop.example.com/page"), brands)).toBeNull();
    expect(brandForHost(host("https://notexample.com/brass"), brands)).toBeNull();
    expect(brandForHost(host("https://www.brassco.example/knobs"), brands)).toBe("Brass Co");
    expect(normalizeDomain("javascript:alert(1)")).toBeNull();
  });

  it("resolves Gemini redirect URIs only through a bare-domain title", () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";
    expect(resolveCitationHost(redirect, "example.com")).toEqual({ host: "example.com", via: "title" });
    expect(resolveCitationHost(redirect, "Some Article About Brass")).toEqual({ host: null, via: "unresolved" });
    expect(resolveCitationHost("ftp://example.com/x", null).host).toBeNull();
  });
});

describe("geo-analysis: list rank", () => {
  it("records rank only for ordered lists", () => {
    const text = fixture("ordered").answer!;
    const items = parseOrderedLists(text);
    expect(listRankFor(items, spansOf(text))).toBe(2);
    expect(listRankFor(items, spansOf(text, "Brass Co"))).toBe(1);
  });

  it("handles bold-number items separated by paragraphs", () => {
    const text = fixture("ordered_paragraphs").answer!;
    expect(listRankFor(parseOrderedLists(text), spansOf(text))).toBe(2);
  });

  it("unordered prose and bulleted lists give null", () => {
    const text = fixture("unordered").answer!;
    expect(listRankFor(parseOrderedLists(text), spansOf(text))).toBeNull();
  });
});

describe("geo-analysis: source types [A1]", () => {
  const tracked = brands.flatMap((b) => b.domains);
  const cls = (url: string, host: string | null, title: string | null = null) => classifySourceByRules({ url, host, title }, tracked)?.sourceType ?? null;
  it("applies deterministic rules in order", () => {
    expect(cls("https://brassco.example/x", "brassco.example")).toBe("brand_page");
    expect(cls("https://www.reddit.com/r/a/comments/1/x", "reddit.com")).toBe("forum_ugc");
    expect(cls("https://cooking.stackexchange.com/q/1", "cooking.stackexchange.com")).toBe("forum_ugc");
    expect(cls("https://www.trustpilot.com/review/x", "trustpilot.com")).toBe("review_site");
    expect(cls("https://www.amazon.co.uk/dp/1", "amazon.co.uk")).toBe("marketplace");
    expect(cls("https://www.etsy.com/listing/1", "etsy.com")).toBe("marketplace");
    expect(cls("https://bestreviews.example/best-brass-cabinet-hardware", "bestreviews.example", "10 Best Brass Cabinet Hardware Brands")).toBe("listicle_roundup");
    expect(cls("https://site.example/brassco-vs-resex", "site.example")).toBe("listicle_roundup");
    expect(cls("https://www.nytimes.com/2026/brass", "nytimes.com", "Brass is back")).toBe("publisher");
    expect(cls("https://random.example/about", "random.example", "About us")).toBeNull();
  });
});

// ------------------------------------------------------------------ metrics
function obs(p: Partial<MetricObservation> & { self?: [boolean, boolean]; comp?: [boolean, boolean] }): MetricObservation {
  const [sm, sc] = p.self ?? [false, false];
  const [cm, cc] = p.comp ?? [false, false];
  return {
    id: Math.random().toString(36),
    cohortKey: p.cohortKey ?? "A",
    provider: p.provider ?? "gemini",
    promptId: p.promptId ?? null,
    promptType: p.promptType ?? "discovery",
    measurementType: p.measurementType ?? "api",
    status: p.status ?? "ok",
    grounded: p.grounded ?? true,
    runId: p.runId ?? "run1",
    createdAt: p.createdAt ?? "2026-09-30T00:00:00.000Z",
    brands:
      p.status === "failed"
        ? []
        : [
            { brandKey: "self", isSelf: true, mentioned: sm, cited: sc },
            { brandKey: "Brass Co", isSelf: false, mentioned: cm, cited: cc },
          ],
  };
}

describe("geo-analysis: metrics formulas", () => {
  it("ratio: denominator 0 => null (unavailable, not zero)", () => {
    expect(ratio(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(ratio(1, 4).value).toBe(0.25);
    expect(METRICS_VERSION).toMatch(/^geo-metrics-/);
  });

  it("mention and citation rates exclude failed/incomplete and ungrounded responses", () => {
    const sample = [
      obs({ self: [true, true] }),
      obs({ self: [true, false], grounded: false }),
      obs({ self: [false, false] }),
      obs({ status: "failed", grounded: false }),
      obs({ status: "incomplete", self: [false, false] }),
    ];
    expect(mentionRate(sample)).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });
    expect(citationRate(sample)).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(smallSampleWarning(mentionRate(sample))).toBe(true);
  });

  it("zero denominators give null rates", () => {
    expect(mentionRate([obs({ status: "failed" })]).value).toBeNull();
    expect(citationRate([obs({ grounded: false, self: [true, false] })])).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(shareOfVoice([obs({})], ["self", "Brass Co"]).every((s) => s.ratio.value === null)).toBe(true);
  });

  it("share of voice uses binary response-level mentions over tracked brands", () => {
    const s = shareOfVoice([obs({ self: [true, false], comp: [true, false] }), obs({ comp: [true, false] }), obs({ comp: [true, false] })], ["self", "Brass Co"]);
    expect(s).toEqual([
      { brandKey: "self", ratio: { numerator: 1, denominator: 4, value: 0.25 } },
      { brandKey: "Brass Co", ratio: { numerator: 3, denominator: 4, value: 0.75 } },
    ]);
  });

  it("discovery and reputation prompts are never mixed; manual imports never enter API metrics", () => {
    const sample = [obs({ self: [false, false] }), obs({ self: [true, false], promptType: "reputation" }), obs({ self: [true, false], measurementType: "manual_import", cohortKey: "manual:x" })];
    expect(mentionRate(sample)).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(mentionRate(sample, "self", { promptType: "reputation" })).toEqual({ numerator: 1, denominator: 1, value: 1 });
  });

  it("refuses to mix cohorts and annotates cohort changes in trends", () => {
    expect(() => mentionRate([obs({ cohortKey: "A" }), obs({ cohortKey: "B" })])).toThrow(CrossCohortError);
    const trend = buildTrend([
      obs({ cohortKey: "A", runId: "r1", createdAt: "2026-09-01T00:00:00Z", self: [true, false] }),
      obs({ cohortKey: "A", runId: "r2", createdAt: "2026-09-08T00:00:00Z" }),
      obs({ cohortKey: "B", runId: "r3", createdAt: "2026-09-15T00:00:00Z", self: [true, true] }),
    ]);
    expect(trend.map((t) => [t.cohortKey, t.annotation !== null])).toEqual([["A", false], ["A", false], ["B", true]]);
    expect(compareRates({ cohortKey: "A", ratio: trend[1]!.mentionRate }, { cohortKey: "B", ratio: trend[2]!.mentionRate })).toBeNull();
    expect(compareRates({ cohortKey: "A", ratio: trend[0]!.mentionRate }, { cohortKey: "A", ratio: trend[1]!.mentionRate })).toBe(-1);
  });
});

describe("geo-analysis: brand-blind prompts", () => {
  it("flags brand names, aliases, competitor names and domains; allows generic prompts", () => {
    expect(brandBlindViolations("Where can I buy solid brass cabinet hardware?", project)).toEqual([]);
    expect(brandBlindViolations("Is resex any good?", project).map((v) => v.term)).toEqual(["ResEx"]);
    expect(brandBlindViolations("Brass Co alternatives", project)[0]!.brandKey).toBe("Brass Co");
    expect(brandBlindViolations("reviews of shop.example.com", project).map((v) => v.kind)).toContain("domain");
  });
});

describe("geo-analysis: question versions [A13]", () => {
  // Snapshot of question_version per GEO question. Changing any wording/options/levels changes the
  // hash: update this map ONLY together with a deliberate version bump (new cohort for calibration).
  const EXPECTED: Record<GeoQuestionId, string> = {
    "geo.mention_adjudication": "d3b0d4aa06b8cceb",
    "geo.recommendation_status": "c652607b7cd8e458",
    "geo.brand_sentiment": "2dd9161241fabc52",
    "geo.source_type": "fac477e80a401d22",
    "geo.proposal_fit": "a00704c5d0da16d7",
    "evidence.injection_risk": "88cf9cacafc5c945",
  };
  it("every Choice has an escape option and versions match the snapshot", async () => {
    for (const [id, q] of Object.entries(GEO_QUESTION_TEMPLATES)) {
      if (q.type === "choice") expect(Object.keys(q.criteria).some((k) => ["unclear", "unknown", "other", "not_mentioned", "insufficient_context", "none"].includes(k))).toBe(true);
      const v = await geoQuestionVersion(id as GeoQuestionId);
      expect(v).toMatch(/^[0-9a-f]{16}$/);
      expect({ id, v }).toEqual({ id, v: EXPECTED[id as GeoQuestionId] });
    }
  });
});
