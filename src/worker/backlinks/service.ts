/**
 * Backlink monitor read models and entry points used by routes/backlinks.ts, the Overview attention feed, and (later)
 * an Ask Okara tool: listBacklinks, backlinkSummary, backlinkEvents, backlinkDetail, backlinkFeed, startBacklinkCheck,
 * advanceBacklinkCheck. Tenancy: callers pass a project resolved with requireProject(); every query filters by
 * workspace_id + project_id. All queries are bounded (LIMIT, <= 100 bound parameters).
 */
import {
  BACKLINK_STATUSES,
  CHECKS_KEPT_PER_BACKLINK,
  FETCHES_PER_INVOCATION,
  MANUAL_CHECKS_PER_DAY,
  MAX_BACKLINKS_PER_PROJECT,
  MAX_RECHECK_IDS,
  RECHECK_ROWS_PER_HOUR,
  SCHEDULED_CHECK_DAYS,
  STATUS_LABELS,
  isBacklinkStatus,
  type BacklinkDetail,
  type BacklinkEventsResponse,
  type BacklinkFeed,
  type BacklinkFilterStatus,
  type BacklinkListResponse,
  type BacklinkRow,
  type BacklinkStatus,
  type BacklinkSummary,
  type StartBacklinkCheckResult,
} from "@shared/backlinks";
import { IMPORT_LABEL_SHEET } from "@shared/import";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { notFound } from "../lib/errors";
import { addSeconds, iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { browserSummary } from "./browser";
import { activeJobs, advanceProject, createJob, manualChecksToday, processBatch, REQUEST_BATCH_DEADLINE_MS, type BatchOptions } from "./jobs";
import { toBacklinkRow, toCheckView, toEventView, toJobView, type BacklinkDbRow, type CheckDbRow, type EventDbRow, type JobDbRow } from "./store";

export const LIST_MAX_LIMIT = 100;
export const CSV_MAX_ROWS = 2_000;
export const EVENTS_MAX = 200;
export const FEED_MAX = 50;

const missingTable = (e: unknown) => e instanceof Error && /no such table/i.test(e.message);

// ------------------------------------------------------------------ list
export type BacklinkSort = "checked" | "status" | "host" | "vendor" | "date" | "da" | "traffic" | "changed";
export interface ListQuery {
  status?: BacklinkFilterStatus | null;
  vendor?: string | null;
  type?: string | null;
  /** Only rows whose last change is within this many days. */
  changedDays?: number | null;
  q?: string | null;
  includeInactive?: boolean;
  sort?: BacklinkSort;
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
}

const SORT_SQL: Record<BacklinkSort, string> = {
  checked: "last_checked_at",
  status: "status",
  host: "live_host",
  vendor: "vendor",
  date: "placed_date",
  da: "da",
  traffic: "traffic",
  changed: "last_change_at",
};

function listWhere(p: ProjectRow, q: ListQuery, now: Date): { sql: string; params: unknown[] } {
  const parts = ["workspace_id = ?", "project_id = ?"];
  const params: unknown[] = [p.workspace_id, p.id];
  if (!q.includeInactive) parts.push("active = 1");
  if (q.status === "unchecked") parts.push("status IS NULL");
  else if (q.status === "target_broken") parts.push("(target_status >= 400 OR (target_status IS NULL AND target_error IS NOT NULL AND target_error NOT IN ('not_checked', 'robots_blocked')))");
  else if (q.status && isBacklinkStatus(q.status)) {
    parts.push("status = ?");
    params.push(q.status);
  }
  if (q.vendor) {
    parts.push("vendor = ?");
    params.push(q.vendor.slice(0, 120));
  }
  if (q.type) {
    parts.push("link_type = ?");
    params.push(q.type.slice(0, 80));
  }
  if (q.changedDays && q.changedDays > 0) {
    parts.push("last_change_at >= ?");
    params.push(iso(addSeconds(now, -Math.min(q.changedDays, 365) * 86_400)));
  }
  if (q.q && q.q.trim()) {
    parts.push("(live_url LIKE ? ESCAPE '\\' OR target_url LIKE ? ESCAPE '\\' OR anchor_expected LIKE ? ESCAPE '\\' OR anchor_found LIKE ? ESCAPE '\\')");
    const like = `%${q.q.trim().slice(0, 100).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like, like, like);
  }
  return { sql: parts.join(" AND "), params };
}

export async function listBacklinks(db: Db, p: ProjectRow, q: ListQuery, now: Date): Promise<BacklinkListResponse> {
  const limit = Math.max(1, Math.min(q.limit ?? 50, LIST_MAX_LIMIT));
  const offset = Math.max(0, Math.min(q.offset ?? 0, 100_000));
  const empty: BacklinkListResponse = { rows: [], total: 0, offset, limit, vendors: [], types: [], labels: [] };
  const w = listWhere(p, q, now);
  const col = SORT_SQL[q.sort ?? "checked"] ?? "last_checked_at";
  const dir = q.dir === "asc" ? "ASC" : "DESC";
  try {
    const rows = await db.all<BacklinkDbRow>(
      `SELECT * FROM backlinks WHERE ${w.sql} ORDER BY (${col} IS NULL), ${col} ${dir}, live_host, id LIMIT ? OFFSET ?`,
      ...w.params,
      limit,
      offset,
    );
    const total = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM backlinks WHERE ${w.sql}`, ...w.params);
    const facets = await db.all<{ kind: string; v: string }>(
      `SELECT 'vendor' AS kind, vendor AS v FROM (SELECT DISTINCT vendor FROM backlinks WHERE workspace_id = ? AND project_id = ? AND active = 1 AND vendor IS NOT NULL ORDER BY vendor LIMIT 50)
       UNION ALL
       SELECT 'type' AS kind, link_type AS v FROM (SELECT DISTINCT link_type FROM backlinks WHERE workspace_id = ? AND project_id = ? AND active = 1 AND link_type IS NOT NULL ORDER BY link_type LIMIT 50)`,
      p.workspace_id,
      p.id,
      p.workspace_id,
      p.id,
    );
    return {
      rows: rows.map(toBacklinkRow),
      total: Number(total?.n ?? 0),
      offset,
      limit,
      vendors: facets.filter((f) => f.kind === "vendor").map((f) => f.v),
      types: facets.filter((f) => f.kind === "type").map((f) => f.v),
      labels: [`Vendor, type, date, DA, traffic and price are ${IMPORT_LABEL_SHEET}.`],
    };
  } catch (e) {
    if (missingTable(e)) return empty;
    throw e;
  }
}

// ------------------------------------------------------------------ CSV
const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // Spreadsheet formula injection: a cell starting with = + - @ (or tab/CR) is prefixed with a quote.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function backlinksCsv(db: Db, p: ProjectRow, q: ListQuery, now: Date): Promise<string> {
  const header = [
    "Live URL", "Target", "Expected anchor", "Found anchor", "Anchor matches", "Status", "Link rel", "HTTP status", "Final URL", "Rel attribute", "Noindex",
    "Target status", "Last checked", "Last change", "Last change at", "Vendor", "Type", "Date", "DA", "Traffic", "Price", "Active",
  ];
  const lines = [header.map(csvCell).join(",")];
  const w = listWhere(p, q, now);
  let rows: BacklinkDbRow[] = [];
  try {
    rows = await db.all<BacklinkDbRow>(`SELECT * FROM backlinks WHERE ${w.sql} ORDER BY live_host, id LIMIT ?`, ...w.params, CSV_MAX_ROWS);
  } catch (e) {
    if (!missingTable(e)) throw e;
  }
  for (const r of rows.map(toBacklinkRow)) {
    lines.push(
      [
        r.liveUrl, r.targetUrl, r.anchorExpected, r.anchorFound, r.anchorMatch === null ? "" : r.anchorMatch ? "yes" : "no", r.status ? STATUS_LABELS[r.status] : "Not checked yet",
        r.linkRel, r.httpStatus, r.finalUrl, r.relText, r.pageNoindex === null ? "" : r.pageNoindex ? "yes" : "no", r.targetStatus ?? r.targetError, r.lastCheckedAt,
        r.lastChangeText, r.lastChangeAt, r.vendor, r.linkType, r.placedDate, r.da, r.traffic, r.priceText, r.active ? "yes" : "no",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

// ------------------------------------------------------------------ detail
export async function backlinkDetail(db: Db, p: ProjectRow, id: string): Promise<BacklinkDetail> {
  let row: BacklinkDbRow | null = null;
  try {
    row = await db.first<BacklinkDbRow>("SELECT * FROM backlinks WHERE workspace_id = ? AND project_id = ? AND id = ?", p.workspace_id, p.id, id);
  } catch (e) {
    if (!missingTable(e)) throw e;
  }
  if (!row) throw notFound("Backlink");
  const checks = await db.all<CheckDbRow>(
    "SELECT * FROM backlink_checks WHERE workspace_id = ? AND project_id = ? AND backlink_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT ?",
    p.workspace_id,
    p.id,
    id,
    CHECKS_KEPT_PER_BACKLINK,
  );
  const events = await db.all<EventDbRow>(
    "SELECT * FROM backlink_events WHERE workspace_id = ? AND project_id = ? AND backlink_id = ? ORDER BY detected_at DESC, rowid DESC LIMIT 50",
    p.workspace_id,
    p.id,
    id,
  );
  return { backlink: toBacklinkRow(row), checks: checks.map(toCheckView), events: events.map(toEventView) };
}

// ------------------------------------------------------------------ events
export async function backlinkEvents(db: Db, p: ProjectRow, opts: { since?: string | null; negativeOnly?: boolean; limit?: number }, now: Date): Promise<BacklinkEventsResponse> {
  const since = opts.since && !Number.isNaN(Date.parse(opts.since)) ? new Date(opts.since).toISOString() : iso(addSeconds(now, -30 * 86_400));
  const limit = Math.max(1, Math.min(opts.limit ?? 100, EVENTS_MAX));
  try {
    const neg = opts.negativeOnly ? " AND e.negative = 1" : "";
    const rows = await db.all<EventDbRow>(
      `SELECT e.*, b.live_url, b.target_url FROM backlink_events e JOIN backlinks b ON b.id = e.backlink_id AND b.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? AND e.project_id = ? AND e.detected_at >= ?${neg}
        ORDER BY e.detected_at DESC, e.rowid DESC LIMIT ?`,
      p.workspace_id,
      p.id,
      since,
      limit,
    );
    const total = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM backlink_events e WHERE e.workspace_id = ? AND e.project_id = ? AND e.detected_at >= ?${neg}`,
      p.workspace_id,
      p.id,
      since,
    );
    return { events: rows.map(toEventView), since, total: Number(total?.n ?? 0) };
  } catch (e) {
    if (missingTable(e)) return { events: [], since, total: 0 };
    throw e;
  }
}

// ------------------------------------------------------------------ summary
const zeroStatus = (): Record<BacklinkStatus, number> => Object.fromEntries(BACKLINK_STATUSES.map((s) => [s, 0])) as Record<BacklinkStatus, number>;

export async function backlinkSummary(db: Db, p: ProjectRow, now: Date, canRun = true, env: Pick<Env, "BROWSER" | "BACKLINK_BROWSER_MS_PER_DAY"> = {}): Promise<BacklinkSummary> {
  const byStatus = zeroStatus();
  const base: BacklinkSummary = {
    state: p.is_demo === 1 ? "demo" : "empty",
    totals: { active: 0, inactive: 0, checked: 0, unchecked: 0 },
    byStatus,
    dofollow: { n: 0, m: 0 },
    targetBroken: 0,
    anchorMismatch: 0,
    changes: { last7: 0, last30: 0, negative7: 0, negative30: 0 },
    lastCheckAt: null,
    nextCheckAt: null,
    job: null,
    lastJob: null,
    limits: {
      maxBacklinks: MAX_BACKLINKS_PER_PROJECT,
      manualPerDay: MANUAL_CHECKS_PER_DAY,
      manualUsedToday: 0,
      recheckRowsPerHour: RECHECK_ROWS_PER_HOUR,
      fetchesPerInvocation: FETCHES_PER_INVOCATION,
      scheduledEveryDays: SCHEDULED_CHECK_DAYS,
    },
    browser: { available: false, unavailableReason: null, waiting: 0, unavailable: 0, failed: 0, usedMs: 0, capMs: 0, deferred: false, deferredUntil: null },
    canRun: canRun && p.is_demo !== 1,
    verified: !!p.verified_host,
    labels: [],
  };
  try {
    const statusRows = await db.all<{ status: string | null; active: number; n: number }>(
      "SELECT status, active, COUNT(*) AS n FROM backlinks WHERE workspace_id = ? AND project_id = ? GROUP BY status, active",
      p.workspace_id,
      p.id,
    );
    for (const r of statusRows) {
      const n = Number(r.n);
      if (Number(r.active) !== 1) {
        base.totals.inactive += n;
        continue;
      }
      base.totals.active += n;
      if (r.status === null) base.totals.unchecked += n;
      else if (isBacklinkStatus(r.status)) {
        byStatus[r.status] += n;
        base.totals.checked += n;
      }
    }
    // dofollow share: n = live dofollow links, m = checked backlinks whose page was read (link found or not).
    base.dofollow = { n: byStatus.dofollow, m: byStatus.dofollow + byStatus.nofollow + byStatus.sponsored + byStatus.ugc + byStatus.missing };
    const extra = await db.first<{ broken: number; mismatch: number; last: string | null }>(
      `SELECT SUM(CASE WHEN target_status >= 400 OR (target_status IS NULL AND target_error IS NOT NULL AND target_error NOT IN ('not_checked', 'robots_blocked')) THEN 1 ELSE 0 END) AS broken,
              SUM(CASE WHEN anchor_match = 0 THEN 1 ELSE 0 END) AS mismatch, MAX(last_checked_at) AS last
         FROM backlinks WHERE workspace_id = ? AND project_id = ? AND active = 1`,
      p.workspace_id,
      p.id,
    );
    base.targetBroken = Number(extra?.broken ?? 0);
    base.anchorMismatch = Number(extra?.mismatch ?? 0);
    base.lastCheckAt = extra?.last ?? null;
    const ev = await db.first<{ a7: number; a30: number; n7: number; n30: number }>(
      `SELECT SUM(CASE WHEN detected_at >= ? THEN 1 ELSE 0 END) AS a7, COUNT(*) AS a30,
              SUM(CASE WHEN detected_at >= ? AND negative = 1 THEN 1 ELSE 0 END) AS n7, SUM(CASE WHEN negative = 1 THEN 1 ELSE 0 END) AS n30
         FROM backlink_events WHERE workspace_id = ? AND project_id = ? AND detected_at >= ?`,
      iso(addSeconds(now, -7 * 86_400)),
      iso(addSeconds(now, -7 * 86_400)),
      p.workspace_id,
      p.id,
      iso(addSeconds(now, -30 * 86_400)),
    );
    base.changes = { last7: Number(ev?.a7 ?? 0), last30: Number(ev?.a30 ?? 0), negative7: Number(ev?.n7 ?? 0), negative30: Number(ev?.n30 ?? 0) };
    const active = await activeJobs(db, p);
    const running = active.find((j) => j.scope === "all") ?? active[0] ?? null;
    base.job = running ? toJobView(running) : null;
    const last = await db.first<JobDbRow>(
      "SELECT * FROM backlink_jobs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'failed') ORDER BY finished_at DESC, rowid DESC LIMIT 1",
      p.workspace_id,
      p.id,
    );
    base.lastJob = last ? toJobView(last) : null;
    base.limits.manualUsedToday = await manualChecksToday(db, p, now);
    base.browser = await browserSummary(db, p, env, now);
    if (p.schedule_enabled === 1 && p.is_demo !== 1 && base.totals.active > 0) {
      const lastAll = await db.first<{ created_at: string }>(
        "SELECT created_at FROM backlink_jobs WHERE workspace_id = ? AND project_id = ? AND scope = 'all' ORDER BY created_at DESC LIMIT 1",
        p.workspace_id,
        p.id,
      );
      base.nextCheckAt = lastAll ? iso(addSeconds(new Date(lastAll.created_at), SCHEDULED_CHECK_DAYS * 86_400)) : iso(now);
    }
  } catch (e) {
    if (missingTable(e)) return { ...base, labels: ["The backlink monitor tables are not created yet (apply migration 0020)."] };
    throw e;
  }
  if (p.is_demo !== 1) base.state = base.totals.active + base.totals.inactive > 0 ? "ready" : "empty";
  base.labels = [
    "Checked by fetching each live article (robots.txt is not consulted for your own placed links); dofollow = a followable link to your site on a page without page-level nofollow.",
    "A link missing, a bot wall (HTTP 403 / 429 / 503) or a failed fetch is re-checked once in Cloudflare's headless browser (Browser Run), within a daily browser-time budget; that result then counts.",
    ...(p.verified_host ? [] : ["Your site is not verified, so target URLs are not checked (verify it in Settings)."]),
    ...(p.schedule_enabled === 1 ? [] : ["Scheduled runs are off for this project, so there is no weekly check."]),
  ];
  return base;
}

// ------------------------------------------------------------------ live feed
export async function backlinkFeed(db: Db, p: ProjectRow, opts: { after?: string | null; limit?: number } = {}): Promise<BacklinkFeed> {
  try {
    const active = await activeJobs(db, p);
    let job: JobDbRow | null = active.find((j) => j.scope === "all") ?? active[0] ?? null;
    if (!job) {
      job = await db.first<JobDbRow>("SELECT * FROM backlink_jobs WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", p.workspace_id, p.id);
    }
    if (!job) return { job: null, items: [] };
    const max = Math.max(0, Math.min(opts.limit ?? FEED_MAX, FEED_MAX));
    if (max === 0) return { job: toJobView(job), items: [] };
    const after = opts.after && !Number.isNaN(Date.parse(opts.after)) ? new Date(opts.after).toISOString() : null;
    const rows = await db.all<CheckDbRow & { live_url: string; target_url: string }>(
      `SELECT c.*, b.live_url, b.target_url FROM backlink_checks c JOIN backlinks b ON b.id = c.backlink_id AND b.workspace_id = c.workspace_id
        WHERE c.workspace_id = ? AND c.project_id = ? AND c.job_id = ?${after ? " AND c.checked_at > ?" : ""}
        ORDER BY c.checked_at DESC, c.rowid DESC LIMIT ?`,
      p.workspace_id,
      p.id,
      job.id,
      ...(after ? [after] : []),
      max,
    );
    return {
      job: toJobView(job),
      items: rows.map((r) => {
        const v = toCheckView(r);
        return {
          checkId: v.id,
          method: v.method,
          backlinkId: v.backlinkId,
          checkedAt: v.checkedAt,
          liveUrl: r.live_url,
          targetUrl: r.target_url,
          status: v.status,
          statusReason: v.statusReason,
          httpStatus: v.httpStatus,
          finalUrl: v.finalUrl,
          anchorFound: v.anchorFound,
          robots: v.robots,
        };
      }),
    };
  } catch (e) {
    if (missingTable(e)) return { job: null, items: [] };
    throw e;
  }
}

// ------------------------------------------------------------------ start / advance
/**
 * Start a check (manual run of every active backlink, or a recheck of up to MAX_RECHECK_IDS ids). The first batch runs
 * in `schedule` (ctx.waitUntil) when given, else inline (tests, Ask Okara without an execution context).
 */
export async function startBacklinkCheck(
  env: Env,
  db: Db,
  p: ProjectRow,
  opts: { userId: string | null; ids?: string[] | null; now: Date; schedule?: (work: Promise<unknown>) => void; batch?: BatchOptions },
): Promise<StartBacklinkCheckResult> {
  const ids = opts.ids && opts.ids.length ? opts.ids.slice(0, MAX_RECHECK_IDS + 1) : null;
  const res = await createJob(db, p, { userId: opts.userId, trigger: ids ? "recheck" : "manual", ids, now: opts.now });
  if (res.existing) return res;
  const work = processBatch(env, db, res.job.id, p.workspace_id, { deadlineMs: REQUEST_BATCH_DEADLINE_MS, ...opts.batch }).catch((e) => {
    console.error("backlink batch failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
  });
  if (opts.schedule) opts.schedule(work);
  else await work;
  return res;
}

/** One more batch of the project's active job (lease-guarded; a no-op while another invocation works on it). */
export async function advanceBacklinkCheck(
  env: Env,
  db: Db,
  p: ProjectRow,
  opts: { after?: string | null; schedule?: (work: Promise<unknown>) => void; batch?: BatchOptions } = {},
): Promise<BacklinkFeed> {
  if (p.is_demo !== 1) {
    const work = advanceProject(env, db, p, { deadlineMs: REQUEST_BATCH_DEADLINE_MS, ...opts.batch }).catch((e) => {
      console.error("backlink batch failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    });
    if (opts.schedule) opts.schedule(work);
    else await work;
  }
  return backlinkFeed(db, p, { after: opts.after });
}

// ------------------------------------------------------------------ attention
export interface BacklinkAttention {
  negative: number;
  since: string;
  examples: Array<{ backlinkId: string; liveUrl: string; targetUrl: string; message: string; detectedAt: string }>;
}

/** New negative changes (lost, nofollow, 404, redirected, noindex, target broken) in the last 7 days. */
export async function backlinkAttention(db: Db, p: ProjectRow, now: Date): Promise<BacklinkAttention | null> {
  const since = iso(addSeconds(now, -7 * 86_400));
  try {
    const ev = await backlinkEvents(db, p, { since, negativeOnly: true, limit: 3 }, now);
    if (ev.total === 0) return null;
    return {
      negative: ev.total,
      since,
      examples: ev.events.map((e) => ({ backlinkId: e.backlinkId, liveUrl: e.liveUrl ?? "", targetUrl: e.targetUrl ?? "", message: e.message, detectedAt: e.detectedAt })),
    };
  } catch {
    return null;
  }
}

export type { BacklinkRow };
