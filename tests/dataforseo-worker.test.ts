/**
 * DataForSEO competitor data: client (Basic auth header, request bodies, parsing of the documented example
 * responses, error/timeout outcomes), credential routes (encrypted storage, no echo, owner-only writes, free
 * user_data test with balance), competitor refreshes (auto on competitor add, manual refresh, cost recorded
 * from the response as actual, budget reservation/settle, operator-key global caps, daily caps, retention,
 * location mapping/setup_required, tenancy, D1 parameter limits on the shim) and the cron queue.
 * Every network call goes to a fake fetch; nothing reaches DataForSEO.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { createSession } from "@worker/platform/session";
import { decryptSecret } from "@worker/lib/crypto";
import { dataForSeoAad } from "@worker/platform/dataforseo-credentials";
import {
  DATAFORSEO_LIMITS,
  basicAuthHeader,
  dataForSeoRequest,
  maxRefreshCostUsd,
  maxTaskCostUsd,
  parseDomainIntersection,
  parseLocationRows,
  parseRankedKeywords,
  parseRelevantPages,
  requestBody,
  targetDomain,
  testCredentials,
} from "@worker/providers/dataforseo";
import {
  KEEP_SNAPSHOTS_PER_DOMAIN,
  addedCompetitorDomains,
  competitorDomains,
  enqueueFetch,
  matchLocation,
  processQueuedCompetitorFetches,
  regionOf,
  setCompetitorDataFetch,
} from "@worker/competitors/dataforseo";
import type { ProjectRow } from "@worker/platform/access";
import type { CompetitorDataPanel, CompetitorDomainDetail, DataForSeoCredentialStatus } from "@shared/competitor-data";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import * as F from "./fixtures/dataforseo";

const app = createApp();
const LOGIN = "owner@agency.example";
const PASSWORD = "p4ssw0rdSECRETvalue";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
const seen: Seen[] = [];
type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let handler: Handler;

/** Routes each documented path to its fixture; competitor target echoed into the fixture. */
function defaultHandler(over: Partial<Record<string, () => Response | Promise<Response>>> = {}): Handler {
  return (url, init) => {
    const path = new URL(url).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Array<Record<string, unknown>>)[0] : undefined;
    if (over[path]) return over[path]!();
    switch (path) {
      case "/v3/appendix/user_data":
        return Response.json(F.userData());
      case "/v3/dataforseo_labs/locations_and_languages":
        return Response.json(F.locations());
      case "/v3/dataforseo_labs/google/ranked_keywords/live":
        return Response.json(F.rankedKeywords(String(body?.target)));
      case "/v3/dataforseo_labs/google/domain_intersection/live":
        return Response.json(F.domainIntersection(String(body?.target1), String(body?.target2)));
      case "/v3/dataforseo_labs/google/relevant_pages/live":
        return Response.json(F.relevantPages(String(body?.target)));
      default:
        return new Response("not found", { status: 404 });
    }
  };
}

function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return handler(url, init);
  }) as typeof fetch;
}

beforeEach(() => {
  seen.length = 0;
  handler = defaultHandler();
  setCompetitorDataFetch(fakeFetch());
});
afterEach(() => setCompetitorDataFetch(null));

const bodies: string[] = [];
type U = { sessionToken: string; csrfToken: string };
async function call(env: Env, u: U, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await app.request(
    `/api${path}`,
    { method, headers: { ...authHeaders(u.sessionToken, u.csrfToken), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  const text = await res.text();
  bodies.push(text);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: text ? (JSON.parse(text) as { data?: any; error?: { code: string; message: string } }) : null };
}

async function seedMember(env: Env, workspaceId: string) {
  const db = new Db(env.DB);
  const userId = newId("usr");
  await db.insert("users", { id: userId, google_sub: `sub-${userId}`, email: `${userId}@example.com`, name: "Member", created_at: new Date().toISOString() });
  await db.insert("memberships", { workspace_id: workspaceId, user_id: userId, role: "member", created_at: new Date().toISOString() });
  const s = await createSession(db, userId, new Date());
  return { userId, sessionToken: s.token, csrfToken: s.csrfToken };
}

async function setup(envOver: Partial<Env> = {}, projectOver: Record<string, unknown> = {}) {
  const env = createTestEnv(envOver);
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId, projectOver);
  return { env, u, pid, db: u.db };
}

async function saveCreds(env: Env, u: U & { workspaceId: string }) {
  const r = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/dataforseo`, { login: LOGIN, password: PASSWORD });
  expect(r.status).toBe(200);
}

const posts = () => seen.filter((s) => s.method === "POST");
const pathOf = (s: Seen) => new URL(s.url).pathname;

// ------------------------------------------------------------------ client
describe("DataForSEO client", () => {
  it("builds the documented Basic auth header", () => {
    // https://docs.dataforseo.com/v3/auth/: "login:password" -> bG9naW46cGFzc3dvcmQ=
    expect(basicAuthHeader({ login: "login", password: "password" })).toBe("Basic bG9naW46cGFzc3dvcmQ=");
  });

  it("builds one-task request bodies with organic results, item limits and no clickstream", () => {
    const loc = { locationCode: 2840, languageCode: "en" };
    expect(requestBody("ranked_keywords", "www.Rival.example", "shop.example.com", loc)).toEqual([
      { target: "rival.example", location_code: 2840, language_code: "en", item_types: ["organic"], limit: 100, order_by: ["keyword_data.keyword_info.search_volume,desc"] },
    ]);
    expect(requestBody("domain_intersection", "rival.example", "www.shop.example.com", loc)).toEqual([
      { target1: "rival.example", target2: "shop.example.com", location_code: 2840, language_code: "en", intersections: false, item_types: ["organic"], limit: 100 },
    ]);
    expect(requestBody("relevant_pages", "rival.example", "x", loc)).toEqual([
      { target: "rival.example", location_code: 2840, language_code: "en", item_types: ["organic"], limit: 20, order_by: ["metrics.organic.etv,desc"] },
    ]);
    for (const b of [requestBody("ranked_keywords", "a.example", "b.example", loc), requestBody("domain_intersection", "a.example", "b.example", loc)]) {
      expect(JSON.stringify(b)).not.toContain("clickstream");
    }
  });

  it("sizes reservations from the published price (per task + per item ceiling)", () => {
    expect(maxTaskCostUsd("ranked_keywords")).toBeCloseTo(0.012 + 100 * 0.00012, 9);
    expect(maxTaskCostUsd("relevant_pages")).toBeCloseTo(0.012 + 20 * 0.00012, 9);
    expect(maxRefreshCostUsd()).toBeCloseTo(0.0624, 9);
  });

  it("parses the documented ranked_keywords example (overview + keywords)", () => {
    const r = parseRankedKeywords(F.rankedKeywords().tasks[0]!.result[0] as Record<string, unknown>);
    expect(r.overview).toMatchObject({ organicKeywords: 3689, organicEtv: 16248.60499012284, estimatedPaidTrafficCost: 105396.22162114584, isNew: 1110, isLost: 0, totalCount: 3696 });
    expect(r.overview.buckets).toMatchObject({ pos_1: 26, pos_2_3: 49, pos_4_10: 569, pos_91_100: 190 });
    expect(r.keywords[0]).toEqual({ keyword: "1000 keywords", position: 1, searchVolume: 140, url: "https://dataforseo.com/free-seo-stats/top-1000-keywords", etv: 42.560001373291016 });
    // Untrusted text is kept as data (rendered as plain text), never interpreted.
    expect(r.keywords[1]!.keyword).toBe("<script>alert(1)</script> api");
    expect(parseRankedKeywords(null).keywords).toEqual([]);
  });

  it("parses the documented domain_intersection example as the keyword gap", () => {
    const r = parseDomainIntersection(F.domainIntersection().tasks[0]!.result[0] as Record<string, unknown>);
    expect(r.totalCount).toBe(481348);
    expect(r.rows).toEqual([
      { keyword: "cool math games with math", searchVolume: 5000000, competitorPosition: 64, competitorUrl: "https://mom.com/kids/cool-math-games-for-kids", etv: 10500, keywordDifficulty: 65, cpc: 2.2300000190734863 },
    ]);
  });

  it("parses relevant_pages and the locations list (Google languages only)", () => {
    const pages = parseRelevantPages(F.relevantPages("rival.example").tasks[0]!.result[0] as Record<string, unknown>);
    expect(pages.rows[0]).toEqual({ url: "https://rival.example/", etv: 900.5, keywords: 400, top3: 15 });
    const locs = parseLocationRows(F.locations().tasks[0]!.result);
    expect(locs.map((l) => l.locationCode)).toEqual([2854, 2840]); // Uruguay has only a bing language here
    expect(locs.find((l) => l.locationCode === 2840)!.languages).toEqual([
      { languageCode: "en", languageName: "English" },
      { languageCode: "es", languageName: "Spanish" },
    ]);
  });

  it("maps project locales through the documented codes", () => {
    const locs = parseLocationRows(F.locations().tasks[0]!.result);
    expect(regionOf("en-US")).toBe("US");
    expect(regionOf("en")).toBeNull();
    expect(regionOf("zh-Hant-TW")).toBe("TW");
    expect(matchLocation(locs, "en-US", "en")).toEqual({ locationCode: 2840, locationName: "United States", languageCode: "en", languageName: "English" });
    expect(matchLocation(locs, "es-US", "es-419")).toMatchObject({ locationCode: 2840, languageCode: "es" });
    expect(matchLocation(locs, "de-DE", "de")).toBeNull();
    expect(matchLocation(locs, "en", "en")).toBeNull();
  });

  it("reports envelope/task errors, HTTP 401, timeouts and blocked hosts without throwing", async () => {
    const creds = { login: "a", password: "b" };
    const opts = { timeoutMs: 1000, maxBytes: 1_000_000 };
    const one = (r: Response | Error) => (async () => {
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch;
    const env = await dataForSeoRequest(one(Response.json(F.envelopeError(40100, "You are not authorized to access this resource."))), creds, "GET", "/v3/x", undefined, opts);
    expect(env).toMatchObject({ kind: "api_error", statusCode: 40100 });
    const task = await dataForSeoRequest(one(Response.json(F.taskError(["v3"], 40501, "Invalid Field: 'target'."))), creds, "POST", "/v3/x", [{}], opts);
    expect(task).toMatchObject({ kind: "api_error", statusCode: 40501, costUsd: 0 });
    const http = await dataForSeoRequest(one(new Response("Unauthorized", { status: 401 })), creds, "GET", "/v3/x", undefined, opts);
    expect(http).toMatchObject({ kind: "api_error", httpStatus: 401 });
    const timeout = await dataForSeoRequest(one(Object.assign(new Error("t"), { name: "TimeoutError" })), creds, "GET", "/v3/x", undefined, opts);
    expect(timeout).toMatchObject({ kind: "unknown", timeout: true });
    const garbled = await dataForSeoRequest(one(new Response("{not json", { status: 200 })), creds, "GET", "/v3/x", undefined, opts);
    expect(garbled).toMatchObject({ kind: "unknown", timeout: false });
    const big = await dataForSeoRequest(one(new Response("x".repeat(2000), { status: 200 })), creds, "GET", "/v3/x", undefined, { timeoutMs: 1000, maxBytes: 100 });
    expect(big).toMatchObject({ kind: "unknown" });
  });

  it("tests credentials with the free user_data endpoint and reads money.balance", async () => {
    const f = fakeFetch();
    const ok = await testCredentials(f, { login: LOGIN, password: PASSWORD });
    expect(ok).toEqual({ ok: true, detail: "Credentials accepted. Balance $42.50 at test time.", balanceUsd: 42.5 });
    expect(seen[0]).toMatchObject({ url: "https://api.dataforseo.com/v3/appendix/user_data", method: "GET" });
    expect(seen[0]!.headers.authorization).toBe(`Basic ${btoa(`${LOGIN}:${PASSWORD}`)}`);
    expect(seen[0]!.url).not.toContain(PASSWORD);
    handler = () => Response.json(F.envelopeError(40100, "You are not authorized to access this resource."));
    expect((await testCredentials(f, { login: LOGIN, password: "wrong" })).ok).toBe(false);
    handler = () => Response.json(F.envelopeError(40202, "Rate-limit per minute has been exceeded."));
    expect((await testCredentials(f, { login: LOGIN, password: PASSWORD })).ok).toBeNull();
  });

  it("normalizes and diffs competitor domains", () => {
    expect(targetDomain("WWW.Rival.Example.")).toBe("rival.example");
    const before = [{ name: "A", domains: ["a.example"], aliases: [] }];
    const after = [...before, { name: "B", domains: ["www.b.example", "b2.example"], aliases: [] }, { name: "A2", domains: ["a.example"], aliases: [] }];
    expect(addedCompetitorDomains(before, after)).toEqual([
      { competitorName: "B", domain: "b.example" },
      { competitorName: "B", domain: "b2.example" },
    ]);
    expect(competitorDomains(after)).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ credentials
describe("DataForSEO credential routes", () => {
  it("is setup_required without credentials; operator credentials count as operator_key", async () => {
    const { env, u } = await setup();
    const r = await call(env, u, "GET", `/workspaces/${u.workspaceId}/dataforseo`);
    expect(r.status).toBe(200);
    expect(r.json!.data).toMatchObject({ source: "none", state: "setup_required", storageReady: true });
    const env2 = createTestEnv({ DATAFORSEO_LOGIN: "op@example.com", DATAFORSEO_PASSWORD: "operatorpw" });
    const u2 = await seedUser(env2);
    const r2 = await call(env2, u2, "GET", `/workspaces/${u2.workspaceId}/dataforseo`);
    expect(r2.json!.data).toMatchObject({ source: "operator_key", state: "ready", keyHint: null });
    // The operator account's balance is never tested/shown for a tenant.
    const t = await call(env2, u2, "POST", `/workspaces/${u2.workspaceId}/dataforseo/test`, {});
    expect(t.status).toBe(412);
    expect(seen).toHaveLength(0);
  });

  it("stores login+password encrypted, never echoes them, tests the saved credentials and shows the balance", async () => {
    const { env, u, db } = await setup();
    const put = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/dataforseo`, { login: LOGIN, password: PASSWORD });
    expect(put.status).toBe(200);
    const status = put.json!.data as DataForSeoCredentialStatus;
    expect(status).toMatchObject({ source: "workspace_key", keyHint: "alue", state: "ready" });
    const row = await db.first<{ key_enc: string; key_hint: string }>("SELECT key_enc, key_hint FROM provider_credentials WHERE workspace_id = ? AND provider = 'dataforseo'", u.workspaceId);
    expect(row!.key_enc).not.toContain(PASSWORD);
    expect(row!.key_enc).not.toContain(LOGIN);
    expect(await decryptSecret(env, row!.key_enc, dataForSeoAad(u.workspaceId))).toBe(`${LOGIN}:${PASSWORD}`);

    const t = await call(env, u, "POST", `/workspaces/${u.workspaceId}/dataforseo/test`, {});
    expect(t.json!.data).toEqual({ ok: true, detail: "Credentials accepted. Balance $42.50 at test time.", balanceUsd: 42.5 });
    expect(seen[0]!.headers.authorization).toBe(basicAuthHeader({ login: LOGIN, password: PASSWORD }));
    const after = await call(env, u, "GET", `/workspaces/${u.workspaceId}/dataforseo`);
    expect(after.json!.data).toMatchObject({ lastTestOk: true, lastBalanceUsd: 42.5 });
    // Typed credentials are tested without being saved.
    const typed = await call(env, u, "POST", `/workspaces/${u.workspaceId}/dataforseo/test`, { login: "other@x.example", password: "typedpassword" });
    expect(typed.json!.data.ok).toBe(true);
    expect(seen[1]!.headers.authorization).toBe(basicAuthHeader({ login: "other@x.example", password: "typedpassword" }));
    for (const b of bodies) {
      expect(b).not.toContain(PASSWORD);
      expect(b).not.toContain(LOGIN);
    }

    const del = await call(env, u, "DELETE", `/workspaces/${u.workspaceId}/dataforseo`);
    expect(del.status).toBe(200);
    expect((await call(env, u, "GET", `/workspaces/${u.workspaceId}/dataforseo`)).json!.data.source).toBe("none");
  });

  it("validates input, requires the owner for writes, CSRF for state changes, and hides other workspaces", async () => {
    const { env, u } = await setup();
    const bad = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/dataforseo`, { login: "a:b", password: PASSWORD });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).not.toContain(PASSWORD);
    const missing = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/dataforseo`, { login: LOGIN });
    expect(missing.status).toBe(400);
    const member = await seedMember(env, u.workspaceId);
    expect((await call(env, member, "PUT", `/workspaces/${u.workspaceId}/dataforseo`, { login: LOGIN, password: PASSWORD })).status).toBe(403);
    expect((await call(env, member, "GET", `/workspaces/${u.workspaceId}/dataforseo`)).status).toBe(200);
    const noCsrf = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/dataforseo`, { login: LOGIN, password: PASSWORD }, { "X-CSRF-Token": "wrong" });
    expect(noCsrf.status).toBe(403);
    const other = await seedUser(env);
    expect((await call(env, other, "GET", `/workspaces/${u.workspaceId}/dataforseo`)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ competitor data
async function addCompetitor(env: Env, u: U, pid: string, name: string, domains: string[]) {
  const proj = await call(env, u, "GET", `/projects/${pid}`);
  const competitors = [...proj.json!.data.competitors, { name, domains, aliases: [] }];
  return call(env, u, "PATCH", `/projects/${pid}`, { competitors });
}

describe("competitor data refresh", () => {
  it("is setup_required without credentials and never calls DataForSEO", async () => {
    const { env, u, pid } = await setup();
    const panel = await call(env, u, "GET", `/projects/${pid}/competitors/dataforseo`);
    expect(panel.status).toBe(200);
    expect(panel.json!.data).toMatchObject({ state: "setup_required", credentialSource: "none", canManage: true });
    expect(panel.json!.data.domains).toEqual([expect.objectContaining({ domain: "brassco.example", latestFetch: null, snapshot: null })]);
    const refresh = await call(env, u, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "brassco.example" });
    expect(refresh.status).toBe(412);
    expect(refresh.json!.error!.code).toBe("setup_required");
    const added = await addCompetitor(env, u, pid, "Rival", ["rival.example"]);
    expect(added.status).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it("pulls data when a competitor is added: auth header, bodies, actual cost in provider_calls, budget settled", async () => {
    const { env, u, pid, db } = await setup();
    await saveCreds(env, u);
    const r = await addCompetitor(env, u, pid, "Rival", ["https://www.rival.example/path"]);
    expect(r.status).toBe(200);

    expect(seen.map((s) => `${s.method} ${pathOf(s)}`).sort()).toEqual([
      "GET /v3/dataforseo_labs/locations_and_languages",
      "POST /v3/dataforseo_labs/google/domain_intersection/live",
      "POST /v3/dataforseo_labs/google/ranked_keywords/live",
      "POST /v3/dataforseo_labs/google/relevant_pages/live",
    ]);
    for (const s of seen) {
      expect(s.headers.authorization).toBe(basicAuthHeader({ login: LOGIN, password: PASSWORD }));
      expect(s.url.startsWith("https://api.dataforseo.com/v3/")).toBe(true);
    }
    const byPath = Object.fromEntries(posts().map((s) => [pathOf(s).split("/")[4], s.body as unknown[]]));
    expect(byPath.ranked_keywords).toEqual(requestBody("ranked_keywords", "rival.example", "shop.example.com", { locationCode: 2840, languageCode: "en" }));
    expect(byPath.domain_intersection).toEqual([expect.objectContaining({ target1: "rival.example", target2: "shop.example.com", intersections: false, location_code: 2840, language_code: "en" })]);
    expect(byPath.relevant_pages).toEqual([expect.objectContaining({ target: "rival.example", limit: DATAFORSEO_LIMITS.topPages })]);

    const calls = await db.all<{ provider: string; model: string; status: string; cost_usd: number | null; cost_is_estimate: number; request_id: string | null; project_id: string; rate_version: string }>(
      "SELECT provider, model, status, cost_usd, cost_is_estimate, request_id, project_id, rate_version FROM provider_calls WHERE workspace_id = ? ORDER BY model",
      u.workspaceId,
    );
    expect(calls.map((c) => [c.model, c.status, c.cost_usd, c.cost_is_estimate])).toEqual([
      ["labs/google/domain_intersection", "ok", 0.01212, 0],
      ["labs/google/ranked_keywords", "ok", 0.0122, 0],
      ["labs/google/relevant_pages", "ok", 0.01224, 0],
      ["labs/locations_and_languages", "ok", 0, 0],
    ]);
    expect(new Set(calls.map((c) => c.provider))).toEqual(new Set(["dataforseo"]));
    expect(calls.every((c) => c.project_id === pid && c.request_id === "06201739-8284-0381-0000-dd310797563a")).toBe(true);

    const counters = await db.all<{ scope_key: string; resource: string; used: number }>("SELECT scope_key, resource, used FROM usage_counters ORDER BY scope_key, resource");
    expect(counters).toEqual([
      { scope_key: `project:${pid}`, resource: "provider_calls", used: 3 },
      { scope_key: `project:${pid}`, resource: "usd_micros", used: 12200 + 12120 + 12240 },
    ]);
    const resv = await db.all<{ status: string }>("SELECT DISTINCT status FROM usage_reservations WHERE project_id = ?", pid);
    expect(resv).toEqual([{ status: "settled" }]);

    const panel = (await call(env, u, "GET", `/projects/${pid}/competitors/dataforseo`)).json!.data as CompetitorDataPanel;
    expect(panel.state).toBe("ready");
    expect(panel.location).toEqual({ locationCode: 2840, locationName: "United States", languageCode: "en", languageName: "English" });
    expect(panel.locationSource).toBe("auto");
    const rival = panel.domains.find((d) => d.domain === "rival.example")!;
    expect(rival.latestFetch).toMatchObject({ status: "completed", trigger: "competitor_added", costUsd: 0.03656 });
    expect(rival.snapshot!.overview).toMatchObject({ organicKeywords: 3689, organicEtv: 16248.60499012284 });
    expect(rival.snapshot!.endpoints.map((e) => e.endpoint)).toEqual(["ranked_keywords", "domain_intersection", "relevant_pages"]);
    expect(panel.pricing.maxRefreshUsd).toBeCloseTo(0.0624, 9);
    // The pre-existing competitor was not re-fetched.
    expect(panel.domains.find((d) => d.domain === "brassco.example")!.latestFetch).toBeNull();

    const detail = (await call(env, u, "GET", `/projects/${pid}/competitors/dataforseo/domains/rival.example`)).json!.data as CompetitorDomainDetail;
    expect(detail.topKeywords).toHaveLength(2);
    expect(detail.keywordGap[0]).toMatchObject({ keyword: "cool math games with math", competitorPosition: 64, competitorUrl: "https://rival.example/kids/cool-math-games-for-kids" });
    expect(detail.topPages[0]).toMatchObject({ url: "https://rival.example/", etv: 900.5 });
    expect(detail.ownDomain).toBe("shop.example.com");
    const raw = await db.first<{ data_json: string }>("SELECT data_json FROM competitor_snapshots WHERE endpoint = 'ranked_keywords'");
    // Only normalized fields are stored, not the raw response (no snippets, no SERP descriptions).
    expect(raw!.data_json).not.toContain("Ignore previous instructions");
  });

  it("applies the global operator caps when running on the operator's credentials", async () => {
    const { env, u, pid, db } = await setup({ DATAFORSEO_LOGIN: "op@example.com", DATAFORSEO_PASSWORD: "operatorpw" });
    const r = await call(env, u, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "brassco.example" });
    expect(r.status).toBe(202);
    expect(r.json!.data.fetch.status).toBe("completed");
    expect(posts()[0]!.headers.authorization).toBe(basicAuthHeader({ login: "op@example.com", password: "operatorpw" }));
    const global = await db.all<{ resource: string; used: number }>("SELECT resource, used FROM usage_counters WHERE scope_key = 'global' ORDER BY resource");
    expect(global).toEqual([
      { resource: "provider_calls", used: 3 },
      { resource: "usd_micros", used: 36560 },
    ]);
    // Global cap reached: nothing is called.
    const env2 = createTestEnv({ DATAFORSEO_LOGIN: "op@example.com", DATAFORSEO_PASSWORD: "operatorpw", GLOBAL_USD_MICROS_PER_DAY: "1000" });
    const u2 = await seedUser(env2);
    const pid2 = await seedProject(env2, u2.workspaceId);
    seen.length = 0;
    const r2 = await call(env2, u2, "POST", `/projects/${pid2}/competitors/dataforseo/refresh`, { domain: "brassco.example" });
    expect(r2.json!.data.fetch).toMatchObject({ status: "failed" });
    expect(r2.json!.data.fetch.error).toMatch(/global daily allowance/);
    expect(posts()).toHaveLength(0);
    const leftover = await new Db(env2.DB).all("SELECT id FROM usage_reservations WHERE status = 'reserved'");
    expect(leftover).toHaveLength(0);
  });

  it("refuses a refresh that would exceed the project's daily budget, reserving all-or-nothing", async () => {
    const { env, u, pid, db } = await setup();
    await saveCreds(env, u);
    await db.run("UPDATE project_limits SET usd_micros_per_day = 30000 WHERE project_id = ?", pid);
    const r = await call(env, u, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "brassco.example" });
    expect(r.json!.data.fetch.status).toBe("failed");
    expect(r.json!.data.fetch.error).toMatch(/project's daily limit/);
    expect(posts()).toHaveLength(0);
    const used = await db.all<{ resource: string; used: number }>("SELECT resource, used FROM usage_counters WHERE scope_key = ? ORDER BY resource", `project:${pid}`);
    expect(used.every((x) => x.used === 0)).toBe(true);
  });

  it("enforces the per-domain daily cap and returns an active refresh instead of a duplicate", async () => {
    const { env, u, pid, db } = await setup();
    await saveCreds(env, u);
    const path = `/projects/${pid}/competitors/dataforseo/refresh`;
    expect((await call(env, u, "POST", path, { domain: "brassco.example" })).status).toBe(202);
    expect((await call(env, u, "POST", path, { domain: "brassco.example" })).status).toBe(202);
    const third = await call(env, u, "POST", path, { domain: "brassco.example" });
    expect(third.status).toBe(429);
    expect(third.json!.error!.code).toBe("quota_exceeded");

    const { u: u2, env: env2, pid: pid2, db: db2 } = await setup();
    await saveCreds(env2, u2);
    const row = (await db2.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", pid2))!;
    const q = await enqueueFetch(db2, row, "brassco.example", "manual", u2.userId, new Date());
    expect(q.kind).toBe("queued");
    const dup = await call(env2, u2, "POST", `/projects/${pid2}/competitors/dataforseo/refresh`, { domain: "brassco.example" });
    expect(dup.status).toBe(200);
    expect(dup.json!.data).toMatchObject({ existing: true, fetch: { status: "queued" } });
    expect(db).toBeDefined();
  });

  it("records partial results, unknown costs on timeouts, and keeps the unknown reservation counted", async () => {
    const { env, u, pid, db } = await setup();
    await saveCreds(env, u);
    handler = defaultHandler({
      "/v3/dataforseo_labs/google/domain_intersection/live": () => Response.json(F.taskError(["v3"], 40501, "Invalid Field: 'target2'.")),
      "/v3/dataforseo_labs/google/relevant_pages/live": () => {
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      },
    });
    const r = await call(env, u, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "brassco.example" });
    expect(r.json!.data.fetch).toMatchObject({ status: "partial", costUsd: null });
    expect(r.json!.data.fetch.error).toMatch(/domain_intersection: DataForSEO 40501/);
    const calls = await db.all<{ model: string; status: string; cost_usd: number | null }>("SELECT model, status, cost_usd FROM provider_calls WHERE model LIKE 'labs/google/%' ORDER BY model");
    expect(calls).toEqual([
      { model: "labs/google/domain_intersection", status: "error", cost_usd: 0 },
      { model: "labs/google/ranked_keywords", status: "ok", cost_usd: 0.0122 },
      { model: "labs/google/relevant_pages", status: "timeout", cost_usd: null },
    ]);
    const unknown = await db.all<{ resource: string; amount: number }>("SELECT resource, amount FROM usage_reservations WHERE status = 'unknown'");
    expect(unknown).toEqual([{ resource: "usd_micros", amount: Math.round(maxTaskCostUsd("relevant_pages") * 1e6) }]);
    const detail = (await call(env, u, "GET", `/projects/${pid}/competitors/dataforseo/domains/brassco.example`)).json!.data as CompetitorDomainDetail;
    expect(detail.topKeywords.length).toBeGreaterThan(0);
    expect(detail.keywordGap).toEqual([]);
    expect(detail.snapshot!.endpoints.find((e) => e.endpoint === "domain_intersection")).toMatchObject({ status: "error" });
  });

  it("asks for a location when the locale cannot be mapped, then uses the owner's choice", async () => {
    const { env, u, pid, db } = await setup({}, { locale: "en", language: "en" });
    await saveCreds(env, u);
    const panel = await call(env, u, "GET", `/projects/${pid}/competitors/dataforseo`);
    expect(panel.json!.data).toMatchObject({ state: "setup_required", location: null });
    expect(panel.json!.data.message).toMatch(/Choose a location/);
    const r = await call(env, u, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "brassco.example" });
    expect(r.json!.data.fetch.status).toBe("setup_required");
    expect(posts()).toHaveLength(0);

    const options = await call(env, u, "GET", `/projects/${pid}/competitors/dataforseo/locations`);
    expect(options.json!.data.map((o: { locationCode: number }) => o.locationCode)).toEqual([2854, 2840]);
    const badChoice = await call(env, u, "PUT", `/projects/${pid}/competitors/dataforseo/settings`, { location: { locationCode: 2840, languageCode: "fr" } });
    expect(badChoice.status).toBe(400);
    const ok = await call(env, u, "PUT", `/projects/${pid}/competitors/dataforseo/settings`, { location: { locationCode: 2854, languageCode: "fr" } });
    expect(ok.json!.data).toMatchObject({ state: "ready", locationSource: "user", location: { locationCode: 2854, languageName: "French" } });
    seen.length = 0;
    const again = await call(env, u, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "brassco.example" });
    expect(again.json!.data.fetch.status).toBe("completed");
    expect(posts().every((s) => (s.body as Array<{ location_code: number; language_code: string }>)[0]!.location_code === 2854)).toBe(true);
    // setup_required attempts do not count toward the daily cap.
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM competitor_fetches WHERE status = 'setup_required'"))!.n).toBe(1);
  });

  it("respects auto-fetch off, demo projects, roles and tenancy", async () => {
    const { env, u, pid } = await setup();
    await saveCreds(env, u);
    expect((await call(env, u, "PUT", `/projects/${pid}/competitors/dataforseo/settings`, { autoFetch: false })).json!.data.autoFetch).toBe(false);
    await addCompetitor(env, u, pid, "Rival", ["rival.example"]);
    expect(seen).toHaveLength(0);

    const member = await seedMember(env, u.workspaceId);
    const mp = await call(env, member, "GET", `/projects/${pid}/competitors/dataforseo`);
    expect(mp.json!.data.canManage).toBe(false);
    expect((await call(env, member, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "rival.example" })).status).toBe(403);
    expect((await call(env, member, "PUT", `/projects/${pid}/competitors/dataforseo/settings`, { autoFetch: true })).status).toBe(403);

    const stranger = await seedUser(env);
    expect((await call(env, stranger, "GET", `/projects/${pid}/competitors/dataforseo`)).status).toBe(404);
    expect((await call(env, stranger, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "rival.example" })).status).toBe(404);
    expect((await call(env, u, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "not-a-competitor.example" })).status).toBe(404);
    expect((await call(env, u, "GET", `/projects/${pid}/competitors/dataforseo/domains/not-a-competitor.example`)).status).toBe(404);

    const demoPid = await seedProject(env, u.workspaceId, { is_demo: 1 });
    expect((await call(env, u, "POST", `/projects/${demoPid}/competitors/dataforseo/refresh`, { domain: "brassco.example" })).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("keeps only the newest snapshots per domain and scales to 25 competitor domains under D1 limits", async () => {
    const { env, u, pid, db } = await setup();
    await saveCreds(env, u);
    const now = Date.now();
    for (let i = 4; i >= 1; i--) {
      const at = new Date(now - i * 86_400_000).toISOString();
      const fid = `cfetch_old${i}`;
      await db.insert("competitor_fetches", { id: fid, workspace_id: u.workspaceId, project_id: pid, domain: "brassco.example", trigger: "manual", status: "completed", created_at: at, finished_at: at, location_code: 2840, language_code: "en", cost_usd: 0.03 });
      await db.insert("competitor_snapshots", { id: `csnap_old${i}`, workspace_id: u.workspaceId, project_id: pid, fetch_id: fid, domain: "brassco.example", endpoint: "ranked_keywords", location_code: 2840, language_code: "en", status: "ok", cost_usd: 0.01, item_count: 0, data_json: "{}", fetched_at: at });
    }
    expect((await call(env, u, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "brassco.example" })).status).toBe(202);
    const kept = await db.all<{ fetch_id: string }>("SELECT DISTINCT fetch_id FROM competitor_snapshots WHERE project_id = ? ORDER BY fetch_id", pid);
    expect(kept).toHaveLength(KEEP_SNAPSHOTS_PER_DOMAIN);
    expect(kept.map((k) => k.fetch_id)).not.toContain("cfetch_old4");
    expect(kept.map((k) => k.fetch_id)).not.toContain("cfetch_old3");

    const competitors = Array.from({ length: 5 }, (_, i) => ({ name: `C${i}`, domains: Array.from({ length: 5 }, (_, j) => `c${i}-${j}.example`), aliases: [] }));
    await db.run("UPDATE projects SET competitors_json = ? WHERE id = ?", JSON.stringify(competitors), pid);
    const panel = await call(env, u, "GET", `/projects/${pid}/competitors/dataforseo`);
    expect(panel.status).toBe(200);
    expect(panel.json!.data.domains).toHaveLength(25);
    // Snapshots of removed competitor domains are pruned on the next refresh.
    expect((await call(env, u, "POST", `/projects/${pid}/competitors/dataforseo/refresh`, { domain: "c0-0.example" })).status).toBe(202);
    expect(await db.all("SELECT id FROM competitor_snapshots WHERE domain = 'brassco.example'")).toHaveLength(0);
  });

  it("runs the refresh after the response via waitUntil when an execution context exists", async () => {
    const { env, u, pid } = await setup();
    await saveCreds(env, u);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    const res = await app.fetch(
      new Request(`http://localhost/api/projects/${pid}/competitors/dataforseo/refresh`, {
        method: "POST",
        headers: authHeaders(u.sessionToken, u.csrfToken),
        body: JSON.stringify({ domain: "brassco.example" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
    // Not finished when the response is sent: claimed (running) or still queued.
    expect(["queued", "running"]).toContain(((await res.json()) as { data: { fetch: { status: string } } }).data.fetch.status);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const panel = (await call(env, u, "GET", `/projects/${pid}/competitors/dataforseo`)).json!.data as CompetitorDataPanel;
    expect(panel.domains[0]!.latestFetch!.status).toBe("completed");
  });

  it("cron processes queued refreshes and fails ones stuck running", async () => {
    const { env, u, pid, db } = await setup();
    await saveCreds(env, u);
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    await db.insert("competitor_fetches", { id: "cfetch_q", workspace_id: u.workspaceId, project_id: pid, domain: "brassco.example", trigger: "competitor_added", status: "queued", created_at: old });
    await db.insert("competitor_fetches", { id: "cfetch_r", workspace_id: u.workspaceId, project_id: pid, domain: "other.example", trigger: "manual", status: "running", created_at: old, started_at: new Date(Date.now() - 3600_000).toISOString() });
    const r = await processQueuedCompetitorFetches(env, new Date());
    expect(r).toEqual({ failedStale: 1, processed: 1, promoted: 0 });
    const rows = await db.all<{ id: string; status: string }>("SELECT id, status FROM competitor_fetches ORDER BY id");
    expect(rows).toEqual([
      { id: "cfetch_q", status: "completed" },
      { id: "cfetch_r", status: "failed" },
    ]);
  });
});
