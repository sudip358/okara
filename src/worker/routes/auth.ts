/**
 * Authentication routes. OWNED BY: platform-auth module.
 *   GET  /auth/login?returnTo=   -> 302 to Google (state, nonce, PKCE S256; scope "openid email profile")
 *   GET  /auth/callback          -> validates state (single-use, unexpired, browser-bound), verifies the
 *                                   ID token, upserts the user (+ workspace on first login), rotates the session
 *   POST /auth/logout            -> deletes the session, clears the cookie
 *   GET  /me                     -> Me
 *   POST /auth/dev-login         -> local-only bypass (DEV_AUTH_BYPASS=true AND ENVIRONMENT=development AND localhost)
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import type { Me } from "@shared/types";
import type { Db } from "../lib/db";
import { setupRequired, unauthorized } from "../lib/errors";
import { sha256Hex } from "../lib/hash";
import { newId, randomToken } from "../lib/ids";
import { addSeconds, iso } from "../lib/time";
import { createSession, deleteSession } from "../platform/session";
import {
  appOrigin,
  clearOauthStateCookie,
  clearSessionCookie,
  readOauthStateCookie,
  readSessionCookie,
  setOauthStateCookie,
  setSessionCookie,
  timingSafeEqualStr,
} from "../platform/security";
import {
  buildAuthorizationUrl,
  exchangeCode,
  OidcError,
  pkceChallenge,
  safeReturnTo,
  verifyIdToken,
  type GoogleIdentity,
} from "../platform/oidc";
import { rateLimit } from "../platform/rate-limit";

export const LOGIN_STATE_TTL_SECONDS = 10 * 60;

export const authRoutes = new Hono<AppEnv>();

interface OauthStateRow {
  state: string;
  purpose: string;
  nonce: string;
  code_verifier: string;
  return_to: string | null;
  expires_at: string;
}

function googleConfig(env: Env) {
  const origin = appOrigin(env);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !origin) {
    throw setupRequired("Google sign-in is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and APP_ORIGIN.");
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    origin,
    redirectUri: `${origin}/api/auth/callback`,
  };
}

/** Find or create the user for a verified identity; first login creates a workspace + owner membership. */
export async function upsertUser(db: Db, identity: GoogleIdentity, now: Date): Promise<string> {
  const ts = iso(now);
  const existing = await db.first<{ id: string }>("SELECT id FROM users WHERE google_sub = ?", identity.sub);
  let userId: string;
  if (existing) {
    userId = existing.id;
    await db.run("UPDATE users SET email = ?, name = ?, last_login_at = ? WHERE id = ?", identity.email, identity.name, ts, userId);
  } else {
    userId = newId("usr");
    try {
      await db.run(
        "INSERT INTO users (id, google_sub, email, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)",
        userId, identity.sub, identity.email, identity.name, ts, ts,
      );
    } catch {
      // Concurrent first login for the same subject: use the row that won.
      const again = await db.first<{ id: string }>("SELECT id FROM users WHERE google_sub = ?", identity.sub);
      if (!again) throw new Error("user upsert failed");
      userId = again.id;
    }
  }
  const membership = await db.first("SELECT 1 AS x FROM memberships WHERE user_id = ? LIMIT 1", userId);
  if (!membership) {
    const workspaceId = newId("ws");
    const name = identity.name ? `${identity.name.slice(0, 80)}'s workspace` : "My workspace";
    await db.batch([
      ["INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)", workspaceId, name, ts],
      ["INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", workspaceId, userId, ts],
    ]);
  }
  return userId;
}

/** Create a fresh session, deleting whatever session the incoming cookie referred to (rotation). */
async function startSession(c: Context<AppEnv>, userId: string) {
  const db = c.get("db");
  const incoming = readSessionCookie(c);
  let rotatedFrom: string | null = null;
  if (incoming && incoming.length <= 200) {
    rotatedFrom = await sha256Hex(incoming);
    await deleteSession(db, rotatedFrom);
  }
  const s = await createSession(db, userId, c.get("now"), c.req.header("User-Agent") ?? null, rotatedFrom);
  setSessionCookie(c, s.token);
  return s;
}

authRoutes.get("/auth/login", rateLimit({ key: "auth_login", limit: 30, windowSeconds: 60 }), async (c) => {
  const cfg = googleConfig(c.env);
  const db = c.get("db");
  const now = c.get("now");
  await db.run("DELETE FROM oauth_states WHERE purpose = 'login' AND expires_at < ?", iso(now));

  const state = randomToken(32);
  const nonce = randomToken(32);
  const codeVerifier = randomToken(48); // 64 base64url chars (RFC 7636: 43-128)
  const returnTo = safeReturnTo(c.req.query("returnTo"), cfg.origin);
  await db.insert("oauth_states", {
    state,
    purpose: "login",
    nonce,
    code_verifier: codeVerifier,
    return_to: returnTo,
    created_at: iso(now),
    expires_at: iso(addSeconds(now, LOGIN_STATE_TTL_SECONDS)),
  });
  setOauthStateCookie(c, state, LOGIN_STATE_TTL_SECONDS);
  const url = buildAuthorizationUrl({
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    state,
    nonce,
    codeChallenge: await pkceChallenge(codeVerifier),
  });
  return c.redirect(url, 302);
});

authRoutes.get("/auth/callback", rateLimit({ key: "auth_callback", limit: 30, windowSeconds: 60 }), async (c) => {
  const cfg = googleConfig(c.env);
  const db = c.get("db");
  const now = c.get("now");
  const fail = (code: string) => {
    clearOauthStateCookie(c);
    return c.redirect(`${cfg.origin}/?authError=${encodeURIComponent(code)}`, 302);
  };

  const state = c.req.query("state");
  if (!state || state.length > 200) return fail("invalid_state");
  // Single use: the row is consumed whether or not the rest of the callback succeeds.
  const row = await db.first<OauthStateRow>("DELETE FROM oauth_states WHERE state = ? AND purpose = 'login' RETURNING *", state);
  if (!row) return fail("invalid_state");
  if (new Date(row.expires_at) <= now) return fail("expired_state");
  const bound = readOauthStateCookie(c);
  if (!bound || !timingSafeEqualStr(bound, state)) return fail("state_mismatch");
  if (c.req.query("error")) return fail("access_denied");
  const code = c.req.query("code");
  if (!code || code.length > 2048) return fail("invalid_request");

  let identity: GoogleIdentity;
  try {
    const idToken = await exchangeCode({
      code,
      codeVerifier: row.code_verifier,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: cfg.redirectUri,
    });
    identity = await verifyIdToken(idToken, { clientId: cfg.clientId, nonce: row.nonce, now });
  } catch (err) {
    if (err instanceof OidcError) return fail(err.code);
    throw err;
  }

  const userId = await upsertUser(db, identity, now);
  await startSession(c, userId);
  clearOauthStateCookie(c);
  return c.redirect(`${cfg.origin}${safeReturnTo(row.return_to, cfg.origin)}`, 302);
});

authRoutes.post("/auth/logout", async (c) => {
  const session = c.get("session");
  if (session) await deleteSession(c.get("db"), session.id);
  clearSessionCookie(c);
  return c.json({ data: { ok: true } });
});

authRoutes.get("/me", async (c) => {
  const user = c.get("user");
  const session = c.get("session");
  if (!user || !session) throw unauthorized();
  const workspaces = await c.get("db").all<{ id: string; name: string; role: "owner" | "member" }>(
    `SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ? ORDER BY w.created_at, w.id`,
    user.id,
  );
  const me: Me = {
    user: { id: user.id, email: user.email, name: user.name },
    workspaces,
    csrfToken: session.csrf_token,
    demoModeAvailable: c.env.DEMO_MODE === "true" && c.env.ENVIRONMENT !== "production",
    environment: c.env.ENVIRONMENT,
  };
  return c.json({ data: me });
});

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The dev bypass exists only for local development with explicit opt-in. Never in production. */
export function devLoginAllowed(env: Env, requestUrl: string): boolean {
  if (env.ENVIRONMENT !== "development" || env.DEV_AUTH_BYPASS !== "true") return false;
  try {
    return LOCAL_HOSTS.has(new URL(requestUrl).hostname) && LOCAL_HOSTS.has(new URL(env.APP_ORIGIN).hostname);
  } catch {
    return false;
  }
}

const devLoginGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!devLoginAllowed(c.env, c.req.url)) {
    return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
  }
  await next();
};

export const DEV_USER: GoogleIdentity = { sub: "dev-bypass:local-demo", email: "demo@localhost.invalid", name: "Local demo user" };

authRoutes.post("/auth/dev-login", devLoginGate, rateLimit({ key: "auth_dev_login", limit: 20, windowSeconds: 60 }), async (c) => {
  const userId = await upsertUser(c.get("db"), DEV_USER, c.get("now"));
  await startSession(c, userId);
  return c.json({ data: { ok: true } });
});
