/**
 * Ask Okara's maton_data tool: owner-only live reads through the workspace's Maton key (Sheets, Search Console
 * limited to this project's property, GA4), setup_required without a key, no key in any output. Synthetic data.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { setMatonFetch } from "@worker/platform/maton";
import type { ProjectRow } from "@worker/platform/access";
import { matonData, spreadsheetIdFrom } from "@worker/chat/tools-maton";
import { ToolError, type ToolContext } from "@worker/chat/tool-base";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";

const app = createApp();
const KEY = "mtn_CHATTEST_0123456789abcdefSECRET";
const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcde";
const seen: string[] = [];

function handler(url: URL, init?: RequestInit): Response {
  const p = url.pathname;
  if (url.hostname === "ctrl.maton.ai") {
    return Response.json({
      connections: [
        { connection_id: "c-sheets", status: "ACTIVE", creation_time: "2026-01-01T00:00:00Z", app: "google-sheets", method: "OAUTH2", url: "", metadata: {} },
        { connection_id: "c-gsc", status: "ACTIVE", creation_time: "2026-01-01T00:00:00Z", app: "google-search-console", method: "OAUTH2", url: "", metadata: {} },
        { connection_id: "c-ga", status: "ACTIVE", creation_time: "2026-01-01T00:00:00Z", app: "google-analytics-data", method: "OAUTH2", url: "", metadata: {} },
        { connection_id: "c-gaa", status: "ACTIVE", creation_time: "2026-01-01T00:00:00Z", app: "google-analytics-admin", method: "OAUTH2", url: "", metadata: {} },
      ],
    });
  }
  if (p === `/google-sheets/v4/spreadsheets/${SHEET}`) return Response.json({ spreadsheetId: SHEET, properties: { title: "Campaign" }, sheets: [{ properties: { sheetId: 1, title: "Blog Hub Drops", index: 0, sheetType: "GRID", gridProperties: { rowCount: 10, columnCount: 7 } } }] });
  if (p.startsWith(`/google-sheets/v4/spreadsheets/${SHEET}/values/`)) return Response.json({ range: "'Blog Hub Drops'!A1:G3", majorDimension: "ROWS", values: [["Date", "Source Article URL", "Target URL"], ["2026-09-01", "https://shop.example.com/blogs/a", "https://shop.example.com/collections/b"]] });
  if (p === "/google-search-console/webmasters/v3/sites") return Response.json({ siteEntry: [{ siteUrl: "https://other.example/", permissionLevel: "siteOwner" }, { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }] });
  if (p.endsWith("/searchAnalytics/query")) return Response.json({ rows: [{ keys: ["brass pulls"], clicks: 12, impressions: 300, ctr: 0.04, position: 9.3 }], responseAggregationType: "byProperty" });
  if (p === "/google-analytics-admin/v1beta/accountSummaries") return Response.json({ accountSummaries: [{ account: "accounts/1", displayName: "Shop", propertySummaries: [{ property: "properties/521310447", displayName: "shop" }] }] });
  if (p === "/google-analytics-data/v1beta/properties/521310447:runReport") {
    return Response.json({ dimensionHeaders: [{ name: "sessionSource" }], metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }], rows: [{ dimensionValues: [{ value: "chatgpt.com" }], metricValues: [{ value: "42" }] }], rowCount: 1, metadata: { currencyCode: "USD" } });
  }
  void init;
  return new Response("{}", { status: 404 });
}

beforeEach(() => {
  seen.length = 0;
  setMatonFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(u);
    return handler(new URL(u), init);
  }) as typeof fetch);
});
afterEach(() => setMatonFetch(null));

async function setup(withKey = true) {
  const env: Env = createTestEnv();
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  await env.DB.prepare("UPDATE projects SET verified_host = 'example.com', gsc_property = NULL WHERE id = ?").bind(pid).run();
  if (withKey) {
    const h = authHeaders(u.sessionToken, u.csrfToken);
    expect((await app.request(`/api/workspaces/${u.workspaceId}/maton`, { method: "PUT", headers: h, body: JSON.stringify({ apiKey: KEY }) }, env)).status).toBe(200);
    expect((await app.request(`/api/workspaces/${u.workspaceId}/maton/test`, { method: "POST", headers: h, body: "{}" }, env)).status).toBe(200);
  }
  const project = (await db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", pid))!;
  const ctx = (userId = u.userId): ToolContext => ({ env, db, project, userId, now: FIXED_NOW });
  return { env, db, u, pid, ctx };
}

const run = (ctx: ToolContext, input: Record<string, unknown>) => matonData.run(ctx, matonData.schema.parse(input));

describe("maton_data chat tool", () => {
  it("parses spreadsheet links and ids", () => {
    expect(spreadsheetIdFrom(`https://docs.google.com/spreadsheets/d/${SHEET}/edit?gid=1#gid=1`)).toBe(SHEET);
    expect(spreadsheetIdFrom(SHEET)).toBe(SHEET);
    expect(spreadsheetIdFrom("not a sheet")).toBeNull();
  });

  it("reads the live sheet, Search Console for this project's property only, and GA4, with source labels and no key", async () => {
    const { ctx } = await setup();
    const tabs = await run(ctx(), { view: "sheet_tabs", spreadsheet: `https://docs.google.com/spreadsheets/d/${SHEET}/edit` });
    expect(JSON.stringify(tabs.data)).toContain("Blog Hub Drops");
    const vals = await run(ctx(), { view: "sheet_values", spreadsheet: SHEET, range: "Blog Hub Drops" });
    expect((vals.data as { rows: string[][] }).rows[0]).toEqual(["Date", "Source Article URL", "Target URL"]);
    expect((vals.data as { source: string }).source).toMatch(/^Maton \(/);

    const gsc = await run(ctx(), { view: "gsc_query", startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["query"] });
    expect((gsc.data as { property: string }).property).toBe("sc-domain:example.com");
    expect(seen.some((u) => u.includes(encodeURIComponent("https://other.example/")))).toBe(false);

    const props = await run(ctx(), { view: "ga_properties" });
    expect(JSON.stringify(props.data)).toContain("521310447");
    const rep = await run(ctx(), { view: "ga_report", propertyId: "521310447", metrics: ["sessions"], dimensions: ["sessionSource"], filter: { dimension: "sessionSource", contains: "chatgpt" } });
    expect((rep.data as { rows: unknown[] }).rows).toEqual([{ dimensions: ["chatgpt.com"], metrics: ["42"] }]);

    for (const o of [tabs, vals, gsc, props, rep]) expect(JSON.stringify(o)).not.toContain(KEY);
  });

  it("is owner-only for live reads (status is open to members)", async () => {
    const { db, u, ctx } = await setup();
    const memberId = newId("usr");
    await db.insert("users", { id: memberId, google_sub: `sub-${memberId}`, email: `${memberId}@example.com`, name: "M", created_at: FIXED_NOW.toISOString() });
    await db.insert("memberships", { workspace_id: u.workspaceId, user_id: memberId, role: "member", created_at: FIXED_NOW.toISOString() });
    await expect(run(ctx(memberId), { view: "sheet_tabs", spreadsheet: SHEET })).rejects.toBeInstanceOf(ToolError);
    const st = await run(ctx(memberId), { view: "status" });
    expect(JSON.stringify(st)).not.toContain(KEY);
  });

  it("says setup_required without a Maton key and makes no call", async () => {
    const { ctx } = await setup(false);
    await expect(run(ctx(), { view: "sheet_tabs", spreadsheet: SHEET })).rejects.toThrow(/setup_required/);
    expect(seen).toEqual([]);
  });

  it("refuses Search Console when Maton has no property for this project", async () => {
    const { env, pid, ctx } = await setup();
    await env.DB.prepare("UPDATE projects SET verified_host = 'unrelated.test' WHERE id = ?").bind(pid).run();
    const db = new Db(env.DB);
    const project = (await db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", pid))!;
    await expect(matonData.run({ ...ctx(), project }, matonData.schema.parse({ view: "gsc_query", startDate: "2026-09-01", endDate: "2026-09-30" }))).rejects.toThrow(/no property for this project/);
  });
});
