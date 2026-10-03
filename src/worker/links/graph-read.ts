/**
 * Reading the stored link graph (internal-links workbench 2026-10-03): summary, the per-URL table (filter, sort,
 * page), one URL's inbound/outbound detail, the cluster view (owner overrides applied at read time), broken and
 * redirected links, the anchor audit, and the CSV exports. Every query filters by workspace_id and project_id and is
 * bounded (LIMIT / keyset); IN lists stay under D1's 100-parameter limit. Page text (titles, anchors) is untrusted
 * evidence returned as plain strings.
 */
import type {
  AnchorAuditReport,
  AnchorAuditView,
  BrokenLinkRow,
  BrokenLinksReport,
  CapabilityState,
  LinkClusterReport,
  LinkGraphFilter,
  LinkGraphSort,
  LinkGraphSummary,
  LinkGraphUrlDetail,
  LinkGraphUrlPage,
  LinkGraphUrlRow,
  LinkHubView,
  LinkSpokeView,
  LinkVerificationView,
} from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { notFound } from "../lib/errors";
import type { ProjectRow } from "../platform/access";
import { loadInventoryState } from "../seo/crawl/rolling";
import { normalizeUrlKey } from "../seo/rules/registry";
import { ANCHOR_AUDIT_VERSION, ANCHOR_THRESHOLDS } from "./anchor-audit";
import { ASSIGN_METHOD_LABEL, HUB_SOURCE_LABEL, spokeType, type AssignMethod, type HubSource } from "./clusters";
import { assumedCanonical, STALE_DAYS } from "./graph";
import { graphHost, loadClusterOverrides, type GraphSummaryJson } from "./graph-store";
import { chunks, IN_CHUNK, placeholders } from "./sql";
import { BOM, csvCell } from "./csv";
import type { StoredVerification } from "./verify";

export const MAX_PAGE_LIMIT = 200;
export const MAX_OFFSET = 20_000;
export const MAX_BROKEN_ROWS = 2_000;
export const MAX_ANCHOR_ROWS = 500;
const MAX_GRAPH_ROWS = 12_000;
const CSV_PAGE = 500;
export { BOM };

export interface GraphRow {
  id: string;
  status: string;
  trigger: LinkGraphSummary["trigger"];
  crawl_run_id: string | null;
  summary_json: string;
  created_at: string;
  finished_at: string | null;
}

export async function latestGraph(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">): Promise<GraphRow | null> {
  return db.first<GraphRow>(
    `SELECT id, status, trigger, crawl_run_id, summary_json, created_at, finished_at FROM link_graphs
      WHERE workspace_id = ? AND project_id = ? AND status = 'ready' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    project.workspace_id,
    project.id,
  );
}

const staleCutoff = (now: Date) => new Date(now.getTime() - STALE_DAYS * 86_400_000).toISOString();
const day = (t: string | null | undefined) => (t ? t.slice(0, 10) : "");

function stateFor(project: Pick<ProjectRow, "is_demo">): CapabilityState {
  return project.is_demo === 1 ? "demo" : "ready";
}

export async function graphSummary(db: Db, project: ProjectRow, now: Date): Promise<LinkGraphSummary> {
  const host = graphHost(project);
  const empty = (state: CapabilityState, labels: string[]): LinkGraphSummary => ({
    state,
    graphId: null,
    builtAt: null,
    trigger: null,
    coverageLabel: null,
    coverage: null,
    counts: null,
    rolling: null,
    newerCrawl: null,
    gscLabel: null,
    labels,
    versions: {},
  });
  if (!host) return empty("setup_required", ["Verify site ownership (Search Console, DNS, or file) first. The link graph is built only from crawls of your verified site."]);
  const g = await latestGraph(db, project);
  if (!g) {
    const crawl = await db.first<{ id: string }>("SELECT id FROM crawl_runs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial') LIMIT 1", project.workspace_id, project.id);
    return empty(crawl ? stateFor(project) : "setup_required", [crawl ? "No link graph yet. It is built after the next crawl, or press Rebuild graph." : `No crawl yet. Run the SEO agent to crawl ${host}; the link graph is built after each crawl.`]);
  }
  const s = parseJson<Partial<GraphSummaryJson>>(g.summary_json, {});
  const newer = await db.first<{ started_at: string }>(
    `SELECT started_at FROM crawl_runs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial') AND finished_at > ?
      ORDER BY started_at DESC LIMIT 1`,
    project.workspace_id,
    project.id,
    g.finished_at ?? g.created_at,
  );
  const limits = await db.first<{ crawl_pages: number }>("SELECT crawl_pages FROM project_limits WHERE workspace_id = ? AND project_id = ?", project.workspace_id, project.id);
  const state = await loadInventoryState(db, { id: project.id, workspaceId: project.workspace_id });
  const c = s.coverage;
  return {
    state: stateFor(project),
    graphId: g.id,
    builtAt: g.finished_at ?? g.created_at,
    trigger: g.trigger,
    coverageLabel: s.coverageLabel ?? null,
    coverage: c
      ? {
          sitemapUrls: c.sitemapUrls,
          sitemapAnalysed: c.sitemapAnalysed,
          pagesWithSnapshot: c.pagesWithSnapshot,
          oldestSnapshot: c.oldestSnapshot,
          newestSnapshot: c.newestSnapshot,
          stalePages: c.stalePages,
          staleDays: STALE_DAYS,
          neverCrawledSitemap: c.neverCrawledSitemap,
          linkOnlyNodes: c.linkOnlyNodes,
        }
      : null,
    counts: s.counts ?? null,
    rolling: s.rolling ? { ...s.rolling, cursorOrd: state.cursorOrd, passes: state.passes, pagesPerRun: Number(limits?.crawl_pages ?? 20) } : null,
    newerCrawl: newer?.started_at ?? null,
    gscLabel: s.gscLabel ?? null,
    labels: [...(s.notes ?? []), ...(newer ? [`A crawl finished after this graph was built (started ${newer.started_at}); rebuild to include it.`] : [])],
    versions: s.versions ?? {},
  };
}

// ------------------------------------------------------------------------------------ per-URL table

interface UrlDbRow {
  url_key: string;
  url: string;
  page_type: string | null;
  title: string | null;
  in_sitemap: number;
  status_code: number | null;
  final_url: string | null;
  redirect_hops: number | null;
  fetched_at: string | null;
  indexable: number;
  noindex: number;
  canonical_url: string | null;
  links_in: number;
  content_links_in: number;
  links_out: number;
  content_links_out: number;
  orphan: number;
  issue: LinkGraphUrlRow["issue"];
  is_hub: number;
  hub_key: string | null;
  hub_method: string | null;
  gsc_impressions: number | null;
  gsc_clicks: number | null;
  gsc_position: number | null;
  anchor_flags: string | null;
}

const ROW_COLUMNS =
  "url_key, url, page_type, title, in_sitemap, status_code, final_url, redirect_hops, fetched_at, indexable, noindex, canonical_url, links_in, content_links_in, links_out, content_links_out, orphan, issue, is_hub, hub_key, hub_method, gsc_impressions, gsc_clicks, gsc_position, anchor_flags";

function toRow(r: UrlDbRow, cutoff: string): LinkGraphUrlRow {
  return {
    key: r.url_key,
    url: r.url,
    title: r.title,
    pageType: r.page_type,
    inSitemap: Number(r.in_sitemap) === 1,
    crawled: r.fetched_at !== null,
    statusCode: r.status_code === null ? null : Number(r.status_code),
    finalUrl: r.final_url,
    redirectHops: r.redirect_hops === null ? null : Number(r.redirect_hops),
    fetchedAt: r.fetched_at,
    stale: r.fetched_at !== null && r.fetched_at < cutoff,
    indexable: Number(r.indexable) === 1,
    noindex: Number(r.noindex) === 1,
    canonicalUrl: r.canonical_url,
    linksIn: Number(r.links_in),
    contentLinksIn: Number(r.content_links_in),
    linksOut: Number(r.links_out),
    contentLinksOut: Number(r.content_links_out),
    orphan: Number(r.orphan) === 1,
    issue: r.issue ?? null,
    isHub: Number(r.is_hub) === 1,
    hubUrl: r.hub_key,
    hubMethod: r.hub_method,
    gsc: r.gsc_impressions === null ? null : { impressions: Number(r.gsc_impressions), clicks: Number(r.gsc_clicks ?? 0), position: r.gsc_position === null ? null : Number(r.gsc_position) },
    anchorFlags: r.anchor_flags ? r.anchor_flags.split(",").filter(Boolean) : [],
  };
}

export const GRAPH_FILTERS: readonly LinkGraphFilter[] = ["all", "orphans", "no_content_links", "issues", "stale", "not_crawled", "hubs", "sitemap", "anchor_flags"];
export const GRAPH_SORTS: readonly LinkGraphSort[] = ["url", "links_in", "content_links_in", "links_out", "impressions", "fetched_at"];
const SORT_SQL: Record<LinkGraphSort, string> = {
  url: "url_key",
  links_in: "links_in",
  content_links_in: "content_links_in",
  links_out: "links_out",
  impressions: "gsc_impressions",
  fetched_at: "fetched_at",
};

function filterSql(filter: LinkGraphFilter, cutoff: string): { sql: string; params: unknown[] } {
  switch (filter) {
    case "orphans":
      return { sql: "orphan = 1", params: [] };
    case "no_content_links":
      return { sql: "in_sitemap = 1 AND indexable = 1 AND content_links_in = 0 AND COALESCE(page_type, '') != 'home'", params: [] };
    case "issues":
      return { sql: "issue IS NOT NULL AND links_in > 0", params: [] };
    case "stale":
      return { sql: "fetched_at IS NOT NULL AND fetched_at < ?", params: [cutoff] };
    case "not_crawled":
      return { sql: "fetched_at IS NULL", params: [] };
    case "hubs":
      return { sql: "is_hub = 1", params: [] };
    case "sitemap":
      return { sql: "in_sitemap = 1", params: [] };
    case "anchor_flags":
      return { sql: "anchor_flags IS NOT NULL", params: [] };
    default:
      return { sql: "1 = 1", params: [] };
  }
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface UrlQuery {
  filter?: LinkGraphFilter;
  sort?: LinkGraphSort;
  dir?: "asc" | "desc";
  q?: string | null;
  offset?: number;
  limit?: number;
}

export async function graphUrls(db: Db, project: ProjectRow, query: UrlQuery, now: Date): Promise<LinkGraphUrlPage> {
  const filter = query.filter && GRAPH_FILTERS.includes(query.filter) ? query.filter : "all";
  const sort = query.sort && GRAPH_SORTS.includes(query.sort) ? query.sort : "links_in";
  const dir = query.dir === "asc" ? "asc" : "desc";
  const offset = Math.max(0, Math.min(MAX_OFFSET, Math.floor(query.offset ?? 0)));
  const limit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(query.limit ?? 50)));
  const q = query.q ? query.q.trim().slice(0, 200) : null;
  const g = await latestGraph(db, project);
  if (!g) return { graphId: null, rows: [], total: 0, offset, limit, filter, sort, dir, q };
  const cutoff = staleCutoff(now);
  const f = filterSql(filter, cutoff);
  const where = [`workspace_id = ? AND project_id = ? AND graph_id = ?`, f.sql];
  const params: unknown[] = [project.workspace_id, project.id, g.id, ...f.params];
  if (q) {
    // LIKE is case-insensitive for ASCII in SQLite/D1.
    where.push(`(url_key LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')`);
    params.push(`%${likeEscape(q)}%`, `%${likeEscape(q)}%`);
  }
  const col = SORT_SQL[sort];
  const total = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM link_graph_urls WHERE ${where.join(" AND ")}`, ...params);
  const rows = await db.all<UrlDbRow>(
    `SELECT ${ROW_COLUMNS} FROM link_graph_urls WHERE ${where.join(" AND ")}
      ORDER BY (${col} IS NULL), ${col} ${dir.toUpperCase()}, url_key ASC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return { graphId: g.id, rows: rows.map((r) => toRow(r, cutoff)), total: Number(total?.n ?? 0), offset, limit, filter, sort, dir, q };
}

async function titlesFor(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, graphId: string, keys: readonly string[]): Promise<Map<string, { title: string | null; status: number | null; issue: LinkGraphUrlRow["issue"]; fetchedAt: string | null }>> {
  const out = new Map<string, { title: string | null; status: number | null; issue: LinkGraphUrlRow["issue"]; fetchedAt: string | null }>();
  for (const part of chunks([...new Set(keys)], IN_CHUNK)) {
    const rows = await db.all<{ url_key: string; title: string | null; status_code: number | null; issue: LinkGraphUrlRow["issue"]; fetched_at: string | null }>(
      `SELECT url_key, title, status_code, issue, fetched_at FROM link_graph_urls WHERE workspace_id = ? AND project_id = ? AND graph_id = ? AND url_key IN (${placeholders(part.length)})`,
      project.workspace_id,
      project.id,
      graphId,
      ...part,
    );
    for (const r of rows) out.set(r.url_key, { title: r.title, status: r.status_code === null ? null : Number(r.status_code), issue: r.issue ?? null, fetchedAt: r.fetched_at });
  }
  return out;
}

const KIND_NAME: Record<string, "content" | "image" | "breadcrumb" | "navigation"> = { c: "content", i: "image", b: "breadcrumb", n: "navigation" };

export function parseInbound(raw: string): Array<{ key: string; anchor: string | null; kind: "content" | "image" | "breadcrumb" | "navigation"; via: "redirect" | "canonical" | null }> {
  return parseJson<unknown[]>(raw, [])
    .filter((e): e is unknown[] => Array.isArray(e) && typeof e[0] === "string")
    .map((e) => ({
      key: e[0] as string,
      anchor: typeof e[1] === "string" ? e[1] : null,
      kind: KIND_NAME[typeof e[2] === "string" ? e[2] : "n"] ?? "navigation",
      via: e[3] === "redirect" || e[3] === "canonical" ? e[3] : null,
    }));
}

export function parseAnchorAudit(raw: string | null | undefined, url: string, title: string | null, flags: string | null): AnchorAuditView | null {
  const a = parseJson<{ n?: number; d?: number; k?: string | null; kb?: AnchorAuditView["keywordBasis"]; es?: number | null; top?: unknown[]; g?: unknown[]; em?: number; q?: string[]; r?: string[] }>(raw ?? "{}", {});
  if (a.n === undefined) return null;
  const pairs = (v: unknown[] | undefined) =>
    (v ?? []).filter((p): p is [string, number] => Array.isArray(p) && typeof p[0] === "string").map((p) => ({ text: p[0], sources: Number(p[1]) || 0 }));
  return {
    url,
    title,
    anchoredInlinks: Number(a.n) || 0,
    distinctAnchors: Number(a.d) || 0,
    keyword: a.k ?? null,
    keywordBasis: a.kb ?? null,
    exactMatchShare: a.es ?? null,
    top: pairs(a.top),
    generic: pairs(a.g),
    emptyAnchors: Number(a.em) || 0,
    queryTerms: Array.isArray(a.q) ? a.q.filter((x): x is string => typeof x === "string") : [],
    flags: (flags ?? "").split(",").filter(Boolean) as AnchorAuditView["flags"],
    reasons: Array.isArray(a.r) ? a.r.filter((x): x is string => typeof x === "string") : [],
  };
}

export async function graphUrlDetail(db: Db, project: ProjectRow, url: string, now: Date): Promise<LinkGraphUrlDetail> {
  const g = await latestGraph(db, project);
  if (!g) throw notFound("Link graph");
  let key: string;
  try {
    key = normalizeUrlKey(new URL(url).toString());
  } catch {
    throw notFound("URL");
  }
  const r = await db.first<UrlDbRow & { inbound_json: string; outbound_json: string; anchors_json: string; chain_json: string | null }>(
    `SELECT ${ROW_COLUMNS}, inbound_json, outbound_json, anchors_json, chain_json FROM link_graph_urls WHERE workspace_id = ? AND project_id = ? AND graph_id = ? AND url_key = ?`,
    project.workspace_id,
    project.id,
    g.id,
    key,
  );
  if (!r) throw notFound("URL");
  const inbound = parseInbound(r.inbound_json);
  const outbound = parseJson<unknown[]>(r.outbound_json, []).filter((k): k is string => typeof k === "string");
  const info = await titlesFor(db, project, g.id, [...inbound.map((i) => i.key), ...outbound]);
  const cutoff = staleCutoff(now);
  return {
    row: toRow(r, cutoff),
    inbound: inbound.map((i) => ({ url: i.key, title: info.get(i.key)?.title ?? null, anchor: i.anchor, kind: i.kind, via: i.via })),
    inboundShown: inbound.length,
    outbound: outbound.map((k) => ({ url: k, title: info.get(k)?.title ?? null, statusCode: info.get(k)?.status ?? null, issue: info.get(k)?.issue ?? null })),
    redirectChain: parseJson<Array<{ status: number; to: string }>>(r.chain_json, []).filter((h) => h && typeof h.to === "string"),
    anchors: parseAnchorAudit(r.anchors_json, r.url, r.title, r.anchor_flags),
  };
}

/** Per-URL CSV (owner's InternalLink_Overview layout plus Okara's columns), UTF-8 with BOM. Keyset-paged, bounded. */
export async function graphCsv(db: Db, project: ProjectRow, now: Date): Promise<string> {
  const header = ["URL", "Title", "Status", "In sitemap", "Indexable", "Links in", "Content links in", "Links out", "Content links out", "Orphan", "Inbound sources (anchors)", "Outbound targets", "Hub", "Hub method", "Last crawled", "Stale", "Impressions", "Clicks", "Avg position"];
  const lines = [header.map(csvCell).join(",")];
  const g = await latestGraph(db, project);
  if (!g) return `${BOM}${lines.join("\r\n")}\r\n`;
  const cutoff = staleCutoff(now);
  let after = "";
  let n = 0;
  while (n < MAX_GRAPH_ROWS) {
    const rows = await db.all<UrlDbRow & { inbound_json: string; outbound_json: string }>(
      `SELECT ${ROW_COLUMNS}, inbound_json, outbound_json FROM link_graph_urls WHERE workspace_id = ? AND project_id = ? AND graph_id = ? AND url_key > ?
        ORDER BY url_key LIMIT ${CSV_PAGE}`,
      project.workspace_id,
      project.id,
      g.id,
      after,
    );
    for (const r of rows) {
      const row = toRow(r, cutoff);
      const inbound = parseInbound(r.inbound_json)
        .map((i) => `${i.key}${i.anchor ? ` [${i.anchor}]` : ""}${i.kind === "navigation" ? " (navigation)" : ""}${i.via ? ` (via ${i.via})` : ""}`)
        .join("; ");
      const outbound = parseJson<unknown[]>(r.outbound_json, []).filter((k): k is string => typeof k === "string").join("; ");
      lines.push(
        [
          row.url,
          row.title,
          row.statusCode,
          row.inSitemap ? "yes" : "no",
          row.crawled ? (row.indexable ? "yes" : "no") : "not crawled",
          row.linksIn,
          row.contentLinksIn,
          row.linksOut,
          row.contentLinksOut,
          row.orphan ? "yes" : "no",
          clipCell(inbound),
          clipCell(outbound),
          row.hubUrl,
          row.hubMethod,
          row.fetchedAt ? day(row.fetchedAt) : "",
          row.stale ? "yes" : "no",
          row.gsc?.impressions ?? null,
          row.gsc?.clicks ?? null,
          row.gsc?.position !== null && row.gsc?.position !== undefined ? Math.round(row.gsc.position * 10) / 10 : null,
        ]
          .map((v) => csvCell(v as string | number | null))
          .join(","),
      );
      n++;
    }
    if (rows.length < CSV_PAGE) break;
    after = rows[rows.length - 1]!.url_key;
  }
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

const clipCell = (s: string) => (s.length > 30_000 ? `${s.slice(0, 29_990)}…` : s);

// ------------------------------------------------------------------------------------ clusters

export async function clusterReport(db: Db, project: ProjectRow): Promise<LinkClusterReport> {
  const g = await latestGraph(db, project);
  const empty = (state: CapabilityState, labels: string[]): LinkClusterReport => ({
    state,
    graphId: null,
    builtAt: null,
    hubs: [],
    unassigned: [],
    counts: { hubs: 0, spokes: 0, linked: 0, partial: 0, unlinked: 0, unassigned: 0 },
    labels,
  });
  if (!graphHost(project)) return empty("setup_required", ["Verify site ownership first; clusters are built from crawls of your verified site."]);
  if (!g) return empty(stateFor(project), ["No link graph yet. It is built after the next crawl, or press Rebuild graph."]);
  const rows = await db.all<{
    url_key: string;
    url: string;
    title: string | null;
    page_type: string | null;
    indexable: number;
    is_hub: number;
    hub_source: HubSource | null;
    hub_key: string | null;
    hub_method: AssignMethod | null;
    hub_score: number | null;
    hub_to_spoke: number | null;
    spoke_to_hub: number | null;
    outbound_json: string;
  }>(
    `SELECT url_key, url, title, page_type, indexable, is_hub, hub_source, hub_key, hub_method, hub_score, hub_to_spoke, spoke_to_hub, outbound_json
       FROM link_graph_urls WHERE workspace_id = ? AND project_id = ? AND graph_id = ? AND (is_hub = 1 OR indexable = 1) LIMIT ${MAX_GRAPH_ROWS}`,
    project.workspace_id,
    project.id,
    g.id,
  );
  const overrides = await loadClusterOverrides(db, project);
  const byKey = new Map(rows.map((r) => [r.url_key, r]));
  const hubs = new Map<string, HubSource>();
  for (const r of rows) if (Number(r.is_hub) === 1 && r.hub_source) hubs.set(r.url_key, r.hub_source);
  const labels: string[] = [];
  let changedSinceBuild = false;
  for (const [key, isHub] of overrides.hubs) {
    if (!byKey.has(key)) continue;
    if (isHub && hubs.get(key) !== "owner") {
      hubs.set(key, "owner");
      changedSinceBuild = true;
    }
    if (!isHub && hubs.has(key)) {
      hubs.delete(key);
      changedSinceBuild = true;
    }
  }
  const outboundOf = (key: string) => {
    const r = byKey.get(key);
    const keys = new Set(parseJson<unknown[]>(r?.outbound_json ?? "[]", []).filter((k): k is string => typeof k === "string"));
    // Shopify collection-scoped / variant product URLs count for their product (graph.ts assumedCanonical).
    for (const k of [...keys]) {
      const c = assumedCanonical(k);
      if (c) keys.add(normalizeUrlKey(c));
    }
    return keys;
  };
  const hubViews = new Map<string, LinkHubView>();
  const hubView = (key: string): LinkHubView => {
    let v = hubViews.get(key);
    if (!v) {
      const r = byKey.get(key);
      const source = hubs.get(key) ?? "owner";
      v = { key, url: r?.url ?? key, title: r?.title ?? null, source, sourceLabel: HUB_SOURCE_LABEL[source], spokes: [], linked: 0, partial: 0, unlinked: 0 };
      hubViews.set(key, v);
    }
    return v;
  };
  for (const key of hubs.keys()) hubView(key);
  const unassigned: LinkClusterReport["unassigned"] = [];
  for (const r of rows) {
    if (hubs.has(r.url_key) || Number(r.indexable) !== 1) continue;
    const type = spokeType({ url: r.url, pageType: r.page_type });
    if (!type) continue;
    let hub = r.hub_key;
    let method = r.hub_method;
    let hubToSpoke = Number(r.hub_to_spoke) === 1;
    let spokeToHub = Number(r.spoke_to_hub) === 1;
    const owner = overrides.assign.get(r.url_key);
    if (owner !== undefined && !(method === "owner" && (hub ?? "") === owner)) {
      changedSinceBuild = true;
      hub = owner === "" ? null : owner;
      method = "owner";
      if (hub) {
        if (!hubs.has(hub)) hubs.set(hub, "owner");
        hubToSpoke = outboundOf(hub).has(r.url_key);
        spokeToHub = outboundOf(r.url_key).has(hub);
      }
    }
    if (hub && !hubs.has(hub)) {
      // The hub was unmarked after the build: the spoke waits for a rebuild to be reassigned.
      hub = null;
      method = null;
    }
    if (!hub || !method) {
      unassigned.push({ key: r.url_key, url: r.url, title: r.title, type });
      continue;
    }
    const v = hubView(hub);
    const spoke: LinkSpokeView = {
      key: r.url_key,
      url: r.url,
      title: r.title,
      type,
      method,
      methodLabel: ASSIGN_METHOD_LABEL[method],
      similarity: r.hub_score === null ? null : Number(r.hub_score),
      hubToSpoke,
      spokeToHub,
    };
    v.spokes.push(spoke);
    if (hubToSpoke && spokeToHub) v.linked++;
    else if (hubToSpoke || spokeToHub) v.partial++;
    else v.unlinked++;
  }
  const list = [...hubViews.values()].sort((a, b) => b.unlinked + b.partial - (a.unlinked + a.partial) || b.spokes.length - a.spokes.length || (a.url < b.url ? -1 : 1));
  for (const h of list) h.spokes.sort((a, b) => Number(a.hubToSpoke && a.spokeToHub) - Number(b.hubToSpoke && b.spokeToHub) || (a.url < b.url ? -1 : 1));
  if (changedSinceBuild) labels.push("Your hub changes are applied; spokes of hubs you added or removed are reassigned automatically on the next graph rebuild.");
  labels.push(
    "Hubs: collection pages (/collections/<handle>), hubs named in your imported sheet, and pages you marked. Spokes: indexable articles and products, assigned by your choice, your sheet, collection membership, existing links, or term overlap (TF-IDF on titles and headings); the method is shown per spoke.",
  );
  labels.push("Linked = the hub links to the spoke and the spoke links back (content or breadcrumb link). Suggestions that add a missing link carry the cluster-gap boost.");
  const counts = list.reduce(
    (a, h) => ({ hubs: a.hubs + 1, spokes: a.spokes + h.spokes.length, linked: a.linked + h.linked, partial: a.partial + h.partial, unlinked: a.unlinked + h.unlinked, unassigned: a.unassigned }),
    { hubs: 0, spokes: 0, linked: 0, partial: 0, unlinked: 0, unassigned: unassigned.length },
  );
  return { state: stateFor(project), graphId: g.id, builtAt: g.finished_at ?? g.created_at, hubs: list, unassigned: unassigned.slice(0, 500), counts, labels };
}

// ------------------------------------------------------------------------------------ broken and redirected links

function fixFor(issue: BrokenLinkRow["issue"], finalUrl: string | null, finalStatus: number | null, finalIssue: string | null): string {
  if (issue === "redirect") {
    if (!finalUrl) return "The URL redirects off this site: remove the link or link to the right page on your site.";
    if (finalIssue === "client_error" || finalIssue === "server_error") return `Remove or replace the link: it redirects to ${finalUrl}, which returned HTTP ${finalStatus}.`;
    return `Link to ${finalUrl}${finalStatus === null ? " (final URL not crawled yet)" : ""}`;
  }
  return "Remove or replace the link";
}

export async function brokenLinks(db: Db, project: ProjectRow, now: Date, opts: { maxRows?: number } = {}): Promise<BrokenLinksReport> {
  const maxRows = Math.max(1, Math.min(MAX_BROKEN_ROWS * 3, opts.maxRows ?? MAX_BROKEN_ROWS));
  const g = await latestGraph(db, project);
  const base = { graphId: g?.id ?? null, builtAt: g ? (g.finished_at ?? g.created_at) : null, rows: [] as BrokenLinkRow[], targets: 0, totalLinks: 0, truncated: false, unchecked: 0 };
  if (!graphHost(project)) return { state: "setup_required", ...base, labels: ["Verify site ownership first; links are checked only from crawls of your verified site."] };
  if (!g) return { state: stateFor(project), ...base, labels: ["No link graph yet. It is built after the next crawl, or press Rebuild graph."] };
  const targets = await db.all<{ url_key: string; url: string; status_code: number | null; final_url: string | null; chain_json: string | null; fetched_at: string | null; inbound_json: string; links_in: number; issue: BrokenLinkRow["issue"] }>(
    `SELECT url_key, url, status_code, final_url, chain_json, fetched_at, inbound_json, links_in, issue FROM link_graph_urls
      WHERE workspace_id = ? AND project_id = ? AND graph_id = ? AND issue IS NOT NULL AND links_in > 0
      ORDER BY CASE issue WHEN 'server_error' THEN 0 WHEN 'client_error' THEN 1 ELSE 2 END, links_in DESC, url_key LIMIT ${MAX_BROKEN_ROWS}`,
    project.workspace_id,
    project.id,
    g.id,
  );
  const unchecked = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM link_graph_urls WHERE workspace_id = ? AND project_id = ? AND graph_id = ? AND fetched_at IS NULL AND links_in > 0",
    project.workspace_id,
    project.id,
    g.id,
  );
  const finals = await titlesFor(db, project, g.id, targets.map((t) => (t.final_url ? normalizeUrlKey(t.final_url) : "")).filter(Boolean));
  const parsed = targets.map((t) => ({ t, inbound: parseInbound(t.inbound_json).filter((i) => !i.via) }));
  const sourceKeys: string[] = [];
  let total = 0;
  for (const p of parsed) {
    total += p.inbound.length;
    for (const i of p.inbound) if (sourceKeys.length < maxRows) sourceKeys.push(i.key);
  }
  const sources = await titlesFor(db, project, g.id, sourceKeys);
  const cutoff = staleCutoff(now);
  const rows: BrokenLinkRow[] = [];
  let truncated = false;
  outer: for (const { t, inbound } of parsed) {
    const finalKey = t.final_url ? normalizeUrlKey(t.final_url) : null;
    const f = finalKey ? finals.get(finalKey) : undefined;
    const chain = parseJson<Array<{ status: number; to: string }>>(t.chain_json, []).filter((h) => h && typeof h.to === "string");
    for (const i of inbound) {
      if (rows.length >= maxRows) {
        truncated = true;
        break outer;
      }
      const src = sources.get(i.key);
      rows.push({
        sourceUrl: i.key,
        sourceTitle: src?.title ?? null,
        anchor: i.anchor,
        kind: i.kind,
        targetUrl: t.url,
        statusCode: t.status_code === null ? null : Number(t.status_code),
        issue: t.issue,
        finalUrl: t.issue === "redirect" ? t.final_url : null,
        finalStatus: f?.status ?? null,
        chain,
        fix: fixFor(t.issue, t.issue === "redirect" ? t.final_url : null, f?.status ?? null, f?.issue ?? null),
        targetCheckedAt: t.fetched_at,
        sourceCheckedAt: src?.fetchedAt ?? null,
        stale: (t.fetched_at !== null && t.fetched_at < cutoff) || (!!src?.fetchedAt && src.fetchedAt < cutoff),
        linkedFrom: Number(t.links_in),
      });
    }
    if (inbound.length < Number(t.links_in)) truncated = true;
  }
  const labels = [
    "From the latest snapshot of every crawled page: links whose target redirected (3xx, with every hop and the final URL) or returned 4xx/5xx when last crawled. Fetch errors and timeouts are never claimed broken.",
    `Snapshots older than ${STALE_DAYS} days are marked stale; the rolling crawl rechecks them.`,
  ];
  if (Number(unchecked?.n ?? 0) > 0) labels.push(`${Number(unchecked!.n).toLocaleString("en-US")} linked URLs are not crawled yet (queued for the rolling crawl); they are not listed until checked.`);
  if (truncated) labels.push("Only part of the sources is listed for targets linked from many pages (often navigation or template links: fix them once in the theme).");
  return { state: stateFor(project), graphId: g.id, builtAt: g.finished_at ?? g.created_at, rows, targets: targets.length, totalLinks: total, truncated, unchecked: Number(unchecked?.n ?? 0), labels };
}

export async function brokenLinksCsv(db: Db, project: ProjectRow, now: Date): Promise<string> {
  const r = await brokenLinks(db, project, now, { maxRows: MAX_BROKEN_ROWS * 3 });
  const header = ["Source URL", "Anchor", "Link position", "Target URL", "Status", "Issue", "Final URL", "Redirect chain", "Fix", "Target checked", "Source checked", "Stale"];
  const lines = [header.map(csvCell).join(",")];
  for (const x of r.rows) {
    lines.push(
      [
        x.sourceUrl,
        x.anchor,
        x.kind,
        x.targetUrl,
        x.statusCode,
        x.issue,
        x.finalUrl,
        x.chain.map((h) => `${h.status} ${h.to}`).join(" > "),
        x.fix,
        day(x.targetCheckedAt),
        day(x.sourceCheckedAt),
        x.stale ? "yes" : "no",
      ]
        .map((v) => csvCell(v as string | number | null))
        .join(","),
    );
  }
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

// ------------------------------------------------------------------------------------ anchors

export async function anchorReport(db: Db, project: ProjectRow, opts: { flaggedOnly?: boolean } = {}): Promise<AnchorAuditReport> {
  const g = await latestGraph(db, project);
  const thresholds = { ...ANCHOR_THRESHOLDS } as Record<string, number>;
  if (!graphHost(project)) return { state: "setup_required", graphId: null, builtAt: null, rows: [], total: 0, thresholds, labels: ["Verify site ownership first."] };
  if (!g) return { state: stateFor(project), graphId: null, builtAt: null, rows: [], total: 0, thresholds, labels: ["No link graph yet. It is built after the next crawl, or press Rebuild graph."] };
  const flaggedOnly = opts.flaggedOnly !== false;
  const rows = await db.all<{ url: string; title: string | null; anchors_json: string; anchor_flags: string | null; content_links_in: number }>(
    `SELECT url, title, anchors_json, anchor_flags, content_links_in FROM link_graph_urls
      WHERE workspace_id = ? AND project_id = ? AND graph_id = ? AND anchors_json != '{}' ${flaggedOnly ? "AND anchor_flags IS NOT NULL" : ""}
      ORDER BY (LENGTH(COALESCE(anchor_flags, '')) - LENGTH(REPLACE(COALESCE(anchor_flags, ''), ',', ''))) DESC, content_links_in DESC, url_key LIMIT ${MAX_ANCHOR_ROWS}`,
    project.workspace_id,
    project.id,
    g.id,
  );
  const total = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM link_graph_urls WHERE workspace_id = ? AND project_id = ? AND graph_id = ? AND anchors_json != '{}' ${flaggedOnly ? "AND anchor_flags IS NOT NULL" : ""}`,
    project.workspace_id,
    project.id,
    g.id,
  );
  const views = rows.map((r) => parseAnchorAudit(r.anchors_json, r.url, r.title, r.anchor_flags)).filter((v): v is AnchorAuditView => v !== null);
  return {
    state: stateFor(project),
    graphId: g.id,
    builtAt: g.finished_at ?? g.created_at,
    rows: views,
    total: Number(total?.n ?? 0),
    thresholds,
    labels: [
      "Content links only: navigation, header, footer, sidebar and breadcrumb links are not counted. One count per source page and anchor.",
      `Flags (engineering defaults, ${ANCHOR_AUDIT_VERSION}): exact-match heavy = more than ${Math.round(ANCHOR_THRESHOLDS.EXACT_MATCH_SHARE * 100)}% exact-match anchors with at least ${ANCHOR_THRESHOLDS.EXACT_MATCH_MIN_INLINKS} links; repeated = one anchor from at least ${ANCHOR_THRESHOLDS.REPEATED_MIN_SOURCES} sources and ${Math.round(ANCHOR_THRESHOLDS.REPEATED_SHARE * 100)}% of links; generic = an anchor such as "click here" or "read more"; empty = a content link with no text, image alt, or aria-label; no query terms = no anchor contains a term of the page's top Search Console queries (at least ${ANCHOR_THRESHOLDS.MIN_ANCHORED_INLINKS} links).`,
      "The keyword is the page's top non-brand Search Console query; without Search Console data, its H1 (labelled).",
    ],
  };
}

// ------------------------------------------------------------------------------------ verification labels

export function verificationView(v: StoredVerification | null | undefined): LinkVerificationView {
  if (!v) return { status: "not_checked", checkedAt: null, matchedVia: null, detail: null, label: "not checked yet" };
  const label =
    v.status === "verified"
      ? `verified on ${day(v.checkedAt)}`
      : v.status === "not_found"
        ? `not found in crawl of ${day(v.checkedAt)}`
        : v.status === "source_unavailable"
          ? `source unavailable in crawl of ${day(v.checkedAt)}`
          : v.checkedAt
            ? "pending next crawl of the source page"
            : "pending first crawl of the source page";
  return { status: v.status, checkedAt: v.checkedAt, matchedVia: (v.matchedVia as LinkVerificationView["matchedVia"]) ?? null, detail: v.detail, label };
}
