/**
 * Storage statements for one backlink check result, shared by the plain batch (jobs.ts) and the browser re-check
 * (browser.ts): the append-only check row (with its method), the change events (computed by events.ts against the
 * previous FINAL check) and the denormalized summary on the backlink row. Tenancy: every statement filters by the
 * workspace_id + project_id of the backlink row the caller loaded.
 */
import { CHECKS_KEPT_PER_BACKLINK, type BacklinkStatus, type BrowserState, type CheckMethod } from "@shared/backlinks";
import { parseJson } from "../lib/db";
import { newId } from "../lib/ids";
import type { CheckResult } from "./check";
import type { CheckSnapshot, DetectedEvent } from "./events";
import type { BacklinkDbRow, CheckDbRow } from "./store";

/** Events kept per backlink. */
export const EVENTS_KEPT_PER_BACKLINK = 50;

export type Stmt = [string, ...unknown[]];

export const clipN = (s: string | null | undefined, n: number) => (s === null || s === undefined ? null : s.length > n ? s.slice(0, n) : s);

export function blankResult(): CheckResult {
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

export function snapshotOf(c: CheckDbRow): CheckSnapshot {
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

export function snapshotOfResult(r: CheckResult): CheckSnapshot {
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

/** A stored check row back as a CheckResult (the plain result a browser re-check falls back to). */
export function resultOfCheck(c: CheckDbRow): CheckResult {
  return {
    ...blankResult(),
    status: c.status as BacklinkStatus,
    statusReason: c.status_reason,
    linkRel: (c.link_rel as CheckResult["linkRel"]) ?? null,
    httpStatus: c.http_status === null ? null : Number(c.http_status),
    finalUrl: c.final_url,
    redirectChain: parseJson<Array<{ status: number; to: string }>>(c.redirect_chain_json, []),
    robots: c.robots,
    metaRobots: c.meta_robots,
    xRobotsTag: c.x_robots_tag,
    pageNoindex: Number(c.page_noindex) === 1,
    pageNofollow: Number(c.page_nofollow) === 1,
    canonicalUrl: c.canonical_url,
    linkMatch: (c.link_match as CheckResult["linkMatch"]) ?? null,
    links: parseJson<CheckResult["links"]>(c.links_json, []),
    relText: c.rel_text,
    anchorFound: c.anchor_found,
    anchorMatch: c.anchor_match === null ? null : Number(c.anchor_match) === 1,
    targetStatus: c.target_status === null ? null : Number(c.target_status),
    targetFinalUrl: c.target_final_url,
    targetError: c.target_error,
    errorCode: c.error_code,
    fetches: Number(c.fetches ?? 0),
    bytes: Number(c.bytes ?? 0),
    truncated: Number(c.truncated) === 1,
  };
}

export function checkInsertStmt(b: BacklinkDbRow, checkId: string, jobId: string | null, ts: string, result: CheckResult, method: CheckMethod): Stmt {
  return [
    `INSERT INTO backlink_checks (id, workspace_id, project_id, backlink_id, job_id, checked_at, status, status_reason, link_rel, http_status, final_url,
       redirect_chain_json, robots, meta_robots, x_robots_tag, page_noindex, page_nofollow, canonical_url, link_match, links_json, rel_text, anchor_found,
       anchor_match, target_status, target_final_url, target_error, error_code, fetches, bytes, truncated, method)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    checkId, b.workspace_id, b.project_id, b.id, jobId, ts, result.status, clipN(result.statusReason, 600), result.linkRel, result.httpStatus, clipN(result.finalUrl, 2000),
    JSON.stringify(result.redirectChain.slice(0, 10).map((h) => ({ status: h.status, to: h.to.slice(0, 2000) }))), result.robots, clipN(result.metaRobots, 400), clipN(result.xRobotsTag, 300),
    result.pageNoindex ? 1 : 0, result.pageNofollow ? 1 : 0, clipN(result.canonicalUrl, 2000), result.linkMatch, JSON.stringify(result.links.slice(0, 20)), clipN(result.relText, 200),
    clipN(result.anchorFound, 200), result.anchorMatch === null ? null : result.anchorMatch ? 1 : 0, result.targetStatus, clipN(result.targetFinalUrl, 2000), result.targetError,
    result.errorCode, result.fetches, result.bytes, result.truncated ? 1 : 0, method,
  ];
}

export function eventStmts(b: BacklinkDbRow, checkId: string, jobId: string | null, ts: string, events: DetectedEvent[]): Stmt[] {
  const out: Stmt[] = events.map((e) => [
    `INSERT INTO backlink_events (id, workspace_id, project_id, backlink_id, check_id, job_id, kind, from_value, to_value, message, negative, detected_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId("blevt"), b.workspace_id, b.project_id, b.id, checkId, jobId, e.kind, e.from, e.to, e.message, e.negative ? 1 : 0, ts,
  ]);
  if (events.length) {
    out.push([
      `DELETE FROM backlink_events WHERE workspace_id = ? AND backlink_id = ? AND id NOT IN (
         SELECT id FROM backlink_events WHERE workspace_id = ? AND backlink_id = ? ORDER BY detected_at DESC, rowid DESC LIMIT ?)`,
      b.workspace_id, b.id, b.workspace_id, b.id, EVENTS_KEPT_PER_BACKLINK,
    ]);
  }
  return out;
}

export function pruneChecksStmt(b: BacklinkDbRow): Stmt {
  return [
    `DELETE FROM backlink_checks WHERE workspace_id = ? AND backlink_id = ? AND id NOT IN (
       SELECT id FROM backlink_checks WHERE workspace_id = ? AND backlink_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT ?)`,
    b.workspace_id, b.id, b.workspace_id, b.id, CHECKS_KEPT_PER_BACKLINK,
  ];
}

export interface BrowserFields {
  state: BrowserState | null;
  reason: string | null;
  /** Previous final check id (events of a pending re-check are computed against it later). */
  baseCheckId: string | null;
  /** Keep browser_queued_at of an already pending row (true) or set it to now / clear it. */
  queuedAt: string | null;
  attempts: number;
}

/**
 * The denormalized summary of the backlink row. `events` are the events of THIS write (empty while a browser re-check
 * is pending: they are computed once, on the final result). `jobId` null keeps last_job_id (browser step).
 */
export function backlinkUpdateStmt(
  b: BacklinkDbRow,
  ts: string,
  result: CheckResult,
  checkId: string,
  jobId: string | null,
  method: CheckMethod,
  events: DetectedEvent[],
  browser: BrowserFields,
): Stmt {
  const lastEvent = events.find((e) => e.negative) ?? events[0] ?? null;
  return [
    `UPDATE backlinks SET status = ?, status_reason = ?, link_rel = ?, http_status = ?, final_url = ?, anchor_found = ?, anchor_match = ?, rel_text = ?, page_noindex = ?,
       target_status = ?, target_error = ?, last_checked_at = ?, last_check_id = ?, last_job_id = COALESCE(?, last_job_id),
       last_change_at = CASE WHEN ? IS NULL THEN last_change_at ELSE ? END,
       last_change_text = CASE WHEN ? IS NULL THEN last_change_text ELSE ? END,
       last_change_negative = CASE WHEN ? IS NULL THEN last_change_negative ELSE ? END,
       check_method = ?, browser_state = ?, browser_reason = ?, browser_base_check_id = ?, browser_queued_at = ?, browser_attempts = ?,
       updated_at = ?
     WHERE workspace_id = ? AND project_id = ? AND id = ?`,
    result.status, clipN(result.statusReason, 600), result.linkRel, result.httpStatus, clipN(result.finalUrl, 2000), clipN(result.anchorFound, 200),
    result.anchorMatch === null ? null : result.anchorMatch ? 1 : 0, clipN(result.relText, 200), result.pageNoindex ? 1 : 0,
    result.targetStatus, result.targetError, ts, checkId, jobId,
    lastEvent ? ts : null, ts,
    lastEvent ? lastEvent.message : null, lastEvent?.message ?? null,
    lastEvent ? 1 : null, lastEvent ? (lastEvent.negative ? 1 : 0) : null,
    method, browser.state, clipN(browser.reason, 400), browser.baseCheckId, browser.queuedAt, browser.attempts,
    ts, b.workspace_id, b.project_id, b.id,
  ];
}
