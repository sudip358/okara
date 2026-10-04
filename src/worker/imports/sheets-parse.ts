/**
 * Parsers for the native Sheets API v4 responses (spreadsheets.get with SPREADSHEET_FIELDS, values.get), shared by
 * the direct transport (imports/sheets.ts) and the Maton transport (platform/maton.ts). No imports with side effects.
 */
import type { SheetTab, SheetTabsResult } from "@shared/import";

/** fields mask for spreadsheets.get: title and grid tabs only (no cell data). */
export const SPREADSHEET_FIELDS = "spreadsheetId,properties.title,sheets.properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount))";

/** Native Spreadsheet resource -> tabs (grid sheets only), shared by the direct and the Maton transport. */
export function parseSpreadsheet(raw: unknown, spreadsheetId: string): SheetTabsResult {
  const json = raw as {
    properties?: { title?: unknown };
    sheets?: Array<{ properties?: { sheetId?: unknown; title?: unknown; index?: unknown; sheetType?: unknown; gridProperties?: { rowCount?: unknown; columnCount?: unknown } } }>;
  } | null;
  const tabs: SheetTab[] = [];
  for (const s of Array.isArray(json?.sheets) ? json!.sheets : []) {
    const p = s?.properties;
    if (!p || typeof p.title !== "string" || typeof p.sheetId !== "number") continue;
    // Only grid sheets hold cell values (object/chart sheets have no values).
    if (p.sheetType !== undefined && p.sheetType !== "GRID") continue;
    tabs.push({
      sheetId: p.sheetId,
      title: p.title.slice(0, 200),
      index: typeof p.index === "number" ? p.index : tabs.length,
      rowCount: typeof p.gridProperties?.rowCount === "number" ? p.gridProperties.rowCount : null,
      columnCount: typeof p.gridProperties?.columnCount === "number" ? p.gridProperties.columnCount : null,
    });
  }
  tabs.sort((a, b) => a.index - b.index);
  const title = typeof json?.properties?.title === "string" ? json.properties.title.slice(0, 300) : spreadsheetId;
  return { spreadsheetId, title, tabs };
}

/** Native ValueRange -> ragged rows of strings. */
export function parseValueRange(raw: unknown): string[][] {
  const values = (raw as { values?: unknown } | null)?.values;
  return (Array.isArray(values) ? values : []).map((r: unknown) => (Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? "" : String(c))) : []));
}

