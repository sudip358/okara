/**
 * Backlink browser fallback: re-check ONE queued backlink per invocation in Cloudflare's headless browser (Browser Run,
 * formerly Browser Rendering; Workers binding `BROWSER`, library @cloudflare/puppeteer). docs/build-kit.md [A38]
 * (2026-10-05 update), docs/api.md "Backlinks".
 *
 * Queueing (jobs.ts, shared needsBrowserRecheck): a plain check that ends as `missing`, `page_error` with HTTP
 * 403/429/503 (bot wall) or `fetch_failed` (not an SSRF refusal) sets browser_state = 'pending'. The plain check is
 * stored (method plain) but its events wait: they are computed once, on the final result, against the previous final
 * check (browser_base_check_id).
 *
 * This step (run by POST /backlinks/check/advance when the invocation did no plain work, and by the 15-minute cron
 * after its plain batch):
 *   1. no BROWSER binding / cap 0 -> pending rows become 'unavailable' (plain result final, events on it); never faked;
 *   2. the account's daily browser budget (browser_usage, UTC day, default 8 of the free 10 minutes) cannot cover a
 *      reservation -> nothing launches, rows stay pending (deferred to the next UTC day, never dropped);
 *   3. a single global lease (browser_lease) keeps Okara at ONE browser at a time and >= 20 s between launches;
 *   4. the live URL is validated with assertPublicExternalUrl BEFORE launching; with request interception every
 *      request of the page (main document, redirect hops, subresources) is re-validated the same way (public http(s)
 *      hosts only; data:/blob: allowed, anything else aborted) and images / media / fonts are aborted to save time;
 *   5. navigate (20 s timeout, DOM ready, then a bounded wait for network idle), read the main response's HTTP status
 *      and X-Robots-Tag, the final URL and the rendered DOM (page.content(), capped at PAGE_MAX_BYTES), and classify it
 *      with the SAME code as the plain check (check.ts classifyLoadedPage -> html.ts analyzePage);
 *   6. page and browser are closed in finally; the measured wall time replaces the pre-charged reservation.
 * The browser result supersedes the plain one for the status (both kept in the history, method plain/browser). When
 * the browser cannot load the page the browser attempt is kept in the history and the plain result stays final.
 * Rendered page text is never stored and never sent to a model; only the same compact facts as a plain check.
 */
import {
  BROWSER_DAILY_CAP_MAX_MS,
  BROWSER_DAILY_CAP_MS,
  BROWSER_IDLE_WAIT_MS,
  BROWSER_LAUNCH_INTERVAL_MS,
  BROWSER_MAX_ATTEMPTS,
  BROWSER_NAV_TIMEOUT_MS,
  BROWSER_RESERVE_MS,
  PAGE_MAX_BYTES,
  statusText,
  type BacklinkStatus,
  type BrowserSummary,
} from "@shared/backlinks";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { newId } from "../lib/ids";
import { addSeconds, iso, utcDay } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { loadProjectRow, siteHost } from "../platform/projects";
import { assertPublicExternalUrl, normalizeHost } from "../seo/ssrf";
import { classifyLoadedPage, type CheckResult } from "./check";
import { diffChecks } from "./events";
import { backlinkUpdateStmt, blankResult, checkInsertStmt, eventStmts, pruneChecksStmt, resultOfCheck, snapshotOf, snapshotOfResult, type Stmt } from "./record";
import type { BacklinkDbRow, CheckDbRow } from "./store";

// ------------------------------------------------------------------ the browser surface we use
/** The subset of @cloudflare/puppeteer's HTTPRequest used here (tests pass fakes). */
export interface BrowserRequest {
  url(): string;
  resourceType(): string;
  isNavigationRequest(): boolean;
  abort(errorCode?: "blockedbyclient" | "accessdenied" | "failed"): Promise<void>;
  continue(): Promise<void>;
  response?(): BrowserResponse | null;
  redirectChain?(): BrowserRequest[];
}

export interface BrowserResponse {
  status(): number;
  url(): string;
  headers(): Record<string, string>;
  request?(): BrowserRequest;
}

export interface BrowserPage {
  setRequestInterception(on: boolean): Promise<void>;
  on(event: "request", handler: (req: BrowserRequest) => void): unknown;
  goto(url: string, opts: { waitUntil: "domcontentloaded" | "load"; timeout: number }): Promise<BrowserResponse | null>;
  waitForNetworkIdle?(opts: { idleTime: number; timeout: number }): Promise<void>;
  url(): string;
  content(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserSession {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

/** Launch one browser session on the binding (production: @cloudflare/puppeteer launch(env.BROWSER)). */
export type BrowserLauncher = (binding: Fetcher) => Promise<BrowserSession>;

const puppeteerLauncher: BrowserLauncher = async (binding) => {
  // Loaded on first use only, so tests (Node) and invocations without browser work never load the library.
  const mod = await import("@cloudflare/puppeteer");
  const browser = await mod.default.launch(binding as unknown as Parameters<typeof mod.default.launch>[0]);
  return browser as unknown as BrowserSession;
};

let launcherOverride: BrowserLauncher | null = null;
/** Test hook: the launcher used instead of @cloudflare/puppeteer (a fake session / page). */
export function setBrowserLauncher(l: BrowserLauncher | null) {
  launcherOverride = l;
}

// ------------------------------------------------------------------ config
export interface BrowserConfig {
  available: boolean;
  reason: string | null;
  capMs: number;
}

/** Daily cap: BACKLINK_BROWSER_MS_PER_DAY (ms) or the 8-minute default, clamped to [0, BROWSER_DAILY_CAP_MAX_MS]. */
export function browserCapMs(env: Pick<Env, "BACKLINK_BROWSER_MS_PER_DAY">): number {
  const raw = env.BACKLINK_BROWSER_MS_PER_DAY;
  if (raw === undefined || raw === null || String(raw).trim() === "") return BROWSER_DAILY_CAP_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return BROWSER_DAILY_CAP_MS;
  return Math.max(0, Math.min(Math.floor(n), BROWSER_DAILY_CAP_MAX_MS));
}

export function browserConfig(env: Pick<Env, "BROWSER" | "BACKLINK_BROWSER_MS_PER_DAY">): BrowserConfig {
  const capMs = browserCapMs(env);
  if (!env.BROWSER) return { available: false, reason: "no Browser Run binding (BROWSER) is configured", capMs };
  if (capMs <= 0) return { available: false, reason: "browser re-checks are turned off (BACKLINK_BROWSER_MS_PER_DAY = 0)", capMs };
  return { available: true, reason: null, capMs };
}

// ------------------------------------------------------------------ usage + lease (operator-level, whole account)
export interface BrowserUsage {
  day: string;
  msUsed: number;
  sessions: number;
  exhausted: boolean;
}

const missing = (e: unknown) => e instanceof Error && /no such (table|column)/i.test(e.message);

export async function browserUsage(db: Db, now: Date): Promise<BrowserUsage> {
  const day = utcDay(now);
  const r = await db.first<{ ms_used: number; sessions: number; exhausted: number }>("SELECT ms_used, sessions, exhausted FROM browser_usage WHERE day = ?", day);
  return { day, msUsed: Number(r?.ms_used ?? 0), sessions: Number(r?.sessions ?? 0), exhausted: Number(r?.exhausted ?? 0) === 1 };
}

const usageAddStmt = (day: string, ms: number, sessions: number, ts: string): Stmt => [
  `INSERT INTO browser_usage (day, ms_used, sessions, exhausted, updated_at) VALUES (?, ?, ?, 0, ?)
   ON CONFLICT (day) DO UPDATE SET ms_used = ms_used + excluded.ms_used, sessions = sessions + excluded.sessions, updated_at = excluded.updated_at`,
  day, Math.max(0, ms), sessions, ts,
];
/** Replace the pre-charged reservation with the measured time (the row exists: the reservation created it). */
const usageAdjustStmt = (day: string, deltaMs: number, ts: string): Stmt => ["UPDATE browser_usage SET ms_used = MAX(0, ms_used + ?), updated_at = ? WHERE day = ?", deltaMs, ts, day];

/** The daily budget cannot cover one more re-check (the reservation), or Browser Run said the day's time is used up. */
export const budgetExhausted = (u: BrowserUsage, capMs: number) => u.exhausted || u.msUsed + BROWSER_RESERVE_MS > capMs;

const nextUtcDay = (now: Date) => new Date(`${utcDay(addSeconds(now, 86_400))}T00:00:00.000Z`);

async function claimLease(db: Db, now: Date): Promise<boolean> {
  const ts = iso(now);
  await db.run("INSERT OR IGNORE INTO browser_lease (id, lease_until, last_launch_at, last_error, updated_at) VALUES ('global', NULL, NULL, NULL, ?)", ts);
  const r = await db.run(
    `UPDATE browser_lease SET lease_until = ?, last_launch_at = ?, updated_at = ?
      WHERE id = 'global' AND (lease_until IS NULL OR lease_until < ?) AND (last_launch_at IS NULL OR last_launch_at <= ?)`,
    iso(addSeconds(now, BROWSER_LEASE_SECONDS)),
    ts,
    ts,
    ts,
    iso(new Date(now.getTime() - BROWSER_LAUNCH_INTERVAL_MS)),
  );
  return r.changes === 1;
}

/** A browser step holding the lease longer than this was interrupted (Browser Run closes an idle browser after 60 s). */
export const BROWSER_LEASE_SECONDS = 90;

// ------------------------------------------------------------------ render
const ABORTED_TYPES = new Set(["image", "media", "font"]);

export interface InterceptStats {
  /** Requests refused by the SSRF guard (non-public host, IP literal, credentials, port, scheme). */
  blocked: string[];
  /** Images / media / fonts aborted. */
  media: number;
  /** A navigation request (main document or redirect hop) was refused. */
  navigationBlocked: string | null;
}

/** Request interception: the same public-host guard as every plain request, plus no images / media / fonts. */
export async function interceptRequest(req: BrowserRequest, stats: InterceptStats): Promise<void> {
  try {
    const u = req.url();
    if (/^(data|blob):/i.test(u)) {
      if (ABORTED_TYPES.has(req.resourceType())) {
        stats.media++;
        await req.abort("blockedbyclient");
      } else await req.continue();
      return;
    }
    let allowed = /^https?:/i.test(u);
    if (allowed) {
      try {
        assertPublicExternalUrl(u);
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      stats.blocked.push(u.slice(0, 300));
      if (req.isNavigationRequest() && !stats.navigationBlocked) stats.navigationBlocked = u.slice(0, 300);
      await req.abort("blockedbyclient");
      return;
    }
    if (ABORTED_TYPES.has(req.resourceType())) {
      stats.media++;
      await req.abort("blockedbyclient");
      return;
    }
    await req.continue();
  } catch {
    /* already handled / page closed */
  }
}

export type RenderOutcome =
  | { ok: true; status: number; finalUrl: string; html: string; truncated: boolean; xRobotsTag: string | null; redirectChain: Array<{ status: number; to: string }>; stats: InterceptStats }
  | { ok: false; code: string; message: string; stats: InterceptStats };

function chainOf(res: BrowserResponse): Array<{ status: number; to: string }> {
  try {
    const reqs = res.request?.()?.redirectChain?.() ?? [];
    return reqs.slice(0, 10).map((r, i) => ({ status: Number(r.response?.()?.status() ?? 0), to: (reqs[i + 1]?.url() ?? res.url()).slice(0, 2000) }));
  } catch {
    return [];
  }
}

/** Render one article (the URL must already be validated). Closes the page in finally; the caller closes the session. */
export async function renderArticle(session: BrowserSession, url: string): Promise<RenderOutcome> {
  const stats: InterceptStats = { blocked: [], media: 0, navigationBlocked: null };
  const page = await session.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => void interceptRequest(req, stats));
    let res: BrowserResponse | null;
    try {
      res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_NAV_TIMEOUT_MS });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (stats.navigationBlocked) return { ok: false, code: "redirect_offsite", message: `A redirect to a non-public address was refused (${stats.navigationBlocked}).`, stats };
      if (/timeout|timed out/i.test(msg)) return { ok: false, code: "timeout", message: `The page did not load within ${BROWSER_NAV_TIMEOUT_MS / 1000} s in the browser.`, stats };
      return { ok: false, code: "error", message: `The browser could not load the page (${msg.slice(0, 160)}).`, stats };
    }
    if (!res) return { ok: false, code: "error", message: "The browser got no response for the page.", stats };
    if (page.waitForNetworkIdle) {
      try {
        await page.waitForNetworkIdle({ idleTime: 500, timeout: BROWSER_IDLE_WAIT_MS });
      } catch {
        /* a page that never goes idle is read as it is */
      }
    }
    let html = await page.content();
    let truncated = false;
    if (html.length > PAGE_MAX_BYTES) {
      html = html.slice(0, PAGE_MAX_BYTES);
      truncated = true;
    }
    const headers = res.headers() ?? {};
    const xrt = headers["x-robots-tag"] ?? headers["X-Robots-Tag"] ?? null;
    return { ok: true, status: res.status(), finalUrl: page.url() || res.url(), html, truncated, xRobotsTag: xrt, redirectChain: chainOf(res), stats };
  } finally {
    await page.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------------ the step
export interface BrowserStepOptions {
  now?: () => Date;
  /** Monotonic milliseconds for the measured browser time (tests inject a fake). */
  elapsedMs?: () => number;
  launcher?: BrowserLauncher;
}

export interface BrowserStepOutcome {
  status: "idle" | "unavailable" | "deferred" | "busy" | "rechecked" | "failed" | "launch_failed";
  backlinkId: string | null;
  /** Browser milliseconds charged for this step. */
  chargedMs: number;
}

const ownHost = (p: ProjectRow) => normalizeHost(p.verified_host ?? siteHost(p.site_url)).replace(/^www\./, "");

async function pendingRows(db: Db, scope: { project?: ProjectRow }, limit: number): Promise<BacklinkDbRow[]> {
  if (scope.project) {
    return db.all<BacklinkDbRow>(
      "SELECT * FROM backlinks WHERE workspace_id = ? AND project_id = ? AND active = 1 AND browser_state = 'pending' ORDER BY browser_queued_at, id LIMIT ?",
      scope.project.workspace_id,
      scope.project.id,
      limit,
    );
  }
  // Cron (operator-level, like the job queue): the oldest pending row of any project, demo projects excluded.
  return db.all<BacklinkDbRow>(
    `SELECT b.* FROM backlinks b JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
      WHERE b.active = 1 AND b.browser_state = 'pending' AND p.is_demo = 0 ORDER BY b.browser_queued_at, b.id LIMIT ?`,
    limit,
  );
}

async function loadChecks(db: Db, b: BacklinkDbRow): Promise<{ plain: CheckDbRow | null; base: CheckDbRow | null }> {
  const ids = [b.last_check_id, b.browser_base_check_id].filter((x): x is string => !!x);
  if (!ids.length) return { plain: null, base: null };
  const rows = await db.all<CheckDbRow>(
    `SELECT * FROM backlink_checks WHERE workspace_id = ? AND project_id = ? AND backlink_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    b.workspace_id,
    b.project_id,
    b.id,
    ...ids,
  );
  return { plain: rows.find((r) => r.id === b.last_check_id) ?? null, base: rows.find((r) => r.id === b.browser_base_check_id) ?? null };
}

/** The plain result becomes final (browser unavailable / failed): its events are computed now, against the base. */
function finalizePlainStmts(b: BacklinkDbRow, plain: CheckDbRow, base: CheckDbRow | null, ts: string, state: "unavailable" | "failed", reason: string): Stmt[] {
  const result = resultOfCheck(plain);
  const events = diffChecks(base ? snapshotOf(base) : null, snapshotOfResult(result));
  return [
    ...eventStmts(b, plain.id, plain.job_id, ts, events),
    backlinkUpdateStmt(b, plain.checked_at, result, plain.id, null, "plain", events, { state, reason, baseCheckId: null, queuedAt: null, attempts: Number(b.browser_attempts ?? 0) }),
    ...(events.length && plain.job_id ? [jobChangesStmt(b, plain.job_id, events.length)] : []),
  ];
}

const jobChangesStmt = (b: BacklinkDbRow, jobId: string, n: number): Stmt => ["UPDATE backlink_jobs SET changes = changes + ? WHERE workspace_id = ? AND id = ?", n, b.workspace_id, jobId];

/** Pending rows whose plain check is gone (pruned / never stored) are simply cleared. */
const clearStmt = (b: BacklinkDbRow, ts: string): Stmt => [
  "UPDATE backlinks SET browser_state = NULL, browser_reason = NULL, browser_base_check_id = NULL, browser_queued_at = NULL, updated_at = ? WHERE workspace_id = ? AND project_id = ? AND id = ?",
  ts, b.workspace_id, b.project_id, b.id,
];

/** No browser: up to `limit` pending rows become "browser unavailable" with the reason; their plain result is final. */
async function resolveUnavailable(db: Db, scope: { project?: ProjectRow }, reason: string, now: Date, limit = 8): Promise<number> {
  const rows = await pendingRows(db, scope, limit);
  const ts = iso(now);
  const stmts: Stmt[] = [];
  for (const b of rows) {
    const { plain, base } = await loadChecks(db, b);
    if (!plain) stmts.push(clearStmt(b, ts));
    else stmts.push(...finalizePlainStmts(b, plain, base, ts, "unavailable", `Browser re-check unavailable: ${reason}. The plain-fetch result is kept.`));
  }
  if (stmts.length) await db.batch(stmts);
  return rows.length;
}

const launchErrorKind = (msg: string): "daily_limit" | "rate_limited" | "other" =>
  /time limit exceeded/i.test(msg) ? "daily_limit" : /\b429\b|rate.?limit|too many/i.test(msg) ? "rate_limited" : "other";

/**
 * One browser re-check (or none). `scope.project` = the project of an advance request; omitted = the cron (any
 * project). Never throws for page problems; D1 errors propagate to the caller's catch.
 */
export async function processBrowserStep(env: Env, db: Db, scope: { project?: ProjectRow }, opts: BrowserStepOptions = {}): Promise<BrowserStepOutcome> {
  const clock = opts.now ?? (() => new Date());
  const elapsed = opts.elapsedMs ?? (() => Date.now());
  const none = (status: BrowserStepOutcome["status"], backlinkId: string | null = null, chargedMs = 0): BrowserStepOutcome => ({ status, backlinkId, chargedMs });
  if (scope.project?.is_demo === 1) return none("idle");
  const cfg = browserConfig(env);
  try {
    if (!cfg.available) {
      const n = await resolveUnavailable(db, scope, cfg.reason ?? "unavailable", clock());
      return none(n ? "unavailable" : "idle");
    }
    const [b] = await pendingRows(db, scope, 1);
    if (!b) return none("idle");
    const usage = await browserUsage(db, clock());
    if (budgetExhausted(usage, cfg.capMs)) return none("deferred", b.id);

    const { plain, base } = await loadChecks(db, b);
    if (!plain) {
      await db.batch([clearStmt(b, iso(clock()))]);
      return none("idle", b.id);
    }
    let url: URL;
    try {
      url = assertPublicExternalUrl(b.live_url);
    } catch {
      await db.batch(finalizePlainStmts(b, plain, base, iso(clock()), "failed", "The live URL is not a public http(s) URL; it is never opened in the browser."));
      return none("failed", b.id);
    }
    const project = await loadProjectRow(db, b.workspace_id, b.project_id);
    if (!project) return none("idle", b.id);

    if (!(await claimLease(db, clock()))) return none("busy", b.id);
    const day = utcDay(clock());
    // Pre-charge the reservation, so an invocation cut off mid-render still counts against the day's budget.
    await db.batch([usageAddStmt(day, BROWSER_RESERVE_MS, 1, iso(clock()))]);

    const t0 = elapsed();
    let session: BrowserSession | null = null;
    let launchError: string | null = null;
    let outcome: RenderOutcome | null = null;
    try {
      try {
        session = await (opts.launcher ?? launcherOverride ?? puppeteerLauncher)(env.BROWSER!);
      } catch (e) {
        launchError = (e instanceof Error ? e.message : String(e)).slice(0, 300) || "launch failed";
      }
      if (session) outcome = await renderArticle(session, url.toString());
    } catch (e) {
      outcome = { ok: false, code: "error", message: `The browser failed (${(e instanceof Error ? e.message : String(e)).slice(0, 160)}).`, stats: { blocked: [], media: 0, navigationBlocked: null } };
    } finally {
      if (session) await session.close().catch(() => undefined);
    }
    const usedMs = Math.max(0, Math.round(elapsed() - t0));
    const now = clock();
    const ts = iso(now);
    const stmts: Stmt[] = [
      usageAdjustStmt(day, usedMs - BROWSER_RESERVE_MS, ts),
      ["UPDATE browser_lease SET lease_until = NULL, last_error = ?, updated_at = ? WHERE id = 'global'", launchError ?? (outcome && !outcome.ok ? outcome.message.slice(0, 300) : null), ts],
    ];

    if (launchError !== null) {
      const kind = launchErrorKind(launchError);
      if (kind === "daily_limit") {
        stmts.push(["UPDATE browser_usage SET exhausted = 1, updated_at = ? WHERE day = ?", ts, day]);
        await db.batch(stmts);
        return none("deferred", b.id, usedMs);
      }
      const attempts = Number(b.browser_attempts ?? 0) + (kind === "rate_limited" ? 0 : 1);
      if (attempts >= BROWSER_MAX_ATTEMPTS) {
        stmts.push(...finalizePlainStmts({ ...b, browser_attempts: attempts }, plain, base, ts, "unavailable", `Browser re-check unavailable: Browser Run refused to start a browser ${attempts} times (${launchError}). The plain-fetch result is kept.`));
      } else {
        stmts.push([
          "UPDATE backlinks SET browser_attempts = ?, browser_reason = ?, updated_at = ? WHERE workspace_id = ? AND project_id = ? AND id = ?",
          attempts, `Browser launch failed (${launchError.slice(0, 200)}); retrying.`, ts, b.workspace_id, b.project_id, b.id,
        ]);
      }
      await db.batch(stmts);
      return none("launch_failed", b.id, usedMs);
    }

    const plainResult = resultOfCheck(plain);
    const checkId = newId("blchk");
    const carried: CheckResult = {
      ...blankResult(),
      // Our target is not re-fetched: the plain check's result for it is carried over.
      targetStatus: plainResult.targetStatus,
      targetFinalUrl: plainResult.targetFinalUrl,
      targetError: plainResult.targetError,
      robots: plainResult.robots,
    };
    const input = { liveUrl: b.live_url, targetUrl: b.target_url, anchorExpected: b.anchor_expected };
    if (outcome && outcome.ok) {
      const browserResult = classifyLoadedPage(
        { ...carried, redirectChain: outcome.redirectChain, bytes: outcome.html.length },
        { status: outcome.status, finalUrl: outcome.finalUrl, startUrl: url.toString(), body: outcome.html, xRobotsTag: outcome.xRobotsTag, truncated: outcome.truncated },
        input,
        { ourHost: ownHost(project), verifiedHost: project.verified_host ? normalizeHost(project.verified_host) : null },
      );
      const events = diffChecks(base ? snapshotOf(base) : null, snapshotOfResult(browserResult));
      const reason = `Checked in a headless browser (Browser Run) because the plain fetch saw “${statusText(plain.status as BacklinkStatus, plainResult.httpStatus)}”.`;
      stmts.push(checkInsertStmt(b, checkId, plain.job_id, ts, browserResult, "browser"));
      stmts.push(...eventStmts(b, checkId, plain.job_id, ts, events));
      stmts.push(backlinkUpdateStmt(b, ts, browserResult, checkId, null, "browser", events, { state: null, reason, baseCheckId: null, queuedAt: null, attempts: 0 }));
      stmts.push(pruneChecksStmt(b));
      if (events.length && plain.job_id) stmts.push(jobChangesStmt(b, plain.job_id, events.length));
      await db.batch(stmts);
      return none("rechecked", b.id, usedMs);
    }
    const fail = outcome && !outcome.ok ? outcome : { code: "error", message: "The browser returned nothing." };
    const failed: CheckResult = { ...carried, status: "fetch_failed", errorCode: fail.code, statusReason: `Browser: ${fail.message}` };
    stmts.push(checkInsertStmt(b, checkId, plain.job_id, ts, failed, "browser"));
    stmts.push(...finalizePlainStmts(b, plain, base, ts, "failed", `Browser re-check failed: ${fail.message} The plain-fetch result is kept.`));
    stmts.push(pruneChecksStmt(b));
    await db.batch(stmts);
    return none("failed", b.id, usedMs);
  } catch (e) {
    if (missing(e)) return none("idle");
    throw e;
  }
}

// ------------------------------------------------------------------ summary
export async function browserSummary(db: Db, p: ProjectRow, env: Pick<Env, "BROWSER" | "BACKLINK_BROWSER_MS_PER_DAY">, now: Date): Promise<BrowserSummary> {
  const cfg = browserConfig(env);
  const out: BrowserSummary = {
    available: cfg.available,
    unavailableReason: cfg.reason,
    waiting: 0,
    unavailable: 0,
    failed: 0,
    usedMs: 0,
    capMs: cfg.capMs,
    deferred: false,
    deferredUntil: null,
  };
  try {
    const rows = await db.all<{ s: string; n: number }>(
      "SELECT browser_state AS s, COUNT(*) AS n FROM backlinks WHERE workspace_id = ? AND project_id = ? AND active = 1 AND browser_state IS NOT NULL GROUP BY browser_state",
      p.workspace_id,
      p.id,
    );
    for (const r of rows) {
      if (r.s === "pending") out.waiting = Number(r.n);
      else if (r.s === "unavailable") out.unavailable = Number(r.n);
      else if (r.s === "failed") out.failed = Number(r.n);
    }
    const u = await browserUsage(db, now);
    out.usedMs = u.msUsed;
    out.deferred = cfg.available && budgetExhausted(u, cfg.capMs);
    out.deferredUntil = out.deferred ? iso(nextUtcDay(now)) : null;
  } catch (e) {
    if (!missing(e)) throw e;
  }
  return out;
}
