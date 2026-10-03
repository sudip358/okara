/**
 * Live view SEO project containers (docs/live-view-design.md section 17): 10 striking-distance queries,
 * 11 pages gaining and losing clicks, 12 technical issues from the latest crawl. Read-only over stored rows:
 * every statement filters workspace_id AND project_id, has a LIMIT, and binds at most a few dozen values.
 */
import type { LiveInsightSync, LiveMoversInsight, LiveStrikingInsight, LiveTechnicalGroup, LiveTechnicalInsight, Severity } from "@shared/types";
import type { Db } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { clip, DEMO_LABEL, uniq } from "../coverage/common";
import type { SyncRow } from "../seo/gsc/overview";
import { getRule } from "../seo/rules/registry";
import { MOVERS, STRIKING_DISTANCE, TECHNICAL, pageMovers, strikingRows, type MetricRowLite, type PageWindowGroup } from "./insights-lib";

const URL_MAX = 300;
const QUERY_MAX = 200;
const SEVERITIES: readonly Severity[] = ["critical", "major", "moderate", "minor", "advisory"];

export const NO_SYNC_MESSAGE = "No Search Console data is stored yet: connect Search Console (or import a CSV export) and run a Search Console sync.";

function syncOf(s: SyncRow & { run_id?: string | null }): LiveInsightSync {
  return {
    syncId: s.id,
    runId: s.run_id ?? null,
    source: s.source,
    syncedAt: s.synced_at,
    current: { start: s.window_start, end: s.window_end },
    previous: { start: s.prev_window_start, end: s.prev_window_end },
    truncated: s.truncated === 1,
  };
}

/** The latest usable sync (completed or partial; same rule as seo/gsc/overview.ts latestUsableSync) with its run id. */
export async function usableSync(db: Db, p: ProjectRow): Promise<(SyncRow & { run_id: string | null }) | null> {
  return db.first<SyncRow & { run_id: string | null }>(
    `SELECT id, run_id, source, property, window_start, window_end, prev_window_start, prev_window_end, data_state, rows_fetched, row_cap, truncated,
            totals_json, status, error, synced_at
       FROM gsc_syncs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial') ORDER BY synced_at DESC LIMIT 1`,
    p.workspace_id,
    p.id,
  );
}

const baseLabels = (p: ProjectRow) => (p.is_demo === 1 ? [DEMO_LABEL] : []);
const stateOf = (p: ProjectRow) => (p.is_demo === 1 ? ("demo" as const) : ("ready" as const));

// ------------------------------------------------------------------ 10 striking-distance queries

/** Query+page rows of the current window whose position is in range, by impressions; previous window joined by exact query+page. */
export async function buildStriking(db: Db, p: ProjectRow, now: Date): Promise<LiveStrikingInsight> {
  const t = STRIKING_DISTANCE;
  const thresholds = { minPosition: t.minPosition, maxPosition: t.maxPosition, minImpressions: t.minImpressions, maxRows: t.maxRows };
  const sync = await usableSync(db, p);
  const base = { kind: "striking" as const, generatedAt: now.toISOString(), thresholds, truncated: false };
  if (!sync) return { ...base, state: p.is_demo === 1 ? "demo" : "setup_required", message: NO_SYNC_MESSAGE, labels: baseLabels(p), sync: null, rows: [], total: 0 };

  const ws = p.workspace_id;
  const inRange = `workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'current' AND device IS NULL AND query IS NOT NULL AND page IS NOT NULL
                   AND position >= ? AND position <= ? AND impressions >= ?`;
  const args = [ws, p.id, sync.id, t.minPosition, t.maxPosition, t.minImpressions] as const;
  const [count, current] = await Promise.all([
    db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM gsc_metrics WHERE ${inRange} LIMIT 1`, ...args),
    db.all<MetricRowLite>(`SELECT query, page, clicks, impressions, position FROM gsc_metrics WHERE ${inRange} ORDER BY impressions DESC, query, page LIMIT ?`, ...args, t.maxRows),
  ]);

  // Previous window: the same query+page (exact strings). Pairs in chunks of 45: query IN (≤45) AND page IN
  // (≤45) binds at most 93 values; the cross product is bounded and matched exactly below.
  const previous: MetricRowLite[] = [];
  for (let i = 0; i < current.length; i += 45) {
    const chunk = current.slice(i, i + 45);
    const qs = uniq(chunk.map((r) => r.query));
    const ps = uniq(chunk.map((r) => r.page));
    previous.push(
      ...(await db.all<MetricRowLite>(
        `SELECT query, page, clicks, impressions, position FROM gsc_metrics
          WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'previous' AND device IS NULL
            AND query IN (${qs.map(() => "?").join(", ")}) AND page IN (${ps.map(() => "?").join(", ")})
          LIMIT ${qs.length * ps.length}`,
        ws,
        p.id,
        sync.id,
        ...qs,
        ...ps,
      )),
    );
  }
  const rows = strikingRows(current, previous, t).map((r) => ({ ...r, query: clip(r.query, QUERY_MAX), page: clip(r.page, URL_MAX) }));
  const labels = [...baseLabels(p)];
  if (sync.source === "csv_import") labels.push("This sync is a CSV import: it stores queries and pages separately, so it has no query+page rows.");
  if (sync.truncated === 1) labels.push("The sync hit its row cap: some query+page rows may be missing.");
  return { ...base, state: stateOf(p), message: null, labels, sync: syncOf(sync), rows, total: Number(count?.n ?? 0) };
}

// ------------------------------------------------------------------ 11 pages gaining and losing clicks

interface PageGroupRaw {
  page: string;
  in_cur: number;
  in_prev: number;
  cur_clicks: number;
  cur_impr: number;
  cur_wpos: number;
  cur_wimp: number;
  prev_clicks: number;
  prev_impr: number;
  prev_wpos: number;
  prev_wimp: number;
}

/**
 * Page-level sums per window (page-dimension rows when the sync stored any, else the sum of query+page rows, a
 * lower bound), grouped in SQL; at most MOVERS.groupCap pages (most clicks first), then pageMovers().
 */
export async function buildMovers(db: Db, p: ProjectRow, now: Date): Promise<LiveMoversInsight> {
  const sync = await usableSync(db, p);
  const base = { kind: "movers" as const, generatedAt: now.toISOString(), top: MOVERS.top };
  const empty = { gainers: [], losers: [], counts: { both: 0, unchanged: 0, newPages: 0, lostPages: 0 } };
  if (!sync) return { ...base, ...empty, state: p.is_demo === 1 ? "demo" : "setup_required", message: NO_SYNC_MESSAGE, labels: baseLabels(p), sync: null, basis: null, truncated: false };
  const ws = p.workspace_id;
  const hasPageRows = await db.first<{ x: number }>(
    "SELECT 1 AS x FROM gsc_metrics WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND device IS NULL AND query IS NULL AND page IS NOT NULL LIMIT 1",
    ws,
    p.id,
    sync.id,
  );
  const basis: "page_rows" | "query_page_rows" = hasPageRows ? "page_rows" : "query_page_rows";
  const raw = await db.all<PageGroupRaw>(
    `SELECT page,
            MAX(CASE WHEN window = 'current' THEN 1 ELSE 0 END) AS in_cur,
            MAX(CASE WHEN window = 'previous' THEN 1 ELSE 0 END) AS in_prev,
            SUM(CASE WHEN window = 'current' THEN clicks ELSE 0 END) AS cur_clicks,
            SUM(CASE WHEN window = 'current' THEN impressions ELSE 0 END) AS cur_impr,
            SUM(CASE WHEN window = 'current' AND impressions > 0 THEN position * impressions ELSE 0 END) AS cur_wpos,
            SUM(CASE WHEN window = 'current' AND impressions > 0 THEN impressions ELSE 0 END) AS cur_wimp,
            SUM(CASE WHEN window = 'previous' THEN clicks ELSE 0 END) AS prev_clicks,
            SUM(CASE WHEN window = 'previous' THEN impressions ELSE 0 END) AS prev_impr,
            SUM(CASE WHEN window = 'previous' AND impressions > 0 THEN position * impressions ELSE 0 END) AS prev_wpos,
            SUM(CASE WHEN window = 'previous' AND impressions > 0 THEN impressions ELSE 0 END) AS prev_wimp
       FROM gsc_metrics
      WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND device IS NULL AND page IS NOT NULL AND ${basis === "page_rows" ? "query IS NULL" : "query IS NOT NULL"}
      GROUP BY page
      ORDER BY SUM(clicks) DESC, page
      LIMIT ?`,
    ws,
    p.id,
    sync.id,
    MOVERS.groupCap + 1,
  );
  const truncated = raw.length > MOVERS.groupCap;
  const groups: PageWindowGroup[] = raw.slice(0, MOVERS.groupCap).map((r) => ({
    page: r.page,
    inCur: Number(r.in_cur) === 1,
    inPrev: Number(r.in_prev) === 1,
    cur: { clicks: Number(r.cur_clicks), impressions: Number(r.cur_impr), wpos: Number(r.cur_wpos), wimp: Number(r.cur_wimp) },
    prev: { clicks: Number(r.prev_clicks), impressions: Number(r.prev_impr), wpos: Number(r.prev_wpos), wimp: Number(r.prev_wimp) },
  }));
  const m = pageMovers(groups, MOVERS.top);
  const clipPage = <T extends { page: string }>(x: T): T => ({ ...x, page: clip(x.page, URL_MAX) });
  const labels = [
    ...baseLabels(p),
    basis === "page_rows"
      ? "Page-level Search Console rows, current vs previous window; only pages present in both windows are ranked."
      : "Sums of query+page rows per page (a lower bound: anonymized queries are omitted), current vs previous window; only pages present in both windows are ranked.",
  ];
  if (truncated) labels.push(`Only the ${MOVERS.groupCap.toLocaleString("en-US")} pages with the most clicks were compared; counts are lower bounds.`);
  return {
    ...base,
    state: stateOf(p),
    message: null,
    labels,
    sync: syncOf(sync),
    basis,
    gainers: m.gainers.map(clipPage),
    losers: m.losers.map(clipPage),
    counts: m.counts,
    truncated,
  };
}

// ------------------------------------------------------------------ 12 technical issues from the latest crawl

interface CrawlRaw {
  id: string;
  run_id: string | null;
  status: "completed" | "partial";
  pages_limit: number;
  pages_crawled: number;
  pages_skipped: number;
  started_at: string;
  finished_at: string | null;
}

/** audit_findings of the latest completed/partial crawl grouped by severity and rule (counts + first examples). */
export async function buildTechnical(db: Db, p: ProjectRow, now: Date): Promise<LiveTechnicalInsight> {
  const ws = p.workspace_id;
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const base = { kind: "technical" as const, generatedAt: now.toISOString(), bySeverity, total: 0, groups: [] as LiveTechnicalGroup[], truncated: false };
  // Same rule as GET /seo/audit: no findings are produced for unverified sites (demo projects carry seeded crawl data).
  if (!p.verified_host && p.is_demo !== 1) {
    return { ...base, state: "setup_required", message: "Verify site ownership first: the crawler only reads verified hosts.", labels: [], crawl: null, newer: null };
  }
  const crawl = await db.first<CrawlRaw>(
    `SELECT id, run_id, status, pages_limit, pages_crawled, pages_skipped, started_at, finished_at FROM crawl_runs
      WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial') ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ws,
    p.id,
  );
  const newer = await db.first<{ status: string; started_at: string }>(
    `SELECT status, started_at FROM crawl_runs WHERE workspace_id = ? AND project_id = ? AND status IN ('running', 'failed') AND started_at > ?
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ws,
    p.id,
    crawl?.started_at ?? "",
  );
  const newerOut = newer ? { status: newer.status, startedAt: newer.started_at } : null;
  if (!crawl) return { ...base, state: stateOf(p), message: null, labels: baseLabels(p), crawl: null, newer: newerOut };

  const [counts, examples] = await Promise.all([
    db.all<{ severity: Severity; rule_id: string; n: number }>(
      `SELECT severity, rule_id, COUNT(*) AS n FROM audit_findings WHERE workspace_id = ? AND project_id = ? AND crawl_run_id = ?
        GROUP BY severity, rule_id ORDER BY n DESC, rule_id LIMIT ?`,
      ws,
      p.id,
      crawl.id,
      TECHNICAL.groupCap + 1,
    ),
    db.all<{ severity: Severity; rule_id: string; url: string | null; template: string | null; detail: string }>(
      `SELECT severity, rule_id, url, template, detail FROM (
         SELECT severity, rule_id, url, template, detail,
                ROW_NUMBER() OVER (PARTITION BY severity, rule_id ORDER BY url IS NULL, url, rowid) AS rn
           FROM audit_findings WHERE workspace_id = ? AND project_id = ? AND crawl_run_id = ?)
        WHERE rn <= ? LIMIT ?`,
      ws,
      p.id,
      crawl.id,
      TECHNICAL.examples,
      TECHNICAL.examples * TECHNICAL.groupCap,
    ),
  ]);
  const truncated = counts.length > TECHNICAL.groupCap;
  const ex = new Map<string, LiveTechnicalGroup["examples"]>();
  for (const e of examples) {
    const k = `${e.severity}\u0000${e.rule_id}`;
    const list = ex.get(k) ?? [];
    list.push({ url: e.url ? clip(e.url, URL_MAX) : null, template: e.template ? clip(e.template, 120) : null, detail: clip(e.detail, 240) });
    ex.set(k, list);
  }
  const order = (s: Severity) => SEVERITIES.indexOf(s);
  const groups: LiveTechnicalGroup[] = counts
    .slice(0, TECHNICAL.groupCap)
    .map((c) => {
      const rule = getRule(c.rule_id);
      return {
        severity: c.severity,
        ruleId: c.rule_id,
        ruleName: rule?.name ?? c.rule_id,
        area: rule?.area ?? "unknown",
        class: rule?.class ?? "heuristic",
        count: Number(c.n),
        examples: ex.get(`${c.severity}\u0000${c.rule_id}`) ?? [],
      };
    })
    .sort((a, b) => order(a.severity) - order(b.severity) || b.count - a.count || a.ruleId.localeCompare(b.ruleId));
  for (const g of groups) bySeverity[g.severity] = (bySeverity[g.severity] ?? 0) + g.count;
  const labels = [...baseLabels(p), "Rule findings of the latest completed crawl (deterministic rules; fact or heuristic per rule)."];
  if (truncated) labels.push(`More than ${TECHNICAL.groupCap} rule groups: counts are lower bounds.`);
  return {
    ...base,
    state: stateOf(p),
    message: null,
    labels,
    crawl: {
      id: crawl.id,
      runId: crawl.run_id,
      status: crawl.status,
      startedAt: crawl.started_at,
      finishedAt: crawl.finished_at,
      pagesCrawled: Number(crawl.pages_crawled),
      pagesSkipped: Number(crawl.pages_skipped),
      pagesLimit: Number(crawl.pages_limit),
    },
    newer: newerOut,
    bySeverity,
    total: groups.reduce((a, g) => a + g.count, 0),
    groups,
    truncated,
  };
}
