/**
 * Full-site internal link graph (internal-links workbench 2026-10-03, items 1 and 5). Pure: inventory rows +
 * the latest snapshot of every page (graph-load.ts) + Search Console page metrics -> nodes and edges.
 *
 * Nodes: every inventory URL (sitemap, discovered link targets, home), every page with a snapshot, and every
 * internal link target seen on an analysed page (at most MAX_GRAPH_NODES; link-only nodes past the cap are dropped
 * and counted). Keys are normalized URL keys (seo/rules/registry normalizeUrlKey).
 *
 * Edges (GRAPH_VERSION):
 *  - Sources: analysable snapshots only (HTTP 2xx, not skipped, not redirected). Error, redirect and skipped
 *    snapshots have no outgoing links.
 *  - A source's links: its stored internal links (all positions, at most 200) plus its anchored links
 *    (link_anchors_json). Kind per (source, target): "c" content text, "i" content image alt, "b" breadcrumb,
 *    "n" any other position (navigation, header, footer, sidebar, or a snapshot taken before anchors were stored).
 *  - Credit ("effective targets"): a link to URL X counts for X; when X's latest snapshot redirects to F it also
 *    counts for F ("via redirect"), and when X's canonical points to C (from X's snapshot, or for an uncrawled
 *    Shopify collection-scoped product URL /collections/<c>/products/<p> or a /products/<p>?query URL, the
 *    assumed canonical /products/<p>) it also counts for C ("via canonical"). Each source counts once per target.
 *  - links_in = distinct sources with any credited link; content_links_in = distinct sources with a content or
 *    breadcrumb link; links_out / content_links_out = distinct direct targets.
 *
 * Node facts: indexable = 2xx, not skipped, not redirected, no noindex (meta or X-Robots-Tag), canonical absent or
 * self. issue (link targets): redirect (3xx or a different final URL, including off-site redirects),
 * client_error (4xx), server_error (5xx); fetch errors and timeouts are unknown, never claimed broken.
 * stale = latest snapshot older than STALE_DAYS. Orphan = indexable sitemap page (not the home page) with
 * links_in 0 across the whole graph (without any sitemap inventory: an indexable crawled page); its coverage is
 * stated (pages not crawled yet may link to it).
 */
import type { LinkAnchor } from "../seo/crawl/extract";
import { normalizeUrlKey } from "../seo/rules/registry";
import { normalizeHost } from "../seo/ssrf";
import type { InventoryRow } from "../seo/crawl/rolling";
import type { SnapshotRecord } from "./graph-load";
import type { GscPageData, GscPageMetric } from "./gsc";

export const GRAPH_VERSION = "links-graph-2026-10-03.1";
export const STALE_DAYS = 30;
export const MAX_GRAPH_NODES = 12_000;
/** Inbound sources stored per URL (exact counts are kept separately). */
export const INBOUND_SAMPLE = 50;
/** Inbound sources stored for redirect and error targets (the Broken links tab lists them). */
export const INBOUND_SAMPLE_ISSUES = 200;
/** Outbound content/breadcrumb targets stored per URL (the extraction stores at most 150 anchored links). */
export const OUTBOUND_SAMPLE = 200;

export type LinkKind = "c" | "i" | "b" | "n";
export type GraphIssue = "redirect" | "client_error" | "server_error";

export interface InboundLink {
  source: number;
  anchor: string | null;
  kind: LinkKind;
  via: "" | "redirect" | "canonical";
}

export interface GraphNode {
  id: number;
  key: string;
  url: string;
  pageId: string | null;
  pageType: string | null;
  title: string | null;
  h1: string | null;
  headings: string[];
  inSitemap: boolean;
  inInventory: boolean;
  source: "sitemap" | "link" | "home" | "crawl";
  snap: SnapshotRecord | null;
  finalKey: string | null;
  /** Canonical key when it points to another URL (from the snapshot, or the Shopify URL-pattern assumption). */
  canonicalKey: string | null;
  canonicalAssumed: boolean;
  noindex: boolean;
  analyzable: boolean;
  indexable: boolean;
  issue: GraphIssue | null;
  stale: boolean;
  /** Distinct direct targets (any position), self excluded. */
  outAll: number[];
  /** Distinct direct targets reached by content or breadcrumb links. */
  outContent: number[];
  linksIn: number;
  contentLinksIn: number;
  inbound: InboundLink[];
  /** Normalized content anchor -> {surface text, distinct sources}. */
  anchors: Map<string, { text: string; sources: number }>;
  /** Distinct sources whose content link here has empty anchor text. */
  emptyAnchors: number;
  gsc: GscPageMetric | null;
  topQueries: Array<{ query: string; impressions: number }>;
  orphan: boolean;
}

export interface GraphCoverage {
  sitemapUrls: number;
  sitemapAnalysed: number;
  pagesWithSnapshot: number;
  oldestSnapshot: string | null;
  newestSnapshot: string | null;
  stalePages: number;
  neverCrawledSitemap: number;
  linkOnlyNodes: number;
  droppedNodes: number;
  snapshotsTruncated: boolean;
  anchorsUnknownPages: number;
}

export interface LinkGraph {
  version: string;
  host: string;
  builtAt: string;
  nodes: GraphNode[];
  byKey: Map<string, GraphNode>;
  coverage: GraphCoverage;
  gsc: Pick<GscPageData, "syncId" | "syncedAt" | "window" | "source"> | null;
  edges: number;
  contentEdges: number;
}

export interface GraphInput {
  host: string;
  homeUrl: string;
  inventory: readonly InventoryRow[];
  snapshots: readonly SnapshotRecord[];
  snapshotsTruncated?: boolean;
  gsc: GscPageData | null;
  now: Date;
  maxNodes?: number;
}

const SHOPIFY_COLLECTION_PRODUCT = /^\/collections\/[^/]+\/products\/([^/?#]+)\/?$/i;
const SHOPIFY_PRODUCT = /^\/products\/([^/?#]+)\/?$/i;

/** Assumed canonical for uncrawled Shopify product URLs (collection-scoped or with a query string); null otherwise. */
export function assumedCanonical(url: string): string | null {
  try {
    const u = new URL(url);
    const m = SHOPIFY_COLLECTION_PRODUCT.exec(u.pathname);
    if (m) return `${u.origin}/products/${m[1]}`;
    if (u.search && SHOPIFY_PRODUCT.test(u.pathname)) return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
  return null;
}

export const isNoindexRobots = (robots: string | null | undefined) => /\bnoindex\b|\bnone\b/i.test(robots ?? "");

export function createKeyCache(): (url: string) => string {
  const cache = new Map<string, string>();
  return (url: string) => {
    let k = cache.get(url);
    if (k === undefined) {
      k = normalizeUrlKey(url);
      if (cache.size < 200_000) cache.set(url, k);
    }
    return k;
  };
}

/** Lower-case, collapsed, trimmed anchor text without surrounding punctuation (the anchor audit's comparison key). */
export function normalizeAnchorText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s"'“”‘’«»‹›<>()[\]{}.,:;!?…→›»-]+|[\s"'“”‘’«»‹›<>()[\]{}.,:;!?…→›»-]+$/gu, "")
    .trim();
}

export function buildLinkGraph(input: GraphInput): LinkGraph {
  const maxNodes = input.maxNodes ?? MAX_GRAPH_NODES;
  const keyOf = createKeyCache();
  const host = normalizeHost(input.host);
  const hostOf = new Map<string, boolean>();
  /** Only URLs on the verified host belong to the graph (the crawler never fetches other hosts). */
  const onHost = (url: string) => {
    let v = hostOf.get(url);
    if (v === undefined) {
      try {
        v = normalizeHost(new URL(url).hostname) === host;
      } catch {
        v = false;
      }
      if (hostOf.size < 200_000) hostOf.set(url, v);
    }
    return v;
  };
  const nodes: GraphNode[] = [];
  const byKey = new Map<string, GraphNode>();
  let dropped = 0;
  const staleBefore = input.now.getTime() - STALE_DAYS * 86_400_000;

  const make = (key: string, url: string, source: GraphNode["source"], force: boolean): GraphNode | null => {
    const existing = byKey.get(key);
    if (existing) return existing;
    if (!force && nodes.length >= maxNodes) {
      dropped++;
      return null;
    }
    const n: GraphNode = {
      id: nodes.length,
      key,
      url,
      pageId: null,
      pageType: null,
      title: null,
      h1: null,
      headings: [],
      inSitemap: false,
      inInventory: false,
      source,
      snap: null,
      finalKey: null,
      canonicalKey: null,
      canonicalAssumed: false,
      noindex: false,
      analyzable: false,
      indexable: false,
      issue: null,
      stale: false,
      outAll: [],
      outContent: [],
      linksIn: 0,
      contentLinksIn: 0,
      inbound: [],
      anchors: new Map(),
      emptyAnchors: 0,
      gsc: null,
      topQueries: [],
      orphan: false,
    };
    // Until a snapshot says otherwise, uncrawled Shopify product URL variants count for their product URL.
    const assumed = assumedCanonical(url);
    if (assumed) {
      const ck = keyOf(assumed);
      if (ck !== key) {
        n.canonicalKey = ck;
        n.canonicalAssumed = true;
      }
    }
    nodes.push(n);
    byKey.set(key, n);
    return n;
  };

  for (const r of input.inventory) {
    if (!onHost(r.url)) continue;
    const n = make(r.urlKey, r.url, r.source, true)!;
    n.inInventory = true;
    n.inSitemap = n.inSitemap || r.inSitemap;
  }
  for (const s of input.snapshots) {
    if (!onHost(s.url)) continue;
    const key = keyOf(s.url);
    const n = make(key, s.url, "crawl", true)!;
    // Two page rows can share a key (a trailing-slash variant): the newer snapshot wins.
    if (n.snap && n.snap.fetchedAt >= s.fetchedAt) continue;
    n.snap = s;
    n.pageId = s.pageId;
    n.pageType = s.pageType;
    n.title = s.title;
    n.h1 = s.h1s[0] ?? null;
    n.headings = s.headings;
  }

  // Node facts from the snapshot.
  for (const n of nodes) {
    const s = n.snap;
    if (!s) continue;
    n.canonicalKey = null;
    n.canonicalAssumed = false;
    const finalKey = s.finalUrl ? keyOf(s.finalUrl) : null;
    if (finalKey && finalKey !== n.key) n.finalKey = finalKey;
    const redirect = (s.statusCode !== null && s.statusCode >= 300 && s.statusCode < 400) || n.finalKey !== null || s.skippedReason === "redirect_offsite";
    const ok = s.statusCode !== null && s.statusCode >= 200 && s.statusCode < 300 && !s.skippedReason;
    n.noindex = isNoindexRobots(s.robotsMeta);
    if (s.canonical) {
      try {
        const ck = keyOf(new URL(s.canonical, n.url).toString());
        if (ck !== n.key) n.canonicalKey = ck;
      } catch {
        /* unparseable canonical: ignored here (the audit rules report it) */
      }
    }
    n.analyzable = ok && !redirect;
    n.indexable = n.analyzable && !n.noindex && n.canonicalKey === null;
    if (redirect) n.issue = "redirect";
    else if (!s.skippedReason && s.statusCode !== null && s.statusCode >= 500) n.issue = "server_error";
    else if (!s.skippedReason && s.statusCode !== null && s.statusCode >= 400) n.issue = "client_error";
    n.stale = Date.parse(s.fetchedAt) < staleBefore;
  }

  // Edges.
  let edges = 0;
  let contentEdges = 0;
  let anchorsUnknown = 0;
  const inboundCap = (t: GraphNode) => (t.issue ? INBOUND_SAMPLE_ISSUES : INBOUND_SAMPLE);
  const rank: Record<LinkKind, number> = { c: 3, i: 2, b: 1, n: 0 };
  for (const src of nodes) {
    if (!src.analyzable || !src.snap) continue;
    const s = src.snap;
    if (s.linkAnchors === null) anchorsUnknown++;
    // Direct targets with their best kind and first anchor.
    const direct = new Map<number, { kind: LinkKind; anchor: string | null; anchors: Set<string>; empty: boolean }>();
    const visit = (href: string, kind: LinkKind, text: string | null) => {
      if (!onHost(href)) return;
      const key = keyOf(href);
      if (key === src.key) return;
      const t = byKey.get(key) ?? make(key, href, "link", false);
      if (!t || t.id === src.id) return;
      const contentKind = kind === "c" || kind === "i";
      const d = direct.get(t.id);
      if (!d) {
        direct.set(t.id, { kind, anchor: text, anchors: new Set(text && contentKind ? [text] : []), empty: contentKind && !text });
        return;
      }
      if (rank[kind] > rank[d.kind]) {
        d.kind = kind;
        if (text) d.anchor = text;
      }
      if (text && d.anchor === null) d.anchor = text;
      if (text && contentKind) d.anchors.add(text);
      if (contentKind && !text) d.empty = true;
    };
    for (const a of s.linkAnchors ?? []) visit(a[0], a[2], a[1] ? a[1] : null);
    for (const href of s.internalLinks) visit(href, "n", null);

    const effective = new Map<number, { content: boolean; via: InboundLink["via"] }>();
    const credit = (id: number, content: boolean, via: InboundLink["via"]) => {
      const e = effective.get(id);
      if (!e) effective.set(id, { content, via });
      else if (content && !e.content) e.content = true;
    };
    for (const [tid, d] of direct) {
      const t = nodes[tid]!;
      const content = d.kind !== "n";
      src.outAll.push(tid);
      edges++;
      if (content) {
        src.outContent.push(tid);
        contentEdges++;
      }
      credit(tid, content, "");
      const finalNode = t.finalKey ? byKey.get(t.finalKey) : undefined;
      if (finalNode && finalNode.id !== src.id) credit(finalNode.id, content, "redirect");
      const canonNode = t.canonicalKey && onHost(t.canonicalKey) ? (byKey.get(t.canonicalKey) ?? make(t.canonicalKey, t.canonicalKey, "link", false) ?? undefined) : undefined;
      if (canonNode && canonNode.id !== src.id && canonNode.id !== tid) credit(canonNode.id, content, "canonical");
      // Inbound sample and anchors (direct links only).
      if (t.inbound.length < inboundCap(t)) t.inbound.push({ source: src.id, anchor: d.anchor, kind: d.kind, via: "" });
      if (content && d.kind !== "b") {
        for (const text of d.anchors) {
          const norm = normalizeAnchorText(text);
          if (!norm) continue;
          const a = t.anchors.get(norm);
          if (a) a.sources++;
          else t.anchors.set(norm, { text, sources: 1 });
        }
        if (d.empty) t.emptyAnchors++;
      }
    }
    for (const [tid, e] of effective) {
      const t = nodes[tid]!;
      t.linksIn++;
      if (e.content) t.contentLinksIn++;
      if (e.via && t.inbound.length < inboundCap(t)) t.inbound.push({ source: src.id, anchor: null, kind: e.content ? "c" : "n", via: e.via });
    }
  }

  // Search Console metrics.
  if (input.gsc) {
    for (const n of nodes) {
      n.gsc = input.gsc.pages.get(n.key) ?? null;
      n.topQueries = input.gsc.topQueries.get(n.key) ?? [];
    }
  }

  // Orphans and coverage.
  const homeKey = keyOf(input.homeUrl);
  let oldest: string | null = null;
  let newest: string | null = null;
  let sitemapUrls = 0;
  let sitemapAnalysed = 0;
  let neverCrawled = 0;
  let stalePages = 0;
  let withSnapshot = 0;
  let linkOnly = 0;
  for (const n of nodes) {
    if (n.snap) {
      withSnapshot++;
      if (n.stale) stalePages++;
    }
    if (!n.snap && !n.inInventory) linkOnly++;
    if (n.inSitemap) {
      sitemapUrls++;
      if (n.snap) {
        sitemapAnalysed++;
        if (oldest === null || n.snap.fetchedAt < oldest) oldest = n.snap.fetchedAt;
        if (newest === null || n.snap.fetchedAt > newest) newest = n.snap.fetchedAt;
      } else neverCrawled++;
    }
  }
  // Orphans: indexable sitemap pages with no inlinks; without any sitemap inventory, indexable crawled pages.
  for (const n of nodes) {
    const inUniverse = sitemapUrls > 0 ? n.inSitemap : n.snap !== null;
    n.orphan = inUniverse && n.indexable && n.linksIn === 0 && n.key !== homeKey && n.pageType !== "home";
  }
  if (sitemapUrls === 0) {
    // No sitemap inventory (yet): coverage falls back to crawled pages.
    for (const n of nodes) {
      if (!n.snap) continue;
      if (oldest === null || n.snap.fetchedAt < oldest) oldest = n.snap.fetchedAt;
      if (newest === null || n.snap.fetchedAt > newest) newest = n.snap.fetchedAt;
    }
  }

  return {
    version: GRAPH_VERSION,
    host: input.host,
    builtAt: input.now.toISOString(),
    nodes,
    byKey,
    coverage: {
      sitemapUrls,
      sitemapAnalysed,
      pagesWithSnapshot: withSnapshot,
      oldestSnapshot: oldest,
      newestSnapshot: newest,
      stalePages,
      neverCrawledSitemap: neverCrawled,
      linkOnlyNodes: linkOnly,
      droppedNodes: dropped,
      snapshotsTruncated: input.snapshotsTruncated === true,
      anchorsUnknownPages: anchorsUnknown,
    },
    gsc: input.gsc ? { syncId: input.gsc.syncId, syncedAt: input.gsc.syncedAt, window: input.gsc.window, source: input.gsc.source } : null,
    edges,
    contentEdges,
  };
}

/** "N of M sitemap URLs analysed (oldest snapshot <date>)", or the crawled-pages fallback without a sitemap. */
export function coverageLabel(c: GraphCoverage): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const oldest = c.oldestSnapshot ? ` (oldest snapshot ${c.oldestSnapshot.slice(0, 10)})` : "";
  if (c.sitemapUrls > 0) return `${fmt(c.sitemapAnalysed)} of ${fmt(c.sitemapUrls)} sitemap URLs analysed${oldest}`;
  return `${fmt(c.pagesWithSnapshot)} crawled page${c.pagesWithSnapshot === 1 ? "" : "s"} analysed; no sitemap inventory yet${oldest}`;
}

/** Keys the source links to, directly or through a redirect/canonical of the linked URL (pairs that already link). */
export function linkedKeys(graph: LinkGraph, src: GraphNode): Set<string> {
  const out = new Set<string>();
  for (const tid of src.outAll) {
    const t = graph.nodes[tid]!;
    out.add(t.key);
    if (t.finalKey) out.add(t.finalKey);
    if (t.canonicalKey) out.add(t.canonicalKey);
  }
  return out;
}

export type { LinkAnchor };
