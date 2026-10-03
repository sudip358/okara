/**
 * Internal-links workbench, items 1 and 5: the full-site link graph (union of the latest snapshots; content vs
 * navigation links; redirect and canonical credit; orphans with coverage), broken and redirected links with chains and
 * fixes, the per-URL table, CSV exports, the broken-link rule fed by earlier crawls, and D1 limits at 2,000 pages and
 * 20,000 links.
 */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import { anchorReport, brokenLinks, brokenLinksCsv, clusterReport, graphCsv, graphSummary, graphUrlDetail, graphUrls } from "@worker/links/graph-read";
import { assumedCanonical } from "@worker/links/graph";
import { buildAndStoreLinkGraph } from "@worker/links/graph-store";
import { multiRowInsert, runBatches } from "@worker/links/sql";
import { normalizeUrlKey, runRules, type RuleSnapshot } from "@worker/seo/rules/registry";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { HOST, U, projectRow, seedLinkCrawl, type LinkPageSeed } from "./links-seed";

async function setup() {
  const env = createTestEnv();
  const { workspaceId, userId } = await seedUser(env);
  const projectId = await seedProject(env, workspaceId);
  const db = new Db(env.DB);
  return { env, db, workspaceId, userId, projectId };
}

export async function seedInventory(db: Db, workspaceId: string, projectId: string, paths: string[], at = FIXED_NOW.toISOString()) {
  await runBatches(
    db,
    multiRowInsert(
      "crawl_inventory",
      ["workspace_id", "project_id", "url_key", "url", "ord", "source", "in_sitemap", "first_seen_at", "last_crawled_at"],
      paths.map((p, i) => [workspaceId, projectId, normalizeUrlKey(U(p)), U(p), i, p === "/" ? "home" : "sitemap", 1, at, at]),
    ),
  );
}

const SITE: LinkPageSeed[] = [
  { path: "/", pageType: "home", title: "Home", links: ["/collections/lamps", "/blogs/news/a"], anchors: [["/blogs/news/a", "Lamp care guide", "c"]] },
  {
    path: "/collections/lamps",
    pageType: "collection",
    title: "Lamps | Shop",
    h1: ["Lamps"],
    links: ["/", "/collections/lamps/products/brass-lamp", "/products/oak-lamp", "/old-guide"],
    anchors: [
      ["/collections/lamps/products/brass-lamp", "Brass lamp", "c"],
      ["/products/oak-lamp", "Oak lamp", "c"],
      ["/old-guide", "old guide", "c"],
    ],
  },
  { path: "/products/brass-lamp", pageType: "product", title: "Brass Lamp", links: ["/"], anchors: [] },
  { path: "/products/oak-lamp", pageType: "product", title: "Oak Lamp", links: ["/"], anchors: [["/collections/lamps", "Lamps", "b"]] },
  {
    path: "/blogs/news/a",
    pageType: "article",
    title: "Lamp care",
    links: ["/gone", "/moved", "/collections/lamps"],
    anchors: [
      ["/gone", "broken link", "c"],
      ["/moved", "moved page", "c"],
      ["/collections/lamps", "Lamps", "b"],
    ],
  },
  { path: "/gone", status: 404, title: "Not found" },
  { path: "/moved", status: 301, finalPath: "/blogs/news/b", title: null, chain: [{ status: 301, to: "/moved-2" }, { status: 301, to: "/blogs/news/b" }] },
  { path: "/blogs/news/b", pageType: "article", title: "Second article", links: ["/"], anchors: [] },
  { path: "/old-guide", status: 301, finalPath: "/missing", title: null, chain: [{ status: 301, to: "/missing" }] },
  { path: "/missing", status: 404, title: "Missing" },
  { path: "/products/orphan", pageType: "product", title: "Orphan Product", links: ["/"], anchors: [] },
];
const SITEMAP = ["/", "/collections/lamps", "/products/brass-lamp", "/products/oak-lamp", "/blogs/news/a", "/blogs/news/b", "/products/orphan", "/never"];

describe("link graph", () => {
  it("credits redirects and canonicals, separates content and navigation links, lists orphans with coverage", async () => {
    const { db, workspaceId, projectId } = await setup();
    await seedInventory(db, workspaceId, projectId, SITEMAP);
    await seedLinkCrawl(db, workspaceId, projectId, SITE);
    const project = await projectRow(db, projectId);
    const built = (await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: FIXED_NOW }))!;
    const n = (p: string) => built.graph.byKey.get(normalizeUrlKey(U(p)))!;

    expect(assumedCanonical(U("/collections/lamps/products/brass-lamp"))).toBe(U("/products/brass-lamp"));
    expect(n("/products/brass-lamp").linksIn).toBe(1); // via the collection-scoped URL's assumed canonical
    expect(n("/products/brass-lamp").inbound).toEqual([expect.objectContaining({ via: "canonical", kind: "c" })]);
    expect(n("/blogs/news/b").linksIn).toBe(1); // via the redirect from /moved
    expect(n("/collections/lamps").linksIn).toBe(3); // home (navigation), oak lamp and article (breadcrumbs)
    expect(n("/collections/lamps").contentLinksIn).toBe(2); // breadcrumbs count as content/breadcrumb links
    expect(n("/").outAll.length).toBe(2);
    expect(n("/").outContent.length).toBe(1);
    expect(n("/products/orphan").orphan).toBe(true);
    expect(n("/never").snap).toBeNull();
    expect(n("/never").orphan).toBe(false); // not crawled: indexability unknown, never claimed orphan
    expect(built.graph.nodes.some((x) => x.url.includes("other.example"))).toBe(false);

    const s = await graphSummary(db, project, FIXED_NOW);
    expect(s.coverageLabel).toBe(`7 of 8 sitemap URLs analysed (oldest snapshot ${FIXED_NOW.toISOString().slice(0, 10)})`);
    // /gone directly, and /missing through the /old-guide redirect.
    expect(s.counts).toMatchObject({ orphans: 1, redirects: 2, clientErrors: 2 });
    expect(s.labels.join(" ")).toMatch(/1 sitemap URLs are not crawled yet/);

    const orphans = await graphUrls(db, project, { filter: "orphans" }, FIXED_NOW);
    expect(orphans.rows.map((r) => r.url)).toEqual([U("/products/orphan")]);
    const byIn = await graphUrls(db, project, { sort: "links_in", dir: "desc", limit: 2 }, FIXED_NOW);
    expect(byIn.rows.map((r) => [r.url, r.linksIn])).toEqual([
      [U("/"), 5],
      [U("/collections/lamps"), 3],
    ]);
    expect(byIn.total).toBe(built.graph.nodes.length);
    expect(byIn.rows).toHaveLength(2);
    const search = await graphUrls(db, project, { q: "LAMP", sort: "url", dir: "asc" }, FIXED_NOW);
    expect(search.rows.every((r) => /lamp/i.test(r.url) || /lamp/i.test(r.title ?? ""))).toBe(true);
    const notCrawled = await graphUrls(db, project, { filter: "not_crawled" }, FIXED_NOW);
    expect(notCrawled.rows.map((r) => r.url)).toEqual(expect.arrayContaining([U("/never"), U("/collections/lamps/products/brass-lamp")]));

    const detail = await graphUrlDetail(db, project, U("/collections/lamps"), FIXED_NOW);
    expect(detail.inbound.map((i) => [i.url, i.anchor, i.kind])).toEqual(
      expect.arrayContaining([
        [U("/"), null, "navigation"],
        [U("/blogs/news/a"), "Lamps", "breadcrumb"],
      ]),
    );
    expect(detail.outbound.map((o) => o.url)).toEqual(expect.arrayContaining([U("/old-guide")]));
    expect(detail.outbound.find((o) => o.url === U("/old-guide"))!.issue).toBe("redirect");
    const moved = await graphUrlDetail(db, project, U("/moved"), FIXED_NOW);
    expect(moved.redirectChain).toEqual([
      { status: 301, to: U("/moved-2") },
      { status: 301, to: U("/blogs/news/b") },
    ]);
  });

  it("lists broken and redirected links with chains and fixes, and exports them as CSV with a BOM", async () => {
    const { db, workspaceId, projectId } = await setup();
    await seedInventory(db, workspaceId, projectId, SITEMAP);
    await seedLinkCrawl(db, workspaceId, projectId, SITE);
    const project = await projectRow(db, projectId);
    await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: FIXED_NOW });
    const r = await brokenLinks(db, project, FIXED_NOW);
    const row = (target: string) => r.rows.find((x) => x.targetUrl === U(target))!;
    expect(row("/gone")).toMatchObject({ sourceUrl: U("/blogs/news/a"), anchor: "broken link", kind: "content", issue: "client_error", statusCode: 404, fix: "Remove or replace the link" });
    expect(row("/moved")).toMatchObject({ issue: "redirect", statusCode: 301, finalUrl: U("/blogs/news/b"), finalStatus: 200, fix: `Link to ${U("/blogs/news/b")}` });
    expect(row("/moved").chain).toHaveLength(2);
    expect(row("/old-guide").fix).toBe(`Remove or replace the link: it redirects to ${U("/missing")}, which returned HTTP 404.`);
    // Errors first, then redirects; uncrawled link targets are counted, never claimed broken.
    expect(r.rows[0]!.issue).toBe("client_error");
    expect(r.rows.some((x) => x.targetUrl === U("/collections/lamps/products/brass-lamp"))).toBe(false);
    expect(r.unchecked).toBeGreaterThanOrEqual(1);

    const csv = await brokenLinksCsv(db, project, FIXED_NOW);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("Source URL,Anchor,Link position,Target URL,Status,Issue,Final URL,Redirect chain,Fix,Target checked,Source checked,Stale");
    expect(lines.find((l) => l.includes("/moved,"))).toContain(`301 ${U("/moved-2")} > 301 ${U("/blogs/news/b")}`);

    const graph = await graphCsv(db, project, FIXED_NOW);
    expect(graph.startsWith("﻿")).toBe(true);
    const g = graph.slice(1).split("\r\n");
    expect(g[0]).toBe("URL,Title,Status,In sitemap,Indexable,Links in,Content links in,Links out,Content links out,Orphan,Inbound sources (anchors),Outbound targets,Hub,Hub method,Last crawled,Stale,Impressions,Clicks,Avg position");
    expect(g.find((l) => l.startsWith(`${U("/collections/lamps")},`))).toContain(`${U("/blogs/news/a")} [Lamps]`);
  });

  it("feeds earlier crawls' statuses to the broken-internal-link rule", () => {
    const snap = (path: string, over: Partial<RuleSnapshot> = {}): RuleSnapshot => ({
      url: U(path),
      finalUrl: U(path),
      statusCode: 200,
      pageType: "other",
      skippedReason: null,
      title: "T",
      metaDescription: "D",
      h1s: ["H"],
      headings: [],
      canonical: U(path),
      robotsMeta: null,
      jsonLdTypes: [],
      jsonLdIssues: [],
      internalLinks: [],
      wordCount: 300,
      firstParagraph: null,
      contentHash: path,
      ...over,
    });
    const base = { siteType: "ecommerce" as const, verifiedHost: HOST, sitemapUrls: [], robots: null, aiCrawlerAccess: null };
    const snapshots = [snap("/a", { internalLinks: [U("/old-404"), U("/fine")] })];
    expect(runRules({ ...base, snapshots }).filter((f) => f.ruleId === "SEO-LINK-BROKEN-INTERNAL")).toHaveLength(0);
    const known = new Map([
      [U("/old-404"), { statusCode: 404, skippedReason: null, fetchedAt: "2026-09-12T00:00:00.000Z", finalUrl: U("/old-404") }],
      [U("/fine"), { statusCode: 200, skippedReason: null, fetchedAt: "2026-09-12T00:00:00.000Z", finalUrl: U("/fine") }],
    ]);
    const f = runRules({ ...base, snapshots, knownLinkTargets: known }).filter((x) => x.ruleId === "SEO-LINK-BROKEN-INTERNAL");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toMatch(/1 internal link\(s\) point to URLs that returned an error \(1 checked in an earlier crawl\)/);
    expect(f[0]!.evidence.targets).toEqual([{ url: U("/old-404"), status: 404, checkedAt: "2026-09-12" }]);
  });
});

describe("link graph at scale (D1 limits)", () => {
  it("builds and reads a 2,000-page, 20,000-link graph without statements over 100 parameters", async () => {
    const { db, workspaceId, projectId } = await setup();
    const N = 2000;
    const at = FIXED_NOW.toISOString();
    const crawlId = "crw_scale";
    await db.insert("crawl_runs", { id: crawlId, workspace_id: workspaceId, project_id: projectId, status: "completed", pages_limit: 200, started_at: at, finished_at: at });
    const path = (i: number) => (i < 100 ? `/collections/c${i}` : i % 2 ? `/products/p${i}` : `/blogs/news/a${i}`);
    await runBatches(
      db,
      multiRowInsert(
        "pages",
        ["id", "workspace_id", "project_id", "url", "page_type", "page_type_method", "first_seen_at", "last_crawled_at"],
        Array.from({ length: N }, (_, i) => [`pg_${i}`, workspaceId, projectId, U(path(i)), i < 100 ? "collection" : i % 2 ? "product" : "article", "url_pattern", at, at]),
      ),
    );
    const snaps = Array.from({ length: N }, (_, i) => {
      const targets = Array.from({ length: 10 }, (_, j) => (i * 7 + j * 13 + 1) % N).filter((t) => t !== i);
      return [
        `snap_${i}`,
        workspaceId,
        projectId,
        `pg_${i}`,
        crawlId,
        200,
        U(path(i)),
        `Page ${i} about brass ${i % 50}`,
        JSON.stringify([`Page ${i}`]),
        JSON.stringify(targets.map((t) => U(path(t)))),
        JSON.stringify(targets.map((t) => [U(path(t)), `anchor ${t % 40}`, "c"])),
        U(path(i)),
        at,
      ];
    });
    await runBatches(
      db,
      multiRowInsert(
        "page_snapshots",
        ["id", "workspace_id", "project_id", "page_id", "crawl_run_id", "status_code", "final_url", "title", "h1_json", "internal_links_json", "link_anchors_json", "canonical", "fetched_at"],
        snaps,
      ),
    );
    await seedInventory(db, workspaceId, projectId, Array.from({ length: N }, (_, i) => path(i)));
    const project = await projectRow(db, projectId);

    const t0 = Date.now();
    const built = (await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: FIXED_NOW }))!;
    const ms = Date.now() - t0;
    expect(built.graph.edges).toBeGreaterThanOrEqual(19_000);
    expect(built.graph.edges).toBeLessThanOrEqual(20_000);
    expect(built.summary.coverageLabel).toBe(`2,000 of 2,000 sitemap URLs analysed (oldest snapshot ${at.slice(0, 10)})`);
    expect(ms).toBeLessThan(20_000);
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM link_graph_urls WHERE project_id = ?", projectId))!.n).toBe(N);

    const page = await graphUrls(db, project, { filter: "all", sort: "links_in", dir: "desc", limit: 200, offset: 1800 }, FIXED_NOW);
    expect(page.rows).toHaveLength(200);
    expect(page.total).toBe(N);
    const detail = await graphUrlDetail(db, project, U(path(5)), FIXED_NOW);
    expect(detail.inbound.length).toBeGreaterThan(0);
    const csv = await graphCsv(db, project, FIXED_NOW);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(N + 1);
    const clusters = await clusterReport(db, project);
    expect(clusters.counts.hubs).toBe(100);
    const anchors = await anchorReport(db, project, { flaggedOnly: false });
    expect(anchors.rows.length).toBeGreaterThan(0);
    const broken = await brokenLinks(db, project, FIXED_NOW);
    expect(broken.rows).toHaveLength(0);
    // A rebuild replaces the stored graph (bounded retention: one ready graph per project).
    await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: new Date(FIXED_NOW.getTime() + 60_000) });
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM link_graphs WHERE project_id = ?", projectId))!.n).toBe(1);
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM link_graph_urls WHERE project_id = ?", projectId))!.n).toBe(N);
  }, 60_000);
});
