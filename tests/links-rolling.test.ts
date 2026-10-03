/**
 * Internal-links workbench, item 1: the rolling crawl (inventory, round-robin order and cursor, multi-run coverage),
 * the union of the latest snapshots across crawls (stale handling), and bounded snapshot retention.
 */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import { graphSummary } from "@worker/links/graph-read";
import { computeGraph } from "@worker/links/graph-store";
import { runCrawlWith } from "@worker/seo/crawl/run";
import { KEEP_RECENT_CRAWLS, loadInventory, loadInventoryState, pruneSnapshots, refreshInventory, rollingOrder, type InventoryRow } from "@worker/seo/crawl/rolling";
import { normalizeUrlKey } from "@worker/seo/rules/registry";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { fakeSite, html, type FakeRoute } from "./fixtures/crawl/fake-site";
import { HOST, U, projectRow, seedLinkCrawl } from "./links-seed";

async function setup(crawlPages?: number) {
  const env = createTestEnv({ APP_ORIGIN: "https://app.okara.example" });
  const { workspaceId, userId } = await seedUser(env);
  const projectId = await seedProject(env, workspaceId);
  const db = new Db(env.DB);
  if (crawlPages) await db.run("UPDATE project_limits SET crawl_pages = ? WHERE project_id = ?", crawlPages, projectId);
  return { env, db, workspaceId, userId, projectId };
}

const row = (path: string, ord: number, last: string | null, inSitemap = true, source: InventoryRow["source"] = "sitemap"): InventoryRow => ({
  urlKey: normalizeUrlKey(U(path)),
  url: U(path),
  ord,
  source,
  inSitemap,
  lastCrawledAt: last,
});

describe("rolling order (pure)", () => {
  const rows = [
    row("/a", 0, null),
    row("/b", 1, null),
    row("/c", 2, "2026-09-01T00:00:00.000Z"),
    row("/d", 3, "2026-09-10T00:00:00.000Z"),
    row("/e", 4, null, false, "link"),
    row("/f", 5, null),
    row("/g", 6, "2026-09-01T00:00:00.000Z"),
  ];
  const paths = (list: InventoryRow[]) => list.map((r) => new URL(r.url).pathname);

  it("puts never-crawled URLs first (Search Console pages first, sitemap before link-discovered), then the oldest snapshots", () => {
    const impressions = new Map([
      [normalizeUrlKey(U("/f")), 500],
      [normalizeUrlKey(U("/g")), 40],
    ]);
    expect(paths(rollingOrder(rows, { impressions, cursorOrd: null }))).toEqual(["/f", "/a", "/b", "/e", "/g", "/c", "/d"]);
    // Without Search Console data: sitemap order, then oldest first (ties in round-robin order).
    expect(paths(rollingOrder(rows, { impressions: null, cursorOrd: null }))).toEqual(["/a", "/b", "/f", "/e", "/c", "/g", "/d"]);
  });

  it("continues round-robin after the stored cursor and excludes the home page", () => {
    // Cursor at ord 2: equal-priority URLs after it come first, then wrap around.
    expect(paths(rollingOrder(rows, { impressions: null, cursorOrd: 2 }))).toEqual(["/f", "/a", "/b", "/e", "/g", "/c", "/d"]);
    expect(paths(rollingOrder(rows, { impressions: null, cursorOrd: 0, homeKey: normalizeUrlKey(U("/b")) }))).not.toContain("/b");
  });
});

describe("crawl inventory", () => {
  const sitemap = (paths: string[], extra: Partial<{ fetchedCount: number; truncated: boolean }> = {}) => ({
    urls: paths.map(U),
    entries: paths.map((p) => ({ url: U(p), lastmod: null })),
    source: new Map(paths.map((p) => [U(p), "sitemap.xml"])),
    fetchedCount: 1,
    truncated: false,
    ...extra,
  });

  it("appends new sitemap URLs in order, skips unchanged sitemaps, marks removals, and never trusts a failed or capped read", async () => {
    const { db, workspaceId, projectId } = await setup();
    const scope = { id: projectId, workspaceId };
    const first = await refreshInventory(db, scope, sitemap(["/a", "/b", "/c"]), U("/"), FIXED_NOW);
    expect(first.added).toBe(3);
    expect(first.rows.map((r) => [new URL(r.url).pathname, r.ord, r.source, r.inSitemap])).toEqual([
      ["/a", 0, "sitemap", true],
      ["/b", 1, "sitemap", true],
      ["/c", 2, "sitemap", true],
      ["/", 3, "home", false],
    ]);
    const state1 = await loadInventoryState(db, scope);
    expect(state1.sitemapUrls).toBe(3);

    const later = new Date(FIXED_NOW.getTime() + 60_000);
    const same = await refreshInventory(db, scope, sitemap(["/c", "/a", "/b"]), U("/"), later);
    expect(same.added).toBe(0);
    expect((await loadInventoryState(db, scope)).sitemapReadAt).toBe(state1.sitemapReadAt); // unchanged hash: no writes

    const failed = await refreshInventory(db, scope, sitemap([], { fetchedCount: 0 }), U("/"), later);
    expect(failed.removed).toBe(0);
    expect(failed.notes.join(" ")).toMatch(/no sitemap could be read/);
    const capped = await refreshInventory(db, scope, sitemap(["/a", "/d"], { truncated: true }), U("/"), later);
    expect(capped.removed).toBe(0);
    expect(capped.added).toBe(1);

    const gone = await refreshInventory(db, scope, sitemap(["/a", "/d"]), U("/"), later);
    expect(gone.removed).toBe(2);
    const inv = await loadInventory(db, scope);
    expect(inv.filter((r) => r.inSitemap).map((r) => new URL(r.url).pathname).sort()).toEqual(["/a", "/d"]);
    const removedAt = await db.first<{ removed_from_sitemap_at: string | null }>("SELECT removed_from_sitemap_at FROM crawl_inventory WHERE project_id = ? AND url_key = ?", projectId, normalizeUrlKey(U("/b")));
    expect(removedAt!.removed_from_sitemap_at).toBe(later.toISOString());
  });
});

/** Home + p0..p(n-1) in the sitemap; each page links to the next one. */
function rollingSite(n: number, overrides: Record<string, string> = {}) {
  const page = (i: number) =>
    overrides[`/p/${i}`] ??
    `<html><head><title>Page ${i}</title><link rel="canonical" href="${U(`/p/${i}`)}"></head><body><nav><a href="/">Home</a></nav><main><h1>Page ${i}</h1><p>Brass hardware words for page ${i} content here and more words.</p><a href="/p/${(i + 1) % n}">Next page ${(i + 1) % n}</a></main></body></html>`;
  const routes: Record<string, FakeRoute> = {
    [U("/robots.txt")]: { status: 200, contentType: "text/plain", body: `User-agent: *\nAllow: /\nSitemap: ${U("/sitemap.xml")}\n` },
    [U("/sitemap.xml")]: { status: 200, contentType: "application/xml", body: `<urlset><url><loc>${U("/")}</loc></url>${Array.from({ length: n }, (_, i) => `<url><loc>${U(`/p/${i}`)}</loc></url>`).join("")}</urlset>` },
    [U("/")]: html(`<html><head><title>Home</title></head><body><main><h1>Home</h1><a href="/p/0">First page</a></main></body></html>`),
  };
  for (let i = 0; i < n; i++) routes[U(`/p/${i}`)] = html(page(i));
  return fakeSite(routes);
}

const crawledPaths = (site: { urls: () => string[] }) =>
  site
    .urls()
    .map((u) => new URL(u).pathname)
    .filter((p) => p !== "/robots.txt" && p !== "/sitemap.xml" && p !== "/llms.txt");

describe("rolling crawl across runs", () => {
  it("crawls the next batch each run (never-crawled first, then the oldest), and the graph unions the latest snapshots", async () => {
    const { env, db, workspaceId, projectId } = await setup(4);
    const at = (day: string) => new Date(`${day}T10:00:00.000Z`);
    const crawl = async (day: string, site = rollingSite(9)) => {
      const summary = await runCrawlWith(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site.fetch, clock: () => at(day) }), {});
      return { summary, paths: crawledPaths(site) };
    };
    const c1 = await crawl("2026-08-01");
    expect(c1.summary.status).toBe("completed");
    expect(c1.paths).toEqual(["/", "/p/0", "/p/1", "/p/2"]);
    const c2 = await crawl("2026-09-01");
    expect(c2.paths).toEqual(["/", "/p/3", "/p/4", "/p/5"]);
    const c3 = await crawl("2026-09-20");
    expect(c3.paths).toEqual(["/", "/p/6", "/p/7", "/p/8"]);

    const project = await projectRow(db, projectId);
    // After three runs the graph covers the whole sitemap from three crawls' snapshots.
    const g3 = await graphSummary(db, project, at("2026-09-20"));
    expect(g3.coverageLabel).toBe("10 of 10 sitemap URLs analysed (oldest snapshot 2026-08-01)");
    expect(g3.counts!.orphans).toBe(0); // every page is linked from its predecessor (p0 from home and p8)

    // Fourth run: nothing is never-crawled any more; the oldest snapshots (crawl 1) come back, and p0 now links to p5.
    const changed = rollingSite(9, {
      "/p/0": `<html><head><title>Page 0</title></head><body><main><h1>Page 0</h1><p>Brass hardware words.</p><a href="/p/5">Jump to five</a></main></body></html>`,
    });
    const c4 = await crawl("2026-10-01", changed);
    expect(c4.paths).toEqual(["/", "/p/0", "/p/1", "/p/2"]);
    const computed = (await computeGraph(db, project, { now: at("2026-10-02") }))!;
    const node = (p: string) => computed.graph.byKey.get(normalizeUrlKey(U(p)))!;
    expect(node("/p/1").linksIn).toBe(0); // p0's latest snapshot no longer links to p1
    expect(node("/p/1").orphan).toBe(true);
    expect(node("/p/5").linksIn).toBe(2); // p4 (crawl 2 snapshot) and p0 (crawl 4 snapshot)
    // Stale: snapshots older than 30 days (crawl 2 on 2026-09-01) are marked stale; crawl 1's were replaced.
    expect(node("/p/3").stale).toBe(true);
    expect(node("/p/0").stale).toBe(false);
    expect(computed.graph.coverage.stalePages).toBe(3);
    expect(computed.summary.coverageLabel).toBe("10 of 10 sitemap URLs analysed (oldest snapshot 2026-09-01)");

    const state = await loadInventoryState(db, { id: projectId, workspaceId });
    expect(state.cursorOrd).not.toBeNull();
    expect(state.passes).toBeGreaterThanOrEqual(1);
    const notes = JSON.parse((await db.first<{ notes_json: string }>("SELECT notes_json FROM crawl_runs WHERE id = ?", c4.summary.crawlRunId))!.notes_json) as string[];
    expect(notes.join(" ")).toMatch(/Rolling crawl \(rolling-crawl-2026-10-03\.1\): 10 known URLs/);
  });

  it("stores anchors and redirect chains on snapshots, and keeps discovered link targets for later runs", async () => {
    const { env, db, workspaceId, projectId } = await setup(3);
    const site = fakeSite({
      [U("/robots.txt")]: { status: 200, contentType: "text/plain", body: "User-agent: *\nAllow: /\n" },
      [U("/")]: html(
        `<html><head><title>Home</title></head><body><nav aria-label="Breadcrumb"><a href="/collections/lamps">Lamps</a></nav><main><a href="/old">Old lamp guide</a> <a href="/blogs/news/a"><img src="x.jpg" alt="Brass lamp care"></a> <a href="/blogs/news/b">Second guide</a></main><footer><a href="/pages/contact">Contact</a></footer></body></html>`,
      ),
      [U("/old")]: { status: 301, headers: { location: U("/older") } },
      [U("/older")]: { status: 301, headers: { location: U("/blogs/news/a") } },
      [U("/blogs/news/a")]: html(`<html><head><title>A</title></head><body><main><p>Article A text.</p></main></body></html>`),
    });
    const summary = await runCrawlWith(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site.fetch }), {});
    const snap = async (path: string) =>
      db.first<{ link_anchors_json: string | null; redirect_chain_json: string | null; status_code: number | null }>(
        "SELECT s.link_anchors_json, s.redirect_chain_json, s.status_code FROM page_snapshots s JOIN pages p ON p.id = s.page_id WHERE s.crawl_run_id = ? AND p.url = ?",
        summary.crawlRunId,
        U(path),
      );
    const home = await snap("/");
    expect(JSON.parse(home!.link_anchors_json!)).toEqual([
      [U("/collections/lamps"), "Lamps", "b"],
      [U("/old"), "Old lamp guide", "c"],
      [U("/blogs/news/a"), "Brass lamp care", "i"],
      [U("/blogs/news/b"), "Second guide", "c"],
    ]);
    const old = await snap("/old");
    expect(old!.status_code).toBe(301);
    expect(JSON.parse(old!.redirect_chain_json!)).toEqual([
      { status: 301, to: U("/older") },
      { status: 301, to: U("/blogs/news/a") },
    ]);
    // The page limit (3: home, /collections/lamps (404), /old) left the other link targets for later runs: they are in the
    // inventory as never crawled, and the crawled ones carry their crawl time.
    const inv = await loadInventory(db, { id: projectId, workspaceId });
    const never = inv.filter((r) => !r.lastCrawledAt).map((r) => new URL(r.url).pathname);
    expect(never.sort()).toEqual(["/blogs/news/a", "/blogs/news/b", "/pages/contact"]);
    expect(inv.find((r) => r.url === U("/blogs/news/b"))!.source).toBe("link");
    expect(inv.find((r) => r.url === U("/collections/lamps"))!.lastCrawledAt).not.toBeNull();
  });
});

describe("snapshot retention", () => {
  it("keeps every snapshot of the recent crawls, the latest full and the previous compacted per page, and deletes the rest", async () => {
    const { db, workspaceId, projectId } = await setup();
    const day = (i: number) => new Date(Date.UTC(2026, 6, 1 + i * 3, 10)).toISOString();
    const pages = (i: number) => [
      { path: "/a", links: ["/b"], sentences: [`Snapshot ${i} of page a talks about brass.`] },
      { path: "/b", links: ["/a"], sentences: [`Snapshot ${i} of page b talks about brass.`] },
      ...(i < 3 ? [{ path: "/c", links: ["/a"], sentences: [`Snapshot ${i} of page c.`] }] : []),
    ];
    for (let i = 0; i < 10; i++) await seedLinkCrawl(db, workspaceId, projectId, pages(i), { startedAt: day(i) });
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM page_snapshots WHERE project_id = ?", projectId))!.n).toBe(23);

    const r = await pruneSnapshots(db, { id: projectId, workspaceId }, FIXED_NOW);
    expect(KEEP_RECENT_CRAWLS).toBe(7);
    // a and b: 3 old snapshots each deleted (their latest two are in recent crawls); c: crawl 2 kept, crawl 1 compacted, crawl 0 deleted.
    expect(r).toEqual({ compacted: 1, deleted: 7, more: false });
    const rows = await db.all<{ url: string; n: number }>(
      "SELECT p.url, COUNT(*) AS n FROM page_snapshots s JOIN pages p ON p.id = s.page_id WHERE s.project_id = ? GROUP BY p.url ORDER BY p.url",
      projectId,
    );
    expect(rows.map((x) => [new URL(x.url).pathname, x.n])).toEqual([
      ["/a", 7],
      ["/b", 7],
      ["/c", 2],
    ]);
    const c = await db.all<{ compacted_at: string | null; internal_links_json: string; title: string | null }>(
      "SELECT s.compacted_at, s.internal_links_json, s.title FROM page_snapshots s JOIN pages p ON p.id = s.page_id WHERE p.url = ? ORDER BY s.fetched_at",
      U("/c"),
    );
    expect(c[0]).toMatchObject({ internal_links_json: "[]", title: "Page /c" });
    expect(c[0]!.compacted_at).toBe(FIXED_NOW.toISOString());
    expect(c[1]!.compacted_at).toBeNull();
    // Idempotent and bounded: a second pass changes nothing; the graph still has c's latest snapshot.
    expect(await pruneSnapshots(db, { id: projectId, workspaceId }, FIXED_NOW)).toEqual({ compacted: 0, deleted: 0, more: false });
    const g = (await computeGraph(db, await projectRow(db, projectId), { now: FIXED_NOW }))!;
    expect(g.graph.byKey.get(normalizeUrlKey(U("/c")))!.snap!.fetchedAt.slice(0, 10)).toBe(day(2).slice(0, 10));
    // Bound: at most pages + KEEP_RECENT_CRAWLS x pages per crawl full snapshots.
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM page_snapshots WHERE project_id = ? AND compacted_at IS NULL", projectId))!.n).toBeLessThanOrEqual(3 + KEEP_RECENT_CRAWLS * 2);
  });

  it("is a no-op while the project has fewer crawls than the recent window and caps the rows per pass", async () => {
    const { db, workspaceId, projectId } = await setup();
    for (let i = 0; i < 3; i++) await seedLinkCrawl(db, workspaceId, projectId, [{ path: "/a" }], { startedAt: new Date(Date.UTC(2026, 6, 1 + i)).toISOString() });
    expect(await pruneSnapshots(db, { id: projectId, workspaceId }, FIXED_NOW)).toEqual({ compacted: 0, deleted: 0, more: false });
    for (let i = 3; i < 12; i++) await seedLinkCrawl(db, workspaceId, projectId, [{ path: "/a" }, { path: "/b" }], { startedAt: new Date(Date.UTC(2026, 6, 1 + i)).toISOString() });
    const r = await pruneSnapshots(db, { id: projectId, workspaceId }, FIXED_NOW, { maxRows: 2 });
    expect(r.more).toBe(true);
    expect(r.deleted + r.compacted).toBe(2);
  });
});

void HOST;
