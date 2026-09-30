import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { sha256Hex } from "@worker/lib/hash";
import { resetOidcDeps, safeReturnTo, setOidcDeps, pkceChallenge } from "@worker/platform/oidc";
import { hitRateLimit } from "@worker/platform/rate-limit";
import { timingSafeEqualStr } from "@worker/platform/security";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedUser } from "./helpers/fixtures";

const ORIGIN = "http://localhost:5173";
const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const app = createApp();

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
});

const networkDisabled: typeof fetch = async () => {
  throw new Error("Network disabled in tests");
};

beforeEach(() => {
  setOidcDeps({ jwks: createLocalJWKSet({ keys: [jwk] }), fetch: networkDisabled });
});
afterEach(() => resetOidcDeps());

interface TokenOpts {
  nonce: string;
  sub?: string;
  email?: string;
  emailVerified?: boolean;
  aud?: string;
  iss?: string;
  expSecondsFromNow?: number;
  key?: CryptoKey;
}

async function makeIdToken(o: TokenOpts): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ nonce: o.nonce, email: o.email ?? "alice@example.com", email_verified: o.emailVerified ?? true, name: "Alice" })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer(o.iss ?? "https://accounts.google.com")
    .setAudience(o.aud ?? CLIENT_ID)
    .setSubject(o.sub ?? "google-sub-alice")
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (o.expSecondsFromNow ?? 3600))
    .sign(o.key ?? privateKey);
}

/** Token endpoint fake: records the exchange and returns the given id_token. */
function tokenEndpoint(idToken: () => Promise<string>, calls: Array<{ url: string; body: URLSearchParams }> = []) {
  const f: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
    return new Response(JSON.stringify({ id_token: await idToken(), access_token: "at", token_type: "Bearer" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return f;
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}
function cookieValue(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    const [pair] = c.split(";");
    const idx = pair!.indexOf("=");
    if (pair!.slice(0, idx).trim() === name) return pair!.slice(idx + 1);
  }
  return null;
}

async function startLogin(env: Env, returnTo?: string) {
  const res = await app.request(`/api/auth/login${returnTo !== undefined ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`, {}, env);
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("Location")!);
  const state = loc.searchParams.get("state")!;
  const nonce = loc.searchParams.get("nonce")!;
  expect(cookieValue(res, "okara_login_state")).toBe(state);
  return { res, loc, state, nonce, stateCookie: `okara_login_state=${state}` };
}

function callback(env: Env, state: string, cookie: string, extra = "code=auth-code-123") {
  return app.request(`/api/auth/callback?state=${encodeURIComponent(state)}&${extra}`, { headers: cookie ? { Cookie: cookie } : {} }, env);
}

function authError(res: Response): string | null {
  const loc = res.headers.get("Location");
  return loc ? new URL(loc).searchParams.get("authError") : null;
}

async function countRows(env: Env, table: string): Promise<number> {
  const r = await new Db(env.DB).first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(r?.n ?? 0);
}

describe("platform-auth: Google OIDC login", () => {
  it("redirects to Google with state, nonce, PKCE S256 and the minimal scope", async () => {
    const env = createTestEnv();
    const { loc, state, nonce, res } = await startLogin(env, "/projects/abc?tab=seo");
    expect(`${loc.origin}${loc.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback`);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(state.length).toBeGreaterThan(30);
    expect(nonce.length).toBeGreaterThan(30);
    const row = await new Db(env.DB).first<Record<string, string>>("SELECT * FROM oauth_states WHERE state = ?", state);
    expect(row).toMatchObject({ purpose: "login", nonce, return_to: "/projects/abc?tab=seo" });
    expect(await pkceChallenge(row!.code_verifier!)).toBe(loc.searchParams.get("code_challenge"));
    const stateCookie = setCookies(res).find((c) => c.startsWith("okara_login_state="))!;
    expect(stateCookie).toMatch(/HttpOnly/i);
    expect(stateCookie).toMatch(/SameSite=Lax/i);
  });

  it("returns 412 setup_required when Google credentials are missing", async () => {
    const env = createTestEnv({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: "" });
    const res = await app.request("/api/auth/login", {}, env);
    expect(res.status).toBe(412);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("setup_required");
  });

  it("only accepts same-origin relative returnTo paths", () => {
    expect(safeReturnTo("/projects/1?x=2#h", ORIGIN)).toBe("/projects/1?x=2#h");
    for (const bad of ["//evil.com/x", "https://evil.com/", "/\\evil.com", "javascript:alert(1)", "projects", "/a\nb", "/api/auth/logout", ""]) {
      expect(safeReturnTo(bad, ORIGIN)).toBe("/");
    }
  });

  it("completes login: exchanges code with the PKCE verifier, creates user/workspace/owner, sets a secure session cookie", async () => {
    const env = createTestEnv();
    const { state, nonce, stateCookie, loc } = await startLogin(env, "/onboarding");
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    setOidcDeps({ fetch: tokenEndpoint(() => makeIdToken({ nonce }), calls) });

    const res = await callback(env, state, stateCookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${ORIGIN}/onboarding`);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0]!.body.get("grant_type")).toBe("authorization_code");
    expect(calls[0]!.body.get("code")).toBe("auth-code-123");
    expect(await pkceChallenge(calls[0]!.body.get("code_verifier")!)).toBe(loc.searchParams.get("code_challenge"));

    const sessionCookie = setCookies(res).find((c) => c.startsWith("okara_session="))!;
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/Secure/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    expect(sessionCookie).toMatch(/Path=\//);
    expect(sessionCookie).toMatch(/Max-Age=1209600/);
    const token = cookieValue(res, "okara_session")!;

    const me = await app.request("/api/me", { headers: { Cookie: `okara_session=${token}` } }, env);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { data: { user: { email: string }; workspaces: Array<{ role: string }>; csrfToken: string; demoModeAvailable: boolean; environment: string } };
    expect(body.data.user.email).toBe("alice@example.com");
    expect(body.data.workspaces).toHaveLength(1);
    expect(body.data.workspaces[0]!.role).toBe("owner");
    expect(body.data.csrfToken.length).toBeGreaterThan(20);
    expect(body.data.demoModeAvailable).toBe(false);
    expect(body.data.environment).toBe("test");

    // D1 stores only the SHA-256 of the session token.
    const s = await new Db(env.DB).first<{ id: string }>("SELECT id FROM sessions");
    expect(s!.id).toBe(await sha256Hex(token));

    // Second login with the same Google subject reuses the user and workspace.
    const again = await startLogin(env);
    setOidcDeps({ fetch: tokenEndpoint(() => makeIdToken({ nonce: again.nonce })) });
    expect((await callback(env, again.state, again.stateCookie)).status).toBe(302);
    expect(await countRows(env, "users")).toBe(1);
    expect(await countRows(env, "workspaces")).toBe(1);
  });

  it("treats state as single-use", async () => {
    const env = createTestEnv();
    const { state, nonce, stateCookie } = await startLogin(env);
    setOidcDeps({ fetch: tokenEndpoint(() => makeIdToken({ nonce })) });
    const first = await callback(env, state, stateCookie);
    expect(cookieValue(first, "okara_session")).toBeTruthy();
    const replay = await callback(env, state, stateCookie);
    expect(authError(replay)).toBe("invalid_state");
    expect(cookieValue(replay, "okara_session")).toBeNull();
    expect(await countRows(env, "sessions")).toBe(1);
  });

  it("rejects an expired state and consumes it", async () => {
    const env = createTestEnv();
    const { state, nonce, stateCookie } = await startLogin(env);
    await new Db(env.DB).run("UPDATE oauth_states SET expires_at = ? WHERE state = ?", new Date(Date.now() - 1000).toISOString(), state);
    setOidcDeps({ fetch: tokenEndpoint(() => makeIdToken({ nonce })) });
    const res = await callback(env, state, stateCookie);
    expect(authError(res)).toBe("expired_state");
    expect(await countRows(env, "oauth_states")).toBe(0);
    expect(await countRows(env, "sessions")).toBe(0);
  });

  it("rejects an unknown state and a state not bound to this browser", async () => {
    const env = createTestEnv();
    expect(authError(await callback(env, "not-a-real-state", "okara_login_state=not-a-real-state"))).toBe("invalid_state");
    const { state, nonce } = await startLogin(env);
    setOidcDeps({ fetch: tokenEndpoint(() => makeIdToken({ nonce })) });
    expect(authError(await callback(env, state, ""))).toBe("state_mismatch");
    expect(await countRows(env, "sessions")).toBe(0);
  });

  it("rejects a callback reporting access_denied", async () => {
    const env = createTestEnv();
    const { state, stateCookie } = await startLogin(env);
    expect(authError(await callback(env, state, stateCookie, "error=access_denied"))).toBe("access_denied");
  });

  const badTokens: Array<[string, (nonce: string) => TokenOpts, string]> = [
    ["nonce mismatch", () => ({ nonce: "some-other-nonce" }), "nonce_mismatch"],
    ["wrong audience", (nonce) => ({ nonce, aud: "someone-else.apps.googleusercontent.com" }), "invalid_id_token"],
    ["wrong issuer", (nonce) => ({ nonce, iss: "https://evil.example.com" }), "invalid_id_token"],
    ["expired token", (nonce) => ({ nonce, expSecondsFromNow: -600 }), "invalid_id_token"],
    ["bad signature", (nonce) => ({ nonce, key: otherPrivateKey }), "invalid_id_token"],
    ["unverified email", (nonce) => ({ nonce, emailVerified: false }), "email_unverified"],
  ];
  for (const [name, opts, code] of badTokens) {
    it(`rejects an ID token with ${name}`, async () => {
      const env = createTestEnv();
      const { state, nonce, stateCookie } = await startLogin(env);
      setOidcDeps({ fetch: tokenEndpoint(() => makeIdToken(opts(nonce))) });
      const res = await callback(env, state, stateCookie);
      expect(authError(res)).toBe(code);
      expect(cookieValue(res, "okara_session")).toBeNull();
      expect(await countRows(env, "users")).toBe(0);
      expect(await countRows(env, "sessions")).toBe(0);
    });
  }

  it("accepts the bare accounts.google.com issuer", async () => {
    const env = createTestEnv();
    const { state, nonce, stateCookie } = await startLogin(env);
    setOidcDeps({ fetch: tokenEndpoint(() => makeIdToken({ nonce, iss: "accounts.google.com" })) });
    expect(cookieValue(await callback(env, state, stateCookie), "okara_session")).toBeTruthy();
  });

  it("maps a token endpoint failure to a login error without creating a session", async () => {
    const env = createTestEnv();
    const { state, stateCookie } = await startLogin(env);
    setOidcDeps({ fetch: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) });
    expect(authError(await callback(env, state, stateCookie))).toBe("token_exchange_failed");
    expect(await countRows(env, "sessions")).toBe(0);
  });

  it("rotates the session: the session in the incoming cookie is deleted on login", async () => {
    const env = createTestEnv();
    const old = await seedUser(env);
    const { state, nonce } = await startLogin(env);
    setOidcDeps({ fetch: tokenEndpoint(() => makeIdToken({ nonce })) });
    const res = await callback(env, state, `okara_login_state=${state}; okara_session=${old.sessionToken}`);
    const token = cookieValue(res, "okara_session")!;
    expect(token).not.toBe(old.sessionToken);
    const db = new Db(env.DB);
    expect(await db.first("SELECT id FROM sessions WHERE id = ?", old.sessionId)).toBeNull();
    const fresh = await db.first<{ rotated_from: string }>("SELECT rotated_from FROM sessions WHERE id = ?", await sha256Hex(token));
    expect(fresh!.rotated_from).toBe(old.sessionId);
  });
});

describe("platform-auth: sessions, logout, /me", () => {
  it("rejects requests without a session", async () => {
    const env = createTestEnv();
    expect((await app.request("/api/me", {}, env)).status).toBe(401);
    expect((await app.request("/api/me", { headers: { Cookie: "okara_session=garbage" } }, env)).status).toBe(401);
  });

  it("ignores the production cookie name in the test environment and vice versa", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    expect((await app.request("/api/me", { headers: { Cookie: `__Host-okara_session=${u.sessionToken}` } }, env)).status).toBe(401);
    const prod = createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: "https://app.example.com", DB: env.DB });
    expect((await app.request("https://app.example.com/api/me", { headers: { Cookie: `__Host-okara_session=${u.sessionToken}` } }, prod)).status).toBe(200);
    expect((await app.request("https://app.example.com/api/me", { headers: { Cookie: `okara_session=${u.sessionToken}` } }, prod)).status).toBe(401);
  });

  it("rejects an expired session and deletes it", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    await u.db.run("UPDATE sessions SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), u.sessionId);
    const res = await app.request("/api/me", { headers: { Cookie: `okara_session=${u.sessionToken}` } }, env);
    expect(res.status).toBe(401);
    expect(await u.db.first("SELECT id FROM sessions WHERE id = ?", u.sessionId)).toBeNull();
  });

  it("rejects an idle session", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    await u.db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", new Date(Date.now() - 4 * 86400_000).toISOString(), u.sessionId);
    expect((await app.request("/api/me", { headers: { Cookie: `okara_session=${u.sessionToken}` } }, env)).status).toBe(401);
  });

  it("returns Me with demoModeAvailable only outside production", async () => {
    const env = createTestEnv({ DEMO_MODE: "true" });
    const u = await seedUser(env);
    const me = (await (await app.request("/api/me", { headers: { Cookie: `okara_session=${u.sessionToken}` } }, env)).json()) as { data: { demoModeAvailable: boolean; csrfToken: string } };
    expect(me.data.demoModeAvailable).toBe(true);
    expect(me.data.csrfToken).toBe(u.csrfToken);
    const prod = createTestEnv({ DEMO_MODE: "true", ENVIRONMENT: "production", APP_ORIGIN: "https://app.example.com", DB: env.DB });
    const pme = (await (await app.request("https://app.example.com/api/me", { headers: { Cookie: `__Host-okara_session=${u.sessionToken}` } }, prod)).json()) as { data: { demoModeAvailable: boolean } };
    expect(pme.data.demoModeAvailable).toBe(false);
  });

  it("logout deletes the session and clears the cookie", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const res = await app.request("/api/auth/logout", { method: "POST", headers: authHeaders(u.sessionToken, u.csrfToken) }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    const cleared = setCookies(res).find((c) => c.startsWith("okara_session="))!;
    expect(cleared).toMatch(/^okara_session=;/);
    expect(cleared).toMatch(/Max-Age=0/);
    expect(await u.db.first("SELECT id FROM sessions WHERE id = ?", u.sessionId)).toBeNull();
    expect((await app.request("/api/me", { headers: { Cookie: `okara_session=${u.sessionToken}` } }, env)).status).toBe(401);
  });
});

describe("platform-auth: CSRF and origin checks", () => {
  async function logout(env: Env, headers: Record<string, string>) {
    return app.request("/api/auth/logout", { method: "POST", headers }, env);
  }

  it("rejects state-changing requests without an Origin header", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const { Origin: _o, ...noOrigin } = authHeaders(u.sessionToken, u.csrfToken);
    const res = await logout(env, noOrigin);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("csrf_failed");
    expect(await u.db.first("SELECT id FROM sessions WHERE id = ?", u.sessionId)).not.toBeNull();
  });

  it("rejects a mismatched Origin", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    for (const origin of ["https://evil.example.com", "http://localhost:5174", "null", "http://localhost:5173.evil.com"]) {
      expect((await logout(env, authHeaders(u.sessionToken, u.csrfToken, origin))).status).toBe(403);
    }
  });

  it("rejects an authenticated request with a missing or wrong CSRF token", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const { "X-CSRF-Token": _t, ...noToken } = authHeaders(u.sessionToken, u.csrfToken);
    expect((await logout(env, noToken)).status).toBe(403);
    expect((await logout(env, authHeaders(u.sessionToken, "wrong-token"))).status).toBe(403);
    const other = await seedUser(env);
    expect((await logout(env, authHeaders(u.sessionToken, other.csrfToken))).status).toBe(403);
    expect(await u.db.first("SELECT id FROM sessions WHERE id = ?", u.sessionId)).not.toBeNull();
  });

  it("allows a valid same-origin request with the session's CSRF token", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    expect((await logout(env, authHeaders(u.sessionToken, u.csrfToken))).status).toBe(200);
  });

  it("does not apply to safe methods", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    expect((await app.request("/api/me", { headers: { Cookie: `okara_session=${u.sessionToken}` } }, env)).status).toBe(200);
    expect((await app.request("/api/health", { method: "HEAD" }, env)).status).not.toBe(403);
  });

  it("compares tokens in constant time helper correctly", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});

describe("platform-auth: dev-login bypass", () => {
  const post = (env: Env, url = "http://localhost/api/auth/dev-login", origin = ORIGIN) =>
    app.request(url, { method: "POST", headers: { Origin: origin } }, env);

  it("is 404 in the test environment even when the flag is set", async () => {
    const env = createTestEnv({ DEV_AUTH_BYPASS: "true" });
    expect((await post(env)).status).toBe(404);
    expect(await countRows(env, "sessions")).toBe(0);
  });

  it("is impossible in production, even on localhost with the flag set", async () => {
    for (const appOrigin of ["https://app.example.com", ORIGIN]) {
      const env = createTestEnv({ ENVIRONMENT: "production", DEV_AUTH_BYPASS: "true", APP_ORIGIN: appOrigin });
      expect((await post(env, "http://localhost/api/auth/dev-login", appOrigin)).status).toBe(404);
      expect((await post(env, "http://127.0.0.1/api/auth/dev-login", appOrigin)).status).toBe(404);
      expect(await countRows(env, "users")).toBe(0);
      expect(await countRows(env, "sessions")).toBe(0);
    }
    const staging = createTestEnv({ ENVIRONMENT: "staging", DEV_AUTH_BYPASS: "true" });
    expect((await post(staging)).status).toBe(404);
  });

  it("is 404 in development unless explicitly enabled, and only on localhost", async () => {
    expect((await post(createTestEnv({ ENVIRONMENT: "development" }))).status).toBe(404);
    expect((await post(createTestEnv({ ENVIRONMENT: "development", DEV_AUTH_BYPASS: "1" }))).status).toBe(404);
    const env = createTestEnv({ ENVIRONMENT: "development", DEV_AUTH_BYPASS: "true" });
    expect((await post(env, "http://app.example.com/api/auth/dev-login")).status).toBe(404);
    expect((await post(env, "http://localhost.evil.com/api/auth/dev-login")).status).toBe(404);
  });

  it("creates a local demo user, workspace, and non-Secure dev session when allowed", async () => {
    const env = createTestEnv({ ENVIRONMENT: "development", DEV_AUTH_BYPASS: "true" });
    const res = await post(env);
    expect(res.status).toBe(200);
    const cookie = setCookies(res).find((c) => c.startsWith("okara_session="))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/Secure/i);
    const token = cookieValue(res, "okara_session")!;
    const me = (await (await app.request("http://localhost/api/me", { headers: { Cookie: `okara_session=${token}` } }, env)).json()) as { data: { workspaces: unknown[] } };
    expect(me.data.workspaces).toHaveLength(1);
    // Cross-origin POST is still refused by the CSRF layer.
    expect((await post(env, "http://localhost/api/auth/dev-login", "https://evil.example.com")).status).toBe(403);
  });
});

describe("platform-auth: security headers and rate limits", () => {
  it("sets security headers and no-store on API responses", async () => {
    const env = createTestEnv();
    const res = await app.request("/api/health", {}, env);
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Strict-Transport-Security")).toMatch(/max-age=\d+/);
    // Also on errors and redirects.
    expect((await app.request("/api/nope", {}, env)).headers.get("X-Frame-Options")).toBe("DENY");
    expect((await app.request("/api/auth/login", {}, env)).headers.get("Cache-Control")).toBe("no-store");
  });

  it("omits HSTS in development", async () => {
    const res = await app.request("/api/health", {}, createTestEnv({ ENVIRONMENT: "development" }));
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("counts atomically per fixed window", async () => {
    const env = createTestEnv();
    const db = new Db(env.DB);
    const t0 = new Date("2026-09-30T12:00:10Z");
    const results = await Promise.all(Array.from({ length: 5 }, () => hitRateLimit(db, "k", 3, 60, t0)));
    expect(results.map((r) => r.count).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(results.filter((r) => !r.allowed)).toHaveLength(2);
    const next = await hitRateLimit(db, "k", 3, 60, new Date("2026-09-30T12:01:05Z"));
    expect(next).toMatchObject({ allowed: true, count: 1 });
    // Old window pruned when the new one opened.
    expect(await countRows(env, "rate_limits")).toBe(1);
  });

  it("rate-limits the login route", async () => {
    const env = createTestEnv();
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) last = await app.request("/api/auth/login", { headers: { "CF-Connecting-IP": "203.0.113.9" } }, env);
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Retry-After")).toMatch(/^\d+$/);
    // A different client is unaffected.
    expect((await app.request("/api/auth/login", { headers: { "CF-Connecting-IP": "203.0.113.10" } }, env)).status).toBe(302);
  });
});
