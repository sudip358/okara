/**
 * Builds the full-site link graph and stores it (internal-links workbench 2026-10-03, items 1, 2, 5, 6, 7).
 * Deterministic: reads stored crawl snapshots, the crawl inventory, stored Search Console rows, cluster overrides
 * and imported placed links; makes no external call and never spends a budget.
 *
 * One `link_graphs` row per build plus one `link_graph_urls` row per URL (written through json_each batches, so
 * each statement binds 4 parameters). Only the latest ready graph and a build in progress are kept. Builds run after
 * every crawl (crawl/run.ts, best effort), on demand (POST .../graph/rebuild), and inside every suggestion run.
 * A build younger than BUILD_GUARD_SECONDS blocks a second concurrent build for the project.
 */
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { conflict } from "../lib/errors";
import { newId } from "../lib/ids";
import { addSeconds, iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { siteHost } from "../platform/projects";
import { loadInventory, loadInventoryState, type InventoryState } from "../seo/crawl/rolling";
import { normalizeUrlKey } from "../seo/rules/registry";
import { ANCHOR_AUDIT_VERSION, auditAllAnchors, type AnchorAudit } from "./anchor-audit";
import { buildClusters, CLUSTERS_VERSION, collectionHandle, spokeType, type ClusterModel, type ClusterOverrides, type SheetHubHint } from "./clusters";
import { buildLinkGraph, coverageLabel, GRAPH_VERSION, STALE_DAYS, type GraphNode, type LinkGraph } from "./graph";
import { loadLatestSnapshots, type SnapshotRecord } from "./graph-load";
import { gscSourceLabel, loadGscPageData } from "./gsc";
import { jsonEachInsert, runBatches } from "./sql";
import { brandStopwords } from "./terms";
import { loadExpectedLinks, persistVerifications, verifyExpectedLinks, VERIFY_VERSION, type VerificationResult } from "./verify";

export const GRAPH_METHOD_VERSION = `${GRAPH_VERSION}+${CLUSTERS_VERSION}+${ANCHOR_AUDIT_VERSION}+${VERIFY_VERSION}`;
export const BUILD_GUARD_SECONDS = 10 * 60;
export const MAX_TOP_ANCHORS = 30;

export type GraphTrigger = "crawl" | "manual" | "run" | "demo";

export interface GraphSummaryJson {
  coverage: LinkGraph["coverage"];
  coverageLabel: string;
  counts: {
    urls: number;
    edges: number;
    contentEdges: number;
    orphans: number;
    noContentLinks: number;
    redirects: number;
    clientErrors: number;
    serverErrors: number;
    hubs: number;
    spokes: number;
    linkedSpokes: number;
    partialSpokes: number;
    unlinkedSpokes: number;
    unassignedSpokes: number;
    anchorFlagged: number;
    verified: number;
    notFound: number;
    pending: number;
    sourceUnavailable: number;
  };
  gscLabel: string | null;
  notes: string[];
  rolling: { inventoryUrls: number; neverCrawled: number; cursorOrd: number | null; passes: number; sitemapReadAt: string | null } | null;
  versions: Record<string, string>;
}

export interface GraphBuild extends ComputedGraph {
  graphId: string;
}

export function graphHost(project: Pick<ProjectRow, "is_demo" | "verified_host" | "site_url">): string | null {
  return project.is_demo === 1 ? siteHost(project.site_url) : project.verified_host;
}

export async function loadClusterOverrides(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">): Promise<ClusterOverrides> {
  const rows = await db.all<{ kind: "hub" | "assign"; page_key: string; value: string }>(
    "SELECT kind, page_key, value FROM link_cluster_overrides WHERE workspace_id = ? AND project_id = ? ORDER BY updated_at LIMIT 5000",
    project.workspace_id,
    project.id,
  );
  const hubs = new Map<string, boolean>();
  const assign = new Map<string, string>();
  for (const r of rows) {
    if (r.kind === "hub") hubs.set(r.page_key, r.value === "yes");
    else assign.set(r.page_key, r.value);
  }
  return { hubs, assign };
}

/** Hub hints from links imported from the owner's sheet (Hub column = collection handle). */
export async function loadSheetHubHints(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">): Promise<SheetHubHint[]> {
  let rows: Array<{ data_json: string }> = [];
  try {
    rows = await db.all<{ data_json: string }>(
      `SELECT data_json FROM import_records WHERE workspace_id = ? AND project_id = ? AND destination = 'implemented_links' AND status = 'placed'
        ORDER BY created_at LIMIT 2000`,
      project.workspace_id,
      project.id,
    );
  } catch {
    return [];
  }
  const out: SheetHubHint[] = [];
  for (const r of rows) {
    const d = parseJson<{ source?: string; hub?: string | null }>(r.data_json, {});
    const handle = sheetHubHandle(d.hub);
    if (!d.source || !handle) continue;
    out.push({ spokeKey: normalizeUrlKey(d.source), handle });
  }
  return out;
}

/** A Hub cell as a collection handle: "chandeliers", "/collections/chandeliers", or a full collection URL. */
export function sheetHubHandle(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || s.startsWith("/")) {
    const h = collectionHandle(s.startsWith("/") ? `https://x.invalid${s}` : s);
    return h;
  }
  const h = s.toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9][a-z0-9_-]{0,200}$/.test(h) ? h : null;
}

async function claimBuild(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, trigger: GraphTrigger, crawlRunId: string | null, userId: string | null, now: Date): Promise<string | null> {
  const running = await db.first<{ id: string }>(
    "SELECT id FROM link_graphs WHERE workspace_id = ? AND project_id = ? AND status = 'building' AND created_at > ? LIMIT 1",
    project.workspace_id,
    project.id,
    iso(addSeconds(now, -BUILD_GUARD_SECONDS)),
  );
  if (running) return null;
  const id = newId("lgraph");
  await db.insert("link_graphs", {
    id,
    workspace_id: project.workspace_id,
    project_id: project.id,
    status: "building",
    trigger,
    crawl_run_id: crawlRunId,
    method_version: GRAPH_METHOD_VERSION,
    created_by: userId,
    created_at: iso(now),
  });
  return id;
}

const KIND_OUT: Record<string, string> = { c: "c", i: "i", b: "b", n: "n" };

function urlRow(graph: LinkGraph, n: GraphNode, clusters: ClusterModel, audit: AnchorAudit | undefined): unknown[] {
  const s = n.snap;
  const spoke = clusters.spokes.get(n.id);
  const hubSource = clusters.hubs.get(n.id) ?? null;
  const hubKey = spoke?.hub !== null && spoke?.hub !== undefined ? graph.nodes[spoke.hub]!.key : null;
  const inbound = n.inbound.map((l) => [graph.nodes[l.source]!.key, l.anchor ? l.anchor.slice(0, 120) : null, KIND_OUT[l.kind] ?? "n", l.via || null]);
  const outbound = n.outContent.slice(0, 200).map((id) => graph.nodes[id]!.key);
  const anchors = audit
    ? {
        n: audit.anchoredInlinks,
        d: audit.distinctAnchors,
        k: audit.keyword,
        kb: audit.keywordBasis,
        e: audit.exactMatchSources,
        es: audit.exactMatchShare,
        top: audit.top.slice(0, MAX_TOP_ANCHORS).map((t) => [t.text, t.sources]),
        g: audit.generic.slice(0, 10).map((t) => [t.text, t.sources]),
        em: audit.emptyAnchors,
        q: audit.queryTerms,
        r: audit.reasons,
      }
    : null;
  return [
    n.key,
    n.url.slice(0, 2048),
    n.pageId,
    n.pageType ?? (spokeType(n) ?? null),
    n.title ? n.title.slice(0, 300) : null,
    n.inSitemap ? 1 : 0,
    s?.statusCode ?? null,
    s?.finalUrl && n.finalKey ? s.finalUrl.slice(0, 2048) : null,
    s?.redirectChain ? s.redirectChain.length : n.finalKey ? 1 : null,
    s?.redirectChain && s.redirectChain.length ? JSON.stringify(s.redirectChain.slice(0, 10)) : null,
    s?.skippedReason ?? null,
    s?.fetchedAt ?? null,
    n.indexable ? 1 : 0,
    n.noindex ? 1 : 0,
    n.canonicalKey && !n.canonicalAssumed ? n.canonicalKey : null,
    n.linksIn,
    n.contentLinksIn,
    n.outAll.length,
    n.outContent.length,
    n.orphan ? 1 : 0,
    n.issue,
    hubSource ? 1 : 0,
    hubSource,
    hubKey,
    spoke?.method ?? null,
    spoke?.similarity ?? null,
    spoke && spoke.hub !== null ? (spoke.hubToSpoke ? 1 : 0) : null,
    spoke && spoke.hub !== null ? (spoke.spokeToHub ? 1 : 0) : null,
    n.gsc ? n.gsc.impressions : null,
    n.gsc ? n.gsc.clicks : null,
    n.gsc ? n.gsc.position : null,
    audit && audit.flags.length ? audit.flags.join(",") : null,
    JSON.stringify(inbound),
    JSON.stringify(outbound),
    anchors ? JSON.stringify(anchors) : "{}",
  ];
}

const URL_COLUMNS = [
  "url_key",
  "url",
  "page_id",
  "page_type",
  "title",
  "in_sitemap",
  "status_code",
  "final_url",
  "redirect_hops",
  "chain_json",
  "skipped_reason",
  "fetched_at",
  "indexable",
  "noindex",
  "canonical_url",
  "links_in",
  "content_links_in",
  "links_out",
  "content_links_out",
  "orphan",
  "issue",
  "is_hub",
  "hub_source",
  "hub_key",
  "hub_method",
  "hub_score",
  "hub_to_spoke",
  "spoke_to_hub",
  "gsc_impressions",
  "gsc_clicks",
  "gsc_position",
  "anchor_flags",
  "inbound_json",
  "outbound_json",
  "anchors_json",
] as const;

export interface BuildOptions {
  trigger: GraphTrigger;
  now: Date;
  crawlRunId?: string | null;
  /** Admit this (still running) crawl's snapshots (the crawl step builds before finalizing). */
  includeCrawlRunId?: string | null;
  userId?: string | null;
  /** Load sentences and generic anchors as well (the suggestion run needs them). */
  text?: boolean;
  /** Throw 409 instead of returning null when another build is in progress. */
  throwOnBusy?: boolean;
}

export interface ComputedGraph {
  graph: LinkGraph;
  clusters: ClusterModel;
  audits: Map<number, AnchorAudit>;
  verifications: VerificationResult[];
  summary: GraphSummaryJson;
  snapshots: SnapshotRecord[];
  gsc: Awaited<ReturnType<typeof loadGscPageData>>;
}

/** Loads the inputs and computes the graph, clusters, anchor audit and verifications in memory (nothing written). */
export async function computeGraph(db: Db, project: ProjectRow, opts: Pick<BuildOptions, "now" | "includeCrawlRunId" | "text">): Promise<ComputedGraph | null> {
  const host = graphHost(project);
  if (!host) return null;
  const scope = { id: project.id, workspaceId: project.workspace_id };
  const inventory = await loadInventory(db, scope);
  const state = await loadInventoryState(db, scope);
  const loaded = await loadLatestSnapshots(db, project, { includeCrawlRunId: opts.includeCrawlRunId ?? null, text: opts.text === true });
  const gsc = await loadGscPageData(db, project);
  const overrides = await loadClusterOverrides(db, project);
  const sheetHubs = await loadSheetHubHints(db, project);
  const homeUrl = `https://${host}/`;
  const graph = buildLinkGraph({ host, homeUrl, inventory, snapshots: loaded.rows, snapshotsTruncated: loaded.truncated, gsc, now: opts.now });
  const aliases = parseJson<unknown[]>(project.brand_aliases_json, []).filter((a): a is string => typeof a === "string");
  const clusters = buildClusters(graph, { overrides, sheetHubs, extraStop: brandStopwords(project.brand_name, aliases) });
  const audits = auditAllAnchors(graph);
  const verifications = verifyExpectedLinks(graph, await loadExpectedLinks(db, project));
  const summary = summarize(graph, clusters, audits, verifications, gsc ? gscSourceLabel(gsc) : null, state, inventory.length);
  return { graph, clusters, audits, verifications, summary, snapshots: loaded.rows, gsc };
}

/** Builds and stores the graph. null = no host (setup required) or another build is in progress. */
export async function buildAndStoreLinkGraph(db: Db, project: ProjectRow, opts: BuildOptions): Promise<GraphBuild | null> {
  if (!graphHost(project)) return null;
  const graphId = await claimBuild(db, project, opts.trigger, opts.crawlRunId ?? null, opts.userId ?? null, opts.now);
  if (!graphId) {
    if (opts.throwOnBusy) throw conflict("The link graph is already being rebuilt for this project. Try again in a few minutes.");
    return null;
  }
  try {
    const computed = (await computeGraph(db, project, opts))!;
    await persistGraph(db, project, graphId, computed, opts.now);
    return { graphId, ...computed };
  } catch (e) {
    await failBuild(db, project, graphId, e, opts.now);
    throw e;
  }
}

/** Stores a graph computed earlier (the crawl step computes before its rules and stores after finalizing). */
export async function storeComputedGraph(db: Db, project: ProjectRow, computed: ComputedGraph, opts: Pick<BuildOptions, "trigger" | "now" | "crawlRunId" | "userId">): Promise<GraphBuild | null> {
  const graphId = await claimBuild(db, project, opts.trigger, opts.crawlRunId ?? null, opts.userId ?? null, opts.now);
  if (!graphId) return null;
  try {
    await persistGraph(db, project, graphId, computed, opts.now);
    return { graphId, ...computed };
  } catch (e) {
    await failBuild(db, project, graphId, e, opts.now);
    throw e;
  }
}

async function persistGraph(db: Db, project: ProjectRow, graphId: string, computed: ComputedGraph, now: Date): Promise<void> {
  const { graph, clusters, audits, verifications, summary } = computed;
  await persistVerifications(db, project, verifications, now);
  const rows = graph.nodes.map((n) => urlRow(graph, n, clusters, audits.get(n.id)));
  await runBatches(
    db,
    jsonEachInsert(
      "link_graph_urls",
      [
        ["graph_id", graphId],
        ["workspace_id", project.workspace_id],
        ["project_id", project.id],
      ],
      URL_COLUMNS,
      rows,
      { maxRows: 250, maxJsonBytes: 250_000 },
    ),
    4,
  );
  await db.run(
    "UPDATE link_graphs SET status = 'ready', summary_json = ?, finished_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?",
    JSON.stringify(summary),
    iso(now),
    graphId,
    project.workspace_id,
    project.id,
  );
  // Retention: keep only this graph and builds still in progress.
  await db.run(
    `DELETE FROM link_graphs WHERE workspace_id = ? AND project_id = ? AND id != ? AND (status != 'building' OR created_at <= ?)`,
    project.workspace_id,
    project.id,
    graphId,
    iso(addSeconds(now, -BUILD_GUARD_SECONDS)),
  );
}

async function failBuild(db: Db, project: ProjectRow, graphId: string, e: unknown, now: Date): Promise<void> {
  await db
    .run(
      "UPDATE link_graphs SET status = 'failed', summary_json = ?, finished_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?",
      JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 200) : "unknown error" }),
      iso(now),
      graphId,
      project.workspace_id,
      project.id,
    )
    .catch(() => undefined);
  await db.run("DELETE FROM link_graph_urls WHERE graph_id = ? AND workspace_id = ? AND project_id = ?", graphId, project.workspace_id, project.id).catch(() => undefined);
}

/** Latest known status per URL key from the graph (for the broken-internal-link rule of a crawl). */
export function knownLinkTargets(graph: LinkGraph, excludeCrawlRunId: string | null): Map<string, { statusCode: number | null; skippedReason: string | null; fetchedAt: string; finalUrl: string | null }> {
  const out = new Map<string, { statusCode: number | null; skippedReason: string | null; fetchedAt: string; finalUrl: string | null }>();
  for (const n of graph.nodes) {
    const s = n.snap;
    if (!s || (excludeCrawlRunId && s.crawlRunId === excludeCrawlRunId)) continue;
    out.set(n.key, { statusCode: s.statusCode, skippedReason: s.skippedReason, fetchedAt: s.fetchedAt, finalUrl: s.finalUrl });
  }
  return out;
}

function summarize(
  graph: LinkGraph,
  clusters: ClusterModel,
  audits: Map<number, AnchorAudit>,
  verifications: readonly VerificationResult[],
  gscLabel: string | null,
  state: InventoryState,
  inventoryUrls: number,
): GraphSummaryJson {
  let orphans = 0;
  let noContent = 0;
  let redirects = 0;
  let clientErrors = 0;
  let serverErrors = 0;
  for (const n of graph.nodes) {
    if (n.orphan) orphans++;
    if (n.inSitemap && n.indexable && n.contentLinksIn === 0 && n.pageType !== "home") noContent++;
    if (n.issue === "redirect" && n.linksIn > 0) redirects++;
    if (n.issue === "client_error" && n.linksIn > 0) clientErrors++;
    if (n.issue === "server_error" && n.linksIn > 0) serverErrors++;
  }
  let linked = 0;
  let partial = 0;
  let unlinked = 0;
  let unassigned = 0;
  for (const s of clusters.spokes.values()) {
    if (s.hub === null) unassigned++;
    else if (s.hubToSpoke && s.spokeToHub) linked++;
    else if (s.hubToSpoke || s.spokeToHub) partial++;
    else unlinked++;
  }
  const v = { verified: 0, not_found: 0, pending: 0, source_unavailable: 0 };
  for (const r of verifications) v[r.status]++;
  const c = graph.coverage;
  const notes: string[] = [
    `Built from the latest snapshot of every crawled page across crawls (${coverageLabel(c)}); snapshots older than ${STALE_DAYS} days are marked stale (${c.stalePages}).`,
  ];
  if (c.neverCrawledSitemap > 0) notes.push(`${c.neverCrawledSitemap.toLocaleString("en-US")} sitemap URLs are not crawled yet; the rolling crawl reaches them in upcoming runs. Orphans and inlink counts cover analysed pages only.`);
  if (c.linkOnlyNodes > 0) notes.push(`${c.linkOnlyNodes.toLocaleString("en-US")} link targets outside the sitemap are queued for the rolling crawl; their status is unknown until crawled (never claimed broken).`);
  if (c.droppedNodes > 0) notes.push(`${c.droppedNodes.toLocaleString("en-US")} further link targets were not added (graph capped at ${graph.nodes.length.toLocaleString("en-US")} URLs).`);
  if (c.snapshotsTruncated) notes.push("More crawled pages exist than the graph loads; the oldest-id pages beyond the cap were left out.");
  if (c.anchorsUnknownPages > 0) notes.push(`${c.anchorsUnknownPages.toLocaleString("en-US")} pages were crawled before anchor text was recorded: their links count, their anchors are unknown until the next crawl.`);
  return {
    coverage: c,
    coverageLabel: coverageLabel(c),
    counts: {
      urls: graph.nodes.length,
      edges: graph.edges,
      contentEdges: graph.contentEdges,
      orphans,
      noContentLinks: noContent,
      redirects,
      clientErrors,
      serverErrors,
      hubs: clusters.hubs.size,
      spokes: clusters.spokes.size,
      linkedSpokes: linked,
      partialSpokes: partial,
      unlinkedSpokes: unlinked,
      unassignedSpokes: unassigned,
      anchorFlagged: [...audits.values()].filter((a) => a.flags.length > 0).length,
      verified: v.verified,
      notFound: v.not_found,
      pending: v.pending,
      sourceUnavailable: v.source_unavailable,
    },
    gscLabel,
    notes,
    rolling: inventoryUrls > 0 ? { inventoryUrls, neverCrawled: graph.nodes.filter((n) => n.inInventory && !n.snap).length, cursorOrd: state.cursorOrd, passes: state.passes, sitemapReadAt: state.sitemapReadAt } : null,
    versions: { graph: GRAPH_VERSION, clusters: CLUSTERS_VERSION, anchors: ANCHOR_AUDIT_VERSION, verify: VERIFY_VERSION },
  };
}

// ------------------------------------------------------------------------------------ overrides (owner edits)

export async function setHubOverride(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, pageUrl: string, isHub: boolean | null, userId: string | null, now: Date): Promise<void> {
  const key = normalizeUrlKey(pageUrl);
  if (isHub === null) {
    await db.run("DELETE FROM link_cluster_overrides WHERE workspace_id = ? AND project_id = ? AND kind = 'hub' AND page_key = ?", project.workspace_id, project.id, key);
    return;
  }
  await upsertOverride(db, project, "hub", key, isHub ? "yes" : "no", userId, now);
}

export async function setSpokeAssignment(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, spokeUrl: string, hubUrl: string | null | undefined, userId: string | null, now: Date): Promise<void> {
  const key = normalizeUrlKey(spokeUrl);
  if (hubUrl === undefined) {
    await db.run("DELETE FROM link_cluster_overrides WHERE workspace_id = ? AND project_id = ? AND kind = 'assign' AND page_key = ?", project.workspace_id, project.id, key);
    return;
  }
  await upsertOverride(db, project, "assign", key, hubUrl === null ? "" : normalizeUrlKey(hubUrl), userId, now);
}

async function upsertOverride(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, kind: "hub" | "assign", key: string, value: string, userId: string | null, now: Date): Promise<void> {
  await db.run(
    `INSERT INTO link_cluster_overrides (id, workspace_id, project_id, kind, page_key, value, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, kind, page_key) DO UPDATE SET value = excluded.value, created_by = excluded.created_by, updated_at = excluded.updated_at
     WHERE link_cluster_overrides.workspace_id = excluded.workspace_id`,
    newId("lco"),
    project.workspace_id,
    project.id,
    kind,
    key,
    value,
    userId,
    iso(now),
    iso(now),
  );
}
