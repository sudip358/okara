import { describe, expect, it } from "vitest";
import { validateDraft, normalizeNumber, type ValidationEvidence } from "@worker/writing/validate";
import { recommendationOutputSchema, recommendationTextFields, toProviderSchema, RECOMMENDATION_V1_JSON_SCHEMA, discoveryPromptsOutputSchema } from "@worker/writing/schemas";
import { SEO_WRITER_SYSTEM, GEO_WRITER_SYSTEM, PROMPT_GENERATOR_SYSTEM } from "@worker/writing/prompts";

const ev: ValidationEvidence[] = [
  { id: "ev_gsc1", text: "Query 'brass cabinet knobs': 1,234 impressions, 12 clicks, CTR 0.97%, position 8.4 (2026-08-30..2026-09-26)" },
  { id: "ev_crawl1", text: "Title: 'Knobs' on https://shop.example.com/collections/knobs", data: { wordCount: 42, h1: ["Cabinet Knobs"] } },
  { id: "ev_spec", text: "Product spec: solid brass, 1.25 in diameter, UL listed, damp-rated, dimmable, 800 lumens, 2700K, 5-year warranty, lead time 3 weeks, IP44, $1,299.00" },
];

describe("validateDraft [A10]/[A17]", () => {
  it("accepts a draft whose facts and numbers all come from cited evidence", () => {
    const r = validateDraft(
      [
        "The query 'brass cabinet knobs' had 1234 impressions and a 0.97% CTR at position 8.4 from 2026-08-30 to 2026-09-26 [ev_gsc1].",
        "Rewrite the H1 and title on https://shop.example.com/collections/knobs [ev_crawl1].",
      ],
      ["ev_gsc1", "ev_crawl1"],
      ev,
    );
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects unknown evidence ids, declared or inline", () => {
    const r = validateDraft(["See [ev_missing] and [ev_gsc1, ev_nope]."], ["ev_gsc1", "ev_ghost"], ev);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("Unknown evidence id cited: ev_ghost");
    expect(r.errors).toContain("Unknown evidence id referenced in text: ev_missing");
    expect(r.errors).toContain("Unknown evidence id referenced in text: ev_nope");
  });

  it("rejects numbers absent from cited evidence (even if present in uncited evidence)", () => {
    const r = validateDraft(["Impressions grew 45% to 1,500 [ev_gsc1]. Diameter is 1.25 in."], ["ev_gsc1"], ev);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("Number not present in cited evidence: 45");
    expect(r.errors).toContain("Number not present in cited evidence: 1,500");
    // 1.25 is only in ev_spec, which is not cited
    expect(r.errors).toContain("Number not present in cited evidence: 1.25");
  });

  it("normalizes number formats: 1,234 == 1234, 12.50 == 12.5, $1,299.00 == 1299", () => {
    expect(normalizeNumber("1,234")).toBe(1234);
    const r = validateDraft(["Priced at $1299 with 800 lumens and 2700K [ev_spec]."], ["ev_spec"], ev);
    expect(r.errors).toEqual([]);
    const r2 = validateDraft(["1234 impressions [ev_gsc1]"], ["ev_gsc1"], ev);
    expect(r2.ok).toBe(true);
  });

  it("checks dimensions like 12 x 18 in", () => {
    const r = validateDraft(["Offer the 12 x 18 in size [ev_spec]."], ["ev_spec"], ev);
    expect(r.errors).toContain("Number not present in cited evidence: 12");
    expect(r.errors).toContain("Number not present in cited evidence: 18");
  });

  it("does not treat H1, IP44-style tokens, or evidence ids as bare numbers", () => {
    const r = validateDraft(["Add a single H1 to the page [ev_crawl1]."], ["ev_crawl1"], ev);
    expect(r.ok).toBe(true);
  });

  it("rejects certification/spec terms not present in cited evidence", () => {
    const r = validateDraft(
      ["These sconces are UL listed, ETL certified, wet-rated, IP65, dimmable, and ship with a warranty [ev_crawl1]."],
      ["ev_crawl1"],
      ev,
    );
    expect(r.ok).toBe(false);
    const joined = r.errors.join("\n");
    for (const label of ["UL listing", "ETL listing", "wet rating", "IP rating", "dimmable", "warranty"]) expect(joined).toContain(label);
  });

  it("accepts certification terms that are in cited evidence, but not a different IP rating", () => {
    const ok = validateDraft(["UL listed, damp-rated, dimmable, IP44, 5-year warranty, lead time 3 weeks [ev_spec]."], ["ev_spec"], ev);
    expect(ok.errors).toEqual([]);
    const bad = validateDraft(["Rated IP65 [ev_spec]."], ["ev_spec"], ev);
    expect(bad.errors.join()).toContain("IP rating");
  });

  it("rejects guarantee and ranking-promise language; negated wording is only a warning", () => {
    const r = validateDraft(
      ["This change guarantees results and will rank the page. It ensures inclusion and secures a #1 ranking [ev_gsc1]."],
      ["ev_gsc1"],
      ev,
    );
    expect(r.ok).toBe(false);
    const joined = r.errors.join("\n");
    expect(joined).toContain("guarantee language");
    expect(joined).toContain("ranking promise");
    expect(joined).toContain("inclusion promise");
    expect(joined).toContain("#1 ranking promise");
    const neg = validateDraft(["Adding FAQ schema does not guarantee inclusion [ev_gsc1]."], ["ev_gsc1"], ev);
    expect(neg.ok).toBe(true);
    expect(neg.warnings.join()).toContain("Negated");
  });

  it("extracts [confirm: ...] placeholders and ignores their contents for fact checks", () => {
    const r = validateDraft(
      ["Add the fixture's rating [confirm: UL or ETL listing and IP rating] and size [confirm: 24 in width] [ev_crawl1]."],
      ["ev_crawl1"],
      ev,
    );
    expect(r.ok).toBe(true);
    expect(r.confirmPlaceholders).toEqual(["UL or ETL listing and IP rating", "24 in width"]);
  });

  it("requires at least one cited evidence id", () => {
    expect(validateDraft(["Improve the title."], [], ev).errors).toContain("No evidence cited.");
  });

  it("uses evidence data (JSON) as part of the corpus", () => {
    expect(validateDraft(["The page has 42 words [ev_crawl1]."], ["ev_crawl1"], ev).ok).toBe(true);
  });

  it("warns on URLs that are not in cited evidence", () => {
    const r = validateDraft(["Link from https://other.example.com/page [ev_crawl1]."], ["ev_crawl1"], ev);
    expect(r.warnings.join()).toContain("URL not found");
  });
});

describe("writer schemas and prompts", () => {
  const valid = {
    agent: "seo",
    scope: "page",
    target: { kind: "url", url: "https://shop.example.com/collections/knobs" },
    trigger: "From GSC query brass cabinet knobs",
    issue: "Weak CTR",
    evidence_ids: ["ev_gsc1"],
    action: "Rewrite the title",
    rationale: "Evidence suggests the title may not match the query [ev_gsc1].",
    effort: "low",
    uncertainty: "medium",
    limitations: "Single window.",
    verified: true,
  };

  it("zod schema accepts recommendation.v1 output and rejects extras/limits", () => {
    expect(recommendationOutputSchema.safeParse(valid).success).toBe(true);
    expect(recommendationOutputSchema.safeParse({ ...valid, priority: 5 }).success).toBe(false);
    expect(recommendationOutputSchema.safeParse({ ...valid, evidence_ids: [] }).success).toBe(false);
    expect(recommendationOutputSchema.safeParse({ ...valid, trigger: "x".repeat(201) }).success).toBe(false);
    const parsed = recommendationOutputSchema.parse(valid);
    expect(recommendationTextFields(parsed)).toContain("Rewrite the title");
  });

  it("provider schema strips unsupported constraints and closes every object", () => {
    const s = toProviderSchema(RECOMMENDATION_V1_JSON_SCHEMA) as any;
    const text = JSON.stringify(s);
    for (const k of ["maxLength", "minItems", "maxItems", "minimum", "$schema", "$id"]) expect(text).not.toContain(`"${k}"`);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.target.additionalProperties).toBe(false);
    expect(s.properties.evidence_bullets.items.additionalProperties).toBe(false);
    expect(RECOMMENDATION_V1_JSON_SCHEMA.properties.trigger.maxLength).toBe(200); // original untouched
  });

  it("discovery prompt parser accepts the array form and the wrapped form", () => {
    const item = { prompt: "Where can I buy solid brass cabinet hardware?", stage: "specific requirement", rationale: "r" };
    expect(discoveryPromptsOutputSchema.parse([item])).toHaveLength(1);
    expect(discoveryPromptsOutputSchema.parse({ prompts: [item] })).toHaveLength(1);
  });

  it("prompts are the build-kit texts", () => {
    expect(SEO_WRITER_SYSTEM.startsWith("You write one SEO recommendation for a human reviewer.")).toBe(true);
    expect(GEO_WRITER_SYSTEM).toContain('Describe what was observed as "API-sampled"');
    expect(PROMPT_GENERATOR_SYSTEM).toContain("INPUT: {product_description, audience, locale, site_type, content_pillars}");
  });
});
