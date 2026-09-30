/** [A22] GEO coverage views: answer coverage (matching, AI source, gap) and citation evidence. */
import { describe, expect, it } from "vitest";
import type { AnswerCoverageRow, CitationEvidenceRow, CoverageResponse } from "@shared/types";
import { Db } from "@worker/lib/db";
import { seedDemoProject } from "@worker/demo/seed";
import { selfDomains } from "@worker/geo/detect";
import { bestOverlap, brandTokenSet, buildAnswerCoverage, contentTokens, gapFor, overlap } from "@worker/coverage/answer-coverage";
import { buildCitationEvidence } from "@worker/coverage/citation-evidence";
import { isSelfHost, resolveCitation } from "@worker/coverage/geo-data";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedUser } from "./helpers/fixtures";
import { hoursAgo, projectRow, seedCrawl, seedGsc, seedObservation, seedPromptSet, setup, U, type Setup } from "./coverage-seed";

const answerCoverage = async (s: Setup) => (await s.call(`/projects/${s.pid}/geo/answer-coverage`)) as { status: number; json: { data: CoverageResponse<AnswerCoverageRow> } };
const citationEvidence = async (s: Setup) => (await s.call(`/projects/${s.pid}/geo/citation-evidence`)) as { status: number; json: { data: CoverageResponse<CitationEvidenceRow> } };

const P = {
  knobs: "Where can I buy solid brass cabinet knobs?",
  bronze: "Is brass or bronze better for cabinet pulls?",
  tables: "What are the best dining tables for small apartments?",
  clean: "How to clean unlacquered brass hardware at home?",
  sconces: "Which lighting brands offer warm dimmable sconces?",
  coastal: "What finishes suit coastal kitchens?",
  quiet: "Which drawer slides are quietest for kitchen cabinets?",
  unapproved: "Unapproved prompt about hinges",
};

/** A site with four crawled pages, GSC rows, and API observations across two providers. */
async function seedScenario() {
  const s = await setup();
  const crawl = await seedCrawl(s, [
    { path: "/blogs/guide/brass-vs-bronze-cabinet-pulls", pageType: "article", title: "Brass vs bronze cabinet pulls: how to choose", h1: ["Brass vs bronze cabinet pulls"], jsonld: ["BlogPosting"] },
    { path: "/collections/brass-cabinet-knobs", pageType: "collection", title: "Brass Cabinet Knobs | Residence Example", h1: ["Brass Cabinet Knobs"] },
    { path: "/products/unlacquered-brass-pull", pageType: "product", title: "Unlacquered Brass Pull | Residence Example", h1: ["Unlacquered Brass Pull"], jsonld: ["Product"] },
    { path: "/pages/care-guide", pageType: "landing", title: "How to clean unlacquered brass hardware", h1: ["Cleaning unlacquered brass"] },
  ]);
  await seedGsc(s, { rows: [{ query: "Solid Brass Knobs", path: "/collections/brass-cabinet-knobs", clicks: 20, impressions: 500 }] });
  const { ids } = await seedPromptSet(s, [
    { text: P.knobs },
    { text: P.bronze },
    { text: P.tables },
    { text: P.clean },
    { text: P.sconces },
    { text: P.coastal },
    { text: P.quiet },
    { text: P.unapproved, approved: false },
  ]);
  const [knobs, bronze, tables, clean, sconces, coastal, quiet] = ids as [string, string, string, string, string, string, string];

  // knobs: gemini exposes a query that matches a GSC query; cites your collection (tracking param), a subdomain page, and reddit.
  await seedObservation(s, {
    promptId: knobs,
    promptText: P.knobs,
    provider: "gemini",
    queries: ["solid brass knobs"],
    citations: [
      { url: `${U("/collections/brass-cabinet-knobs")}?utm_source=gemini#top`, sourceType: "brand_page" },
      { url: "https://www.reddit.com/r/centuryhomes/comments/abc/brass_knobs", sourceType: "forum_ugc" },
      { url: "https://blog.example.com/brass-care", sourceType: "brand_page" },
    ],
  });
  // knobs: perplexity cites the same collection twice (trailing slash) and a product page, no other sources.
  await seedObservation(s, {
    promptId: knobs,
    promptText: P.knobs,
    provider: "perplexity",
    createdAt: hoursAgo(0.5),
    citations: [
      { url: `${U("/collections/brass-cabinet-knobs")}/`, sourceType: "brand_page" },
      { url: U("/collections/brass-cabinet-knobs"), sourceType: "brand_page" },
      { url: `https://${"WWW.SHOP.EXAMPLE.COM"}/products/unlacquered-brass-pull`, sourceType: "brand_page" },
    ],
  });
  // bronze: no queries exposed; a competitor and a look-alike host are cited (the look-alike is NOT your site).
  await seedObservation(s, {
    promptId: bronze,
    promptText: P.bronze,
    provider: "perplexity",
    citations: [
      { url: "https://brassco.example/blog/brass-vs-bronze", sourceType: "brand_page" },
      { url: "https://evil-example.com.attacker.net/brass-vs-bronze", sourceType: "listicle_roundup" },
      { url: "https://example.com.attacker.net/shop", sourceType: "other" },
    ],
  });
  // bronze: a manual import citing your site must be ignored (not API-sampled).
  await seedObservation(s, { promptId: bronze, promptText: P.bronze, measurement: "manual_import", citations: [{ url: U("/blogs/guide/brass-vs-bronze-cabinet-pulls") }] });
  // tables: latest gemini cohort cites a publisher; an OLDER gemini cohort cited your site (ignored).
  await seedObservation(s, { promptId: tables, promptText: P.tables, provider: "gemini", citations: [{ url: "https://www.nytimes.com/wirecutter/reviews/best-dining-tables/", sourceType: "publisher" }, { url: "https://www.nytimes.com/wirecutter/other", sourceType: "publisher" }, { url: "https://forum.example/t/1", sourceType: "forum_ugc" }] });
  await seedObservation(s, { promptId: tables, promptText: P.tables, provider: "gemini", cohort: "gemini-c1", createdAt: hoursAgo(200), citations: [{ url: U("/pages/old-page"), sourceType: "brand_page" }] });
  // clean: query overlaps a crawled title (no GSC row); grounded answer cites nothing.
  await seedObservation(s, { promptId: clean, promptText: P.clean, provider: "gemini", queries: ["clean unlacquered brass"], citations: [] });
  // sconces: only a failed call.
  await seedObservation(s, { promptId: sconces, promptText: P.sconces, provider: "gemini", status: "failed" });
  // coastal: a successful but ungrounded answer.
  await seedObservation(s, { promptId: coastal, promptText: P.coastal, provider: "perplexity", grounded: false });
  // quiet: grounded answer citing nothing, no matching page.
  await seedObservation(s, { promptId: quiet, promptText: P.quiet, provider: "perplexity", citations: [] });
  return { s, ids: { knobs, bronze, tables, clean, sconces, coastal, quiet }, pageIds: crawl.pageIds };
}

const byText = (rows: AnswerCoverageRow[], text: string) => {
  const r = rows.find((x) => x.text === text);
  if (!r) throw new Error(`no row for ${text}`);
  return r;
};

describe("coverage: GEO answer coverage", () => {
  it("maps approved prompts to pages, cited sources, and every gap value", async () => {
    const { s } = await seedScenario();
    const res = await answerCoverage(s);
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(d.state).toBe("ready");
    expect(d.rows.map((r) => r.text)).toEqual([P.knobs, P.bronze, P.tables, P.clean, P.sconces, P.coastal, P.quiet]);
    expect(d.labels).toContain("API-sampled answers; not consumer apps.");

    const knobs = byText(d.rows, P.knobs);
    expect(knobs.matchedPage).toEqual({ url: U("/collections/brass-cabinet-knobs"), method: "engine_search_query", score: 1 });
    expect(knobs.basis).toContain('"solid brass knobs" has Search Console impressions');
    expect(knobs.aiSource).toBe("your_site");
    expect(knobs.gap).toBe("covered");
    expect(knobs.providersRun).toBe(2);
    expect(knobs.topOtherSource).toEqual({ host: "reddit.com", sourceType: "forum_ugc", url: "https://www.reddit.com/r/centuryhomes/comments/abc/brass_knobs" });

    const bronze = byText(d.rows, P.bronze);
    expect(bronze.matchedPage?.url).toBe(U("/blogs/guide/brass-vs-bronze-cabinet-pulls"));
    expect(bronze.matchedPage?.method).toBe("title_heading_overlap");
    expect(bronze.matchedPage!.score).toBeGreaterThanOrEqual(0.2);
    expect(bronze.basis).toContain("No engine search queries were captured");
    expect(bronze.aiSource).toBe("other_site"); // evil-example.com.attacker.net is not your site; manual import ignored
    expect(bronze.topOtherSource?.host).toBe("brassco.example");
    expect(bronze.gap).toBe("improve");

    const tables = byText(d.rows, P.tables);
    expect(tables.matchedPage).toBeNull();
    expect(tables.aiSource).toBe("other_site"); // the older cohort's self citation is ignored
    expect(tables.topOtherSource).toEqual({ host: "nytimes.com", sourceType: "publisher", url: "https://www.nytimes.com/wirecutter/reviews/best-dining-tables/" }); // as the provider gave it
    expect(tables.gap).toBe("create_page");

    const clean = byText(d.rows, P.clean);
    expect(clean.matchedPage).toMatchObject({ url: U("/pages/care-guide"), method: "engine_search_query" });
    expect(clean.matchedPage!.score).toBeCloseTo(0.6, 2); // {clean, unlacquered, brass} vs title+H1 {clean, unlacquered, brass, hardware, cleaning}
    expect(clean.basis).toContain("overlaps its title/H1");
    expect(clean.aiSource).toBe("none");
    expect(clean.gap).toBe("improve");

    const sconces = byText(d.rows, P.sconces);
    expect(sconces.aiSource).toBe("not_run");
    expect(sconces.gap).toBe("check");
    expect(sconces.providersRun).toBe(0);

    const coastal = byText(d.rows, P.coastal);
    expect(coastal.aiSource).toBe("not_run");
    expect(coastal.basis).toContain("not grounded");
    expect(coastal.gap).toBe("check");

    const quiet = byText(d.rows, P.quiet);
    expect(quiet.matchedPage).toBeNull();
    expect(quiet.aiSource).toBe("none");
    expect(quiet.gap).toBe("check");

    expect(d.completeness).toMatchObject({ covered: 5, total: 7 });
    expect(d.labels.some((l) => l.includes("1 manual import(s) are not included"))).toBe(true);
  });

  it("is setup_required without approved prompts, and without API-sampled answers (rows stay not_run)", async () => {
    const s = await setup();
    const none = (await answerCoverage(s)).json.data;
    expect(none.state).toBe("setup_required");
    expect(none.rows).toEqual([]);

    await seedPromptSet(s, [{ text: P.knobs }, { text: P.bronze, approved: false }]);
    const noObs = (await answerCoverage(s)).json.data;
    expect(noObs.state).toBe("setup_required");
    expect(noObs.rows).toHaveLength(1);
    expect(noObs.rows[0]).toMatchObject({ aiSource: "not_run", gap: "check", matchedPage: null, providersRun: 0 });
    const ce = (await citationEvidence(s)).json.data;
    expect(ce.state).toBe("setup_required");
    expect(ce.rows).toEqual([]);
  });

  it("counts a self citation behind a provider redirect link (host from the bare-domain title) as your site", async () => {
    const s = await setup();
    const { ids } = await seedPromptSet(s, [{ text: P.knobs }]);
    await seedObservation(s, {
      promptId: ids[0]!,
      promptText: P.knobs,
      citations: [{ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123", title: "shop.example.com" }],
    });
    const ac = (await answerCoverage(s)).json.data;
    expect(ac.rows[0]).toMatchObject({ aiSource: "your_site", gap: "covered" });
    const ce = (await citationEvidence(s)).json.data;
    expect(ce.rows).toEqual([]);
    expect(ce.labels.some((l) => l.includes("redirect links without a page URL"))).toBe(true);
    expect(ce.completeness).toMatchObject({ covered: 1, total: 1 });
  });

  it("pure helpers: token overlap thresholds and gap table", () => {
    const brand = brandTokenSet({ brand_name: "Residence Example", brand_aliases_json: JSON.stringify(["ResEx"]) });
    expect([...brand].sort()).toEqual(["example", "resex", "residence"]);
    const page = { pageId: "p", url: U("/x"), key: "k", tokens: contentTokens("Brass Knobs | Residence Example", brand) };
    expect([...page.tokens].sort()).toEqual(["brass", "knob"]);
    expect(overlap(new Set(["a", "b"]), new Set(["b", "c"]))).toEqual({ jaccard: 1 / 3, shared: ["b"] });
    // One shared token is never enough, whatever the Jaccard.
    expect(bestOverlap(contentTokens("brass", brand), [page])).toBeNull();
    expect(bestOverlap(contentTokens("brass knobs", brand), [page])?.jaccard).toBe(1);
    // Two shared tokens but Jaccard below 0.2.
    expect(bestOverlap(contentTokens("brass knobs for tall painted oak kitchen doors with glass panels, drawers and hinges", brand), [page])).toBeNull();
    expect(gapFor("your_site", false, false)).toBe("covered");
    expect(gapFor("other_site", true, false)).toBe("improve");
    expect(gapFor("none", true, false)).toBe("improve");
    expect(gapFor("other_site", false, false)).toBe("create_page");
    expect(gapFor("other_site", false, true)).toBe("check");
    expect(gapFor("not_run", true, false)).toBe("check");
    expect(gapFor("none", false, false)).toBe("check");
  });
});

describe("coverage: hostname matching", () => {
  it("is not fooled by look-alike hosts", async () => {
    const s = await setup();
    const project = await projectRow(s.db, s.pid);
    const domains = selfDomains(project);
    expect(domains.sort()).toEqual(["example.com", "shop.example.com"]);
    expect(isSelfHost("shop.example.com", domains)).toBe(true);
    expect(isSelfHost("blog.example.com", domains)).toBe(true);
    expect(isSelfHost("evil-example.com.attacker.net", domains)).toBe(false);
    expect(isSelfHost("example.com.attacker.net", domains)).toBe(false);
    expect(isSelfHost("notexample.com", domains)).toBe(false);
    expect(isSelfHost(null, domains)).toBe(false);
    const row = { observation_id: "o", title: null, position: 1, source_type: "other" };
    expect(resolveCitation({ ...row, url: "https://evil-example.com.attacker.net/x" }, domains).self).toBe(false);
    expect(resolveCitation({ ...row, url: "https://user@shop.example.com.attacker.net/x" }, domains).self).toBe(false);
    expect(resolveCitation({ ...row, url: "https://WWW.Shop.Example.com/x" }, domains).self).toBe(true);
    expect(resolveCitation({ ...row, url: "javascript:alert(1)" }, domains).host).toBeNull();
  });
});

describe("coverage: GEO citation evidence", () => {
  it("aggregates cited URLs of your site with counts, alongside hosts, next steps, and add-proof rows", async () => {
    const { s, pageIds } = await seedScenario();
    const d = (await citationEvidence(s)).json.data;
    expect(d.state).toBe("ready");
    expect(d.labels).toContain("API-sampled answers; not consumer apps.");

    const urls = d.rows.map((r) => r.url);
    expect(urls).not.toContain(U("/pages/old-page")); // older cohort
    expect(urls.some((u) => u.includes("attacker.net"))).toBe(false);

    const knobs = d.rows.find((r) => r.url === U("/collections/brass-cabinet-knobs"))!;
    expect(knobs).toMatchObject({
      pageId: pageIds["/collections/brass-cabinet-knobs"],
      citedCount: 2, // once per answer, despite the duplicate + tracking variants
      citedInPrompts: [P.knobs],
      providers: ["gemini", "perplexity"],
      citedAlongside: [{ host: "reddit.com", sourceType: "forum_ugc" }],
      nextStep: "compare",
    });
    expect(knobs.lastCitedAt).toBe(hoursAgo(0.5));
    expect(knobs.reason).toContain("alongside 1 other source host");

    const pull = d.rows.find((r) => r.url === U("/products/unlacquered-brass-pull"))!;
    expect(pull).toMatchObject({ pageId: pageIds["/products/unlacquered-brass-pull"], citedCount: 1, providers: ["perplexity"], citedAlongside: [], nextStep: "none" });

    const sub = d.rows.find((r) => r.url === "https://blog.example.com/brass-care")!;
    expect(sub).toMatchObject({ pageId: null, citedCount: 1, nextStep: "compare" });

    const proof = d.rows.filter((r) => r.nextStep === "add_proof");
    expect(proof.map((r) => r.url).sort()).toEqual([U("/blogs/guide/brass-vs-bronze-cabinet-pulls"), U("/pages/care-guide")]);
    for (const r of proof) {
      expect(r).toMatchObject({ citedCount: 0, citedInPrompts: [], providers: [], lastCitedAt: null, citedAlongside: [] });
      expect(r.reason).toContain("Matched to a prompt where the site was not cited");
      expect(r.reason).not.toMatch(/will be cited|will cause|guarantee/i);
    }
    expect(proof.find((r) => r.url === U("/pages/care-guide"))!.reason).toContain(P.clean);
    expect(d.rows.at(-1)!.nextStep).toBe("add_proof"); // cited rows first
    expect(d.completeness).toMatchObject({ covered: 2, total: 6 }); // 6 grounded successful answers, 2 cite your site
  });

  it("demo projects are labelled 'demo' and read the seeded demo observations", async () => {
    const env = createTestEnv({ DEMO_MODE: "true" });
    const user = await seedUser(env);
    const db = new Db(env.DB);
    const demo = await seedDemoProject(env, db, user.userId, FIXED_NOW);
    const ac = await buildAnswerCoverage(db, demo, FIXED_NOW);
    expect(ac.state).toBe("demo");
    expect(ac.labels[0]).toBe("Demo data - simulated run");
    expect(ac.rows).toHaveLength(5);
    const lamps = ac.rows.find((r) => r.text.startsWith("Which table lamps"))!;
    expect(lamps.aiSource).toBe("your_site");
    expect(lamps.gap).toBe("covered");
    const sofas = ac.rows.find((r) => r.text.startsWith("What are the best washable sofas"))!;
    expect(sofas.aiSource).toBe("other_site");
    expect(sofas.matchedPage?.method).toBe("engine_search_query");
    expect(sofas.gap).toBe("improve");
    const midCentury = ac.rows.find((r) => r.text.includes("mid-century"))!;
    expect(midCentury.providersRun).toBe(1); // perplexity failed

    const ce = await buildCitationEvidence(db, demo, FIXED_NOW);
    expect(ce.state).toBe("demo");
    const lamp = ce.rows.find((r) => r.url.endsWith("/products/brass-table-lamp"))!;
    expect(lamp.citedCount).toBe(1);
    expect(lamp.citedAlongside).toEqual([{ host: "lamp-house.example", sourceType: "brand_page" }]);
    expect(lamp.nextStep).toBe("compare");
    // The washable-sofa prompt matches the guide, which another prompt's answer cites: no add-proof duplicate.
    const guide = ce.rows.filter((r) => r.url.endsWith("/blog/how-to-choose-a-washable-sofa"));
    expect(guide).toHaveLength(1);
    expect(guide[0]!.citedCount).toBe(1);
  });
});
