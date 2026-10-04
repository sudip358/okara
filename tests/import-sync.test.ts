/**
 * Live sync of sheet-linked imports: competitors (add / remove / metrics update, DataForSEO queue), GEO prompts
 * (new questions pending, removed ones archived), placed links (append only); idempotency; token-expired,
 * header-changed, tab renamed / deleted and not-connected paths surfaced on the Import page and the Overview
 * attention feed; cron pickup by next_run_at; lease; frequency validation; tenancy. Fake Sheets client only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { setImportSheetsClient } from "@worker/routes/imports";
import { setCompetitorDataFetch } from "@worker/competitors/dataforseo";
import { SheetsApiError, type SheetsClient } from "@worker/imports/sheets";
import { processDueImportSyncs } from "@worker/imports/sync";
import type { ImportOverview, ImportSyncSummary } from "@shared/import";
import type { AttentionFeed, GeoPromptSet, Project } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { BLOG_HUB_HEADERS, COMPETITORS_HEADERS, SPREADSHEET_ID, SPREADSHEET_TITLE, aiQuestionRows, blogHubRows, competitorRows, type FakeTab } from "./fixtures/sheets";

const app = createApp();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function call(env: Env, u: { sessionToken: string; csrfToken: string }, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, { method, headers: authHeaders(u.sessionToken, u.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as { data?: Json; error?: { code: string; message: string } }) : null };
}

/** In-memory spreadsheet behind the SheetsClient interface; tests edit `tabs` between syncs. */
class FakeSheet implements SheetsClient {
  tabs: FakeTab[] = [];
  failWith: SheetsApiError | null = null;
  reads = 0;
  async getSpreadsheet(id: string) {
    if (this.failWith) throw this.failWith;
    if (id !== SPREADSHEET_ID) throw new SheetsApiError(404, "not_found", "Spreadsheet not found.");
    return { spreadsheetId: id, title: SPREADSHEET_TITLE, tabs: this.tabs.map((t, index) => ({ sheetId: t.sheetId, title: t.title, index, rowCount: 1000, columnCount: 26 })) };
  }
  async getValues(_id: string, tab: string, dataRows: number) {
    this.reads++;
    if (this.failWith) throw this.failWith;
    const t = this.tabs.find((x) => x.title === tab);
    if (!t) throw new SheetsApiError(400, "tab_missing", "That tab was not found in the spreadsheet (renamed or deleted?).");
    return t.rows.slice(0, dataRows + 1).map((r) => [...r]);
  }
}

const COMP_MAPPING = { domain: "Competing Domains", notes: "Notes", assignedTo: "Assigned to", metrics: COMPETITORS_HEADERS.slice(3) };

async function setup(envOver: Partial<Env> = {}) {
  const env = createTestEnv(envOver);
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId, { brand_name: "Residence Supply" });
  const sheet = new FakeSheet();
  sheet.tabs = [
    { sheetId: 11, title: "04 - Competitors", rows: competitorRows() },
    { sheetId: 12, title: "AI Questions", rows: aiQuestionRows() },
    { sheetId: 13, title: "Blog Hub Drops", rows: blogHubRows() },
  ];
  setImportSheetsClient(sheet);
  return { env, u, pid, sheet, db: new Db(env.DB) };
}

async function linkCompetitors(s: Awaited<ReturnType<typeof setup>>, frequencyHours = 24) {
  const r = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, {
    source: { kind: "sheets", spreadsheetId: SPREADSHEET_ID, tab: "04 - Competitors" },
    destination: "competitors",
    mapping: COMP_MAPPING,
    keepInSync: { frequencyHours },
  });
  expect(r.status).toBe(201);
  return r.json!.data.sync as ImportSyncSummary;
}

const syncNow = (s: Awaited<ReturnType<typeof setup>>, id: string) => call(s.env, s.u, "POST", `/projects/${s.pid}/import/syncs/${id}/run`);

afterEach(() => {
  setImportSheetsClient(undefined);
  setCompetitorDataFetch(null);
});

describe("competitor sync", () => {
  it("adds new domains (queues DataForSEO), untracks removed ones (history kept), updates metrics; idempotent", async () => {
    const s = await setup({ DATAFORSEO_LOGIN: "op@example.com", DATAFORSEO_PASSWORD: "op-password" });
    setCompetitorDataFetch((async () => new Response("{}", { status: 500 })) as typeof fetch);
    const sync = await linkCompetitors(s);
    expect(sync).toMatchObject({ destination: "competitors", frequencyHours: 24, enabled: true, lastStatus: "ok", tab: "04 - Competitors" });
    expect(sync.lastChanges).toEqual(["+ lumens.example", "+ rejuvenation.example", "+ forbes-lomax.example"]);

    // The owner edits the sheet: one domain added, one removed, a metric changed.
    const tab = s.sheet.tabs[0]!;
    tab.rows = tab.rows.filter((r) => r[0] !== "rejuvenation.example");
    tab.rows.find((r) => r[0] === "lumens.example")![3] = "72";
    tab.rows.push(["newcomp.example", "Spotted in AI answers", "Sam", "30"]);

    const r = await syncNow(s, sync.id);
    expect(r.status).toBe(200);
    expect(r.json!.data.outcome.status).toBe("ok");
    expect(r.json!.data.outcome.changes).toEqual(["+ newcomp.example", "− rejuvenation.example"]);
    expect(r.json!.data.sync.lastChanges).toEqual(["+ newcomp.example", "− rejuvenation.example"]);

    const project = (await call(s.env, s.u, "GET", `/projects/${s.pid}`)).json!.data as Project;
    const domains = project.competitors.flatMap((c) => c.domains);
    expect(domains).toContain("newcomp.example");
    expect(domains).not.toContain("rejuvenation.example");
    expect(domains).toContain("brassco.example"); // the owner's own competitor is untouched

    const recs = (await call(s.env, s.u, "GET", `/projects/${s.pid}/import/records/competitors`)).json!.data as Json[];
    const rej = recs.find((x) => x.domain === "rejuvenation.example");
    expect(rej.status).toBe("removed_from_sheet");
    expect(rej.removedAt).toBeTruthy();
    expect(rej.metrics.DA).toBe("68"); // history kept
    expect(recs.find((x) => x.domain === "lumens.example").metrics.DA).toBe("72");
    const fetched = (await s.db.all<{ domain: string }>("SELECT domain FROM competitor_fetches WHERE project_id = ?", s.pid)).map((f) => f.domain);
    expect(fetched).toContain("newcomp.example");

    // Unchanged sheet: no import row, no change.
    const before = await s.db.all("SELECT id FROM imports WHERE project_id = ?", s.pid);
    const again = await syncNow(s, sync.id);
    expect(again.json!.data.outcome).toMatchObject({ status: "ok", changes: [], import: null });
    expect(await s.db.all("SELECT id FROM imports WHERE project_id = ?", s.pid)).toHaveLength(before.length);

    // The removed domain comes back to the sheet -> tracked again.
    tab.rows.push(["rejuvenation.example", "", "Ana", "69"]);
    const back = await syncNow(s, sync.id);
    expect(back.json!.data.outcome.changes).toEqual(["+ rejuvenation.example"]);
  });

  it("[A39] keeps the fetch choice and accepted typo fixes for later syncs; adds new sheet domains up to the 60 cap; removed ones are untracked as before", async () => {
    const s = await setup({ DATAFORSEO_LOGIN: "op@example.com", DATAFORSEO_PASSWORD: "op-password" });
    setCompetitorDataFetch((async () => new Response("{}", { status: 500 })) as typeof fetch);
    // 55 tracked already (Brass Co + 54): the sheet's 4 domains fit, then only 1 slot is left.
    const existing = [{ name: "Brass Co", domains: ["brassco.example"], aliases: [] }, ...Array.from({ length: 54 }, (_, i) => ({ name: `Old ${i}`, domains: [`old${i}.example`], aliases: [] }))];
    await s.db.run("UPDATE projects SET competitors_json = ? WHERE id = ?", JSON.stringify(existing), s.pid);
    s.sheet.tabs[0]!.rows.push(["ww.typo-fixed.example", "typo", "", "10"]);
    const r = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, {
      source: { kind: "sheets", spreadsheetId: SPREADSHEET_ID, tab: "04 - Competitors" },
      destination: "competitors",
      mapping: COMP_MAPPING,
      options: { fetchCompetitorData: false, acceptDomainFixes: ["ww.typo-fixed.example"] },
      keepInSync: { frequencyHours: 24 },
    });
    expect(r.status).toBe(201);
    expect(r.json!.data.changes).toEqual(["+ lumens.example", "+ rejuvenation.example", "+ forbes-lomax.example", "+ typo-fixed.example"]);
    const sync = r.json!.data.sync as ImportSyncSummary;
    const stored = await s.db.first<{ options_json: string }>("SELECT options_json FROM import_syncs WHERE id = ?", sync.id);
    expect(JSON.parse(stored!.options_json)).toMatchObject({ fetchCompetitorData: false, acceptDomainFixes: ["ww.typo-fixed.example"] });

    // The sheet grows by 2: one slot left (60 cap) -> 1 added, 1 not added (limit); no DataForSEO fetch (choice kept).
    const tab = s.sheet.tabs[0]!;
    tab.rows.push(["https://www.grow-a.example/page", "", "", "1"], ["grow-b.example", "", "", "2"]);
    const r1 = await syncNow(s, sync.id);
    expect(r1.json!.data.outcome.changes).toEqual(["+ grow-a.example"]);
    let project = (await call(s.env, s.u, "GET", `/projects/${s.pid}`)).json!.data as Project;
    expect(project.competitors).toHaveLength(60);
    expect(await s.db.all("SELECT id FROM competitor_fetches WHERE project_id = ?", s.pid)).toHaveLength(0);
    expect(await s.db.all("SELECT id FROM competitor_fetch_backlog WHERE project_id = ?", s.pid)).toHaveLength(0);

    // A domain removed from the sheet is untracked by the sync (existing behaviour), freeing the slot for grow-b.
    tab.rows = tab.rows.filter((row) => row[0] !== "rejuvenation.example");
    const r2 = await syncNow(s, sync.id);
    expect(r2.json!.data.outcome.changes).toEqual(["+ grow-b.example", "− rejuvenation.example"]);
    project = (await call(s.env, s.u, "GET", `/projects/${s.pid}`)).json!.data as Project;
    expect(project.competitors).toHaveLength(60);
    expect(project.competitors.flatMap((c) => c.domains)).toEqual(expect.arrayContaining(["typo-fixed.example", "grow-b.example"]));
  });

  it("token expired, header changed, tab renamed and deleted, not connected: surfaced, never silent", async () => {
    const s = await setup();
    const sync = await linkCompetitors(s);

    s.sheet.failWith = new SheetsApiError(400, "token_expired", "Google rejected the stored Google Sheets authorization (invalid_grant): it expired or was revoked. While the OAuth app is in Testing mode Google expires it after 7 days.");
    let r = await syncNow(s, sync.id);
    expect(r.json!.data.outcome).toMatchObject({ status: "error", code: "token_expired" });
    expect(r.json!.data.sync).toMatchObject({ lastStatus: "error", lastErrorCode: "token_expired", enabled: true });
    const att = (await call(s.env, s.u, "GET", `/projects/${s.pid}/attention`)).json!.data as AttentionFeed;
    expect(att.importSyncs).toHaveLength(1);
    expect(att.importSyncs![0]).toMatchObject({ code: "token_expired", tab: "04 - Competitors", destination: "competitors" });
    expect(att.importSyncs![0]!.message).toMatch(/7 days/);
    const ov = (await call(s.env, s.u, "GET", `/projects/${s.pid}/import`)).json!.data as ImportOverview;
    expect(ov.syncs[0]!.lastErrorCode).toBe("token_expired");
    s.sheet.failWith = null;

    // Header changed: the domain column was renamed.
    const tab = s.sheet.tabs[0]!;
    tab.rows[0] = ["Domain", ...COMPETITORS_HEADERS.slice(1)];
    r = await syncNow(s, sync.id);
    expect(r.json!.data.outcome.code).toBe("header_changed");
    expect(r.json!.data.outcome.message).toMatch(/"Competing Domains" not found/);
    const project = (await call(s.env, s.u, "GET", `/projects/${s.pid}`)).json!.data as Project;
    expect(project.competitors.flatMap((c) => c.domains)).toContain("lumens.example"); // nothing removed on a bad header
    tab.rows[0] = [...COMPETITORS_HEADERS];

    // Tab renamed (same sheetId): followed, with a warning; success clears the error.
    tab.title = "Competitors 2026";
    r = await syncNow(s, sync.id);
    expect(r.json!.data.outcome.status).toBe("ok");
    expect(r.json!.data.sync.lastWarning).toMatch(/renamed from "04 - Competitors" to "Competitors 2026"/);
    expect(r.json!.data.sync.tab).toBe("Competitors 2026");
    expect(((await call(s.env, s.u, "GET", `/projects/${s.pid}/attention`)).json!.data as AttentionFeed).importSyncs).toEqual([]);

    // Tab deleted.
    s.sheet.tabs = s.sheet.tabs.filter((t) => t.sheetId !== 11);
    r = await syncNow(s, sync.id);
    expect(r.json!.data.outcome.code).toBe("tab_missing");

    // Not connected.
    setImportSheetsClient(null);
    r = await syncNow(s, sync.id);
    expect(r.json!.data.outcome.code).toBe("not_connected");
  });
});

describe("prompt and link sync", () => {
  it("adds new questions pending approval and archives removed ones (earlier versions kept); links append", async () => {
    const s = await setup();
    const p = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, {
      source: { kind: "sheets", spreadsheetId: SPREADSHEET_ID, tab: "AI Questions" },
      destination: "geo_prompts",
      mapping: { question: "Question", done: "Done" },
      options: { approvePrompts: true },
      keepInSync: { frequencyHours: 12 },
    });
    expect(p.status).toBe(201);
    const promptSync = p.json!.data.sync as ImportSyncSummary;
    const qTab = s.sheet.tabs[1]!;
    qTab.rows = qTab.rows.filter((r) => !String(r[0]).startsWith("How do I pick"));
    qTab.rows.push(["Where can I buy unlacquered brass sconces?"]);
    const r = await syncNow(s, promptSync.id);
    expect(r.json!.data.outcome.changes).toEqual(["+ Where can I buy unlacquered brass sconces?", "− How do I pick a pendant light size for a kitchen island (archived)"]);
    const set = (await call(s.env, s.u, "GET", `/projects/${s.pid}/geo/prompts`)).json!.data as GeoPromptSet;
    expect(set.label).toMatch(/^Synced from sheet /);
    expect(set.prompts.map((x) => x.text)).not.toContain("How do I pick a pendant light size for a kitchen island");
    const added = set.prompts.find((x) => x.text === "Where can I buy unlacquered brass sconces?")!;
    expect(added.approved).toBe(false); // synced questions always wait for approval
    expect(set.prompts.find((x) => x.text.startsWith("What are the best"))!.approved).toBe(true);
    const old = await s.db.all<{ text: string }>("SELECT p.text FROM geo_prompts p JOIN geo_prompt_sets s ON s.id = p.prompt_set_id WHERE s.project_id = ? AND s.version = 1", s.pid);
    expect(old.map((x) => x.text)).toContain("How do I pick a pendant light size for a kitchen island"); // history kept
    expect((await syncNow(s, promptSync.id)).json!.data.outcome.changes).toEqual([]);

    const l = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, {
      source: { kind: "sheets", spreadsheetId: SPREADSHEET_ID, tab: "Blog Hub Drops" },
      destination: "implemented_links",
      mapping: { source: "Source Article URL", target: "Target URL", anchor: "Anchor" },
      keepInSync: { frequencyHours: 6 },
    });
    const linkSync = l.json!.data.sync as ImportSyncSummary;
    const lTab = s.sheet.tabs[2]!;
    lTab.rows = [BLOG_HUB_HEADERS, ["2026-09-20", "/blogs/news/brass-patina", "/products/brass-pull", "brass pulls"]];
    const lr = await syncNow(s, linkSync.id);
    expect(lr.json!.data.outcome.changes).toHaveLength(1);
    const links = (await call(s.env, s.u, "GET", `/projects/${s.pid}/import/links`)).json!.data;
    expect(links.links).toHaveLength(3); // append only: the two earlier links stay recorded
  });
});

describe("cron, settings and guards", () => {
  it("the cron runs only due syncs; PATCH validates frequency; a held lease means busy; CSV cannot sync; tenancy", async () => {
    const s = await setup();
    const sync = await linkCompetitors(s, 6);
    s.sheet.reads = 0;
    const now = new Date();
    expect(await processDueImportSyncs(s.env, now, { sheets: s.sheet })).toEqual({ processed: 0, failed: 0 });
    expect(s.sheet.reads).toBe(0);
    const later = new Date(now.getTime() + 6 * 3600_000 + 60_000);
    expect(await processDueImportSyncs(s.env, later, { sheets: s.sheet })).toEqual({ processed: 1, failed: 0 });
    expect(s.sheet.reads).toBe(1);
    const row = await s.db.first<{ next_run_at: string; last_run_at: string }>("SELECT next_run_at, last_run_at FROM import_syncs WHERE id = ?", sync.id);
    expect(new Date(row!.next_run_at).getTime()).toBe(later.getTime() + 6 * 3600_000);

    expect((await call(s.env, s.u, "PATCH", `/projects/${s.pid}/import/syncs/${sync.id}`, { frequencyHours: 3 })).status).toBe(400);
    const patched = await call(s.env, s.u, "PATCH", `/projects/${s.pid}/import/syncs/${sync.id}`, { frequencyHours: 12, enabled: false });
    expect(patched.json!.data).toMatchObject({ frequencyHours: 12, enabled: false });
    expect(await processDueImportSyncs(s.env, new Date(later.getTime() + 48 * 3600_000), { sheets: s.sheet })).toEqual({ processed: 0, failed: 0 });

    await s.db.run("UPDATE import_syncs SET running_until = ? WHERE id = ?", new Date(Date.now() + 600_000).toISOString(), sync.id);
    expect((await syncNow(s, sync.id)).json!.data.outcome.status).toBe("busy");

    const csvSync = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, {
      source: { kind: "csv", name: "c.csv", text: "Competing Domains\nx.example" },
      destination: "competitors",
      mapping: { domain: "Competing Domains" },
      keepInSync: { frequencyHours: 24 },
    });
    expect(csvSync.status).toBe(400);

    const other = await seedUser(s.env);
    expect((await call(s.env, other, "POST", `/projects/${s.pid}/import/syncs/${sync.id}/run`)).status).toBe(404);
    const otherPid = await seedProject(s.env, other.workspaceId);
    expect((await call(s.env, other, "POST", `/projects/${otherPid}/import/syncs/${sync.id}/run`)).status).toBe(404);
    expect((await call(s.env, other, "DELETE", `/projects/${otherPid}/import/syncs/${sync.id}`)).status).toBe(404);

    const del = await call(s.env, s.u, "DELETE", `/projects/${s.pid}/import/syncs/${sync.id}`);
    expect(del.status).toBe(200);
    const project = (await call(s.env, s.u, "GET", `/projects/${s.pid}`)).json!.data as Project;
    expect(project.competitors.flatMap((c) => c.domains)).toContain("lumens.example"); // stop syncing keeps the data
  });
});
