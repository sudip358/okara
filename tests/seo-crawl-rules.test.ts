import { describe, expect, it } from "vitest";
import { RULES, runRules, TEMPLATE_MIN_URLS, type RuleInput, type RuleSnapshot } from "@worker/seo/rules/registry";
import { AI_CRAWLERS, evaluateAiCrawlerAccess } from "@worker/seo/rules/ai-crawlers";
import { parseRobots, type RobotsState } from "@worker/seo/crawl/robots";
import type { PageType } from "@shared/types";

const H = "shop.example.com";
const U = (p: string) => `https://${H}${p}`;

function snap(path: string, over: Partial<RuleSnapshot> = {}): RuleSnapshot {
  const url = U(path);
  return {
    url,
    finalUrl: url,
    statusCode: 200,
    pageType: "other",
    skippedReason: null,
    title: `Title for ${path}`,
    metaDescription: `Description for ${path}`,
    h1s: [`Heading ${path}`],
    headings: [{ level: 1, text: `Heading ${path}` }, { level: 2, text: "Sub" }],
    canonical: url,
    robotsMeta: null,
    jsonLdTypes: [],
    jsonLdIssues: [],
    internalLinks: [],
    wordCount: 400,
    firstParagraph: "An introductory paragraph with more than ten words describing this page clearly.",
    contentHash: `hash-${path}`,
    textHash: `text-${path}`,
    ...over,
  };
}

const product = (path: string, over: Partial<RuleSnapshot> = {}) =>
  snap(path, {
    pageType: "product",
    jsonLdTypes: ["Product"],
    ...over,
  });

const robotsOk = (text: string): RobotsState => ({ status: "ok", httpStatus: 200, parsed: parseRobots(text), note: "" });

function input(snapshots: RuleSnapshot[], over: Partial<RuleInput> = {}): RuleInput {
  return { siteType: "ecommerce", verifiedHost: H, snapshots, sitemapUrls: [], robots: robotsOk(""), aiCrawlerAccess: null, ...over };
}

const firing = (inp: RuleInput, ruleId: string) => runRules(inp).filter((f) => f.ruleId === ruleId);

const aiAccess = (robotsTxt: string) => evaluateAiCrawlerAccess(robotsOk(robotsTxt), { present: false, notes: [] }, U("/"));

/** Positive and negative fixtures for every registered rule. Adding a rule without a case fails the registry test. */
const CASES: Record<string, { positive: RuleInput; negative: RuleInput }> = {
  "SEO-TITLE-MISSING": { positive: input([snap("/a", { title: null })]), negative: input([snap("/a")]) },
  "SEO-TITLE-DUPLICATE": {
    positive: input([snap("/a", { title: "Same" }), snap("/b", { title: "same " })]),
    negative: input([snap("/a", { title: "Same" }), snap("/b", { title: "Same", canonical: U("/a") })]),
  },
  "SEO-META-DESC-MISSING": { positive: input([snap("/a", { metaDescription: "" })]), negative: input([snap("/a")]) },
  "SEO-META-DESC-DUPLICATE": {
    positive: input([snap("/a", { metaDescription: "D" }), snap("/b", { metaDescription: "D" })]),
    negative: input([snap("/a"), snap("/b")]),
  },
  "SEO-H1-MISSING": { positive: input([snap("/a", { h1s: [] })]), negative: input([snap("/a")]) },
  "SEO-H1-MULTIPLE": { positive: input([snap("/a", { h1s: ["x", "y"] })]), negative: input([snap("/a")]) },
  "SEO-HEADING-SKIP": {
    positive: input([snap("/a", { headings: [{ level: 1, text: "x" }, { level: 3, text: "y" }] })]),
    negative: input([snap("/a", { headings: [{ level: 1, text: "x" }, { level: 2, text: "y" }, { level: 3, text: "z" }, { level: 2, text: "w" }] })]),
  },
  "SEO-CANONICAL-MISSING": { positive: input([snap("/a", { canonical: null })]), negative: input([snap("/a")]) },
  "SEO-CANONICAL-OFFHOST": {
    positive: input([snap("/a", { canonical: "https://www.other.example/a" })]),
    negative: input([snap("/a", { canonical: "https://SHOP.example.com/a" })]),
  },
  "SEO-CANONICAL-TARGET-BAD": {
    positive: input([snap("/a", { canonical: U("/b") }), snap("/b", { statusCode: 404, title: null })]),
    negative: input([snap("/a", { canonical: U("/b") }), snap("/b")]),
  },
  "SEO-NOINDEX": { positive: input([snap("/a", { robotsMeta: "noindex, follow" })]), negative: input([snap("/a", { robotsMeta: "index, follow" })]) },
  "SEO-STATUS-4XX": { positive: input([snap("/gone", { statusCode: 404 })]), negative: input([snap("/a")]) },
  "SEO-STATUS-5XX": { positive: input([snap("/err", { statusCode: 503 })]), negative: input([snap("/a")]) },
  "SEO-LINK-BROKEN-INTERNAL": {
    positive: input([snap("/a", { internalLinks: [U("/gone")] }), snap("/gone", { statusCode: 404 })]),
    negative: input([snap("/a", { internalLinks: [U("/b"), U("/uncrawled")] }), snap("/b")]),
  },
  "SEO-CONTENT-THIN": {
    positive: input([snap("/blog/a", { pageType: "article", wordCount: 80 })]),
    negative: input([product("/products/a", { wordCount: 40, jsonLdTypes: ["Product"] })]),
  },
  "SEO-CONTENT-DUPLICATE": {
    positive: input([snap("/a", { textHash: "same" }), snap("/b", { textHash: "same" })]),
    negative: input([snap("/a", { textHash: "same" }), snap("/b", { textHash: "same", canonical: U("/a") })]),
  },
  "SEO-ROBOTS-SITEMAP-CONFLICT": {
    positive: input([snap("/")], { sitemapUrls: [U("/private/x")], robots: robotsOk("User-agent: *\nDisallow: /private/") }),
    negative: input([snap("/")], { sitemapUrls: [U("/public/x")], robots: robotsOk("User-agent: *\nDisallow: /private/") }),
  },
  "SEO-JSONLD-INVALID": {
    positive: input([snap("/a", { jsonLdIssues: [{ type: "(unparsed)", issue: "invalid_json", detail: "" }] })]),
    negative: input([snap("/a")]),
  },
  "ECOM-PRODUCT-JSONLD-MISSING": {
    positive: input([product("/products/a", { jsonLdTypes: ["BreadcrumbList"] })]),
    negative: input([product("/products/a", { jsonLdTypes: ["BreadcrumbList"] })], { siteType: "saas" }),
  },
  "ECOM-PRODUCT-OFFER-INCOMPLETE": {
    positive: input([product("/products/a", { jsonLdIssues: [{ type: "Product", issue: "missing_offers", detail: "Product has no offers." }] })]),
    negative: input([product("/products/a")]),
  },
  "ECOM-COLLECTION-NO-INTRO": {
    positive: input([snap("/collections/a", { pageType: "collection", firstParagraph: null, wordCount: 30 })]),
    negative: input([snap("/collections/a", { pageType: "collection" })]),
  },
  "ECOM-FACETED-NO-CANONICAL": {
    positive: input([snap("/collections/a?filter.p.color=red&sort_by=price", { pageType: "collection", canonical: U("/collections/a?filter.p.color=red&sort_by=price") })]),
    negative: input([snap("/collections/a?filter.p.color=red", { pageType: "collection", canonical: U("/collections/a") }), snap("/collections/a?page=2", { canonical: U("/collections/a?page=2") })]),
  },
  "ECOM-VARIANT-NO-CANONICAL": {
    positive: input([product("/products/a?variant=1", { canonical: null })]),
    negative: input([product("/products/a?variant=1", { canonical: U("/products/a") })]),
  },
  "AI-SEARCH-CRAWLER-BLOCKED": {
    positive: input([snap("/")], { aiCrawlerAccess: aiAccess("User-agent: OAI-SearchBot\nDisallow: /") }),
    negative: input([snap("/")], { aiCrawlerAccess: aiAccess("User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /") }),
  },
};

describe("seo-crawl rule registry [A16]", () => {
  it("every registered rule has a stable id, metadata, and an emitter", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of RULES) {
      expect(r.id).toMatch(/^[A-Z]+(-[A-Z0-9]+)+$/);
      expect(typeof r.emit).toBe("function");
      expect(r.name.length).toBeGreaterThan(3);
      expect(r.applicability.length).toBeGreaterThan(10);
      expect(["fact", "heuristic"]).toContain(r.class);
      expect(["critical", "major", "moderate", "minor", "advisory"]).toContain(r.severity);
      expect(() => r.emit({ ...input([]), pages: [], all: [] })).not.toThrow();
    }
  });

  it("every registered rule has a positive and negative fixture (no rule without a firing emitter)", () => {
    expect(Object.keys(CASES).sort()).toEqual(RULES.map((r) => r.id).sort());
  });

  for (const [ruleId, c] of Object.entries(CASES)) {
    it(`${ruleId} fires on its positive fixture and not on its negative`, () => {
      expect(firing(c.positive, ruleId).length).toBeGreaterThan(0);
      expect(firing(c.negative, ruleId)).toEqual([]);
    });
  }

  it("uses the documented classes and severities for H1 and noindex", () => {
    const get = (id: string) => RULES.find((r) => r.id === id)!;
    expect(get("SEO-H1-MISSING")).toMatchObject({ class: "heuristic", severity: "moderate" });
    expect(get("SEO-H1-MISSING").applicability).toMatch(/not automatically a ranking failure/);
    expect(get("SEO-H1-MULTIPLE").severity).toBe("minor");
    expect(get("SEO-NOINDEX")).toMatchObject({ class: "fact", severity: "major" });
    expect(get("SEO-HEADING-SKIP").severity).toBe("advisory");
  });

  it("skips e-commerce rules for non-ecommerce sites and content rules for skipped/redirected pages", () => {
    const f = runRules(input([product("/products/a", { jsonLdTypes: [] }), snap("/js", { skippedReason: "js_rendered", title: null }), snap("/r", { statusCode: 301, finalUrl: U("/b"), title: null })], { siteType: "publisher" }));
    expect(f.filter((x) => x.ruleId.startsWith("ECOM-"))).toEqual([]);
    expect(f.filter((x) => x.ruleId === "SEO-TITLE-MISSING")).toEqual([]);
  });
});

describe("seo-crawl template grouping [A9]", () => {
  it("10 product pages missing offers produce findings labelled 'product template'", () => {
    const pages = Array.from({ length: 10 }, (_, i) =>
      product(`/products/p${i}`, { jsonLdIssues: [{ type: "Product", issue: "missing_offers", detail: "Product has no offers." }] }),
    );
    const f = firing(input([snap("/", { pageType: "home" }), ...pages]), "ECOM-PRODUCT-OFFER-INCOMPLETE");
    expect(f).toHaveLength(10);
    expect(new Set(f.map((x) => x.template))).toEqual(new Set(["product template"]));
    expect(f[0]!.evidence.templateAffectedUrls).toBe(10);
    expect(f.every((x) => x.severity === "moderate")).toBe(true);
  });

  it(`does not label a template below ${TEMPLATE_MIN_URLS} URLs or for non-templated page types`, () => {
    const two = [0, 1].map((i) => product(`/products/p${i}`, { canonical: null }));
    expect(firing(input(two), "SEO-CANONICAL-MISSING").every((x) => x.template === null)).toBe(true);
    const others = [0, 1, 2, 3].map((i) => snap(`/x${i}`, { canonical: null, pageType: "other" as PageType }));
    expect(firing(input(others), "SEO-CANONICAL-MISSING").every((x) => x.template === null)).toBe(true);
  });
});

describe("seo-crawl AI crawler access [A19]", () => {
  it("lists only vendor-documented tokens with source URLs and purposes", () => {
    const tokens = AI_CRAWLERS.map((c) => c.token);
    expect(tokens).toEqual(expect.arrayContaining(["GPTBot", "OAI-SearchBot", "ClaudeBot", "Claude-SearchBot", "PerplexityBot", "Google-Extended"]));
    for (const c of AI_CRAWLERS) expect(c.sourceUrl).toMatch(/^https:\/\//);
    expect(AI_CRAWLERS.find((c) => c.token === "GPTBot")!.purpose).toBe("training");
    expect(AI_CRAWLERS.find((c) => c.token === "OAI-SearchBot")!.purpose).toBe("answer_search");
  });

  it("a robots.txt blocking only training crawlers produces no defect finding", () => {
    const access = aiAccess("User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: Google-Extended\nDisallow: /\n\nUser-agent: *\nAllow: /");
    expect(access.crawlers.find((c) => c.token === "GPTBot")!.allowed).toBe(false);
    expect(access.crawlers.find((c) => c.token === "OAI-SearchBot")!.allowed).toBe(true);
    const f = runRules(input([snap("/")], { aiCrawlerAccess: access }));
    expect(f.filter((x) => x.ruleId.startsWith("AI-"))).toEqual([]);
    expect(access.advisory.join(" ")).toMatch(/not a defect/);
    expect(access.advisory.join(" ")).not.toMatch(/GPTBot/);
  });

  it("an unreachable robots.txt reports unknown (null) access", () => {
    const access = evaluateAiCrawlerAccess({ status: "unreachable", httpStatus: 503, parsed: { groups: [], sitemaps: [] }, note: "" }, { present: false, notes: [] });
    expect(access.crawlers.every((c) => c.allowed === null)).toBe(true);
  });
});
