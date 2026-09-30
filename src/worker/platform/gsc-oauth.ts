/**
 * Google Search Console OAuth (separate from login consent). Minimum scope webmasters.readonly, offline
 * access, PKCE (S256), single-use state bound to the initiating session, user, workspace, and project.
 * Refresh tokens are stored only as AES-GCM envelopes (lib/crypto) and are never returned to the browser.
 * Disconnect deletes only the local token; it never calls Google's /revoke (that would end the grant for
 * every project connected with the same Google account).
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { encryptSecret, encryptionConfigured } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import { base64Url, newId, randomToken } from "../lib/ids";
import { addSeconds, iso } from "../lib/time";
import type { ProjectRow as ProjectRowLite, SessionUser } from "./access";
import { requireProject } from "./access";
import { appRedirectUri } from "./security";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GSC_STATE_TTL_SECONDS = 10 * 60;
/** Timeout for calls to Google's token endpoint (exchange and refresh). */
export const GOOGLE_TOKEN_TIMEOUT_MS = 10_000;

export const gscTokenAad = (projectId: string) => `oauth_connections:${projectId}:google_gsc`;
/** Built from the same appOrigin() helper as the login redirect URI; null when APP_ORIGIN is not usable. */
export const gscRedirectUri = (env: Env): string | null => appRedirectUri(env, "/api/gsc/callback");
export const integrationsPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/integrations`;

export function gscOAuthConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && encryptionConfigured(env) && gscRedirectUri(env));
}

export interface OAuthConnectionRow {
  id: string;
  workspace_id: string;
  project_id: string;
  user_id: string;
  provider: string;
  scopes: string;
  refresh_token_enc: string | null;
  status: "connected" | "revoked" | "error";
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export async function loadGscConnection(db: Db, workspaceId: string, projectId: string): Promise<OAuthConnectionRow | null> {
  return db.first<OAuthConnectionRow>(
    "SELECT * FROM oauth_connections WHERE workspace_id = ? AND project_id = ? AND provider = 'google_gsc'",
    workspaceId,
    projectId,
  );
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Create a single-use state row and return the Google consent URL. */
export async function startGscConnect(
  env: Env,
  db: Db,
  args: { user: SessionUser; sessionId: string; workspaceId: string; projectId: string; now: Date },
): Promise<string> {
  if (!gscOAuthConfigured(env)) {
    throw new HttpError(412, "setup_required", "Google OAuth client, token encryption key, or APP_ORIGIN is not configured.");
  }
  const state = randomToken(32);
  const verifier = randomToken(48);
  await db.run("DELETE FROM oauth_states WHERE expires_at < ?", iso(args.now));
  await db.insert("oauth_states", {
    state,
    purpose: "gsc",
    nonce: randomToken(16), // unused for a non-OIDC flow; column is NOT NULL
    code_verifier: verifier,
    session_id: args.sessionId,
    user_id: args.user.id,
    workspace_id: args.workspaceId,
    project_id: args.projectId,
    return_to: integrationsPath(args.projectId),
    created_at: iso(args.now),
    expires_at: iso(addSeconds(args.now, GSC_STATE_TTL_SECONDS)),
  });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: gscRedirectUri(env)!,
    response_type: "code",
    scope: GSC_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

interface StateRow {
  state: string;
  purpose: string;
  code_verifier: string;
  session_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  project_id: string | null;
  expires_at: string;
}

export interface CallbackResult {
  /** Relative SPA path to redirect to. */
  redirectTo: string;
  ok: boolean;
  reason?: string;
}

/**
 * Handle Google's redirect. The state row is consumed (deleted) before any other check so it can never be
 * replayed. The callback must arrive in the same session, for the same user, that started the flow.
 * Failures never throw: they redirect to the integrations page with `?gscError=<code>`.
 */
export async function handleGscCallback(
  env: Env,
  db: Db,
  args: { query: URLSearchParams; user: SessionUser | null; sessionId: string | null; now: Date; fetchImpl: typeof fetch },
): Promise<CallbackResult> {
  const fail = (projectId: string | null, reason: string): CallbackResult => ({
    redirectTo: projectId ? `${integrationsPath(projectId)}?gscError=${reason}` : `/?gscError=${reason}`,
    ok: false,
    reason,
  });
  const stateParam = args.query.get("state");
  if (!stateParam || stateParam.length > 200) return fail(null, "invalid_state");
  const row = await db.first<StateRow>("DELETE FROM oauth_states WHERE state = ? AND purpose = 'gsc' RETURNING *", stateParam);
  if (!row || !row.project_id || !row.workspace_id) return fail(null, "invalid_state");
  if (new Date(row.expires_at) <= args.now) return fail(row.project_id, "invalid_state");
  if (!args.user || !args.sessionId || row.session_id !== args.sessionId || row.user_id !== args.user.id) {
    return fail(row.project_id, "session_mismatch");
  }
  let project: ProjectRowLite;
  try {
    project = await requireProject(db, args.user.id, row.project_id);
  } catch {
    return fail(null, "invalid_state");
  }
  if (project.workspace_id !== row.workspace_id) return fail(project.id, "session_mismatch");
  const back = (reason?: string): CallbackResult =>
    reason ? fail(project.id, reason) : { redirectTo: `${integrationsPath(project.id)}?gsc=connected`, ok: true };

  if (args.query.get("error")) return back(args.query.get("error")!.replace(/[^a-z_]/gi, "").slice(0, 40) || "access_denied");
  const code = args.query.get("code");
  if (!code || code.length > 2048) return back("missing_code");
  if (!gscOAuthConfigured(env)) return back("setup_required");

  let token: { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  try {
    const res = await args.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: gscRedirectUri(env)!,
        grant_type: "authorization_code",
        code_verifier: row.code_verifier,
      }).toString(),
      signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
    });
    token = (await res.json().catch(() => ({}))) as typeof token;
    if (!res.ok || !token.access_token) return back("token_exchange_failed");
  } catch {
    return back("token_exchange_failed");
  }
  if (token.scope !== undefined && !token.scope.split(/\s+/).includes(GSC_SCOPE)) return back("insufficient_scope");

  const now = iso(args.now);
  const existing = await loadGscConnection(db, project.workspace_id, project.id);
  let refreshEnc: string | null = existing?.refresh_token_enc ?? null;
  if (token.refresh_token) {
    refreshEnc = await encryptSecret(env, token.refresh_token, gscTokenAad(project.id));
  }
  // Reconnect responses may omit refresh_token: keep the stored one.
  const status = refreshEnc ? "connected" : "error";
  const lastError = refreshEnc ? null : "Google did not return a refresh token. Disconnect and connect again.";
  if (existing) {
    await db.run(
      `UPDATE oauth_connections SET user_id = ?, scopes = ?, refresh_token_enc = ?, status = ?, last_error = ?, updated_at = ?
        WHERE workspace_id = ? AND project_id = ? AND provider = 'google_gsc'`,
      args.user.id, GSC_SCOPE, refreshEnc, status, lastError, now, project.workspace_id, project.id,
    );
  } else {
    await db.insert("oauth_connections", {
      id: newId("oac"),
      workspace_id: project.workspace_id,
      project_id: project.id,
      user_id: args.user.id,
      provider: "google_gsc",
      scopes: GSC_SCOPE,
      refresh_token_enc: refreshEnc,
      status,
      last_error: lastError,
      created_at: now,
      updated_at: now,
    });
  }
  return refreshEnc ? back() : back("no_refresh_token");
}

/**
 * Local-only: returns false and makes no network call. Google's /revoke ends the whole grant for the
 * Google account + OAuth client, i.e. every project (in any workspace) connected with that account, so a
 * per-project disconnect or project delete must never call it. Users revoke the grant themselves at
 * myaccount.google.com (which affects every project connected with that Google account).
 * @deprecated Kept so existing callers compile; delete callers and use disconnectGsc/deleting the row.
 */
export async function revokeGscToken(_env: Env, _db: Db, _workspaceId: string, _projectId: string, _fetchImpl: typeof fetch): Promise<boolean> {
  return false;
}

/**
 * Delete this project's stored (encrypted) token and clear the selected property. Deliberately does not
 * revoke at Google (see revokeGscToken): other projects may share the same grant. `revoked` is always false.
 */
export async function disconnectGsc(_env: Env, db: Db, workspaceId: string, projectId: string, _fetchImpl: typeof fetch, now: Date): Promise<{ revoked: boolean }> {
  await db.batch([
    ["DELETE FROM oauth_connections WHERE workspace_id = ? AND project_id = ? AND provider = 'google_gsc'", workspaceId, projectId],
    ["UPDATE projects SET gsc_property = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?", iso(now), workspaceId, projectId],
  ]);
  return { revoked: false };
}
