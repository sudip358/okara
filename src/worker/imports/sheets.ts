/**
 * Google Sheets connection (separate, optional consent) and Sheets API v4 client for the Import feature.
 *
 * OAuth: a separate consent requesting only https://www.googleapis.com/auth/spreadsheets.readonly (a "sensitive"
 * scope), requested when the owner presses "Connect Google Sheets" (incremental authorization: never at sign-in,
 * never together with Search Console). Offline access, PKCE S256, single-use state bound to the initiating session,
 * user, workspace and project (oauth_states purpose 'sheets'). include_granted_scopes=false, so the stored token
 * holds only this scope. The refresh token is stored AES-GCM encrypted in its own oauth_connections row
 * (provider 'google_sheets'), never returned to the browser, and deleted locally on disconnect (Google's /revoke is
 * never called: it would end the grant for every project using the same Google account, like Search Console).
 * Redirect URI: the already registered /api/gsc/callback is reused; the callback dispatches on the state's purpose,
 * so no new redirect URI has to be added in Google Cloud Console.
 *
 * API (verified 2026-10-02 at developers.google.com/workspace/sheets/api/reference/rest, docs/provider-contracts.md):
 *   GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}?fields=...      -> Spreadsheet
 *   GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}  -> ValueRange
 *       {range, majorDimension, values: string[][]}; empty trailing rows and columns are omitted (ragged rows).
 * Calls go through the allowlisted API fetch (runs/runtime.ts createApiFetch); redirects are never followed and
 * response bodies are size-capped.
 */
import type { SheetTab, SheetTabsResult, SheetsConnectionStatus, SyncErrorCode } from "@shared/import";
import { MAX_IMPORT_COLUMNS } from "@shared/import";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import { base64Url, newId, randomToken } from "../lib/ids";
import { readCapped } from "../lib/read-capped";
import { addSeconds, iso } from "../lib/time";
import type { ProjectRow, SessionUser } from "../platform/access";
import { requireProject } from "../platform/access";
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_TOKEN_TIMEOUT_MS,
  GSC_STATE_TTL_SECONDS,
  gscOAuthConfigured,
  gscRedirectUri,
  type CallbackResult,
  type OAuthConnectionRow,
} from "../platform/gsc-oauth";
import { createApiFetch } from "../runs/runtime";

export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const SHEETS_API_BASE = "https://sheets.googleapis.com/v4";
export const SHEETS_PROVIDER = "google_sheets";
/** Per-request timeout for Sheets API calls. */
export const SHEETS_TIMEOUT_MS = 25_000;
/** Response body cap for one values.get (a 20,000-row tab of short cells fits comfortably). */
export const SHEETS_MAX_RESPONSE_BYTES = 24 * 1024 * 1024;

export const sheetsTokenAad = (projectId: string) => `oauth_connections:${projectId}:${SHEETS_PROVIDER}`;
export const importPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/import`;

export const SHEETS_NOTES = [
  "Read-only access to your Google Sheets (scope spreadsheets.readonly). Google classifies this scope as sensitive.",
  "While the Google OAuth app is in Testing mode, Google expires this authorization after 7 days: reconnect when a sync reports an expired token.",
  "The connection is stored for this project only and is separate from Search Console. Disconnect deletes the stored token here; revoke the grant itself at myaccount.google.com.",
];

// ------------------------------------------------------------------ test hook + allowlisted fetch
let fetchOverride: typeof fetch | null = null;
/** Test hook: the base fetch behind the allowlisted API fetch. */
export function setSheetsFetch(f: typeof fetch | null) {
  fetchOverride = f;
}
export const sheetsFetch = (env: Env): typeof fetch => createApiFetch(env, fetchOverride ?? ((input, init) => fetch(input, init)));

// ------------------------------------------------------------------ connection
export async function loadSheetsConnection(db: Db, workspaceId: string, projectId: string): Promise<OAuthConnectionRow | null> {
  return db.first<OAuthConnectionRow>(
    "SELECT * FROM oauth_connections WHERE workspace_id = ? AND project_id = ? AND provider = 'google_sheets'",
    workspaceId,
    projectId,
  );
}

export async function sheetsStatus(env: Env, db: Db, p: ProjectRow): Promise<SheetsConnectionStatus> {
  const base = { scope: SHEETS_SCOPE, notes: SHEETS_NOTES };
  if (p.is_demo === 1) return { ...base, state: "demo", connectedAt: null, lastError: null };
  const conn = await loadSheetsConnection(db, p.workspace_id, p.id);
  if (!conn || conn.status === "revoked") {
    return { ...base, state: gscOAuthConfigured(env) ? "setup_required" : "disabled", connectedAt: null, lastError: null };
  }
  return { ...base, state: conn.status === "connected" ? "ready" : "error", connectedAt: conn.created_at, lastError: conn.last_error };
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Create a single-use state row (purpose 'sheets') and return Google's consent URL for spreadsheets.readonly only. */
export async function startSheetsConnect(
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
    purpose: "sheets",
    nonce: randomToken(16),
    code_verifier: verifier,
    session_id: args.sessionId,
    user_id: args.user.id,
    workspace_id: args.workspaceId,
    project_id: args.projectId,
    return_to: importPath(args.projectId),
    created_at: iso(args.now),
    expires_at: iso(addSeconds(args.now, GSC_STATE_TTL_SECONDS)),
  });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: gscRedirectUri(env)!,
    response_type: "code",
    scope: SHEETS_SCOPE,
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

/** Purpose of a pending OAuth state ('gsc' | 'sheets' | ...), without consuming it; null when unknown. */
export async function oauthStatePurpose(db: Db, state: string | null): Promise<string | null> {
  if (!state || state.length > 200) return null;
  const row = await db.first<{ purpose: string }>("SELECT purpose FROM oauth_states WHERE state = ?", state);
  return row?.purpose ?? null;
}

/**
 * Google's redirect for the Sheets consent (arrives on /api/gsc/callback). Same rules as Search Console: the state
 * row is consumed first; same session and user; failures redirect to the Import page with ?sheetsError=<code>.
 */
export async function handleSheetsCallback(
  env: Env,
  db: Db,
  args: { query: URLSearchParams; user: SessionUser | null; sessionId: string | null; now: Date; fetchImpl?: typeof fetch },
): Promise<CallbackResult> {
  const fail = (projectId: string | null, reason: string): CallbackResult => ({
    redirectTo: projectId ? `${importPath(projectId)}?sheetsError=${reason}` : `/?sheetsError=${reason}`,
    ok: false,
    reason,
  });
  const stateParam = args.query.get("state");
  if (!stateParam || stateParam.length > 200) return fail(null, "invalid_state");
  const row = await db.first<StateRow>("DELETE FROM oauth_states WHERE state = ? AND purpose = 'sheets' RETURNING *", stateParam);
  if (!row || !row.project_id || !row.workspace_id) return fail(null, "invalid_state");
  if (new Date(row.expires_at) <= args.now) return fail(row.project_id, "invalid_state");
  if (!args.user || !args.sessionId || row.session_id !== args.sessionId || row.user_id !== args.user.id) {
    return fail(row.project_id, "session_mismatch");
  }
  let project: ProjectRow;
  try {
    project = await requireProject(db, args.user.id, row.project_id);
  } catch {
    return fail(null, "invalid_state");
  }
  if (project.workspace_id !== row.workspace_id) return fail(project.id, "session_mismatch");
  const back = (reason?: string): CallbackResult =>
    reason ? fail(project.id, reason) : { redirectTo: `${importPath(project.id)}?sheets=connected`, ok: true };

  if (args.query.get("error")) return back(args.query.get("error")!.replace(/[^a-z_]/gi, "").slice(0, 40) || "access_denied");
  const code = args.query.get("code");
  if (!code || code.length > 2048) return back("missing_code");
  if (!gscOAuthConfigured(env)) return back("setup_required");

  const fetchImpl = args.fetchImpl ?? sheetsFetch(env);
  let token: { access_token?: string; refresh_token?: string; scope?: string };
  try {
    const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
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
  // Google returns the granted scopes; the user can untick the Sheets scope on the consent screen.
  if (token.scope !== undefined && !token.scope.split(/\s+/).includes(SHEETS_SCOPE)) return back("insufficient_scope");

  const now = iso(args.now);
  const existing = await loadSheetsConnection(db, project.workspace_id, project.id);
  let refreshEnc: string | null = existing?.refresh_token_enc ?? null;
  if (token.refresh_token) refreshEnc = await encryptSecret(env, token.refresh_token, sheetsTokenAad(project.id));
  const status = refreshEnc ? "connected" : "error";
  const lastError = refreshEnc ? null : "Google did not return a refresh token. Disconnect and connect again.";
  if (existing) {
    await db.run(
      `UPDATE oauth_connections SET user_id = ?, scopes = ?, refresh_token_enc = ?, status = ?, last_error = ?, updated_at = ?
        WHERE workspace_id = ? AND project_id = ? AND provider = 'google_sheets'`,
      args.user.id, SHEETS_SCOPE, refreshEnc, status, lastError, now, project.workspace_id, project.id,
    );
  } else {
    await db.insert("oauth_connections", {
      id: newId("oac"),
      workspace_id: project.workspace_id,
      project_id: project.id,
      user_id: args.user.id,
      provider: SHEETS_PROVIDER,
      scopes: SHEETS_SCOPE,
      refresh_token_enc: refreshEnc,
      status,
      last_error: lastError,
      created_at: now,
      updated_at: now,
    });
  }
  clearSheetsTokenCache(project.id);
  return refreshEnc ? back() : back("no_refresh_token");
}

/** Local-only disconnect: deletes this project's stored Sheets token. Syncs stay configured and report not_connected. */
export async function disconnectSheets(db: Db, workspaceId: string, projectId: string): Promise<void> {
  await db.run("DELETE FROM oauth_connections WHERE workspace_id = ? AND project_id = ? AND provider = 'google_sheets'", workspaceId, projectId);
  clearSheetsTokenCache(projectId);
}

// ------------------------------------------------------------------ API client
export class SheetsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: SyncErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const tokenCache = new Map<string, { envelope: string; token: string; expiresAt: number }>();
export function clearSheetsTokenCache(projectId?: string) {
  if (projectId) tokenCache.delete(projectId);
  else tokenCache.clear();
}

/** A1 column letters for a 1-based column number (1 -> A, 27 -> AA). */
export function columnLetters(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** 'Tab name'!A1:CV5001 (sheet names quoted, single quotes doubled). */
export function a1Range(tab: string, dataRows: number, columns = MAX_IMPORT_COLUMNS): string {
  return `'${tab.replace(/'/g, "''")}'!A1:${columnLetters(columns)}${dataRows + 1}`;
}

/** fields mask for spreadsheets.get: title and grid tabs only (no cell data). */
export const SPREADSHEET_FIELDS = "spreadsheetId,properties.title,sheets.properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount))";

/** Native Spreadsheet resource -> tabs (grid sheets only), shared by the direct and the Maton transport. */
export function parseSpreadsheet(raw: unknown, spreadsheetId: string): SheetTabsResult {
  const json = raw as {
    properties?: { title?: unknown };
    sheets?: Array<{ properties?: { sheetId?: unknown; title?: unknown; index?: unknown; sheetType?: unknown; gridProperties?: { rowCount?: unknown; columnCount?: unknown } } }>;
  } | null;
  const tabs: SheetTab[] = [];
  for (const s of Array.isArray(json?.sheets) ? json!.sheets : []) {
    const p = s?.properties;
    if (!p || typeof p.title !== "string" || typeof p.sheetId !== "number") continue;
    // Only grid sheets hold cell values (object/chart sheets have no values).
    if (p.sheetType !== undefined && p.sheetType !== "GRID") continue;
    tabs.push({
      sheetId: p.sheetId,
      title: p.title.slice(0, 200),
      index: typeof p.index === "number" ? p.index : tabs.length,
      rowCount: typeof p.gridProperties?.rowCount === "number" ? p.gridProperties.rowCount : null,
      columnCount: typeof p.gridProperties?.columnCount === "number" ? p.gridProperties.columnCount : null,
    });
  }
  tabs.sort((a, b) => a.index - b.index);
  const title = typeof json?.properties?.title === "string" ? json.properties.title.slice(0, 300) : spreadsheetId;
  return { spreadsheetId, title, tabs };
}

/** Native ValueRange -> ragged rows of strings. */
export function parseValueRange(raw: unknown): string[][] {
  const values = (raw as { values?: unknown } | null)?.values;
  return (Array.isArray(values) ? values : []).map((r: unknown) => (Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? "" : String(c))) : []));
}

export interface SheetsClient {
  getSpreadsheet(spreadsheetId: string): Promise<SheetTabsResult>;
  /** Rows of a tab (header row + at most `dataRows` rows), each row a ragged array of strings. */
  getValues(spreadsheetId: string, tab: string, dataRows: number): Promise<string[][]>;
  /** How the sheet is read (absent = the project's direct Google Sheets OAuth connection). */
  transport?: { kind: "direct" | "maton"; label: string | null };
}

/** Null when Sheets is not connected for the project (or OAuth is not configured). */
export async function createSheetsClient(
  env: Env,
  db: Db,
  project: { id: string; workspaceId: string },
  fetchImpl: typeof fetch = sheetsFetch(env),
  clock: () => Date = () => new Date(),
): Promise<SheetsClient | null> {
  if (!gscOAuthConfigured(env)) return null;
  const conn = await loadSheetsConnection(db, project.workspaceId, project.id);
  if (!conn || conn.status !== "connected" || !conn.refresh_token_enc) return null;
  const envelope = conn.refresh_token_enc;

  async function markError(message: string) {
    await db.run(
      "UPDATE oauth_connections SET status = 'error', last_error = ?, updated_at = ? WHERE workspace_id = ? AND project_id = ? AND provider = 'google_sheets'",
      message,
      iso(clock()),
      project.workspaceId,
      project.id,
    );
  }

  async function accessToken(forceRefresh: boolean): Promise<string> {
    const cached = tokenCache.get(project.id);
    const nowMs = clock().getTime();
    if (!forceRefresh && cached && cached.envelope === envelope && cached.expiresAt - 60_000 > nowMs) return cached.token;
    const refreshToken = await decryptSecret(env, envelope, sheetsTokenAad(project.id));
    let res: Response;
    try {
      res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET!,
        }).toString(),
        signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw new SheetsApiError(0, "api_error", "Could not reach Google's token endpoint.");
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      tokenCache.delete(project.id);
      if (body.error === "invalid_grant") {
        const msg =
          "Google rejected the stored Google Sheets authorization (invalid_grant): it expired or was revoked. While the OAuth app is in Testing mode Google expires it after 7 days. Reconnect Google Sheets on the Import page.";
        await markError(msg);
        throw new SheetsApiError(res.status || 400, "token_expired", msg);
      }
      throw new SheetsApiError(res.status, "api_error", `Google token refresh failed (${res.status}).`);
    }
    const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    tokenCache.set(project.id, { envelope, token: body.access_token, expiresAt: nowMs + ttl * 1000 });
    return body.access_token;
  }

  async function call(url: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(attempt > 0);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          signal: AbortSignal.timeout(SHEETS_TIMEOUT_MS),
        });
      } catch {
        throw new SheetsApiError(0, "api_error", "Could not reach the Google Sheets API.");
      }
      if (res.status === 401 && attempt === 0) {
        tokenCache.delete(project.id);
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const text = await readCapped(res, SHEETS_MAX_RESPONSE_BYTES);
      if (text === null) throw new SheetsApiError(res.status, "api_error", "The Google Sheets response was too large; import fewer rows or a smaller tab.");
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        // Google's message is shown as plain text (clipped); it never contains our token.
        const message = String((json as { error?: { message?: unknown } } | null)?.error?.message ?? "").slice(0, 300);
        if (res.status === 404) throw new SheetsApiError(404, "not_found", "Spreadsheet not found, or the connected Google account cannot open it.");
        if (res.status === 403) throw new SheetsApiError(403, "forbidden", `Google Sheets refused access (403)${message ? `: ${message}` : ""}. Share the sheet with the connected Google account, and make sure the Google Sheets API is enabled for the OAuth client's Cloud project.`);
        if (res.status === 400 && /unable to parse range/i.test(message)) throw new SheetsApiError(400, "tab_missing", "That tab was not found in the spreadsheet (renamed or deleted?).");
        if (res.status === 429) throw new SheetsApiError(429, "api_error", "Google Sheets API quota exceeded. Try again in a minute.");
        throw new SheetsApiError(res.status, "api_error", `Google Sheets API error ${res.status}${message ? `: ${message}` : ""}`);
      }
      return json;
    }
    throw new SheetsApiError(401, "token_expired", "Google Sheets rejected the access token. Reconnect Google Sheets.");
  }

  return {
    async getSpreadsheet(spreadsheetId) {
      return parseSpreadsheet(await call(`${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(SPREADSHEET_FIELDS)}`), spreadsheetId);
    },
    async getValues(spreadsheetId, tab, dataRows) {
      const range = a1Range(tab, dataRows);
      const url = `${SHEETS_API_BASE}/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
      return parseValueRange(await call(url));
    },
  };
}
