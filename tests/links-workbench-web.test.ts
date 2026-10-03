/**
 * Internal-links workbench UI: pure helpers (filters, priority sort, graph query strings and sorting, export links,
 * coverage lines, tab routing) and server-rendered markup of every tab (no DOM, no network). Untrusted text (sentences,
 * drafts, anchors, titles) renders as plain text.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type {
  AnchorAuditReport,
  AttentionFeed as Feed,
  BrokenLinksReport,
  LinkClusterReport,
  LinkGraphSummary,
  LinkGraphUrlRow,
  LinkSuggestion,
  LinkSuggestionReport,
  PlacedLinksReport,
} from "@shared/types";
import {
  DEFAULT_FILTERS,
  DEFAULT_GRAPH_QUERY,
  WORKBENCH_TABS,
  chainText,
  coverageLines,
  exportHref,
  filterSuggestions,
  graphQueryString,
  issueLabel,
  nextSort,
  positionBandLabel,
  sortSuggestions,
  suggestionHubs,
  tabFromParam,
} from "@web/pages/links/lib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const suggestionsTab = await load<Record<"SuggestionsTab", FC>>("../src/web/pages/links/SuggestionsTab.tsx");
const clustersTab = await load<Record<"ClustersView", FC>>("../src/web/pages/links/ClustersTab.tsx");
const brokenTab = await load<Record<"BrokenView", FC>>("../src/web/pages/links/BrokenTab.tsx");
const anchorsTab = await load<Record<"AnchorsView", FC>>("../src/web/pages/links/AnchorsTab.tsx");
const placedTab = await load<Record<"PlacedView", FC>>("../src/web/pages/links/PlacedTab.tsx");
const graphTab = await load<Record<"UrlRow", FC>>("../src/web/pages/links/GraphTab.tsx");
const parts = await load<Record<"CoverageStrip", FC>>("../src/web/pages/links/parts.tsx");
const attention = await load<Record<"AttentionFeed", FC>>("../src/web/components/overview/AttentionFeed.tsx");

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const noop = () => {};
const BASE = "/projects/p1/seo/internal-links";

const s = (over: Partial<LinkSuggestion>): LinkSuggestion => ({
  id: "x",
  source: { pageId: "a", url: "https://shop.example.com/blogs/news/a", title: "Article A" },
  target: { pageId: "b", url: "https://shop.example.com/collections/lamps", title: "Lamps", inlinks: 3, orphan: false },
  sentence: { index: 0, text: "Our lamps glow." },
  anchor: { text: "lamps" },
  role: null,
  method: "deterministic",
  decision: null,
  status: "review",
  score: 1,
  reasons: [],
  userStatus: "open",
  ...over,
});

const prio = (value: number, over: Partial<NonNullable<LinkSuggestion["priority"]>> = {}): NonNullable<LinkSuggestion["priority"]> => ({
  value,
  relevance: value,
  impact: 1,
  targetFactor: 1,
  sourceFactor: 1,
  clusterFactor: 1,
  positionBand: "none",
  target: { impressions: null, clicks: null, position: null, basis: null },
  source: { inlinks: 0, clicks: null },
  gscLabel: null,
  explanation: [`Priority ${value.toFixed(2)}`],
  version: "links-priority-2026-10-03.1",
  ...over,
});

describe("workbench lib", () => {
  it("filters by hub, cluster gap, method and verification, and sorts by priority within a status", () => {
    const hub = { hubUrl: "https://shop.example.com/collections/lamps", hubTitle: "Lamps", gap: "hub_to_spoke" as const };
    const list = [
      s({ id: "1", priority: prio(1.2), cluster: hub }),
      s({ id: "2", priority: prio(3.4), placement: "draft_sentence" }),
      s({ id: "3", status: "suggested", priority: prio(0.5), cluster: { ...hub, gap: null }, verification: { status: "verified", checkedAt: "2026-10-02T00:00:00.000Z", matchedVia: "target", detail: null, label: "verified on 2026-10-02" } }),
      s({ id: "4", priority: null, score: 9 }),
    ];
    expect(sortSuggestions(list).map((x) => x.id)).toEqual(["3", "2", "1", "4"]);
    expect(sortSuggestions(list, "score").map((x) => x.id)).toEqual(["3", "4", "1", "2"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, hub: hub.hubUrl }).map((x) => x.id)).toEqual(["1", "3"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, hub: "none" }).map((x) => x.id)).toEqual(["2", "4"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, gap: "gap" }).map((x) => x.id)).toEqual(["1"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, method: "draft_sentence" }).map((x) => x.id)).toEqual(["2"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, verification: "verified" }).map((x) => x.id)).toEqual(["3"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, verification: "not_checked" }).map((x) => x.id)).toEqual(["1", "2", "4"]);
    expect(suggestionHubs(list)).toEqual([{ url: hub.hubUrl, title: "Lamps" }]);
    expect(positionBandLabel("striking_distance")).toBe("striking distance 8–20");
  });

  it("builds graph queries, toggles sorting, and names tabs, issues, chains and exports", () => {
    expect(graphQueryString(DEFAULT_GRAPH_QUERY)).toBe("filter=all&sort=links_in&dir=desc&offset=0&limit=50");
    expect(graphQueryString({ ...DEFAULT_GRAPH_QUERY, q: "  brass lamp ", filter: "orphans" })).toBe("filter=orphans&sort=links_in&dir=desc&offset=0&limit=50&q=brass+lamp");
    const q1 = nextSort({ ...DEFAULT_GRAPH_QUERY, offset: 100 }, "links_in");
    expect(q1).toMatchObject({ sort: "links_in", dir: "asc", offset: 0 });
    expect(nextSort(q1, "url")).toMatchObject({ sort: "url", dir: "asc" });
    expect(nextSort(q1, "impressions")).toMatchObject({ sort: "impressions", dir: "desc" });
    expect(WORKBENCH_TABS.map((t) => t.label)).toEqual(["Suggestions", "Clusters", "Link graph", "Broken links", "Anchors", "Placed & verified"]);
    expect(tabFromParam("placed")).toBe("placed");
    expect(tabFromParam("<script>")).toBe("suggestions");
    expect(tabFromParam(null)).toBe("suggestions");
    expect(issueLabel("redirect", 301)).toBe("Redirect (301)");
    expect(issueLabel("client_error", 404)).toBe("Client error (404)");
    expect(issueLabel(null, 200)).toBe("HTTP 200");
    expect(chainText([{ status: 301, to: "https://shop.example.com/moved-2" }, { status: 302, to: "https://shop.example.com/b" }])).toBe("301 → /moved-2 · 302 → /b");
    expect(exportHref(BASE, "sheet")).toBe(`/api${BASE}/export?format=sheet`);
    expect(exportHref(BASE, "sheet", { ids: ["a", "b"], userStatus: ["accepted", "implemented"] })).toBe(`/api${BASE}/export?format=sheet&ids=a%2Cb&userStatus=accepted%2Cimplemented`);
    expect(exportHref(BASE, "sheet", { ids: Array.from({ length: 600 }, (_, i) => `i${i}`) }).split("%2C")).toHaveLength(500);
  });

  it("states coverage, stale snapshots and the rolling crawl", () => {
    expect(coverageLines(null)).toEqual([]);
    const g = graphSummary();
    expect(coverageLines(g)).toEqual([
      "312 of 1,904 sitemap URLs analysed (oldest snapshot 2026-09-02)",
      "40 snapshots older than 30 days (stale)",
      "rolling crawl: 1,592 known URLs not crawled yet, up to 100 pages per run",
    ]);
  });
});

function graphSummary(over: Partial<LinkGraphSummary> = {}): LinkGraphSummary {
  return {
    state: "ready",
    graphId: "lg_1",
    builtAt: "2026-10-02T10:00:00.000Z",
    trigger: "crawl",
    coverageLabel: "312 of 1,904 sitemap URLs analysed (oldest snapshot 2026-09-02)",
    coverage: { sitemapUrls: 1904, sitemapAnalysed: 312, pagesWithSnapshot: 330, oldestSnapshot: "2026-09-02T00:00:00.000Z", newestSnapshot: "2026-10-02T00:00:00.000Z", stalePages: 40, staleDays: 30, neverCrawledSitemap: 1592, linkOnlyNodes: 12 },
    counts: null,
    rolling: { inventoryUrls: 1910, neverCrawled: 1592, cursorOrd: 312, passes: 1, sitemapReadAt: "2026-10-02T10:00:00.000Z", pagesPerRun: 100 },
    newerCrawl: null,
    gscLabel: null,
    labels: [],
    versions: {},
    ...over,
  };
}

function report(over: Partial<LinkSuggestionReport> = {}): LinkSuggestionReport {
  return {
    state: "ready",
    generatedAt: "2026-10-02T10:00:00.000Z",
    pagesAnalysed: 12,
    completeness: { note: "12 of 14 pages analysed", covered: 12, total: 14 },
    suggestions: [],
    orphanPages: [],
    genericAnchors: [],
    labels: ["Suggestions for review. Okara never edits your pages.", "Confidence values are Jev's reported confidence/probability, not predicted traffic."],
    ...over,
  } as LinkSuggestionReport;
}

describe("workbench render", () => {
  it("renders suggestions with priority numbers, cluster gaps, verification and a labelled draft, as plain text", () => {
    const draft = s({
      id: "d1",
      sentence: null,
      placement: "draft_sentence",
      anchor: { text: "lamps" },
      priority: prio(2.5),
      draft: {
        text: "See our lamps <script>alert(1)</script> for the hallway.",
        label: "Draft sentence — review before publishing",
        evidence: [{ id: "ev_s0", text: "Hallway lighting matters." }],
        citedEvidenceIds: ["ev_s0"],
        validation: { ok: true, errors: [], warnings: [] },
        insertAfter: "Hallway lighting matters.",
        writer: { provider: "anthropic", model: "configured-writer-model" },
      },
    });
    const existing = s({
      id: "e1",
      priority: prio(3.1, {
        positionBand: "striking_distance",
        target: { impressions: 4000, clicks: 30, position: 12.4, basis: "page_rows" },
        gscLabel: "Search Console 2026-09-01 – 2026-09-28, stored sync 2026-09-30",
        explanation: ["Search Console figures: Search Console 2026-09-01 – 2026-09-28, stored sync 2026-09-30. These are your Search Console impressions, not search volume."],
      }),
      cluster: { hubUrl: "https://shop.example.com/collections/lamps", hubTitle: "Lamps", gap: "hub_to_spoke" },
      userStatus: "implemented",
      verification: { status: "not_found", checkedAt: "2026-10-02T00:00:00.000Z", matchedVia: null, detail: "Not found in the crawl of 2026-10-02.", label: "not found in crawl of 2026-10-02" },
    });
    const html = render(
      h(suggestionsTab.SuggestionsTab, {
        report: report({ suggestions: [draft, existing], drafts: { state: "setup_required", drafted: 0, rejected: 0, candidates: 3, cap: 20, label: "3 high-priority pairs have no sentence that mentions the target. Drafting a new sentence needs a writer." } }),
        projectId: "p1",
        base: BASE,
        onChange: noop,
      }),
    );
    expect(html).not.toContain("<script>");
    const t = text(html);
    expect(t).toContain("Draft sentence — review before publishing");
    expect(t).toContain("See our lamps <script>alert(1)</script> for the hallway.");
    expect(t).toContain("insert PK sentence");
    expect(t).toContain("wrap existing");
    expect(t).toContain("Insert after: “Hallway lighting matters.”");
    expect(t).toContain("Drafted sentences need a writer");
    expect(t).toContain("Cluster gap");
    expect(t).toContain("Striking distance");
    expect(t).toContain("4,000 impr. · pos 12.4");
    expect(t).toContain("not search volume");
    expect(t).toContain("not found in crawl of 2026-10-02");
    // Highest priority first.
    expect(t.indexOf("3.10")).toBeLessThan(t.indexOf("2.50"));
    expect(html).toContain(`href="/api${BASE}/export?format=sheet"`);
    expect(t).toContain("Export sheet format");
  });

  it("renders the setup state without a verified site", () => {
    const t = text(render(h(suggestionsTab.SuggestionsTab, { report: report({ state: "setup_required", labels: ["Verify site ownership first."] }), projectId: "p1", base: BASE, onChange: noop })));
    expect(t).toContain("Verify site ownership first.");
    expect(t).toContain("Go to integrations");
  });

  it("renders clusters with methods and missing links", () => {
    const r: LinkClusterReport = {
      state: "ready",
      graphId: "lg_1",
      builtAt: "2026-10-02T10:00:00.000Z",
      hubs: [
        {
          key: "https://shop.example.com/collections/lamps",
          url: "https://shop.example.com/collections/lamps",
          title: "Lamps",
          source: "collection",
          sourceLabel: "Shopify collection",
          spokes: [
            { key: "k1", url: "https://shop.example.com/blogs/news/lamp-care", title: "Lamp care", type: "article", method: "tfidf", methodLabel: "Topic similarity (TF-IDF)", similarity: 0.31, hubToSpoke: false, spokeToHub: true },
            { key: "k2", url: "https://shop.example.com/products/oak-lamp", title: "Oak lamp", type: "product", method: "collection_membership", methodLabel: "Listed on the collection page", similarity: null, hubToSpoke: true, spokeToHub: true },
          ],
          linked: 1,
          partial: 1,
          unlinked: 0,
        },
      ],
      unassigned: [{ key: "u1", url: "https://shop.example.com/blogs/news/misc", title: "Misc <b>notes</b>", type: "article" }],
      counts: { hubs: 1, spokes: 2, linked: 1, partial: 1, unlinked: 0, unassigned: 1 },
      labels: ["Hubs: Shopify collections, pages you mark, and the Hub column of your sheet."],
    };
    const html = render(h(clustersTab.ClustersView, { report: r, busy: false, error: null, onEdit: async () => {} }));
    expect(html).not.toContain("<b>notes</b>");
    const t = text(html);
    expect(t).toContain("Lamps");
    expect(t).toContain("Topic similarity (TF-IDF)");
    expect(t).toContain("Listed on the collection page");
    expect(t).toContain("Unassigned spokes");
    expect(t).toContain("Misc <b>notes</b>");
    expect(t).toMatch(/Partly linked/);
    expect(text(render(h(clustersTab.ClustersView, { report: { ...r, state: "setup_required", labels: ["Verify site ownership first."] }, busy: false, error: null, onEdit: async () => {} })))).toContain("Verify site ownership first.");
  });

  it("renders broken links with the redirect chain and the fix", () => {
    const r: BrokenLinksReport = {
      state: "ready",
      graphId: "lg_1",
      builtAt: "2026-10-02T10:00:00.000Z",
      rows: [
        {
          sourceUrl: "https://shop.example.com/blogs/news/a",
          sourceTitle: "Article A",
          anchor: "moved page",
          kind: "content",
          targetUrl: "https://shop.example.com/moved",
          statusCode: 301,
          issue: "redirect",
          finalUrl: "https://shop.example.com/blogs/news/b",
          finalStatus: 200,
          chain: [
            { status: 301, to: "https://shop.example.com/moved-2" },
            { status: 301, to: "https://shop.example.com/blogs/news/b" },
          ],
          fix: "Link to https://shop.example.com/blogs/news/b",
          targetCheckedAt: "2026-10-01T00:00:00.000Z",
          sourceCheckedAt: "2026-10-02T00:00:00.000Z",
          stale: false,
          linkedFrom: 1,
        },
        { sourceUrl: "https://shop.example.com/", sourceTitle: null, anchor: null, kind: "navigation", targetUrl: "https://shop.example.com/gone", statusCode: 404, issue: "client_error", finalUrl: null, finalStatus: null, chain: [], fix: "Remove or replace the link", targetCheckedAt: null, sourceCheckedAt: null, stale: true, linkedFrom: 40 },
      ],
      targets: 2,
      totalLinks: 2,
      truncated: false,
      unchecked: 3,
      labels: ["Redirects are not errors, but each hop slows crawling."],
    };
    const t = text(render(h(brokenTab.BrokenView, { report: r, base: BASE })));
    expect(t).toContain("Chain: 301 → /moved-2 · 301 → /blogs/news/b");
    expect(t).toContain("Link to https://shop.example.com/blogs/news/b");
    expect(t).toContain("Redirect (301)");
    expect(t).toContain("Client error (404)");
    expect(t).toContain("Remove or replace the link");
    expect(t).toContain("Linked from 40 pages");
    expect(t).toContain("Stale");
    expect(render(h(brokenTab.BrokenView, { report: r, base: BASE }))).toContain(`href="/api${BASE}/broken?format=csv"`);
  });

  it("renders the anchor audit with flags, keyword basis and thresholds", () => {
    const r: AnchorAuditReport = {
      state: "ready",
      graphId: "lg_1",
      builtAt: null,
      rows: [
        {
          url: "https://shop.example.com/collections/chandeliers",
          title: "Brass Chandeliers",
          anchoredInlinks: 11,
          distinctAnchors: 2,
          keyword: "brass chandeliers",
          keywordBasis: "search_console_query",
          exactMatchShare: 0.909,
          top: [
            { text: "brass chandeliers", sources: 10 },
            { text: "click here", sources: 1 },
          ],
          generic: [{ text: "click here", sources: 1 }],
          emptyAnchors: 1,
          queryTerms: ["brass", "chandelier"],
          flags: ["exact_match_heavy", "repeated_anchor", "generic_anchor", "empty_anchor"],
          reasons: ['91% of 11 anchored links use the exact-match anchor "brass chandeliers" (threshold: more than 50% with at least 5 links).'],
        },
      ],
      total: 1,
      thresholds: { EXACT_MATCH_SHARE: 0.5 },
      labels: ["Flags (engineering defaults, links-anchor-audit-2026-10-03.1): ..."],
    };
    const t = text(render(h(anchorsTab.AnchorsView, { report: r, loading: false, error: null, onRetry: noop, all: false, onAll: noop })));
    expect(t).toContain("Exact-match heavy");
    expect(t).toContain("Repeated anchor");
    expect(t).toContain("Generic anchors");
    expect(t).toContain("Empty anchors");
    expect(t).toContain("keyword “brass chandeliers” (top Search Console query) · exact match 91%");
    expect(t).toContain("threshold: more than 50% with at least 5 links");
    const empty = text(render(h(anchorsTab.AnchorsView, { report: { ...r, rows: [], total: 0 }, loading: false, error: null, onRetry: noop, all: false, onAll: noop })));
    expect(empty).toContain("No anchor flags. Every audited page is within the thresholds.");
  });

  it("renders placed links with verification labels, and the empty state", () => {
    const r: PlacedLinksReport = {
      state: "ready",
      rows: [
        {
          key: "k1",
          sourceUrl: "https://shop.example.com/blogs/news/e",
          targetUrl: "https://shop.example.com/guide",
          anchor: "the guide",
          origins: ["sheet"],
          suggestionId: null,
          placedOn: "2026-09-20",
          method: "wrap existing",
          hub: "lamps",
          verification: { status: "not_found", checkedAt: "2026-09-30T12:00:00.000Z", matchedVia: null, detail: "Not found in the crawl of 2026-09-30: the source page does not link to the target.", label: "not found in crawl of 2026-09-30" },
        },
        {
          key: "k2",
          sourceUrl: "https://shop.example.com/blogs/news/a",
          targetUrl: "https://shop.example.com/products/brass-lamp",
          anchor: "brass lamp",
          origins: ["implemented", "sheet"],
          suggestionId: "lsug_1",
          placedOn: "2026-09-27",
          method: "insert PK sentence",
          hub: null,
          verification: { status: "verified", checkedAt: "2026-09-30T12:00:00.000Z", matchedVia: "target", detail: "Verified on 2026-09-30: the source page links to the target.", label: "verified on 2026-09-30" },
        },
      ],
      counts: { total: 2, verified: 1, notFound: 1, pending: 0, sourceUnavailable: 0, notChecked: 0 },
      labels: ["Checked after each crawl."],
    };
    const t = text(render(h(placedTab.PlacedView, { report: r, base: BASE, projectId: "p1" })));
    expect(t).toContain("not found in crawl of 2026-09-30");
    expect(t).toContain("verified on 2026-09-30");
    expect(t).toContain("From your sheet");
    expect(t).toContain("wrap existing · lamps");
    expect(t).toContain("since 2026-09-20");
    const empty = text(render(h(placedTab.PlacedView, { report: { ...r, rows: [], counts: { total: 0, verified: 0, notFound: 0, pending: 0, sourceUnavailable: 0, notChecked: 0 } }, base: BASE, projectId: "p1" })));
    expect(empty).toContain("No placed links yet.");
    expect(empty).toContain("Import page");
  });

  it("renders a graph row with orphan, stale and status badges, and the coverage strip", () => {
    const row: LinkGraphUrlRow = {
      key: "https://shop.example.com/products/orphan",
      url: "https://shop.example.com/products/orphan",
      title: "Orphan <i>product</i>",
      pageType: "product",
      inSitemap: false,
      crawled: true,
      statusCode: 200,
      finalUrl: null,
      redirectHops: null,
      fetchedAt: "2026-08-01T00:00:00.000Z",
      stale: true,
      indexable: true,
      noindex: false,
      canonicalUrl: null,
      linksIn: 0,
      contentLinksIn: 0,
      linksOut: 4,
      contentLinksOut: 1,
      orphan: true,
      issue: null,
      isHub: false,
      hubUrl: "https://shop.example.com/collections/lamps",
      hubMethod: "tfidf",
      gsc: { impressions: 1234, clicks: 5, position: 14.2 },
      anchorFlags: ["generic_anchor"],
    };
    const html = renderToStaticMarkup(h("table", null, h("tbody", null, h(graphTab.UrlRow, { row, open: false, onToggle: noop }))));
    expect(html).not.toContain("<i>product</i>");
    const t = text(html);
    expect(t).toContain("Orphan <i>product</i>");
    expect(t).toContain("Orphan");
    expect(t).toContain("Not in sitemap");
    expect(t).toContain("Stale");
    expect(t).toContain("HTTP 200");
    expect(t).toContain("Generic anchors");
    expect(t).toContain("1,234");
    expect(html).toContain('aria-expanded="false"');

    const strip = text(render(h(parts.CoverageStrip, { graph: graphSummary({ newerCrawl: "2026-10-03T00:00:00.000Z" }) })));
    expect(strip).toContain("Coverage: 312 of 1,904 sitemap URLs analysed (oldest snapshot 2026-09-02)");
    expect(strip).toContain("40 snapshots older than 30 days (stale)");
    expect(strip).toContain("A newer crawl exists; rebuild the graph to include it.");
    expect(text(render(h(parts.CoverageStrip, { graph: graphSummary({ coverageLabel: null, labels: ["No link graph yet."] }) })))).toContain("No link graph yet.");
  });

  it("shows implemented links that were not found in the Overview attention feed", () => {
    const feed: Feed = { agents: [], recentEvents: [], linkVerification: { notFound: 2, checkedAt: "2026-10-02T10:00:00.000Z", examples: [] } };
    const html = render(h(attention.AttentionFeed, { projectId: "p1", feed, onRunStarted: noop }));
    expect(html).toContain('data-testid="attention-link-verification"');
    const t = text(html);
    expect(t).toContain("Placed links not found");
    expect(t).toContain("2 links you marked implemented (or your sheet lists) were not found");
    expect(html).toMatch(/href="\/projects\/p1\/internal-links\?tab=placed"/);
    const none = render(h(attention.AttentionFeed, { projectId: "p1", feed: { agents: [], recentEvents: [], linkVerification: null }, onRunStarted: noop }));
    expect(none).not.toContain("attention-link-verification");
  });
});
