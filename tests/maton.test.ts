/**
 * Maton.ai API gateway: strict egress policy (every non-allowed app/path/method refused before any fetch; the key never
 * in errors or outputs), key routes (encrypted storage, owner-only set/test/remove/pick, tenancy, no echo), connection
 * listing parsing (documented shape), Sheets import and cron sync through Maton (native paths and shapes, Maton-
 * Connection header when picked, transport recorded), Search Console source and gsc_sync through Maton, transport
 * precedence (direct OAuth wins; Maton when direct is missing; neither -> setup_required), and the tenant-scoped
 * helpers for Ask Okara (Sheets, GSC, GA4 runReport/accountSummaries; size caps; source label; provider_calls).
 * Every network call goes to a fake fetch; nothing reaches Maton.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { decryptSecret } from "@worker/lib/crypto";
import { createSession } from "@worker/platform/session";
import {
  checkMatonRequest,
  gaListProperties,
  gaRunReport,
  gscQuery,
  gscSites,
  listActiveConnections,
  matonRequest,
  matonStatus,
  MatonApiError,
  MatonPolicyError,
  MatonSetupRequiredError,
  parseConnections,
  readSheetTabs,
  readSheetValues,
  setMatonFetch,
  type MatonScope,
} from "@worker/platform/maton";
import { matonAad } from "@worker/platform/maton-credentials";
import { resolveGscProvider } from "@worker/platform/gsc-maton";
import { resolveSheetsClient } from "@worker/imports/sheets-maton";
import { processDueImportSyncs } from "@worker/imports/sync";
import { syncGsc } from "@worker/seo/gsc/sync";
import type { ImportOverview } from "@shared/import";
import type { IntegrationsStatus } from "@shared/types";
import type { GscMatonStatus, MatonStatus, MatonTestResult } from "@shared/maton";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { AI_QUESTIONS_HEADERS, SPREADSHEET_ID, SPREADSHEET_TITLE, aiQuestionRows } from "./fixtures/sheets";

const app = createApp();
const KEY = "mtn_TESTKEY_abcdef0123456789SECRET";
const CONN_SHEETS_OLD = "11111111-aaaa-4bbb-8ccc-000000000001";
const CONN_SHEETS_NEW = "11111111-aaaa-4bbb-8ccc-000000000002";
const CONN_GSC = "22222222-aaaa-4bbb-8ccc-000000000003";
const CONN_GA = "33333333-aaaa-4bbb-8ccc-000000000004";
const CONN_GA_ADMIN = "44444444-aaaa-4bbb-8ccc-000000000005";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
const seen: Seen[] = [];
type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
let handler: Handler;

/** Documented list shape (SKILL.md "List Connections"), with an unrelated app and a session URL that must be dropped. */
const connectionsResponse = () => ({
  connections: [
    { connection_id: CONN_SHEETS_OLD, status: "ACTIVE", creation_time: "2025-12-08T07:20:53.488460Z", last_updated_time: "2026-01-31T20:03:32.593153Z", url: "https://connect.maton.ai/?session_token=5e9SECRET", app: "google-sheets", method: "OAUTH2", metadata: {} },
    { connection_id: CONN_SHEETS_NEW, status: "ACTIVE", creation_time: "2026-02-01T10:00:00.000000Z", last_updated_time: "2026-02-01T10:00:00.000000Z", url: "https://connect.maton.ai/?session_token=x", app: "google-sheets", method: "OAUTH2", metadata: { anything: "x" } },
    { connection_id: CONN_GSC, status: "ACTIVE", creation_time: "2026-01-05T00:00:00Z", last_updated_time: "2026-01-05T00:00:00Z", url: "https://connect.maton.ai/?session_token=y", app: "google-search-console", method: "OAUTH2", metadata: {} },
    { connection_id: CONN_GA, status: "ACTIVE", creation_time: "2026-01-06T00:00:00Z", last_updated_time: "2026-01-06T00:00:00Z", url: "https://connect.maton.ai/?session_token=z", app: "google-analytics-data", method: "OAUTH2", metadata: {} },
    { connection_id: CONN_GA_ADMIN, status: "ACTIVE", creation_time: "2026-01-06T00:00:00Z", last_updated_time: "2026-01-06T00:00:00Z", url: "", app: "google-analytics-admin", method: "OAUTH2", metadata: {} },
    { connection_id: "55555555-aaaa-4bbb-8ccc-000000000006", status: "ACTIVE", creation_time: "2026-01-07T00:00:00Z", url: "", app: "google-mail", method: "OAUTH2", metadata: {} },
    { connection_id: "66666666-aaaa-4bbb-8ccc-000000000007", status: "ACTIVE", creation_time: "2026-01-07T00:00:00Z", url: "", app: "github", method: "OAUTH2", metadata: {} },
  ],
});

/** Native Sheets v4 Spreadsheet (fields mask) and ValueRange shapes. */
const spreadsheetResponse = () => ({
  spreadsheetId: SPREADSHEET_ID,
  properties: { title: SPREADSHEET_TITLE },
  sheets: [
    { properties: { sheetId: 12, title: "AI Questions", index: 0, sheetType: "GRID", gridProperties: { rowCount: 1000, columnCount: 26 } } },
    { properties: { sheetId: 99, title: "Chart", index: 1, sheetType: "OBJECT" } },
  ],
});
const valuesResponse = (rows: string[][]) => ({ range: "'AI Questions'!A1:CV5001", majorDimension: "ROWS", values: rows });

let sheetRows: string[][];

function defaultHandler(): Handler {
  return (url, init) => {
    const p = url.pathname;
    if (url.hostname === "ctrl.maton.ai" && p === "/connections") return Response.json(connectionsResponse());
    if (p === `/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}`) return Response.json(spreadsheetResponse());
    if (p.startsWith(`/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values/`)) return Response.json(valuesResponse(sheetRows));
    if (p === "/google-search-console/webmasters/v3/sites") {
      return Response.json({ siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }, { siteUrl: "https://other.example/", permissionLevel: "siteRestrictedUser" }] });
    }
    if (p.endsWith("/searchAnalytics/query")) {
      const body = JSON.parse(String(init?.body)) as { dimensions: string[] };
      if (body.dimensions.length === 0) return Response.json({ rows: [{ keys: [], clicks: 120, impressions: 4000, ctr: 0.03, position: 8.2 }], responseAggregationType: "byProperty" });
      return Response.json({ rows: [], responseAggregationType: "byPage" });
    }
    if (p === "/google-analytics-admin/v1beta/accountSummaries") {
      return Response.json({ accountSummaries: [{ name: "accountSummaries/1", account: "accounts/1", displayName: "Shop", propertySummaries: [{ property: "properties/521310447", displayName: "shop.example.com", propertyType: "PROPERTY_TYPE_ORDINARY", parent: "accounts/1" }] }] });
    }
    if (p === "/google-analytics-data/v1beta/properties/521310447:runReport") {
      return Response.json({
        dimensionHeaders: [{ name: "landingPage" }, { name: "sessionSource" }],
        metricHeaders: [{ name: "sessions", type: "TYPE_INTEGER" }, { name: "totalRevenue", type: "TYPE_CURRENCY" }],
        rows: [
          { dimensionValues: [{ value: "/products/brass-pull" }, { value: "chatgpt.com" }], metricValues: [{ value: "42" }, { value: "310.5" }] },
          { dimensionValues: [{ value: "/" }, { value: "perplexity.ai" }], metricValues: [{ value: "7" }, { value: "0" }] },
        ],
        rowCount: 2,
        metadata: { currencyCode: "USD", timeZone: "America/New_York" },
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
}

function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({ url, method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return handler(new URL(url), init);
  }) as typeof fetch;
}

beforeEach(() => {
  seen.length = 0;
  sheetRows = aiQuestionRows();
  handler = defaultHandler();
  setMatonFetch(fakeFetch());
});
afterEach(() => setMatonFetch(null));

const bodies: string[] = [];
type U = { sessionToken: string; csrfToken: string };
async function call(env: Env, u: U, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, { method, headers: authHeaders(u.sessionToken, u.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: text ? (JSON.parse(text) as { data?: Json; error?: { code: string; message: string } }) : null };
}

async function seedMember(env: Env, workspaceId: string) {
  const db = new Db(env.DB);
  const userId = newId("usr");
  await db.insert("users", { id: userId, google_sub: `sub-${userId}`, email: `${userId}@example.com`, name: "Member", created_at: FIXED_NOW.toISOString() });
  await db.insert("memberships", { workspace_id: workspaceId, user_id: userId, role: "member", created_at: FIXED_NOW.toISOString() });
  const s = await createSession(db, userId, new Date());
  return { userId, sessionToken: s.token, csrfToken: s.csrfToken };
}

async function setup() {
  const env = createTestEnv();
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId);
  return { env, u, pid, db: new Db(env.DB) };
}

/** Save the key and run the saved-key test (stores the connection list). */
async function connectMaton(env: Env, u: U & { workspaceId: string }) {
  expect((await call(env, u, "PUT", `/workspaces/${u.workspaceId}/maton`, { apiKey: KEY })).status).toBe(200);
  const t = await call(env, u, "POST", `/workspaces/${u.workspaceId}/maton/test`, {});
  expect(t.status).toBe(200);
  expect(t.json!.data.ok).toBe(true);
}

const deps = (over: Record<string, unknown> = {}) => ({ env: {}, apiKey: KEY, purpose: "test", ...over });

// ------------------------------------------------------------------ egress policy
describe("Maton egress policy", () => {
  const allowed: Array<[string, string]> = [
    ["GET", "https://ctrl.maton.ai/connections"],
    ["GET", "https://ctrl.maton.ai/connections?status=ACTIVE"],
    ["GET", "https://ctrl.maton.ai/connections?app=google-sheets&status=ACTIVE"],
    ["GET", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties`],
    ["GET", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values/'AI%20Questions'!A1%3AD10?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`],
    ["GET", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites"],
    ["POST", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query"],
    ["POST", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites/https%3A%2F%2Fshop.example.com%2F/searchAnalytics/query"],
    ["POST", "https://gateway.maton.ai/google-analytics-data/v1beta/properties/521310447:runReport"],
    ["GET", "https://gateway.maton.ai/google-analytics-admin/v1beta/accountSummaries"],
    ["GET", "https://gateway.maton.ai/google-analytics-admin/v1beta/accountSummaries?pageSize=200&pageToken=abc"],
  ];
  const refused: Array<[string, string]> = [
    // other apps reachable with the same key
    ["GET", "https://gateway.maton.ai/google-mail/gmail/v1/users/me/messages"],
    ["POST", "https://gateway.maton.ai/google-mail/gmail/v1/users/me/messages/send"],
    ["GET", "https://gateway.maton.ai/google-drive/drive/v3/files"],
    ["GET", "https://gateway.maton.ai/github/user/repos"],
    ["DELETE", "https://gateway.maton.ai/github/repos/o/r"],
    ["POST", "https://gateway.maton.ai/slack/api/chat.postMessage"],
    // Sheets writes and other methods
    ["PUT", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values/Sheet1!A1?valueInputOption=USER_ENTERED`],
    ["POST", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values/Sheet1!A1:append`],
    ["GET", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values/Sheet1!A1:append`],
    ["POST", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values/Sheet1:clear`],
    ["POST", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values:batchUpdate`],
    ["GET", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values:batchGet?ranges=A1`],
    ["POST", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`],
    ["GET", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`],
    ["POST", "https://gateway.maton.ai/google-sheets/v4/spreadsheets"],
    ["DELETE", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}`],
    ["GET", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}?includeGridData=true`],
    ["GET", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values/A1/../../../../google-mail/gmail/v1/users/me/messages`],
    ["GET", `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values/%2e%2e/%2e%2e/%2e%2e/%2e%2e/github/user`],
    ["GET", "https://gateway.maton.ai/google-sheets/v4/spreadsheets/short"],
    // Search Console writes and other endpoints
    ["PUT", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fx%2Fs.xml"],
    ["DELETE", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/x"],
    ["GET", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps"],
    ["GET", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites/sc-domain%3Aexample.com"],
    ["PUT", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites/sc-domain%3Aexample.com"],
    ["DELETE", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites/sc-domain%3Aexample.com"],
    ["GET", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query"],
    ["POST", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites/sc-domain:example.com/searchAnalytics/query"],
    ["POST", "https://gateway.maton.ai/google-search-console/webmasters/v3/sites?x=1"],
    // GA: only runReport and accountSummaries
    ["POST", "https://gateway.maton.ai/google-analytics-data/v1beta/properties/521310447:runRealtimeReport"],
    ["POST", "https://gateway.maton.ai/google-analytics-data/v1beta/properties/521310447:batchRunReports"],
    ["GET", "https://gateway.maton.ai/google-analytics-data/v1beta/properties/521310447/metadata"],
    ["GET", "https://gateway.maton.ai/google-analytics-data/v1beta/properties/521310447:runReport"],
    ["POST", "https://gateway.maton.ai/google-analytics-data/v1beta/properties/abc:runReport"],
    ["GET", "https://gateway.maton.ai/google-analytics-admin/v1beta/accounts"],
    ["POST", "https://gateway.maton.ai/google-analytics-admin/v1beta/properties"],
    ["PATCH", "https://gateway.maton.ai/google-analytics-admin/v1beta/properties/1"],
    ["POST", "https://gateway.maton.ai/google-analytics-admin/v1beta/accountSummaries"],
    // control plane: listing only
    ["POST", "https://ctrl.maton.ai/connections"],
    ["GET", `https://ctrl.maton.ai/connections/${CONN_GSC}`],
    ["DELETE", `https://ctrl.maton.ai/connections/${CONN_GSC}`],
    ["GET", "https://ctrl.maton.ai/connections?app=google-mail"],
    ["GET", "https://ctrl.maton.ai/connections?status=PENDING"],
    // scheme, host, port, credentials
    ["GET", "http://gateway.maton.ai/google-search-console/webmasters/v3/sites"],
    ["GET", "https://gateway.maton.ai:8443/google-search-console/webmasters/v3/sites"],
    ["GET", "https://user:pw@gateway.maton.ai/google-search-console/webmasters/v3/sites"],
    ["GET", "https://evil.example/google-search-console/webmasters/v3/sites"],
    ["GET", "https://api.maton.ai/google-search-console/webmasters/v3/sites"],
    ["GET", "not a url"],
  ];

  it("admits exactly the documented read-only requests", () => {
    for (const [m, u] of allowed) expect(() => checkMatonRequest(m, u), `${m} ${u}`).not.toThrow();
  });

  it("refuses every other app, path and method before any fetch, without the key in the error", async () => {
    for (const [m, u] of refused) {
      expect(() => checkMatonRequest(m, u), `${m} ${u}`).toThrow(MatonPolicyError);
      const err = await matonRequest(deps(), { method: m as "GET", url: u, body: m === "GET" ? undefined : {} }).catch((e: unknown) => e);
      expect(err, `${m} ${u}`).toBeInstanceOf(MatonPolicyError);
      expect(String((err as Error).message)).not.toContain(KEY);
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a bad connection id header and a GET body", async () => {
    await expect(matonRequest(deps(), { method: "GET", url: "https://gateway.maton.ai/google-search-console/webmasters/v3/sites", connectionId: "x\r\nEvil: 1" })).rejects.toBeInstanceOf(MatonPolicyError);
    await expect(matonRequest(deps(), { method: "GET", url: "https://gateway.maton.ai/google-search-console/webmasters/v3/sites", body: {} })).rejects.toBeInstanceOf(MatonPolicyError);
    expect(seen).toHaveLength(0);
  });

  it("sends the key only in the Authorization header, the picked Maton-Connection, never follows redirects, meters cost 0", async () => {
    const recorded: Json[] = [];
    const calls = { async record(c: Json) { recorded.push(c); } };
    await matonRequest(deps({ calls }), { method: "GET", url: "https://gateway.maton.ai/google-search-console/webmasters/v3/sites", connectionId: CONN_GSC });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers["maton-connection"]).toBe(CONN_GSC);
    expect(seen[0]!.url).not.toContain(KEY);
    expect(recorded[0]).toMatchObject({ provider: "maton", model: "google-search-console/gsc.sites.list", purpose: "test", status: "ok", costUsd: 0, costIsEstimate: false });
    await matonRequest(deps(), { method: "GET", url: "https://gateway.maton.ai/google-search-console/webmasters/v3/sites" });
    expect(seen[1]!.headers["maton-connection"]).toBeUndefined();

    handler = () => new Response(null, { status: 302, headers: { location: "https://gateway.maton.ai/google-mail/gmail/v1/users/me/messages" } });
    await expect(matonRequest(deps(), { method: "GET", url: "https://gateway.maton.ai/google-search-console/webmasters/v3/sites" })).rejects.toMatchObject({ code: "bad_response" });
    expect(seen).toHaveLength(3);
  });

  it("scrubs the key from upstream error text and stored call errors; maps 401/429/400/oversize/timeout", async () => {
    const recorded: Json[] = [];
    const calls = { async record(c: Json) { recorded.push(c); } };
    handler = () => Response.json({ error: { message: `bad request for key ${KEY} Bearer ${KEY}` } }, { status: 403 });
    const e1 = (await matonRequest(deps({ calls }), { method: "GET", url: "https://gateway.maton.ai/google-search-console/webmasters/v3/sites" }).catch((e) => e)) as MatonApiError;
    expect(e1).toBeInstanceOf(MatonApiError);
    expect(e1.code).toBe("forbidden");
    expect(e1.message).not.toContain(KEY);
    expect(e1.upstreamMessage).not.toContain(KEY);
    expect(JSON.stringify(recorded)).not.toContain(KEY);

    handler = () => new Response("Unauthorized", { status: 401 });
    await expect(matonRequest(deps(), { method: "GET", url: "https://ctrl.maton.ai/connections" })).rejects.toMatchObject({ code: "unauthorized" });
    handler = () => new Response("{}", { status: 429 });
    await expect(matonRequest(deps(), { method: "GET", url: "https://ctrl.maton.ai/connections" })).rejects.toMatchObject({ code: "rate_limited" });
    handler = () => Response.json({ error: "Missing connection for google-sheets" }, { status: 400 });
    await expect(matonRequest(deps(), { method: "GET", url: `https://gateway.maton.ai/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}` })).rejects.toMatchObject({ code: "missing_connection" });
    handler = () => new Response("x".repeat(2 * 1024 * 1024), { status: 200 });
    await expect(matonRequest(deps(), { method: "GET", url: "https://ctrl.maton.ai/connections" })).rejects.toMatchObject({ code: "too_large" });
    handler = () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    };
    await expect(matonRequest(deps({ calls }), { method: "GET", url: "https://ctrl.maton.ai/connections" })).rejects.toMatchObject({ code: "timeout" });
    expect(recorded.at(-1)).toMatchObject({ status: "timeout" });
  });

  it("parses the documented connection list: listed apps only, never url or metadata", async () => {
    const list = parseConnections(connectionsResponse());
    expect(list.map((c) => c.app)).toEqual(["google-analytics-admin", "google-analytics-data", "google-search-console", "google-sheets", "google-sheets"]);
    expect(list.find((c) => c.connectionId === CONN_SHEETS_OLD)).toEqual({ app: "google-sheets", connectionId: CONN_SHEETS_OLD, status: "ACTIVE", createdAt: "2025-12-08T07:20:53.488460Z" });
    expect(JSON.stringify(list)).not.toMatch(/session_token|metadata|url/);
    expect(parseConnections({ connections: "x" })).toEqual([]);
    expect(parseConnections(null)).toEqual([]);
    const live = await listActiveConnections(deps());
    expect(live).toHaveLength(5);
    expect(new URL(seen[0]!.url).search).toBe("?status=ACTIVE");
  });
});

// ------------------------------------------------------------------ key routes
describe("Maton key routes", () => {
  it("stores the key encrypted, never echoes it, lists connections per app, and lets the owner pick one", async () => {
    const { env, u, db } = await setup();
    const empty = await call(env, u, "GET", `/workspaces/${u.workspaceId}/maton`);
    expect(empty.json!.data).toMatchObject({ configured: false, state: "setup_required", storageReady: true });
    await connectMaton(env, u);
    const row = await db.first<{ key_enc: string; key_hint: string }>("SELECT key_enc, key_hint FROM provider_credentials WHERE workspace_id = ? AND provider = 'maton'", u.workspaceId);
    expect(row!.key_enc).not.toContain(KEY);
    expect(row!.key_hint).toBe(KEY.slice(-4));
    expect(await decryptSecret(env, row!.key_enc, matonAad(u.workspaceId))).toBe(KEY);

    const st = (await call(env, u, "GET", `/workspaces/${u.workspaceId}/maton`)).json!.data as MatonStatus;
    expect(st).toMatchObject({ configured: true, keyHint: KEY.slice(-4), state: "ready", lastTestOk: true });
    const sheets = st.apps.find((a) => a.app === "google-sheets")!;
    expect(sheets.connections.map((c) => c.connectionId)).toEqual([CONN_SHEETS_OLD, CONN_SHEETS_NEW]);
    expect(sheets.selectedConnectionId).toBeNull();
    expect(st.apps.find((a) => a.app === "google-analytics-data")).toMatchObject({ usedByOkara: false });
    expect(st.warning).toMatch(/This key can reach every app you connected in Maton/);

    const test = (await call(env, u, "POST", `/workspaces/${u.workspaceId}/maton/test`, {})).json!.data as MatonTestResult;
    expect(test.apps.find((a) => a.app === "google-analytics-data")).toMatchObject({ used: false });
    expect(test.apps.some((a) => (a.app as string) === "google-mail")).toBe(false);

    const pick = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/maton/connections/google-sheets`, { connectionId: CONN_SHEETS_NEW });
    expect(pick.status).toBe(200);
    expect((pick.json!.data as MatonStatus).apps.find((a) => a.app === "google-sheets")!.selectedConnectionId).toBe(CONN_SHEETS_NEW);
    // A re-test keeps the pick while the connection is still listed.
    await call(env, u, "POST", `/workspaces/${u.workspaceId}/maton/test`, {});
    expect(((await call(env, u, "GET", `/workspaces/${u.workspaceId}/maton`)).json!.data as MatonStatus).apps.find((a) => a.app === "google-sheets")!.selectedConnectionId).toBe(CONN_SHEETS_NEW);
    expect((await call(env, u, "PUT", `/workspaces/${u.workspaceId}/maton/connections/google-sheets`, { connectionId: CONN_GSC })).status).toBe(400);
    expect((await call(env, u, "PUT", `/workspaces/${u.workspaceId}/maton/connections/google-mail`, { connectionId: null })).status).toBe(404);

    expect(bodies.join("\n")).not.toContain(KEY);
    expect(bodies.join("\n")).not.toContain("session_token");

    expect((await call(env, u, "DELETE", `/workspaces/${u.workspaceId}/maton`)).status).toBe(200);
    expect(await db.first("SELECT 1 FROM provider_credentials WHERE workspace_id = ? AND provider = 'maton'", u.workspaceId)).toBeNull();
    expect(await db.first("SELECT 1 FROM maton_connections WHERE workspace_id = ?", u.workspaceId)).toBeNull();
  });

  it("tests a typed key without saving it; reports a rejected key", async () => {
    const { env, u, db } = await setup();
    const r = await call(env, u, "POST", `/workspaces/${u.workspaceId}/maton/test`, { apiKey: KEY });
    expect(r.json!.data.ok).toBe(true);
    expect(await db.first("SELECT 1 FROM provider_credentials WHERE workspace_id = ?", u.workspaceId)).toBeNull();
    handler = () => new Response("no", { status: 401 });
    const bad = await call(env, u, "POST", `/workspaces/${u.workspaceId}/maton/test`, { apiKey: "wrong-key-123456" });
    expect(bad.json!.data).toMatchObject({ ok: false, detail: "Maton rejected the key (HTTP 401)." });
    expect((await call(env, u, "POST", `/workspaces/${u.workspaceId}/maton/test`, {})).status).toBe(412);
  });

  it("is owner-only to set, test, pick and remove; members can read status; other workspaces get 404", async () => {
    const { env, u } = await setup();
    await connectMaton(env, u);
    const m = await seedMember(env, u.workspaceId);
    expect((await call(env, m, "GET", `/workspaces/${u.workspaceId}/maton`)).status).toBe(200);
    expect((await call(env, m, "PUT", `/workspaces/${u.workspaceId}/maton`, { apiKey: "another-key-1234" })).status).toBe(403);
    expect((await call(env, m, "POST", `/workspaces/${u.workspaceId}/maton/test`, {})).status).toBe(403);
    expect((await call(env, m, "PUT", `/workspaces/${u.workspaceId}/maton/connections/google-sheets`, { connectionId: null })).status).toBe(403);
    expect((await call(env, m, "DELETE", `/workspaces/${u.workspaceId}/maton`)).status).toBe(403);
    const other = await seedUser(env);
    expect((await call(env, other, "GET", `/workspaces/${u.workspaceId}/maton`)).status).toBe(404);
    expect((await call(env, other, "DELETE", `/workspaces/${u.workspaceId}/maton`)).status).toBe(404);
    // The other workspace's own status shows nothing of the first one.
    expect((await call(env, other, "GET", `/workspaces/${other.workspaceId}/maton`)).json!.data).toMatchObject({ configured: false, apps: expect.any(Array) });
    expect(((await call(env, other, "GET", `/workspaces/${other.workspaceId}/maton`)).json!.data as MatonStatus).apps.every((a) => a.connections.length === 0)).toBe(true);
  });
});

// ------------------------------------------------------------------ Sheets through Maton
describe("Google Sheets import and sync through Maton", () => {
  it("imports through Maton with the native paths, sends the picked Maton-Connection, and records the transport", async () => {
    const { env, u, pid, db } = await setup();
    // Neither direct nor Maton: setup_required.
    expect((await call(env, u, "POST", `/projects/${pid}/import/sheets/tabs`, { spreadsheet: SPREADSHEET_ID })).status).toBe(412);
    await connectMaton(env, u);
    await call(env, u, "PUT", `/workspaces/${u.workspaceId}/maton/connections/google-sheets`, { connectionId: CONN_SHEETS_NEW });
    seen.length = 0;

    const ov = (await call(env, u, "GET", `/projects/${pid}/import`)).json!.data as ImportOverview;
    expect(ov.sheets).toMatchObject({ state: "ready", via: "maton", maton: { available: true } });
    expect(ov.sheets.maton!.label).toContain(CONN_SHEETS_NEW.slice(0, 8));

    const tabs = await call(env, u, "POST", `/projects/${pid}/import/sheets/tabs`, { spreadsheet: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit` });
    expect(tabs.status).toBe(200);
    expect(tabs.json!.data.tabs.map((t: Json) => t.title)).toEqual(["AI Questions"]);
    const meta = new URL(seen[0]!.url);
    expect(meta.host).toBe("gateway.maton.ai");
    expect(meta.pathname).toBe(`/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}`);
    expect(meta.searchParams.get("fields")).toContain("sheets.properties(");
    expect(seen[0]!.headers["maton-connection"]).toBe(CONN_SHEETS_NEW);

    const r = await call(env, u, "POST", `/projects/${pid}/import/commit`, {
      source: { kind: "sheets", spreadsheetId: SPREADSHEET_ID, tab: "AI Questions" },
      destination: "geo_prompts",
      mapping: { question: AI_QUESTIONS_HEADERS[0] },
      keepInSync: { frequencyHours: 24 },
    });
    expect(r.status).toBe(201);
    const valuesCall = seen.find((s) => s.url.includes("/values/"))!;
    expect(new URL(valuesCall.url).pathname).toBe(`/google-sheets/v4/spreadsheets/${SPREADSHEET_ID}/values/'AI%20Questions'!A1%3ACV5001`);
    expect(valuesCall.headers["maton-connection"]).toBe(CONN_SHEETS_NEW);
    expect((await db.first<{ transport: string }>("SELECT transport FROM imports WHERE project_id = ?", pid))!.transport).toBe("maton");
    const hist = (await call(env, u, "GET", `/projects/${pid}/import`)).json!.data as ImportOverview;
    expect(hist.history[0]!.transport).toBe("maton");
    const calls = await db.all<{ provider: string; cost_usd: number; purpose: string; project_id: string }>("SELECT provider, cost_usd, purpose, project_id FROM provider_calls WHERE workspace_id = ? AND purpose = 'import_sheets'", u.workspaceId);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.provider === "maton" && c.cost_usd === 0 && c.project_id === pid)).toBe(true);
  });

  it("cron sync reads through Maton and records last_transport", async () => {
    const { env, u, pid, db } = await setup();
    await connectMaton(env, u);
    const r = await call(env, u, "POST", `/projects/${pid}/import/commit`, {
      source: { kind: "sheets", spreadsheetId: SPREADSHEET_ID, tab: "AI Questions" },
      destination: "geo_prompts",
      mapping: { question: AI_QUESTIONS_HEADERS[0] },
      keepInSync: { frequencyHours: 6 },
    });
    expect(r.status).toBe(201);
    sheetRows = [...aiQuestionRows(), ["Which brass finish ages best outdoors?"]];
    seen.length = 0;
    const later = new Date(Date.now() + 7 * 3600 * 1000);
    const out = await processDueImportSyncs(env, later);
    expect(out).toEqual({ processed: 1, failed: 0 });
    expect(seen.some((s) => new URL(s.url).host === "gateway.maton.ai" && s.url.includes("/values/"))).toBe(true);
    // No pick and two connections: Maton's default (no header).
    expect(seen.every((s) => s.headers["maton-connection"] === undefined)).toBe(true);
    const sync = await db.first<{ last_transport: string; last_status: string }>("SELECT last_transport, last_status FROM import_syncs WHERE project_id = ?", pid);
    expect(sync).toMatchObject({ last_transport: "maton", last_status: "ok" });
    const ov = (await call(env, u, "GET", `/projects/${pid}/import`)).json!.data as ImportOverview;
    expect(ov.syncs[0]!.lastTransport).toBe("maton");
  });

  it("precedence: direct OAuth wins; Maton when direct is missing; neither -> null", async () => {
    const { env, u, pid, db } = await setup();
    expect(await resolveSheetsClient(env, db, { id: pid, workspaceId: u.workspaceId })).toBeNull();
    await connectMaton(env, u);
    expect((await resolveSheetsClient(env, db, { id: pid, workspaceId: u.workspaceId }))!.transport?.kind).toBe("maton");
    await db.insert("oauth_connections", {
      id: newId("oac"), workspace_id: u.workspaceId, project_id: pid, user_id: u.userId, provider: "google_sheets",
      scopes: "https://www.googleapis.com/auth/spreadsheets.readonly", refresh_token_enc: "envelope", status: "connected", last_error: null,
      created_at: FIXED_NOW.toISOString(), updated_at: FIXED_NOW.toISOString(),
    });
    const direct = await resolveSheetsClient(env, db, { id: pid, workspaceId: u.workspaceId });
    expect(direct!.transport).toBeUndefined();
    // Another workspace never sees this workspace's Maton key.
    const other = await seedUser(env);
    const opid = await seedProject(env, other.workspaceId);
    expect(await resolveSheetsClient(env, db, { id: opid, workspaceId: other.workspaceId })).toBeNull();
  });
});

// ------------------------------------------------------------------ Search Console through Maton
describe("Search Console through Maton", () => {
  it("lets the owner pick a property from Maton's sites list, then gsc_sync reads through Maton", async () => {
    const { env, u, pid, db } = await setup();
    const ref = { id: pid, workspaceId: u.workspaceId };
    expect(await resolveGscProvider(env, db, ref, fetchNever)).toBeNull();
    const none = await syncGsc(makeTestContext(env, ref, { gsc: null }));
    expect(none.status).toBe("setup_required");

    await connectMaton(env, u);
    const st = (await call(env, u, "GET", `/projects/${pid}/gsc/maton`)).json!.data as GscMatonStatus;
    expect(st).toMatchObject({ effective: null, source: "direct", directConnected: false, matonAvailable: true });
    // Maton is opt-in per project: not used until the owner picks it.
    expect(await resolveGscProvider(env, db, ref, fetchNever)).toBeNull();

    const sites = await call(env, u, "GET", `/projects/${pid}/gsc/maton/sites`);
    expect(sites.json!.data).toEqual([{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }, { siteUrl: "https://other.example/", permissionLevel: "siteRestrictedUser" }]);
    expect((await call(env, u, "PUT", `/projects/${pid}/gsc/source`, { source: "maton", property: "https://not-listed.example/" })).status).toBe(400);
    const put = await call(env, u, "PUT", `/projects/${pid}/gsc/source`, { source: "maton", property: "sc-domain:example.com" });
    expect(put.status).toBe(200);
    expect(put.json!.data.status).toMatchObject({ effective: "maton", source: "maton", property: "sc-domain:example.com" });
    expect(put.json!.data.verification.check.ok).toBe(true);
    const integ = (await call(env, u, "GET", `/projects/${pid}/integrations`)).json!.data as IntegrationsStatus;
    expect(integ.gsc).toMatchObject({ state: "ready", via: "maton", property: "sc-domain:example.com" });

    const gsc = await resolveGscProvider(env, db, ref, fetchNever);
    expect(gsc!.transport).toMatchObject({ kind: "maton" });
    seen.length = 0;
    const ctx = makeTestContext(env, ref, { gsc });
    const res = await syncGsc(ctx, { pageSize: 100 });
    expect(["completed", "partial", "no_data"]).toContain(res.status);
    const q = seen.filter((s) => s.url.endsWith("/searchAnalytics/query"));
    expect(q.length).toBeGreaterThan(0);
    expect(new URL(q[0]!.url).pathname).toBe("/google-search-console/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
    expect(q[0]!.method).toBe("POST");
    expect(q[0]!.body).toMatchObject({ dataState: "final", type: "web" });
    expect(ctx.events.some((e) => e.step === "gsc_sync" && /via Maton/.test(e.message))).toBe(true);
  });

  it("direct OAuth wins over a Maton source; members cannot change the source", async () => {
    const { env, u, pid, db } = await setup();
    await connectMaton(env, u);
    await call(env, u, "PUT", `/projects/${pid}/gsc/source`, { source: "maton", property: "sc-domain:example.com" });
    const m = await seedMember(env, u.workspaceId);
    expect((await call(env, m, "PUT", `/projects/${pid}/gsc/source`, { source: "direct" })).status).toBe(403);
    expect((await call(env, m, "GET", `/projects/${pid}/gsc/maton/sites`)).status).toBe(403);
    expect((await call(env, m, "GET", `/projects/${pid}/gsc/maton`)).status).toBe(200);
    await db.insert("oauth_connections", {
      id: newId("oac"), workspace_id: u.workspaceId, project_id: pid, user_id: u.userId, provider: "google_gsc",
      scopes: "https://www.googleapis.com/auth/webmasters.readonly", refresh_token_enc: "envelope", status: "connected", last_error: null,
      created_at: FIXED_NOW.toISOString(), updated_at: FIXED_NOW.toISOString(),
    });
    const gsc = await resolveGscProvider(env, db, { id: pid, workspaceId: u.workspaceId }, fetchNever);
    expect(gsc).not.toBeNull();
    expect(gsc!.transport).toBeUndefined();
    expect(((await call(env, u, "GET", `/projects/${pid}/gsc/maton`)).json!.data as GscMatonStatus).effective).toBe("direct");
    // Switching back to direct clears the Maton choice.
    await call(env, u, "PUT", `/projects/${pid}/gsc/source`, { source: "direct" });
    expect(((await call(env, u, "GET", `/projects/${pid}/gsc/maton`)).json!.data as GscMatonStatus).source).toBe("direct");
  });
});

const fetchNever: typeof fetch = async () => {
  throw new Error("direct GSC fetch must not be called in this test");
};

// ------------------------------------------------------------------ tenant-scoped helpers (Ask Okara)
describe("Maton helpers for Ask Okara", () => {
  async function scope(): Promise<{ s: MatonScope; db: Db; wid: string; env: Env }> {
    const { env, u, pid, db } = await setup();
    await connectMaton(env, u);
    seen.length = 0;
    return { s: { env, db, workspaceId: u.workspaceId, projectId: pid, purpose: "chat_maton", clock: () => FIXED_NOW }, db, wid: u.workspaceId, env };
  }

  it("matonStatus has apps and picks but never the key", async () => {
    const { env, db, wid } = await scope();
    const st = await matonStatus(env, db, wid);
    expect(st.apps.map((a) => a.app)).toEqual(["google-sheets", "google-search-console", "google-analytics-data", "google-analytics-admin"]);
    expect(JSON.stringify(st)).not.toContain(KEY);
    expect(seen).toHaveLength(0);
  });

  it("reads sheet tabs and values with caps and a source label", async () => {
    const { s, db } = await scope();
    const tabs = await readSheetTabs(s, SPREADSHEET_ID);
    expect(tabs.data.tabs).toHaveLength(1);
    expect(tabs.source).toBe(`Maton (${tabs.connectionLabel}), fetched ${FIXED_NOW.toISOString()}`);
    sheetRows = [["a", "x".repeat(900)], ...Array.from({ length: 30 }, (_, i) => [`r${i}`])];
    const vals = await readSheetValues(s, SPREADSHEET_ID, "'AI Questions'!A1:B40", 10);
    expect(vals.data.rows).toHaveLength(10);
    expect(vals.data.rows[0]![1]).toHaveLength(500);
    expect(vals.truncated).toBe(true);
    const n = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM provider_calls WHERE purpose = 'chat_maton' AND provider = 'maton' AND cost_usd = 0");
    expect(n!.n).toBe(2);
  });

  it("queries Search Console and GA4 (runReport, accountSummaries) read-only", async () => {
    const { s } = await scope();
    const sites = await gscSites(s);
    expect(sites.data[0]).toEqual({ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" });
    const q = await gscQuery(s, { siteUrl: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-28", rowLimit: 999_999 });
    expect(q.data.rows[0]).toEqual({ keys: [], clicks: 120, impressions: 4000, ctr: 0.03, position: 8.2 });
    expect((seen.at(-1)!.body as Json).rowLimit).toBe(25_000);
    await expect(gscQuery(s, { siteUrl: "sc-domain:example.com", startDate: "last week", endDate: "2026-09-28" })).rejects.toBeInstanceOf(MatonPolicyError);

    const props = await gaListProperties(s);
    expect(props.data).toEqual([{ property: "properties/521310447", propertyId: "521310447", displayName: "shop.example.com", account: "accounts/1", accountName: "Shop" }]);
    expect(seen.at(-1)!.headers["maton-connection"]).toBeUndefined();
    const rep = await gaRunReport(s, "properties/521310447", {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "landingPage" }, { name: "sessionSource" }],
      metrics: [{ name: "sessions" }, { name: "totalRevenue" }],
      limit: 50_000,
      // unknown fields are dropped
      ...({ returnPropertyQuota: true, evil: "x" } as object),
    } as Json);
    const sent = seen.at(-1)!;
    expect(new URL(sent.url).pathname).toBe("/google-analytics-data/v1beta/properties/521310447:runReport");
    expect(sent.method).toBe("POST");
    expect(sent.body).toEqual({
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      metrics: [{ name: "sessions" }, { name: "totalRevenue" }],
      dimensions: [{ name: "landingPage" }, { name: "sessionSource" }],
      limit: 10_000,
    });
    expect(rep.data).toMatchObject({ dimensionHeaders: ["landingPage", "sessionSource"], rowCount: 2, currencyCode: "USD" });
    expect(rep.data.rows[0]).toEqual({ dimensions: ["/products/brass-pull", "chatgpt.com"], metrics: ["42", "310.5"] });
    expect(rep.source).toMatch(/^Maton \(connection 33333333/);
    await expect(gaRunReport(s, "UA-123", { dateRanges: [{ startDate: "7daysAgo", endDate: "today" }], metrics: [{ name: "sessions" }] })).rejects.toBeInstanceOf(MatonPolicyError);
  });

  it("reports setup_required without a key or connection, and stays inside the workspace", async () => {
    const { env, u, pid, db } = await setup();
    const s: MatonScope = { env, db, workspaceId: u.workspaceId, projectId: pid, purpose: "chat_maton" };
    await expect(readSheetTabs(s, SPREADSHEET_ID)).rejects.toBeInstanceOf(MatonSetupRequiredError);
    await connectMaton(env, u);
    const other = await seedUser(env);
    await expect(gaRunReport({ ...s, workspaceId: other.workspaceId }, "1", { dateRanges: [{ startDate: "7daysAgo", endDate: "today" }], metrics: [{ name: "sessions" }] })).rejects.toBeInstanceOf(MatonSetupRequiredError);
    handler = () => Response.json({ connections: [] });
    await call(env, u, "POST", `/workspaces/${u.workspaceId}/maton/test`, {});
    await expect(gscSites(s)).rejects.toMatchObject({ code: "setup_required", app: "google-search-console" });
  });
});
