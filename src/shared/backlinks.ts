/**
 * Backlink monitor: API contract and pure helpers shared by the Worker (checker, routes) and the web pages (Backlinks
 * page, Live Backlinks containers). No I/O here. docs/api.md "Backlinks", docs/build-kit.md [A38].
 *
 * Every string from the checked article (anchor text, URLs, robots values) and from the owner's sheet (vendor, type,
 * price) is untrusted text: stored and shown as plain text, never as instructions or HTML.
 */

// ------------------------------------------------------------------ limits
/** Monitored backlinks (active rows) per project. */
export const MAX_BACKLINKS_PER_PROJECT = 2_000;
/** Manual full checks ("Run backlink check") per project per UTC day. */
export const MANUAL_CHECKS_PER_DAY = 3;
/** Rows rechecked on request per project per hour (each id counts). */
export const RECHECK_ROWS_PER_HOUR = 30;
/** Ids accepted in one recheck request. */
export const MAX_RECHECK_IDS = 30;
/** Days between scheduled full checks of a project. */
export const SCHEDULED_CHECK_DAYS = 7;
/** Checks kept per backlink. */
export const CHECKS_KEPT_PER_BACKLINK = 10;
/** External fetches per invocation (robots.txt, redirect hops and our own target checks included). */
export const FETCHES_PER_INVOCATION = 20;
/** Backlinks started per invocation (CPU stays within the Workers Free 10 ms budget for typical pages). */
export const ITEMS_PER_INVOCATION = 8;
/** Page fetch caps. */
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 15_000;
export const MAX_REDIRECT_HOPS = 5;
/** Minimum milliseconds between two requests to the same host. */
export const HOST_INTERVAL_MS = 1_000;
/** Live view polls at most this often, and only while a check job runs. */
export const LIVE_POLL_MS = 2_000;

// ------------------------------------------------------------------ browser fallback (Browser Run)
/**
 * Browser re-checks run in Cloudflare's headless browser (Browser Run, binding BROWSER). Cloudflare's published Workers
 * Free allowance (developers.cloudflare.com/browser-run/pricing/ and /limits/, checked 2026-10-05): 10 minutes of
 * browser time per day, 3 concurrent browsers, 1 new browser instance every 20 seconds.
 */
export const BROWSER_FREE_DAILY_MS = 600_000;
/** Default daily cap Okara stops at (8 minutes), below the free allowance. Override: BACKLINK_BROWSER_MS_PER_DAY. */
export const BROWSER_DAILY_CAP_MS = 480_000;
/** Highest accepted override: one reservation below the free allowance, so a running render never crosses it. */
export const BROWSER_DAILY_CAP_MAX_MS = 540_000;
/** Navigation timeout of one browser re-check. */
export const BROWSER_NAV_TIMEOUT_MS = 20_000;
/** Extra wait for the network to go idle after DOM ready (bounded; a page that never idles is read anyway). */
export const BROWSER_IDLE_WAIT_MS = 5_000;
/**
 * Browser time reserved (pre-charged) per re-check before launching: Browser Run closes an idle browser after 60 s by
 * default, so an invocation cut off mid-render can cost at most this much. Adjusted to the measured time afterwards.
 */
export const BROWSER_RESERVE_MS = 60_000;
/** Minimum time between two browser launches (Workers Free: 1 new browser instance every 20 seconds). */
export const BROWSER_LAUNCH_INTERVAL_MS = 20_000;
/** Launch failures of one backlink before it is marked "browser unavailable" (the plain result is kept). */
export const BROWSER_MAX_ATTEMPTS = 3;
/** The Backlinks page / Live view refresh this often while browser re-checks wait (and the budget is not used up). */
export const BROWSER_POLL_MS = 10_000;
/** HTTP statuses of a plain fetch that look like a bot wall and are re-checked in the browser. */
export const BOT_WALL_STATUSES: readonly number[] = [403, 429, 503];
/** fetch_failed error codes that are never sent to the browser (the SSRF guard refused the URL or a redirect). */
export const NO_BROWSER_ERROR_CODES: readonly string[] = ["blocked_url", "redirect_offsite"];

export type CheckMethod = "plain" | "browser";
/** pending = waiting for the browser step; unavailable = no browser (plain result kept); failed = browser could not load the page. */
export type BrowserState = "pending" | "unavailable" | "failed";

/**
 * Which plain results are re-checked in the browser (pure; code decides): link missing, a bot-wall HTTP status
 * (403 / 429 / 503) or a failed fetch other than an SSRF refusal. Everything else is final.
 */
export function needsBrowserRecheck(r: { status: BacklinkStatus; httpStatus: number | null; errorCode: string | null }): boolean {
  if (r.status === "missing") return true;
  if (r.status === "page_error") return r.httpStatus !== null && BOT_WALL_STATUSES.includes(r.httpStatus);
  if (r.status === "fetch_failed") return !(r.errorCode !== null && NO_BROWSER_ERROR_CODES.includes(r.errorCode));
  return false;
}

// ------------------------------------------------------------------ statuses
export type BacklinkStatus = "dofollow" | "nofollow" | "sponsored" | "ugc" | "missing" | "page_error" | "redirected" | "robots_blocked" | "fetch_failed";
export const BACKLINK_STATUSES: readonly BacklinkStatus[] = ["dofollow", "nofollow", "sponsored", "ugc", "missing", "page_error", "redirected", "robots_blocked", "fetch_failed"];
/** The rel class of the matching link (found on the final page). */
export type LinkRel = "dofollow" | "nofollow" | "sponsored" | "ugc" | "missing";
/** Statuses where the link was found on the page. */
export const FOUND_STATUSES: readonly BacklinkStatus[] = ["dofollow", "nofollow", "sponsored", "ugc"];
/** nofollow family (rel nofollow / sponsored / ugc, or a page-level nofollow). */
export const NOFOLLOW_FAMILY: readonly LinkRel[] = ["nofollow", "sponsored", "ugc"];

/** List filter values: a status, plus "unchecked" and "target_broken". */
export type BacklinkFilterStatus = BacklinkStatus | "unchecked" | "target_broken";

export const STATUS_LABELS: Record<BacklinkStatus, string> = {
  dofollow: "Live · dofollow",
  nofollow: "Live · nofollow",
  sponsored: "Live · sponsored",
  ugc: "Live · ugc",
  missing: "Link missing",
  page_error: "Page error",
  redirected: "Redirected",
  robots_blocked: "Robots blocked",
  fetch_failed: "Fetch failed",
};

export type StatusTone = "good" | "warn" | "bad" | "neutral";
export const STATUS_TONES: Record<BacklinkStatus, StatusTone> = {
  dofollow: "good",
  nofollow: "warn",
  sponsored: "warn",
  ugc: "warn",
  missing: "bad",
  page_error: "bad",
  redirected: "warn",
  robots_blocked: "neutral",
  fetch_failed: "neutral",
};

export function isBacklinkStatus(s: unknown): s is BacklinkStatus {
  return typeof s === "string" && (BACKLINK_STATUSES as readonly string[]).includes(s);
}

// ------------------------------------------------------------------ contract types
export interface BacklinkRow {
  id: string;
  liveUrl: string;
  liveHost: string;
  targetUrl: string;
  anchorExpected: string | null;
  vendor: string | null;
  linkType: string | null;
  placedDate: string | null;
  da: number | null;
  traffic: number | null;
  priceText: string | null;
  active: boolean;
  removedAt: string | null;
  status: BacklinkStatus | null;
  statusReason: string | null;
  linkRel: LinkRel | null;
  httpStatus: number | null;
  finalUrl: string | null;
  anchorFound: string | null;
  /** null when no anchor was expected or no link was found. */
  anchorMatch: boolean | null;
  relText: string | null;
  pageNoindex: boolean | null;
  targetStatus: number | null;
  targetError: string | null;
  lastCheckedAt: string | null;
  lastChangeAt: string | null;
  lastChangeText: string | null;
  lastChangeNegative: boolean | null;
  sourceRow: number | null;
  createdAt: string;
  /** Method of the check the status comes from (null = never checked). */
  checkMethod: CheckMethod | null;
  /** Browser re-check state (null = none needed or done). */
  browserState: BrowserState | null;
  browserReason: string | null;
}

export interface BacklinkListResponse {
  rows: BacklinkRow[];
  total: number;
  offset: number;
  limit: number;
  /** Distinct vendors / types of active backlinks for the filters (capped at 50 each). */
  vendors: string[];
  types: string[];
  labels: string[];
}

export interface BacklinkFoundLink {
  href: string;
  rel: string | null;
  anchor: string;
  /** "target" = resolves to the target URL; "host" = another URL on your site. */
  match: "target" | "host";
  relClass: Exclude<LinkRel, "missing">;
}

export interface BacklinkCheckView {
  id: string;
  backlinkId: string;
  jobId: string | null;
  checkedAt: string;
  method: CheckMethod;
  status: BacklinkStatus;
  statusReason: string | null;
  linkRel: LinkRel | null;
  httpStatus: number | null;
  finalUrl: string | null;
  redirectChain: Array<{ status: number; to: string }>;
  robots: string | null;
  metaRobots: string | null;
  xRobotsTag: string | null;
  pageNoindex: boolean;
  pageNofollow: boolean;
  canonicalUrl: string | null;
  linkMatch: "target" | "host" | "none" | null;
  links: BacklinkFoundLink[];
  relText: string | null;
  anchorFound: string | null;
  anchorMatch: boolean | null;
  targetStatus: number | null;
  targetFinalUrl: string | null;
  targetError: string | null;
  errorCode: string | null;
  fetches: number;
  truncated: boolean;
}

export type BacklinkEventKind =
  | "rel_changed"
  | "link_removed"
  | "link_restored"
  | "page_error"
  | "redirected"
  | "robots_blocked"
  | "fetch_failed"
  | "recovered"
  | "noindex_added"
  | "noindex_removed"
  | "anchor_changed"
  | "target_moved"
  | "target_broken"
  | "target_recovered"
  | "canonical_changed";

export interface BacklinkEventView {
  id: string;
  backlinkId: string;
  checkId: string | null;
  kind: BacklinkEventKind;
  from: string | null;
  to: string | null;
  message: string;
  negative: boolean;
  detectedAt: string;
  /** Set on project-wide event lists. */
  liveUrl?: string;
  targetUrl?: string;
}

export interface BacklinkDetail {
  backlink: BacklinkRow;
  checks: BacklinkCheckView[];
  events: BacklinkEventView[];
}

export interface BacklinkJobView {
  id: string;
  trigger: "manual" | "recheck" | "scheduled";
  scope: "all" | "ids";
  status: "queued" | "running" | "completed" | "failed";
  total: number;
  done: number;
  failed: number;
  robotsBlocked: number;
  changes: number;
  fetches: number;
  batches: number;
  note: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BacklinkSummary {
  state: "ready" | "empty" | "demo";
  totals: { active: number; inactive: number; checked: number; unchecked: number };
  byStatus: Record<BacklinkStatus, number>;
  /** dofollow of checked active backlinks whose page was read (n of m, never a percentage invented elsewhere). */
  dofollow: { n: number; m: number };
  targetBroken: number;
  anchorMismatch: number;
  changes: { last7: number; last30: number; negative7: number; negative30: number };
  lastCheckAt: string | null;
  /** When the next weekly scheduled check becomes due (null when scheduled runs are off or nothing is monitored). */
  nextCheckAt: string | null;
  job: BacklinkJobView | null;
  lastJob: BacklinkJobView | null;
  limits: { maxBacklinks: number; manualPerDay: number; manualUsedToday: number; recheckRowsPerHour: number; fetchesPerInvocation: number; scheduledEveryDays: number };
  /** Browser re-checks (Browser Run fallback). */
  browser: BrowserSummary;
  canRun: boolean;
  verified: boolean;
  labels: string[];
}

export interface BrowserSummary {
  /** A BROWSER binding is configured and the daily cap is above 0. */
  available: boolean;
  /** Why browser re-checks are unavailable (null when available). */
  unavailableReason: string | null;
  /** Active backlinks waiting for a browser re-check. */
  waiting: number;
  /** Active backlinks marked "browser unavailable" / "browser failed" (plain result kept). */
  unavailable: number;
  failed: number;
  /** Browser milliseconds used today (UTC, whole Cloudflare account, Okara's own counter) and the cap. */
  usedMs: number;
  capMs: number;
  /** The daily budget is used up: waiting rows run after 00:00 UTC (deferredUntil). */
  deferred: boolean;
  deferredUntil: string | null;
}

export interface BacklinkFeedItem {
  checkId: string;
  method: CheckMethod;
  backlinkId: string;
  checkedAt: string;
  liveUrl: string;
  targetUrl: string;
  status: BacklinkStatus;
  statusReason: string | null;
  httpStatus: number | null;
  finalUrl: string | null;
  anchorFound: string | null;
  robots: string | null;
}

export interface BacklinkFeed {
  job: BacklinkJobView | null;
  items: BacklinkFeedItem[];
}

export interface BacklinkEventsResponse {
  events: BacklinkEventView[];
  since: string;
  total: number;
}

export interface StartBacklinkCheckResult {
  job: BacklinkJobView;
  /** True when an equivalent job was already queued/running (returned instead of a new one). */
  existing: boolean;
}

// ------------------------------------------------------------------ helpers
/** "example.com" and "/path?q" of a URL for compact table cells; the raw string when it does not parse. */
export function splitUrl(u: string): { host: string; path: string } {
  try {
    const x = new URL(u);
    return { host: x.hostname.replace(/^www\./, ""), path: `${x.pathname}${x.search}` || "/" };
  } catch {
    return { host: u, path: "" };
  }
}

/** Anchor comparison: case-insensitive, NFKC, whitespace collapsed, surrounding punctuation/quotes ignored. */
export function normAnchor(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, "")
    .trim();
}

export function anchorsMatch(expected: string | null | undefined, found: string | null | undefined): boolean | null {
  const e = normAnchor(expected);
  if (!e || found === null || found === undefined) return null;
  return normAnchor(found) === e;
}

/** "1.5" minutes for "used 1.5 of 8 min today" (one decimal, trailing .0 dropped). */
export function minutesText(ms: number): string {
  const m = Math.max(0, ms) / 60_000;
  const r = Math.round(m * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** "Browser re-checks: 3 waiting · used 1.5 of 8 min today" (summary line of the Backlinks page and Live container 01). */
export function browserSummaryText(b: BrowserSummary): string {
  if (!b.available) return `Browser re-checks: unavailable${b.unavailableReason ? ` (${b.unavailableReason})` : ""}`;
  const wait = `${b.waiting.toLocaleString("en-US")} waiting`;
  const used = `used ${minutesText(b.usedMs)} of ${minutesText(b.capMs)} min today`;
  return `Browser re-checks: ${wait} · ${used}${b.deferred && b.waiting > 0 ? " · budget used up, the rest run after 00:00 UTC" : ""}`;
}

/** Human status text with the HTTP status where it helps ("Page error · 404"). */
export function statusText(s: BacklinkStatus | null, httpStatus: number | null = null): string {
  if (!s) return "Not checked yet";
  if (s === "page_error" && httpStatus) return `Page error · ${httpStatus}`;
  return STATUS_LABELS[s];
}

/** Our target page is broken when the last check returned 4xx/5xx or could not reach it. */
export function targetBroken(r: Pick<BacklinkRow, "targetStatus" | "targetError">): boolean {
  return (r.targetStatus !== null && r.targetStatus >= 400) || (r.targetError !== null && r.targetError !== "not_checked" && r.targetError !== "robots_blocked");
}
