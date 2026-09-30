/**
 * Google OpenID Connect (authorization code flow + PKCE S256). OWNED BY: platform-auth module.
 * Endpoints are the values published in Google's discovery document
 * (https://accounts.google.com/.well-known/openid-configuration), documented at
 * https://developers.google.com/identity/openid-connect/openid-connect.
 *
 * ID tokens are verified with `jose` against Google's JWKS: signature (RS256), issuer, audience,
 * expiry, nonce, and email_verified. The token-endpoint fetch and the JWKS are injectable so tests
 * never touch the network (see setOidcDeps).
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { base64Url } from "../lib/ids";

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const LOGIN_SCOPE = "openid email profile";

export interface OidcDeps {
  fetch: typeof fetch;
  jwks: JWTVerifyGetKey;
}

let remoteJwks: JWTVerifyGetKey | null = null;
const defaultDeps = (): OidcDeps => ({
  fetch: (input, init) => fetch(input, init),
  jwks: (remoteJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URI))),
});

let overrides: Partial<OidcDeps> = {};

/** Test hook: replace the token-exchange fetch and/or the JWKS key resolver. */
export function setOidcDeps(deps: Partial<OidcDeps>) {
  overrides = { ...overrides, ...deps };
}
export function resetOidcDeps() {
  overrides = {};
}
function deps(): OidcDeps {
  return { ...defaultDeps(), ...overrides };
}

export class OidcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function buildAuthorizationUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: LOGIN_SCOPE,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Exchange an authorization code for tokens; returns the raw id_token. */
export async function exchangeCode(p: {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<string> {
  let res: Response;
  try {
    res = await deps().fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: p.code,
        code_verifier: p.codeVerifier,
        client_id: p.clientId,
        client_secret: p.clientSecret,
        redirect_uri: p.redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OidcError("token_exchange_failed", "Could not reach Google's token endpoint.");
  }
  if (!res.ok) throw new OidcError("token_exchange_failed", `Token endpoint returned HTTP ${res.status}.`);
  const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!body || typeof body.id_token !== "string") throw new OidcError("token_exchange_failed", "Token response had no id_token.");
  return body.id_token;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

/** Verify a Google ID token: signature, iss, aud, exp/iat, nonce, email_verified. */
export async function verifyIdToken(idToken: string, p: { clientId: string; nonce: string; now: Date }): Promise<GoogleIdentity> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, deps().jwks, {
      issuer: GOOGLE_ISSUERS,
      audience: p.clientId,
      algorithms: ["RS256"],
      currentDate: p.now,
      clockTolerance: 60,
      requiredClaims: ["sub", "exp", "iat"],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    throw new OidcError("invalid_id_token", "ID token failed verification.");
  }
  if (typeof payload.nonce !== "string" || payload.nonce !== p.nonce) {
    throw new OidcError("nonce_mismatch", "ID token nonce did not match.");
  }
  if (payload.email_verified !== true && payload.email_verified !== "true") {
    throw new OidcError("email_unverified", "Google account email is not verified.");
  }
  if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string" || !payload.email) {
    throw new OidcError("invalid_id_token", "ID token is missing identity claims.");
  }
  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 200) : null;
  return { sub: payload.sub, email: payload.email.slice(0, 320), name };
}

/**
 * Accept only same-origin relative paths ("/projects/x?tab=1"). Anything else (absolute URLs,
 * protocol-relative "//evil", backslashes, control characters) falls back to "/".
 */
export function safeReturnTo(value: string | null | undefined, appOrigin: string): string {
  if (!value || value.length > 512) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const base = new URL(appOrigin);
    const url = new URL(value, base);
    if (url.origin !== base.origin) return "/";
    if (url.pathname.startsWith("/api/")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
