/**
 * Import (Google Sheets / CSV): shared contract and pure helpers used by the Worker (authoritative parsing,
 * planning) and the web Import page (preview, auto-mapping). No I/O here.
 *
 * Every cell is untrusted text: it is stored and shown as plain text and handed to agents as evidence, never as
 * instructions. Nothing here invents data: values are the sheet's own, labelled "from your sheet".
 */

// ------------------------------------------------------------------ limits
/** CSV upload/paste: at most 10 MiB of text. */
export const MAX_CSV_BYTES = 10 * 1024 * 1024;
/** Rows parsed from one CSV or read from one sheet tab (header included). */
export const MAX_IMPORT_ROWS = 100_000;
/** Columns kept per row. */
export const MAX_IMPORT_COLUMNS = 100;
/** Characters kept per cell (longer cells are clipped). */
export const MAX_CELL_CHARS = 2_000;
/** Rows shown in a preview. */
export const PREVIEW_ROWS = 20;
/** Rows a context document keeps (first N rows, or the top N by a numeric column). */
export const CONTEXT_DOC_MAX_ROWS = 2_000;
/** Characters of table text a context document keeps (rows past this are cut and the cap is stated). */
export const CONTEXT_DOC_MAX_CHARS = 60_000;
/** Characters per cell inside a context document table. */
export const CONTEXT_DOC_CELL_CHARS = 200;
/** Rows read from a sheet tab for a context document (the Sheets range is limited to this many data rows). */
export const SHEET_DOC_READ_ROWS = 20_000;
/** Rows read from a sheet tab for prompts / competitors / links. */
export const SHEET_ROWS_READ = 5_000;
/** Items listed in a dry-run result (the counts always cover every row). */
export const PLAN_ITEMS_SHOWN = 300;
/** Sync cadence choices (hours). Never more often than every 6 hours. */
export const SYNC_FREQUENCIES = [6, 12, 24] as const;
export type SyncFrequency = (typeof SYNC_FREQUENCIES)[number];

export const IMPORT_LABEL_SHEET = "from your sheet, not measured by Okara";
export const IMPORT_LABEL_THIRD_PARTY = "from your sheet (third-party tool)";

// ------------------------------------------------------------------ contract types
export type ImportDestination = "geo_prompts" | "competitors" | "implemented_links" | "context_doc" | "reference" | "backlinks";
export const IMPORT_DESTINATIONS: readonly ImportDestination[] = ["geo_prompts", "competitors", "implemented_links", "backlinks", "context_doc", "reference"];
export const SYNCABLE_DESTINATIONS: readonly ImportDestination[] = ["geo_prompts", "competitors", "implemented_links", "backlinks"];

export const DESTINATION_LABELS: Record<ImportDestination, string> = {
  geo_prompts: "GEO prompts",
  competitors: "Competitors",
  implemented_links: "Internal links already placed",
  backlinks: "Backlinks to monitor (built links)",
  context_doc: "Imported research (context document)",
  reference: "Reference only (Okara measures this itself)",
};

export interface PromptsMapping {
  question: string;
  /** Optional "Done" column (kept as a reference note). */
  done?: string | null;
  /** Columns kept as reference notes, e.g. "Lumens (position)". */
  notes?: string[];
}
export interface CompetitorsMapping {
  domain: string;
  notes?: string | null;
  assignedTo?: string | null;
  /** Metric columns stored as the imported snapshot (DA, Organic Traffic, ...). */
  metrics?: string[];
}
export interface LinksMapping {
  source: string;
  target: string;
  anchor?: string | null;
  date?: string | null;
  method?: string | null;
  hub?: string | null;
  status?: string | null;
}
/**
 * Backlink monitor (built links sheet, e.g. the "Built Links" tab): one row holds the live article URL and up to two
 * (anchor, target) pairs; every pair becomes one monitored backlink. Vendor / type / date / DA / traffic / price are
 * the owner's own sheet values, kept as labels ("from your sheet").
 */
export interface BacklinksMapping {
  liveUrl: string;
  target: string;
  anchor?: string | null;
  target2?: string | null;
  anchor2?: string | null;
  vendor?: string | null;
  type?: string | null;
  date?: string | null;
  da?: string | null;
  traffic?: string | null;
  price?: string | null;
}
export interface DocMapping {
  /** Columns kept in the document (all when empty). */
  columns?: string[];
  /** Numeric column to keep the top rows by (descending); first rows otherwise. */
  sortBy?: string | null;
  title?: string | null;
}
export type ImportMapping = PromptsMapping | CompetitorsMapping | LinksMapping | BacklinksMapping | DocMapping;

export interface ImportOptions {
  /** GEO prompts: save imported prompts approved (they run in the next GEO run) or pending approval. */
  approvePrompts?: boolean;
  /** GEO prompts: competitor names taken from "(position)" headers to add as tracked competitors. */
  addCompetitors?: string[];
  /** Record keys (from a dry run) the owner unchecked; never applied, also on later syncs. */
  excludeKeys?: string[];
}

export type ImportSourceInput =
  | { kind: "csv"; name: string; text: string }
  | { kind: "sheets"; spreadsheetId: string; tab: string };

export type PlanAction = "add" | "update" | "unchanged" | "skip" | "remove" | "not_added";
export interface PlanItem {
  key: string;
  label: string;
  action: PlanAction;
  reason: string | null;
  /** Row number in the source (1 = header row), when the item comes from a row. */
  row: number | null;
}
export interface ImportCounts {
  add: number;
  update: number;
  unchanged: number;
  skip: number;
  remove: number;
  not_added: number;
}
export interface ImportPlan {
  destination: ImportDestination;
  sourceLabel: string;
  rowsRead: number;
  /** True when the source had more rows than were read (cap stated in notes). */
  truncated: boolean;
  counts: ImportCounts;
  /** Human-readable summary lines, e.g. "42 prompts new, 3 duplicates skipped". */
  summary: string[];
  notes: string[];
  items: PlanItem[];
  itemsTotal: number;
  /** GEO prompts: competitor names found in "(position)" headers, and whether they are tracked already. */
  suggestedCompetitors?: Array<{ name: string; tracked: boolean }>;
}

export interface ImportRecordSummary {
  id: string;
  source: "csv" | "sheets";
  sourceName: string;
  tab: string | null;
  destination: ImportDestination;
  trigger: "manual" | "sync";
  counts: Partial<ImportCounts>;
  changes: string[];
  rowsRead: number;
  status: "completed" | "undone";
  createdAt: string;
  undoneAt: string | null;
  canUndo: boolean;
  /** Sheet imports: how the sheet was read ('maton' = through the workspace's Maton.ai key). */
  transport?: "direct" | "maton";
}

export type SyncErrorCode = "token_expired" | "not_connected" | "tab_missing" | "header_changed" | "forbidden" | "not_found" | "api_error" | "apply_error";

export interface ImportSyncSummary {
  id: string;
  spreadsheetId: string;
  spreadsheetTitle: string;
  tab: string;
  destination: ImportDestination;
  frequencyHours: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: "never" | "ok" | "error";
  lastErrorCode: SyncErrorCode | null;
  lastError: string | null;
  lastWarning: string | null;
  lastChanges: string[];
  /** Transport of the last successful sync ('maton' = through the workspace's Maton.ai key). */
  lastTransport?: "direct" | "maton";
}

export interface SheetsConnectionStatus {
  state: "ready" | "setup_required" | "disabled" | "error" | "demo";
  connectedAt: string | null;
  lastError: string | null;
  scope: string;
  notes: string[];
  /** What Import and sync use now: the direct Google Sheets connection wins; 'maton' when only Maton is available. */
  via?: "direct" | "maton";
  /** The workspace's Maton google-sheets connection (key saved + active connection), even when direct wins. */
  maton?: { available: boolean; label: string | null };
}

export interface ImportOverview {
  canManage: boolean;
  sheets: SheetsConnectionStatus;
  history: ImportRecordSummary[];
  syncs: ImportSyncSummary[];
  /** Imported research / reference documents (latest versions). */
  documents: Array<{ id: string; title: string; version: number; createdAt: string; chars: number }>;
  limits: { maxCsvBytes: number; maxRows: number; docMaxRows: number; docMaxChars: number };
}

export interface SheetTab {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number | null;
  columnCount: number | null;
}
export interface SheetTabsResult {
  spreadsheetId: string;
  title: string;
  tabs: SheetTab[];
}
export interface TabPreview {
  tab: string;
  headers: string[];
  rows: string[][];
  rowsRead: number;
  suggestion: DestinationSuggestion;
}

export interface ImportedLinkStatus {
  key: string;
  sourceUrl: string;
  targetUrl: string;
  anchor: string | null;
  placedOn: string | null;
  status: "placed" | "removed_from_sheet";
  /** found / not_found in the latest crawl's internal links of the source page; source_not_crawled; no_crawl. */
  crawl: "found" | "not_found" | "source_not_crawled" | "no_crawl";
  importedAt: string;
}
export interface ImportedLinksReport {
  crawlStartedAt: string | null;
  links: ImportedLinkStatus[];
  total: number;
  references: Array<{ id: string; title: string; createdAt: string }>;
}

export interface ImportedCompetitorRow {
  domain: string;
  status: "tracked" | "not_tracked_limit" | "removed_from_sheet";
  notes: string | null;
  assignedTo: string | null;
  metrics: Record<string, string>;
  importedAt: string;
  removedAt: string | null;
}

// ------------------------------------------------------------------ decoding
/** Decode uploaded bytes: UTF-8 (with or without BOM), UTF-16 LE/BE with BOM. Invalid bytes become U+FFFD. */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  return new TextDecoder("utf-8").decode(bytes);
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// ------------------------------------------------------------------ CSV parsing (RFC 4180, tolerant)
export interface ParsedCsv {
  rows: string[][];
  delimiter: "," | "\t" | ";";
  /** True when rows past MAX_IMPORT_ROWS were dropped. */
  truncated: boolean;
}

/** Comma, tab (cells copied from Google Sheets paste as tab-separated) or semicolon, from the first line outside quotes. */
export function detectDelimiter(text: string): ParsedCsv["delimiter"] {
  const counts = { ",": 0, "\t": 0, ";": 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length && i < 64_000; i++) {
    const ch = text[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && (ch === "," || ch === "\t" || ch === ";")) counts[ch]++;
  }
  if (counts["\t"] > 0 && counts["\t"] >= counts[","]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

/**
 * Parse delimited text: quoted cells may hold delimiters, doubled quotes and line breaks; CRLF, LF and CR all end a
 * row; a stray quote inside an unquoted cell is kept literally. Cells are clipped to MAX_CELL_CHARS, rows to
 * MAX_IMPORT_COLUMNS, and parsing stops after `maxRows` rows (truncated = true).
 */
export function parseCsv(input: string, opts: { delimiter?: ParsedCsv["delimiter"]; maxRows?: number } = {}): ParsedCsv {
  const text = stripBom(input);
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const maxRows = opts.maxRows ?? MAX_IMPORT_ROWS;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let quotedCell = false;
  let truncated = false;
  const pushCell = () => {
    if (row.length < MAX_IMPORT_COLUMNS) row.push(cell.length > MAX_CELL_CHARS ? cell.slice(0, MAX_CELL_CHARS) : cell);
    cell = "";
    quotedCell = false;
  };
  const pushRow = (): boolean => {
    pushCell();
    rows.push(row);
    row = [];
    if (rows.length >= maxRows) return false;
    return true;
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.length === 0 && !quotedCell) {
      inQuotes = true;
      quotedCell = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushCell();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      const more = pushRow();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      if (!more) {
        truncated = i < n && text.slice(i).trim().length > 0;
        return { rows, delimiter, truncated };
      }
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell.length > 0 || row.length > 0 || quotedCell) pushRow();
  return { rows, delimiter, truncated };
}

// ------------------------------------------------------------------ tables
export interface ImportTable {
  headers: string[];
  rows: string[][];
  /** Source row number of each data row (1 = the header row). */
  rowNumbers: number[];
}

const isBlankRow = (r: readonly string[]) => r.every((c) => (c ?? "").trim() === "");

/**
 * Header row = the first non-empty row. Empty header names become "Column N"; duplicates get " (2)", " (3)".
 * Fully empty rows are dropped; ragged rows (the Sheets API omits trailing empty cells) are padded/trimmed to the
 * header width.
 */
export function toTable(raw: readonly (readonly string[])[]): ImportTable {
  let h = 0;
  while (h < raw.length && isBlankRow(raw[h]!)) h++;
  if (h >= raw.length) return { headers: [], rows: [], rowNumbers: [] };
  const headerRow = raw[h]!.map((c) => clean(c ?? ""));
  let width = headerRow.length;
  while (width > 0 && headerRow[width - 1] === "") width--;
  const seen = new Map<string, number>();
  const headers = headerRow.slice(0, Math.min(width, MAX_IMPORT_COLUMNS)).map((name, i) => {
    const base = name || `Column ${i + 1}`;
    const k = base.toLowerCase();
    const count = (seen.get(k) ?? 0) + 1;
    seen.set(k, count);
    return count === 1 ? base : `${base} (${count})`;
  });
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let r = h + 1; r < raw.length; r++) {
    const src = raw[r]!;
    if (isBlankRow(src)) continue;
    const out: string[] = [];
    for (let c = 0; c < headers.length; c++) out.push(clipCell(String(src[c] ?? "")));
    rows.push(out);
    rowNumbers.push(r + 1);
  }
  return { headers, rows, rowNumbers };
}

/** Control characters (except tab/newline) removed; surrounding whitespace trimmed. */
export function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}
const clipCell = (s: string) => {
  const c = clean(s);
  return c.length > MAX_CELL_CHARS ? c.slice(0, MAX_CELL_CHARS) : c;
};

export function columnIndex(headers: readonly string[], name: string | null | undefined): number {
  if (!name) return -1;
  const i = headers.indexOf(name);
  if (i >= 0) return i;
  const k = normHeader(name);
  return headers.findIndex((h) => normHeader(h) === k);
}

// ------------------------------------------------------------------ header matching
export const normHeader = (h: string) =>
  h
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** "Lumens (position)" -> "Lumens"; null when the header is not a "(position)" column. */
export function positionHeaderName(h: string): string | null {
  const m = /^(.*?)\s*\(\s*position\s*\)\s*$/i.exec(h.trim());
  const name = m?.[1]?.trim();
  return name ? name : null;
}

const TECHNICAL_TAB = /\b(titles?|h1s?|meta|metas|descriptions?|30x|3xx|301s?|302s?|40x|4xx|404s?|5xx|indexed|indexing|index coverage|canonicals?|redirects?|status codes?|broken)\b/i;
const LINK_REFERENCE_TAB = /internal\s*link|orphan/i;

export interface DestinationSuggestion {
  destination: ImportDestination;
  mapping: ImportMapping;
  reason: string;
}

const find = (headers: readonly string[], ...patterns: RegExp[]): string | null => {
  for (const p of patterns) {
    const h = headers.find((x) => p.test(normHeader(x)));
    if (h) return h;
  }
  return null;
};

/**
 * Suggest a destination and column mapping from the tab name and header row:
 *   "Question"                                 -> GEO prompts ("(position)" columns kept as reference notes)
 *   "Competing Domains" / "Competitor ... Domain" -> competitors (other columns kept as the sheet metrics snapshot)
 *   "Source ... URL" + "Target URL" (+ "Anchor") -> internal links already placed
 *   technical audit tabs (Titles, H1, Meta, 30x, 40x, Indexed...) -> reference only
 *   internal-link overview / orphan tabs        -> reference only
 *   anything else                              -> imported research (context document)
 */
export function suggestDestination(tabName: string, headers: readonly string[]): DestinationSuggestion {
  const backlinks = suggestBacklinksMapping(headers);
  if (backlinks) {
    return {
      destination: "backlinks",
      mapping: backlinks,
      reason: `"${backlinks.liveUrl}" and "${backlinks.target}" columns look like built backlinks: each live article is checked for its link to your site (dofollow / nofollow).`,
    };
  }
  const source = find(headers, /^source( article| page)? url$/, /^source$/, /^from url$/);
  const target = find(headers, /^target( page)? url$/, /^target$/, /^to url$/);
  if (source && target) {
    const mapping: LinksMapping = {
      source,
      target,
      anchor: find(headers, /^anchor( text)?$/),
      date: find(headers, /^date$/, /^date placed$/),
      method: find(headers, /^method$/),
      hub: find(headers, /^hub$/),
      status: find(headers, /^status$/),
    };
    return { destination: "implemented_links", mapping, reason: `"${source}" and "${target}" columns look like links you already placed.` };
  }
  const question = find(headers, /^questions?$/, /^prompts?$/, /^ai questions?$/);
  if (question) {
    const notes = headers.filter((h) => h !== question && (positionHeaderName(h) !== null || /^competitors?$/.test(normHeader(h))));
    const mapping: PromptsMapping = { question, done: find(headers, /^done$/), notes };
    return { destination: "geo_prompts", mapping, reason: `"${question}" column: each question becomes a GEO prompt.` };
  }
  const domain = find(headers, /^competing domains?$/, /^competitor domains?$/, /^competitors? domain$/, /^competitors?$/, /^domains?$/);
  if (domain && /domain|competitor/i.test(domain + " " + tabName)) {
    const notes = find(headers, /^notes?$/);
    const assignedTo = find(headers, /^assigned to$/, /^owner$/);
    const metrics = headers.filter((h) => h !== domain && h !== notes && h !== assignedTo);
    const mapping: CompetitorsMapping = { domain, notes, assignedTo, metrics };
    return { destination: "competitors", mapping, reason: `"${domain}" column: each domain becomes a tracked competitor.` };
  }
  if (TECHNICAL_TAB.test(tabName)) {
    return { destination: "reference", mapping: { columns: [...headers], title: tabName }, reason: "Technical audit tab: Okara measures this itself from its crawl and Search Console; import as reference only." };
  }
  if (LINK_REFERENCE_TAB.test(tabName)) {
    return { destination: "reference", mapping: { columns: [...headers], title: tabName }, reason: "Internal-link reference tab: shown next to Okara's own crawl counts on the Internal links page." };
  }
  return { destination: "context_doc", mapping: { columns: [...headers], title: tabName }, reason: "Research or plan tab: stored as an imported research document the agents can read as evidence." };
}

/**
 * Backlinks column mapping from a header row ("Built Links": <vendor> | Type | Date | Live URL | Anchor 1 | Target |
 * Anchor 2 | Target 2 | DA | Traffic | Price). Needs a live-URL column and a target column; null otherwise. The vendor
 * column is a "Vendor"/"Provider"/"Agency" header, else the FIRST column when its header is blank ("Column 1" after
 * toTable) or a number (e.g. "3"), as in the master sheet.
 */
export function suggestBacklinksMapping(headers: readonly string[]): BacklinksMapping | null {
  const liveUrl = find(headers, /^live( article| page| post| link)?( url| link)?$/, /^(article|published|placement|guest post) url$/, /^url live$/);
  if (!liveUrl) return null;
  const rest = headers.filter((h) => h !== liveUrl);
  const target = find(rest, /^target( 1)?$/, /^target( 1)? (url|page|link)$/, /^(our|landing) (url|page)$/);
  if (!target) return null;
  const target2 = find(rest.filter((h) => h !== target), /^target 2$/, /^target 2 (url|page|link)$/);
  const anchor = find(rest, /^anchor( 1)?$/, /^anchor( 1)? text$/);
  const anchor2 = find(rest.filter((h) => h !== anchor), /^anchor 2$/, /^anchor 2 text$/);
  const first = headers[0] ?? "";
  const vendorNamed = find(rest, /^(vendor|provider|agency|seller|supplier|source)$/);
  const vendor = vendorNamed ?? (first !== liveUrl && (/^column 1$/i.test(first) || /^\d+$/.test(first.trim())) ? first : null);
  return {
    liveUrl,
    target,
    anchor,
    target2,
    anchor2,
    vendor,
    type: find(rest, /^(type|link type|placement type)$/),
    date: find(rest, /^(date|date placed|live date|published|published date|date live)$/),
    da: find(rest, /^(da|dr|domain authority|domain rating)$/),
    traffic: find(rest, /^(traffic|organic traffic|monthly traffic)$/),
    price: find(rest, /^(price|cost|fee)$/),
  };
}

/** Required columns of a mapping (used to detect a changed header row on sync). */
export function requiredColumns(destination: ImportDestination, mapping: ImportMapping): string[] {
  switch (destination) {
    case "geo_prompts":
      return [(mapping as PromptsMapping).question];
    case "competitors":
      return [(mapping as CompetitorsMapping).domain];
    case "implemented_links":
      return [(mapping as LinksMapping).source, (mapping as LinksMapping).target];
    case "backlinks":
      return [(mapping as BacklinksMapping).liveUrl, (mapping as BacklinksMapping).target];
    default:
      return [];
  }
}

// ------------------------------------------------------------------ keys
/** Prompt identity: NFKC, lower-case, single spaces, trailing punctuation removed. */
export function promptKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s?.!]+$/u, "");
}

/** Link endpoint identity: lower-case host, no "www.", no fragment, no trailing slash, utm_* removed. */
export function linkUrlKey(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const k of [...url.searchParams.keys()]) if (/^utm_/i.test(k)) url.searchParams.delete(k);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const q = url.searchParams.toString();
    return `${host}${path}${q ? `?${q}` : ""}`;
  } catch {
    return u.trim().toLowerCase();
  }
}

export const linkKey = (source: string, target: string, anchor: string | null) =>
  `${linkUrlKey(source)}>${linkUrlKey(target)}|${(anchor ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()}`;

/** Spreadsheet id from a docs.google.com URL or a bare id; null when it does not look like one. */
export function extractSpreadsheetId(input: string): string | null {
  const s = input.trim();
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,100})/.exec(s);
  if (m) return m[1]!;
  return /^[a-zA-Z0-9_-]{20,100}$/.test(s) ? s : null;
}

/** "1,234" / "12.5%" / "$3,400" -> number; null when the cell is not numeric. */
export function numericCell(s: string): number | null {
  const t = s.replace(/[,\s$€£%]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Plain sentence for counts, e.g. "42 new, 3 skipped". */
export function countsSentence(c: Partial<ImportCounts>, nouns: { one: string; many: string } = { one: "row", many: "rows" }): string {
  const parts: string[] = [];
  const n = (k: number) => (k === 1 ? nouns.one : nouns.many);
  if (c.add) parts.push(`${c.add} ${n(c.add)} new`);
  if (c.update) parts.push(`${c.update} updated`);
  if (c.unchanged) parts.push(`${c.unchanged} unchanged`);
  if (c.remove) parts.push(`${c.remove} removed from the sheet`);
  if (c.not_added) parts.push(`${c.not_added} not added (limit)`);
  if (c.skip) parts.push(`${c.skip} skipped`);
  return parts.length ? parts.join(", ") : "Nothing to import";
}
