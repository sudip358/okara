/**
 * Import sources: a CSV (uploaded file or pasted cells, parsed server-side with the shared parser) or one Google
 * Sheets tab read through the project's Sheets connection. Both become an ImportTable (header row + data rows).
 */
import {
  MAX_CSV_BYTES,
  SHEET_DOC_READ_ROWS,
  SHEET_ROWS_READ,
  parseCsv,
  toTable,
  type ImportDestination,
  type ImportSourceInput,
  type ImportTable,
} from "@shared/import";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { HttpError, badRequest } from "../lib/errors";
import type { ProjectRow } from "../platform/access";
import { SheetsApiError, type SheetsClient } from "./sheets";
import { resolveSheetsClient, transportOf } from "./sheets-maton";

export interface ImportSource {
  kind: "csv" | "sheets";
  /** File name or spreadsheet title (plain text). */
  name: string;
  spreadsheetId: string | null;
  tab: string | null;
  sheetTabId: number | null;
  /** Owner of import records: 'sheet:<spreadsheetId>:<sheetId>' or 'csv:<normalized name>'. */
  sourceKey: string;
  /** Sheets only: how the tab was read ('direct' OAuth or the workspace's Maton gateway key). */
  transport?: "direct" | "maton";
}

export interface LoadedTable {
  source: ImportSource;
  table: ImportTable;
  rowsRead: number;
  truncated: boolean;
  readCap: number | null;
  /** Set when a synced tab was found by its id under a new name. */
  renamedFrom?: string | null;
}

export interface SourceDeps {
  sheets?: SheetsClient | null;
}

export const csvSourceKey = (name: string) =>
  `csv:${name.normalize("NFKC").toLowerCase().replace(/\.(csv|tsv|txt)$/i, "").replace(/\s+/g, " ").trim().slice(0, 120)}`;
export const sheetSourceKey = (spreadsheetId: string, sheetTabId: number | null, tab: string) =>
  `sheet:${spreadsheetId}:${sheetTabId ?? tab}`;

export const rowsToReadFor = (destination: ImportDestination) =>
  destination === "context_doc" || destination === "reference" ? SHEET_DOC_READ_ROWS : SHEET_ROWS_READ;

export function sheetsHttpError(e: unknown): HttpError {
  if (e instanceof SheetsApiError) {
    if (e.code === "token_expired") return new HttpError(412, "setup_required", e.message);
    if (e.code === "not_found") return new HttpError(404, "not_found", e.message);
    if (e.code === "tab_missing") return new HttpError(400, "tab_missing", e.message);
    if (e.code === "forbidden") return new HttpError(403, "sheets_forbidden", e.message);
    if (e.status === 429) return new HttpError(429, "rate_limited", e.message);
    return new HttpError(502, "sheets_error", e.message);
  }
  return e instanceof HttpError ? e : new HttpError(502, "sheets_error", "Google Sheets request failed.");
}

export async function sheetsClientFor(env: Env, db: Db, project: ProjectRow, deps: SourceDeps = {}): Promise<SheetsClient> {
  // Direct Google Sheets OAuth first; else the workspace's Maton google-sheets connection (imports/sheets-maton.ts).
  const client = deps.sheets !== undefined ? deps.sheets : await resolveSheetsClient(env, db, { id: project.id, workspaceId: project.workspace_id });
  if (!client) {
    throw new HttpError(
      412,
      "setup_required",
      "Connect Google Sheets on the Import page first, or add a Maton.ai key with a Google Sheets connection on the Integrations page (or download the tab as CSV and upload it).",
    );
  }
  return client;
}

/** CSV text -> table. Size and row caps are enforced; the cap is reported, never silent. */
export function csvTable(name: string, text: string): LoadedTable {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_CSV_BYTES) throw new HttpError(413, "payload_too_large", `CSV is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB. Split it or import fewer rows.`);
  const parsed = parseCsv(text);
  const table = toTable(parsed.rows);
  if (table.headers.length === 0) throw badRequest("The CSV is empty: no header row found.");
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "Pasted cells";
  return {
    source: { kind: "csv", name: clean, spreadsheetId: null, tab: clean, sheetTabId: null, sourceKey: csvSourceKey(clean) },
    table,
    rowsRead: table.rows.length,
    truncated: parsed.truncated,
    readCap: parsed.truncated ? parsed.rows.length : null,
  };
}

/** Read one sheet tab (by sheetId when known, else by title). */
export async function sheetTable(
  client: SheetsClient,
  spreadsheetId: string,
  tab: { title: string; sheetTabId?: number | null },
  destination: ImportDestination,
): Promise<LoadedTable> {
  const meta = await client.getSpreadsheet(spreadsheetId);
  let found = tab.sheetTabId !== undefined && tab.sheetTabId !== null ? meta.tabs.find((t) => t.sheetId === tab.sheetTabId) : undefined;
  found ??= meta.tabs.find((t) => t.title === tab.title);
  if (!found) throw new SheetsApiError(400, "tab_missing", `Tab "${tab.title.slice(0, 120)}" was not found in "${meta.title.slice(0, 120)}" (renamed or deleted?).`);
  const cap = rowsToReadFor(destination);
  const values = await client.getValues(spreadsheetId, found.title, cap);
  const table = toTable(values);
  const truncated = values.length >= cap + 1 && (found.rowCount === null || found.rowCount > cap + 1);
  return {
    source: { kind: "sheets", name: meta.title, spreadsheetId, tab: found.title, sheetTabId: found.sheetId, sourceKey: sheetSourceKey(spreadsheetId, found.sheetId, found.title), transport: transportOf(client) },
    table,
    rowsRead: table.rows.length,
    truncated,
    readCap: truncated ? cap : null,
    renamedFrom: found.title !== tab.title ? tab.title : null,
  };
}

export async function loadTable(
  env: Env,
  db: Db,
  project: ProjectRow,
  input: ImportSourceInput,
  destination: ImportDestination,
  deps: SourceDeps = {},
): Promise<LoadedTable> {
  if (input.kind === "csv") return csvTable(input.name, input.text);
  const client = await sheetsClientFor(env, db, project, deps);
  try {
    return await sheetTable(client, input.spreadsheetId, { title: input.tab }, destination);
  } catch (e) {
    throw sheetsHttpError(e);
  }
}
