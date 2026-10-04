/**
 * Backlink check jobs: creation (manual run, recheck of chosen rows, weekly schedule), bounded batch processing under
 * a lease, result storage with change detection, and the cron tick.
 *
 * Workers Free budget (50 external subrequests and ~10 ms CPU per invocation): one invocation processes ONE batch of at
 * most ITEMS_PER_INVOCATION backlinks and FETCHES_PER_INVOCATION external requests (robots.txt, redirect hops and our
 * own target checks included; check.ts stops before the request that would exceed it), with about 6 D1 calls. Batches
 * are driven by:
 *   1. the request that starts a job (POST /backlinks/check: first batch in ctx.waitUntil);
 *   2. POST /backlinks/check/advance, which the Live Backlinks view and the Backlinks page call while a job runs
 *      (sequentially, at most every 2 s; each call is a fresh invocation with its own budget; the lease makes extra calls
 *      no-ops);
 *   3. the existing 15-minute cron (index.ts): one batch per tick for the oldest job, plus the weekly scheduling.
 * The lease (LEASE_SECONDS) guarantees at most one invocation works on a job; an interrupted batch is picked up again
 * when the lease expires. Results of a batch are written in one D1 batch (atomic).
 */
import {
  CHECKS_KEPT_PER_BACKLINK,
  FETCHES_PER_INVOCATION,
  ITEMS_PER_INVOCATION,
  MANUAL_CHECKS_PER_DAY,
  MAX_RECHECK_IDS,
  RECHECK_ROWS_PER_HOUR,
  SCHEDULED_CHECK_DAYS,
  type BacklinkStatus,
  type StartBacklinkCheckResult,
} from "@shared/backlinks";
import type { Env } from "../env";
import { Db, parseJson } from "../lib/db";
import { HttpError, badRequest, conflict } from "../lib/errors";
import { newId } from "../lib/ids";
import { addSeconds, iso, utcDay } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { loadProjectRow, siteHost } from "../platform/projects";
import { crawlerUserAgent } from "../seo/crawl/robots";
import { normalizeHost } from "../seo/ssrf";
import { checkBacklink, emptyCache, FetchBudgetExhausted, type CheckDeps, type CheckResult, type JobCache, type RobotsVerdict, type TargetResult } from "./check";
import { diffChecks, type CheckSnapshot } from "./events";
import { toJobView, type BacklinkDbRow, type CheckDbRow, type JobDbRow } from "./store";

/** A batch holding the lease longer than this was interrupted; the next invocation may take the job. */
export const LEASE_SECONDS = 90;
/** Wall time a request-driven batch may use (ctx.waitUntil work is cut off ~30 s after the response). */
export const REQUEST_BATCH_DEADLINE_MS = 20_000;
/** Wall time a cron batch may use. */
export const CRON_BATCH_DEADLINE_MS = 60_000;
/** A queued/running job without progress for this long is failed by the cron. */
export const STALLED_JOB_DAYS = 3;
/** Jobs kept per project (active jobs are never pruned). */
export const JOBS_KEPT_PER_PROJECT = 50;
/** Events kept per backlink. */
export const EVENTS_KEPT_PER_BACKLINK = 50;
/** Projects given a weekly scheduled job per cron tick. */
export const SCHEDULES_PER_TICK = 3;

// ------------------------------------------------------------------ test hooks
let fetchOverride: typeof fetch | null = null;
let sleepOverride: ((ms: number) => Promise<void>) | null = null;
/** Test hook: the platform fetch used for article pages, robots.txt and our target checks. */
export function setBacklinkFetch(f: typeof fetch | null, sleep: ((ms: number) => Promise<void>) | null = null) {
  fetchOverride = f;
  sleepOverride = sleep;
}

export function checkDeps(env: Env): CheckDeps {
  return {
    fetchImpl: fetchOverride ?? ((input, init) => fetch(input, init)),
    userAgent: crawlerUserAgent(env.APP_ORIGIN),
    ...(sleepOverride ? { sleep: sleepOverride } : {}),
  };
}

// ------------------------------------------------------------------ reads
export async function loadJob(db: Db, workspaceId: string, id: string): Promise<JobDbRow | null> {
  return db.first<JobDbRow>("SELECT * FROM backlink_jobs WHERE workspace_id = ? AND id = ?", workspaceId, id);
}

export async function activeJobs(db: Db, p: ProjectRow): Promise<JobDbRow[]> {
  try {
    return await db.all<JobDbRow>(
      "SELECT * FROM backlink_jobs WHERE workspace_id = ? AND project_id = ? AND status IN ('queued', 'running') ORDER BY created_at, id LIMIT 2",
      p.workspace_id,
      p.id,
    );
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) return [];
    throw e;
  }
}

const dayStart = (now: Date) => `${utcDay(now)}T00:00:00.000Z`;

export async function manualChecksToday(db: Db, p: ProjectRow, now: Date): Promise<number> {
  const r = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM backlink_jobs WHERE workspace_id = ? AND project_id = ? AND trigger = 'manual' AND created_at >= ?",
    p.workspace_id,
    p.id,
    dayStart(now),
  );
  return Number(r?.n ?? 0);
}

export async function recheckRowsLastHour(db: Db, p: ProjectRow, now: Date): Promise<number> {
  const r = await db.first<{ n: number }>(
    "SELECT COALESCE(SUM(total), 0) AS n FROM backlink_jobs WHERE workspace_id = ? AND project_id = ? AND trigger = 'recheck' AND created_at > ?",
    p.workspace_id,
    p.id,
    iso(addSeconds(now, -3600)),
  );
  return Number(r?.n ?? 0);
}

// ------------------------------------------------------------------ start
export interface StartOptions {
  userId: string | null;
  trigger: "manual" | "recheck" | "scheduled";
  ids?: string[] | null;
  now: Date;
}

/**
 * Create a check job (queued). Manual full checks: MANUAL_CHECKS_PER_DAY per project per UTC day; rechecks: at most
 * MAX_RECHECK_IDS ids per request and RECHECK_ROWS_PER_HOUR rows per project per hour. When a job of the same scope is
 * already queued/running it is returned (existing: true) instead of a new one (a recheck answers 409 so the rows the
 * caller chose are not silently dropped).
 */
export async function createJob(db: Db, p: ProjectRow, opts: StartOptions): Promise<StartBacklinkCheckResult> {
  if (p.is_demo === 1) throw new HttpError(409, "demo_project", "Demo projects never fetch pages; backlink checks are disabled.");
  const scope: "all" | "ids" = opts.ids && opts.ids.length ? "ids" : "all";
  const now = opts.now;
  const active = await activeJobs(db, p);
  const same = active.find((j) => j.scope === scope);
  if (same) {
    if (scope === "ids") throw conflict("A recheck is already running for this project. Wait for it to finish.");
    return { job: toJobView(same), existing: true };
  }
  let ids: string[] = [];
  let total: number;
  if (scope === "ids") {
    ids = [...new Set(opts.ids!)];
    if (ids.length > MAX_RECHECK_IDS) throw badRequest(`Recheck at most ${MAX_RECHECK_IDS} backlinks at a time.`);
    const found = await db.all<{ id: string }>(
      `SELECT id FROM backlinks WHERE workspace_id = ? AND project_id = ? AND active = 1 AND id IN (${ids.map(() => "?").join(",")})`,
      p.workspace_id,
      p.id,
      ...ids,
    );
    ids = found.map((r) => r.id);
    if (ids.length === 0) throw new HttpError(404, "not_found", "None of these backlinks are monitored in this project.");
    if (opts.trigger === "recheck") {
      const used = await recheckRowsLastHour(db, p, now);
      if (used + ids.length > RECHECK_ROWS_PER_HOUR) {
        throw new HttpError(429, "rate_limited", `Rechecks are limited to ${RECHECK_ROWS_PER_HOUR} backlinks per project per hour (${Math.max(0, RECHECK_ROWS_PER_HOUR - used)} left this hour).`, {
          retryAfterSeconds: 3600,
        });
      }
    }
    total = ids.length;
  } else {
    const r = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM backlinks WHERE workspace_id = ? AND project_id = ? AND active = 1", p.workspace_id, p.id);
    total = Number(r?.n ?? 0);
    if (total === 0) throw conflict("No backlinks to check yet. Import your built links (Import page, destination “Backlinks to monitor”) first.");
    if (opts.trigger === "manual" && (await manualChecksToday(db, p, now)) >= MANUAL_CHECKS_PER_DAY) {
      throw new HttpError(429, "rate_limited", `“Run backlink check” is limited to ${MANUAL_CHECKS_PER_DAY} per project per UTC day. The weekly check still runs.`, {
        retryAfterSeconds: Math.max(1, Math.ceil((new Date(`${utcDay(now)}T00:00:00.000Z`).getTime() + 86_400_000 - now.getTime()) / 1000)),
      });
    }
  }
  const id = newId("bljob");
  const ts = iso(now);
  try {
    await db.run(
      `INSERT INTO backlink_jobs (id, workspace_id, project_id, trigger, scope, ids_json, status, total, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'queued',?,?,?,?)`,
      id, p.workspace_id, p.id, opts.trigger, scope, JSON.stringify(ids), total, opts.userId, ts, ts,
    );
  } catch (e) {
    // Two requests raced past the check above: the partial unique index keeps one active job per scope.
    if (e instanceof Error && /unique/i.test(e.message)) {
      const again = (await activeJobs(db, p)).find((j) => j.scope === scope);
      if (again) return { job: toJobView(again), existing: true };
    }
    throw e;
  }
  await pruneJobs(db, p);
  return { job: toJobView((await loadJob(db, p.workspace_id, id))!), existing: false };
}

async function pruneJobs(db: Db, p: ProjectRow): Promise<void> {
  await db.run(
    `DELETE FROM backlink_jobs WHERE workspace_id = ? AND project_id = ? AND status NOT IN ('queued', 'running') AND id NOT IN (
       SELECT id FROM backlink_jobs WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    p.workspace_id,
    p.id,
    p.workspace_id,
    p.id,
    JOBS_KEPT_PER_PROJECT,
  );
}

// ------------------------------------------------------------------ batch
export interface BatchOptions {
  now?: () => Date;
  /** Wall-clock deadline (ms from the start of the batch) after which no new backlink is started. */
  deadlineMs?: number;
  fetchLimit?: number;
  itemLimit?: number;
  deps?: CheckDeps;
}

export interface BatchOutcome {
  status: "processed" | "busy" | "done" | "missing";
  checked: number;
  fetches: number;
  job: JobDbRow | null;
}

const ownHost = (p: ProjectRow) => normalizeHost(p.verified_host ?? siteHost(p.site_url)).replace(/^www\./, "");

function cacheKeysFor(items: BacklinkDbRow[], p: ProjectRow): string[] {
  const keys = new Set<string>();
  for (const b of items) {
    try {
      const u = new URL(b.live_url);
      const host = normalizeHost(u.hostname);
      keys.add(`robots:${u.protocol}//${host}`);
      keys.add(`pace:${host}`);
    } catch {
      /* invalid stored URL: the check records it */
    }
    keys.add(`target:${b.target_url_key}`);
  }
  if (p.verified_host) {
    keys.add(`robots:https://${normalizeHost(p.verified_host)}`);
    keys.add(`pace:${normalizeHost(p.verified_host)}`);
  }
  return [...keys].slice(0, 90);
}

async function loadCache(db: Db, job: JobDbRow, keys: string[]): Promise<JobCache> {
  const cache = emptyCache();
  if (!keys.length) return cache;
  const rows = await db.all<{ cache_key: string; value_json: string }>(
    `SELECT cache_key, value_json FROM backlink_job_cache WHERE job_id = ? AND workspace_id = ? AND cache_key IN (${keys.map(() => "?").join(",")})`,
    job.id,
    job.workspace_id,
    ...keys,
  );
  for (const r of rows) {
    const [kind, ...rest] = r.cache_key.split(":");
    const k = rest.join(":");
    if (kind === "robots") cache.robots.set(k, parseJson<RobotsVerdict>(r.value_json, { status: "unreachable", httpStatus: null, group: null }));
    else if (kind === "pace") cache.pace.set(k, Number(parseJson<number>(r.value_json, 0)));
    else if (kind === "target") cache.targets.set(k, parseJson<TargetResult>(r.value_json, { status: null, finalUrl: null, error: "error" }));
  }
  return cache;
}

function cacheStatements(job: JobDbRow, cache: JobCache, now: Date): Array<[string, ...unknown[]]> {
  const out: Array<[string, ...unknown[]]> = [];
  for (const key of cache.dirty) {
    const [kind, ...rest] = key.split(":");
    const k = rest.join(":");
    const value = kind === "robots" ? cache.robots.get(k) : kind === "pace" ? cache.pace.get(k) : kind === "target" ? cache.targets.get(k) : undefined;
    if (value === undefined) continue;
    out.push([
      `INSERT INTO backlink_job_cache (job_id, cache_key, workspace_id, project_id, value_json, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT (job_id, cache_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      job.id, key.slice(0, 1000), job.workspace_id, job.project_id, JSON.stringify(value), iso(now),
    ]);
  }
  return out;
}

function snapshotOf(c: CheckDbRow): CheckSnapshot {
  const links = parseJson<Array<{ href?: string; match?: string }>>(c.links_json, []);
  return {
    status: c.status as BacklinkStatus,
    linkRel: (c.link_rel as CheckSnapshot["linkRel"]) ?? null,
    httpStatus: c.http_status === null ? null : Number(c.http_status),
    finalUrl: c.final_url,
    anchorFound: c.anchor_found,
    pageNoindex: Number(c.page_noindex) === 1,
    targetStatus: c.target_status === null ? null : Number(c.target_status),
    targetError: c.target_error,
    canonicalUrl: c.canonical_url,
    linkMatch: (c.link_match as CheckSnapshot["linkMatch"]) ?? null,
    linkHref: links[0]?.href ?? null,
    statusReason: c.status_reason,
  };
}

function snapshotOfResult(r: CheckResult): CheckSnapshot {
  const first = r.links.find((l) => l.match === "target") ?? r.links[0];
  return {
    status: r.status,
    linkRel: r.linkRel,
    httpStatus: r.httpStatus,
    finalUrl: r.finalUrl,
    anchorFound: r.anchorFound,
    pageNoindex: r.pageNoindex,
    targetStatus: r.targetStatus,
    targetError: r.targetError,
    canonicalUrl: r.canonicalUrl,
    linkMatch: r.linkMatch,
    linkHref: first?.href ?? null,
    statusReason: r.statusReason,
  };
}

/** Claim the job's lease; false when another invocation holds it or the job is finished. */
async function claim(db: Db, job: JobDbRow, now: Date): Promise<boolean> {
  const r = await db.run(
    `UPDATE backlink_jobs SET status = 'running', lease_until = ?, started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE workspace_id = ? AND id = ? AND status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < ?)`,
    iso(addSeconds(now, LEASE_SECONDS)),
    iso(now),
    iso(now),
    job.workspace_id,
    job.id,
    iso(now),
  );
  return r.changes === 1;
}

function pendingWhere(job: JobDbRow): { sql: string; params: unknown[] } {
  const ids = job.scope === "ids" ? parseJson<string[]>(job.ids_json, []).slice(0, MAX_RECHECK_IDS) : [];
  return {
    sql: `workspace_id = ? AND project_id = ? AND active = 1 AND (last_job_id IS NULL OR last_job_id <> ?)${job.scope === "ids" ? ` AND id IN (${ids.length ? ids.map(() => "?").join(",") : "NULL"})` : ""}`,
    params: [job.workspace_id, job.project_id, job.id, ...ids],
  };
}

/**
 * Process one batch of a job. Never throws for page problems (they are check results); returns "busy" when another
 * invocation holds the lease and "done" when nothing was left (the job is completed).
 */
export async function processBatch(env: Env, db: Db, jobId: string, workspaceId: string, opts: BatchOptions = {}): Promise<BatchOutcome> {
  const clock = opts.now ?? (() => new Date());
  const startedMs = Date.now();
  const deadline = opts.deadlineMs ?? REQUEST_BATCH_DEADLINE_MS;
  let job = await loadJob(db, workspaceId, jobId);
  if (!job) return { status: "missing", checked: 0, fetches: 0, job: null };
  if (job.status === "completed" || job.status === "failed") return { status: "done", checked: 0, fetches: 0, job };
  if (!(await claim(db, job, clock()))) return { status: "busy", checked: 0, fetches: 0, job };

  const project = await loadProjectRow(db, job.workspace_id, job.project_id);
  if (!project) {
    await finish(db, job, clock(), "failed", "Project not found.");
    return { status: "done", checked: 0, fetches: 0, job: await loadJob(db, workspaceId, jobId) };
  }
  const where = pendingWhere(job);
  const items = await db.all<BacklinkDbRow>(`SELECT * FROM backlinks WHERE ${where.sql} ORDER BY id LIMIT ?`, ...where.params, opts.itemLimit ?? ITEMS_PER_INVOCATION);
  if (items.length === 0) {
    await finish(db, job, clock(), "completed", null);
    return { status: "done", checked: 0, fetches: 0, job: await loadJob(db, workspaceId, jobId) };
  }

  const cache = await loadCache(db, job, cacheKeysFor(items, project));
  const prevIds = items.map((b) => b.last_check_id).filter((x): x is string => !!x);
  const prevChecks = new Map<string, CheckDbRow>();
  if (prevIds.length) {
    const rows = await db.all<CheckDbRow>(
      `SELECT * FROM backlink_checks WHERE workspace_id = ? AND project_id = ? AND id IN (${prevIds.map(() => "?").join(",")})`,
      job.workspace_id,
      job.project_id,
      ...prevIds,
    );
    for (const r of rows) prevChecks.set(r.backlink_id, r);
  }

  const deps = opts.deps ?? checkDeps(env);
  const budget = { limit: opts.fetchLimit ?? FETCHES_PER_INVOCATION, used: 0 };
  const site = { ourHost: ownHost(project), verifiedHost: project.verified_host ? normalizeHost(project.verified_host) : null };
  const stmts: Array<[string, ...unknown[]]> = [];
  let checked = 0;
  let failed = 0;
  let robotsBlocked = 0;
  let changes = 0;
  for (const b of items) {
    if (Date.now() - startedMs > deadline) break;
    const usedBefore = budget.used;
    let result: CheckResult;
    try {
      result = await checkBacklink({ liveUrl: b.live_url, targetUrl: b.target_url, anchorExpected: b.anchor_expected }, site, cache, budget, deps);
    } catch (e) {
      if (!(e instanceof FetchBudgetExhausted)) throw e;
      if (usedBefore > 0) break; // retried with a fresh budget in the next batch
      // Even a full budget was not enough (a very long robots/redirect chain): record it instead of retrying forever.
      result = {
        ...blankResult(),
        status: "fetch_failed",
        errorCode: "fetch_budget",
        statusReason: `Checking this page needs more than ${budget.limit} requests (robots.txt and redirect hops); not completed.`,
        fetches: budget.used - usedBefore,
      };
    }
    const now = clock();
    const ts = iso(now);
    const checkId = newId("blchk");
    const prev = prevChecks.get(b.id);
    const events = diffChecks(prev ? snapshotOf(prev) : null, snapshotOfResult(result));
    checked++;
    if (result.status === "fetch_failed" || result.status === "page_error") failed++;
    if (result.status === "robots_blocked") robotsBlocked++;
    changes += events.length;
    stmts.push([
      `INSERT INTO backlink_checks (id, workspace_id, project_id, backlink_id, job_id, checked_at, status, status_reason, link_rel, http_status, final_url,
         redirect_chain_json, robots, meta_robots, x_robots_tag, page_noindex, page_nofollow, canonical_url, link_match, links_json, rel_text, anchor_found,
         anchor_match, target_status, target_final_url, target_error, error_code, fetches, bytes, truncated)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      checkId, job.workspace_id, job.project_id, b.id, job.id, ts, result.status, clipN(result.statusReason, 600), result.linkRel, result.httpStatus, clipN(result.finalUrl, 2000),
      JSON.stringify(result.redirectChain.slice(0, 10).map((h) => ({ status: h.status, to: h.to.slice(0, 2000) }))), result.robots, clipN(result.metaRobots, 400), clipN(result.xRobotsTag, 300),
      result.pageNoindex ? 1 : 0, result.pageNofollow ? 1 : 0, clipN(result.canonicalUrl, 2000), result.linkMatch, JSON.stringify(result.links.slice(0, 20)), clipN(result.relText, 200),
      clipN(result.anchorFound, 200), result.anchorMatch === null ? null : result.anchorMatch ? 1 : 0, result.targetStatus, clipN(result.targetFinalUrl, 2000), result.targetError,
      result.errorCode, result.fetches, result.bytes, result.truncated ? 1 : 0,
    ]);
    for (const e of events) {
      stmts.push([
        `INSERT INTO backlink_events (id, workspace_id, project_id, backlink_id, check_id, job_id, kind, from_value, to_value, message, negative, detected_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        newId("blevt"), job.workspace_id, job.project_id, b.id, checkId, job.id, e.kind, e.from, e.to, e.message, e.negative ? 1 : 0, ts,
      ]);
    }
    const lastEvent = events.find((e) => e.negative) ?? events[0] ?? null;
    stmts.push([
      `UPDATE backlinks SET status = ?, status_reason = ?, link_rel = ?, http_status = ?, final_url = ?, anchor_found = ?, anchor_match = ?, rel_text = ?, page_noindex = ?,
         target_status = ?, target_error = ?, last_checked_at = ?, last_check_id = ?, last_job_id = ?,
         last_change_at = CASE WHEN ? IS NULL THEN last_change_at ELSE ? END,
         last_change_text = CASE WHEN ? IS NULL THEN last_change_text ELSE ? END,
         last_change_negative = CASE WHEN ? IS NULL THEN last_change_negative ELSE ? END,
         updated_at = ?
       WHERE workspace_id = ? AND project_id = ? AND id = ?`,
      result.status, clipN(result.statusReason, 600), result.linkRel, result.httpStatus, clipN(result.finalUrl, 2000), clipN(result.anchorFound, 200),
      result.anchorMatch === null ? null : result.anchorMatch ? 1 : 0, clipN(result.relText, 200), result.pageNoindex ? 1 : 0,
      result.targetStatus, result.targetError, ts, checkId, job.id,
      lastEvent ? ts : null, ts,
      lastEvent ? lastEvent.message : null, lastEvent?.message ?? null,
      lastEvent ? 1 : null, lastEvent ? (lastEvent.negative ? 1 : 0) : null,
      ts, job.workspace_id, job.project_id, b.id,
    ]);
    stmts.push([
      `DELETE FROM backlink_checks WHERE workspace_id = ? AND backlink_id = ? AND id NOT IN (
         SELECT id FROM backlink_checks WHERE workspace_id = ? AND backlink_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT ?)`,
      job.workspace_id, b.id, job.workspace_id, b.id, CHECKS_KEPT_PER_BACKLINK,
    ]);
    if (events.length) {
      stmts.push([
        `DELETE FROM backlink_events WHERE workspace_id = ? AND backlink_id = ? AND id NOT IN (
           SELECT id FROM backlink_events WHERE workspace_id = ? AND backlink_id = ? ORDER BY detected_at DESC, rowid DESC LIMIT ?)`,
        job.workspace_id, b.id, job.workspace_id, b.id, EVENTS_KEPT_PER_BACKLINK,
      ]);
    }
  }
  const now = clock();
  stmts.push(...cacheStatements(job, cache, now));
  stmts.push([
    `UPDATE backlink_jobs SET done = done + ?, failed = failed + ?, robots_blocked = robots_blocked + ?, changes = changes + ?, fetches = fetches + ?,
       batches = batches + 1, lease_until = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?`,
    checked, failed, robotsBlocked, changes, budget.used, iso(now), job.workspace_id, job.id,
  ]);
  await db.batch(stmts);

  const left = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM backlinks WHERE ${where.sql}`, ...where.params);
  job = (await loadJob(db, workspaceId, jobId))!;
  if (Number(left?.n ?? 0) === 0) {
    await finish(db, job, now, "completed", null);
    job = (await loadJob(db, workspaceId, jobId))!;
  }
  return { status: "processed", checked, fetches: budget.used, job };
}

const clipN = (s: string | null | undefined, n: number) => (s === null || s === undefined ? null : s.length > n ? s.slice(0, n) : s);

function blankResult(): CheckResult {
  return {
    status: "fetch_failed",
    statusReason: null,
    linkRel: null,
    httpStatus: null,
    finalUrl: null,
    redirectChain: [],
    robots: null,
    metaRobots: null,
    xRobotsTag: null,
    pageNoindex: false,
    pageNofollow: false,
    canonicalUrl: null,
    linkMatch: null,
    links: [],
    relText: null,
    anchorFound: null,
    anchorMatch: null,
    targetStatus: null,
    targetFinalUrl: null,
    targetError: null,
    errorCode: null,
    fetches: 0,
    bytes: 0,
    truncated: false,
  };
}

async function finish(db: Db, job: JobDbRow, now: Date, status: "completed" | "failed", note: string | null): Promise<void> {
  await db.batch([
    [
      `UPDATE backlink_jobs SET status = ?, note = COALESCE(?, note), lease_until = NULL, finished_at = ?, updated_at = ?,
         total = CASE WHEN ? = 'completed' THEN done ELSE total END
       WHERE workspace_id = ? AND id = ? AND status IN ('queued', 'running')`,
      status, note, iso(now), iso(now), status, job.workspace_id, job.id,
    ],
    ["DELETE FROM backlink_job_cache WHERE job_id = ? AND workspace_id = ?", job.id, job.workspace_id],
  ]);
}

/** Process one batch of the project's oldest active job whose lease is free (POST /backlinks/check/advance). */
export async function advanceProject(env: Env, db: Db, p: ProjectRow, opts: BatchOptions = {}): Promise<BatchOutcome | null> {
  const jobs = await activeJobs(db, p);
  // Rechecks (a few rows the user is waiting for) go before a long full check.
  const ordered = [...jobs].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "ids" ? -1 : 1));
  for (const j of ordered) {
    const out = await processBatch(env, db, j.id, j.workspace_id, opts);
    if (out.status !== "busy") return out;
  }
  return null;
}

// ------------------------------------------------------------------ cron
/**
 * Cron tick (index.ts, every 15 min): fail stalled jobs, give up to SCHEDULES_PER_TICK projects their weekly job
 * (scheduled runs enabled, not demo, at least one active backlink, no full job in the last SCHEDULED_CHECK_DAYS
 * days), then process ONE batch of the oldest active job with a free lease (rechecks first). Missing tables (migration
 * not applied) are a no-op.
 */
export async function processDueBacklinkChecks(env: Env, now: Date, opts: BatchOptions = {}): Promise<{ scheduled: number; processed: number }> {
  const db = new Db(env.DB);
  try {
    await db.run(
      `UPDATE backlink_jobs SET status = 'failed', note = 'Stopped: no progress for ${STALLED_JOB_DAYS} days.', lease_until = NULL, finished_at = ?, updated_at = ?
        WHERE status IN ('queued', 'running') AND updated_at < ?`,
      iso(now),
      iso(now),
      iso(addSeconds(now, -STALLED_JOB_DAYS * 86_400)),
    );
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) return { scheduled: 0, processed: 0 };
    throw e;
  }
  const due = await db.all<{ id: string; workspace_id: string }>(
    `SELECT p.id, p.workspace_id FROM projects p
      WHERE p.schedule_enabled = 1 AND p.is_demo = 0
        AND EXISTS (SELECT 1 FROM backlinks b WHERE b.workspace_id = p.workspace_id AND b.project_id = p.id AND b.active = 1)
        AND NOT EXISTS (SELECT 1 FROM backlink_jobs j WHERE j.workspace_id = p.workspace_id AND j.project_id = p.id AND j.scope = 'all'
                          AND (j.status IN ('queued', 'running') OR j.created_at >= ?))
      ORDER BY p.id LIMIT ?`,
    iso(addSeconds(now, -SCHEDULED_CHECK_DAYS * 86_400)),
    SCHEDULES_PER_TICK,
  );
  let scheduled = 0;
  for (const d of due) {
    const p = await loadProjectRow(db, d.workspace_id, d.id);
    if (!p) continue;
    try {
      await createJob(db, p, { userId: null, trigger: "scheduled", now });
      scheduled++;
    } catch (e) {
      console.error("backlink schedule failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    }
  }
  const next = await db.first<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id FROM backlink_jobs WHERE status IN ('queued', 'running') AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY CASE scope WHEN 'ids' THEN 0 ELSE 1 END, updated_at, id LIMIT 1`,
    iso(now),
  );
  let processed = 0;
  if (next) {
    const out = await processBatch(env, db, next.id, next.workspace_id, { deadlineMs: CRON_BATCH_DEADLINE_MS, ...opts });
    processed = out.checked;
  }
  return { scheduled, processed };
}
