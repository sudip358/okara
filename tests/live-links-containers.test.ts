/**
 * Live view internal-link containers (docs/live-view-design.md section 18), web side: server-rendered markup of each
 * container's loading, error, setup, empty and data states from demo-shaped fixtures; the pure helpers (n of m
 * meters, broken-link counts, cluster gaps, anchor thresholds, placed-link summary); registration in the container
 * registry and the "Containers" menu; the SEO board rendering them with their run buttons; and honesty rules (plain
 * text, no invented percentages, fixed-layout tables, a link to the matching Internal links tab).
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { buildTimeline } from "../src/web/pages/live/engine";
import { linkContainerActions, moreSeoActions, seoPanelActions, type ActionEnv } from "../src/web/pages/live/run-actions";
import {
  LINK_TAB,
  anchorFlagCounts,
  anchorThresholdCaption,
  anchorThresholds,
  brokenStatusText,
  brokenSummary,
  clusterGaps,
  coverageMeters,
  graphCaption,
  graphNotes,
  graphSizeText,
  linkDeps,
  linksTabPath,
  meterFraction,
  missingText,
  placedSummary,
} from "../src/web/pages/live/more/links-lib";
import { SEO_CONTAINERS, isLazy, parseHidden, serializeHidden } from "../src/web/pages/live/more/registry";
import { assessment } from "./geo-batch-board-fixtures";
import { activity, at, coverageRow, evidenceRow, linkReport, overview, seoFeed } from "./live-web-fixtures";
import { HOSTILE_TEXT, anchors, brokenData, brokenEmpty, clusters, graphSummary, placed } from "./live-links-fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const lc = await load<Record<"LinkGraphPanel" | "BrokenLinksPanel" | "ClusterGapsPanel" | "AnchorFlagsPanel" | "PlacedLinksPanel", FC>>("../src/web/pages/live/more/LinkContainers.tsx");
const { ContainersMenu } = await load<Record<"ContainersMenu", FC>>("../src/web/pages/live/more/ContainersMenu.tsx");
const moreData = await load<{ LiveMoreContext: { Provider: FC } }>("../src/web/pages/live/more/data.ts");
const ra = await load<{ PanelActionsContext: { Provider: FC }; RunActionsProvider: FC }>("../src/web/pages/live/RunActions.tsx");
const { SeoBoard } = await load<Record<"SeoBoard", FC>>("../src/web/pages/live/SeoBoard.tsx");

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, h(ra.RunActionsProvider, { projectId: "p1", onStarted: () => {}, onReload: () => {} }, el)));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
const st = <T,>(data: T | null, error: unknown = null) => ({ data, error, loading: data === null && !error, reload: () => {}, setData: () => {} });
const base = { reduced: false, projectId: "p1", replaying: false, verified: true };

/** Words and shapes that must never render (no projection, no score, plain text only). */
const FORBIDDEN: RegExp[] = [/Simulated run/, /\bchance\b/i, /\d\s*\/\s*10\b/, /\bTraffic\b/, /\bRevenue\b/, /\bforecast/i, /\bscore\b/i, /\bConfidence\b/];
function expectHonest(html: string) {
  const t = text(html);
  for (const re of FORBIDDEN) expect(re.test(t), `forbidden ${re}`).toBe(false);
  expect(html).not.toContain("<script>");
  expect(html).not.toMatch(/<img[^>]*onerror/);
  expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+="/i);
  for (const m of html.matchAll(/<table class="([^"]*)"/g)) expect(m[1]).toMatch(/w-full table-fixed/);
}
/** The only percentages allowed are the anchor thresholds and the server's own reason lines. */
const percents = (t: string) => t.match(/\d+(?:\.\d+)?%/g) ?? [];

// ------------------------------------------------------------------ 16 link graph coverage
describe("16 link graph coverage", () => {
  it("demo data: n-of-m meters with bars, build time and trigger, demo caption, link to the Link graph tab", () => {
    const html = render(h(lc.LinkGraphPanel, { ...base, replaying: true, state: st(graphSummary()), action: null }));
    const t = text(html);
    expect(t).toContain("16 Link graph coverage");
    expect(t).toContain("8 analysed");
    expect(t).toContain("of 8 sitemap URLs");
    expect(t).toContain("Demo data - simulated run");
    expect(t).toMatch(/From your latest link graph \(built 3 Oct, \d\d:\d\d from the demo crawl\), not part of this run/);
    expect(t).toContain("Current state, not replayed");
    expect(t).toContain("Sitemap URLs analysed 8 of 8 sitemap URLs");
    expect(t).toContain("Orphan pages (0 links in) 3 of 8 sitemap URLs");
    expect(t).toContain("No content links in 3 of 8 sitemap URLs");
    expect(t).toContain("Stale snapshots (older than 30 days) 0 of 8 crawled pages");
    expect(t).toContain("Known URLs not crawled yet 0 of 8 known URLs");
    expect(t).toContain("32 page-to-page links between 8 URLs (32 in body content)");
    expect((html.match(/role="meter"/g) ?? []).length).toBe(5);
    expect(html).toMatch(/aria-valuetext="3 of 8 sitemap URLs"/);
    expect(html).toContain('href="/projects/p1/internal-links?tab=graph"');
    expect(t).toContain("Open Internal links , Link graph tab");
    expect(percents(t)).toEqual([]);
    expectHonest(html);
  });
  it("shows the chosen run button and a newer crawl; a graph built by a crawl claims neither this run nor another", () => {
    const action = linkContainerActions(env())["link-graph:rebuild"];
    const html = render(h(lc.LinkGraphPanel, { ...base, state: st(graphSummary({ state: "ready", trigger: "crawl", newerCrawl: "2026-10-03T18:00:00.000Z" })), action }));
    const t = text(html);
    expect(html).toContain('data-action="link-graph-rebuild"');
    expect(t).toContain("Rebuild link graph");
    expect(t).toContain("A crawl finished after this graph was built (started 3 Oct); rebuild the graph to include it.");
    expect(t).toMatch(/From your latest link graph \(built 3 Oct, \d\d:\d\d after a crawl\)/);
    expect(t).not.toContain("not part of this run");
    expect(t).not.toContain("Demo data");
  });
  it("setup (no crawl / unverified), no graph yet, loading and error states never show zero counts", () => {
    const noCrawl = text(render(h(lc.LinkGraphPanel, { ...base, action: null, state: st(graphSummary({ state: "setup_required", graphId: null, coverage: null, counts: null, rolling: null, builtAt: null, trigger: null, labels: ["No crawl yet. Run the SEO agent to crawl demo.example; the link graph is built after each crawl."] })) })));
    expect(noCrawl).toContain("Setup required");
    expect(noCrawl).toContain("No crawl yet.");
    expect(noCrawl).toContain("The link graph is built at the end of every crawl of your verified site.");
    expect(noCrawl).not.toContain("analysed");
    const unverified = render(h(lc.LinkGraphPanel, { ...base, verified: false, action: null, state: st(graphSummary({ state: "setup_required", graphId: null, coverage: null, counts: null, rolling: null, labels: ["Verify site ownership first."] })) }));
    expect(unverified).toContain('href="/projects/p1/settings"');
    const noGraph = text(render(h(lc.LinkGraphPanel, { ...base, action: null, state: st(graphSummary({ state: "ready", graphId: null, builtAt: null, coverage: null, counts: null, rolling: null })) })));
    expect(noGraph).toContain("No link graph yet.");
    expect(text(render(h(lc.LinkGraphPanel, { ...base, action: null, state: st(null) })))).toContain("Loading the link graph…");
    expect(text(render(h(lc.LinkGraphPanel, { ...base, action: null, state: st(null, new Error("boom")) })))).toContain("Could not load the link graph");
  });
  it("without a sitemap: crawled pages, no bar for counts without a denominator", () => {
    const g = graphSummary({ coverage: { ...graphSummary().coverage!, sitemapUrls: 0, sitemapAnalysed: 0 }, rolling: null });
    const m = coverageMeters(g);
    expect(m[0]).toMatchObject({ key: "analysed", label: "Crawled pages analysed", n: 8, m: null });
    expect(m.find((x) => x.key === "orphans")).toMatchObject({ m: 8, of: "crawled pages" });
    expect(m.find((x) => x.key === "no_content")).toMatchObject({ m: null });
    expect(m.find((x) => x.key === "not_crawled")).toBeUndefined();
    const t = text(render(h(lc.LinkGraphPanel, { ...base, action: null, state: st(g) })));
    expect(t).toContain("8 pages analysed");
    expect(t).toContain("no sitemap inventory yet");
  });
});

// ------------------------------------------------------------------ 17 broken and redirected links
describe("17 broken and redirected internal links", () => {
  it("data: counts by status (4xx/5xx, 3xx with final URL, chains), top rows with source, anchor, target, status and fix", () => {
    const html = render(h(lc.BrokenLinksPanel, { ...base, state: st(brokenData()) }));
    const t = text(html);
    expect(t).toContain("17 Broken and redirected internal links");
    expect(t).toContain("6 links");
    expect(t).toContain("3 to 4xx/5xx · 3 redirected");
    expect(t).toContain("4xx: 2 links · 1 URL");
    expect(t).toContain("5xx: 1 link · 1 URL");
    expect(t).toContain("3xx: 3 links · 3 URLs");
    expect(t).toContain("Redirected links: 1 through a chain (2+ hops) · 1 ending in 4xx/5xx · 1 leaving the site · 2 linked URLs not crawled yet.");
    expect(t).toContain("/blog/how-to-choose-a-washable-sofa");
    expect(t).toContain("“washable sofas”");
    expect(t).toContain("Navigation / template");
    expect(t).toContain("301 → 200 (2 hops)");
    expect(t).toContain("302 → off-site");
    expect(t).toContain("301 → 404");
    expect(t).toContain("→ /collections/table-lamps");
    expect(t).toContain("Link to https://demo.example/collections/table-lamps");
    expect(html).toContain('title="Chain: 301 → /collections/lamp · 301 → /collections/table-lamps"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="/projects/p1/internal-links?tab=broken"');
    expect(percents(t)).toEqual([]);
    expectHonest(html);
  });
  it("demo: an empty graph result says so with the server's notes; setup and no-graph states", () => {
    const empty = text(render(h(lc.BrokenLinksPanel, { ...base, state: st(brokenEmpty()) })));
    expect(empty).toContain("No broken or redirected internal links in the analysed pages.");
    expect(empty).toContain("Fetch errors and timeouts are never claimed broken.");
    expect(empty).toContain("Demo data - simulated run");
    // A graph exists and lists nothing: zero is a measured count here (setup states never show one).
    expect(empty).toContain("0 links");
    const setup = text(render(h(lc.BrokenLinksPanel, { ...base, verified: false, state: st(brokenEmpty({ state: "setup_required", graphId: null, labels: ["Verify site ownership first; links are checked only from crawls of your verified site."] })) })));
    expect(setup).toContain("Setup required");
    expect(setup).toContain("Verify the site in Settings");
    expect(text(render(h(lc.BrokenLinksPanel, { ...base, state: st(brokenEmpty({ state: "ready", graphId: null, builtAt: null })) })))).toContain("No link graph yet.");
  });
  it("status text and summary helpers", () => {
    const s = brokenSummary(brokenData());
    expect(s).toEqual({ listed: 6, clientErrors: 2, serverErrors: 1, redirects: 3, chains: 1, redirectsToErrors: 1, offSite: 1, targets: { client: 1, server: 1, redirect: 3 } });
    expect(brokenStatusText({ issue: "client_error", statusCode: 410, finalUrl: null, finalStatus: null, chain: [] })).toBe("410");
    expect(brokenStatusText({ issue: "redirect", statusCode: 301, finalUrl: "https://x/y", finalStatus: null, chain: [{ status: 301, to: "https://x/y" }] })).toBe("301 → not crawled");
  });
});

// ------------------------------------------------------------------ 18 hub and cluster gaps
describe("18 hub and cluster gaps", () => {
  it("data: hubs sorted by missing links with linked/partly/unlinked counts and the missing directions", () => {
    const html = render(h(lc.ClusterGapsPanel, { ...base, state: st(clusters()) }));
    const t = text(html);
    expect(t).toContain("18 Hub and cluster gaps");
    expect(t).toContain("2 spokes missing a link");
    expect(t).toContain("of 4 spokes in 2 hubs");
    expect(t).toContain("Linked both ways 2");
    expect(t).toContain("Partly linked 1");
    expect(t).toContain("Unlinked 1");
    expect(t).toContain("Missing links: 2 hub → spoke · 1 spoke → hub.");
    // The sofas hub (2 missing links) comes before the table lamps hub (1), whatever the server order.
    expect(t.indexOf(HOSTILE_TEXT)).toBeLessThan(t.indexOf("Table Lamps | Demo Furnishings"));
    expect(t).toContain("2 missing links");
    expect(t).toContain("both directions missing");
    expect(t).toContain("hub → spoke missing");
    expect(t).toContain("1 · 0 · 1 of 2");
    expect(html).toContain('aria-label="2 spokes: 1 linked both ways, 0 partly linked, 1 unlinked"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="/projects/p1/internal-links?tab=clusters"');
    expectHonest(html);
  });
  it("empty, setup and helper", () => {
    expect(text(render(h(lc.ClusterGapsPanel, { ...base, state: st(clusters({ hubs: [], counts: { hubs: 0, spokes: 0, linked: 0, partial: 0, unlinked: 0, unassigned: 3 } })) })))).toContain("No hubs found yet.");
    expect(text(render(h(lc.ClusterGapsPanel, { ...base, state: st(clusters({ state: "setup_required", graphId: null, hubs: [], labels: ["Verify site ownership first."] })) })))).toContain("Setup required");
    const g = clusterGaps(clusters(), 1, 1);
    expect(g.totalHubs).toBe(2);
    expect(g.hubs).toHaveLength(1);
    expect(g.hubs[0]!.gaps).toBe(2);
    expect(g.hubs[0]!.examples).toHaveLength(1);
    expect(missingText({ hubToSpoke: true, spokeToHub: false })).toBe("spoke → hub missing");
  });
});

// ------------------------------------------------------------------ 19 anchor text flags
describe("19 anchor text flags", () => {
  it("data: flag counts with the documented thresholds as caption and tooltips; rows with the server's reasons", () => {
    const html = render(h(lc.AnchorFlagsPanel, { ...base, state: st(anchors()) }));
    const t = text(html);
    expect(t).toContain("19 Anchor text flags");
    expect(t).toContain("2 pages flagged");
    expect(t).toContain("Exact-match heavy 1");
    expect(t).toContain("Generic anchors 1");
    expect(t).toContain("Empty anchors 1");
    expect(t).toContain("Repeated anchor 0");
    expect(t).toContain("Thresholds (engineering defaults, not search-engine rules): exact match > 50% with ≥ 5 links · repeated: one anchor from ≥ 10 pages and ≥ 60% · no query terms: ≥ 3 anchored links.");
    expect(html).toContain('title="Exact-match heavy: More than 50% of anchored links use the exact keyword, with at least 5 links"');
    expect(t).toContain("7 anchored links · 1 distinct anchor · keyword “Furniture for real living rooms” (H1, no Search Console query)");
    expect(t).toContain('100% of 7 anchored links use the exact-match anchor "Furniture for real living rooms"');
    // The most used anchor is shown only when no reason line quotes it already.
    expect(t).not.toContain("Most used: “Furniture for real living rooms”");
    expect(t).toContain("1 empty anchor");
    expect(html).toContain("&lt;script&gt;");
    expect(t).not.toContain("Flags (engineering defaults");
    expect(html).toContain('href="/projects/p1/internal-links?tab=anchors"');
    // Percentages: the thresholds caption (50%, 60%) and the server's reason line (100%, its threshold 50%) only.
    expect(percents(t).sort()).toEqual(["100%", "50%", "50%", "60%"]);
    expectHonest(html);
  });
  it("no flags, setup and threshold helpers (a missing threshold is left out, never guessed)", () => {
    expect(text(render(h(lc.AnchorFlagsPanel, { ...base, state: st(anchors({ rows: [], total: 0 })) })))).toContain("No anchor flags: every audited page is within the thresholds.");
    expect(text(render(h(lc.AnchorFlagsPanel, { ...base, state: st(anchors({ state: "setup_required", graphId: null, rows: [], labels: ["Verify site ownership first."] })) })))).toContain("Setup required");
    expect(anchorThresholdCaption({})).toBe("Thresholds (engineering defaults, not search-engine rules): as returned by the anchor audit.");
    expect(anchorThresholds({}).exact_match_heavy).toBe("More than the threshold share of anchored links use the exact keyword");
    expect(anchorFlagCounts(anchors())).toEqual({ exact_match_heavy: 1, repeated_anchor: 0, generic_anchor: 1, empty_anchor: 1, no_query_terms: 0 });
  });
});

// ------------------------------------------------------------------ 20 placed links verification
describe("20 placed links verification", () => {
  it("demo data: verified / not found / pending of the total, the latest not-found rows with the server's label", () => {
    const html = render(h(lc.PlacedLinksPanel, { ...base, state: st(placed()) }));
    const t = text(html);
    expect(t).toContain("20 Placed links verification");
    expect(t).toContain("0 verified");
    expect(t).toContain("of 2 placed links · 1 not found");
    expect(t).toContain("Verified 0 of 2");
    expect(t).toContain("Not found 1 of 2");
    expect(t).toContain("Pending crawl 1 of 2");
    expect(t).toContain("/collections/sofas → should link to /blog/how-to-choose-a-washable-sofa");
    expect(t).toContain("“choose a washable sofa” · accepted since 3 Oct");
    expect(t).toContain("not found in crawl of 2026-10-03");
    expect(t).toContain("1 link waits for the next crawl of its source page.");
    expect(t).toContain("From your placed links, checked at every link graph build (latest check: crawl of 3 Oct)");
    expect(t).toContain("Demo data - simulated run");
    expect(html).toContain('aria-label="Verified 0, Not found 1, Source unavailable 0, Pending crawl 1 of 2 placed links"');
    expect(html).toContain('href="/projects/p1/internal-links?tab=placed"');
    expect(percents(t)).toEqual([]);
    expectHonest(html);
  });
  it("empty and setup states; latest not found first", () => {
    const empty = render(h(lc.PlacedLinksPanel, { ...base, state: st(placed({ rows: [], counts: { total: 0, verified: 0, notFound: 0, pending: 0, sourceUnavailable: 0, notChecked: 0 } })) }));
    expect(text(empty)).toContain("No placed links yet.");
    expect(empty).toContain('href="/projects/p1/import"');
    expect(text(empty)).not.toContain("0 verified");
    expect(text(render(h(lc.PlacedLinksPanel, { ...base, verified: false, state: st(placed({ state: "setup_required" })) })))).toContain("Verify your site first");
    const two = placed();
    const older = { ...two.rows[0]!, key: "k0", sourceUrl: "https://demo.example/a", verification: { ...two.rows[0]!.verification, checkedAt: "2026-09-01T00:00:00.000Z" } };
    const s = placedSummary({ ...two, rows: [older, ...two.rows], counts: { ...two.counts, total: 3, notFound: 2 } });
    expect(s.notFoundRows.map((x) => x.key)).toEqual(["k1", "k0"]);
    expect(s.pending).toBe(1);
    expect(s.latestCheck).toBe("2026-10-03T17:09:40.000Z");
  });
});

// ------------------------------------------------------------------ helpers, registry, menu, board
describe("helpers", () => {
  it("captions, notes, sizes, bars and tabs", () => {
    expect(graphCaption(null, "crawl")).toBeNull();
    expect(graphCaption("2026-10-03T19:12:00.000Z", "manual")).toMatch(/rebuilt on request\), not part of this run$/);
    expect(graphCaption("2026-10-03T19:12:00.000Z", "run")).toMatch(/by a link analysis run\), not part of this run$/);
    expect(graphNotes(graphSummary({ labels: ["Built from the latest snapshot of every crawled page across crawls (x).", "A crawl finished after this graph was built (started 2026-10-03T18:00:00Z); rebuild to include it.", "Keep me."] }))).toEqual(["Keep me."]);
    expect(graphSizeText(graphSummary({ counts: { ...graphSummary().counts!, edges: 1, urls: 1, contentEdges: 0 } }))).toBe("1 page-to-page link between 1 URL (0 in body content)");
    expect(meterFraction(3, 8)).toBe(0.375);
    expect(meterFraction(3, 0)).toBe(0);
    expect(meterFraction(3, null)).toBe(0);
    expect(LINK_TAB).toEqual({ "link-graph": "graph", "broken-links": "broken", "cluster-gaps": "clusters", "anchor-flags": "anchors", "placed-links": "placed" });
    expect(linksTabPath("anchor-flags")).toBe("internal-links?tab=anchors");
  });
  it("refetch keys: the crawl's terminal event and the link reload counter, nothing else (no polling)", () => {
    // Whole LiveMoreValue-shaped inputs: the GSC, batch, budget, sheets and gap keys never refetch these containers.
    const live = { keys: { gsc: "g", crawl: "evt:9", batch: "b", budget: "x" }, reloads: { sheets: 4, gap: 5, links: 2 } };
    const fresh = { keys: { gsc: "", crawl: "", batch: "", budget: "" }, reloads: { sheets: 0, gap: 0 } as { sheets: number; gap: number; links?: number } };
    expect(linkDeps(live)).toEqual(["evt:9", 2]);
    expect(linkDeps(fresh)).toEqual(["", 0]);
  });
});

describe("registry and Containers menu", () => {
  it("SEO 16-20 continue the numbering, are lazily mounted and listed in the menu", () => {
    const links = SEO_CONTAINERS.filter((c) => c.links);
    expect(links.map((c) => `${c.num} ${c.title} [${c.tab}]`)).toEqual([
      "16 Link graph coverage [Link graph]",
      "17 Broken and redirected internal links [Broken links]",
      "18 Hub and cluster gaps [Clusters]",
      "19 Anchor text flags [Anchors]",
      "20 Placed links verification [Placed links]",
    ]);
    expect(SEO_CONTAINERS.map((c) => c.num).slice(-6)).toEqual(["15", "16", "17", "18", "19", "20"]);
    expect(links.every((c) => isLazy(c) && !c.more)).toBe(true);
    expect(new Set(SEO_CONTAINERS.map((c) => c.key)).size).toBe(SEO_CONTAINERS.length);
    const open = renderToStaticMarkup(h(ContainersMenu, { defs: SEO_CONTAINERS, hidden: new Set(["anchor-flags"]), onToggle: () => {}, onShowAll: () => {}, defaultOpen: true }));
    expect((open.match(/role="menuitemcheckbox"/g) ?? []).length).toBe(20);
    for (const k of ["link-graph", "broken-links", "cluster-gaps", "anchor-flags", "placed-links"]) expect(open).toContain(`data-container="${k}"`);
    expect(open).toMatch(/aria-checked="false"[^>]*data-container="anchor-flags"/);
    expect(text(open)).toContain("16 Link graph coverage");
    expect(text(open)).toContain("1 hidden");
    expect([...parseHidden('["placed-links","nope","link-graph"]', "seo")].sort()).toEqual(["link-graph", "placed-links"]);
    expect(serializeHidden(new Set(["placed-links", "pages"]), "seo")).toBe('["pages","placed-links"]');
  });
});

function env(over: Partial<ActionEnv> = {}): ActionEnv {
  return {
    projectId: "p1", demo: false, verifiedHost: "shop.example", gscProperty: "sc-domain:shop.example", running: { seo: false, geo: false }, manualToday: 0,
    engines: [{ provider: "gemini", name: "Gemini", ready: true, detail: null }], promptCount: 4, buyer: { state: "ready", labels: [] }, links: { state: "ready", labels: [] },
    path: (sub) => `/projects/p1/${sub}`,
    ...over,
  };
}
const seoBoardProps = () => {
  const a = activity();
  const feed = seoFeed();
  return {
    projectId: "p1", runId: "run1", ownHost: "shop.example", verified: true, activity: a,
    revealed: buildTimeline(a.items, { elements: feed.elements, queries: feed.queries, recommendations: feed.recommendations }), upcoming: [], replaying: false, atEnd: true, mode: "finished", fresh: new Set(), reduced: false, seo: feed, feedError: null,
    data: {
      overview: st(overview()), buyer: st({ state: "ready", generatedAt: at(0), rows: [], completeness: null, labels: [] }), links: st(linkReport()), competitors: st([assessment()]),
      coverage: st({ state: "ready", generatedAt: at(0), rows: [coverageRow()], completeness: null, labels: [] }), evidence: st({ state: "ready", generatedAt: at(0), rows: [evidenceRow()], completeness: null, labels: [] }),
    },
  };
};
const moreValue = (hidden: string[]) => ({ runId: "run1", demo: false, replaying: false, keys: { gsc: "", crawl: "", batch: "", budget: "" }, reloads: { sheets: 0, gap: 0, links: 0 }, hidden: new Set(hidden) });

describe("SEO board", () => {
  it("renders 16-20 after 15 (loading until their data arrives) with the 17-20 run buttons; hidden ones are left out", () => {
    const actions = { ...seoPanelActions(env()), ...moreSeoActions(env()), ...linkContainerActions(env()) };
    const html = render(h(ra.PanelActionsContext.Provider, { value: actions }, h(SeoBoard, seoBoardProps())));
    const order = ["budget", "link-graph", "broken-links", "cluster-gaps", "anchor-flags", "placed-links"].map((k) => html.indexOf(`data-panel="${k}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual(order.slice().sort((x, y) => x - y));
    expect(html).toContain('data-action="crawl-broken-links"');
    expect(html).toContain('data-action="crawl-anchor-flags"');
    expect(html).toContain('data-action="links-cluster-gaps"');
    expect(html).toContain('data-action="links-placed-links"');
    // 16 picks its action from its own data, so no button before the summary loaded (and never the raw keys).
    expect(html).not.toContain('data-action="link-graph-rebuild"');
    expect(html).not.toContain('data-action="crawl-link-graph"');
    const t = text(html);
    for (const what of ["the link graph", "broken and redirected links", "clusters", "anchor flags", "placed links"]) expect(t).toContain(`Loading ${what}…`);
    const hidden = render(h(moreData.LiveMoreContext.Provider, { value: moreValue(["link-graph", "anchor-flags"]) }, h(SeoBoard, seoBoardProps())));
    expect(hidden).not.toContain('data-panel="link-graph"');
    expect(hidden).not.toContain('data-panel="anchor-flags"');
    expect(hidden).toContain('data-panel="placed-links"');
  });
});
