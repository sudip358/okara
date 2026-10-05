/**
 * Backlinks page and Live Backlinks helpers (pure, unit-tested): API paths and query strings, status chips and
 * groups, progress and change texts. Every string from the checked pages and the owner's sheet is rendered by React
 * as plain text; nothing here builds HTML.
 */
import {
  BROWSER_POLL_MS,
  FOUND_STATUSES,
  LIVE_POLL_MS,
  MAX_RECHECK_IDS,
  STATUS_LABELS,
  STATUS_TONES,
  splitUrl,
  targetBroken,
  type BacklinkFilterStatus,
  type BacklinkJobView,
  type BacklinkRow,
  type BacklinkStatus,
  type BacklinkSummary,
  type LinkRel,
  type StatusTone,
} from "@shared/backlinks";

export const backlinksBase = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/backlinks`;

export interface ListFilters {
  status: BacklinkFilterStatus | "";
  vendor: string;
  type: string;
  changed: "" | "7" | "30";
  q: string;
  sort: "checked" | "status" | "host" | "vendor" | "date" | "da" | "traffic" | "changed";
  dir: "asc" | "desc";
  offset: number;
  limit: number;
}

export const DEFAULT_FILTERS: ListFilters = { status: "", vendor: "", type: "", changed: "", q: "", sort: "checked", dir: "desc", offset: 0, limit: 50 };

export function listQuery(f: ListFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  if (f.status) p.set("status", f.status);
  if (f.vendor) p.set("vendor", f.vendor);
  if (f.type) p.set("type", f.type);
  if (f.changed) p.set("changed", f.changed);
  if (f.q.trim()) p.set("q", f.q.trim().slice(0, 100));
  if (f.sort !== "checked") p.set("sort", f.sort);
  if (f.dir !== "desc") p.set("dir", f.dir);
  if (f.offset) p.set("offset", String(f.offset));
  if (f.limit !== 50) p.set("limit", String(f.limit));
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The CSV export link (same filters, all matching rows up to the server cap). */
export function csvHref(projectId: string, f: ListFilters): string {
  return `/api${backlinksBase(projectId)}${listQuery({ ...f, offset: 0, limit: 50 }, { format: "csv" })}`;
}

export const FILTER_LABELS: Record<BacklinkFilterStatus, string> = {
  ...STATUS_LABELS,
  unchecked: "Not checked yet",
  target_broken: "Target broken",
};

/** Chip classes per tone (colour always paired with the word). */
export const TONE_CLASS: Record<StatusTone, string> = {
  good: "bg-emerald-50 text-emerald-800 ring-emerald-600/30 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-400/30",
  warn: "bg-amber-50 text-amber-900 ring-amber-600/30 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-400/30",
  bad: "bg-rose-50 text-rose-800 ring-rose-600/30 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-400/30",
  neutral: "bg-zinc-100 text-zinc-700 ring-zinc-500/30 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-400/30",
};

export function statusChip(status: BacklinkStatus | null, httpStatus: number | null = null): { label: string; tone: StatusTone } {
  if (!status) return { label: "Not checked yet", tone: "neutral" };
  return { label: status === "page_error" && httpStatus ? `Page ${httpStatus}` : STATUS_LABELS[status], tone: STATUS_TONES[status] };
}

export function relLabel(rel: LinkRel | null): string {
  if (!rel) return "—";
  return rel === "missing" ? "not found" : rel;
}

export function targetText(r: Pick<BacklinkRow, "targetStatus" | "targetError">): { text: string; broken: boolean } {
  const broken = targetBroken(r);
  if (r.targetStatus !== null) return { text: String(r.targetStatus), broken };
  if (r.targetError === "not_checked") return { text: "not checked (site not verified)", broken: false };
  if (r.targetError === "robots_blocked") return { text: "not checked (robots.txt)", broken: false };
  if (r.targetError) return { text: r.targetError.replace(/_/g, " "), broken };
  return { text: "—", broken: false };
}

export function anchorMatchText(r: Pick<BacklinkRow, "anchorExpected" | "anchorFound" | "anchorMatch">): string | null {
  if (r.anchorMatch === null) return null;
  return r.anchorMatch ? "matches" : "differs";
}

export const urlParts = splitUrl;

export function progressText(job: BacklinkJobView | null): string {
  if (!job) return "No check yet";
  const total = Math.max(job.total, job.done);
  const verb = job.status === "queued" ? "Queued" : job.status === "running" ? "Checking" : job.status === "completed" ? "Checked" : "Stopped";
  return `${verb} ${job.done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
}

export const jobActive = (job: BacklinkJobView | null | undefined) => !!job && (job.status === "queued" || job.status === "running");

export const TRIGGER_LABEL: Record<BacklinkJobView["trigger"], string> = { manual: "manual run", recheck: "recheck", scheduled: "weekly check" };

/** Polling interval of the Live view: LIVE_POLL_MS while a job runs, no polling otherwise. */
export const pollInterval = (job: BacklinkJobView | null | undefined): number | null => (jobActive(job) ? LIVE_POLL_MS : null);

// ------------------------------------------------------------------ container groupings
export type RelGroup = "dofollow" | "nofollow" | "sponsored" | "ugc" | "page_nofollow";
export const REL_GROUP_LABEL: Record<RelGroup, string> = {
  dofollow: "dofollow",
  nofollow: "nofollow (rel)",
  sponsored: "sponsored",
  ugc: "ugc",
  page_nofollow: "page-level nofollow",
};

/** Found links grouped by rel; a nofollow whose reason says "Page-level nofollow" is its own group. */
export function relGroups(rows: readonly BacklinkRow[]): Record<RelGroup, BacklinkRow[]> {
  const out: Record<RelGroup, BacklinkRow[]> = { dofollow: [], nofollow: [], sponsored: [], ugc: [], page_nofollow: [] };
  for (const r of rows) {
    if (!r.status || !(FOUND_STATUSES as readonly string[]).includes(r.status)) continue;
    if (r.status === "nofollow" && (r.statusReason ?? "").startsWith("Page-level nofollow")) out.page_nofollow.push(r);
    else out[r.status as Exclude<RelGroup, "page_nofollow">].push(r);
  }
  return out;
}

export function anchorCounts(rows: readonly BacklinkRow[]): { matches: number; differs: number; noExpected: number } {
  let matches = 0;
  let differs = 0;
  let noExpected = 0;
  for (const r of rows) {
    if (!r.status || !(FOUND_STATUSES as readonly string[]).includes(r.status)) continue;
    if (r.anchorMatch === true) matches++;
    else if (r.anchorMatch === false) differs++;
    else noExpected++;
  }
  return { matches, differs, noExpected };
}

export type CurrentBucket = "live_dofollow" | "live_nofollow" | "missing" | "page_error" | "redirected" | "robots_blocked" | "fetch_failed" | "target_broken" | "unchecked";
export const BUCKET_LABEL: Record<CurrentBucket, string> = {
  live_dofollow: "Live + dofollow",
  live_nofollow: "Live + nofollow / sponsored / ugc",
  missing: "Link missing",
  page_error: "Page 404 / 5xx",
  redirected: "Redirected",
  robots_blocked: "Robots blocked",
  fetch_failed: "Fetch failed",
  target_broken: "Target broken",
  unchecked: "Not checked yet",
};
export const BUCKET_TONE: Record<CurrentBucket, StatusTone> = {
  live_dofollow: "good",
  live_nofollow: "warn",
  missing: "bad",
  page_error: "bad",
  redirected: "warn",
  robots_blocked: "neutral",
  fetch_failed: "neutral",
  target_broken: "bad",
  unchecked: "neutral",
};

/** Buckets for container 03 from the summary's server counts (target broken overlaps the others and is listed apart). */
export function bucketCounts(s: BacklinkSummary): Array<{ bucket: CurrentBucket; n: number }> {
  const b = s.byStatus;
  return [
    { bucket: "live_dofollow", n: b.dofollow },
    { bucket: "live_nofollow", n: b.nofollow + b.sponsored + b.ugc },
    { bucket: "missing", n: b.missing },
    { bucket: "page_error", n: b.page_error },
    { bucket: "redirected", n: b.redirected },
    { bucket: "robots_blocked", n: b.robots_blocked },
    { bucket: "fetch_failed", n: b.fetch_failed },
    { bucket: "target_broken", n: s.targetBroken },
    { bucket: "unchecked", n: s.totals.unchecked },
  ];
}

/** Rows "Recheck failed/changed" sends: failing pages first, then rows changed in the last 7 days; capped. */
export function recheckCandidates(rows: readonly BacklinkRow[], now = Date.now(), cap = MAX_RECHECK_IDS): string[] {
  const bad = new Set<BacklinkStatus>(["fetch_failed", "page_error", "missing", "redirected"]);
  const weekAgo = now - 7 * 86_400_000;
  const failing = rows.filter((r) => r.active && r.status && bad.has(r.status));
  const changed = rows.filter((r) => r.active && r.lastChangeAt && Date.parse(r.lastChangeAt) >= weekAgo && !failing.includes(r));
  return [...failing, ...changed].map((r) => r.id).slice(0, cap);
}

/** "3 Oct" style day for compact cells. */
export function shortDay(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function nOfM(n: number, m: number): string {
  return `${n.toLocaleString("en-US")} of ${m.toLocaleString("en-US")}`;
}

/**
 * Per-row check state for the Change column: "pending" while a recheck the user clicked has not produced a newer
 * check, "browser" while the row waits for its browser re-check, "queued" while a full check job has not reached the row
 * yet, else idle (shows the last change + a button).
 */
export type RowCheckState = "pending" | "browser" | "queued" | "idle";

export function rowCheckState(r: BacklinkRow, pendingSince: string | undefined, job: BacklinkJobView | null | undefined): RowCheckState {
  if (pendingSince && !(r.lastCheckedAt && r.lastCheckedAt > pendingSince)) return "pending";
  // The plain check is stored; the row waits for its browser re-check (Browser Run).
  if (r.active && r.browserState === "pending") return "browser";
  if (r.active && job && jobActive(job) && job.scope === "all" && (!r.lastCheckedAt || r.lastCheckedAt < job.createdAt)) return "queued";
  return "idle";
}

// ------------------------------------------------------------------ browser re-checks
/** Badge text for a status that came from the headless browser (null for a plain fetch / never checked). */
export function methodBadge(r: Pick<BacklinkRow, "checkMethod">): string | null {
  return r.checkMethod === "browser" ? "checked in browser" : null;
}

/** Short note under the status for rows whose browser re-check could not run (the plain result is shown). */
export function browserNote(r: Pick<BacklinkRow, "browserState">): string | null {
  if (r.browserState === "unavailable") return "browser unavailable";
  if (r.browserState === "failed") return "browser re-check failed";
  return null;
}

export const METHOD_LABEL: Record<"plain" | "browser", string> = { plain: "plain fetch", browser: "browser" };

/**
 * Re-checks are waiting and can run now: the pages call POST /check/advance every BROWSER_POLL_MS (no polling while
 * the browser is unavailable or the day's browser budget is used up).
 */
export function browserPollInterval(s: Pick<BacklinkSummary, "browser"> | null | undefined): number | null {
  const b = s?.browser;
  return b && b.available && !b.deferred && b.waiting > 0 ? BROWSER_POLL_MS : null;
}
