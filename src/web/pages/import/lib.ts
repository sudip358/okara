/**
 * Import page helpers (pure, unit-tested): reading CSV files (BOM-aware), building previews and default mappings
 * from the shared auto-suggestion, request bodies, and the labels shown for plans, syncs and crawl checks.
 * Cell text is untrusted: the page renders it as plain text only.
 */
import {
  DESTINATION_LABELS,
  MAX_CSV_BYTES,
  PREVIEW_ROWS,
  SYNCABLE_DESTINATIONS,
  countsSentence,
  decodeCsvBytes,
  parseCsv,
  suggestBacklinksMapping,
  suggestDestination,
  toTable,
  type BacklinksMapping,
  type CompetitorsMapping,
  type DestinationSuggestion,
  type DocMapping,
  type ImportCounts,
  type ImportDestination,
  type ImportedLinkStatus,
  type ImportMapping,
  type ImportOptions,
  type ImportPlan,
  type ImportSyncSummary,
  type LinksMapping,
  type PlanAction,
  type PromptsMapping,
  type SyncErrorCode,
} from "@shared/import";

export interface StagedTab {
  /** Stable id inside the page (tab title or file name). */
  id: string;
  label: string;
  source: { kind: "csv"; name: string; text: string } | { kind: "sheets"; spreadsheetId: string; tab: string };
  headers: string[];
  rows: string[][];
  rowsRead: number;
  truncated: boolean;
  suggestion: DestinationSuggestion;
  destination: ImportDestination;
  mapping: ImportMapping;
  options: ImportOptions;
  keepInSync: boolean;
  frequencyHours: number;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Read an uploaded file as text (UTF-8 / UTF-16 BOMs handled). Throws a readable error over the size cap. */
export async function readCsvFile(file: { size: number; name: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> {
  if (file.size > MAX_CSV_BYTES) throw new Error(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_CSV_BYTES)}. Split the sheet or remove columns.`);
  return decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
}

export function defaultMapping(s: DestinationSuggestion, destination: ImportDestination, headers: string[], tabName: string): ImportMapping {
  if (destination === s.destination) return structuredCloneSafe(s.mapping);
  // The owner switched destination: start from a fresh guess for that destination.
  const first = headers[0] ?? "";
  switch (destination) {
    case "geo_prompts":
      return { question: first, done: null, notes: [] } satisfies PromptsMapping;
    case "competitors":
      return { domain: first, notes: null, assignedTo: null, metrics: headers.slice(1) } satisfies CompetitorsMapping;
    case "implemented_links":
      return { source: first, target: headers[1] ?? first, anchor: headers[2] ?? null } satisfies LinksMapping;
    case "backlinks":
      // The header row may still be recognisable (Live URL / Target ...); otherwise start from the first columns.
      return suggestBacklinksMapping(headers) ?? ({ liveUrl: first, target: headers[1] ?? first, anchor: headers[2] ?? null } satisfies BacklinksMapping);
    default:
      return { columns: [...headers], sortBy: null, title: tabName } satisfies DocMapping;
  }
}

const structuredCloneSafe = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Stage a CSV/pasted text: parse locally for preview and auto-mapping (the server parses again on import). */
export function stageCsv(name: string, text: string): StagedTab {
  const parsed = parseCsv(text);
  const table = toTable(parsed.rows);
  const label = name.replace(/\.(csv|tsv|txt)$/i, "") || "Pasted cells";
  const suggestion = suggestDestination(label, table.headers);
  return {
    id: `csv:${name}`,
    label,
    source: { kind: "csv", name, text },
    headers: table.headers,
    rows: table.rows.slice(0, PREVIEW_ROWS),
    rowsRead: table.rows.length,
    truncated: parsed.truncated,
    suggestion,
    destination: suggestion.destination,
    mapping: structuredCloneSafe(suggestion.mapping),
    options: {},
    keepInSync: false,
    frequencyHours: 24,
  };
}

export function stageSheetTab(spreadsheetId: string, preview: { tab: string; headers: string[]; rows: string[][]; rowsRead: number; suggestion: DestinationSuggestion }): StagedTab {
  const syncable = SYNCABLE_DESTINATIONS.includes(preview.suggestion.destination);
  return {
    id: `sheet:${preview.tab}`,
    label: preview.tab,
    source: { kind: "sheets", spreadsheetId, tab: preview.tab },
    headers: preview.headers,
    rows: preview.rows,
    rowsRead: preview.rowsRead,
    truncated: false,
    suggestion: preview.suggestion,
    destination: preview.suggestion.destination,
    mapping: structuredCloneSafe(preview.suggestion.mapping),
    options: {},
    keepInSync: syncable && (preview.suggestion.destination === "competitors" || preview.suggestion.destination === "backlinks"),
    frequencyHours: 24,
  };
}

export function importRequestBody(t: StagedTab, extraExclude: string[] = []) {
  const options: ImportOptions = { ...t.options };
  const exclude = [...new Set([...(t.options.excludeKeys ?? []), ...extraExclude])];
  if (exclude.length) options.excludeKeys = exclude;
  return {
    source: t.source,
    destination: t.destination,
    mapping: t.mapping,
    options,
    ...(t.keepInSync && t.source.kind === "sheets" && SYNCABLE_DESTINATIONS.includes(t.destination) ? { keepInSync: { frequencyHours: t.frequencyHours } } : {}),
  };
}

export function canSync(t: Pick<StagedTab, "source" | "destination">): boolean {
  return t.source.kind === "sheets" && SYNCABLE_DESTINATIONS.includes(t.destination);
}

const NOUNS: Record<ImportDestination, { one: string; many: string }> = {
  geo_prompts: { one: "prompt", many: "prompts" },
  competitors: { one: "competitor", many: "competitors" },
  implemented_links: { one: "placed link", many: "placed links" },
  backlinks: { one: "backlink", many: "backlinks" },
  context_doc: { one: "document", many: "documents" },
  reference: { one: "document", many: "documents" },
};

export function countsText(destination: ImportDestination, counts: Partial<ImportCounts>): string {
  return countsSentence(counts, NOUNS[destination]);
}

export const ACTION_LABELS: Record<PlanAction, string> = {
  add: "New",
  update: "Update",
  unchanged: "Unchanged",
  skip: "Skipped",
  remove: "Removed from sheet",
  not_added: "Not added (limit)",
};

export const ACTION_TONES: Record<PlanAction, "success" | "info" | "neutral" | "warning" | "danger"> = {
  add: "success",
  update: "info",
  unchanged: "neutral",
  skip: "warning",
  remove: "danger",
  not_added: "warning",
};

/** Rows the owner may uncheck in a plan (changes only). */
export const excludable = (a: PlanAction) => a === "add" || a === "update" || a === "not_added";

export function planHasChanges(p: ImportPlan): boolean {
  return p.counts.add + p.counts.update + p.counts.remove > 0;
}

export function syncErrorLabel(code: SyncErrorCode | string | null): string {
  switch (code) {
    case "token_expired":
      return "Google authorization expired";
    case "not_connected":
      return "Google Sheets not connected";
    case "tab_missing":
      return "Tab not found";
    case "header_changed":
      return "Header row changed";
    case "forbidden":
      return "No access to the sheet";
    case "not_found":
      return "Spreadsheet not found";
    case "apply_error":
      return "Could not apply changes";
    default:
      return "Sync failed";
  }
}

export function syncErrorHelp(code: SyncErrorCode | string | null): string {
  switch (code) {
    case "token_expired":
    case "not_connected":
      return "Reconnect Google Sheets above. While the Google OAuth app is in Testing mode, Google expires this authorization after 7 days.";
    case "tab_missing":
      return "The tab was deleted, or renamed and replaced. Re-import it from the new tab, then stop this sync.";
    case "header_changed":
      return "A mapped column is no longer in row 1. Re-import the tab with a new column mapping (the sync is updated), or restore the header.";
    case "forbidden":
      return "Share the spreadsheet with the connected Google account, and check the Google Sheets API is enabled for the OAuth client.";
    default:
      return "Try Sync now; if it keeps failing, re-import the tab.";
  }
}

export function syncStatusText(s: ImportSyncSummary): string {
  if (!s.enabled) return "Paused";
  if (s.lastStatus === "error") return `Failing: ${syncErrorLabel(s.lastErrorCode)}`;
  if (s.lastStatus === "never") return "Not synced yet";
  return "In sync";
}

export function frequencyLabel(h: number): string {
  return h === 24 ? "Daily" : `Every ${h} hours`;
}

export function crawlCheckLabel(c: ImportedLinkStatus["crawl"]): { text: string; tone: "success" | "warning" | "neutral" } {
  switch (c) {
    case "found":
      return { text: "placed per sheet · found in latest crawl", tone: "success" };
    case "not_found":
      return { text: "placed per sheet · not found in latest crawl", tone: "warning" };
    case "source_not_crawled":
      return { text: "placed per sheet · source page not in latest crawl", tone: "neutral" };
    default:
      return { text: "placed per sheet · no crawl yet", tone: "neutral" };
  }
}

export const destinationLabel = (d: ImportDestination) => DESTINATION_LABELS[d];

export function sheetsErrorMessage(code: string | null): string | null {
  if (!code) return null;
  const m: Record<string, string> = {
    setup_required: "Google sign-in is not configured on this server (OAuth client, token key or APP_ORIGIN missing). CSV import still works.",
    demo_project: "Demo projects cannot connect Google Sheets.",
    access_denied: "Google Sheets access was not granted.",
    insufficient_scope: "The Sheets permission was unticked on Google's consent screen. Connect again and allow it.",
    session_mismatch: "The Google redirect came back to a different session. Try again in this tab.",
    invalid_state: "The connection link expired. Try again.",
    no_refresh_token: "Google did not return a refresh token. Disconnect and connect again.",
    token_exchange_failed: "Google did not accept the authorization code. Try again.",
  };
  return m[code] ?? `Google Sheets connection failed (${code.slice(0, 40)}).`;
}

// ------------------------------------------------------------------ competitors [A39]
/** Whether "Fetch DataForSEO data for new competitors" is ticked: the owner's choice, else the plan's default (on for <= 10 new). */
export function fetchCompetitorDataChecked(options: ImportOptions, plan: ImportPlan | null): boolean {
  if (typeof options.fetchCompetitorData === "boolean") return options.fetchCompetitorData;
  return plan?.competitorFetch?.defaultOn ?? true;
}

/** Options with the suggested fix for `key` (a likely-typo host) accepted or not. */
export function withDomainFix(options: ImportOptions, key: string, accepted: boolean): ImportOptions {
  const cur = new Set(options.acceptDomainFixes ?? []);
  if (accepted) cur.add(key);
  else cur.delete(key);
  const next: ImportOptions = { ...options };
  if (cur.size) next.acceptDomainFixes = [...cur];
  else delete next.acceptDomainFixes;
  return next;
}

/** Caption under the fetch option: the default rule, or why nothing is fetched. */
export function competitorFetchCaption(plan: ImportPlan): string | null {
  const f = plan.competitorFetch;
  if (!f) return null;
  if (f.state !== "ready") return f.message;
  if (f.newDomains === 0) return "No new competitor domains in this import: nothing to fetch.";
  const rule = `Default: on for up to ${f.perDay} new domains, off above (you can tick it).`;
  return f.willFetch
    ? `${rule} Fetched in sheet order, at most ${f.perDay} per project per UTC day; the rest wait for the next days. Each competitor also has its own Refresh button.`
    : `${rule} Nothing is fetched or billed now; use Refresh per competitor on the Competitors page later.`;
}
