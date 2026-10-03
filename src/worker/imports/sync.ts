/**
 * Live sync of sheet-linked imports (owner request 2026-10-02: "we keep on updating the competitor list").
 *
 * An import from the Google Sheets source into competitors, GEO prompts or placed links can be kept in sync. The
 * cron tick (index.ts, every 15 min) re-reads due tabs (next_run_at <= now; every 6, 12 or 24 h, default 24 h) with
 * the project's stored Sheets token, and "Sync now" runs one immediately (rate-limited). A sync:
 *   - claims the row (running_until lease) so two ticks never sync the same tab at once;
 *   - follows the tab by its sheetId when it was renamed (warning shown), fails with tab_missing when it is gone;
 *   - fails with header_changed when a mapped required column is no longer in the header row;
 *   - applies the same destination code as a manual import with removeMissing = true (prompts archived,
 *     competitors untracked and marked "removed from sheet"; placed links are append-only), writing an imports row
 *     with trigger 'sync' only when something changed (idempotent: an unchanged sheet writes nothing);
 *   - records ok/error, the error code and message on the sync row. Failures never stop silently: the Import page
 *     and the Overview "needs attention" feed show them until a sync succeeds or the owner stops syncing.
 * DataForSEO refreshes for new competitor domains go through onCompetitorsChanged, so its daily caps and budgets
 * apply unchanged.
 */
import { SYNC_FREQUENCIES, columnIndex, requiredColumns, type ImportDestination, type ImportMapping, type ImportOptions, type SyncErrorCode } from "@shared/import";
import type { Env } from "../env";
import { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { HttpError } from "../lib/errors";
import { newId } from "../lib/ids";
import { addSeconds, iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { loadProjectRow } from "../platform/projects";
import { clip, type ImportCtx } from "./destinations";
import { commitImport, toSyncSummary, type CommitResult, type SyncRow } from "./service";
import { loadSheetsConnection, SheetsApiError, type SheetsClient } from "./sheets";
import { resolveSheetsClient, transportOf } from "./sheets-maton";
import { sheetTable } from "./source";

/** A sync holding the lease longer than this was interrupted; the next tick may take it. */
export const SYNC_LEASE_SECONDS = 10 * 60;
/** Syncs processed per cron tick (each reads 2 Sheets API endpoints). */
export const SYNCS_PER_TICK = 3;
/** Manual "Sync now" presses per sync per hour. */
export const SYNC_NOW_PER_HOUR = 6;

export interface SyncDeps {
  /** Test hook: the Sheets client (null = not connected). */
  sheets?: SheetsClient | null;
  schedule?: (work: Promise<unknown>) => void;
}

export const nextRunAt = (now: Date, hours: number) => iso(addSeconds(now, hours * 3600));

export function validFrequency(h: unknown): h is (typeof SYNC_FREQUENCIES)[number] {
  return typeof h === "number" && (SYNC_FREQUENCIES as readonly number[]).includes(h);
}

export async function loadSync(db: Db, p: ProjectRow, id: string): Promise<SyncRow | null> {
  return db.first<SyncRow>("SELECT * FROM import_syncs WHERE workspace_id = ? AND project_id = ? AND id = ?", p.workspace_id, p.id, id);
}

/** Create or update the sync for (spreadsheet, tab, destination) after a manual sheet import. */
export async function upsertSync(
  db: Db,
  p: ProjectRow,
  args: {
    spreadsheetId: string;
    spreadsheetTitle: string;
    tab: string;
    sheetTabId: number | null;
    destination: ImportDestination;
    mapping: ImportMapping;
    options: ImportOptions;
    frequencyHours: number;
    userId: string;
    now: Date;
    lastImportId: string | null;
  },
): Promise<SyncRow> {
  const ts = iso(args.now);
  const opts: ImportOptions = { excludeKeys: (args.options.excludeKeys ?? []).slice(0, 500) };
  await db.run(
    `INSERT INTO import_syncs (id, workspace_id, project_id, spreadsheet_id, spreadsheet_title, tab, sheet_tab_id, destination, mapping_json, options_json,
       frequency_hours, enabled, next_run_at, last_run_at, last_status, last_import_id, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,'ok',?,?,?,?)
     ON CONFLICT (project_id, spreadsheet_id, tab, destination) DO UPDATE SET
       spreadsheet_title = excluded.spreadsheet_title, sheet_tab_id = excluded.sheet_tab_id, mapping_json = excluded.mapping_json,
       options_json = excluded.options_json, frequency_hours = excluded.frequency_hours, enabled = 1, next_run_at = excluded.next_run_at,
       last_run_at = excluded.last_run_at, last_status = 'ok', last_error_code = NULL, last_error = NULL, last_warning = NULL,
       last_import_id = COALESCE(excluded.last_import_id, import_syncs.last_import_id), updated_at = excluded.updated_at`,
    newId("isync"), p.workspace_id, p.id, args.spreadsheetId, clip(args.spreadsheetTitle, 300), clip(args.tab, 200), args.sheetTabId, args.destination,
    JSON.stringify(args.mapping), JSON.stringify(opts), args.frequencyHours, nextRunAt(args.now, args.frequencyHours), ts, args.lastImportId, args.userId, ts, ts,
  );
  return (await db.first<SyncRow>(
    "SELECT * FROM import_syncs WHERE workspace_id = ? AND project_id = ? AND spreadsheet_id = ? AND tab = ? AND destination = ?",
    p.workspace_id,
    p.id,
    args.spreadsheetId,
    clip(args.tab, 200),
    args.destination,
  ))!;
}

export interface SyncOutcome {
  status: "ok" | "error" | "busy";
  code: SyncErrorCode | null;
  message: string | null;
  warning: string | null;
  result: CommitResult | null;
}

class SyncFailure extends Error {
  constructor(
    public readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Run one sync now. Never throws for sheet/token/header problems: they are recorded on the sync row. */
export async function runSync(env: Env, db: Db, sync: SyncRow, now: Date, userId: string | null, deps: SyncDeps = {}): Promise<SyncOutcome> {
  const claim = await db.run(
    `UPDATE import_syncs SET running_until = ? WHERE workspace_id = ? AND project_id = ? AND id = ? AND (running_until IS NULL OR running_until < ?)`,
    iso(addSeconds(now, SYNC_LEASE_SECONDS)),
    sync.workspace_id,
    sync.project_id,
    sync.id,
    iso(now),
  );
  if (claim.changes !== 1) return { status: "busy", code: null, message: "A sync of this tab is already running.", warning: null, result: null };

  let warning: string | null = null;
  let outcome: SyncOutcome;
  try {
    const project = await loadProjectRow(db, sync.workspace_id, sync.project_id);
    if (!project) throw new SyncFailure("apply_error", "Project not found.");
    // Same resolution as a manual import: direct Google Sheets OAuth, else the workspace's Maton connection.
    const client = deps.sheets !== undefined ? deps.sheets : await resolveSheetsClient(env, db, { id: project.id, workspaceId: project.workspace_id });
    if (!client) {
      const conn = deps.sheets !== undefined ? null : await loadSheetsConnection(db, project.workspace_id, project.id);
      if (conn && conn.status === "error") {
        throw new SyncFailure("token_expired", conn.last_error ?? "The Google Sheets authorization expired or was revoked. Reconnect Google Sheets on the Import page.");
      }
      throw new SyncFailure(
        "not_connected",
        "Google Sheets is not connected for this project. Connect it on the Import page (or add a Maton.ai key with a Google Sheets connection on the Integrations page) to resume syncing.",
      );
    }
    let loaded;
    try {
      loaded = await sheetTable(client, sync.spreadsheet_id, { title: sync.tab, sheetTabId: sync.sheet_tab_id }, sync.destination);
    } catch (e) {
      if (e instanceof SheetsApiError) throw new SyncFailure(e.code, e.message);
      throw e;
    }
    const mapping = parseJson<ImportMapping>(sync.mapping_json, {} as ImportMapping);
    const missing = requiredColumns(sync.destination, mapping).filter((c) => columnIndex(loaded.table.headers, c) < 0);
    if (missing.length) {
      throw new SyncFailure(
        "header_changed",
        `The header row of tab "${clip(loaded.source.tab ?? sync.tab, 100)}" changed: column${missing.length === 1 ? "" : "s"} ${missing.map((m) => `"${clip(m, 60)}"`).join(", ")} not found (found: ${loaded.table.headers.slice(0, 12).map((h) => `"${clip(h, 40)}"`).join(", ")}). Re-import the tab with a new mapping.`,
      );
    }
    if (loaded.renamedFrom) warning = `Tab renamed from "${clip(loaded.renamedFrom, 100)}" to "${clip(loaded.source.tab ?? "", 100)}"; the sync follows it.`;
    const ctx: ImportCtx = { env, db, project, now, userId, trigger: "sync", removeMissing: true, schedule: deps.schedule };
    let result: CommitResult;
    try {
      result = await commitImport(ctx, loaded, sync.destination, mapping, parseJson<ImportOptions>(sync.options_json, {}), sync.id);
    } catch (e) {
      throw new SyncFailure(e instanceof HttpError && e.code === "header_changed" ? "header_changed" : "apply_error", e instanceof Error ? clip(e.message, 500) : "Import failed.");
    }
    await db.run(
      `UPDATE import_syncs SET running_until = NULL, last_run_at = ?, last_status = 'ok', last_error_code = NULL, last_error = NULL, last_warning = ?,
         next_run_at = ?, tab = ?, sheet_tab_id = ?, spreadsheet_title = ?, last_import_id = COALESCE(?, last_import_id), updated_at = ?
        WHERE workspace_id = ? AND project_id = ? AND id = ?`,
      iso(now), warning, nextRunAt(now, sync.frequency_hours), clip(loaded.source.tab ?? sync.tab, 200), loaded.source.sheetTabId, clip(loaded.source.name, 300),
      result.import?.id ?? null, iso(now), sync.workspace_id, sync.project_id, sync.id,
    );
    await recordSyncTransport(db, sync, transportOf(client));
    outcome = { status: "ok", code: null, message: null, warning, result };
  } catch (e) {
    const code: SyncErrorCode = e instanceof SyncFailure ? e.code : "api_error";
    const message = e instanceof Error ? clip(e.message, 600) : "Sync failed.";
    await db.run(
      `UPDATE import_syncs SET running_until = NULL, last_run_at = ?, last_status = 'error', last_error_code = ?, last_error = ?, last_warning = ?, next_run_at = ?, updated_at = ?
        WHERE workspace_id = ? AND project_id = ? AND id = ?`,
      iso(now), code, message, warning, nextRunAt(now, sync.frequency_hours), iso(now), sync.workspace_id, sync.project_id, sync.id,
    );
    outcome = { status: "error", code, message, warning, result: null };
  }
  return outcome;
}

/** import_syncs.last_transport (migration 0018); a pending migration only skips the note. */
async function recordSyncTransport(db: Db, sync: SyncRow, transport: "direct" | "maton"): Promise<void> {
  try {
    await db.run("UPDATE import_syncs SET last_transport = ? WHERE workspace_id = ? AND project_id = ? AND id = ?", transport, sync.workspace_id, sync.project_id, sync.id);
  } catch {
    // column missing until 0018 is applied
  }
}

/** Cron: run up to SYNCS_PER_TICK due syncs. Missing table (migration not applied) is a no-op. */
export async function processDueImportSyncs(env: Env, now: Date, deps: SyncDeps = {}): Promise<{ processed: number; failed: number }> {
  const db = new Db(env.DB);
  let due: SyncRow[];
  try {
    due = await db.all<SyncRow>(
      `SELECT * FROM import_syncs WHERE enabled = 1 AND next_run_at <= ? AND (running_until IS NULL OR running_until < ?)
        ORDER BY next_run_at LIMIT ?`,
      iso(now),
      iso(now),
      SYNCS_PER_TICK,
    );
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) return { processed: 0, failed: 0 };
    throw e;
  }
  let failed = 0;
  for (const s of due) {
    try {
      const o = await runSync(env, db, s, now, null, deps);
      if (o.status === "error") failed++;
    } catch (e) {
      failed++;
      console.error("import sync failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    }
  }
  return { processed: due.length, failed };
}

export { toSyncSummary };
