/** CSV helpers for the internal-links exports (RFC 4180, formula-injection safe). */

/** UTF-8 byte order mark: Excel opens UTF-8 CSV files correctly only with it. */
export const BOM = "\uFEFF";

/**
 * One CSV cell (RFC 4180): quoted when it contains a comma, quote, CR, or LF; quotes doubled. Text cells
 * that a spreadsheet would treat as a formula (leading =, +, -, @, tab, CR) are prefixed with a single
 * quote, because sentences and anchors are untrusted crawled text.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: ReadonlyArray<string | number | null | undefined>) => cells.map(csvCell).join(",");
