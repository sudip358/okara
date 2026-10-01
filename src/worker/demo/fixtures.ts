/**
 * Demo fixture content (DEMO_MODE only). A fictional home-furnishings store on the reserved `demo.example`
 * host; every competitor and citation uses reserved `.example` hosts. Nothing here is a real brand,
 * a real measurement, or a real provider answer. All text is labelled as demo data.
 */
import type { ProjectInput, SourceType } from "@shared/types";

export const DEMO_LABEL = "Demo data - simulated run";
export const DEMO_MODEL = "demo-fixture";
export const DEMO_HOST = "demo.example";
export const DEMO_ORIGIN = `https://${DEMO_HOST}`;
export const DEMO_BRAND = "Demo Furnishings";

export const DEMO_PROJECT: ProjectInput = {
  name: "Demo Furnishings (demo data)",
  siteUrl: DEMO_ORIGIN,
  siteType: "ecommerce",
  brandName: DEMO_BRAND,
  brandAliases: ["DemoFurnishings"],
  competitors: [
    { name: "Sample Sofa Co", domains: ["sofa-sample.example"], aliases: ["SampleSofa"] },
    { name: "Example Lamp House", domains: ["lamp-house.example"], aliases: [] },
  ],
  productDescription: `(${DEMO_LABEL}) Fictional online store selling washable linen slipcover sofas, solid oak side tables, and brass table lamps.`,
  audience: `(${DEMO_LABEL}) Fictional audience: families furnishing small living rooms who want washable, durable furniture.`,
  locale: "en-US",
  language: "en",
  voice: `(${DEMO_LABEL}) Plain, practical, no superlatives.`,
};

export interface DemoPage {
  path: string;
  pageType: "home" | "collection" | "product" | "article" | "landing" | "other";
  method: string;
  title: string;
  metaDescription: string | null;
  h1: string[];
  jsonldTypes: string[];
  jsonldIssues: Array<{ type: string; issue: "missing_offers"; detail: string }>;
  wordCount: number;
  excerpt: string;
  firstParagraph: string;
}

const d = (s: string) => `${s} [${DEMO_LABEL}]`;

export const DEMO_PAGES: DemoPage[] = [
  {
    path: "/",
    pageType: "home",
    method: "url_pattern",
    title: "Demo Furnishings | Washable sofas, oak tables and brass lamps",
    metaDescription: "Fictional demo store: washable linen sofas, solid oak side tables, and brass table lamps.",
    h1: ["Furniture for real living rooms"],
    jsonldTypes: ["Organization", "WebSite"],
    jsonldIssues: [],
    wordCount: 420,
    excerpt: d("Furniture for real living rooms. Washable linen slipcovers, solid oak, and brass lamps."),
    firstParagraph: d("Furniture for real living rooms."),
  },
  {
    path: "/collections/sofas",
    pageType: "collection",
    method: "url_pattern",
    title: "Sofas | Demo Furnishings",
    metaDescription: null,
    h1: ["Sofas"],
    jsonldTypes: ["CollectionPage"],
    jsonldIssues: [],
    wordCount: 310,
    excerpt: d("Linen slipcover sofas with removable, machine-washable covers."),
    firstParagraph: d("Linen slipcover sofas with removable covers."),
  },
  {
    path: "/collections/table-lamps",
    pageType: "collection",
    method: "url_pattern",
    title: "Table Lamps | Demo Furnishings",
    metaDescription: "Fictional demo collection of brass table lamps.",
    h1: ["Table Lamps"],
    jsonldTypes: ["CollectionPage"],
    jsonldIssues: [],
    wordCount: 45,
    excerpt: d("Product grid only; no introductory copy."),
    firstParagraph: "",
  },
  {
    path: "/products/linen-slipcover-sofa",
    pageType: "product",
    method: "jsonld",
    title: "Linen Slipcover Sofa | Demo Furnishings",
    metaDescription: "Fictional demo product: three-seat sofa with a washable linen slipcover.",
    h1: ["Linen Slipcover Sofa"],
    jsonldTypes: ["Product"],
    jsonldIssues: [{ type: "Product", issue: "missing_offers", detail: "Product has no offers (price, priceCurrency, availability)." }],
    wordCount: 380,
    excerpt: d("Three-seat sofa with a removable linen slipcover."),
    firstParagraph: d("Three-seat sofa with a removable linen slipcover."),
  },
  {
    path: "/products/oak-side-table",
    pageType: "product",
    method: "jsonld",
    title: "Oak Side Table | Demo Furnishings",
    metaDescription: "Fictional demo product: solid oak side table.",
    h1: ["Oak Side Table"],
    jsonldTypes: ["Product"],
    jsonldIssues: [{ type: "Product", issue: "missing_offers", detail: "Product has no offers (price, priceCurrency, availability)." }],
    wordCount: 260,
    excerpt: d("Solid oak side table with an oiled finish."),
    firstParagraph: d("Solid oak side table with an oiled finish."),
  },
  {
    path: "/products/brass-table-lamp",
    pageType: "product",
    method: "jsonld",
    title: "Brass Table Lamp | Demo Furnishings",
    metaDescription: "Fictional demo product: brass table lamp with linen shade.",
    h1: ["Brass Table Lamp"],
    jsonldTypes: ["Product"],
    jsonldIssues: [{ type: "Product", issue: "missing_offers", detail: "Product has no offers (price, priceCurrency, availability)." }],
    wordCount: 190,
    excerpt: d("Brass table lamp with a linen shade. Bulb compatibility is not stated on the page."),
    firstParagraph: d("Brass table lamp with a linen shade."),
  },
  {
    path: "/blog/how-to-choose-a-washable-sofa",
    pageType: "article",
    method: "url_pattern",
    title: "How to choose a washable sofa | Demo Furnishings",
    metaDescription: "Fictional demo article on choosing a washable sofa.",
    h1: ["How to choose a washable sofa"],
    jsonldTypes: ["Article"],
    jsonldIssues: [],
    wordCount: 1150,
    excerpt: d("Look for removable covers, pre-washed fabric, and replaceable cushions."),
    firstParagraph: d("A washable sofa starts with a removable cover."),
  },
  {
    path: "/pages/about",
    pageType: "landing",
    method: "url_pattern",
    title: "About | Demo Furnishings",
    metaDescription: "About the fictional Demo Furnishings store.",
    h1: [],
    jsonldTypes: [],
    jsonldIssues: [],
    wordCount: 240,
    excerpt: d("About this fictional store."),
    firstParagraph: d("About this fictional store."),
  },
];

/** Rule IDs and severities follow src/worker/seo/rules/registry.ts. */
export interface DemoFinding {
  ruleId: string;
  severity: "critical" | "major" | "moderate" | "minor" | "advisory";
  path: string | null;
  template: string | null;
  detail: string;
}

export const DEMO_FINDINGS: DemoFinding[] = [
  ...["/products/linen-slipcover-sofa", "/products/oak-side-table", "/products/brass-table-lamp"].map((path) => ({
    ruleId: "ECOM-PRODUCT-OFFER-INCOMPLETE",
    severity: "moderate" as const,
    path,
    template: "product template",
    detail: d("Product JSON-LD is present but has no offers (price, priceCurrency, availability)."),
  })),
  { ruleId: "SEO-META-DESC-MISSING", severity: "minor", path: "/collections/sofas", template: null, detail: d("No meta description found.") },
  { ruleId: "ECOM-COLLECTION-NO-INTRO", severity: "minor", path: "/collections/table-lamps", template: "collection template", detail: d("Collection page has a product grid but no introductory copy (45 words).") },
  { ruleId: "SEO-H1-MISSING", severity: "moderate", path: "/pages/about", template: null, detail: d("No H1 found. A missing H1 is not by itself a ranking failure.") },
];

/** GSC query/page rows: [query, path, current clicks, current impressions, current position, previous clicks, previous impressions, previous position]. */
export const DEMO_GSC_ROWS: Array<[string, string, number, number, number, number, number, number]> = [
  ["washable linen sofa", "/collections/sofas", 38, 4120, 6.8, 44, 3610, 7.4],
  ["linen slipcover sofa", "/products/linen-slipcover-sofa", 61, 1880, 4.2, 55, 1720, 4.6],
  ["oak side table", "/products/oak-side-table", 22, 1340, 9.3, 25, 1290, 8.8],
  ["brass table lamp", "/products/brass-table-lamp", 17, 2210, 11.6, 21, 2050, 10.9],
  ["how to choose a washable sofa", "/blog/how-to-choose-a-washable-sofa", 74, 2980, 5.1, 59, 2540, 5.9],
  ["demo furnishings", "/", 140, 520, 1.2, 131, 480, 1.3],
  ["table lamps for reading", "/collections/table-lamps", 4, 960, 17.4, 6, 880, 16.2],
  ["pet friendly sofa fabric", "/blog/how-to-choose-a-washable-sofa", 9, 1410, 12.8, 7, 1100, 14.1],
];

export const DEMO_PROMPTS: Array<{ text: string; stage: string }> = [
  { text: "What are the best washable sofas for homes with kids and pets?", stage: "consideration" },
  { text: "Which table lamps work well for reading in a small living room?", stage: "consideration" },
  { text: "Where can I buy a solid oak side table online?", stage: "decision" },
  { text: "What should I look for when choosing a linen slipcover sofa?", stage: "awareness" },
  { text: "Which online stores sell mid-century style furniture at moderate prices?", stage: "consideration" },
];

export interface DemoCitation {
  url: string;
  title: string;
  brandKey: string | null;
  sourceType: SourceType;
}

export interface DemoAnswer {
  provider: "gemini" | "perplexity";
  status: "ok" | "failed";
  text: string | null;
  citations: DemoCitation[];
  searchQueries: string[] | null;
  /** brand key -> { recommendation status, list rank, sentiment } for brands named in the text */
  mentions: Record<string, { status: "recommended" | "listed_neutral"; rank: number | null; sentiment: "positive" | "neutral" }>;
  displacement: { entity: string; url: string; sourceType: SourceType; span: string } | null;
  error?: string;
}

const pre = `[${DEMO_LABEL}; not a real provider answer] `;

/** Answers indexed by prompt position (0..4), one per provider. */
export const DEMO_ANSWERS: DemoAnswer[][] = [
  [
    {
      provider: "gemini",
      status: "ok",
      text: `${pre}Popular washable options include Sample Sofa Co, whose slipcovers are listed as machine washable, and performance-fabric sofas from larger retailers.`,
      citations: [
        { url: "https://top-sofas-roundup.example/best-washable-sofas", title: "Best washable sofas (demo roundup)", brandKey: null, sourceType: "listicle_roundup" },
        { url: "https://sofa-sample.example/slipcover-sofas", title: "Slipcover sofas (demo)", brandKey: "Sample Sofa Co", sourceType: "brand_page" },
      ],
      searchQueries: ["best washable sofas kids pets", "machine washable slipcover sofa"],
      mentions: { "Sample Sofa Co": { status: "recommended", rank: null, sentiment: "positive" } },
      displacement: { entity: "Sample Sofa Co", url: "https://top-sofas-roundup.example/best-washable-sofas", sourceType: "listicle_roundup", span: "Sample Sofa Co, whose slipcovers are listed as machine washable" },
    },
    {
      provider: "perplexity",
      status: "ok",
      text: `${pre}Reviewers often point to Sample Sofa Co for families because the covers can be removed and washed.`,
      citations: [{ url: "https://home-reviews.example/sofas/sample-sofa-co", title: "Sample Sofa Co review (demo)", brandKey: "Sample Sofa Co", sourceType: "review_site" }],
      searchQueries: null,
      mentions: { "Sample Sofa Co": { status: "recommended", rank: null, sentiment: "positive" } },
      displacement: { entity: "Sample Sofa Co", url: "https://home-reviews.example/sofas/sample-sofa-co", sourceType: "review_site", span: "Sample Sofa Co for families because the covers can be removed and washed" },
    },
  ],
  [
    {
      provider: "gemini",
      status: "ok",
      text: `${pre}Good reading lamps for small rooms:\n1. Example Lamp House swing-arm lamp\n2. Demo Furnishings brass table lamp with a linen shade\n3. A basic LED desk lamp`,
      citations: [
        { url: "https://lamp-house.example/swing-arm", title: "Swing-arm lamp (demo)", brandKey: "Example Lamp House", sourceType: "brand_page" },
        { url: `${DEMO_ORIGIN}/products/brass-table-lamp`, title: "Brass Table Lamp | Demo Furnishings", brandKey: "self", sourceType: "brand_page" },
      ],
      searchQueries: ["reading lamp small living room"],
      mentions: {
        "Example Lamp House": { status: "recommended", rank: 1, sentiment: "positive" },
        self: { status: "recommended", rank: 2, sentiment: "positive" },
      },
      displacement: null,
    },
    {
      provider: "perplexity",
      status: "ok",
      text: `${pre}For reading in a small room, Example Lamp House sells adjustable lamps with warm light.`,
      citations: [{ url: "https://lamp-house.example/reading-lamps", title: "Reading lamps (demo)", brandKey: "Example Lamp House", sourceType: "brand_page" }],
      searchQueries: null,
      mentions: { "Example Lamp House": { status: "recommended", rank: null, sentiment: "positive" } },
      displacement: { entity: "Example Lamp House", url: "https://lamp-house.example/reading-lamps", sourceType: "brand_page", span: "Example Lamp House sells adjustable lamps with warm light" },
    },
  ],
  [
    {
      provider: "gemini",
      status: "ok",
      text: `${pre}Demo Furnishings sells a solid oak side table online; marketplaces also list oak tables from many makers.`,
      citations: [{ url: "https://marketplace.example/oak-side-tables", title: "Oak side tables (demo marketplace)", brandKey: null, sourceType: "marketplace" }],
      searchQueries: ["buy solid oak side table online"],
      mentions: { self: { status: "listed_neutral", rank: null, sentiment: "neutral" } },
      displacement: null,
    },
    {
      provider: "perplexity",
      status: "ok",
      text: `${pre}Several online stores sell solid oak side tables with oiled finishes.`,
      citations: [{ url: `${DEMO_ORIGIN}/products/oak-side-table`, title: "Oak Side Table | Demo Furnishings", brandKey: "self", sourceType: "brand_page" }],
      searchQueries: null,
      mentions: {},
      displacement: null,
    },
  ],
  [
    {
      provider: "gemini",
      status: "ok",
      text: `${pre}Look for pre-washed linen and removable covers. The Demo Furnishings guide explains how to check cushion construction.`,
      citations: [{ url: `${DEMO_ORIGIN}/blog/how-to-choose-a-washable-sofa`, title: "How to choose a washable sofa | Demo Furnishings", brandKey: "self", sourceType: "brand_page" }],
      searchQueries: ["linen slipcover sofa what to look for"],
      mentions: { self: { status: "recommended", rank: null, sentiment: "positive" } },
      displacement: null,
    },
    {
      provider: "perplexity",
      status: "ok",
      text: `${pre}Forum users recommend Sample Sofa Co slipcovers and suggest checking whether linen is pre-shrunk.`,
      citations: [{ url: "https://forum.example/threads/linen-slipcovers", title: "Linen slipcovers thread (demo)", brandKey: null, sourceType: "forum_ugc" }],
      searchQueries: null,
      mentions: { "Sample Sofa Co": { status: "recommended", rank: null, sentiment: "positive" } },
      displacement: { entity: "Sample Sofa Co", url: "https://forum.example/threads/linen-slipcovers", sourceType: "forum_ugc", span: "Forum users recommend Sample Sofa Co slipcovers" },
    },
  ],
  [
    {
      provider: "gemini",
      status: "ok",
      text: `${pre}Large marketplaces carry mid-century style furniture across many price points.`,
      citations: [{ url: "https://marketplace.example/mid-century", title: "Mid-century furniture (demo marketplace)", brandKey: null, sourceType: "marketplace" }],
      searchQueries: ["mid-century furniture online store moderate price"],
      mentions: {},
      displacement: null,
    },
    {
      provider: "perplexity",
      status: "failed",
      text: null,
      citations: [],
      searchQueries: null,
      mentions: {},
      displacement: null,
      error: `${DEMO_LABEL}: simulated provider timeout (failed runs are not counted as absences).`,
    },
  ],
];

// ------------------------------------------------------------------ SEO judgments (Live view replay)
/**
 * Fictional Jev answers of the demo SEO run, one entry per candidate, in the runtime decision format
 * (recommend/generate.ts recordOutcome: `{answer, candidate, questionTier, key?}`). They feed the Live view
 * panel "Every SEO element, judged one by one" of the labelled demo replay. The seed computes each tier with
 * the real policy (runs/policy.ts tierFor), so tiers and verdicts are consistent with production rules.
 * Kinds and questions follow recommend/decide.ts (e.g. weak_ctr asks title/meta-match, gate kinds ask only
 * their gate question). `path` is relative to DEMO_ORIGIN; `minutesAgo` falls inside the demo run's
 * "decisions" step. `recKey` marks the candidate a demo recommendation was drafted from (its dedup key).
 */
export type DemoJevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

export interface DemoSeoJudgment {
  kind: "weak_ctr" | "answer_clarity" | "freshness" | "schema_mismatch" | "declining" | "coverage_gap";
  path: string;
  recKey?: "url:sofas:meta";
  outcome: "selected" | "rejected";
  reason: "low_fit" | "budget" | null;
  minutesAgo: number;
  questions: Array<{ id: string; key?: string; answer: DemoJevAnswer }>;
}

const noul = (n: number): DemoJevAnswer => ({ type: "noul", noul: n });
const pick = (choice: string, confidence: number, other: string): DemoJevAnswer => ({
  type: "choice",
  choice,
  confidence,
  probabilities: { [choice]: confidence, [other]: Math.round((1 - confidence) * 100) / 100 },
});

export const DEMO_SEO_JUDGMENTS: DemoSeoJudgment[] = [
  { kind: "answer_clarity", path: "/blog/how-to-choose-a-washable-sofa", outcome: "rejected", reason: "low_fit", minutesAgo: 120.76, questions: [{ id: "seo.answer_is_direct", answer: noul(0.91) }] },
  {
    kind: "weak_ctr", path: "/products/brass-table-lamp", outcome: "rejected", reason: "budget", minutesAgo: 120.72,
    questions: [
      { id: "seo.query_page_relevance", answer: noul(0.9) },
      { id: "seo.action_choice", answer: pick("rewrite_title_meta", 0.72, "no_action") },
      { id: "seo.title_matches_query", answer: noul(0.88) },
      { id: "seo.meta_matches_query", answer: noul(0.58) },
    ],
  },
  { kind: "freshness", path: "/blog/how-to-choose-a-washable-sofa", outcome: "rejected", reason: "low_fit", minutesAgo: 120.68, questions: [{ id: "seo.outdated_information", answer: noul(0.07) }] },
  { kind: "schema_mismatch", path: "/products/oak-side-table", outcome: "rejected", reason: "budget", minutesAgo: 120.64, questions: [{ id: "seo.schema_content_match", answer: noul(0.34) }] },
  {
    kind: "weak_ctr", path: "/collections/sofas", recKey: "url:sofas:meta", outcome: "selected", reason: null, minutesAgo: 120.6,
    questions: [
      { id: "seo.query_page_relevance", answer: noul(0.94) },
      { id: "seo.title_matches_query", answer: noul(0.83) },
    ],
  },
  {
    kind: "declining", path: "/products/oak-side-table", outcome: "rejected", reason: "budget", minutesAgo: 120.56,
    questions: [
      { id: "seo.action_choice", answer: pick("improve_intro_answer", 0.83, "add_section") },
      { id: "seo.page_action", answer: pick("update", 0.62, "keep") },
    ],
  },
  {
    kind: "coverage_gap", path: "/blog/how-to-choose-a-washable-sofa", outcome: "rejected", reason: "budget", minutesAgo: 120.52,
    questions: [
      { id: "seo.action_choice", answer: pick("add_section", 0.86, "no_action") },
      { id: "seo.covers_topic", key: "seo.covers_topic#t1", answer: noul(0.14) },
      { id: "seo.covers_topic", key: "seo.covers_topic#t2", answer: noul(0.93) },
    ],
  },
  {
    kind: "weak_ctr", path: "/products/linen-slipcover-sofa", outcome: "rejected", reason: "low_fit", minutesAgo: 120.45,
    questions: [
      { id: "seo.query_page_relevance", answer: noul(0.96) },
      { id: "seo.action_choice", answer: pick("no_action", 0.88, "rewrite_title_meta") },
      { id: "seo.title_matches_query", answer: noul(0.95) },
      { id: "seo.meta_matches_query", answer: noul(0.9) },
    ],
  },
  { kind: "answer_clarity", path: "/collections/table-lamps", outcome: "rejected", reason: "budget", minutesAgo: 120.4, questions: [{ id: "seo.answer_is_direct", answer: noul(0.09) }] },
];

/** Fictional query relevance answers (Noul) for the demo GSC queries, judged before candidates. */
export const DEMO_QUERY_RELEVANCE: Array<[string, number]> = [
  ["washable linen sofa", 0.96],
  ["linen slipcover sofa", 0.97],
  ["oak side table", 0.93],
  ["brass table lamp", 0.95],
  ["how to choose a washable sofa", 0.88],
  ["demo furnishings", 0.98],
  ["table lamps for reading", 0.84],
  ["pet friendly sofa fabric", 0.61],
];
