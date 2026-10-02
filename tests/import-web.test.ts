/**
 * Import page UI: pure helpers (CSV staging with the owner's exact headers, BOM-aware file reading, request bodies,
 * sync/crawl labels) and server-rendered markup (no DOM, no network). Untrusted cell text renders as plain text.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { ImportPlan, ImportRecordSummary, ImportSyncSummary, ImportedLinksReport, SheetsConnectionStatus } from "@shared/import";
import type { AttentionFeed as Feed, ContextDocument } from "@shared/types";
import {
  canSync,
  crawlCheckLabel,
  defaultMapping,
  importRequestBody,
  readCsvFile,
  sheetsErrorMessage,
  stageCsv,
  stageSheetTab,
  syncErrorHelp,
  syncErrorLabel,
  syncStatusText,
} from "@web/pages/import/lib";
import { AI_QUESTIONS_HEADERS, BLOG_HUB_HEADERS, COMPETITORS_HEADERS, SPREADSHEET_ID } from "./fixtures/sheets";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const page = await load<Record<"PlanView" | "SyncList" | "HistoryList" | "SheetsConnection" | "PreviewTable" | "MappingFields", FC>>("../src/web/pages/import/ImportPage.tsx");
const panels = await load<Record<"PlacedLinksView" | "SheetCompetitorMetricsView" | "PromptSheetNote", FC>>("../src/web/pages/import/ImportedPanels.tsx");
const attention = await load<Record<"AttentionFeed", FC>>("../src/web/components/overview/AttentionFeed.tsx");
const context = await load<Record<"ImportedDocs", FC>>("../src/web/components/overview/ContextPanel.tsx");

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const noop = () => {};
const csvOf = (rows: string[][]) => rows.map((r) => r.join(",")).join("\n");

describe("import lib", () => {
  it("stages CSVs and suggests destinations from the owner's headers", () => {
    const q = stageCsv("AI Questions.csv", csvOf([AI_QUESTIONS_HEADERS, ["Best brass sconces?", "Yes", "3"]]));
    expect(q.label).toBe("AI Questions");
    expect(q.destination).toBe("geo_prompts");
    expect(q.rows[0]).toEqual(["Best brass sconces?", "Yes", "3", "", "", "", "", ""]);
    expect(stageCsv("04 - Competitors.csv", csvOf([COMPETITORS_HEADERS])).destination).toBe("competitors");
    expect(stageCsv("Blog Hub Drops.csv", csvOf([BLOG_HUB_HEADERS])).destination).toBe("implemented_links");
    expect(stageCsv("Content Decay.csv", "URL,Clicks\n/a,1").destination).toBe("context_doc");
    expect(stageCsv("40x.csv", "Address,Status Code\n/a,404").destination).toBe("reference");
    const pasted = stageCsv("Pasted cells", "Question\tDone\nWhat, if anything?\tYes");
    expect(pasted.rows[0]).toEqual(["What, if anything?", "Yes"]);
  });

  it("reads files with a UTF-8 BOM and refuses files over 10 MB", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Question\nÜber?")]);
    expect(await readCsvFile({ name: "q.csv", size: bytes.length, arrayBuffer: async () => bytes.buffer })).toBe("Question\nÜber?");
    await expect(readCsvFile({ name: "big.csv", size: 11 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) })).rejects.toThrow(/limit is 10.0 MB/);
  });

  it("builds request bodies: keep-in-sync only for sheet tabs into syncable destinations; exclusions merged", () => {
    const sheetTab = stageSheetTab(SPREADSHEET_ID, { tab: "04 - Competitors", headers: COMPETITORS_HEADERS, rows: [], rowsRead: 0, suggestion: stageCsv("04 - Competitors", csvOf([COMPETITORS_HEADERS])).suggestion });
    expect(sheetTab.keepInSync).toBe(true); // competitors default to kept in sync
    expect(importRequestBody(sheetTab, ["x.example"])).toMatchObject({ source: { kind: "sheets", spreadsheetId: SPREADSHEET_ID, tab: "04 - Competitors" }, keepInSync: { frequencyHours: 24 }, options: { excludeKeys: ["x.example"] } });
    const doc = { ...sheetTab, destination: "context_doc" as const, mapping: defaultMapping(sheetTab.suggestion, "context_doc", sheetTab.headers, sheetTab.label) };
    expect(canSync(doc)).toBe(false);
    expect(importRequestBody(doc)).not.toHaveProperty("keepInSync");
    expect(doc.mapping).toMatchObject({ title: "04 - Competitors", columns: COMPETITORS_HEADERS });
    const csvTab = stageCsv("04 - Competitors.csv", csvOf([COMPETITORS_HEADERS]));
    expect(importRequestBody({ ...csvTab, keepInSync: true })).not.toHaveProperty("keepInSync");
  });

  it("labels sync errors, crawl checks and OAuth errors", () => {
    expect(syncErrorLabel("token_expired")).toBe("Google authorization expired");
    expect(syncErrorHelp("token_expired")).toMatch(/7 days/);
    expect(syncErrorLabel("header_changed")).toBe("Header row changed");
    expect(syncErrorHelp("tab_missing")).toMatch(/renamed/);
    expect(crawlCheckLabel("found").text).toBe("placed per sheet · found in latest crawl");
    expect(crawlCheckLabel("not_found").text).toBe("placed per sheet · not found in latest crawl");
    expect(sheetsErrorMessage("insufficient_scope")).toMatch(/unticked/);
    expect(sheetsErrorMessage(null)).toBeNull();
  });
});

const plan: ImportPlan = {
  destination: "geo_prompts",
  sourceLabel: 'CSV "AI Questions.csv"',
  rowsRead: 3,
  truncated: false,
  counts: { add: 1, update: 0, unchanged: 0, skip: 1, remove: 0, not_added: 0 },
  summary: ["1 prompt new, 1 skipped"],
  notes: ["note"],
  items: [
    { key: "k1", label: '<script>alert("x")</script> best sconces', action: "add", reason: null, row: 2 },
    { key: "k2", label: "dup", action: "skip", reason: "duplicate question in the sheet", row: 3 },
  ],
  itemsTotal: 2,
};

const sync = (over: Partial<ImportSyncSummary> = {}): ImportSyncSummary => ({
  id: "s1",
  spreadsheetId: SPREADSHEET_ID,
  spreadsheetTitle: "Example Campaign Sheet",
  tab: "04 - Competitors",
  destination: "competitors",
  frequencyHours: 24,
  enabled: true,
  nextRunAt: "2026-10-03T10:00:00.000Z",
  lastRunAt: "2026-10-02T10:00:00.000Z",
  lastStatus: "ok",
  lastErrorCode: null,
  lastError: null,
  lastWarning: null,
  lastChanges: ["+ lumens.example", "− oldcomp.example"],
  ...over,
});

describe("import render", () => {
  it("plan rows render untrusted text as text, with include checkboxes only for changes", () => {
    const html = render(h(page.PlanView, { plan, excluded: [], onToggle: noop }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(text(html)).toContain("1 prompt new, 1 skipped");
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(1);
    expect(text(html)).toContain("duplicate question in the sheet");
  });

  it("sync list shows the change log, failures with help and a reconnect link", () => {
    const ok = text(render(h(page.SyncList, { syncs: [sync()], canManage: true, base: "/projects/p/import", projectId: "p", onChanged: noop })));
    expect(ok).toContain("In sync");
    expect(ok).toContain("+ lumens.example, − oldcomp.example, synced");
    expect(ok).toContain("Sync now");
    const failing = render(h(page.SyncList, { syncs: [sync({ lastStatus: "error", lastErrorCode: "token_expired", lastError: "Google rejected <b>it</b>", lastChanges: [] })], canManage: true, base: "/x", projectId: "p", onChanged: noop }));
    expect(text(failing)).toContain("Failing: Google authorization expired");
    expect(text(failing)).toMatch(/7 days/);
    expect(failing).toContain('href="/api/projects/p/import/sheets/connect"');
    expect(failing).not.toContain("<b>it</b>");
    const member = text(render(h(page.SyncList, { syncs: [sync()], canManage: false, base: "/x", projectId: "p", onChanged: noop })));
    expect(member).not.toContain("Sync now");
  });

  it("history shows undo only where allowed", () => {
    const rec = (over: Partial<ImportRecordSummary>): ImportRecordSummary => ({ id: "i1", source: "csv", sourceName: "AI Questions.csv", tab: "AI Questions", destination: "geo_prompts", trigger: "manual", counts: { add: 4 }, changes: ["+ q"], rowsRead: 5, status: "completed", createdAt: "2026-10-02T10:00:00.000Z", undoneAt: null, canUndo: true, ...over });
    const html = text(render(h(page.HistoryList, { history: [rec({}), rec({ id: "i0", canUndo: false, status: "undone" })], canManage: true, base: "/x", onChanged: noop })));
    expect(html.match(/Undo this import/g)).toHaveLength(1);
    expect(html).toContain("4 prompts new");
    expect(html).toContain("Undone");
  });

  it("Sheets connection explains the sensitive scope and the 7-day Testing expiry", () => {
    const status: SheetsConnectionStatus = { state: "setup_required", connectedAt: null, lastError: null, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", notes: ["Google classifies this scope as sensitive.", "Testing mode: 7 days."] };
    const html = render(h(page.SheetsConnection, { projectId: "p 1", status }));
    expect(html).toContain('href="/api/projects/p%201/import/sheets/connect"');
    expect(text(html)).toContain("sensitive");
    expect(text(html)).toContain("7 days");
  });

  it("preview and mapping fields render header names as text", () => {
    const html = render(h(page.PreviewTable, { headers: ["Question", "<i>x</i>"], rows: [["<img src=x onerror=alert(1)>", "1"]] }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<i>x</i>");
    const map = text(render(h(page.MappingFields, { destination: "competitors", mapping: { domain: "Competing Domains", metrics: ["DA"] }, headers: COMPETITORS_HEADERS, onChange: noop })));
    expect(map).toContain("Domain column");
    expect(map).toContain("Sheet metrics to keep");
  });

  it("panels on other pages are labelled as sheet data", () => {
    const report: ImportedLinksReport = {
      crawlStartedAt: "2026-10-01T00:00:00.000Z",
      total: 2,
      links: [
        { key: "a", sourceUrl: "https://shop.example.com/a", targetUrl: "https://shop.example.com/b", anchor: "brass", placedOn: "2026-09-01", status: "placed", crawl: "found", importedAt: "x" },
        { key: "b", sourceUrl: "https://shop.example.com/c", targetUrl: "https://shop.example.com/d", anchor: null, placedOn: null, status: "placed", crawl: "not_found", importedAt: "x" },
      ],
      references: [{ id: "d1", title: "Reference: Orphaned Pages", createdAt: "2026-10-01T00:00:00.000Z" }],
    };
    const links = text(render(h(panels.PlacedLinksView, { report, projectId: "p", crawlCounts: { pagesAnalysed: 20, orphanPages: 3 } })));
    expect(links).toContain("placed per sheet · found in latest crawl");
    expect(links).toContain("placed per sheet · not found in latest crawl");
    expect(links).toContain("1 of 2 found");
    expect(links).toContain("20 pages analysed, 3 orphan pages");
    const comps = text(render(h(panels.SheetCompetitorMetricsView, { rows: [{ domain: "lumens.example", status: "removed_from_sheet", notes: "n", assignedTo: "Sam", metrics: { DA: "71" }, importedAt: "2026-10-01T00:00:00.000Z", removedAt: "2026-10-02T00:00:00.000Z" }] })));
    expect(comps).toContain("from your sheet (third-party tool)");
    expect(comps).toContain("removed from sheet");
    const note = text(render(h(panels.PromptSheetNote, { note: { key: "k", text: "q", status: "in_set", notes: { "Lumens (position)": "1" }, done: "Yes", importedAt: "x" } })));
    expect(note).toContain("From your sheet (not measured by Okara): Done: Yes · Lumens (position): 1");
  });

  it("Overview lists failing syncs; the context panel lists imported research as plain text", () => {
    const feed: Feed = { agents: [], recentEvents: [], importSyncs: [{ id: "s1", spreadsheetTitle: "Sheet", tab: "04 - Competitors", destination: "competitors", code: "header_changed", message: "Column missing", lastRunAt: null }] };
    const html = text(render(h(attention.AttentionFeed, { projectId: "p", feed, onRunStarted: noop })));
    expect(html).toContain("Sheet sync failed");
    expect(html).toContain("Header row changed");
    expect(html).toContain("Fix on the Import page");
    const doc: ContextDocument = { id: "d", kind: "imported", docKey: "csv:x", title: "Content Decay", version: 1, content: "Imported research: Content Decay\n\nA | B\n<script>x</script> | 1", facts: [], unconfirmedCount: 0, createdAt: "2026-10-02T00:00:00.000Z", usedByRecommendationCount: 0 };
    const ctx = render(h(context.ImportedDocs, { docs: [doc], projectId: "p" }));
    expect(ctx).not.toContain("<script>");
    expect(text(ctx)).toContain("Imported research (1)");
    expect(syncStatusText(sync({ enabled: false }))).toBe("Paused");
  });
});
