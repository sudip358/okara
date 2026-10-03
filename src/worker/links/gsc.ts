/**
 * Search Console page metrics for the internal-links workbench (priority, rolling-crawl order, anchor audit).
 * Read from the latest usable stored sync (no API call), current window only, tenant-scoped.
 *
 *  - Page metrics: the page-dimension row (query and device NULL) when present: Google's own clicks, impressions
 *    and average position for the page ("page_rows"). Otherwise the query+page rows are summed (a lower bound,
 *    anonymized queries are missing) with an impression-weighted position (an approximation): "query_page_rows".
 *  - Top queries per page: the page's query+page rows by impressions, self-brand queries excluded (gsc/brand.ts),
 *    at most TOP_QUERIES_PER_PAGE. Used by the anchor audit only.
 * These are the site's own Search Console impressions, never market search volume.
 */
import type { Db } from "../lib/db";
import { normalizeUrlKey } from "../seo/rules/registry";
import { latestUsableSync, projectBrandClassifier } from "../seo/gsc/overview";
import type { ProjectRow } from "../platform/access";

export const TOP_QUERIES_PER_PAGE = 3;
/** Rows read per slice (bounded; the sync itself stores at most the project's gsc_rows cap per window). */
export const MAX_GSC_ROWS = 25_000;

export interface GscPageMetric {
  impressions: number;
  clicks: number;
  /** Google's page position (page_rows) or an impression-weighted approximation (query_page_rows); null without impressions. */
  position: number | null;
  basis: "page_rows" | "query_page_rows";
}

export interface GscPageData {
  syncId: string;
  syncedAt: string;
  source: "api" | "csv_import" | "demo";
  window: { start: string; end: string };
  pages: Map<string, GscPageMetric>;
  topQueries: Map<string, Array<{ query: string; impressions: number }>>;
}

type ProjectRef = Pick<ProjectRow, "id" | "workspace_id"> & Partial<Pick<ProjectRow, "brand_name" | "brand_aliases_json" | "competitors_json">>;

/** null when the project has no usable Search Console sync. */
export async function loadGscPageData(db: Db, project: ProjectRef, opts: { topQueries?: boolean } = {}): Promise<GscPageData | null> {
  const sync = await latestUsableSync(db, project.workspace_id, project.id);
  if (!sync) return null;
  const pageRows = await db.all<{ page: string; clicks: number; impressions: number; position: number }>(
    `SELECT page, clicks, impressions, position FROM gsc_metrics
      WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND "window" = 'current' AND query IS NULL AND device IS NULL AND page IS NOT NULL
      LIMIT ${MAX_GSC_ROWS}`,
    project.workspace_id,
    project.id,
    sync.id,
  );
  const queryRows = await db.all<{ query: string; page: string; clicks: number; impressions: number; position: number }>(
    `SELECT query, page, clicks, impressions, position FROM gsc_metrics
      WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND "window" = 'current' AND query IS NOT NULL AND page IS NOT NULL AND device IS NULL
      ORDER BY impressions DESC LIMIT ${MAX_GSC_ROWS}`,
    project.workspace_id,
    project.id,
    sync.id,
  );
  const pages = new Map<string, GscPageMetric>();
  for (const r of pageRows) {
    const k = normalizeUrlKey(r.page);
    const prev = pages.get(k);
    const impressions = Number(r.impressions) || 0;
    const clicks = Number(r.clicks) || 0;
    if (prev) {
      // Two raw page strings with the same key (trailing slash): combine, weighting position by impressions.
      const imp = prev.impressions + impressions;
      const pos = imp > 0 ? ((prev.position ?? 0) * prev.impressions + Number(r.position) * impressions) / imp : null;
      pages.set(k, { impressions: imp, clicks: prev.clicks + clicks, position: pos, basis: "page_rows" });
    } else {
      pages.set(k, { impressions, clicks, position: impressions > 0 && Number.isFinite(Number(r.position)) ? Number(r.position) : null, basis: "page_rows" });
    }
  }
  const summed = new Map<string, { impressions: number; clicks: number; weighted: number }>();
  const topQueries = new Map<string, Array<{ query: string; impressions: number }>>();
  const brand =
    opts.topQueries === false
      ? null
      : await projectBrandClassifier(db, {
          id: project.id,
          workspace_id: project.workspace_id,
          gsc_property: null,
          is_demo: 0,
          brand_name: project.brand_name,
          brand_aliases_json: project.brand_aliases_json,
          competitors_json: project.competitors_json,
        });
  for (const r of queryRows) {
    const k = normalizeUrlKey(r.page);
    const impressions = Number(r.impressions) || 0;
    const s = summed.get(k) ?? { impressions: 0, clicks: 0, weighted: 0 };
    s.impressions += impressions;
    s.clicks += Number(r.clicks) || 0;
    s.weighted += (Number(r.position) || 0) * impressions;
    summed.set(k, s);
    if (brand && !brand.isSelfBrand(r.query)) {
      const list = topQueries.get(k) ?? [];
      if (list.length < TOP_QUERIES_PER_PAGE) {
        list.push({ query: r.query, impressions });
        topQueries.set(k, list);
      }
    }
  }
  for (const [k, s] of summed) {
    if (pages.has(k)) continue;
    pages.set(k, { impressions: s.impressions, clicks: s.clicks, position: s.impressions > 0 ? s.weighted / s.impressions : null, basis: "query_page_rows" });
  }
  return {
    syncId: sync.id,
    syncedAt: sync.synced_at,
    source: sync.source,
    window: { start: sync.window_start, end: sync.window_end },
    pages,
    topQueries,
  };
}

/** "Search Console 2026-09-01 – 2026-09-28, stored sync 2026-09-30" (plain text). */
export function gscSourceLabel(d: Pick<GscPageData, "window" | "syncedAt" | "source">): string {
  const what = d.source === "csv_import" ? "Search Console CSV import" : d.source === "demo" ? "Demo Search Console data" : "Search Console";
  return `${what} ${d.window.start} – ${d.window.end}, stored sync ${d.syncedAt.slice(0, 10)}`;
}
