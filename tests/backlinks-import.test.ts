/**
 * "backlinks" import destination: header auto-mapping of the Built Links tab (numeric / blank vendor header, two
 * (anchor, target) pairs per row), dry run and commit from CSV, idempotent re-import, sheet sync marking removed pairs
 * inactive (never deleted) and reactivating them, undo, skip reasons (private / IP live URL, own-site live URL,
 * off-site target), the per-project cap, and the migration rebuild keeping existing imports.
 */
import { afterEach, describe, expect, it } from "vitest";
import { suggestBacklinksMapping, suggestDestination, toTable, parseCsv, type BacklinksMapping, type ImportPlan, type ImportSyncSummary } from "@shared/import";
import { MAX_BACKLINKS_PER_PROJECT } from "@shared/backlinks";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { setImportSheetsClient } from "@worker/routes/imports";
import { SheetsApiError, type SheetsClient } from "@worker/imports/sheets";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { SPREADSHEET_ID, SPREADSHEET_TITLE, type FakeTab } from "./fixtures/sheets";
import { BUILT_LINKS_HEADERS, BUILT_LINKS_ROWS, T, builtLinksCsv } from "./backlinks-fixtures";

const app = createApp();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(env: Env, u: { sessionToken: string; csrfToken: string }, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, { method, headers: authHeaders(u.sessionToken, u.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as { data?: Json; error?: { code: string; message: string } }) : null };
}

class FakeSheet implements SheetsClient {
  tabs: FakeTab[] = [];
  async getSpreadsheet(id: string) {
    if (id !== SPREADSHEET_ID) throw new SheetsApiError(404, "not_found", "Spreadsheet not found.");
    return { spreadsheetId: id, title: SPREADSHEET_TITLE, tabs: this.tabs.map((t, index) => ({ sheetId: t.sheetId, title: t.title, index, rowCount: 1000, columnCount: 26 })) };
  }
  async getValues(_id: string, tab: string, dataRows: number) {
    const t = this.tabs.find((x) => x.title === tab);
    if (!t) throw new SheetsApiError(400, "tab_missing", "That tab was not found in the spreadsheet (renamed or deleted?).");
    return t.rows.slice(0, dataRows + 1).map((r) => [...r]);
  }
}

async function setup() {
  const env = createTestEnv();
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId);
  return { env, u, pid, db: new Db(env.DB) };
}

const MAPPING: BacklinksMapping = suggestBacklinksMapping(BUILT_LINKS_HEADERS)!;
const csvSource = (rows = BUILT_LINKS_ROWS) => ({ kind: "csv", name: "Built Links.csv", text: builtLinksCsv(rows) });

afterEach(() => setImportSheetsClient(undefined));

describe("header auto-mapping", () => {
  it("maps the Built Links header row (numeric vendor header, two anchor/target pairs)", () => {
    expect(MAPPING).toEqual({
      liveUrl: "Live URL",
      target: "Target",
      anchor: "Anchor 1",
      target2: "Target 2",
      anchor2: "Anchor 2",
      vendor: "3",
      type: "Type",
      date: "Date",
      da: "DA",
      traffic: "Traffic",
      price: "Price",
    });
    const s = suggestDestination("Built Links", BUILT_LINKS_HEADERS);
    expect(s.destination).toBe("backlinks");
  });

  it("a blank vendor header becomes 'Column 1' and is still mapped as the vendor", () => {
    const t = toTable(parseCsv(builtLinksCsv([BUILT_LINKS_ROWS[0]!], ["", ...BUILT_LINKS_HEADERS.slice(1)])).rows);
    expect(t.headers[0]).toBe("Column 1");
    expect(suggestBacklinksMapping(t.headers)?.vendor).toBe("Column 1");
  });

  it("no live URL or no target column -> not a backlinks tab; a Blog Hub tab stays 'placed links'", () => {
    expect(suggestBacklinksMapping(["Type", "Target", "DA"])).toBeNull();
    expect(suggestBacklinksMapping(["Live URL", "DA"])).toBeNull();
    expect(suggestDestination("Blog Hub Drops", ["Date", "Source Article URL", "Target URL", "Anchor"]).destination).toBe("implemented_links");
  });
});

describe("import from CSV", () => {
  it("dry run counts pairs and skip reasons; commit stores one row per pair with sheet labels", async () => {
    const s = await setup();
    const dry = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/dry-run`, { source: csvSource(), destination: "backlinks", mapping: MAPPING });
    expect(dry.status).toBe(200);
    const plan = dry.json!.data as ImportPlan;
    expect(plan.counts).toMatchObject({ add: 5, skip: 2 });
    expect(plan.summary[0]).toMatch(/^5 backlinks new, 2 skipped/);
    const reasons = plan.items.filter((i) => i.action === "skip").map((i) => i.reason);
    expect(reasons.some((r) => /public http\(s\) URL/.test(r ?? ""))).toBe(true);
    expect(reasons.some((r) => /target must be a URL on shop\.example\.com/.test(r ?? ""))).toBe(true);

    const commit = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, { source: csvSource(), destination: "backlinks", mapping: MAPPING });
    expect(commit.status).toBe(201);
    const rows = await s.db.all<Json>("SELECT * FROM backlinks WHERE workspace_id = ? AND project_id = ? ORDER BY source_row, target_url", s.u.workspaceId, s.pid);
    expect(rows).toHaveLength(5);
    const pair2 = rows.filter((r: Json) => r.live_url === "https://home-ideas.example.org/kitchen-refresh");
    expect(pair2.map((r: Json) => r.target_url).sort()).toEqual([T("/collections/hinges"), T("/collections/knobs")]);
    expect(pair2.find((r: Json) => r.target_url === T("/collections/hinges")).anchor_expected).toBe("solid brass hinges");
    const first = rows.find((r: Json) => r.live_url.includes("decor-blog"));
    expect(first).toMatchObject({ vendor: "VendorA", link_type: "Guest Post", placed_date: "2026-09-01", da: 42, traffic: 1200, price_text: "$150", active: 1, status: null });
    // A cell without a scheme gets https://, a relative target resolves against the site URL.
    expect(rows.find((r: Json) => r.live_url === "https://home-ideas.example.org/lighting")?.target_url).toBe(T("/collections/lighting"));

    // Re-import of the same rows: nothing to change, no import row.
    const again = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, { source: csvSource(), destination: "backlinks", mapping: MAPPING });
    expect(again.status).toBe(200);
    expect(again.json!.data.import).toBeNull();
    expect(again.json!.data.plan.counts).toMatchObject({ unchanged: 5 });
  });

  it("a live URL on our own site is skipped", async () => {
    const s = await setup();
    const rows = [["V", "Guest Post", "", "https://shop.example.com/blogs/news/x", "a", T("/collections/pulls"), "", "", "", "", ""]];
    const dry = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/dry-run`, { source: csvSource(rows), destination: "backlinks", mapping: MAPPING });
    expect(dry.json!.data.items[0].reason).toBe("the live URL is on your own site");
  });

  it("undo removes created backlinks and restores updated ones", async () => {
    const s = await setup();
    const first = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, { source: csvSource(), destination: "backlinks", mapping: MAPPING });
    const changed = BUILT_LINKS_ROWS.map((r) => [...r]);
    changed[0]![0] = "VendorZ";
    changed.push(["VendorD", "Guest Post", "", "https://fresh.example.net/new", "z", T("/collections/new"), "", "", "", "", ""]);
    const second = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, { source: csvSource(changed), destination: "backlinks", mapping: MAPPING });
    expect(second.json!.data.plan.counts).toMatchObject({ add: 1, update: 1 });
    const undo = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/${second.json!.data.import.id}/undo`);
    expect(undo.status).toBe(200);
    const rows = await s.db.all<Json>("SELECT vendor, live_url FROM backlinks WHERE workspace_id = ? AND project_id = ?", s.u.workspaceId, s.pid);
    expect(rows).toHaveLength(5);
    expect(rows.find((r: Json) => r.live_url.includes("decor-blog")).vendor).toBe("VendorA");
    expect(first.json!.data.import.destination).toBe("backlinks");
  });

  it(`caps active backlinks at ${MAX_BACKLINKS_PER_PROJECT} per project (rest not added)`, async () => {
    const s = await setup();
    const rows: string[][] = [];
    for (let i = 0; i < MAX_BACKLINKS_PER_PROJECT + 3; i++) rows.push(["V", "Guest Post", "", `https://site${i}.example.net/post`, "a", T(`/p/${i % 50}`), "", "", "", "", ""]);
    const commit = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, { source: csvSource(rows), destination: "backlinks", mapping: MAPPING });
    expect(commit.status).toBe(201);
    expect(commit.json!.data.plan.counts).toMatchObject({ add: MAX_BACKLINKS_PER_PROJECT, not_added: 3 });
    const n = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM backlinks WHERE project_id = ? AND active = 1", s.pid);
    expect(n?.n).toBe(MAX_BACKLINKS_PER_PROJECT);
  });
});

describe("live sync of the Built Links tab", () => {
  it("syncs: new pairs added, removed pairs marked inactive (kept), returning pairs reactivated", async () => {
    const s = await setup();
    const sheet = new FakeSheet();
    sheet.tabs = [{ sheetId: 21, title: "Built Links", rows: [BUILT_LINKS_HEADERS, ...BUILT_LINKS_ROWS.map((r) => [...r])] }];
    setImportSheetsClient(sheet);
    const preview = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/sheets/preview`, { spreadsheetId: SPREADSHEET_ID, tabs: ["Built Links"] });
    expect(preview.json!.data[0].suggestion.destination).toBe("backlinks");
    const commit = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, {
      source: { kind: "sheets", spreadsheetId: SPREADSHEET_ID, tab: "Built Links" },
      destination: "backlinks",
      mapping: preview.json!.data[0].suggestion.mapping,
      keepInSync: { frequencyHours: 24 },
    });
    expect(commit.status).toBe(201);
    const sync = commit.json!.data.sync as ImportSyncSummary;
    expect(sync.destination).toBe("backlinks");

    // The owner deletes the first row and adds a new one.
    const tab = sheet.tabs[0]!;
    tab.rows = tab.rows.filter((r) => !r[3]!.includes("decor-blog"));
    tab.rows.push(["VendorE", "Guest Post", "2026-10-01", "https://new-post.example.org/a", "brass knobs", T("/collections/knobs"), "", "", "", "", ""]);
    const r = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/syncs/${sync.id}/run`);
    expect(r.json!.data.outcome.status).toBe("ok");
    expect(r.json!.data.outcome.changes.some((l: string) => l.startsWith("+ https://new-post.example.org/a"))).toBe(true);
    expect(r.json!.data.outcome.changes.some((l: string) => l.startsWith("− https://decor-blog.example.net/brass-hardware-guide") && l.endsWith("(inactive)"))).toBe(true);
    const removed = await s.db.first<Json>("SELECT active, removed_at FROM backlinks WHERE project_id = ? AND live_url LIKE '%decor-blog%'", s.pid);
    expect(removed).toMatchObject({ active: 0 });
    expect(removed.removed_at).toBeTruthy();

    // The row comes back: monitored again.
    tab.rows.push([...BUILT_LINKS_ROWS[0]!]);
    const r2 = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/syncs/${sync.id}/run`);
    expect(r2.json!.data.outcome.status).toBe("ok");
    expect((await s.db.first<Json>("SELECT active FROM backlinks WHERE project_id = ? AND live_url LIKE '%decor-blog%'", s.pid))?.active).toBe(1);
  });
});

describe("migration 0020 (imports / import_syncs rebuilt)", () => {
  it("accepts the backlinks destination and keeps import_changes cascading from imports", async () => {
    const s = await setup();
    const commit = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, { source: csvSource(), destination: "backlinks", mapping: MAPPING });
    const id = commit.json!.data.import.id as string;
    const n = await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM import_changes WHERE import_id = ?", id);
    expect(Number(n?.n)).toBe(5);
    await s.db.run("DELETE FROM imports WHERE id = ?", id);
    expect(Number((await s.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM import_changes WHERE import_id = ?", id))?.n)).toBe(0);
  });
});
