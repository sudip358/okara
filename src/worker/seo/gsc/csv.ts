/**
 * Search Console CSV import (Performance report -> Export -> CSV). Accepted files from the export:
 *   Queries.csv  header "Top queries" | "Query"  -> query-level rows (page unknown)
 *   Pages.csv    header "Top pages"   | "Page"   -> page-level rows
 *   Chart.csv    header "Date"                   -> per-day PROPERTY totals (the only export that
 *                                                  yields property totals: clicks/impressions sums;
 *                                                  position stays null because it cannot be re-aggregated)
 * followed by Clicks, Impressions, CTR ("4.5%"), Position. English headers only.
 *
 * Provenance: every import is a gsc_syncs row with source 'csv_import'; totals_json.provenance records
 * the export kind(s), row counts, the importing user, and time. A user-declared window pairs
 * with its comparable window, so importing the current and previous exports for adjacent windows
 * lands in one sync. Imported data is labelled "CSV import" everywhere; it never claims to be an API sync.
 */
import type { DateWindow } from "@shared/types";
import type { Db } from "../../lib/db";
import { badRequest } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { iso, utcDay } from "../../lib/time";
import { daysInWindow, followingWindow, isIsoDate, precedingWindow } from "./windows";
import { parseTotalsJson, type TotalsJson, type WindowTotalsJson } from "./aggregate";

export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 25_000;
/** The Search Console UI export is limited to 1,000 rows per table. */
export const GSC_UI_EXPORT_ROW_LIMIT = 1_000;
export const CSV_MAX_WINDOW_DAYS = 93;

export type CsvKind = "queries" | "pages" | "dates";

export interface CsvRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface ParsedCsv {
  kind: CsvKind;
  rows: CsvRow[];
}

const KEY_HEADERS: Record<string, CsvKind> = {
  "top queries": "queries",
  query: "queries",
  queries: "queries",
  "top pages": "pages",
  page: "pages",
  pages: "pages",
  date: "dates",
};
const METRIC_HEADERS = ["clicks", "impressions", "ctr", "position"] as const;

/** Returned in every 400 so the user can fix the file. */
export const EXPECTED_CSV_HEADERS = {
  firstColumn: ["Top queries", "Query", "Top pages", "Page", "Date"],
  metricColumns: ["Clicks", "Impressions", "CTR", "Position"],
  example: "Top queries,Clicks,Impressions,CTR,Position",
  source: "Search Console > Performance > Export > Download CSV (Queries.csv, Pages.csv, or Chart.csv)",
} as const;

export class CsvError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
  }
}

/** RFC 4180-ish parser: quoted fields, doubled quotes, commas/newlines inside quotes, CRLF, BOM. */
export function parseCsvText(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) out.push(row);
      row = [];
      if (out.length > CSV_MAX_ROWS + 1) throw new CsvError(`CSV has more than ${CSV_MAX_ROWS.toLocaleString("en-US")} rows.`);
    } else field += ch;
  }
  if (inQuotes) throw new CsvError("CSV has an unterminated quoted field.");
  row.push(field);
  if (row.some((c) => c.trim() !== "")) out.push(row);
  return out;
}

/** "4.5%" -> 0.045; "0.045" -> 0.045. */
export function parseCtr(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  if (t.endsWith("%")) {
    const n = Number(t.slice(0, -1).trim().replace(/,/g, ""));
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : null;
  }
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function parseCount(raw: string): number | null {
  const t = raw.trim().replace(/,/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseGscCsv(csv: string): ParsedCsv {
  if (new TextEncoder().encode(csv).byteLength > CSV_MAX_BYTES) throw new CsvError("CSV is larger than 2 MB.");
  const table = parseCsvText(csv);
  if (table.length === 0) throw new CsvError("CSV is empty.");
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const kind = KEY_HEADERS[header[0] ?? ""];
  const expected = 'Expected a Search Console export header: "Top queries" (or "Query"), "Top pages" (or "Page"), or "Date", followed by "Clicks", "Impressions", "CTR", "Position".';
  if (!kind) throw new CsvError(`Unrecognized first column "${table[0]![0] ?? ""}". ${expected}`);
  const idx: Record<(typeof METRIC_HEADERS)[number], number> = { clicks: -1, impressions: -1, ctr: -1, position: -1 };
  for (const m of METRIC_HEADERS) {
    idx[m] = header.indexOf(m);
    if (idx[m] < 1) throw new CsvError(`Missing "${m === "ctr" ? "CTR" : m[0]!.toUpperCase() + m.slice(1)}" column. ${expected}`);
  }
  const body = table.slice(1);
  if (body.length > CSV_MAX_ROWS) throw new CsvError(`CSV has more than ${CSV_MAX_ROWS.toLocaleString("en-US")} rows.`);
  const errors: string[] = [];
  const rows: CsvRow[] = [];
  body.forEach((cells, i) => {
    const line = i + 2;
    const key = (cells[0] ?? "").trim();
    const clicks = parseCount(cells[idx.clicks] ?? "");
    const impressions = parseCount(cells[idx.impressions] ?? "");
    const ctr = parseCtr(cells[idx.ctr] ?? "");
    const position = Number((cells[idx.position] ?? "").trim());
    const problems: string[] = [];
    if (!key) problems.push("empty key");
    if (kind === "dates" && key && !isIsoDate(key)) problems.push(`invalid date "${key.slice(0, 20)}"`);
    if (kind === "pages" && key && !/^https?:\/\/[^\s]+$/i.test(key)) problems.push("page is not an absolute http(s) URL");
    if (clicks === null) problems.push("invalid Clicks");
    if (impressions === null) problems.push("invalid Impressions");
    if (ctr === null) problems.push("invalid CTR");
    if (!Number.isFinite(position) || position < 0) problems.push("invalid Position");
    if (clicks !== null && impressions !== null && clicks > impressions) problems.push("Clicks exceed Impressions");
    if (problems.length) {
      if (errors.length < 5) errors.push(`Row ${line}: ${problems.join(", ")}`);
      else if (errors.length === 5) errors.push("…more rows with errors");
      return;
    }
    rows.push({ key: key.slice(0, 2048), clicks: clicks!, impressions: impressions!, ctr: ctr!, position });
  });
  if (errors.length) throw new CsvError("CSV contains invalid rows.", errors);
  return { kind, rows };
}

// ------------------------------------------------------------------ import
export interface CsvImportInput {
  csv: string;
  window: "current" | "previous";
  start: string;
  end: string;
}

export interface CsvImportResult {
  syncId: string;
  kind: CsvKind;
  rows: number;
  window: "current" | "previous";
  windows: { current: DateWindow; previous: DateWindow };
  truncated: boolean;
  notes: string[];
}

export async function importGscCsv(
  db: Db,
  scope: { workspaceId: string; projectId: string; userId: string; property: string | null; now: Date },
  input: CsvImportInput,
): Promise<CsvImportResult> {
  if (!isIsoDate(input.start) || !isIsoDate(input.end)) throw badRequest("start and end must be YYYY-MM-DD dates.");
  if (input.start > input.end) throw badRequest("start must not be after end.");
  const declared: DateWindow = { start: input.start, end: input.end };
  const days = daysInWindow(declared);
  if (days > CSV_MAX_WINDOW_DAYS) throw badRequest(`Window is longer than ${CSV_MAX_WINDOW_DAYS} days.`);
  if (input.end >= utcDay(scope.now)) throw badRequest("Window must end before today (only complete days can be imported).");

  let parsed: ParsedCsv;
  try {
    parsed = parseGscCsv(input.csv);
  } catch (e) {
    if (e instanceof CsvError) throw badRequest(e.message, { expectedHeaders: EXPECTED_CSV_HEADERS, errors: Array.isArray(e.details) ? e.details : [] });
    throw e;
  }
  if (parsed.kind === "dates") {
    const outside = parsed.rows.find((r) => r.key < declared.start || r.key > declared.end);
    if (outside) throw badRequest(`Date ${outside.key} is outside the declared window ${declared.start}..${declared.end}.`);
  }

  const windows =
    input.window === "current"
      ? { current: declared, previous: precedingWindow(declared) }
      : { current: followingWindow(declared), previous: declared };

  // Reuse a CSV sync covering exactly this window pair, so current + previous exports combine.
  const existing = await db.first<{ id: string; totals_json: string }>(
    `SELECT id, totals_json FROM gsc_syncs
      WHERE workspace_id = ? AND project_id = ? AND source = 'csv_import'
        AND window_start = ? AND window_end = ? AND prev_window_start = ? AND prev_window_end = ?
      ORDER BY synced_at DESC LIMIT 1`,
    scope.workspaceId, scope.projectId, windows.current.start, windows.current.end, windows.previous.start, windows.previous.end,
  );
  const now = iso(scope.now);
  const syncId = existing?.id ?? newId("gsync");
  const totals: TotalsJson = existing ? parseTotalsJson(existing.totals_json) : { current: null, previous: null, notes: [] };
  const provenance = (totals.provenance ?? {}) as { imports?: Array<Record<string, unknown>> };
  const imports = Array.isArray(provenance.imports) ? provenance.imports : [];

  const truncated = parsed.kind !== "dates" && parsed.rows.length === GSC_UI_EXPORT_ROW_LIMIT;
  const notes: string[] = [];
  if (truncated) notes.push(`The ${parsed.kind} export has exactly ${GSC_UI_EXPORT_ROW_LIMIT.toLocaleString("en-US")} rows, the Search Console UI export limit; it is likely truncated.`);
  if (parsed.kind !== "dates") notes.push(`A ${parsed.kind} export cannot provide property totals; import the Dates (Chart.csv) export for totals.`);

  const statements: Array<[string, ...unknown[]]> = [];
  if (!existing) {
    statements.push([
      `INSERT INTO gsc_syncs (id, workspace_id, project_id, run_id, source, property, window_start, window_end, prev_window_start,
         prev_window_end, data_state, rows_fetched, row_cap, truncated, totals_json, status, error, synced_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      syncId, scope.workspaceId, scope.projectId, null, "csv_import", scope.property, windows.current.start, windows.current.end,
      windows.previous.start, windows.previous.end, "final", 0, CSV_MAX_ROWS, 0, "{}", "running", null, now,
    ]);
  }
  // Replace rows of the same kind + window (re-import is idempotent).
  if (parsed.kind === "dates") {
    statements.push([
      "DELETE FROM gsc_daily WHERE sync_id = ? AND workspace_id = ? AND date >= ? AND date <= ?",
      syncId, scope.workspaceId, declared.start, declared.end,
    ]);
    for (const r of parsed.rows) {
      statements.push([
        "INSERT INTO gsc_daily (sync_id, workspace_id, project_id, date, clicks, impressions) VALUES (?,?,?,?,?,?)",
        syncId, scope.workspaceId, scope.projectId, r.key, r.clicks, r.impressions,
      ]);
    }
    let clicks = 0;
    let impressions = 0;
    for (const r of parsed.rows) {
      clicks += r.clicks;
      impressions += r.impressions;
    }
    const t: WindowTotalsJson = { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : null, position: null, derivedFrom: "daily_chart_export" };
    totals[input.window] = t;
  } else {
    const col = parsed.kind === "queries" ? "query" : "page";
    const other = parsed.kind === "queries" ? "page" : "query";
    statements.push([
      `DELETE FROM gsc_metrics WHERE sync_id = ? AND workspace_id = ? AND window = ? AND ${col} IS NOT NULL AND ${other} IS NULL`,
      syncId, scope.workspaceId, input.window,
    ]);
    for (const r of parsed.rows) {
      statements.push([
        "INSERT INTO gsc_metrics (workspace_id, project_id, sync_id, window, query, page, device, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        scope.workspaceId, scope.projectId, syncId, input.window,
        parsed.kind === "queries" ? r.key : null, parsed.kind === "pages" ? r.key : null, null,
        r.clicks, r.impressions, r.ctr, r.position,
      ]);
    }
  }
  imports.push({ kind: parsed.kind, window: input.window, start: declared.start, end: declared.end, rows: parsed.rows.length, importedBy: scope.userId, importedAt: now, truncated });
  totals.provenance = { source: "csv_import", label: "Search Console CSV export (uploaded by a user)", imports };
  totals.notes = [...new Set([...(totals.notes ?? []), ...notes])];

  // Commit rows in chunks; the sync row goes first so FKs hold.
  for (let i = 0; i < statements.length; i += 500) await db.batch(statements.slice(i, i + 500));

  const counts = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM gsc_metrics WHERE sync_id = ? AND workspace_id = ?", syncId, scope.workspaceId);
  const anyTruncated = imports.some((i) => i.truncated === true);
  const hasData = (counts?.n ?? 0) > 0 || totals.current !== null || totals.previous !== null;
  await db.run(
    "UPDATE gsc_syncs SET rows_fetched = ?, truncated = ?, totals_json = ?, status = ?, synced_at = ? WHERE id = ? AND workspace_id = ?",
    counts?.n ?? 0,
    anyTruncated ? 1 : 0,
    JSON.stringify(totals),
    hasData ? "completed" : "no_data",
    now,
    syncId,
    scope.workspaceId,
  );
  return { syncId, kind: parsed.kind, rows: parsed.rows.length, window: input.window, windows, truncated, notes };
}
