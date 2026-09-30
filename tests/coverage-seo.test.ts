/** [A22] SEO coverage views: page audit and content evidence (statuses, action, priority, states, tenancy). */
import { describe, expect, it } from "vitest";
import type { ContentEvidenceRow, CoverageResponse, PageAuditRow } from "@shared/types";
import { Db } from "@worker/lib/db";
import { seedDemoProject } from "@worker/demo/seed";
import { buildPageAudit, h1Cell, schemaCell, titleCell } from "@worker/coverage/page-audit";
import { buildContentEvidence, contentPriority, freshnessCell, priorityLabel, proofCell } from "@worker/coverage/content-evidence";
import { pageKey } from "@worker/coverage/common";
import { PRIORITY_VERSION, priorityBreakdown } from "@worker/seo/recommend/priority";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedUser } from "./helpers/fixtures";
import { GOOD_TITLE, seedCrawl, seedGsc, setup, U, type Setup } from "./coverage-seed";

const pageAudit = async (s: Setup) => (await s.call(`/projects/${s.pid}/seo/page-audit`)) as { status: number; json: { data: CoverageResponse<PageAuditRow> } };
const contentEvidence = async (s: Setup) => (await s.call(`/projects/${s.pid}/seo/content-evidence`)) as { status: number; json: { data: CoverageResponse<ContentEvidenceRow> } };
const rowFor = <T extends { url: string }>(rows: T[], path: string): T => {
  const r = rows.find((x) => x.url === U(path));
  if (!r) throw new Error(`no row for ${path}`);
  return r;
};

// ------------------------------------------------------------------ page audit
describe("coverage: SEO page audit", () => {
  it("derives title / H1 / schema cells and keep / update / review from the latest crawl", async () => {
    const s = await setup();
    // An older crawl must be ignored.
    await seedCrawl(s, [{ path: "/old-only", title: null }], [], { startedAt: "2026-09-01T00:00:00.000Z" });
    await seedCrawl(
      s,
      [
        { path: "/clean", pageType: "landing" },
        { path: "/dup-a", pageType: "landing", title: "Brass pulls for kitchen cabinets and drawers" },
        { path: "/dup-b", pageType: "landing", title: "Brass pulls for kitchen cabinets and drawers" },
        { path: "/no-title", pageType: "landing", title: null },
        { path: "/long-title", pageType: "landing", title: "Solid brass cabinet hardware, knobs, pulls, hinges and latches made to order in small batches" },
        { path: "/no-h1", pageType: "landing", h1: [], headings: [{ level: 2, text: "Intro" }] },
        { path: "/two-h1", pageType: "landing", h1: ["One", "Two"] },
        { path: "/skip", pageType: "landing", headings: [{ level: 1, text: "Main" }, { level: 3, text: "Deep" }] },
        { path: "/products/no-offers", pageType: "product", jsonld: ["Product"], jsonldIssues: [{ type: "Product", issue: "missing_offers", detail: "Product has no offers." }] },
        { path: "/products/no-jsonld", pageType: "product", jsonld: [] },
        { path: "/products/good", pageType: "product", jsonld: ["Product", "BreadcrumbList"] },
        { path: "/blog/no-jsonld", pageType: "article", jsonld: [] },
        { path: "/blog/breadcrumb-only", pageType: "article", jsonld: ["BreadcrumbList"] },
        { path: "/blog/good", pageType: "article", jsonld: ["BlogPosting"] },
        { path: "/about", pageType: "landing", jsonld: [] },
        { path: "/minor-only", pageType: "landing" },
        { path: "/app", pageType: "other", skipped: "js_rendered" },
        { path: "/gone", pageType: "other", status: 404 },
        { path: "/moved", pageType: "other", status: 200, finalPath: "/clean" },
      ],
      [
        { ruleId: "SEO-TITLE-DUPLICATE", severity: "moderate", path: "/dup-a", detail: "Title is shared with 1 other crawled URL(s)." },
        { ruleId: "SEO-TITLE-DUPLICATE", severity: "moderate", path: "/dup-b", detail: "Title is shared with 1 other crawled URL(s)." },
        { ruleId: "SEO-TITLE-MISSING", severity: "major", path: "/no-title" },
        { ruleId: "SEO-H1-MISSING", severity: "moderate", path: "/no-h1" },
        { ruleId: "SEO-H1-MULTIPLE", severity: "minor", path: "/two-h1" },
        { ruleId: "SEO-HEADING-SKIP", severity: "advisory", path: "/skip" },
        { ruleId: "ECOM-PRODUCT-OFFER-INCOMPLETE", severity: "moderate", path: "/products/no-offers" },
        { ruleId: "ECOM-PRODUCT-JSONLD-MISSING", severity: "moderate", path: "/products/no-jsonld" },
        { ruleId: "SEO-META-DESC-MISSING", severity: "minor", path: "/minor-only" },
        { ruleId: "SEO-STATUS-4XX", severity: "major", path: "/gone" },
        { ruleId: "AI-SEARCH-CRAWLER-BLOCKED", severity: "advisory", path: null },
      ],
    );

    const res = await pageAudit(s);
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(d.state).toBe("ready");
    expect(d.rows).toHaveLength(19);
    expect(d.rows.some((r) => r.url === U("/old-only"))).toBe(false);

    const clean = rowFor(d.rows, "/clean");
    expect(clean.title.status).toBe("ok");
    expect(clean.title.detail).toContain(GOOD_TITLE);
    expect(clean.h1.status).toBe("ok");
    expect(clean.schema).toMatchObject({ status: "ok", types: ["BreadcrumbList"] });
    expect(clean.action).toBe("keep");
    expect(clean.findingsCount).toBe(0);

    const dup = rowFor(d.rows, "/dup-a");
    expect(dup.title.status).toBe("review");
    expect(dup.title.detail).toContain("shared with 1 other");
    expect(dup.action).toBe("update"); // fact, moderate

    expect(rowFor(d.rows, "/no-title").title.status).toBe("missing");
    expect(rowFor(d.rows, "/no-title").action).toBe("update");

    const long = rowFor(d.rows, "/long-title");
    expect(long.title.status).toBe("review");
    expect(long.title.detail).toMatch(/characters \(guideline 30-60\)/);
    expect(long.findingsCount).toBe(0);
    expect(long.action).toBe("review"); // heuristic cell flag without a finding

    const noH1 = rowFor(d.rows, "/no-h1");
    expect(noH1.h1.status).toBe("missing");
    expect(noH1.action).toBe("review"); // SEO-H1-MISSING is a heuristic rule
    expect(rowFor(d.rows, "/two-h1").h1).toMatchObject({ status: "review", detail: "2 <h1> elements." });
    expect(rowFor(d.rows, "/two-h1").action).toBe("review");
    expect(rowFor(d.rows, "/skip").h1).toMatchObject({ status: "review", detail: "Heading level jumps from h1 to h3." });

    const noOffers = rowFor(d.rows, "/products/no-offers");
    expect(noOffers.schema.status).toBe("review");
    expect(noOffers.schema.types).toEqual(["Product"]);
    expect(noOffers.schema.detail).toContain("no offers");
    expect(noOffers.action).toBe("update");

    expect(rowFor(d.rows, "/products/no-jsonld").schema.status).toBe("missing");
    expect(rowFor(d.rows, "/products/good").schema.status).toBe("ok");
    expect(rowFor(d.rows, "/products/good").action).toBe("keep");
    expect(rowFor(d.rows, "/blog/no-jsonld").schema.status).toBe("missing");
    expect(rowFor(d.rows, "/blog/breadcrumb-only").schema).toMatchObject({ status: "review", detail: "JSON-LD present but no Article type." });
    expect(rowFor(d.rows, "/blog/good").schema.status).toBe("ok");
    expect(rowFor(d.rows, "/about").schema.status).toBe("not_applicable");
    expect(rowFor(d.rows, "/about").action).toBe("keep");
    expect(rowFor(d.rows, "/minor-only").action).toBe("review");

    const app = rowFor(d.rows, "/app");
    expect([app.title.status, app.h1.status, app.schema.status]).toEqual(["unknown", "unknown", "unknown"]);
    expect(app.title.detail).toBe("Skipped: js_rendered.");
    expect(app.action).toBe("review");
    const gone = rowFor(d.rows, "/gone");
    expect(gone.title.status).toBe("unknown");
    expect(gone.action).toBe("update");
    expect(rowFor(d.rows, "/moved").h1.detail).toContain("Redirects to");

    expect(d.completeness?.note).toContain("1 skipped: js_rendered (1)");
    expect(d.completeness).toMatchObject({ covered: 18, total: 19 });
    expect(d.labels.join(" ")).toContain("guideline");
    expect(d.labels.some((l) => l.includes("1 site-wide finding"))).toBe(true);
  });

  it("does not expect Product markup on product pages of non-ecommerce sites", async () => {
    const s = await setup({ site_type: "saas" });
    await seedCrawl(s, [{ path: "/product", pageType: "product", jsonld: [] }]);
    const d = (await pageAudit(s)).json.data;
    expect(d.rows[0]!.schema.status).toBe("not_applicable");
  });

  it("pure cell helpers", () => {
    const base = {
      pageId: "p",
      url: U("/x"),
      pageType: "landing" as const,
      statusCode: 200,
      finalUrl: U("/x"),
      skippedReason: null,
      title: "Short",
      h1s: ["A"],
      headings: [{ level: 1, text: "A" }],
      jsonldTypes: [],
      jsonldIssues: [],
      wordCount: 10,
      outboundCitations: 0,
      tableCount: 0,
      lastUpdated: null,
      fetchedAt: FIXED_NOW.toISOString(),
    };
    expect(titleCell(base, []).status).toBe("review");
    expect(titleCell({ ...base, title: "   " }, []).status).toBe("missing");
    expect(h1Cell({ ...base, h1s: ["", " "] }).status).toBe("missing");
    expect(schemaCell({ ...base, jsonldTypes: [], jsonldIssues: [{ type: "?", issue: "invalid_json" }] }, "ecommerce").status).toBe("review");
    expect(schemaCell({ ...base, pageType: "product", jsonldTypes: ["Organization"] }, "ecommerce").detail).toContain("no Product type");
  });

  it("is setup_required without verification or without a completed crawl, and 404 across tenants", async () => {
    const unverified = await setup({ verified_host: null, verified_at: null, verification_method: null });
    const u = (await pageAudit(unverified)).json.data;
    expect(u.state).toBe("setup_required");
    expect(u.rows).toEqual([]);
    expect(u.completeness?.note).toContain("Verify site ownership");

    const s = await setup();
    expect((await pageAudit(s)).json.data.state).toBe("setup_required");
    await seedCrawl(s, [{ path: "/a" }], [], { status: "running" });
    const running = (await pageAudit(s)).json.data;
    expect(running.state).toBe("setup_required");
    expect(running.completeness?.note).toContain("in progress");
    expect((await contentEvidence(s)).json.data.state).toBe("setup_required");

    const failed = await setup();
    await seedCrawl(failed, [{ path: "/a" }], [], { status: "failed" });
    expect((await pageAudit(failed)).json.data.state).toBe("error");
    // An older completed crawl is still shown, labelled, when the newest one failed.
    await seedCrawl(failed, [{ path: "/b" }], [], { status: "completed", startedAt: "2026-09-01T00:00:00.000Z" });
    const older = (await pageAudit(failed)).json.data;
    expect(older.state).toBe("ready");
    expect(older.rows.map((r) => r.url)).toEqual([U("/b")]);
    expect(older.labels.some((l) => l.includes("A newer crawl failed"))).toBe(true);

    for (const path of ["seo/page-audit", "seo/content-evidence", "geo/answer-coverage", "geo/citation-evidence"]) {
      const r = await s.callOther(`/projects/${s.pid}/${path}`);
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("not_found");
    }
  });
});

// ------------------------------------------------------------------ content evidence
describe("coverage: SEO content evidence", () => {
  it("reports depth, proof and freshness per own page; priority is null without Search Console data", async () => {
    const s = await setup();
    await seedCrawl(s, [
      { path: "/blog/thin", pageType: "article", words: 100, outbound: 0, tables: 0, lastUpdated: "2024-01-01" },
      { path: "/blog/deep", pageType: "article", words: 900, outbound: 3, tables: 1, lastUpdated: "2026-09-01T00:00:00Z" },
      { path: "/products/pull", pageType: "product", words: 80, outbound: null, tables: null, lastUpdated: null },
      { path: "/collections/knobs", pageType: "collection", words: null, outbound: 0, tables: 2, lastUpdated: "not a date" },
      { path: "/app", pageType: "other", skipped: "js_rendered" },
    ]);
    const d = (await contentEvidence(s)).json.data;
    expect(d.state).toBe("ready");
    expect(d.rows).toHaveLength(4);
    expect(d.completeness?.note).toContain("1 page(s) without analysable content");

    const thin = rowFor(d.rows, "/blog/thin");
    expect(thin.depth).toEqual({ wordCount: 100, status: "review" });
    expect(thin.proof).toEqual({ outboundCitations: 0, tables: 0, status: "missing" });
    expect(thin.freshness).toMatchObject({ lastUpdated: "2024-01-01", status: "review" });
    expect(thin.freshness.ageDays).toBe(1003);
    expect(thin.gsc).toEqual({ impressions: null, clicks: null, window: null });
    expect(thin.priority).toMatchObject({ value: null, label: null, version: null });
    expect(thin.priority.basis).toContain("no Search Console data");

    const deep = rowFor(d.rows, "/blog/deep");
    expect(deep.depth.status).toBe("ok");
    expect(deep.proof).toEqual({ outboundCitations: 3, tables: 1, status: "present" });
    expect(deep.freshness).toMatchObject({ ageDays: 29, status: "ok" });

    const pull = rowFor(d.rows, "/products/pull");
    expect(pull.depth.status).toBe("ok"); // product threshold is 50
    expect(pull.proof.status).toBe("unknown");
    expect(pull.freshness).toEqual({ lastUpdated: null, ageDays: null, status: "unknown" });

    const knobs = rowFor(d.rows, "/collections/knobs");
    expect(knobs.depth).toEqual({ wordCount: null, status: "unknown" });
    expect(knobs.proof.status).toBe("present");
    expect(knobs.freshness).toMatchObject({ lastUpdated: "not a date", ageDays: null, status: "unknown" });

    expect(d.labels).toContain("Competitor columns appear only for competitor URLs you approve; Okara does not crawl competitors automatically.");
  });

  it("computes priority with the SEO formula when GSC data, property totals and a gap exist", async () => {
    const s = await setup();
    await seedCrawl(s, [
      { path: "/blog/stale", pageType: "article", lastUpdated: "2023-05-01" },
      { path: "/blog/fresh", pageType: "article" },
      { path: "/blog/unseen", pageType: "article", outbound: 0, tables: 0 },
    ]);
    await seedGsc(s, {
      pageRows: [
        { path: "/blog/stale", clicks: 250, impressions: 16000 },
        { path: "/blog/fresh", clicks: 100, impressions: 5000 },
      ],
      rows: [{ query: "brass knobs", path: "/blog/stale", clicks: 1, impressions: 10 }],
      totals: { clicks: 1000, impressions: 100000 },
    });
    const d = (await contentEvidence(s)).json.data;
    const stale = rowFor(d.rows, "/blog/stale");
    expect(stale.gsc).toEqual({ impressions: 16000, clicks: 250, window: { start: "2026-08-30", end: "2026-09-26" } });
    const expected = priorityBreakdown({ impressions: 16000, clicks: 250, totalImpressions: 100000, totalClicks: 1000, severity: null, reach: null, effort: "medium" }, "n/a");
    expect(stale.priority.value).toBe(expected.priority);
    expect(stale.priority.value).toBeCloseTo(42.5, 5); // sqrt(0.25) * 100 * 0.85
    expect(stale.priority.label).toBe("high");
    expect(stale.priority.version).toBe(PRIORITY_VERSION);
    expect(stale.priority.basis).toContain("last updated over 365 days ago");

    const fresh = rowFor(d.rows, "/blog/fresh");
    expect(fresh.priority.value).toBeNull();
    expect(fresh.priority.basis).toContain("Not computed");

    const unseen = rowFor(d.rows, "/blog/unseen");
    expect(unseen.gsc.impressions).toBe(0);
    expect(unseen.priority).toMatchObject({ value: 0, label: "low" });
    expect(d.rows[0]!.url).toBe(U("/blog/stale")); // sorted by priority
  });

  it("priority is null when property totals are missing", async () => {
    const s = await setup();
    await seedCrawl(s, [{ path: "/blog/stale", pageType: "article", lastUpdated: "2020-01-01" }]);
    await seedGsc(s, { pageRows: [{ path: "/blog/stale", clicks: 5, impressions: 50 }], totals: null });
    const row = (await contentEvidence(s)).json.data.rows[0]!;
    expect(row.gsc.impressions).toBe(50);
    expect(row.priority.value).toBeNull();
    expect(row.priority.basis).toContain("property totals");
  });

  it("pure helpers: freshness, proof, labels, priority inputs", () => {
    expect(freshnessCell("2027-06-01", FIXED_NOW).status).toBe("review"); // future date
    expect(freshnessCell(null, FIXED_NOW).status).toBe("unknown");
    expect(proofCell({ outboundCitations: null, tableCount: 0 }).status).toBe("unknown");
    expect(proofCell({ outboundCitations: 1, tableCount: null }).status).toBe("present");
    expect(priorityLabel(40)).toBe("high");
    expect(priorityLabel(15)).toBe("medium");
    expect(priorityLabel(14.99)).toBe("low");
    const gap = { depth: { wordCount: 10, status: "review" as const }, proof: { outboundCitations: 1, tables: 0, status: "present" as const }, freshness: { lastUpdated: null, ageDays: null, status: "unknown" as const } };
    expect(contentPriority({ ...gap, gsc: { impressions: null, clicks: null, window: null } }, { impressions: 1, clicks: 1 }).value).toBeNull();
    expect(contentPriority({ ...gap, gsc: { impressions: 10, clicks: 1, window: null } }, null).value).toBeNull();
    expect(pageKey("https://WWW.Shop.Example.com/a/?utm_source=x&b=2#top")).toBe("shop.example.com/a?b=2");
  });
});

// ------------------------------------------------------------------ demo
describe("coverage: SEO demo state", () => {
  it("labels demo projects 'demo' and derives rows from the seeded demo crawl", async () => {
    const env = createTestEnv({ DEMO_MODE: "true" });
    const user = await seedUser(env);
    const db = new Db(env.DB);
    const demo = await seedDemoProject(env, db, user.userId, FIXED_NOW);
    const audit = await buildPageAudit(db, demo, FIXED_NOW);
    expect(audit.state).toBe("demo");
    expect(audit.labels[0]).toBe("Demo data - simulated run");
    const sofa = audit.rows.find((r) => r.url.endsWith("/products/linen-slipcover-sofa"))!;
    expect(sofa.schema.status).toBe("review");
    expect(sofa.action).toBe("update");
    const about = audit.rows.find((r) => r.url.endsWith("/pages/about"))!;
    expect(about.h1.status).toBe("missing");
    expect(about.action).toBe("review");

    const ce = await buildContentEvidence(db, demo, FIXED_NOW);
    expect(ce.state).toBe("demo");
    expect(ce.rows.length).toBe(8);
    const guide = ce.rows.find((r) => r.url.endsWith("/blog/how-to-choose-a-washable-sofa"))!;
    expect(guide.gsc.impressions).toBe(2980 + 1410); // query x page rows summed (lower bound)
    expect(guide.proof.status).toBe("missing");
    expect(guide.priority.value).not.toBeNull();
    expect(ce.labels.some((l) => l.includes("lower bound"))).toBe(true);
  });
});
