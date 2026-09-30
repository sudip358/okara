/**
 * [A21] Checklist data snapshot: everything the checklist items evaluate, loaded once per request with
 * every query scoped by workspace_id AND project_id. Items are pure functions over this object, so they
 * are testable without HTTP and never call external services (no crawling, no SERP scraping).
 */
import type { AiCrawlerAccess, CapabilityState, Competitor, PageType, SiteType } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { listProviderStatuses } from "../routes/credentials";

/** Upper bounds on rows read per request (checklists summarize; they never page through history). */
export const LOAD_LIMITS = { gscRows: 20_000, observations: 2_000, citations: 10_000, displacements: 5_000, searchQueries: 5_000, decisions: 1_000 } as const;

export interface Snap {
  pageId: string;
  url: string;
  pageType: PageType;
  statusCode: number | null;
  finalUrl: string | null;
  skippedReason: string | null;
  title: string | null;
  metaDescription: string | null;
  h1s: string[];
  headings: Array<{ level: number; text: string }>;
  canonical: string | null;
  robotsMeta: string | null;
  jsonLdTypes: string[];
  jsonLdIssues: Array<{ type: string; issue: string }>;
  internalLinks: string[];
  wordCount: number | null;
  firstParagraph: string | null;
  excerpt: string | null;
  author: string | null;
  lastUpdated: string | null;
  outboundCitations: number | null;
  tableCount: number | null;
  /** null = not extracted (snapshot older than the [A21] extraction fields, or a skipped/error page). */
  imagesTotal: number | null;
  imagesMissingAlt: number | null;
  viewport: string | null;
  breadcrumbNav: boolean | null;
  genericAnchors: Array<{ href: string; text: string }> | null;
  crawlRunId: string;
  fetchedAt: string;
}

export interface Finding {
  ruleId: string;
  url: string | null;
  detail: string;
  severity: string;
}

export interface RobotsInfo {
  /** Whether robots/sitemap details were recorded for this crawl (seeded demo crawls may lack them). */
  recorded: boolean;
  status: string | null;
  sitemapsAdvertised: string[];
  sitemapsFetched: string[];
  sitemapUrlCount: number | null;
  access: AiCrawlerAccess | null;
}

export interface CrawlInfo {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  pagesLimit: number;
  pagesCrawled: number;
  pagesSkipped: number;
  notes: string[];
  robots: RobotsInfo;
}

export interface GscRow {
  window: "current" | "previous";
  query: string | null;
  page: string | null;
  device: string | null;
  clicks: number;
  impressions: number;
  position: number;
}

export interface GscInfo {
  connection: "connected" | "error" | "revoked" | null;
  sync: {
    id: string;
    source: "api" | "csv_import" | "demo";
    syncedAt: string;
    windowStart: string;
    windowEnd: string;
    prevStart: string;
    prevEnd: string;
    truncated: boolean;
    rowsFetched: number;
  } | null;
  rows: GscRow[];
}

export interface GeoObservation {
  id: string;
  provider: string;
  measurementType: "api" | "manual_import";
  status: string;
  grounded: boolean;
  importedSurface: string | null;
  createdAt: string;
}

export interface GeoCitation {
  observationId: string;
  url: string;
  host: string;
  title: string | null;
  sourceType: string;
  brandKey: string | null;
}

export interface GeoInfo {
  promptSet: { version: number; approved: number; total: number } | null;
  promptsPerRun: number | null;
  observations: GeoObservation[];
  citations: GeoCitation[];
  brandObs: Array<{ observationId: string; brandKey: string; isSelf: boolean; mentioned: boolean; cited: boolean }>;
  displacements: Array<{ observationId: string; entity: string; url: string | null; sourceType: string }>;
  searchQueries: string[];
  providers: Array<{ provider: string; label: string; state: CapabilityState }>;
}

export interface DecisionInfo {
  questionId: string;
  /** The answer object ({type, choice|noul|score, confidence?, probabilities?}) when recorded. */
  answer: Record<string, unknown> | null;
  /** Candidate key recorded with the answer (e.g. "weak_ctr:https://host/path"). */
  candidate: string | null;
  tier: string | null;
  outcome: string;
  reasonCode: string | null;
  createdAt: string;
}

export interface ChecklistData {
  now: Date;
  project: {
    id: string;
    workspaceId: string;
    siteType: SiteType;
    isDemo: boolean;
    brandName: string;
    siteUrl: string;
    verifiedHost: string | null;
    gscProperty: string | null;
    competitors: Competitor[];
  };
  crawl: CrawlInfo | null;
  snapshots: Snap[];
  findings: Finding[];
  gsc: GscInfo;
  geo: GeoInfo;
  decisions: DecisionInfo[];
  pillars: { version: number; content: string; factCount: number } | null;
}

export interface SnapshotRow {
  page_id: string;
  url: string;
  page_type: PageType;
  crawl_run_id: string;
  status_code: number | null;
  final_url: string | null;
  skipped_reason: string | null;
  title: string | null;
  meta_description: string | null;
  h1_json: string;
  headings_json: string;
  canonical: string | null;
  robots_meta: string | null;
  jsonld_types_json: string;
  jsonld_issues_json: string;
  internal_links_json: string;
  word_count: number | null;
  first_paragraph: string | null;
  main_text_excerpt: string | null;
  author: string | null;
  last_updated: string | null;
  outbound_citations: number | null;
  table_count: number | null;
  images_total: number | null;
  images_missing_alt: number | null;
  viewport_meta: string | null;
  breadcrumb_nav: number | null;
  generic_anchors_json: string | null;
  fetched_at: string;
}

export const SNAPSHOT_COLUMNS = `p.id AS page_id, p.url, p.page_type, s.crawl_run_id, s.status_code, s.final_url, s.skipped_reason, s.title,
  s.meta_description, s.h1_json, s.headings_json, s.canonical, s.robots_meta, s.jsonld_types_json, s.jsonld_issues_json,
  s.internal_links_json, s.word_count, s.first_paragraph, s.main_text_excerpt, s.author, s.last_updated, s.outbound_citations,
  s.table_count, s.images_total, s.images_missing_alt, s.viewport_meta, s.breadcrumb_nav, s.generic_anchors_json, s.fetched_at`;

export function toSnap(r: SnapshotRow): Snap {
  return {
    pageId: r.page_id,
    url: r.url,
    pageType: r.page_type,
    statusCode: r.status_code,
    finalUrl: r.final_url,
    skippedReason: r.skipped_reason,
    title: r.title,
    metaDescription: r.meta_description,
    h1s: parseJson<string[]>(r.h1_json, []),
    headings: parseJson<Array<{ level: number; text: string }>>(r.headings_json, []),
    canonical: r.canonical,
    robotsMeta: r.robots_meta,
    jsonLdTypes: parseJson<string[]>(r.jsonld_types_json, []),
    jsonLdIssues: parseJson<Array<{ type: string; issue: string }>>(r.jsonld_issues_json, []),
    internalLinks: parseJson<string[]>(r.internal_links_json, []),
    wordCount: r.word_count,
    firstParagraph: r.first_paragraph,
    excerpt: r.main_text_excerpt,
    author: r.author,
    lastUpdated: r.last_updated,
    outboundCitations: r.outbound_citations,
    tableCount: r.table_count,
    imagesTotal: r.images_total,
    imagesMissingAlt: r.images_missing_alt,
    viewport: r.viewport_meta,
    breadcrumbNav: r.breadcrumb_nav === null ? null : r.breadcrumb_nav === 1,
    genericAnchors: r.generic_anchors_json === null ? null : parseJson<Array<{ href: string; text: string }>>(r.generic_anchors_json, []),
    crawlRunId: r.crawl_run_id,
    fetchedAt: r.fetched_at,
  };
}

/**
 * robots_json is written by the crawler as { robots, sitemap, aiCrawlerAccess, rulesetVersion }; seeded
 * demo crawls store the AiCrawlerAccess object directly. Both shapes are accepted.
 */
export function parseRobotsJson(raw: string | null): RobotsInfo {
  const json = parseJson<Record<string, unknown> | null>(raw, null);
  const empty: RobotsInfo = { recorded: false, status: null, sitemapsAdvertised: [], sitemapsFetched: [], sitemapUrlCount: null, access: null };
  if (!json || typeof json !== "object") return empty;
  const isAccess = (v: unknown): v is AiCrawlerAccess => !!v && typeof v === "object" && Array.isArray((v as { crawlers?: unknown }).crawlers);
  const access = isAccess(json.aiCrawlerAccess) ? json.aiCrawlerAccess : isAccess(json) ? (json as unknown as AiCrawlerAccess) : null;
  const robots = json.robots && typeof json.robots === "object" ? (json.robots as Record<string, unknown>) : null;
  const sitemap = json.sitemap && typeof json.sitemap === "object" ? (json.sitemap as Record<string, unknown>) : null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    recorded: !!robots || !!sitemap,
    status: robots && typeof robots.status === "string" ? robots.status : null,
    sitemapsAdvertised: strings(robots?.sitemaps),
    sitemapsFetched: strings(sitemap?.fetched),
    sitemapUrlCount: sitemap && typeof sitemap.urlCount === "number" ? sitemap.urlCount : null,
    access,
  };
}

const bool = (v: unknown) => v === 1 || v === true;

/** The latest completed/partial crawl (or a specific one by id) with its snapshots and findings. */
export async function loadCrawl(db: Db, ws: string, pid: string, crawlRunId?: string): Promise<{ crawl: CrawlInfo | null; snapshots: Snap[]; findings: Finding[] }> {
  const run = await db.first<{
    id: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    pages_limit: number;
    pages_crawled: number;
    pages_skipped: number;
    robots_json: string | null;
    notes_json: string;
  }>(
    `SELECT id, status, started_at, finished_at, pages_limit, pages_crawled, pages_skipped, robots_json, notes_json
       FROM crawl_runs WHERE workspace_id = ? AND project_id = ? AND ${crawlRunId ? "id = ?" : "status IN ('completed', 'partial')"}
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ...(crawlRunId ? [ws, pid, crawlRunId] : [ws, pid]),
  );
  if (!run) return { crawl: null, snapshots: [], findings: [] };
  const rows = await db.all<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS}
       FROM page_snapshots s JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.project_id = ? AND s.crawl_run_id = ?
      ORDER BY s.fetched_at, s.rowid`,
    ws,
    pid,
    run.id,
  );
  const findings = await db.all<{ rule_id: string; url: string | null; detail: string; severity: string }>(
    "SELECT rule_id, url, detail, severity FROM audit_findings WHERE workspace_id = ? AND project_id = ? AND crawl_run_id = ?",
    ws,
    pid,
    run.id,
  );
  return {
    crawl: {
      id: run.id,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      pagesLimit: run.pages_limit,
      pagesCrawled: run.pages_crawled,
      pagesSkipped: run.pages_skipped,
      notes: parseJson<string[]>(run.notes_json, []),
      robots: parseRobotsJson(run.robots_json),
    },
    snapshots: rows.map(toSnap),
    findings: findings.map((f) => ({ ruleId: f.rule_id, url: f.url, detail: f.detail, severity: f.severity })),
  };
}

export async function loadGsc(db: Db, ws: string, pid: string): Promise<GscInfo> {
  const conn = await db.first<{ status: "connected" | "error" | "revoked" }>(
    "SELECT status FROM oauth_connections WHERE workspace_id = ? AND project_id = ? AND provider = 'google_gsc'",
    ws,
    pid,
  );
  const sync = await db.first<{
    id: string;
    source: "api" | "csv_import" | "demo";
    synced_at: string;
    window_start: string;
    window_end: string;
    prev_window_start: string;
    prev_window_end: string;
    truncated: number;
    rows_fetched: number;
  }>(
    `SELECT id, source, synced_at, window_start, window_end, prev_window_start, prev_window_end, truncated, rows_fetched
       FROM gsc_syncs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial')
      ORDER BY synced_at DESC, rowid DESC LIMIT 1`,
    ws,
    pid,
  );
  const rows = sync
    ? (
        await db.all<Omit<GscRow, "window"> & { win: "current" | "previous" }>(
          `SELECT "window" AS win, query, page, device, clicks, impressions, position FROM gsc_metrics
            WHERE workspace_id = ? AND project_id = ? AND sync_id = ? LIMIT ${LOAD_LIMITS.gscRows}`,
          ws,
          pid,
          sync.id,
        )
      ).map(({ win, ...r }) => ({ ...r, window: win }))
    : [];
  return {
    connection: conn?.status ?? null,
    sync: sync
      ? {
          id: sync.id,
          source: sync.source,
          syncedAt: sync.synced_at,
          windowStart: sync.window_start,
          windowEnd: sync.window_end,
          prevStart: sync.prev_window_start,
          prevEnd: sync.prev_window_end,
          truncated: sync.truncated === 1,
          rowsFetched: sync.rows_fetched,
        }
      : null,
    rows,
  };
}

export async function loadGeo(env: Env, db: Db, ws: string, pid: string): Promise<GeoInfo> {
  const set = await db.first<{ id: string; version: number }>(
    "SELECT id, version FROM geo_prompt_sets WHERE workspace_id = ? AND project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1",
    ws,
    pid,
  );
  let promptSet: GeoInfo["promptSet"] = null;
  if (set) {
    const c = await db.first<{ total: number; approved: number | null }>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) AS approved FROM geo_prompts WHERE workspace_id = ? AND project_id = ? AND prompt_set_id = ?",
      ws,
      pid,
      set.id,
    );
    promptSet = { version: set.version, total: Number(c?.total ?? 0), approved: Number(c?.approved ?? 0) };
  }
  const limits = await db.first<{ geo_prompts_per_run: number }>("SELECT geo_prompts_per_run FROM project_limits WHERE workspace_id = ? AND project_id = ?", ws, pid);
  const obsRows = await db.all<{ id: string; provider: string; measurement_type: "api" | "manual_import"; status: string; grounded: number; imported_surface: string | null; created_at: string }>(
    `SELECT id, provider, measurement_type, status, grounded, imported_surface, created_at FROM geo_observations
      WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ${LOAD_LIMITS.observations}`,
    ws,
    pid,
  );
  const ids = new Set(obsRows.map((o) => o.id));
  const citations = (
    await db.all<{ observation_id: string; url: string; host: string; title: string | null; source_type: string; brand_key: string | null }>(
      `SELECT observation_id, url, host, title, source_type, brand_key FROM geo_citations
        WHERE workspace_id = ? AND project_id = ? LIMIT ${LOAD_LIMITS.citations}`,
      ws,
      pid,
    )
  ).filter((c) => ids.has(c.observation_id));
  const brandObs = (
    await db.all<{ observation_id: string; brand_key: string; is_self: number; mentioned: number; cited: number }>(
      "SELECT observation_id, brand_key, is_self, mentioned, cited FROM geo_brand_observations WHERE workspace_id = ? AND project_id = ?",
      ws,
      pid,
    )
  ).filter((b) => ids.has(b.observation_id));
  const displacements = (
    await db.all<{ observation_id: string; entity: string; url: string | null; source_type: string }>(
      `SELECT observation_id, entity, url, source_type FROM geo_displacements WHERE workspace_id = ? AND project_id = ? LIMIT ${LOAD_LIMITS.displacements}`,
      ws,
      pid,
    )
  ).filter((d) => ids.has(d.observation_id));
  const queries = await db.all<{ normalized: string }>(
    `SELECT q.normalized FROM geo_search_queries q JOIN geo_observations o ON o.id = q.observation_id AND o.workspace_id = q.workspace_id
      WHERE q.workspace_id = ? AND q.project_id = ? AND o.measurement_type = 'api' LIMIT ${LOAD_LIMITS.searchQueries}`,
    ws,
    pid,
  );
  const providers = (await listProviderStatuses(env, db, ws))
    .filter((p) => p.provider === "gemini" || p.provider === "perplexity")
    .map((p) => ({ provider: p.provider, label: p.label, state: p.state }));
  return {
    promptSet,
    promptsPerRun: limits ? Number(limits.geo_prompts_per_run) : null,
    observations: obsRows.map((o) => ({
      id: o.id,
      provider: o.provider,
      measurementType: o.measurement_type,
      status: o.status,
      grounded: bool(o.grounded),
      importedSurface: o.imported_surface,
      createdAt: o.created_at,
    })),
    citations: citations.map((c) => ({ observationId: c.observation_id, url: c.url, host: c.host, title: c.title, sourceType: c.source_type, brandKey: c.brand_key })),
    brandObs: brandObs.map((b) => ({ observationId: b.observation_id, brandKey: b.brand_key, isSelf: bool(b.is_self), mentioned: bool(b.mentioned), cited: bool(b.cited) })),
    displacements: displacements.map((d) => ({ observationId: d.observation_id, entity: d.entity, url: d.url, sourceType: d.source_type })),
    searchQueries: queries.map((q) => q.normalized),
    providers,
  };
}

export async function loadDecisions(db: Db, ws: string, pid: string): Promise<DecisionInfo[]> {
  const rows = await db.all<{ question_id: string; answer_json: string | null; tier: string | null; outcome: string; reason_code: string | null; created_at: string }>(
    `SELECT question_id, answer_json, tier, outcome, reason_code, created_at FROM decision_records
      WHERE workspace_id = ? AND project_id = ? AND agent = 'seo' AND question_id IN ('seo.page_overlap', 'seo.intent_page_fit')
      ORDER BY created_at DESC, rowid DESC LIMIT ${LOAD_LIMITS.decisions}`,
    ws,
    pid,
  );
  return rows.map((r) => {
    const raw = parseJson<Record<string, unknown> | null>(r.answer_json, null);
    // Runtime rows store {answer, candidate, questionTier}; older/demo rows store the answer object itself.
    const inner = raw && typeof raw.answer === "object" && raw.answer !== null ? (raw.answer as Record<string, unknown>) : raw && typeof raw.type === "string" ? raw : null;
    return {
      questionId: r.question_id,
      answer: inner,
      candidate: raw && typeof raw.candidate === "string" ? raw.candidate : null,
      tier: r.tier,
      outcome: r.outcome,
      reasonCode: r.reason_code,
      createdAt: r.created_at,
    };
  });
}

export async function loadPillars(db: Db, ws: string, pid: string): Promise<ChecklistData["pillars"]> {
  const doc = await db.first<{ version: number; content: string; facts_json: string }>(
    "SELECT version, content, facts_json FROM context_documents WHERE workspace_id = ? AND project_id = ? AND kind = 'pillars' ORDER BY version DESC LIMIT 1",
    ws,
    pid,
  );
  if (!doc) return null;
  return { version: doc.version, content: doc.content.slice(0, 600), factCount: parseJson<unknown[]>(doc.facts_json, []).length };
}

export function projectInfo(p: ProjectRow): ChecklistData["project"] {
  return {
    id: p.id,
    workspaceId: p.workspace_id,
    siteType: p.site_type as SiteType,
    isDemo: p.is_demo === 1,
    brandName: p.brand_name,
    siteUrl: p.site_url,
    verifiedHost: p.verified_host,
    gscProperty: p.gsc_property,
    competitors: parseJson<Competitor[]>(p.competitors_json, []),
  };
}

/** Load the full project snapshot used by the SEO and GEO checklists. */
/**
 * Crawl data counts only for verified sites (or seeded demo projects), matching the SEO audit: an
 * unverified site never produces live crawl-based results.
 */
export const crawlAllowed = (p: ProjectRow) => !!p.verified_host || p.is_demo === 1;

export async function loadChecklistData(env: Env, db: Db, project: ProjectRow, now: Date): Promise<ChecklistData> {
  const ws = project.workspace_id;
  const pid = project.id;
  const noCrawl = { crawl: null, snapshots: [], findings: [] };
  const [crawl, gsc, geo, decisions, pillars] = await Promise.all([
    crawlAllowed(project) ? loadCrawl(db, ws, pid) : Promise.resolve(noCrawl),
    loadGsc(db, ws, pid),
    loadGeo(env, db, ws, pid),
    loadDecisions(db, ws, pid),
    loadPillars(db, ws, pid),
  ]);
  return { now, project: projectInfo(project), crawl: crawl.crawl, snapshots: crawl.snapshots, findings: crawl.findings, gsc, geo, decisions, pillars };
}

export const EMPTY_GEO: GeoInfo = { promptSet: null, promptsPerRun: null, observations: [], citations: [], brandObs: [], displacements: [], searchQueries: [], providers: [] };
