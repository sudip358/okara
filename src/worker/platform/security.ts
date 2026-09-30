/**
 * Security middleware. OWNED BY: platform-auth module.
 * - securityHeaders: CSP, HSTS, frame-ancestors, nosniff, referrer policy, no-store on /api
 * - loadSession: resolve session cookie -> c.var.user/session
 * - csrfProtection: Origin check + X-CSRF-Token for state-changing requests
 * Also exports the session cookie helpers used by routes/auth.ts.
 */
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import { lookupSession, SESSION_COOKIE, SESSION_COOKIE_DEV, SESSION_TTL_SECONDS } from "./session";

/**
 * Content-Security-Policy for the same-origin React SPA: no inline or remote scripts, API calls to
 * self only, no framing, no plugins. Vite emits hashed external JS/CSS files, so 'self' suffices.
 * The login redirect to Google is a top-level navigation (not a form post), so form-action stays 'self'.
 */
export const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const isLocalDevEnv = (env: Env) => env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test";

/** `__Host-okara_session` everywhere except development/test (plain-http localhost). */
export const sessionCookieName = (env: Env) => (isLocalDevEnv(env) ? SESSION_COOKIE_DEV : SESSION_COOKIE);
export const oauthStateCookieName = (env: Env) => (isLocalDevEnv(env) ? "okara_login_state" : "__Host-okara_login_state");

const secureCookies = (env: Env) => env.ENVIRONMENT !== "development";

export function setSessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, sessionCookieName(c.env), token, {
    httpOnly: true,
    secure: secureCookies(c.env),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context<AppEnv>) {
  deleteCookie(c, sessionCookieName(c.env), { path: "/", secure: secureCookies(c.env), httpOnly: true, sameSite: "Lax" });
}

export function readSessionCookie(c: Context<AppEnv>): string | undefined {
  return getCookie(c, sessionCookieName(c.env));
}

/** Short-lived cookie binding an OAuth login `state` to the browser that started the flow. */
export function setOauthStateCookie(c: Context<AppEnv>, state: string, maxAgeSeconds: number) {
  setCookie(c, oauthStateCookieName(c.env), state, {
    httpOnly: true,
    secure: secureCookies(c.env),
    sameSite: "Lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export function readOauthStateCookie(c: Context<AppEnv>): string | undefined {
  return getCookie(c, oauthStateCookieName(c.env));
}

export function clearOauthStateCookie(c: Context<AppEnv>) {
  deleteCookie(c, oauthStateCookieName(c.env), { path: "/", secure: secureCookies(c.env), httpOnly: true, sameSite: "Lax" });
}

/** Constant-time string comparison (length is not secret). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ea.byteLength; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

/**
 * Canonical app origin, or null (setup_required) when APP_ORIGIN is missing, unparseable, still the
 * wrangler.jsonc placeholder, or not https outside development/test.
 */
export function appOrigin(env: Env): string | null {
  const raw = (env.APP_ORIGIN ?? "").trim();
  if (!raw || /REPLACE_WITH/i.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && !(isLocalDevEnv(env) && u.protocol === "http:")) return null;
  return u.origin;
}

/**
 * OAuth redirect URI for an app path (e.g. "/api/auth/callback", "/api/gsc/callback"). Login and Search
 * Console both build theirs here so the registered URIs always match; null when APP_ORIGIN is not usable.
 */
export function appRedirectUri(env: Env, path: `/${string}`): string | null {
  const origin = appOrigin(env);
  return origin ? `${origin}${path}` : null;
}

function applySecurityHeaders(h: Headers, env: Env, isApi: boolean) {
  h.set("Content-Security-Policy", SPA_CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Frame-Options", "DENY");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (env.ENVIRONMENT !== "development") {
    h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (isApi) h.set("Cache-Control", "no-store");
}

export const securityHeaders = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  const isApi = new URL(c.req.url).pathname.startsWith("/api");
  try {
    applySecurityHeaders(c.res.headers, c.env, isApi);
  } catch {
    // Immutable headers (e.g. a passed-through fetch Response): copy, then apply.
    c.res = new Response(c.res.body, c.res);
    applySecurityHeaders(c.res.headers, c.env, isApi);
  }
};

export const loadSession = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const token = readSessionCookie(c);
  if (token) {
    const found = await lookupSession(c.get("db"), token, c.get("now"));
    if (found) {
      c.set("user", found.user);
      c.set("session", found.session);
    }
  }
  await next();
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function csrfError(c: Context<AppEnv>, message: string) {
  return c.json({ error: { code: "csrf_failed", message } }, 403);
}

/**
 * State-changing requests (anything but GET/HEAD/OPTIONS; the OAuth callbacks are GETs) must carry an
 * Origin equal to APP_ORIGIN. Requests with a live session must also echo its CSRF token.
 */
export const csrfProtection = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) return next();

  const expected = appOrigin(c.env);
  if (!expected) return csrfError(c, "APP_ORIGIN is not configured (setup required); state-changing requests are refused.");
  const origin = c.req.header("Origin");
  if (!origin || origin !== expected) {
    return csrfError(c, "Cross-origin or origin-less request refused.");
  }

  const session = c.get("session");
  if (session) {
    const token = c.req.header("X-CSRF-Token");
    if (!token || !timingSafeEqualStr(token, session.csrf_token)) {
      return csrfError(c, "Missing or invalid CSRF token.");
    }
  }
  await next();
};
