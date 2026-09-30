/**
 * [A22] Coverage views: shared loaders and helpers. Every query filters by workspace_id AND project_id.
 *
 * Data sources (stored data only; nothing here fetches or calls a model):
 *   - latest usable crawl: newest crawl_runs row with status completed|partial, its page_snapshots
 *     (joined to pages) and audit_findings.
 *   - latest usable GSC sync (completed|partial), current window, device IS NULL rows only (device rows
 *     would double count page/query slices).
 * URL matching uses `pageKey`: host without "www." (lowercase), path without trailing slashes, query
 * string without tracking parameters (sorted); protocol and fragment ignored.
 */
import type { CapabilityState, Completeness, PageType, Severity, SiteType } from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { normalizeDomain } from "../geo/detect";
import { completenessNote } from "../seo/crawl/run";
import { getRule, normalizeUrlKey } from "../seo/rules/registry";
import { pageMetrics, parseTotalsJson, toWindowTotals, type SliceRow } from "../seo/gsc/aggregate";
import { normalizeQuery } from "../geo/analyze";

export const COVERAGE_VERSION = "coverage-2026-09-30.1";

export const DEMO_LABEL = "Demo data - simulated run";

// ------------------------------------------------------------------ URL keys
/** Query parameters that only track a visit and never select different content. */
const TRACKING_PARAM = /^(utm_[a-z0-9_]+|srsltid|gclid|gbraid|wbraid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid|dclid)$/i;

/** Parse an http(s) URL, or null. */
export function parseHttpUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

function cleanSearch(u: URL): string {
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
  if (params.length === 0) return "";
  params.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  return `?${new URLSearchParams(params).toString()}`;
}

function cleanPath(u: URL): string {
  const p = u.pathname || "/";
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : p;
}

/** Comparable key for "the same page": www-less host + path + non-tracking query. Null for non-http(s). */
export function pageKey(raw: string | null | undefined): string | null {
  const u = parseHttpUrl(raw);
  if (!u) return null;
  const host = normalizeDomain(u.hostname) ?? u.hostname.toLowerCase();
  return `${host}${cleanPath(u)}${cleanSearch(u)}`;
}

/** Display form of a cited URL: lowercase host, no fragment, no tracking parameters, no trailing slash. */
export function displayUrl(raw: string): string {
  const u = parseHttpUrl(raw);
  if (!u) return raw;
  return `${u.protocol}//${u.host.toLowerCase()}${cleanPath(u)}${cleanSearch(u)}`;
}

export function clip(s: string | null | undefined, max: number): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

/** Run `fn` over id chunks small enough for SQLite/D1 bound-parameter limits. */
export async function inChunks<T>(ids: string[], fn: (chunk: string[], placeholders: string) => Promise<T[]>, size = 90): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    out.push(...(await fn(chunk, chunk.map(() => "?").join(","))));
  }
  return out;
}

// ------------------------------------------------------------------ crawl
export interface CrawlInfo {
  id: string;
  status: "completed" | "partial";
  pagesLimit: number;
  pagesCrawled: number;
  pagesSkipped: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface Snap {
  pageId: string;
  url: string;
  pageType: PageType;
  statusCode: number | null;
  finalUrl: string | null;
  skippedReason: string | null;
  title: string | null;
  h1s: string[];
  headings: Array<{ level: number; text: string }>;
  jsonldTypes: string[];
  jsonldIssues: Array<{ type: string; issue: string; detail?: string }>;
  wordCount: number | null;
  outboundCitations: number | null;
  tableCount: number | null;
  lastUpdated: string | null;
  fetchedAt: string;
}

export interface FindingLite {
  id: string;
  ruleId: string;
  severity: Severity;
  cls: "fact" | "heuristic";
  url: string | null;
  detail: string;
}

export interface CrawlData {
  crawl: CrawlInfo;
  snaps: Snap[];
  findings: FindingLite[];
  /** Set when a newer crawl exists that is still running or failed (older data is shown). */
  newerCrawl: "running" | "failed" | null;
}

/** Why no crawl data is available (used for the honest state). */
export type CrawlAbsence = "unverified" | "no_crawl" | "running" | "failed";

export async function loadLatestCrawl(db: Db, project: ProjectRow): Promise<CrawlData | CrawlAbsence> {
  const ws = project.workspace_id;
  const pid = project.id;
  if (!project.verified_host && !project.is_demo) return "unverified";
  const row = await db.first<{
    id: string;
    status: "completed" | "partial";
    pages_limit: number;
    pages_crawled: number;
    pages_skipped: number;
    started_at: string;
    finished_at: string | null;
  }>(
    `SELECT id, status, pages_limit, pages_crawled, pages_skipped, started_at, finished_at FROM crawl_runs
      WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial')
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ws,
    pid,
  );
  if (!row) {
    const any = await db.first<{ status: string }>(
      "SELECT status FROM crawl_runs WHERE workspace_id = ? AND project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
      ws,
      pid,
    );
    return any?.status === "running" ? "running" : any?.status === "failed" ? "failed" : "no_crawl";
  }
  const snapRows = await db.all<{
    page_id: string;
    url: string;
    page_type: PageType;
    status_code: number | null;
    final_url: string | null;
    skipped_reason: string | null;
    title: string | null;
    h1_json: string;
    headings_json: string;
    jsonld_types_json: string;
    jsonld_issues_json: string;
    word_count: number | null;
    outbound_citations: number | null;
    table_count: number | null;
    last_updated: string | null;
    fetched_at: string;
  }>(
    `SELECT s.page_id, p.url, p.page_type, s.status_code, s.final_url, s.skipped_reason, s.title, s.h1_json, s.headings_json,
            s.jsonld_types_json, s.jsonld_issues_json, s.word_count, s.outbound_citations, s.table_count, s.last_updated, s.fetched_at
       FROM page_snapshots s JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id AND p.project_id = s.project_id
      WHERE s.workspace_id = ? AND s.project_id = ? AND s.crawl_run_id = ?
      ORDER BY p.url, s.fetched_at DESC, s.rowid DESC`,
    ws,
    pid,
    row.id,
  );
  const seen = new Set<string>();
  const snaps: Snap[] = [];
  for (const r of snapRows) {
    if (seen.has(r.page_id)) continue; // one snapshot per page per crawl (newest)
    seen.add(r.page_id);
    snaps.push({
      pageId: r.page_id,
      url: r.url,
      pageType: r.page_type,
      statusCode: r.status_code,
      finalUrl: r.final_url,
      skippedReason: r.skipped_reason,
      title: r.title,
      h1s: parseJson<unknown[]>(r.h1_json, []).filter((h): h is string => typeof h === "string"),
      headings: parseJson<unknown[]>(r.headings_json, []).filter(
        (h): h is { level: number; text: string } => !!h && typeof h === "object" && typeof (h as { level?: unknown }).level === "number",
      ),
      jsonldTypes: uniq(parseJson<unknown[]>(r.jsonld_types_json, []).filter((t): t is string => typeof t === "string")),
      jsonldIssues: parseJson<unknown[]>(r.jsonld_issues_json, []).filter(
        (i): i is { type: string; issue: string; detail?: string } => !!i && typeof i === "object" && typeof (i as { issue?: unknown }).issue === "string",
      ),
      wordCount: r.word_count,
      outboundCitations: r.outbound_citations,
      tableCount: r.table_count,
      lastUpdated: r.last_updated,
      fetchedAt: r.fetched_at,
    });
  }
  const newest = await db.first<{ id: string; status: string }>(
    "SELECT id, status FROM crawl_runs WHERE workspace_id = ? AND project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
    ws,
    pid,
  );
  const newerCrawl = newest && newest.id !== row.id && (newest.status === "running" || newest.status === "failed") ? newest.status : null;
  const findingRows = await db.all<{ id: string; rule_id: string; severity: Severity; url: string | null; detail: string }>(
    "SELECT id, rule_id, severity, url, detail FROM audit_findings WHERE workspace_id = ? AND project_id = ? AND crawl_run_id = ? ORDER BY rowid",
    ws,
    pid,
    row.id,
  );
  return {
    crawl: {
      id: row.id,
      status: row.status,
      pagesLimit: row.pages_limit,
      pagesCrawled: row.pages_crawled,
      pagesSkipped: row.pages_skipped,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    },
    snaps,
    newerCrawl,
    findings: findingRows.map((f) => ({
      id: f.id,
      ruleId: f.rule_id,
      severity: f.severity,
      cls: getRule(f.rule_id)?.class ?? "heuristic",
      url: f.url,
      detail: f.detail,
    })),
  };
}

/** Same definition as the rule registry: 2xx, not skipped, not redirected. */
export function isAnalyzable(s: Pick<Snap, "statusCode" | "skippedReason" | "finalUrl" | "url">): boolean {
  const ok = s.statusCode !== null && s.statusCode >= 200 && s.statusCode < 300 && !s.skippedReason;
  const redirected = !!s.finalUrl && normalizeUrlKey(s.finalUrl) !== normalizeUrlKey(s.url);
  return ok && !redirected;
}

/** Why a snapshot was not analysed, as plain text. */
export function unanalyzedReason(s: Snap): string {
  if (s.skippedReason) return `Skipped: ${s.skippedReason}.`;
  if (s.statusCode === null) return "No HTTP response recorded; not analysed.";
  if (s.statusCode < 200 || s.statusCode >= 300) return `HTTP ${s.statusCode}; not analysed.`;
  return `Redirects to ${s.finalUrl}; not analysed.`;
}

export function crawlCompleteness(d: CrawlData): Completeness {
  const byReason: Record<string, number> = {};
  for (const s of d.snaps) if (s.skippedReason) byReason[s.skippedReason] = (byReason[s.skippedReason] ?? 0) + 1;
  const crawled = d.snaps.filter((s) => !s.skippedReason).length;
  return { note: completenessNote(crawled, byReason, d.crawl.pagesLimit, false), covered: crawled, total: d.snaps.length };
}

export function crawlLabel(d: CrawlData): string {
  const when = d.crawl.finishedAt ?? d.crawl.startedAt;
  const newer =
    d.newerCrawl === "running" ? " A newer crawl is in progress." : d.newerCrawl === "failed" ? " A newer crawl failed; this is the latest completed one." : "";
  return `From the latest ${d.crawl.status === "partial" ? "partial " : ""}completed crawl (${when.slice(0, 10)}); only server-delivered HTML of your verified site is analysed.${newer}`;
}

/** State + note when crawl data is absent. Demo projects stay 'demo'. */
export function crawlAbsenceState(project: ProjectRow, why: CrawlAbsence): { state: CapabilityState; note: string } {
  const note =
    why === "unverified"
      ? "Verify site ownership (Search Console, DNS, or file) before crawling. No page data exists for unverified sites."
      : why === "running"
        ? "A crawl is in progress; no completed crawl to show yet."
        : why === "failed"
          ? "The latest crawl failed and there is no completed crawl to show."
          : "No crawl has completed yet.";
  if (project.is_demo) return { state: "demo", note };
  return { state: why === "failed" ? "error" : "setup_required", note };
}

// ------------------------------------------------------------------ GSC
export interface GscPageData {
  window: { start: string; end: string };
  source: string;
  truncated: boolean;
  totals: { impressions: number; clicks: number } | null;
  /** pageKey -> current-window metrics */
  pages: Map<string, { impressions: number; clicks: number; basis: "page_rows" | "query_page_rows" }>;
  /** normalized query -> pageKey -> {url, impressions, clicks} (query x page rows, current window) */
  queryPages: Map<string, Map<string, { url: string; impressions: number; clicks: number }>>;
}

export interface GscSyncRow {
  id: string;
  source: string;
  window_start: string;
  window_end: string;
  truncated: number;
  totals_json: string;
}

export async function latestGscSync(db: Db, ws: string, pid: string): Promise<GscSyncRow | null> {
  return db.first<GscSyncRow>(
    `SELECT id, source, window_start, window_end, truncated, totals_json FROM gsc_syncs
      WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial') ORDER BY synced_at DESC LIMIT 1`,
    ws,
    pid,
  );
}

export function isSiteType(v: string): v is SiteType {
  return v === "ecommerce" || v === "saas" || v === "publisher" || v === "local" || v === "other";
}

/**
 * Current-window GSC data of the latest usable sync. Per-page metrics prefer page-dimension rows and
 * fall back to query x page rows (a lower bound: anonymized queries are omitted); see seo/gsc/aggregate.
 */
export async function loadGscPageData(db: Db, ws: string, pid: string): Promise<GscPageData | null> {
  const sync = await latestGscSync(db, ws, pid);
  if (!sync) return null;
  const rows = await db.all<SliceRow>(
    `SELECT window, query, page, clicks, impressions, ctr, position FROM gsc_metrics
      WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'current' AND device IS NULL AND page IS NOT NULL`,
    ws,
    pid,
    sync.id,
  );
  const pages = new Map<string, { impressions: number; clicks: number; basis: "page_rows" | "query_page_rows" }>();
  for (const [k, m] of pageMetrics(rows, "current", (u) => pageKey(u) ?? u)) {
    pages.set(k, { impressions: m.impressions, clicks: m.clicks, basis: m.basis === "page_rows" ? "page_rows" : "query_page_rows" });
  }
  const queryPages = new Map<string, Map<string, { url: string; impressions: number; clicks: number }>>();
  for (const r of rows) {
    if (!r.query || !r.page) continue;
    const q = normalizeQuery(r.query);
    const k = pageKey(r.page);
    if (!q || !k) continue;
    if (!queryPages.has(q)) queryPages.set(q, new Map());
    const byPage = queryPages.get(q)!;
    const cur = byPage.get(k) ?? { url: r.page, impressions: 0, clicks: 0 };
    cur.impressions += r.impressions;
    cur.clicks += r.clicks;
    byPage.set(k, cur);
  }
  const t = toWindowTotals(parseTotalsJson(sync.totals_json).current);
  return {
    window: { start: sync.window_start, end: sync.window_end },
    source: sync.source,
    truncated: sync.truncated === 1,
    totals: t ? { impressions: t.impressions, clicks: t.clicks } : null,
    pages,
    queryPages,
  };
}
