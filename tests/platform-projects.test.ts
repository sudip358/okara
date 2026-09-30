import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { decryptSecret, encryptSecret } from "@worker/lib/crypto";
import { newId } from "@worker/lib/ids";
import { createSession, lookupSession } from "@worker/platform/session";
import { projectRoutes } from "@worker/routes/projects";
import { integrationRoutes } from "@worker/routes/integrations";
import { demoRoutes } from "@worker/routes/demo";
import { outbound } from "@worker/platform/projects";
import { gscTokenAad } from "@worker/platform/gsc-oauth";
import { clearGscTokenCache, createGscProvider } from "@worker/platform/gsc-client";
import { gscEntryVerifiesHost, gscPropertyCoversHost, parseTxtData } from "@worker/platform/verification";
import type { Project } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedUser } from "./helpers/fixtures";

// ------------------------------------------------------------------ harness

/**
 * Mounts the platform-projects routers the same way createApp() does, with a session loader built on
 * lookupSession for the dev cookie. Independent of other modules' middleware state.
 */
function testApp() {
  const app = new Hono<AppEnv>().basePath("/api");
  app.use("*", async (c, next) => {
    const db = new Db(c.env.DB);
    const now = new Date();
    c.set("db", db);
    c.set("now", now);
    c.set("user", null);
    c.set("session", null);
    const m = /(?:^|;\s*)okara_session=([^;]+)/.exec(c.req.header("cookie") ?? "");
    if (m) {
      const found = await lookupSession(db, m[1]!, now);
      if (found) {
        c.set("user", found.user);
        c.set("session", found.session);
      }
    }
    await next();
  });
  app.route("/", projectRoutes);
  app.route("/", integrationRoutes);
  app.route("/", demoRoutes);
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    return c.json({ error: { code: "internal", message: String(err) } }, 500);
  });
  return app;
}

type FetchCall = { url: string; init: RequestInit | undefined };
function fakeFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const formOf = (init: RequestInit | undefined) => new URLSearchParams(String(init?.body ?? ""));

const baseInput = {
  name: "Shop",
  siteUrl: "https://shop.example.com",
  siteType: "ecommerce",
  brandName: "Residence Example",
  brandAliases: ["ResEx"],
  competitors: [{ name: "Brass Co", domains: ["brassco.example"], aliases: ["BrassCo"] }],
  productDescription: "Solid brass cabinet hardware.",
  audience: "Interior designers",
  locale: "en-US",
  language: "en",
  voice: "Plain.",
};

let env: Env;
let app: ReturnType<typeof testApp>;
let A: Awaited<ReturnType<typeof seedUser>>;
let B: Awaited<ReturnType<typeof seedUser>>;

async function call(user: { sessionToken: string; csrfToken: string }, method: string, path: string, body?: unknown, e: Env = env) {
  return app.request(`/api${path}`, { method, headers: authHeaders(user.sessionToken, user.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) }, e);
}
async function createAsA(input: Record<string, unknown> = baseInput): Promise<Project> {
  const res = await call(A, "POST", `/workspaces/${A.workspaceId}/projects`, input);
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Project }).data;
}

beforeEach(async () => {
  env = createTestEnv();
  app = testApp();
  A = await seedUser(env);
  B = await seedUser(env);
  outbound.fetch = (async () => {
    throw new Error("network disabled in tests");
  }) as typeof fetch;
  clearGscTokenCache();
});

// ------------------------------------------------------------------ tenancy and CRUD

describe("projects CRUD and tenancy", () => {
  it("creates, lists, reads, patches a project for its workspace member", async () => {
    const p = await createAsA({ ...baseInput, siteUrl: "https://Shop.Example.com/some/path?x=1" });
    expect(p.siteUrl).toBe("https://shop.example.com");
    expect(p.verifiedHost).toBeNull();
    const list = (await (await call(A, "GET", `/workspaces/${A.workspaceId}/projects`)).json()) as { data: Project[] };
    expect(list.data.map((x) => x.id)).toEqual([p.id]);
    const patched = await call(A, "PATCH", `/projects/${p.id}`, { name: "Renamed", scheduleEnabled: false });
    expect(patched.status).toBe(200);
    const pj = ((await patched.json()) as { data: Project }).data;
    expect(pj).toMatchObject({ name: "Renamed", scheduleEnabled: false, brandAliases: ["ResEx"] });
  });

  it("user B cannot read, patch, delete, export, or touch A's project (404)", async () => {
    const p = await createAsA();
    for (const [method, path, body] of [
      ["GET", `/projects/${p.id}`],
      ["PATCH", `/projects/${p.id}`, { name: "pwned" }],
      ["DELETE", `/projects/${p.id}`],
      ["GET", `/projects/${p.id}/export`],
      ["GET", `/projects/${p.id}/context`],
      ["PUT", `/projects/${p.id}/context/product`, { content: "x", facts: [] }],
      ["GET", `/projects/${p.id}/verification`],
      ["POST", `/projects/${p.id}/verification/check`, { method: "dns" }],
      ["GET", `/projects/${p.id}/limits`],
      ["PUT", `/projects/${p.id}/limits`, { crawlPages: 200 }],
      ["GET", `/projects/${p.id}/integrations`],
      ["GET", `/projects/${p.id}/gsc/connect`],
      ["DELETE", `/projects/${p.id}/gsc`],
      ["GET", `/workspaces/${A.workspaceId}/projects`],
      ["POST", `/workspaces/${A.workspaceId}/projects`, baseInput],
    ] as Array<[string, string, unknown?]>) {
      const res = await call(B, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const still = await call(A, "GET", `/projects/${p.id}`);
    expect(((await still.json()) as { data: Project }).data.name).toBe("Shop");
  });

  it("requires a session", async () => {
    const res = await app.request(`/api/workspaces/${A.workspaceId}/projects`, {}, env);
    expect(res.status).toBe(401);
  });

  it.each([
    ["http://shop.example.com", "https"],
    ["https://user:pw@shop.example.com", "credentials"],
    ["https://shop.example.com:8443", "port"],
    ["https://127.0.0.1", "public domain"],
    ["https://localhost", "public domain"],
    ["shop.example.com", "https URL"],
  ])("rejects siteUrl %s", async (siteUrl, fragment) => {
    const res = await call(A, "POST", `/workspaces/${A.workspaceId}/projects`, { ...baseInput, siteUrl });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain(fragment);
  });

  it("rejects more than five competitors and unknown fields", async () => {
    const competitors = Array.from({ length: 6 }, (_, i) => ({ name: `C${i}`, domains: [`c${i}.example`], aliases: [] }));
    expect((await call(A, "POST", `/workspaces/${A.workspaceId}/projects`, { ...baseInput, competitors })).status).toBe(400);
    expect((await call(A, "POST", `/workspaces/${A.workspaceId}/projects`, { ...baseInput, workspaceId: B.workspaceId })).status).toBe(400);
  });

  it("rejects brand/competitor alias and domain collisions, listing them", async () => {
    const res = await call(A, "POST", `/workspaces/${A.workspaceId}/projects`, {
      ...baseInput,
      brandAliases: ["ResEx", "brassco"],
      competitors: [
        { name: "Brass Co", domains: ["brassco.example"], aliases: ["BrassCo"] },
        { name: "Mirror", domains: ["example.com"], aliases: [] },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { collisions: Array<{ kind: string; term: string; b: string }> } } };
    expect(body.error.code).toBe("alias_collision");
    expect(body.error.details.collisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "brand_vs_competitor", b: "Brass Co" }),
        expect.objectContaining({ kind: "domain", term: "example.com", b: "Mirror" }),
      ]),
    );
  });

  it("changing the site host clears verification", async () => {
    const p = await createAsA();
    await A.db.run("UPDATE projects SET verified_host = 'shop.example.com', verification_method = 'dns', verified_at = 'x' WHERE id = ?", p.id);
    const res = await call(A, "PATCH", `/projects/${p.id}`, { siteUrl: "https://www.example.org" });
    const pj = ((await res.json()) as { data: Project }).data;
    expect(pj).toMatchObject({ siteUrl: "https://www.example.org", verifiedHost: null, verificationMethod: null });
  });
});

// ------------------------------------------------------------------ context documents

describe("context documents", () => {
  it("creates v1 per kind with confirmed user facts, and PUT creates a new version without mutating old ones", async () => {
    const p = await createAsA();
    const res = await call(A, "GET", `/projects/${p.id}/context`);
    const docs = ((await res.json()) as { data: Array<{ id: string; kind: string; version: number; facts: Array<{ confirmed: boolean; source: string }>; unconfirmedCount: number }> }).data;
    expect(docs.map((d) => d.kind)).toEqual(["product", "positioning", "competitors", "voice", "pillars"]);
    expect(docs.every((d) => d.version === 1)).toBe(true);
    const product = docs.find((d) => d.kind === "product")!;
    expect(product.facts).toEqual([expect.objectContaining({ confirmed: true, source: "user" })]);
    expect(docs.find((d) => d.kind === "pillars")!.facts).toEqual([]);

    const put = await call(A, "PUT", `/projects/${p.id}/context/product`, {
      content: "Updated",
      facts: [
        { text: "Solid brass", confirmed: true },
        { text: "Ships in 3 days", confirmed: false, source: "crawl:snap_1" },
      ],
    });
    expect(put.status).toBe(200);
    const v2 = ((await put.json()) as { data: { id: string; version: number; unconfirmedCount: number; content: string } }).data;
    expect(v2).toMatchObject({ version: 2, unconfirmedCount: 1, content: "Updated" });
    const old = await A.db.first<{ content: string; version: number }>("SELECT content, version FROM context_documents WHERE id = ?", product.id);
    expect(old).toEqual({ content: "Solid brass cabinet hardware.", version: 1 });

    // usedByRecommendationCount follows evidence(context_doc, ref_id = doc id) cited by recommendations.
    const evId = newId("ev");
    await A.db.insert("evidence", { id: evId, workspace_id: p.workspaceId, project_id: p.id, source: "context_doc", ref_id: v2.id, text: "t", hash: "h", created_at: "2026-09-30T00:00:00Z" });
    await A.db.insert("recommendations", {
      id: newId("rec"), workspace_id: p.workspaceId, project_id: p.id, agent: "seo", scope: "page", target_json: "{}", issue_type: "x", trigger: "t", issue: "i",
      action: "a", rationale: "r", effort: "low", uncertainty: "low", limitations: "l", verified: 0, priority: 1, priority_version: "v",
      evidence_ids_json: JSON.stringify([evId]), dedup_key: "d", status: "open", created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
    });
    const again = ((await (await call(A, "GET", `/projects/${p.id}/context`)).json()) as { data: Array<{ kind: string; version: number; usedByRecommendationCount: number }> }).data;
    expect(again.find((d) => d.kind === "product")).toMatchObject({ version: 2, usedByRecommendationCount: 1 });
    expect(again.find((d) => d.kind === "voice")).toMatchObject({ usedByRecommendationCount: 0 });
  });

  it("rejects unknown kinds and invalid bodies", async () => {
    const p = await createAsA();
    expect((await call(A, "PUT", `/projects/${p.id}/context/secrets`, { content: "x", facts: [] })).status).toBe(400);
    expect((await call(A, "PUT", `/projects/${p.id}/context/voice`, { content: 5 })).status).toBe(400);
  });
});

// ------------------------------------------------------------------ limits

describe("limits", () => {
  it("returns defaults and applies bounded updates", async () => {
    const p = await createAsA();
    const get = ((await (await call(A, "GET", `/projects/${p.id}/limits`)).json()) as { data: unknown }).data;
    expect(get).toEqual({ crawlPages: 20, gscRows: 5000, geoPromptsPerRun: 5, providerCallsPerDay: 60, usdPerDay: 0.5 });
    for (const bad of [{ crawlPages: 0 }, { crawlPages: 201 }, { gscRows: 99 }, { geoPromptsPerRun: 26 }, { providerCallsPerDay: 501 }, { usdPerDay: 20.01 }, { usdPerDay: -1 }]) {
      expect((await call(A, "PUT", `/projects/${p.id}/limits`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const put = ((await (await call(A, "PUT", `/projects/${p.id}/limits`, { crawlPages: 50, usdPerDay: 1.25 })).json()) as { data: unknown }).data;
    expect(put).toEqual({ crawlPages: 50, gscRows: 5000, geoPromptsPerRun: 5, providerCallsPerDay: 60, usdPerDay: 1.25 });
    const row = await A.db.first<{ usd_micros_per_day: number }>("SELECT usd_micros_per_day FROM project_limits WHERE project_id = ?", p.id);
    expect(row!.usd_micros_per_day).toBe(1_250_000);
  });
});

// ------------------------------------------------------------------ GSC OAuth

async function startConnect(user: typeof A, projectId: string) {
  const res = await call(user, "GET", `/projects/${projectId}/gsc/connect`);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  return { loc, state: loc.searchParams.get("state")! };
}

function tokenEndpoint(refreshToken: string | undefined) {
  return fakeFetch((url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      const f = formOf(init);
      if (f.get("grant_type") === "authorization_code") {
        return json({ access_token: "at-1", expires_in: 3600, scope: "https://www.googleapis.com/auth/webmasters.readonly", token_type: "Bearer", ...(refreshToken ? { refresh_token: refreshToken } : {}) });
      }
    }
    return json({ error: "unexpected" }, 500);
  });
}

describe("GSC OAuth", () => {
  it("redirects to Google with minimum scope, offline access, PKCE, and a session-bound state", async () => {
    const p = await createAsA();
    const { loc, state } = await startConnect(A, p.id);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect(loc.searchParams.get("include_granted_scopes")).toBe("false");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:5173/api/gsc/callback");
    const row = await A.db.first<{ session_id: string; user_id: string; workspace_id: string; project_id: string; purpose: string }>("SELECT * FROM oauth_states WHERE state = ?", state);
    expect(row).toMatchObject({ session_id: A.sessionId, user_id: A.userId, workspace_id: A.workspaceId, project_id: p.id, purpose: "gsc" });
  });

  it("rejects a callback from another session and consumes the state (single use)", async () => {
    const p = await createAsA();
    const { state } = await startConnect(A, p.id);
    const other = await createSession(A.db, A.userId, new Date());
    const f = tokenEndpoint("rt-1");
    outbound.fetch = f.fn;
    const wrong = await call({ sessionToken: other.token, csrfToken: other.csrfToken }, "GET", `/gsc/callback?state=${state}&code=c1`);
    expect(wrong.status).toBe(403);
    const replay = await call(A, "GET", `/gsc/callback?state=${state}&code=c1`);
    expect(replay.status).toBe(400);
    expect(f.calls).toHaveLength(0);
    expect(await A.db.first("SELECT id FROM oauth_connections WHERE project_id = ?", p.id)).toBeNull();
  });

  it("rejects expired state", async () => {
    const p = await createAsA();
    const { state } = await startConnect(A, p.id);
    await A.db.run("UPDATE oauth_states SET expires_at = '2000-01-01T00:00:00.000Z' WHERE state = ?", state);
    outbound.fetch = tokenEndpoint("rt").fn;
    expect((await call(A, "GET", `/gsc/callback?state=${state}&code=c1`)).status).toBe(400);
  });

  it("stores the refresh token encrypted and keeps it when a reconnect omits refresh_token", async () => {
    const p = await createAsA();
    const first = await startConnect(A, p.id);
    const f1 = tokenEndpoint("refresh-token-ORIGINAL");
    outbound.fetch = f1.fn;
    const cb = await call(A, "GET", `/gsc/callback?state=${first.state}&code=code-1`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe(`/projects/${p.id}/integrations?gsc=connected`);
    const exchange = formOf(f1.calls[0]!.init);
    expect(exchange.get("code_verifier")).toBeTruthy();
    expect(exchange.get("redirect_uri")).toBe("http://localhost:5173/api/gsc/callback");

    const row1 = await A.db.first<{ refresh_token_enc: string; status: string }>("SELECT refresh_token_enc, status FROM oauth_connections WHERE project_id = ?", p.id);
    expect(row1!.status).toBe("connected");
    expect(row1!.refresh_token_enc).not.toContain("ORIGINAL");
    expect(await decryptSecret(env, row1!.refresh_token_enc, gscTokenAad(p.id))).toBe("refresh-token-ORIGINAL");

    const second = await startConnect(A, p.id);
    outbound.fetch = tokenEndpoint(undefined).fn;
    const cb2 = await call(A, "GET", `/gsc/callback?state=${second.state}&code=code-2`);
    expect(cb2.headers.get("location")).toContain("gsc=connected");
    const row2 = await A.db.first<{ refresh_token_enc: string; status: string }>("SELECT refresh_token_enc, status FROM oauth_connections WHERE project_id = ?", p.id);
    expect(row2!.status).toBe("connected");
    expect(await decryptSecret(env, row2!.refresh_token_enc, gscTokenAad(p.id))).toBe("refresh-token-ORIGINAL");

    const status = ((await (await call(A, "GET", `/projects/${p.id}/integrations`)).json()) as { data: { gsc: { state: string }; providers: unknown[] } }).data;
    expect(status.gsc.state).toBe("ready");
    expect(status.providers.length).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(row2!.refresh_token_enc);
  });

  it("reports an error state when the first connection returns no refresh token", async () => {
    const p = await createAsA();
    const { state } = await startConnect(A, p.id);
    outbound.fetch = tokenEndpoint(undefined).fn;
    const cb = await call(A, "GET", `/gsc/callback?state=${state}&code=c`);
    expect(cb.headers.get("location")).toContain("reason=no_refresh_token");
  });

  it("disconnect revokes at Google and deletes the token", async () => {
    const p = await createAsA();
    await insertConnection(p, "rt-disconnect");
    const f = fakeFetch((url) => (url === "https://oauth2.googleapis.com/revoke" ? new Response("", { status: 200 }) : json({}, 500)));
    outbound.fetch = f.fn;
    const res = await call(A, "DELETE", `/projects/${p.id}/gsc`);
    expect(((await res.json()) as { data: { revoked: boolean } }).data.revoked).toBe(true);
    expect(formOf(f.calls[0]!.init).get("token")).toBe("rt-disconnect");
    expect(await A.db.first("SELECT id FROM oauth_connections WHERE project_id = ?", p.id)).toBeNull();
  });
});

async function insertConnection(p: Project, refreshToken: string) {
  await A.db.insert("oauth_connections", {
    id: newId("oac"), workspace_id: p.workspaceId, project_id: p.id, user_id: A.userId, provider: "google_gsc",
    scopes: "https://www.googleapis.com/auth/webmasters.readonly", refresh_token_enc: await encryptSecret(env, refreshToken, gscTokenAad(p.id)),
    status: "connected", created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
  });
}

function googleApi(sites: Array<{ siteUrl: string; permissionLevel: string }>, opts: { invalidGrant?: boolean } = {}) {
  return fakeFetch(async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      if (opts.invalidGrant) return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      return json({ access_token: "access-xyz", expires_in: 3600 });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer access-xyz") return json({ error: { message: "unauthenticated" } }, 401);
    if (url === "https://www.googleapis.com/webmasters/v3/sites") return json({ siteEntry: sites });
    if (url.includes("/searchAnalytics/query")) return json({ rows: [{ keys: ["q"], clicks: 1, impressions: 10, ctr: 0.1, position: 3 }], responseAggregationType: "byProperty" });
    return json({}, 404);
  });
}

// ------------------------------------------------------------------ GSC client

describe("GSC client", () => {
  it("refreshes server-side, caches the access token, and posts the documented query body", async () => {
    const p = await createAsA();
    await insertConnection(p, "rt-client");
    const f = googleApi([{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }]);
    const gsc = (await createGscProvider(env, A.db, { id: p.id, workspaceId: p.workspaceId }, f.fn))!;
    expect(await gsc.listProperties()).toEqual([{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }]);
    const out = await gsc.query({ property: "sc-domain:example.com", startDate: "2026-08-30", endDate: "2026-09-26", dimensions: ["query", "page"], rowLimit: 99999, startRow: 0, dataState: "final" });
    expect(out.rows).toHaveLength(1);
    const q = f.calls.find((c) => c.url.includes("searchAnalytics"))!;
    expect(q.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
    expect(JSON.parse(String(q.init!.body))).toEqual({ startDate: "2026-08-30", endDate: "2026-09-26", dimensions: ["query", "page"], type: "web", rowLimit: 25000, startRow: 0, dataState: "final" });
    expect(f.calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);
    expect(formOf(f.calls[0]!.init).get("grant_type")).toBe("refresh_token");
  });

  it("marks the connection as error on invalid_grant", async () => {
    const p = await createAsA();
    await insertConnection(p, "rt-dead");
    const gsc = (await createGscProvider(env, A.db, { id: p.id, workspaceId: p.workspaceId }, googleApi([], { invalidGrant: true }).fn))!;
    await expect(gsc.listProperties()).rejects.toMatchObject({ code: "invalid_grant" });
    const row = await A.db.first<{ status: string; last_error: string }>("SELECT status, last_error FROM oauth_connections WHERE project_id = ?", p.id);
    expect(row!.status).toBe("error");
    expect(row!.last_error).toContain("invalid_grant");
    expect(await createGscProvider(env, A.db, { id: p.id, workspaceId: p.workspaceId }, googleApi([]).fn)).toBeNull();
  });

  it("returns null when not connected", async () => {
    const p = await createAsA();
    expect(await createGscProvider(env, A.db, { id: p.id, workspaceId: p.workspaceId }, googleApi([]).fn)).toBeNull();
  });
});

// ------------------------------------------------------------------ verification

describe("verification", () => {
  it("URL-prefix vs sc-domain coverage rules", () => {
    expect(gscPropertyCoversHost("https://shop.example.com/", "shop.example.com")).toBe(true);
    expect(gscPropertyCoversHost("https://shop.example.com/blog/", "shop.example.com")).toBe(false);
    expect(gscPropertyCoversHost("http://shop.example.com/", "shop.example.com")).toBe(false);
    expect(gscPropertyCoversHost("https://example.com/", "shop.example.com")).toBe(false);
    expect(gscPropertyCoversHost("sc-domain:example.com", "shop.example.com")).toBe(true);
    expect(gscPropertyCoversHost("sc-domain:example.com", "example.com")).toBe(true);
    expect(gscPropertyCoversHost("sc-domain:shop.example.com", "example.com")).toBe(false);
    expect(gscPropertyCoversHost("sc-domain:ample.com", "example.com")).toBe(false);
    expect(gscEntryVerifiesHost({ siteUrl: "sc-domain:example.com", permissionLevel: "siteUnverifiedUser" }, "shop.example.com").ok).toBe(false);
    expect(gscEntryVerifiesHost({ siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" }, "shop.example.com").ok).toBe(true);
    expect(parseTxtData('"okara-site-verification=" "abc"')).toBe("okara-site-verification=abc");
  });

  it("selecting a GSC property the account cannot see is rejected; a covering verified property verifies the host", async () => {
    const p = await createAsA();
    await insertConnection(p, "rt-v");
    outbound.fetch = googleApi([
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteFullUser" },
      { siteUrl: "https://other.example.com/", permissionLevel: "siteOwner" },
    ]).fn;
    expect((await call(A, "PUT", `/projects/${p.id}/gsc/property`, { property: "sc-domain:not-listed.com" })).status).toBe(400);

    const miss = await call(A, "PUT", `/projects/${p.id}/gsc/property`, { property: "https://other.example.com/" });
    const missBody = ((await miss.json()) as { data: { verification: { verified: boolean } } }).data;
    expect(missBody.verification.verified).toBe(false);

    const hit = await call(A, "PUT", `/projects/${p.id}/gsc/property`, { property: "sc-domain:example.com" });
    const hitBody = ((await hit.json()) as { data: { verification: { verified: boolean; method: string; verifiedHost: string } } }).data;
    expect(hitBody.verification).toMatchObject({ verified: true, method: "gsc", verifiedHost: "shop.example.com" });
  });

  it("unverified GSC permission level does not verify", async () => {
    const p = await createAsA();
    await insertConnection(p, "rt-u");
    outbound.fetch = googleApi([{ siteUrl: "sc-domain:example.com", permissionLevel: "siteUnverifiedUser" }]).fn;
    const res = await call(A, "PUT", `/projects/${p.id}/gsc/property`, { property: "sc-domain:example.com" });
    expect(((await res.json()) as { data: { verification: { verified: boolean } } }).data.verification.verified).toBe(false);
    const check = await call(A, "POST", `/projects/${p.id}/verification/check`, { method: "gsc" });
    expect(((await check.json()) as { data: { verified: boolean } }).data.verified).toBe(false);
  });

  it("DNS TXT verification via DNS-over-HTTPS", async () => {
    const p = await createAsA();
    const status = ((await (await call(A, "GET", `/projects/${p.id}/verification`)).json()) as { data: { verified: boolean; dnsRecord: { name: string; value: string }; fileCheck: { url: string; content: string } } }).data;
    expect(status.verified).toBe(false);
    expect(status.dnsRecord.name).toBe("_okara-verify.shop.example.com");
    expect(status.fileCheck.url).toBe("https://shop.example.com/.well-known/okara-verification.txt");

    outbound.fetch = fakeFetch(() => json({ Status: 0, Answer: [{ name: "_okara-verify.shop.example.com.", type: 16, data: '"okara-site-verification=wrong"' }] })).fn;
    let res = await call(A, "POST", `/projects/${p.id}/verification/check`, { method: "dns" });
    expect(((await res.json()) as { data: { verified: boolean } }).data.verified).toBe(false);

    const f = fakeFetch((url, init) => {
      expect(new Headers(init?.headers).get("accept")).toBe("application/dns-json");
      expect(url).toBe("https://cloudflare-dns.com/dns-query?name=_okara-verify.shop.example.com&type=TXT");
      return json({ Status: 0, Answer: [{ name: "_okara-verify.shop.example.com.", type: 16, data: `"${status.dnsRecord.value}"` }] });
    });
    outbound.fetch = f.fn;
    res = await call(A, "POST", `/projects/${p.id}/verification/check`, { method: "dns" });
    expect(((await res.json()) as { data: { verified: boolean; method: string; verifiedHost: string } }).data).toMatchObject({ verified: true, method: "dns", verifiedHost: "shop.example.com" });
  });

  it("file verification: no redirects, size cap, token required", async () => {
    const p = await createAsA();
    const token = (await A.db.first<{ verification_token: string }>("SELECT verification_token FROM projects WHERE id = ?", p.id))!.verification_token;
    const check = async () => ((await (await call(A, "POST", `/projects/${p.id}/verification/check`, { method: "file" })).json()) as { data: { verified: boolean; check: { detail: string } } }).data;

    outbound.fetch = fakeFetch((_u, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 301, headers: { location: "https://evil.example/" } });
    }).fn;
    expect((await check()).verified).toBe(false);

    outbound.fetch = fakeFetch(() => new Response(`${token}${"x".repeat(2000)}`, { status: 200 })).fn;
    const big = await check();
    expect(big.verified).toBe(false);
    expect(big.check.detail).toContain("larger");

    const f = fakeFetch(() => new Response(`${token}\n`, { status: 200 }));
    outbound.fetch = f.fn;
    expect((await check()).verified).toBe(true);
    expect(f.calls[0]!.url).toBe("https://shop.example.com/.well-known/okara-verification.txt");
  });
});

// ------------------------------------------------------------------ export and delete

describe("export and delete", () => {
  it("exports all project data without secrets", async () => {
    const p = await createAsA();
    await insertConnection(p, "rt-export-SECRET");
    await A.db.insert("provider_credentials", { id: newId("pc"), workspace_id: A.workspaceId, provider: "gemini", key_enc: "v1.aaaa.KEYENCSECRET", key_hint: "abcd", created_at: "x", updated_at: "x" });
    const conn = (await A.db.first<{ refresh_token_enc: string }>("SELECT refresh_token_enc FROM oauth_connections WHERE project_id = ?", p.id))!;
    const token = (await A.db.first<{ verification_token: string }>("SELECT verification_token FROM projects WHERE id = ?", p.id))!.verification_token;
    const res = await call(A, "GET", `/projects/${p.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="okara-project-/);
    const text = await res.text();
    for (const secret of ["refresh_token_enc", "key_enc", conn.refresh_token_enc, "rt-export-SECRET", "KEYENCSECRET", token, "code_verifier"]) {
      expect(text).not.toContain(secret);
    }
    const body = JSON.parse(text) as { data: { project: { id: string }; tables: Record<string, unknown[]> } };
    expect(body.data.project.id).toBe(p.id);
    expect(body.data.tables.context_documents).toHaveLength(5);
    expect(body.data.tables.project_limits).toHaveLength(1);
    expect(body.data.tables.oauth_connections).toHaveLength(1);
    expect(Object.keys(body.data.tables)).toEqual(expect.arrayContaining(["recommendations", "evidence", "geo_observations", "gsc_metrics", "agent_runs", "run_events", "provider_calls"]));
  });

  it("delete removes all tenant data (demo-seeded) and revokes the GSC token", async () => {
    const demoEnv = createTestEnv({ DEMO_MODE: "true", ENVIRONMENT: "development" });
    env = demoEnv;
    A = await seedUser(env);
    const seeded = await call(A, "POST", "/demo/seed", undefined, demoEnv);
    expect(seeded.status).toBe(201);
    const p = ((await seeded.json()) as { data: Project }).data;
    await insertConnection(p, "rt-delete");
    await A.db.insert("run_locks", { project_id: p.id, agent: "seo", run_id: "r", expires_at: "x" });
    await A.db.insert("usage_counters", { scope_key: `project:${p.id}`, day: "2026-09-30", resource: "provider_calls", used: 1, limit_value: 60 });
    // Another project in the same workspace must survive.
    const keep = await createAsA();

    const f = fakeFetch((url) => (url === "https://oauth2.googleapis.com/revoke" ? new Response("", { status: 200 }) : json({}, 500)));
    outbound.fetch = f.fn;
    const del = await call(A, "DELETE", `/projects/${p.id}`, undefined, demoEnv);
    expect(del.status).toBe(200);
    expect(((await del.json()) as { data: { gscRevoked: boolean } }).data.gscRevoked).toBe(true);
    expect(f.calls.map((c) => c.url)).toEqual(["https://oauth2.googleapis.com/revoke"]);

    const tables = [
      "context_documents", "oauth_connections", "agent_runs", "run_events", "crawl_runs", "pages", "page_snapshots", "audit_findings",
      "gsc_syncs", "gsc_metrics", "gsc_daily", "evidence", "decision_records", "recommendations", "recommendation_events", "geo_prompt_sets",
      "geo_prompts", "geo_observations", "geo_brand_observations", "geo_citations", "geo_search_queries", "geo_displacements", "provider_calls",
      "project_limits", "run_locks",
    ];
    for (const t of tables) {
      const n = await A.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, p.id);
      expect(n!.n, t).toBe(0);
    }
    expect((await A.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM usage_counters WHERE scope_key = ?", `project:${p.id}`))!.n).toBe(0);
    expect((await call(A, "GET", `/projects/${p.id}`, undefined, demoEnv)).status).toBe(404);
    expect((await call(A, "GET", `/projects/${keep.id}`, undefined, demoEnv)).status).toBe(200);
  });
});

// ------------------------------------------------------------------ demo

describe("demo seed", () => {
  it("is 404 in production even with DEMO_MODE=true, and 404 when DEMO_MODE is off", async () => {
    const prod = createTestEnv({ DEMO_MODE: "true", ENVIRONMENT: "production" });
    const u = await seedUser(prod);
    expect((await call(u, "POST", "/demo/seed", undefined, prod)).status).toBe(404);
    expect((await new Db(prod.DB).first<{ n: number }>("SELECT COUNT(*) AS n FROM projects"))!.n).toBe(0);
    expect((await call(A, "POST", "/demo/seed")).status).toBe(404);
  });

  it("creates a labelled demo project with data for every screen", async () => {
    const demoEnv = createTestEnv({ DEMO_MODE: "true", ENVIRONMENT: "development" });
    const u = await seedUser(demoEnv);
    const res = await call(u, "POST", "/demo/seed", undefined, demoEnv);
    expect(res.status).toBe(201);
    const p = ((await res.json()) as { data: Project }).data;
    expect(p).toMatchObject({ isDemo: true, scheduleEnabled: false, siteUrl: "https://demo.example", workspaceId: u.workspaceId });
    const db = new Db(demoEnv.DB);
    const count = async (sql: string) => (await db.first<{ n: number }>(sql, p.id))!.n;
    expect(await count("SELECT COUNT(*) AS n FROM gsc_syncs WHERE project_id = ? AND source = 'demo'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM gsc_daily WHERE project_id = ?")).toBe(56);
    expect(await count("SELECT COUNT(*) AS n FROM page_snapshots WHERE project_id = ?")).toBe(8);
    expect(await count("SELECT COUNT(*) AS n FROM audit_findings WHERE project_id = ?")).toBeGreaterThan(0);
    expect(await count("SELECT COUNT(*) AS n FROM recommendations WHERE project_id = ? AND is_demo = 1 AND agent = 'seo'")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM recommendations WHERE project_id = ? AND is_demo = 1 AND agent = 'geo'")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM geo_prompts WHERE project_id = ? AND prompt_type = 'discovery'")).toBe(5);
    expect(await count("SELECT COUNT(*) AS n FROM geo_observations WHERE project_id = ? AND model = 'demo-fixture' AND measurement_type = 'api'")).toBe(10);
    expect(await count("SELECT COUNT(*) AS n FROM geo_displacements WHERE project_id = ?")).toBeGreaterThan(0);
    expect(await count("SELECT COUNT(*) AS n FROM geo_search_queries WHERE project_id = ?")).toBeGreaterThan(0);
    expect(await count("SELECT COUNT(*) AS n FROM run_events WHERE project_id = ?")).toBeGreaterThan(0);
    // Prompts are brand-blind.
    const prompts = await db.all<{ text: string }>("SELECT text FROM geo_prompts WHERE project_id = ?", p.id);
    expect(prompts.every((x) => !/demo furnishings/i.test(x.text))).toBe(true);
    // Every answer is labelled as demo data; no cost shown as actual.
    const answers = await db.all<{ raw_answer: string | null; cost_usd: number | null }>("SELECT raw_answer, cost_usd FROM geo_observations WHERE project_id = ?", p.id);
    expect(answers.filter((a) => a.raw_answer !== null).every((a) => a.raw_answer!.includes("Demo data"))).toBe(true);
    expect(answers.every((a) => a.cost_usd === null)).toBe(true);
    // Recommendation evidence IDs resolve to evidence rows of this project.
    const recs = await db.all<{ evidence_ids_json: string }>("SELECT evidence_ids_json FROM recommendations WHERE project_id = ?", p.id);
    for (const r of recs) {
      for (const id of JSON.parse(r.evidence_ids_json) as string[]) {
        expect(await db.first("SELECT id FROM evidence WHERE id = ? AND project_id = ?", id, p.id)).not.toBeNull();
      }
    }
    const integ = ((await (await call(u, "GET", `/projects/${p.id}/integrations`, undefined, demoEnv)).json()) as { data: { gsc: { state: string } } }).data;
    expect(integ.gsc.state).toBe("demo");
    const ctx = ((await (await call(u, "GET", `/projects/${p.id}/context`, undefined, demoEnv)).json()) as { data: Array<{ kind: string; version: number; unconfirmedCount: number; usedByRecommendationCount: number }> }).data;
    expect(ctx.find((d) => d.kind === "product")).toMatchObject({ version: 2, unconfirmedCount: 1, usedByRecommendationCount: 2 });
  });
});
