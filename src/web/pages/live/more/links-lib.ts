/**
 * Internal-link containers of the Live view (docs/live-view-design.md section 18): pure helpers over the internal
 * links workbench responses (GET /seo/internal-links/{graph,broken,clusters,anchors,placed}). No React, no I/O;
 * unit-tested in tests/live-links-containers.test.ts.
 *
 * Every number is a count of stored rows or a count the server computed from the stored link graph, shown as "n of m"
 * with both numbers; the only percentages are the workbench's documented anchor thresholds (engineering defaults the
 * server returns) and the server's own reason lines. Nothing is estimated, projected or scored here.
 */
import type {
  AnchorAuditReport,
  AnchorAuditView,
  BrokenLinkRow,
  BrokenLinksReport,
  LinkClusterReport,
  LinkGraphSummary,
  LinkHubView,
  LinkSpokeView,
  LinkVerificationStatus,
  PlacedLinkRow,
  PlacedLinksReport,
} from "@shared/types";
import { ANCHOR_FLAG_LABEL, type WorkbenchTab } from "@web/pages/links/lib";
import { fmtInt, shortDate } from "../text";

export type LinkContainerKey = "link-graph" | "broken-links" | "cluster-gaps" | "anchor-flags" | "placed-links";

/** The Internal links page tab each container opens ("Open Internal links ›"). */
export const LINK_TAB: Record<LinkContainerKey, WorkbenchTab> = {
  "link-graph": "graph",
  "broken-links": "broken",
  "cluster-gaps": "clusters",
  "anchor-flags": "anchors",
  "placed-links": "placed",
};

/** Project sub-path of the matching Internal links tab, e.g. "internal-links?tab=broken". */
export const linksTabPath = (key: LinkContainerKey) => `internal-links?tab=${LINK_TAB[key]}`;

/**
 * Refetch keys of the section 18 containers (no polling of their own): the id of the shown run's latest seo.crawl
 * terminal event (the crawl step logs it after the rebuilt graph is stored) and the reload counter bumped when a
 * "Rebuild link graph" or a link analysis of the view finished (both rebuild the stored graph).
 */
export function linkDeps(v: { keys: { crawl: string }; reloads: { links?: number } }): unknown[] {
  return [v.keys.crawl, v.reloads.links ?? 0];
}

/** Rows each container lists before "Showing n of m" (the full list is on the Internal links page). */
export const LINK_ROWS = { broken: 20, hubs: 8, hubExamples: 3, anchors: 12, notFound: 6 } as const;

/** "3 Oct, 19:12" (local time); "—" when missing or unparseable. */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${shortDate(iso)}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------ captions
export const TRIGGER_LABEL: Record<NonNullable<LinkGraphSummary["trigger"]>, string> = {
  crawl: "after a crawl",
  manual: "rebuilt on request",
  run: "by a link analysis run",
  demo: "from the demo crawl",
};

/**
 * Where the containers' data comes from: the project's latest stored link graph. A graph built by a crawl may or may
 * not be the crawl of the run on screen (the summary does not say which run), so that caption claims neither; a graph
 * rebuilt on request, by a link analysis run or by the demo seed is never part of an agent run.
 */
export function graphCaption(builtAt: string | null | undefined, trigger: LinkGraphSummary["trigger"] | undefined): string | null {
  if (!builtAt) return null;
  const how = trigger ? ` ${TRIGGER_LABEL[trigger]}` : "";
  return `From your latest link graph (built ${shortDateTime(builtAt)}${how})${trigger && trigger !== "crawl" ? ", not part of this run" : ""}`;
}

// ------------------------------------------------------------------ 16 link graph coverage
export interface CoverageMeter {
  key: "analysed" | "orphans" | "no_content" | "stale" | "not_crawled";
  label: string;
  n: number;
  /** null = no stored denominator (no bar is drawn, only the count). */
  m: number | null;
  /** What m counts ("sitemap URLs", "crawled pages", "known URLs"). */
  of: string;
  /** Problem counts are amber; coverage is sky. Colour is never the only signal (the label says what it is). */
  tone: "sky" | "amber";
  note: string | null;
}

/** The coverage rows of the graph summary as "n of m" meters (counts computed by the server's graph build). */
export function coverageMeters(g: LinkGraphSummary): CoverageMeter[] {
  const c = g.coverage;
  const k = g.counts;
  if (!c || !k) return [];
  const sitemap = c.sitemapUrls > 0;
  const universe = sitemap ? c.sitemapUrls : c.pagesWithSnapshot;
  const universeOf = sitemap ? "sitemap URLs" : "crawled pages";
  const span = c.oldestSnapshot ? `oldest snapshot ${shortDate(c.oldestSnapshot)}${c.newestSnapshot && shortDate(c.newestSnapshot) !== shortDate(c.oldestSnapshot) ? ` · newest ${shortDate(c.newestSnapshot)}` : ""}` : null;
  const out: CoverageMeter[] = [
    sitemap
      ? { key: "analysed", label: "Sitemap URLs analysed", n: c.sitemapAnalysed, m: c.sitemapUrls, of: "sitemap URLs", tone: "sky", note: span }
      : { key: "analysed", label: "Crawled pages analysed", n: c.pagesWithSnapshot, m: null, of: "crawled pages", tone: "sky", note: `No sitemap inventory yet${span ? ` · ${span}` : ""}` },
    { key: "orphans", label: "Orphan pages (0 links in)", n: k.orphans, m: universe, of: universeOf, tone: "amber", note: "Indexable pages no analysed page links to (home page excluded)" },
    sitemap
      ? { key: "no_content", label: "No content links in", n: k.noContentLinks, m: c.sitemapUrls, of: "sitemap URLs", tone: "amber", note: "Only navigation or template links point to them (orphans included)" }
      : { key: "no_content", label: "No content links in", n: k.noContentLinks, m: null, of: "sitemap URLs", tone: "amber", note: "Counted for sitemap URLs only; no sitemap inventory yet" },
    { key: "stale", label: `Stale snapshots (older than ${c.staleDays} days)`, n: c.stalePages, m: c.pagesWithSnapshot, of: "crawled pages", tone: "amber", note: "The rolling crawl rechecks the oldest snapshots first" },
  ];
  if (g.rolling) {
    out.push({
      key: "not_crawled",
      label: "Known URLs not crawled yet",
      n: g.rolling.neverCrawled,
      m: g.rolling.inventoryUrls,
      of: "known URLs",
      tone: "amber",
      note: `Rolling crawl: up to ${fmtInt(g.rolling.pagesPerRun)} pages per run`,
    });
  } else if (sitemap) {
    out.push({ key: "not_crawled", label: "Sitemap URLs not crawled yet", n: c.neverCrawledSitemap, m: c.sitemapUrls, of: "sitemap URLs", tone: "amber", note: null });
  }
  return out;
}

/** Bar width of an n-of-m meter (0..1); 0 without a denominator. */
export const meterFraction = (n: number, m: number | null) => (m && m > 0 ? Math.max(0, Math.min(1, n / m)) : 0);

/**
 * The server's notes minus the two the container states itself: the "newer crawl" note (shown with a readable date)
 * and the "Built from the latest snapshot …" coverage sentence (the meters show the same counts).
 */
export function graphNotes(g: LinkGraphSummary): string[] {
  return g.labels.filter((l) => !l.startsWith("A crawl finished after this graph was built") && !l.startsWith("Built from the latest snapshot of every crawled page"));
}

/** "32 links between 8 URLs (32 in body content)". */
export function graphSizeText(g: LinkGraphSummary): string | null {
  const k = g.counts;
  if (!k) return null;
  return `${plural(k.edges, "page-to-page link")} between ${plural(k.urls, "URL")} (${fmtInt(k.contentEdges)} in body content)`;
}

// ------------------------------------------------------------------ 17 broken and redirected links
export interface BrokenSummary {
  /** Links (source, target pairs) listed by the server; `truncated` = sources were cut for busy targets. */
  listed: number;
  clientErrors: number;
  serverErrors: number;
  redirects: number;
  /** Redirect links whose target redirects more than once (every hop stored). */
  chains: number;
  /** Redirect links whose final URL returned 4xx/5xx when crawled. */
  redirectsToErrors: number;
  /** Redirect links that leave the site (no final URL on it). */
  offSite: number;
  /** Distinct target URLs per status group. */
  targets: { client: number; server: number; redirect: number };
}

export function brokenSummary(r: BrokenLinksReport): BrokenSummary {
  const t = { client: new Set<string>(), server: new Set<string>(), redirect: new Set<string>() };
  const s: BrokenSummary = { listed: r.rows.length, clientErrors: 0, serverErrors: 0, redirects: 0, chains: 0, redirectsToErrors: 0, offSite: 0, targets: { client: 0, server: 0, redirect: 0 } };
  for (const x of r.rows) {
    if (x.issue === "client_error") {
      s.clientErrors++;
      t.client.add(x.targetUrl);
    } else if (x.issue === "server_error") {
      s.serverErrors++;
      t.server.add(x.targetUrl);
    } else {
      s.redirects++;
      t.redirect.add(x.targetUrl);
      if (x.chain.length >= 2) s.chains++;
      if (x.finalStatus !== null && x.finalStatus >= 400) s.redirectsToErrors++;
      if (!x.finalUrl) s.offSite++;
    }
  }
  s.targets = { client: t.client.size, server: t.server.size, redirect: t.redirect.size };
  return s;
}

/** Status chip text: "404", "503", "301 → 200", "301 → 404", "301 (2 hops)", "301 → off-site". */
export function brokenStatusText(x: Pick<BrokenLinkRow, "issue" | "statusCode" | "finalUrl" | "finalStatus" | "chain">): string {
  const code = x.statusCode !== null ? String(x.statusCode) : x.issue === "redirect" ? "3xx" : x.issue === "client_error" ? "4xx" : "5xx";
  if (x.issue !== "redirect") return code;
  const hops = x.chain.length >= 2 ? ` (${x.chain.length} hops)` : "";
  if (!x.finalUrl) return `${code} → off-site${hops}`;
  return `${code} → ${x.finalStatus !== null ? x.finalStatus : "not crawled"}${hops}`;
}

export const brokenTone = (x: Pick<BrokenLinkRow, "issue" | "finalStatus">): "change" | "review" =>
  x.issue !== "redirect" || (x.finalStatus !== null && x.finalStatus >= 400) ? "change" : "review";

// ------------------------------------------------------------------ 18 hub and cluster gaps
export interface HubGap {
  hub: LinkHubView;
  /** Spokes the hub does not link to. */
  missingHubToSpoke: number;
  /** Spokes that do not link back to the hub. */
  missingSpokeToHub: number;
  /** Missing links in the cluster (both directions counted). */
  gaps: number;
  /** The first spokes with a missing link (spokes come sorted unlinked/partial first). */
  examples: Array<{ spoke: LinkSpokeView; hubToSpoke: boolean; spokeToHub: boolean }>;
}

/** Hubs sorted by missing links (then unlinked spokes, then size), with the first spokes that miss a link. */
export function clusterGaps(r: LinkClusterReport, maxHubs: number = LINK_ROWS.hubs, maxExamples: number = LINK_ROWS.hubExamples): { hubs: HubGap[]; totalHubs: number; missingHubToSpoke: number; missingSpokeToHub: number } {
  const all = r.hubs.map((hub): HubGap => {
    let h2s = 0;
    let s2h = 0;
    const examples: HubGap["examples"] = [];
    for (const s of hub.spokes) {
      if (!s.hubToSpoke) h2s++;
      if (!s.spokeToHub) s2h++;
      if ((!s.hubToSpoke || !s.spokeToHub) && examples.length < maxExamples) examples.push({ spoke: s, hubToSpoke: s.hubToSpoke, spokeToHub: s.spokeToHub });
    }
    return { hub, missingHubToSpoke: h2s, missingSpokeToHub: s2h, gaps: h2s + s2h, examples };
  });
  all.sort((a, b) => b.gaps - a.gaps || b.hub.unlinked - a.hub.unlinked || b.hub.spokes.length - a.hub.spokes.length || (a.hub.url < b.hub.url ? -1 : a.hub.url > b.hub.url ? 1 : 0));
  return {
    hubs: all.slice(0, maxHubs),
    totalHubs: all.length,
    missingHubToSpoke: all.reduce((n, h) => n + h.missingHubToSpoke, 0),
    missingSpokeToHub: all.reduce((n, h) => n + h.missingSpokeToHub, 0),
  };
}

/** "hub → spoke missing", "spoke → hub missing", or both. */
export function missingText(e: { hubToSpoke: boolean; spokeToHub: boolean }): string {
  if (!e.hubToSpoke && !e.spokeToHub) return "both directions missing";
  return e.hubToSpoke ? "spoke → hub missing" : "hub → spoke missing";
}

// ------------------------------------------------------------------ 19 anchor text flags
export type AnchorFlag = AnchorAuditView["flags"][number];
export const ANCHOR_FLAGS: readonly AnchorFlag[] = ["exact_match_heavy", "repeated_anchor", "generic_anchor", "empty_anchor", "no_query_terms"];
export { ANCHOR_FLAG_LABEL };

const share = (x: number) => `${Math.round(x * 100)}%`;
const known = (t: Record<string, number>, k: string) => (typeof t[k] === "number" && Number.isFinite(t[k]) ? t[k]! : null);

/**
 * The documented thresholds per flag, from the report's `thresholds` (engineering defaults of
 * links-anchor-audit; the same numbers as the workbench's own notes). A threshold the server did not return is left
 * out of its sentence rather than guessed.
 */
export function anchorThresholds(t: Record<string, number>): Record<AnchorFlag, string> {
  const exact = known(t, "EXACT_MATCH_SHARE");
  const exactMin = known(t, "EXACT_MATCH_MIN_INLINKS");
  const repMin = known(t, "REPEATED_MIN_SOURCES");
  const repShare = known(t, "REPEATED_SHARE");
  const minLinks = known(t, "MIN_ANCHORED_INLINKS");
  return {
    exact_match_heavy: `More than ${exact !== null ? share(exact) : "the threshold share"} of anchored links use the exact keyword${exactMin !== null ? `, with at least ${fmtInt(exactMin)} links` : ""}`,
    repeated_anchor: `One anchor${repMin !== null ? ` from at least ${fmtInt(repMin)} source pages` : ""}${repShare !== null ? ` and at least ${share(repShare)} of anchored links` : ""}`,
    generic_anchor: 'A generic anchor such as "click here" or "read more"',
    empty_anchor: "A content link with no text, image alt or aria-label",
    no_query_terms: `No anchor contains a term of the page's top Search Console queries${minLinks !== null ? ` (at least ${fmtInt(minLinks)} anchored links)` : ""}`,
  };
}

/**
 * One-line caption of the numeric thresholds ("exact match > 50% with ≥ 5 links · …"); thresholds the server did not
 * return are left out.
 */
export function anchorThresholdCaption(t: Record<string, number>): string {
  const exact = known(t, "EXACT_MATCH_SHARE");
  const exactMin = known(t, "EXACT_MATCH_MIN_INLINKS");
  const repMin = known(t, "REPEATED_MIN_SOURCES");
  const repShare = known(t, "REPEATED_SHARE");
  const minLinks = known(t, "MIN_ANCHORED_INLINKS");
  const parts: string[] = [];
  if (exact !== null) parts.push(`exact match > ${share(exact)}${exactMin !== null ? ` with ≥ ${fmtInt(exactMin)} links` : ""}`);
  if (repMin !== null || repShare !== null) parts.push(`repeated: one anchor${repMin !== null ? ` from ≥ ${fmtInt(repMin)} pages` : ""}${repShare !== null ? ` and ≥ ${share(repShare)}` : ""}`);
  if (minLinks !== null) parts.push(`no query terms: ≥ ${fmtInt(minLinks)} anchored links`);
  return `Thresholds (engineering defaults, not search-engine rules): ${parts.length ? parts.join(" · ") : "as returned by the anchor audit"}.`;
}

/** Keyword basis without nested parentheses (the caller puts it in parentheses). */
export const KEYWORD_BASIS_SHORT: Record<NonNullable<AnchorAuditView["keywordBasis"]>, string> = {
  search_console_query: "top Search Console query",
  h1: "H1, no Search Console query",
  title: "title, no Search Console query or H1",
};

/** Flagged pages per flag among the listed rows. */
export function anchorFlagCounts(r: AnchorAuditReport): Record<AnchorFlag, number> {
  const out = Object.fromEntries(ANCHOR_FLAGS.map((f) => [f, 0])) as Record<AnchorFlag, number>;
  for (const row of r.rows) for (const f of row.flags) if (f in out) out[f]++;
  return out;
}

/** "7 anchored links · 1 distinct anchor · keyword “…” (H1)" (keyword is page text: the caller renders plain text). */
export function anchorFacts(a: AnchorAuditView): string {
  const parts = [plural(a.anchoredInlinks, "anchored link"), plural(a.distinctAnchors, "distinct anchor")];
  if (a.emptyAnchors > 0) parts.push(plural(a.emptyAnchors, "empty anchor"));
  return parts.join(" · ");
}

// ------------------------------------------------------------------ 20 placed links verification
export interface PlacedSummary {
  total: number;
  verified: number;
  notFound: number;
  /** Pending crawl of the source page, plus links not checked yet. */
  pending: number;
  sourceUnavailable: number;
  /** "not found" rows, latest check first. */
  notFoundRows: PlacedLinkRow[];
  /** The latest check of any placed link (the crawl snapshot date). */
  latestCheck: string | null;
}

export function placedSummary(r: PlacedLinksReport, max: number = LINK_ROWS.notFound): PlacedSummary {
  const notFound = r.rows
    .filter((x) => x.verification.status === "not_found")
    .sort((a, b) => (b.verification.checkedAt ?? "").localeCompare(a.verification.checkedAt ?? "") || (a.sourceUrl < b.sourceUrl ? -1 : 1));
  const latest = r.rows.map((x) => x.verification.checkedAt).filter((x): x is string => !!x).sort().pop() ?? null;
  return {
    total: r.counts.total,
    verified: r.counts.verified,
    notFound: r.counts.notFound,
    pending: r.counts.pending + r.counts.notChecked,
    sourceUnavailable: r.counts.sourceUnavailable,
    notFoundRows: notFound.slice(0, max),
    latestCheck: latest,
  };
}

export const VERIFY_SEGMENTS: Array<{ key: "verified" | "notFound" | "pending" | "sourceUnavailable"; label: string; status: LinkVerificationStatus; cls: string }> = [
  { key: "verified", label: "Verified", status: "verified", cls: "bg-emerald-600 dark:bg-emerald-400" },
  { key: "notFound", label: "Not found", status: "not_found", cls: "bg-rose-600 dark:bg-rose-400" },
  { key: "sourceUnavailable", label: "Source unavailable", status: "source_unavailable", cls: "bg-amber-500 dark:bg-amber-400" },
  { key: "pending", label: "Pending crawl", status: "pending", cls: "lv-hatch bg-zinc-300 dark:bg-zinc-600" },
];

export const ORIGIN_LABEL: Record<PlacedLinkRow["origins"][number], string> = { implemented: "implemented", accepted: "accepted", sheet: "from your sheet" };
