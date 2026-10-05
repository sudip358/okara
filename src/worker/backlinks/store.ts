/**
 * Backlink monitor storage: row types, mapping to the API contract, the import upsert helpers used by the "backlinks"
 * import destination (imports/destinations.ts), and undo. Tenancy: every statement filters by workspace_id (and
 * project_id) of a project the caller resolved with requireProject() (or the cron's own job row).
 */
import { isBacklinkStatus, type BrowserState, type CheckMethod, type BacklinkCheckView, type BacklinkEventKind, type BacklinkEventView, type BacklinkFoundLink, type BacklinkJobView, type BacklinkRow, type LinkRel } from "@shared/backlinks";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";

export interface BacklinkDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  pair_key: string;
  live_url: string;
  live_url_key: string;
  live_host: string;
  target_url: string;
  target_url_key: string;
  anchor_expected: string | null;
  vendor: string | null;
  link_type: string | null;
  placed_date: string | null;
  da: number | null;
  traffic: number | null;
  price_text: string | null;
  source_import_id: string | null;
  source_key: string | null;
  source_row: number | null;
  active: number;
  removed_at: string | null;
  status: string | null;
  status_reason: string | null;
  link_rel: string | null;
  http_status: number | null;
  final_url: string | null;
  anchor_found: string | null;
  anchor_match: number | null;
  rel_text: string | null;
  page_noindex: number | null;
  target_status: number | null;
  target_error: string | null;
  last_checked_at: string | null;
  last_check_id: string | null;
  last_job_id: string | null;
  last_change_at: string | null;
  last_change_text: string | null;
  last_change_negative: number | null;
  created_at: string;
  updated_at: string;
  /** Migration 0022 (browser fallback). */
  check_method?: string | null;
  browser_state?: string | null;
  browser_reason?: string | null;
  browser_queued_at?: string | null;
  browser_base_check_id?: string | null;
  browser_attempts?: number | null;
}

export interface CheckDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  backlink_id: string;
  job_id: string | null;
  checked_at: string;
  status: string;
  status_reason: string | null;
  link_rel: string | null;
  http_status: number | null;
  final_url: string | null;
  redirect_chain_json: string;
  robots: string | null;
  meta_robots: string | null;
  x_robots_tag: string | null;
  page_noindex: number;
  page_nofollow: number;
  canonical_url: string | null;
  link_match: string | null;
  links_json: string;
  rel_text: string | null;
  anchor_found: string | null;
  anchor_match: number | null;
  target_status: number | null;
  target_final_url: string | null;
  target_error: string | null;
  error_code: string | null;
  fetches: number;
  bytes: number;
  truncated: number;
  /** Migration 0022: 'plain' | 'browser'. */
  method?: string | null;
}

export interface EventDbRow {
  id: string;
  backlink_id: string;
  check_id: string | null;
  job_id: string | null;
  kind: string;
  from_value: string | null;
  to_value: string | null;
  message: string;
  negative: number;
  detected_at: string;
  live_url?: string;
  target_url?: string;
}

export interface JobDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  trigger: "manual" | "recheck" | "scheduled";
  scope: "all" | "ids";
  ids_json: string;
  status: "queued" | "running" | "completed" | "failed";
  total: number;
  done: number;
  failed: number;
  robots_blocked: number;
  changes: number;
  fetches: number;
  batches: number;
  lease_until: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

const bool = (v: number | null | undefined): boolean | null => (v === null || v === undefined ? null : Number(v) === 1);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const rel = (v: string | null): LinkRel | null => (v === "dofollow" || v === "nofollow" || v === "sponsored" || v === "ugc" || v === "missing" ? v : null);

export const method = (v: string | null | undefined): CheckMethod => (v === "browser" ? "browser" : "plain");
const browserState = (v: string | null | undefined): BrowserState | null => (v === "pending" || v === "unavailable" || v === "failed" ? v : null);

export function toBacklinkRow(r: BacklinkDbRow): BacklinkRow {
  return {
    id: r.id,
    liveUrl: r.live_url,
    liveHost: r.live_host,
    targetUrl: r.target_url,
    anchorExpected: r.anchor_expected,
    vendor: r.vendor,
    linkType: r.link_type,
    placedDate: r.placed_date,
    da: num(r.da),
    traffic: num(r.traffic),
    priceText: r.price_text,
    active: Number(r.active) === 1,
    removedAt: r.removed_at,
    status: isBacklinkStatus(r.status) ? r.status : null,
    statusReason: r.status_reason,
    linkRel: rel(r.link_rel),
    httpStatus: num(r.http_status),
    finalUrl: r.final_url,
    anchorFound: r.anchor_found,
    anchorMatch: bool(r.anchor_match),
    relText: r.rel_text,
    pageNoindex: bool(r.page_noindex),
    targetStatus: num(r.target_status),
    targetError: r.target_error,
    lastCheckedAt: r.last_checked_at,
    lastChangeAt: r.last_change_at,
    lastChangeText: r.last_change_text,
    lastChangeNegative: bool(r.last_change_negative),
    sourceRow: num(r.source_row),
    createdAt: r.created_at,
    checkMethod: r.last_check_id ? method(r.check_method) : null,
    browserState: browserState(r.browser_state),
    browserReason: r.browser_reason ?? null,
  };
}

export function toCheckView(r: CheckDbRow): BacklinkCheckView {
  const linkMatch = r.link_match === "target" || r.link_match === "host" || r.link_match === "none" ? r.link_match : null;
  return {
    id: r.id,
    backlinkId: r.backlink_id,
    jobId: r.job_id,
    checkedAt: r.checked_at,
    method: method(r.method),
    status: isBacklinkStatus(r.status) ? r.status : "fetch_failed",
    statusReason: r.status_reason,
    linkRel: rel(r.link_rel),
    httpStatus: num(r.http_status),
    finalUrl: r.final_url,
    redirectChain: parseJson<Array<{ status: number; to: string }>>(r.redirect_chain_json, []).filter((h) => h && typeof h.to === "string"),
    robots: r.robots,
    metaRobots: r.meta_robots,
    xRobotsTag: r.x_robots_tag,
    pageNoindex: Number(r.page_noindex) === 1,
    pageNofollow: Number(r.page_nofollow) === 1,
    canonicalUrl: r.canonical_url,
    linkMatch,
    links: parseJson<BacklinkFoundLink[]>(r.links_json, []).filter((l) => l && typeof l.href === "string"),
    relText: r.rel_text,
    anchorFound: r.anchor_found,
    anchorMatch: bool(r.anchor_match),
    targetStatus: num(r.target_status),
    targetFinalUrl: r.target_final_url,
    targetError: r.target_error,
    errorCode: r.error_code,
    fetches: Number(r.fetches ?? 0),
    truncated: Number(r.truncated) === 1,
  };
}

export function toEventView(r: EventDbRow): BacklinkEventView {
  return {
    id: r.id,
    backlinkId: r.backlink_id,
    checkId: r.check_id,
    kind: r.kind as BacklinkEventKind,
    from: r.from_value,
    to: r.to_value,
    message: r.message,
    negative: Number(r.negative) === 1,
    detectedAt: r.detected_at,
    ...(r.live_url !== undefined ? { liveUrl: r.live_url } : {}),
    ...(r.target_url !== undefined ? { targetUrl: r.target_url } : {}),
  };
}

export function toJobView(r: JobDbRow): BacklinkJobView {
  return {
    id: r.id,
    trigger: r.trigger,
    scope: r.scope,
    status: r.status,
    total: Number(r.total),
    done: Number(r.done),
    failed: Number(r.failed),
    robotsBlocked: Number(r.robots_blocked),
    changes: Number(r.changes),
    fetches: Number(r.fetches),
    batches: Number(r.batches),
    note: r.note,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

// ------------------------------------------------------------------ import support
/** Sheet values of one backlink pair (what an import writes). */
export interface BacklinkSheetData {
  liveUrl: string;
  liveUrlKey: string;
  liveHost: string;
  targetUrl: string;
  targetUrlKey: string;
  anchorExpected: string | null;
  vendor: string | null;
  linkType: string | null;
  placedDate: string | null;
  da: number | null;
  traffic: number | null;
  priceText: string | null;
  sourceRow: number | null;
}

/** Sheet fields compared for "unchanged" (the source row number may move without a change). */
export function sameSheetData(r: BacklinkDbRow, d: BacklinkSheetData): boolean {
  return (
    r.live_url === d.liveUrl &&
    r.target_url === d.targetUrl &&
    (r.anchor_expected ?? null) === d.anchorExpected &&
    (r.vendor ?? null) === d.vendor &&
    (r.link_type ?? null) === d.linkType &&
    (r.placed_date ?? null) === d.placedDate &&
    num(r.da) === d.da &&
    num(r.traffic) === d.traffic &&
    (r.price_text ?? null) === d.priceText
  );
}

/** Every backlink of the project keyed by pair_key (active and inactive; bounded). */
export async function loadBacklinkIndex(db: Db, p: ProjectRow): Promise<Map<string, BacklinkDbRow>> {
  try {
    const rows = await db.all<BacklinkDbRow>("SELECT * FROM backlinks WHERE workspace_id = ? AND project_id = ? LIMIT 10000", p.workspace_id, p.id);
    return new Map(rows.map((r) => [r.pair_key, r]));
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) return new Map();
    throw e;
  }
}

export function insertBacklinkStmt(p: ProjectRow, id: string, pairKey: string, d: BacklinkSheetData, importId: string, sourceKey: string, now: Date): [string, ...unknown[]] {
  const ts = iso(now);
  return [
    `INSERT INTO backlinks (id, workspace_id, project_id, pair_key, live_url, live_url_key, live_host, target_url, target_url_key, anchor_expected, vendor, link_type,
       placed_date, da, traffic, price_text, source_import_id, source_key, source_row, active, removed_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,?,?)`,
    id, p.workspace_id, p.id, pairKey, d.liveUrl, d.liveUrlKey, d.liveHost, d.targetUrl, d.targetUrlKey, d.anchorExpected, d.vendor, d.linkType,
    d.placedDate, d.da, d.traffic, d.priceText, importId, sourceKey, d.sourceRow, ts, ts,
  ];
}

export function updateBacklinkSheetStmt(p: ProjectRow, id: string, d: BacklinkSheetData, importId: string, sourceKey: string, now: Date): [string, ...unknown[]] {
  return [
    `UPDATE backlinks SET live_url = ?, live_url_key = ?, live_host = ?, target_url = ?, target_url_key = ?, anchor_expected = ?, vendor = ?, link_type = ?,
       placed_date = ?, da = ?, traffic = ?, price_text = ?, source_import_id = ?, source_key = ?, source_row = ?, active = 1, removed_at = NULL, updated_at = ?
     WHERE workspace_id = ? AND project_id = ? AND id = ?`,
    d.liveUrl, d.liveUrlKey, d.liveHost, d.targetUrl, d.targetUrlKey, d.anchorExpected, d.vendor, d.linkType,
    d.placedDate, d.da, d.traffic, d.priceText, importId, sourceKey, d.sourceRow, iso(now), p.workspace_id, p.id, id,
  ];
}

export function deactivateBacklinkStmt(p: ProjectRow, id: string, now: Date): [string, ...unknown[]] {
  return ["UPDATE backlinks SET active = 0, removed_at = ?, updated_at = ? WHERE workspace_id = ? AND project_id = ? AND id = ?", iso(now), iso(now), p.workspace_id, p.id, id];
}

/** The fields an import may change, kept as prev_json in import_changes so undo can restore them. */
export function sheetSnapshot(r: BacklinkDbRow): Record<string, unknown> {
  return {
    id: r.id,
    pair_key: r.pair_key,
    live_url: r.live_url,
    live_url_key: r.live_url_key,
    live_host: r.live_host,
    target_url: r.target_url,
    target_url_key: r.target_url_key,
    anchor_expected: r.anchor_expected,
    vendor: r.vendor,
    link_type: r.link_type,
    placed_date: r.placed_date,
    da: r.da,
    traffic: r.traffic,
    price_text: r.price_text,
    source_import_id: r.source_import_id,
    source_key: r.source_key,
    source_row: r.source_row,
    active: r.active,
    removed_at: r.removed_at,
    updated_at: r.updated_at,
  };
}

/**
 * Undo of a "backlinks" import: pairs it created are deleted (with their checks and events); pairs it updated or
 * marked inactive get their previous sheet values and active state back. Check results are not touched.
 */
export async function undoBacklinkImport(
  db: Db,
  p: ProjectRow,
  importId: string,
  changes: Array<{ record_key: string; action: string; prev_json: string | null }>,
): Promise<string[]> {
  const stmts: Array<[string, ...unknown[]]> = [];
  let removed = 0;
  let restored = 0;
  for (const c of changes) {
    const prev = c.prev_json ? parseJson<Record<string, unknown> | null>(c.prev_json, null) : null;
    if (!prev) {
      stmts.push(["DELETE FROM backlinks WHERE workspace_id = ? AND project_id = ? AND pair_key = ? AND source_import_id = ?", p.workspace_id, p.id, c.record_key, importId]);
      removed++;
      continue;
    }
    stmts.push([
      `UPDATE backlinks SET live_url = ?, live_url_key = ?, live_host = ?, target_url = ?, target_url_key = ?, anchor_expected = ?, vendor = ?, link_type = ?, placed_date = ?,
         da = ?, traffic = ?, price_text = ?, source_import_id = ?, source_key = ?, source_row = ?, active = ?, removed_at = ?, updated_at = ?
       WHERE workspace_id = ? AND project_id = ? AND pair_key = ?`,
      prev.live_url, prev.live_url_key, prev.live_host, prev.target_url, prev.target_url_key, prev.anchor_expected ?? null, prev.vendor ?? null, prev.link_type ?? null,
      prev.placed_date ?? null, prev.da ?? null, prev.traffic ?? null, prev.price_text ?? null, prev.source_import_id ?? null, prev.source_key ?? null, prev.source_row ?? null,
      Number(prev.active ?? 1), prev.removed_at ?? null, prev.updated_at ?? null, p.workspace_id, p.id, c.record_key,
    ]);
    restored++;
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  const lines: string[] = [];
  if (removed) lines.push(`${removed} backlink${removed === 1 ? "" : "s"} removed from monitoring`);
  if (restored) lines.push(`${restored} backlink${restored === 1 ? "" : "s"} restored to their previous sheet values`);
  return lines;
}
