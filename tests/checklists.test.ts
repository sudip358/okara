/** [A21] SEO and GEO readiness checklists: measured items, honest statuses, manual items, ordering, tenancy. */
import { describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Checklist, ChecklistItem, ChecklistStatus } from "@shared/types";
import { Db } from "@worker/lib/db";
import { getProjectChecklist } from "@worker/checklists/service";
import { CHECKLIST_VERSION, DISCLAIMER } from "@worker/checklists/registry";
import { seedDemoProject } from "@worker/demo/seed";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { crawler, projectRow, seedCrawl, seedGeo, seedGsc, SITE_ROBOTS, type PageSeed } from "./checklists-seed";

async function setup(projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv();
  const user = await seedUser(env);
  const projectId = await seedProject(env, user.workspaceId, projectOverrides);
  const db = new Db(env.DB);
  return { env, db, ws: user.workspaceId, projectId, user };
}

async function checklist(env: ReturnType<typeof createTestEnv>, db: Db, projectId: string, kind: "seo" | "geo"): Promise<Checklist> {
  return getProjectChecklist(env, db, await projectRow(db, projectId), kind, FIXED_NOW);
}

const byId = (c: Checklist) => new Map(c.items.map((i) => [i.id, i]));
function item(c: Checklist, id: string): ChecklistItem {
  const i = byId(c).get(id);
  if (!i) throw new Error(`missing item ${id}`);
  return i;
}
const statusOf = (c: Checklist, id: string): ChecklistStatus => item(c, id).status;

const GOOD_SITE: PageSeed[] = [
  { path: "/", pageType: "home", links: ["/collections/pulls", "/products/brass-pull", "/blog/brass-vs-bronze-pulls", "/pages/about"] },
  { path: "/collections/pulls", pageType: "collection", links: ["/", "/products/brass-pull", "/blog/brass-vs-bronze-pulls", "/pages/about"] },
  { path: "/products/brass-pull", pageType: "product", links: ["/", "/collections/pulls", "/blog/brass-vs-bronze-pulls"] },
  { path: "/blog/brass-vs-bronze-pulls", pageType: "article", tables: 1, links: ["/", "/collections/pulls", "/products/brass-pull", "/pages/about"] },
  { path: "/pages/about", pageType: "landing", links: ["/", "/collections/pulls"] },
];

const BAD_SITE: PageSeed[] = [
  { path: "/", pageType: "home", jsonld: [], images: 0, links: ["/collections/pulls", "/old", "/gone"], viewport: null },
  { path: "/collections/pulls", pageType: "collection", title: null, meta: null, jsonld: [], breadcrumbNav: false, images: 4, imagesMissingAlt: 4, links: ["/"], viewport: null },
  {
    path: "/products/brass-pull",
    pageType: "product",
    jsonld: ["Product"],
    jsonldIssues: [{ type: "Product", issue: "missing_offers" }],
    breadcrumbNav: false,
    canonical: null,
    images: 2,
    imagesMissingAlt: 2,
    viewport: null,
  },
  {
    path: "/blog/brass-vs-bronze",
    pageType: "article",
    tables: 0,
    author: null,
    lastUpdated: "2024-01-01T00:00:00Z",
    outbound: 0,
    jsonld: [],
    breadcrumbNav: false,
    headings: [{ level: 1, text: "Brass vs bronze" }, { level: 3, text: "Finishes" }],
    images: 1,
    imagesMissingAlt: 1,
    viewport: null,
  },
  { path: "/app", pageType: "other", skipped: "js_rendered", words: 3, h1: [], headings: [] },
  { path: "/old", pageType: "other", status: 301, finalPath: "/login?next=/old" },
  { path: "/gone", pageType: "other", status: 404 },
  { path: "/members", pageType: "other", status: 403 },
  { path: "/account", pageType: "other", status: 403 }, // the account page itself is not a wall
];

const BAD_FINDINGS = [
  { ruleId: "SEO-NOINDEX", path: "/blog/brass-vs-bronze" },
  { ruleId: "SEO-CANONICAL-MISSING", path: "/products/brass-pull" },
  { ruleId: "SEO-CANONICAL-OFFHOST", path: "/collections/pulls" },
  { ruleId: "SEO-STATUS-4XX", path: "/gone" },
  { ruleId: "SEO-LINK-BROKEN-INTERNAL", path: "/" },
  { ruleId: "SEO-META-DESC-MISSING", path: "/collections/pulls" },
  { ruleId: "SEO-TITLE-MISSING", path: "/collections/pulls" },
  { ruleId: "SEO-H1-MISSING", path: "/" },
  { ruleId: "SEO-HEADING-SKIP", path: "/blog/brass-vs-bronze" },
  { ruleId: "SEO-ROBOTS-SITEMAP-CONFLICT", path: "/private/page" },
  { ruleId: "SEO-CONTENT-THIN", path: "/blog/brass-vs-bronze" },
];

const BAD_ROBOTS = SITE_ROBOTS({
  crawlers: [
    crawler("Googlebot", "search_engine", false),
    crawler("Bingbot", "search_engine", false),
    crawler("OAI-SearchBot", "answer_search", false),
    crawler("PerplexityBot", "answer_search", false),
    crawler("GPTBot", "training", false),
  ],
  sitemaps: [],
  fetched: [],
  urlCount: 0,
});

const NOT_CONNECTED_IDS = [
  "seo.technical.indexing_issues",
  "seo.technical.core_web_vitals",
  "seo.quick_wins.people_also_ask",
  "seo.content.competitor_keywords",
  "seo.content.volume_kd",
  "seo.links.brand_mentions",
  "seo.links.backlink_gap",
  "geo.tracking.ai_referrals",
];

describe("checklists: contract, states, disclaimer", () => {
  it("returns setup_required with every item when there is no crawl, GSC, or GEO data", async () => {
    const { env, db, projectId } = await setup();
    for (const kind of ["seo", "geo"] as const) {
      const c = await checklist(env, db, projectId, kind);
      expect(c.kind).toBe(kind);
      expect(c.state).toBe("setup_required");
      expect(c.checklistVersion).toBe(CHECKLIST_VERSION);
      expect(c.disclaimer).toBe(DISCLAIMER);
      expect(c.disclaimer).toMatch(/None guarantees rankings, inclusion, or citation/);
      expect(c.items.length).toBe(kind === "seo" ? 40 : 36);
      expect(new Set(c.items.map((i) => i.id)).size).toBe(c.items.length);
      expect(Object.values(c.counts).reduce((a, b) => a + b, 0)).toBe(c.items.length);
      expect(c.sources).toEqual({ crawlRunId: null, crawledAt: null, gscSyncedAt: null, geoObservations: 0 });
      for (const i of c.items) {
        expect(i.id.startsWith(`${kind}.`)).toBe(true);
        expect(i.evidence.length).toBeLessThanOrEqual(5);
        // Nothing is "met" without data; no item text promises outcomes.
        expect(i.status).not.toBe("met");
        expect(`${i.summary} ${i.guidance} ${i.caveat ?? ""}`).not.toMatch(/\b(guarantees? (rankings|citations?|inclusion)|will rank|will be cited)\b/i);
        if (kind === "geo") expect(i.tacticTier).toBeNull();
        if (i.method === "manual" && i.status === "manual") expect(i.manual).toEqual({ checked: false, note: null, updatedAt: null, updatedBy: null });
        else expect(i.manual).toBeNull();
      }
    }
  });

  it("labels demo projects 'demo' and evaluates the seeded demo data", async () => {
    const env = createTestEnv({ DEMO_MODE: "true" });
    const user = await seedUser(env);
    const db = new Db(env.DB);
    const demo = await seedDemoProject(env, db, user.userId, FIXED_NOW);
    const geo = await getProjectChecklist(env, db, demo, "geo", FIXED_NOW);
    const seo = await getProjectChecklist(env, db, demo, "seo", FIXED_NOW);
    expect(geo.state).toBe("demo");
    expect(seo.state).toBe("demo");
    // Demo robots: OAI-SearchBot allowed, GPTBot (training) blocked -> still met.
    expect(statusOf(geo, "geo.access.ai_search_bots_allowed")).toBe("met");
    expect(item(geo, "geo.access.ai_search_bots_allowed").summary).toMatch(/GPTBot.*business choice/);
    // Product JSON-LD without offers on 3 product pages.
    expect(statusOf(geo, "geo.structure.schema_markup")).toBe("partial");
    expect(statusOf(geo, "geo.trust.public_pricing")).toBe("not_met");
    // Demo GSC: two rows below the 4-10 bucket median -> measured opportunity beats the tier-D opinion.
    const lowCtr = item(seo, "seo.quick_wins.low_ctr");
    expect(lowCtr.status).toBe("not_met");
    expect(lowCtr.tacticTier).toBe("D");
    expect(lowCtr.caveat).toMatch(/data takes precedence/);
    expect(item(seo, "seo.on_page.title_length").caveat).toMatch(/measured data takes precedence/);
    expect(statusOf(seo, "seo.quick_wins.page_two")).toBe("not_met");
    // Demo has forum/listicle/review citations without the brand.
    expect(statusOf(geo, "geo.mentions.reddit_threads")).toBe("partial");
    expect(statusOf(geo, "geo.mentions.review_platforms")).toBe("partial");
    expect(item(geo, "geo.mentions.review_platforms").caveat).toMatch(/marketplaces are shown instead of G2 and Capterra/);
    expect(statusOf(geo, "geo.mentions.youtube")).toBe("unknown");
    expect(geo.sources.geoObservations).toBe(10);
    expect(seo.sources.gscSyncedAt).not.toBeNull();
  });
});

describe("GEO Access: measured from the latest crawl", () => {
  it("blocking only training crawlers is not a failure", async () => {
    const { env, db, ws, projectId } = await setup();
    await seedCrawl(db, ws, projectId, {
      pages: GOOD_SITE,
      robots: SITE_ROBOTS({
        crawlers: [
          crawler("Googlebot", "search_engine", true),
          crawler("OAI-SearchBot", "answer_search", true),
          crawler("PerplexityBot", "answer_search", true),
          crawler("GPTBot", "training", false),
          crawler("ClaudeBot", "training", false),
          crawler("ChatGPT-User", "user_fetch", false),
        ],
      }),
    });
    const geo = await checklist(env, db, projectId, "geo");
    const i = item(geo, "geo.access.ai_search_bots_allowed");
    expect(i.status).toBe("met");
    expect(i.method).toBe("measured");
    expect(i.summary).toMatch(/3 of 3/);
    expect(i.summary).toMatch(/training crawlers blocked: GPTBot, ClaudeBot/);
    expect(i.summary).toMatch(/ChatGPT-User blocked/); // informational only
    expect(i.links.map((l) => l.to)).toContain("seo#robots");
    expect(item(geo, "geo.access.cdn_not_blocking").status).toBe("manual");
    expect(item(geo, "geo.access.cdn_not_blocking").caveat).toMatch(/overrides robots\.txt/);
  });

  it("flags blocked answer/search crawlers: some blocked is partial, all blocked is not_met", async () => {
    const a = await setup();
    await seedCrawl(a.db, a.ws, a.projectId, {
      pages: GOOD_SITE,
      robots: SITE_ROBOTS({ crawlers: [crawler("Googlebot", "search_engine", true), crawler("OAI-SearchBot", "answer_search", false), crawler("PerplexityBot", "answer_search", true)] }),
    });
    expect(statusOf(await checklist(a.env, a.db, a.projectId, "geo"), "geo.access.ai_search_bots_allowed")).toBe("partial");

    const b = await setup();
    await seedCrawl(b.db, b.ws, b.projectId, { pages: GOOD_SITE, robots: BAD_ROBOTS });
    const geo = await checklist(b.env, b.db, b.projectId, "geo");
    expect(statusOf(geo, "geo.access.ai_search_bots_allowed")).toBe("not_met");
    expect(item(geo, "geo.access.ai_search_bots_allowed").evidence.length).toBeLessThanOrEqual(5);
  });

  it("detects login walls (401/403 and sign-in redirects), JS-only pages, noindex/canonical, and missing sitemaps", async () => {
    const { env, db, ws, projectId } = await setup();
    await seedCrawl(db, ws, projectId, { pages: BAD_SITE, findings: BAD_FINDINGS, robots: BAD_ROBOTS });
    const geo = await checklist(env, db, projectId, "geo");
    const walls = item(geo, "geo.access.no_login_walls");
    expect(walls.status).toBe("not_met");
    const wallUrls = walls.evidence.map((e) => e.url);
    expect(wallUrls).toContain("https://shop.example.com/members");
    expect(wallUrls).toContain("https://shop.example.com/old");
    expect(wallUrls).not.toContain("https://shop.example.com/account");
    const js = item(geo, "geo.access.key_text_in_html");
    expect(js.status).toBe("not_met");
    expect(js.evidence[0]?.url).toBe("https://shop.example.com/app");
    expect(statusOf(geo, "geo.access.noindex_canonical")).toBe("not_met");
    expect(statusOf(geo, "geo.access.sitemap_indexnow")).toBe("not_met");
    expect(item(geo, "geo.access.sitemap_indexnow").caveat).toMatch(/IndexNow is used by Bing and other participating engines, not Google/);
  });

  it("marks the same access items met on a clean crawl", async () => {
    const { env, db, ws, projectId } = await setup();
    const { crawlId } = await seedCrawl(db, ws, projectId, { pages: GOOD_SITE });
    const geo = await checklist(env, db, projectId, "geo");
    for (const id of ["geo.access.ai_search_bots_allowed", "geo.access.sitemap_indexnow", "geo.access.noindex_canonical", "geo.access.key_text_in_html", "geo.access.no_login_walls"]) {
      const i = item(geo, id);
      expect(i.status, id).toBe("met");
      expect(i.method, id).toBe("measured");
    }
    expect(geo.state).toBe("ready");
    expect(geo.sources.crawlRunId).toBe(crawlId);
  });

  it("partial canonical issues only (missing canonical) are partial, not a failure", async () => {
    const { env, db, ws, projectId } = await setup();
    await seedCrawl(db, ws, projectId, { pages: GOOD_SITE, findings: [{ ruleId: "SEO-CANONICAL-MISSING", path: "/pages/about" }] });
    expect(statusOf(await checklist(env, db, projectId, "geo"), "geo.access.noindex_canonical")).toBe("partial");
    expect(statusOf(await checklist(env, db, projectId, "seo"), "seo.technical.canonical_tags")).toBe("partial");
  });

  it("ignores crawl data for an unverified, non-demo project", async () => {
    const { env, db, ws, projectId } = await setup({ verified_host: null, verification_method: null, verified_at: null });
    await seedCrawl(db, ws, projectId, { pages: GOOD_SITE });
    const geo = await checklist(env, db, projectId, "geo");
    expect(geo.state).toBe("setup_required");
    expect(statusOf(geo, "geo.access.ai_search_bots_allowed")).toBe("unknown");
  });
});

describe("measured structure, trust, and SEO technical/on-page items", () => {
  const GEO_MET = [
    "geo.structure.comparison_tables",
    "geo.structure.internal_links",
    "geo.structure.schema_markup",
    "geo.structure.question_headings",
    "geo.trust.author_bio",
    "geo.trust.last_updated",
    "geo.trust.reputable_sources",
    "geo.trust.public_pricing",
    "geo.content.update_stats",
  ];
  const SEO_MET = [
    "seo.technical.sitemap_submitted",
    "seo.technical.robots_noindex",
    "seo.technical.canonical_tags",
    "seo.technical.js_crawlable",
    "seo.technical.broken_links",
    "seo.technical.clean_urls",
    "seo.technical.breadcrumbs",
    "seo.technical.orphan_pages",
    "seo.technical.schema_rich_results",
    "seo.technical.mobile_friendly",
    "seo.on_page.title_length",
    "seo.on_page.unique_meta",
    "seo.on_page.heading_structure",
    "seo.on_page.image_alt",
    "seo.on_page.internal_links",
    "seo.content.author_eeat",
    "seo.content.date_modified",
    "seo.content.comparison_pages",
    "seo.content.merge_thin",
    "seo.content.cannibalization",
  ];
  const GEO_NOT_MET = [
    "geo.structure.comparison_tables",
    "geo.structure.internal_links",
    "geo.structure.schema_markup",
    "geo.structure.question_headings",
    "geo.trust.author_bio",
    "geo.trust.reputable_sources",
    "geo.trust.public_pricing",
    "geo.content.update_stats",
  ];
  const SEO_NOT_MET = [
    "seo.technical.sitemap_submitted",
    "seo.technical.robots_noindex",
    "seo.technical.canonical_tags",
    "seo.technical.js_crawlable",
    "seo.technical.broken_links",
    "seo.technical.breadcrumbs",
    "seo.technical.orphan_pages",
    "seo.technical.schema_rich_results",
    "seo.technical.mobile_friendly",
    "seo.on_page.title_length",
    "seo.on_page.image_alt",
    "seo.on_page.internal_links",
    "seo.content.author_eeat",
    "seo.content.merge_thin",
  ];

  it("a clean crawl meets every measured item it covers", async () => {
    const { env, db, ws, projectId } = await setup();
    await seedCrawl(db, ws, projectId, { pages: GOOD_SITE });
    const geo = await checklist(env, db, projectId, "geo");
    const seo = await checklist(env, db, projectId, "seo");
    for (const id of GEO_MET) expect(statusOf(geo, id), id).toBe("met");
    for (const id of SEO_MET) expect(statusOf(seo, id), id).toBe("met");
    expect(item(seo, "seo.technical.mobile_friendly").method).toBe("heuristic");
    expect(item(geo, "geo.structure.question_headings").method).toBe("heuristic");
    expect(statusOf(seo, "seo.content.listicles")).toBe("not_met"); // no best-of page
    expect(statusOf(geo, "geo.content.howto_bestof_comparison")).toBe("partial"); // comparison only
  });

  it("a broken crawl fails the same items with evidence", async () => {
    const { env, db, ws, projectId } = await setup();
    await seedCrawl(db, ws, projectId, { pages: BAD_SITE, findings: BAD_FINDINGS, robots: BAD_ROBOTS });
    const geo = await checklist(env, db, projectId, "geo");
    const seo = await checklist(env, db, projectId, "seo");
    for (const id of GEO_NOT_MET) expect(statusOf(geo, id), id).toBe("not_met");
    for (const id of SEO_NOT_MET) expect(statusOf(seo, id), id).toBe("not_met");
    expect(statusOf(seo, "seo.on_page.unique_meta")).toBe("partial");
    expect(statusOf(seo, "seo.on_page.heading_structure")).toBe("partial");
    const orphans = item(seo, "seo.technical.orphan_pages");
    expect(orphans.evidence.map((e) => e.url).sort()).toEqual(["https://shop.example.com/blog/brass-vs-bronze", "https://shop.example.com/products/brass-pull"]);
    expect(orphans.caveat).toMatch(/Within crawl coverage/);
    const alt = item(seo, "seo.on_page.image_alt");
    expect(alt.summary).toMatch(/7 of 7 images lack an alt attribute/);
    const broken = item(seo, "seo.technical.broken_links");
    expect(broken.evidence.some((e) => e.label === "Linked redirect" && e.url === "https://shop.example.com/old")).toBe(true);
    for (const i of [...geo.items, ...seo.items]) {
      expect(i.evidence.length).toBeLessThanOrEqual(5);
      if (i.completeness) expect(i.completeness.note.length).toBeGreaterThan(0);
    }
    const title = item(seo, "seo.on_page.title_length");
    expect(title.caveat).toMatch(/pixel width/);
  });

  it("marks stale declared dates and provisional orphans when the crawl hit its limit", async () => {
    const { env, db, ws, projectId } = await setup();
    await seedCrawl(db, ws, projectId, {
      pages: [...GOOD_SITE, { path: "/pages/lonely", pageType: "landing", lastUpdated: "2023-02-01" }],
      notes: ["6 of 6 pages crawled; page limit 6 reached"],
    });
    const seo = await checklist(env, db, projectId, "seo");
    expect(statusOf(seo, "seo.technical.orphan_pages")).toBe("partial");
    expect(item(seo, "seo.technical.orphan_pages").completeness?.note).toMatch(/provisional/);
    const geo = await checklist(env, db, projectId, "geo");
    expect(statusOf(geo, "geo.content.update_stats")).toBe("partial");
  });
});

describe("Search Console quick wins", () => {
  const PAGE_ROWS: Array<[string | null, string | null, "current" | "previous", number, number, number]> = [
    ["brass pulls", "/collections/pulls", "current", 40, 1000, 5.0],
    ["brass cabinet pull", "/products/brass-pull", "current", 30, 1000, 6.0],
    ["brass vs bronze", "/blog/brass-vs-bronze-pulls", "current", 5, 1000, 7.0],
    ["about residence example", "/pages/about", "current", 35, 900, 8.0],
    [null, "/collections/pulls", "current", 40, 1000, 5.0],
    [null, "/products/brass-pull", "current", 30, 1000, 6.0],
    [null, "/blog/brass-vs-bronze-pulls", "current", 5, 1000, 7.0],
    [null, "/pages/about", "current", 3, 500, 15.2],
    [null, "/collections/pulls", "previous", 45, 1000, 5.0],
    [null, "/products/brass-pull", "previous", 30, 1000, 6.0],
    [null, "/blog/brass-vs-bronze-pulls", "previous", 30, 1000, 6.0],
    [null, "/pages/about", "previous", 4, 450, 15.0],
  ];

  it("lists weak-CTR, page-2, and declining pages from GSC rows", async () => {
    const { env, db, ws, projectId } = await setup();
    await seedCrawl(db, ws, projectId, { pages: GOOD_SITE });
    await seedGsc(db, ws, projectId, PAGE_ROWS);
    const seo = await checklist(env, db, projectId, "seo");
    const low = item(seo, "seo.quick_wins.low_ctr");
    expect(low.status).toBe("not_met");
    expect(low.evidence[0]?.url).toBe("https://shop.example.com/blog/brass-vs-bronze-pulls");
    expect(low.caveat).toMatch(/tier D \(external opinion\).*data takes precedence/);
    const p2 = item(seo, "seo.quick_wins.page_two");
    expect(p2.status).toBe("not_met");
    expect(p2.evidence.map((e) => e.url)).toEqual(["https://shop.example.com/pages/about"]);
    const dec = item(seo, "seo.quick_wins.declining_pages");
    expect(dec.status).toBe("not_met");
    expect(dec.evidence[0]?.url).toBe("https://shop.example.com/blog/brass-vs-bronze-pulls");
    // "answer in first lines": "brass vs bronze" -> only "brass" appears in the default first paragraph.
    expect(statusOf(seo, "seo.on_page.answer_first_lines")).toBe("partial");
    expect(statusOf(seo, "seo.technical.gsc_ga4")).toBe("partial"); // GSC data present, GA4 never verifiable
  });

  it("meets the quick wins when GSC shows no opportunity, and is not_connected without GSC", async () => {
    const { env, db, ws, projectId } = await setup();
    await seedCrawl(db, ws, projectId, { pages: GOOD_SITE });
    let seo = await checklist(env, db, projectId, "seo");
    for (const id of ["seo.quick_wins.low_ctr", "seo.quick_wins.page_two", "seo.quick_wins.declining_pages"]) expect(statusOf(seo, id), id).toBe("not_connected");
    await seedGsc(db, ws, projectId, [
      ["brass pulls", "/collections/pulls", "current", 40, 1000, 5.0],
      ["brass cabinet pull", "/products/brass-pull", "current", 38, 1000, 6.0],
      ["brass bronze pulls", "/blog/brass-vs-bronze-pulls", "current", 36, 1000, 7.0],
      ["brass pulls", "/collections/pulls", "previous", 40, 1000, 5.0],
    ]);
    seo = await checklist(env, db, projectId, "seo");
    for (const id of ["seo.quick_wins.low_ctr", "seo.quick_wins.page_two", "seo.quick_wins.declining_pages"]) expect(statusOf(seo, id), id).toBe("met");
    expect(item(seo, "seo.on_page.title_length").caveat).not.toMatch(/precedence/);
  });
});

describe("GEO mentions and tracking", () => {
  it("builds manual-action lists from cited sources and never marks missing data as met", async () => {
    const { env, db, ws, projectId } = await setup();
    let geo = await checklist(env, db, projectId, "geo");
    for (const id of ["geo.mentions.reddit_threads", "geo.mentions.listicles", "geo.mentions.youtube"]) expect(statusOf(geo, id), id).toBe("unknown");

    await seedGeo(db, ws, projectId, {
      approvedPrompts: 20,
      observations: [
        { provider: "gemini", citations: [{ url: "https://www.reddit.com/r/woodworking/comments/abc/brass_pulls", sourceType: "forum_ugc", title: "Brass pulls?" }], displacement: { entity: "Brass Co", url: "https://www.reddit.com/r/woodworking/comments/abc/brass_pulls", sourceType: "forum_ugc" }, competitor: { name: "Brass Co", mentioned: true, cited: false } },
        { provider: "perplexity", citations: [{ url: "https://roundup.example/best-cabinet-pulls", sourceType: "listicle_roundup" }], selfMentioned: true },
        { provider: "gemini", citations: [{ url: "https://www.trustpilot.com/review/brassco.example", sourceType: "review_site" }] },
        { provider: "perplexity", citations: [{ url: "https://shop.example.com/products/brass-pull", sourceType: "brand_page", brandKey: "self" }], selfMentioned: true, selfCited: true, searchQueries: ["solid brass pulls for kitchens"] },
        { provider: "gemini", status: "failed" },
      ],
    });
    geo = await checklist(env, db, projectId, "geo");
    const reddit = item(geo, "geo.mentions.reddit_threads");
    expect(reddit.status).toBe("partial");
    expect(reddit.method).toBe("measured");
    expect(reddit.evidence[0]?.url).toBe("https://www.reddit.com/r/woodworking/comments/abc/brass_pulls");
    expect(reddit.evidence[0]?.detail).toMatch(/named instead: Brass Co/);
    expect(reddit.guidance).toMatch(/never posts, reviews, or contacts anyone/);
    expect(statusOf(geo, "geo.mentions.listicles")).toBe("met");
    expect(statusOf(geo, "geo.mentions.review_platforms")).toBe("partial");
    expect(item(geo, "geo.mentions.review_platforms").guidance).toMatch(/Never write, buy, or incentivize fake reviews/);
    expect(statusOf(geo, "geo.mentions.youtube")).toBe("unknown");
    expect(statusOf(geo, "geo.mentions.news_coverage")).toBe("unknown");
    expect(statusOf(geo, "geo.content.cited_pages_gaps")).toBe("partial");
    expect(statusOf(geo, "geo.tracking.prompt_list")).toBe("met");
    expect(item(geo, "geo.tracking.prompt_list").summary).toMatch(/up to 5 prompts per provider/);
    const rerun = item(geo, "geo.tracking.rerun_engines");
    expect(rerun.status).toBe("met");
    expect(rerun.caveat).toMatch(/API-sampled/);
    expect(statusOf(geo, "geo.tracking.citation_share")).toBe("met");
    expect(item(geo, "geo.tracking.study_cited_sections").evidence[0]?.url).toBe("https://shop.example.com/products/brass-pull");
    expect(item(geo, "geo.content.use_case_pages").summary).toMatch(/1 distinct search query/);
    expect(geo.state).toBe("ready");
    expect(geo.sources.geoObservations).toBe(5);
  });

  it("scores the prompt list against the suggested 20", async () => {
    const { env, db, ws, projectId } = await setup();
    await seedGeo(db, ws, projectId, { approvedPrompts: 5, totalPrompts: 7 });
    const geo = await checklist(env, db, projectId, "geo");
    expect(statusOf(geo, "geo.tracking.prompt_list")).toBe("partial");
    expect(item(geo, "geo.tracking.prompt_list").summary).toMatch(/5 approved of 7/);
    expect(statusOf(geo, "geo.tracking.rerun_engines")).toBe("not_connected"); // no provider keys, no runs
  });
});

describe("honest labels: not_connected and not_applicable", () => {
  it("never shows not_connected items as met, whatever data exists", async () => {
    const empty = await setup();
    const full = await setup();
    await seedCrawl(full.db, full.ws, full.projectId, { pages: GOOD_SITE });
    await seedGsc(full.db, full.ws, full.projectId, [["brass pulls", "/collections/pulls", "current", 40, 1000, 5.0]]);
    await seedGeo(full.db, full.ws, full.projectId, { approvedPrompts: 20, observations: [{ citations: [{ url: "https://roundup.example/best", sourceType: "listicle_roundup" }], selfMentioned: true }] });
    for (const s of [empty, full]) {
      const seo = await checklist(s.env, s.db, s.projectId, "seo");
      const geo = await checklist(s.env, s.db, s.projectId, "geo");
      for (const id of NOT_CONNECTED_IDS) expect(statusOf(id.startsWith("seo") ? seo : geo, id), id).toBe("not_connected");
      expect(statusOf(seo, "seo.technical.gsc_ga4")).not.toBe("met");
    }
  });

  it("Google Business Profile is not_applicable unless the site type is local", async () => {
    const shop = await setup();
    const seo = await checklist(shop.env, shop.db, shop.projectId, "seo");
    const gbp = item(seo, "seo.links.google_business_profile");
    expect(gbp.status).toBe("not_applicable");
    expect(gbp.manual).toBeNull();
    const local = await setup({ site_type: "local" });
    const lseo = await checklist(local.env, local.db, local.projectId, "seo");
    expect(statusOf(lseo, "seo.links.google_business_profile")).toBe("manual");
    const saas = await setup({ site_type: "saas" });
    const sgeo = await checklist(saas.env, saas.db, saas.projectId, "geo");
    expect(item(sgeo, "geo.mentions.review_platforms").caveat ?? "").not.toMatch(/marketplaces/);
  });
});

describe("ordering by reference tier (SEO) then status", () => {
  it("orders items within each section by tier S..D (null last), then actionable status first", async () => {
    const { env, db, ws, projectId } = await setup();
    await seedCrawl(db, ws, projectId, { pages: BAD_SITE, findings: BAD_FINDINGS, robots: BAD_ROBOTS });
    const seo = await checklist(env, db, projectId, "seo");
    const tierRank = (t: ChecklistItem["tacticTier"]) => (t ? "SABCD".indexOf(t) : 5);
    const statusRank: Record<ChecklistStatus, number> = { not_met: 0, partial: 1, manual: 2, unknown: 3, not_connected: 4, met: 5, not_applicable: 6 };
    const sections = ["technical", "on_page", "quick_wins", "seo_content", "links"];
    let prev: ChecklistItem | null = null;
    for (const i of seo.items) {
      if (prev && prev.section === i.section) {
        expect(tierRank(prev.tacticTier) <= tierRank(i.tacticTier), `${prev.id} before ${i.id}`).toBe(true);
        if (prev.tacticTier === i.tacticTier) expect(statusRank[prev.status] <= statusRank[i.status], `${prev.id} before ${i.id}`).toBe(true);
      } else if (prev) {
        expect(sections.indexOf(prev.section)).toBeLessThan(sections.indexOf(i.section));
      }
      prev = i;
    }
    const technical = seo.items.filter((i) => i.section === "technical").map((i) => i.tacticTier);
    expect(technical[0]).toBe("S");
    expect(technical[technical.length - 1]).toBeNull();
    expect(item(seo, "seo.technical.core_web_vitals").tacticTier).toBe("D");
    expect(item(seo, "seo.links.best_x_lists").tacticTier).toBe("S");
  });
});

describe("manual items via the API", () => {
  it("persists check-offs with who and when, rejects measured items, and isolates tenants", async () => {
    const env = createTestEnv();
    const app = createApp();
    const a = await seedUser(env);
    const b = await seedUser(env);
    const db = new Db(env.DB);
    const pid = await seedProject(env, a.workspaceId);
    await seedCrawl(db, a.workspaceId, pid, { pages: GOOD_SITE });
    const url = (kind: string, id?: string) => `/api/projects/${pid}/checklists/${kind}${id ? `/${id}` : ""}`;
    const H = authHeaders(a.sessionToken, a.csrfToken);

    const put = await app.request(url("geo", "geo.content.original_research"), { method: "PUT", headers: H, body: JSON.stringify({ checked: true, note: "Installer survey, n=212, March 2026" }) }, env);
    expect(put.status).toBe(200);
    const saved = ((await put.json()) as { data: ChecklistItem }).data;
    expect(saved.id).toBe("geo.content.original_research");
    expect(saved.manual).toMatchObject({ checked: true, note: "Installer survey, n=212, March 2026", updatedBy: "Test User" });
    expect(saved.manual?.updatedAt).toBeTruthy();

    const get = await app.request(url("geo"), { headers: H }, env);
    expect(get.status).toBe(200);
    const c = ((await get.json()) as { data: Checklist }).data;
    expect(item(c, "geo.content.original_research").manual).toMatchObject({ checked: true, note: "Installer survey, n=212, March 2026" });
    expect(item(c, "geo.content.first_hand_experience").manual?.checked).toBe(false);
    // Uncheck keeps the row; empty note becomes null.
    const un = await app.request(url("geo", "geo.content.original_research"), { method: "PUT", headers: H, body: JSON.stringify({ checked: false, note: "  " }) }, env);
    expect(((await un.json()) as { data: ChecklistItem }).data.manual).toMatchObject({ checked: false, note: null });
    const row = await db.first<{ workspace_id: string; updated_by: string }>("SELECT workspace_id, updated_by FROM checklist_manual WHERE project_id = ?", pid);
    expect(row).toEqual({ workspace_id: a.workspaceId, updated_by: a.userId });

    // Measured / not-applicable / unknown items.
    expect((await app.request(url("geo", "geo.access.ai_search_bots_allowed"), { method: "PUT", headers: H, body: JSON.stringify({ checked: true }) }, env)).status).toBe(400);
    expect((await app.request(url("seo", "seo.links.google_business_profile"), { method: "PUT", headers: H, body: JSON.stringify({ checked: true }) }, env)).status).toBe(400);
    expect((await app.request(url("seo", "geo.content.original_research"), { method: "PUT", headers: H, body: JSON.stringify({ checked: true }) }, env)).status).toBe(404);
    expect((await app.request(url("geo", "geo.content.nope"), { method: "PUT", headers: H, body: JSON.stringify({ checked: true }) }, env)).status).toBe(404);
    expect((await app.request(url("geo", "geo.content.original_research"), { method: "PUT", headers: H, body: JSON.stringify({ checked: true, note: "x".repeat(501) }) }, env)).status).toBe(400);
    expect((await app.request(url("geo", "geo.content.original_research"), { method: "PUT", headers: H, body: JSON.stringify({ checked: "yes" }) }, env)).status).toBe(400);
    expect((await app.request(url("aeo"), { headers: H }, env)).status).toBe(400);

    // Another tenant cannot read or write.
    const HB = authHeaders(b.sessionToken, b.csrfToken);
    expect((await app.request(url("geo"), { headers: HB }, env)).status).toBe(404);
    expect((await app.request(url("geo", "geo.content.original_research"), { method: "PUT", headers: HB, body: JSON.stringify({ checked: true }) }, env)).status).toBe(404);
    // CSRF is enforced on PUT.
    expect((await app.request(url("geo", "geo.content.original_research"), { method: "PUT", headers: { ...H, "X-CSRF-Token": "wrong" }, body: JSON.stringify({ checked: true }) }, env)).status).toBe(403);
    // Unauthenticated.
    expect((await app.request(url("seo"), {}, env)).status).toBe(401);
  });
});
