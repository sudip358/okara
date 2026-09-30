/**
 * Client helpers for the redirect map page: reading pasted/imported URL lists and building the
 * Shopify URL-redirect CSV download ("Redirect from,Redirect to", paths only). The server's
 * `shopifyCsv` already holds the automatic rows; rows the user resolves here are appended.
 */

export const SHOPIFY_CSV_HEADER = "Redirect from,Redirect to";
export const MAX_OLD_URLS = 500;
export const MAX_NEW_URLS = 5000;
export const MAX_URL_LENGTH = 2048;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** RFC 4180 field escaping (same rule as the server). */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value) || value !== value.trim()) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Non-empty trimmed lines. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Parse CSV text (quoted fields, "" escapes, CRLF/LF) and return the first column of each record. */
export function parseCsvFirstColumn(text: string): string[] {
  const out: string[] = [];
  let field = "";
  let col = 0;
  let inQuotes = false;
  const endRecord = () => {
    if (col === 0) out.push(field);
    field = "";
    col = 0;
  };
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          if (col === 0) field += '"';
          i++;
        } else inQuotes = false;
      } else if (col === 0) field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      if (col === 0) out.push(field);
      col++;
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRecord();
    } else if (col === 0) field += ch;
  }
  if (field.length > 0 || col > 0) endRecord();
  const values = out.map((v) => v.trim()).filter((v) => v.length > 0);
  // Drop a header row: a first cell that is neither a path nor something URL-like.
  if (values.length > 0 && !looksLikeUrlOrPath(values[0]!)) values.shift();
  return values;
}

export function looksLikeUrlOrPath(v: string): boolean {
  return v.startsWith("/") || /^https?:\/\//i.test(v) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(v);
}

/** "/path?query" of an absolute URL, or null. */
export function pathAndQuery(url: string): string | null {
  try {
    const u = new URL(url);
    const path = `/${u.pathname.split("/").filter(Boolean).join("/")}`;
    return `${path}${u.search}`;
  } catch {
    return null;
  }
}

const comparable = (p: string) => {
  const path = p.split(/[?#]/, 1)[0] ?? "";
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // keep as written
  }
  return `/${decoded.toLowerCase().split("/").filter(Boolean).join("/")}`;
};

/**
 * Server CSV (automatic rows) + rows the user resolved to a candidate. Rows whose target is the same
 * path, or whose "from" is already in the file, are skipped.
 */
export function buildDownloadCsv(serverCsv: string, resolved: ReadonlyArray<{ from: string; to: string }>): { csv: string; added: number } {
  const base = serverCsv.trim() ? serverCsv.replace(/\s*$/, "\n") : `${SHOPIFY_CSV_HEADER}\n`;
  const existing = new Set(
    parseCsvFirstColumn(base)
      .map(comparable),
  );
  const lines: string[] = [];
  for (const r of resolved) {
    const toPath = pathAndQuery(r.to);
    if (!toPath || !r.from.startsWith("/")) continue;
    const key = comparable(r.from);
    if (existing.has(key) || key === comparable(toPath)) continue;
    existing.add(key);
    lines.push(`${csvEscape(r.from)},${csvEscape(toPath)}`);
  }
  return { csv: lines.length ? `${base}${lines.join("\n")}\n` : base, added: lines.length };
}
