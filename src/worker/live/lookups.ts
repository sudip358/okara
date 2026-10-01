/**
 * Batched lookups for the live feeds (docs/api.md "Live view"). Only the rows of ONE response page are
 * enriched, so each lookup binds at most the page's distinct URLs / ids / queries, chunked by `inChunks`
 * (90 values) so every statement stays under D1's 100 bound parameters. Every query filters workspace_id
 * AND project_id and has a LIMIT. Stored values are returned as clipped plain text; nothing is fetched.
 */
import type { DateWindow, LiveGscMetrics, PageType } from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { clip, inChunks, pageKey, parseHttpUrl, uniq } from "../coverage/common";
import { latestUsableSync } from "../seo/gsc/overview";
import { normalizeDemandQuery } from "../seo/gsc/demand";

const CHUNK = 90;

// ------------------------------------------------------------------ URLs

/** Display path of a URL (path + non-fragment query), plain text; the raw value when not http(s). */
export function pathLabel(raw: string): string {
  const u = parseHttpUrl(raw);
  if (!u) return clip(raw, 160);
  return clip(`${u.pathname || "/"}${u.search}`, 160);
}

/**
 * Spellings under which the same page may be stored (pages.url, gsc_metrics.page): the value itself, the
 * https and stored protocol, with and without "www.", with and without a trailing slash. Matching back is
 * by `pageKey`, so a variant never maps to a different page.
 */
export function urlVariants(raw: string): string[] {
  const out = new Set<string>([raw]);
  const u = parseHttpUrl(raw);
  if (!u) return [...out];
  const h = u.hostname.toLowerCase();
  const alt = h.startsWith("www.") ? h.slice(4) : `www.${h}`;
  const port = u.port ? `:${u.port}` : "";
  const path = u.pathname || "/";
  const bare = path.replace(/\/+$/, "");
  const paths = bare === "" ? ["/", ""] : [bare, `${bare}/`];
  for (const proto of uniq([u.protocol, "https:"])) {
    for (const host of [h, alt]) for (const p of paths) out.add(`${proto}//${host}${port}${p}${u.search}`);
  }
  return [...out];
}

// ------------------------------------------------------------------ pages and snapshots

export interface PageLite {
  id: string;
  url: string;
  pageType: PageType;
}

/** pages rows for the given URLs, keyed by `pageKey`. */
export async function loadPagesByUrl(db: Db, ws: string, pid: string, urls: string[]): Promise<Map<string, PageLite>> {
  const out = new Map<string, PageLite>();
  const variants = uniq(urls.flatMap(urlVariants));
  if (variants.length === 0) return out;
  const rows = await inChunks(
    variants,
    (chunk, ph) =>
      db.all<{ id: string; url: string; page_type: PageType }>(
        `SELECT id, url, page_type FROM pages WHERE workspace_id = ? AND project_id = ? AND url IN (${ph}) LIMIT ${chunk.length}`,
        ws,
        pid,
        ...chunk,
      ),
    CHUNK,
  );
  for (const r of rows) {
    const k = pageKey(r.url);
    if (k && !out.has(k)) out.set(k, { id: r.id, url: r.url, pageType: r.page_type });
  }
  return out;
}

export interface SnapshotLite {
  pageId: string;
  crawlRunId: string;
  statusCode: number | null;
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  headings: string[];
  canonical: string | null;
  robotsMeta: string | null;
  jsonldTypes: string[];
  wordCount: number | null;
  firstParagraph: string | null;
  lastUpdated: string | null;
  fetchedAt: string;
}

/**
 * One snapshot per page: the page's snapshot from `preferCrawlId` (the run's crawl) when it has one, else its
 * latest snapshot. Skipped reads (no extracted values) are ignored.
 */
export async function loadSnapshots(db: Db, ws: string, pid: string, pageIds: string[], preferCrawlId: string | null): Promise<Map<string, SnapshotLite>> {
  const out = new Map<string, SnapshotLite>();
  const ids = uniq(pageIds);
  if (ids.length === 0) return out;
  const rows = await inChunks(
    ids,
    (chunk, ph) =>
      db.all<{
        page_id: string;
        crawl_run_id: string;
        status_code: number | null;
        title: string | null;
        meta_description: string | null;
        h1_json: string;
        headings_json: string;
        canonical: string | null;
        robots_meta: string | null;
        jsonld_types_json: string;
        word_count: number | null;
        first_paragraph: string | null;
        last_updated: string | null;
        fetched_at: string;
      }>(
        `SELECT page_id, crawl_run_id, status_code, title, meta_description, h1_json, headings_json, canonical, robots_meta,
                jsonld_types_json, word_count, first_paragraph, last_updated, fetched_at
           FROM (SELECT s.page_id, s.crawl_run_id, s.status_code, s.title, s.meta_description, s.h1_json, s.headings_json, s.canonical,
                        s.robots_meta, s.jsonld_types_json, s.word_count, s.first_paragraph, s.last_updated, s.fetched_at,
                        ROW_NUMBER() OVER (PARTITION BY s.page_id
                                           ORDER BY CASE WHEN s.crawl_run_id = ? THEN 0 ELSE 1 END, s.fetched_at DESC, s.rowid DESC) AS rn
                   FROM page_snapshots s
                  WHERE s.workspace_id = ? AND s.project_id = ? AND s.skipped_reason IS NULL AND s.page_id IN (${ph}))
          WHERE rn = 1 LIMIT ${chunk.length}`,
        preferCrawlId ?? "",
        ws,
        pid,
        ...chunk,
      ),
    CHUNK - 3,
  );
  for (const r of rows) {
    const headings = parseJson<unknown[]>(r.headings_json, [])
      .map((h) => (h && typeof h === "object" && typeof (h as { text?: unknown }).text === "string" ? (h as { text: string }).text : null))
      .filter((t): t is string => !!t && t.trim() !== "");
    out.set(r.page_id, {
      pageId: r.page_id,
      crawlRunId: r.crawl_run_id,
      statusCode: r.status_code,
      title: r.title,
      metaDescription: r.meta_description,
      h1: parseJson<unknown[]>(r.h1_json, []).filter((h): h is string => typeof h === "string" && h.trim() !== ""),
      headings,
      canonical: r.canonical,
      robotsMeta: r.robots_meta,
      jsonldTypes: uniq(parseJson<unknown[]>(r.jsonld_types_json, []).filter((t): t is string => typeof t === "string")),
      wordCount: r.word_count,
      firstParagraph: r.first_paragraph,
      lastUpdated: r.last_updated,
      fetchedAt: r.fetched_at,
    });
  }
  return out;
}

// ------------------------------------------------------------------ link suggestions

export interface LinkSuggestionLite {
  id: string;
  sourceUrl: string;
  targetUrl: string;
  targetInlinks: number;
  provider: string | null;
  model: string | null;
}

export async function loadLinkSuggestions(db: Db, ws: string, pid: string, ids: string[]): Promise<Map<string, LinkSuggestionLite>> {
  const out = new Map<string, LinkSuggestionLite>();
  const list = uniq(ids);
  if (list.length === 0) return out;
  const rows = await inChunks(
    list,
    (chunk, ph) =>
      db.all<{ id: string; source_url: string; target_url: string; target_inlinks: number; provider: string | null; model: string | null }>(
        `SELECT id, source_url, target_url, target_inlinks, provider, model FROM link_suggestions
          WHERE workspace_id = ? AND project_id = ? AND id IN (${ph}) LIMIT ${chunk.length}`,
        ws,
        pid,
        ...chunk,
      ),
    CHUNK,
  );
  for (const r of rows) {
    out.set(r.id, { id: r.id, sourceUrl: r.source_url, targetUrl: r.target_url, targetInlinks: r.target_inlinks, provider: r.provider, model: r.model });
  }
  return out;
}

// ------------------------------------------------------------------ Search Console

export interface GscLookup {
  syncId: string;
  window: DateWindow;
  /** pageKey -> current-window metrics */
  pages: Map<string, LiveGscMetrics>;
  /** normalizeDemandQuery(query) -> current-window metrics */
  queries: Map<string, LiveGscMetrics>;
}

interface Acc {
  clicks: number;
  impressions: number;
  wpos: number;
  wimp: number;
}

const add = (a: Acc | undefined, r: Acc): Acc => ({
  clicks: (a?.clicks ?? 0) + r.clicks,
  impressions: (a?.impressions ?? 0) + r.impressions,
  wpos: (a?.wpos ?? 0) + r.wpos,
  wimp: (a?.wimp ?? 0) + r.wimp,
});

function metrics(a: Acc, window: DateWindow, basis: LiveGscMetrics["basis"]): LiveGscMetrics {
  return {
    clicks: a.clicks,
    impressions: a.impressions,
    // Impression-weighted position of the stored rows (seo/gsc/aggregate.ts weightedPosition); null without impressions.
    position: a.wimp > 0 ? Math.round((a.wpos / a.wimp) * 100) / 100 : null,
    window,
    basis,
  };
}

const SUMS = `SUM(clicks) AS clicks, SUM(impressions) AS impressions,
              SUM(CASE WHEN impressions > 0 THEN position * impressions ELSE 0 END) AS wpos,
              SUM(CASE WHEN impressions > 0 THEN impressions ELSE 0 END) AS wimp`;

/**
 * Current-window metrics of the latest usable sync (completed or partial) for the given page URLs and query
 * texts; null when there is no usable sync or nothing to look up.
 *   Pages: page-dimension rows (query IS NULL) when the sync stored any for the page (basis page_rows), else
 *   the sum of its query+page rows (basis query_page_rows, a lower bound: anonymized queries are omitted).
 *   Queries: query-dimension rows (page IS NULL; basis query_rows) when stored, else the sum of the query's
 *   query+page rows (basis query_page_rows).
 * Device rows are excluded (they would double count). Grouped in SQL, so the read is bounded by the inputs.
 */
export async function loadGscMetrics(db: Db, ws: string, pid: string, urls: string[], queries: string[]): Promise<GscLookup | null> {
  if (urls.length === 0 && queries.length === 0) return null;
  const sync = await latestUsableSync(db, ws, pid);
  if (!sync) return null;
  const window: DateWindow = { start: sync.window_start, end: sync.window_end };
  const out: GscLookup = { syncId: sync.id, window, pages: new Map(), queries: new Map() };

  const pageVariants = uniq(urls.flatMap(urlVariants));
  if (pageVariants.length > 0) {
    const rows = await inChunks(
      pageVariants,
      (chunk, ph) =>
        db.all<{ page: string; page_row: number } & Acc>(
          `SELECT page, CASE WHEN query IS NULL THEN 1 ELSE 0 END AS page_row, ${SUMS}
             FROM gsc_metrics
            WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'current' AND device IS NULL AND page IN (${ph})
            GROUP BY page, page_row LIMIT ${chunk.length * 2}`,
          ws,
          pid,
          sync.id,
          ...chunk,
        ),
      CHUNK,
    );
    const pageRows = new Map<string, Acc>();
    const qpRows = new Map<string, Acc>();
    for (const r of rows) {
      const k = pageKey(r.page);
      if (!k) continue;
      const target = r.page_row === 1 ? pageRows : qpRows;
      target.set(k, add(target.get(k), r));
    }
    for (const [k, a] of qpRows) out.pages.set(k, metrics(a, window, "query_page_rows"));
    for (const [k, a] of pageRows) out.pages.set(k, metrics(a, window, "page_rows"));
  }

  const queryVariants = uniq(queries.flatMap((q) => [q, normalizeDemandQuery(q)]).filter((q) => q !== ""));
  if (queryVariants.length > 0) {
    const rows = await inChunks(
      queryVariants,
      (chunk, ph) =>
        db.all<{ query: string; query_row: number } & Acc>(
          `SELECT query, CASE WHEN page IS NULL THEN 1 ELSE 0 END AS query_row, ${SUMS}
             FROM gsc_metrics
            WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'current' AND device IS NULL AND query IN (${ph})
            GROUP BY query, query_row LIMIT ${chunk.length * 2}`,
          ws,
          pid,
          sync.id,
          ...chunk,
        ),
      CHUNK,
    );
    const queryRows = new Map<string, Acc>();
    const qpRows = new Map<string, Acc>();
    for (const r of rows) {
      const k = normalizeDemandQuery(r.query);
      const target = r.query_row === 1 ? queryRows : qpRows;
      target.set(k, add(target.get(k), r));
    }
    for (const [k, a] of qpRows) out.queries.set(k, metrics(a, window, "query_page_rows"));
    for (const [k, a] of queryRows) out.queries.set(k, metrics(a, window, "query_rows"));
  }
  return out;
}
