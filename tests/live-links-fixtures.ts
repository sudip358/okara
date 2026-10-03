/**
 * Demo-shaped fixtures for the Live view internal-link containers (docs/live-view-design.md section 18): the shapes
 * and values the demo project returns from GET /seo/internal-links/{graph,broken,clusters,anchors,placed}, plus data
 * variants for the states the demo does not have (broken links). Hostile strings stand in for page text.
 */
import type { AnchorAuditReport, BrokenLinkRow, BrokenLinksReport, LinkClusterReport, LinkGraphSummary, PlacedLinkRow, PlacedLinksReport } from "../src/shared/types";

export const HOSTILE_TEXT = '<script>alert("x")</script><img src=x onerror=alert(1)>';
export const BUILT = "2026-10-03T19:12:51.397Z";
const O = "https://demo.example";

export function graphSummary(over: Partial<LinkGraphSummary> = {}): LinkGraphSummary {
  return {
    state: "demo",
    graphId: "lgraph_1",
    builtAt: BUILT,
    trigger: "demo",
    coverageLabel: "8 of 8 sitemap URLs analysed (oldest snapshot 2026-10-03)",
    coverage: {
      sitemapUrls: 8,
      sitemapAnalysed: 8,
      pagesWithSnapshot: 8,
      oldestSnapshot: "2026-10-03T17:09:26.778Z",
      newestSnapshot: "2026-10-03T17:10:50.778Z",
      stalePages: 0,
      staleDays: 30,
      neverCrawledSitemap: 0,
      linkOnlyNodes: 0,
    },
    counts: {
      urls: 8, edges: 32, contentEdges: 32, orphans: 3, noContentLinks: 3, redirects: 0, clientErrors: 0, serverErrors: 0, hubs: 2, spokes: 4,
      linkedSpokes: 2, partialSpokes: 2, unlinkedSpokes: 0, unassignedSpokes: 0, anchorFlagged: 2, verified: 0, notFound: 1, pending: 1, sourceUnavailable: 0,
    },
    rolling: { inventoryUrls: 8, neverCrawled: 0, cursorOrd: 7, passes: 0, sitemapReadAt: "2026-10-03T17:09:20.778Z", pagesPerRun: 20 },
    newerCrawl: null,
    gscLabel: "Demo Search Console data 2026-09-03 – 2026-09-30, stored sync 2026-10-03",
    labels: ["Built from the latest snapshot of every crawled page across crawls (8 of 8 sitemap URLs analysed (oldest snapshot 2026-10-03)); snapshots older than 30 days are marked stale (0)."],
    versions: { graph: "links-graph-2026-10-03.1" },
    ...over,
  };
}

export const brokenLabels = [
  "From the latest snapshot of every crawled page: links whose target redirected (3xx, with every hop and the final URL) or returned 4xx/5xx when last crawled. Fetch errors and timeouts are never claimed broken.",
  "Snapshots older than 30 days are marked stale; the rolling crawl rechecks them.",
];

/** The demo: a graph with no failing or redirecting link targets. */
export function brokenEmpty(over: Partial<BrokenLinksReport> = {}): BrokenLinksReport {
  return { state: "demo", graphId: "lgraph_1", builtAt: BUILT, rows: [], targets: 0, totalLinks: 0, truncated: false, unchecked: 0, labels: brokenLabels, ...over };
}

export function brokenRow(over: Partial<BrokenLinkRow> = {}): BrokenLinkRow {
  return {
    sourceUrl: `${O}/blog/how-to-choose-a-washable-sofa`,
    sourceTitle: "How to choose a washable sofa",
    anchor: "washable sofas",
    kind: "content",
    targetUrl: `${O}/collections/old-sofas`,
    statusCode: 404,
    issue: "client_error",
    finalUrl: null,
    finalStatus: null,
    chain: [],
    fix: "Remove or replace the link",
    targetCheckedAt: "2026-10-03T17:10:00.000Z",
    sourceCheckedAt: "2026-10-03T17:09:30.000Z",
    stale: false,
    linkedFrom: 1,
    ...over,
  };
}

export function brokenData(): BrokenLinksReport {
  return brokenEmpty({
    state: "ready",
    rows: [
      brokenRow({ issue: "server_error", statusCode: 503, targetUrl: `${O}/pages/care`, fix: "Remove or replace the link" }),
      brokenRow({ anchor: HOSTILE_TEXT }),
      brokenRow({ sourceUrl: `${O}/`, kind: "navigation", anchor: "Old sofas", linkedFrom: 40 }),
      brokenRow({
        issue: "redirect", statusCode: 301, targetUrl: `${O}/collections/lamps`, finalUrl: `${O}/collections/table-lamps`, finalStatus: 200,
        chain: [{ status: 301, to: `${O}/collections/lamp` }, { status: 301, to: `${O}/collections/table-lamps` }], fix: `Link to ${O}/collections/table-lamps`,
      }),
      brokenRow({ issue: "redirect", statusCode: 302, targetUrl: `${O}/go/partner`, finalUrl: null, finalStatus: null, chain: [{ status: 302, to: "https://partner.example/" }], fix: "The URL redirects off this site: remove the link or link to the right page on your site." }),
      brokenRow({ issue: "redirect", statusCode: 301, targetUrl: `${O}/old`, finalUrl: `${O}/gone`, finalStatus: 404, chain: [{ status: 301, to: `${O}/gone` }], fix: `Remove or replace the link: it redirects to ${O}/gone, which returned HTTP 404.` }),
    ],
    targets: 5,
    totalLinks: 6,
    unchecked: 2,
  });
}

export function clusters(over: Partial<LinkClusterReport> = {}): LinkClusterReport {
  return {
    state: "demo",
    graphId: "lgraph_1",
    builtAt: BUILT,
    hubs: [
      {
        key: `${O}/collections/table-lamps`, url: `${O}/collections/table-lamps`, title: "Table Lamps | Demo Furnishings", source: "collection", sourceLabel: "Collection (URL pattern)",
        spokes: [
          { key: `${O}/products/brass-table-lamp`, url: `${O}/products/brass-table-lamp`, title: "Brass Table Lamp", type: "product", method: "existing_links", methodLabel: "Existing links", similarity: 0.73, hubToSpoke: false, spokeToHub: true },
          { key: `${O}/products/oak-side-table`, url: `${O}/products/oak-side-table`, title: "Oak Side Table", type: "product", method: "collection_membership", methodLabel: "Listed on the collection page", similarity: 0.28, hubToSpoke: true, spokeToHub: true },
        ],
        linked: 1, partial: 1, unlinked: 0,
      },
      {
        key: `${O}/collections/sofas`, url: `${O}/collections/sofas`, title: HOSTILE_TEXT, source: "collection", sourceLabel: "Collection (URL pattern)",
        spokes: [
          { key: `${O}/blog/how-to-choose-a-washable-sofa`, url: `${O}/blog/how-to-choose-a-washable-sofa`, title: "How to choose a washable sofa", type: "article", method: "existing_links", methodLabel: "Existing links", similarity: 0.44, hubToSpoke: false, spokeToHub: false },
          { key: `${O}/products/linen-slipcover-sofa`, url: `${O}/products/linen-slipcover-sofa`, title: "Linen Slipcover Sofa", type: "product", method: "collection_membership", methodLabel: "Listed on the collection page", similarity: 0.44, hubToSpoke: true, spokeToHub: true },
        ],
        linked: 1, partial: 0, unlinked: 1,
      },
    ],
    unassigned: [],
    counts: { hubs: 2, spokes: 4, linked: 2, partial: 1, unlinked: 1, unassigned: 0 },
    labels: ["Linked = the hub links to the spoke and the spoke links back (content or breadcrumb link). Suggestions that add a missing link carry the cluster-gap boost."],
    ...over,
  };
}

export const THRESHOLDS = { MIN_ANCHORED_INLINKS: 3, EXACT_MATCH_SHARE: 0.5, EXACT_MATCH_MIN_INLINKS: 5, REPEATED_MIN_SOURCES: 10, REPEATED_SHARE: 0.6 };

export function anchors(over: Partial<AnchorAuditReport> = {}): AnchorAuditReport {
  return {
    state: "demo",
    graphId: "lgraph_1",
    builtAt: BUILT,
    rows: [
      {
        url: `${O}/`, title: "Demo Furnishings", anchoredInlinks: 7, distinctAnchors: 1, keyword: "Furniture for real living rooms", keywordBasis: "h1", exactMatchShare: 1,
        top: [{ text: "Furniture for real living rooms", sources: 7 }], generic: [], emptyAnchors: 0, queryTerms: [], flags: ["exact_match_heavy"],
        reasons: ['100% of 7 anchored links use the exact-match anchor "Furniture for real living rooms" (threshold: more than 50% with at least 5 links).'],
      },
      {
        url: `${O}/products/linen-slipcover-sofa`, title: "Linen Slipcover Sofa", anchoredInlinks: 7, distinctAnchors: 2, keyword: HOSTILE_TEXT, keywordBasis: "search_console_query", exactMatchShare: 0.2,
        top: [{ text: HOSTILE_TEXT, sources: 5 }], generic: [{ text: "click here", sources: 2 }], emptyAnchors: 1, queryTerms: ["linen"], flags: ["generic_anchor", "empty_anchor"],
        reasons: ['2 links use generic anchors such as "click here".'],
      },
    ],
    total: 2,
    thresholds: { ...THRESHOLDS },
    labels: [
      "Content links only: navigation, header, footer, sidebar and breadcrumb links are not counted. One count per source page and anchor.",
      "Flags (engineering defaults, links-anchor-audit-2026-10-03.1): exact-match heavy = more than 50% …",
    ],
    ...over,
  };
}

const verification = (status: PlacedLinkRow["verification"]["status"], checkedAt: string | null, label: string): PlacedLinkRow["verification"] => ({ status, checkedAt, matchedVia: null, detail: null, label });

/** The demo: two fictional accepted suggestions, one checked against the demo crawl (not found), one pending. */
export function placed(over: Partial<PlacedLinksReport> = {}): PlacedLinksReport {
  return {
    state: "demo",
    rows: [
      {
        key: "k1", sourceUrl: `${O}/collections/sofas`, targetUrl: `${O}/blog/how-to-choose-a-washable-sofa`, anchor: "choose a washable sofa", origins: ["accepted"], suggestionId: "lsug_1",
        placedOn: "2026-10-03", method: "wrap existing", hub: null, verification: verification("not_found", "2026-10-03T17:09:40.000Z", "not found in crawl of 2026-10-03"),
      },
      {
        key: "k2", sourceUrl: `${O}/`, targetUrl: `${O}/pages/about`, anchor: HOSTILE_TEXT, origins: ["accepted"], suggestionId: "lsug_2",
        placedOn: "2026-10-03", method: "wrap existing", hub: null, verification: verification("pending", "2026-10-03T17:09:26.000Z", "pending next crawl of the source page"),
      },
    ],
    counts: { total: 2, verified: 0, notFound: 1, pending: 1, sourceUnavailable: 0, notChecked: 0 },
    labels: ["Pending = the source page has not been crawled since; the rolling crawl reaches every page over successive runs."],
    ...over,
  };
}
