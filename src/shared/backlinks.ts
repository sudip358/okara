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
  canRun: boolean;
  verified: boolean;
  labels: string[];
}

export interface BacklinkFeedItem {
  checkId: string;
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
