/**
 * Maton.ai API gateway client: the ONLY module in Okara that sends a request to Maton (owner request 2026-10-03).
 *
 * Why a strict egress policy: a Maton API key reaches every app the owner connected in Maton (Gmail, Drive, GitHub,
 * ...). Okara needs read-only Google Sheets and Search Console, so every request is checked against an exact
 * allowlist of (host, method, path shape, query keys) BEFORE any fetch; everything else throws MatonPolicyError and
 * nothing leaves the Worker.
 *
 * Contract (verified 2026-10-03 against Maton's api-gateway skill docs, SKILL.md + references/google-sheets/README.md
 * + references/google-search-console/README.md; see docs/provider-contracts.md "Maton.ai API gateway"):
 *   - Gateway  https://gateway.maton.ai/{app}/{native-api-path}; header `Authorization: Bearer <MATON_API_KEY>`;
 *     optional `Maton-Connection: <connection_id>` picks one of several connections (omitted = the default, oldest
 *     active connection). Errors: 400 missing connection, 401 invalid key, 429 rate limited (10 req/s per account),
 *     other 4xx/5xx passed through from the target API.
 *   - Control  https://ctrl.maton.ai/connections?app=&status=ACTIVE (same Bearer auth) ->
 *     { connections: [{ connection_id, status, creation_time, last_updated_time, url, app, method, metadata }] }.
 *     No account e-mail or label field is documented, so none is read; `url` (a connect session link) and `metadata`
 *     are dropped at parse time.
 *   - google-sheets proxies sheets.googleapis.com: /google-sheets/v4/spreadsheets/{id} and .../values/{range}.
 *   - google-search-console proxies www.googleapis.com: /google-search-console/webmasters/v3/sites and
 *     POST .../sites/{siteUrl}/searchAnalytics/query (siteUrl URL-encoded).
 *   - google-analytics-data proxies analyticsdata.googleapis.com (POST /v1beta/properties/{id}:runReport);
 *     google-analytics-admin proxies analyticsadmin.googleapis.com (GET /v1beta/accountSummaries).
 *
 * Two layers: (1) matonRequest + typed calls taking an explicit key (used by the Okara features), and (2) tenant-scoped
 * helpers at the end of this file (matonStatus, readSheetTabs, readSheetValues, gscSites, gscQuery, gaListProperties,
 * gaRunReport) that resolve the workspace's key and chosen connection, cap the output and label it with its source
 * ("Maton (<connection>), fetched <ts>") for reuse by Ask Okara.
 *
 * Allowed (and nothing else):
 *   GET  ctrl.maton.ai     /connections                                         query: app (known apps), status=ACTIVE
 *   GET  gateway.maton.ai  /google-sheets/v4/spreadsheets/{id}                 query: fields
 *   GET  gateway.maton.ai  /google-sheets/v4/spreadsheets/{id}/values/{range}  query: majorDimension, valueRenderOption
 *   GET  gateway.maton.ai  /google-search-console/webmasters/v3/sites          no query
 *   POST gateway.maton.ai  /google-search-console/webmasters/v3/sites/{site}/searchAnalytics/query   no query
 *   POST gateway.maton.ai  /google-analytics-data/v1beta/properties/{numericId}:runReport               no query
 *   GET  gateway.maton.ai  /google-analytics-admin/v1beta/accountSummaries      query: pageSize, pageToken
 * (GA: references/google-analytics-data/README.md "Run Report" and references/google-analytics-admin/README.md
 *  "List Account Summaries"; both read-only. The response shapes are Google's native ones, linked from those READMEs.)
 * Requests go through the guarded API fetch (runs/runtime.ts createApiFetch) with the two Maton hosts admitted for
 * these calls only (never added to the shared allowlist); redirects are never followed; each call has a timeout and a
 * response size cap. The key goes only in the Authorization header and is scrubbed from every error text.
 * Every request that left is recorded in provider_calls (provider "maton", cost 0: Okara is not charged per request;
 * the owner's own Maton plan applies).
 */
import type { CallRecorder } from "../providers/types";
import { readCapped } from "../lib/read-capped";
import { redact } from "../runs/calls";
import { createApiFetch, OutboundBlockedError } from "../runs/runtime";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { iso } from "../lib/time";
import type { MatonStatus } from "@shared/maton";
import type { SheetTabsResult } from "@shared/import";
import { MATON_LISTED_APPS, type MatonListedApp } from "./maton-apps";
import { createCallRecorder } from "../runs/calls";
import { matonTransport, matonWorkspaceStatus, type MatonTransport } from "./maton-credentials";
import { parseSpreadsheet, parseValueRange, SPREADSHEET_FIELDS } from "../imports/sheets-parse";

export const MATON_GATEWAY_HOST = "gateway.maton.ai";
export const MATON_CTRL_HOST = "ctrl.maton.ai";
export const MATON_HOSTS = [MATON_GATEWAY_HOST, MATON_CTRL_HOST] as const;
export const MATON_PROVIDER = "maton";
export const MATON_RATE_VERSION = "maton-2026-10-03";

export { MATON_USED_APPS, MATON_GA_APPS, MATON_LISTED_APPS, type MatonUsedApp, type MatonListedApp } from "./maton-apps";

export const MATON_TIMEOUTS_MS = { ctrl: 10_000, sheets: 25_000, gsc: 30_000, ga: 30_000 } as const;
export const MATON_MAX_BYTES = { ctrl: 1024 * 1024, sheets: 24 * 1024 * 1024, gsc: 16 * 1024 * 1024, ga: 8 * 1024 * 1024 } as const;

/** "{numericPropertyId}:runReport" (the only GA Data method allowed; runRealtimeReport/batchRunReports are not). */
const GA_RUN_REPORT_SEGMENT = /^\d{1,20}:runReport$/;
/** Spreadsheet ids are URL-safe base64-ish tokens. */
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{10,200}$/;
/** Maton connection ids (UUID-like in the docs' examples); validated before use as a header value. */
export const CONNECTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export class MatonPolicyError extends Error {
  constructor(message: string) {
    super(`Maton request refused by Okara's egress policy: ${message}`);
  }
}

export type MatonErrorCode = "unauthorized" | "missing_connection" | "rate_limited" | "forbidden" | "not_found" | "bad_request" | "upstream" | "network" | "timeout" | "too_large" | "bad_response";

export class MatonApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: MatonErrorCode,
    message: string,
    /** The target API's own error message (clipped, redacted), plain text. */
    public readonly upstreamMessage: string = "",
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ egress policy
export type MatonOp = "list_connections" | "sheets.get" | "sheets.values.get" | "gsc.sites.list" | "gsc.searchanalytics.query" | "ga.runReport" | "ga.accountSummaries";

export interface MatonRoute {
  op: MatonOp;
  app: MatonListedApp | null;
  kind: keyof typeof MATON_TIMEOUTS_MS;
}

function onlyQueryKeys(url: URL, allowed: readonly string[]): boolean {
  for (const k of url.searchParams.keys()) if (!allowed.includes(k)) return false;
  return true;
}

/**
 * The egress policy. Returns the matched route for an allowed request, throws MatonPolicyError otherwise.
 * Checked on the parsed (normalized) URL that is then fetched, so dot segments or encodings cannot slip past.
 */
export function checkMatonRequest(method: string, rawUrl: string): MatonRoute {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MatonPolicyError("invalid URL.");
  }
  const m = method.toUpperCase();
  if (url.protocol !== "https:") throw new MatonPolicyError("only https is allowed.");
  if (url.username || url.password) throw new MatonPolicyError("URL credentials are not allowed.");
  if (url.port) throw new MatonPolicyError("non-standard port.");
  if (url.hash) throw new MatonPolicyError("URL fragments are not allowed.");
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host === MATON_CTRL_HOST) {
    if (m === "GET" && path === "/connections" && onlyQueryKeys(url, ["app", "status"])) {
      const app = url.searchParams.getAll("app");
      const status = url.searchParams.getAll("status");
      const appOk = app.length === 0 || (app.length === 1 && (MATON_LISTED_APPS as readonly string[]).includes(app[0]!));
      const statusOk = status.length === 0 || (status.length === 1 && status[0] === "ACTIVE");
      if (appOk && statusOk) return { op: "list_connections", app: null, kind: "ctrl" };
    }
    throw new MatonPolicyError(`${m} ${MATON_CTRL_HOST}${path} is not allowed (only listing ACTIVE connections).`);
  }
  if (host !== MATON_GATEWAY_HOST) throw new MatonPolicyError(`${host} is not a Maton host.`);

  const seg = path.split("/");
  // seg[0] is "" (leading slash). Raw ':' in a segment would select another Sheets method (values/{range}:append,
  // values:batchUpdate, spreadsheets/{id}:batchUpdate), so ranges and site URLs must arrive percent-encoded.
  if (seg[1] === "google-sheets" && m === "GET" && seg[2] === "v4" && seg[3] === "spreadsheets" && seg[4] && SPREADSHEET_ID.test(seg[4])) {
    if (seg.length === 5 && onlyQueryKeys(url, ["fields"])) return { op: "sheets.get", app: "google-sheets", kind: "sheets" };
    if (seg.length === 7 && seg[5] === "values" && seg[6] && !seg[6].includes(":") && onlyQueryKeys(url, ["majorDimension", "valueRenderOption"])) {
      return { op: "sheets.values.get", app: "google-sheets", kind: "sheets" };
    }
  }
  if (seg[1] === "google-search-console" && seg[2] === "webmasters" && seg[3] === "v3" && seg[4] === "sites" && !url.search) {
    if (m === "GET" && seg.length === 5) return { op: "gsc.sites.list", app: "google-search-console", kind: "gsc" };
    if (m === "POST" && seg.length === 8 && seg[5] && !seg[5].includes(":") && seg[6] === "searchAnalytics" && seg[7] === "query") {
      return { op: "gsc.searchanalytics.query", app: "google-search-console", kind: "gsc" };
    }
  }
  if (seg[1] === "google-analytics-data" && m === "POST" && seg.length === 5 && seg[2] === "v1beta" && seg[3] === "properties" && GA_RUN_REPORT_SEGMENT.test(seg[4] ?? "") && !url.search) {
    return { op: "ga.runReport", app: "google-analytics-data", kind: "ga" };
  }
  if (seg[1] === "google-analytics-admin" && m === "GET" && seg.length === 4 && seg[2] === "v1beta" && seg[3] === "accountSummaries" && onlyQueryKeys(url, ["pageSize", "pageToken"])) {
    return { op: "ga.accountSummaries", app: "google-analytics-admin", kind: "ga" };
  }
  throw new MatonPolicyError(`${m} ${MATON_GATEWAY_HOST}${path} is not allowed (only read-only Google Sheets, Search Console and Google Analytics report requests).`);
}

// ------------------------------------------------------------------ transport
let fetchOverride: typeof fetch | null = null;
/** Test hook: the base fetch behind the guarded fetch (tests must never reach Maton). */
export function setMatonFetch(f: typeof fetch | null) {
  fetchOverride = f;
}

export interface MatonDeps {
  env: Pick<Env, "WRITER_BASE_URL">;
  apiKey: string;
  /** Records each request that left (provider_calls). */
  calls?: CallRecorder | null;
  /** provider_calls.purpose, e.g. "maton_test", "import_sheets", "gsc_sync". */
  purpose: string;
  /** Base fetch (tests); defaults to the module test hook, then the platform fetch. */
  fetchImpl?: typeof fetch;
}

export interface MatonCall {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  /** Maton-Connection header (a validated connection id), or null for the default connection. */
  connectionId?: string | null;
}

/** Remove the key (and anything key-shaped) from text before it is stored or shown. */
export function scrubKey(text: string, apiKey: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join("[redacted]");
  return redact(out);
}

/**
 * One request to Maton. The policy is checked first (throws MatonPolicyError, nothing is sent). Never follows a
 * redirect. Returns the parsed JSON body; non-2xx answers throw MatonApiError with a key-free message.
 */
export async function matonRequest(deps: MatonDeps, call: MatonCall): Promise<unknown> {
  const route = checkMatonRequest(call.method, call.url);
  const url = new URL(call.url).toString();
  if (call.method === "GET" && call.body !== undefined) throw new MatonPolicyError("GET requests carry no body.");
  if (call.connectionId != null && !CONNECTION_ID.test(call.connectionId)) throw new MatonPolicyError("invalid Maton connection id.");
  if (route.kind === "ctrl" && call.connectionId) throw new MatonPolicyError("the control plane takes no Maton-Connection header.");
  if (!deps.apiKey || /[\s\r\n]/.test(deps.apiKey)) throw new MatonApiError(401, "unauthorized", "The saved Maton API key is not usable; enter it again on the Integrations page.");

  const headers: Record<string, string> = { Authorization: `Bearer ${deps.apiKey}`, Accept: "application/json" };
  if (call.connectionId) headers["Maton-Connection"] = call.connectionId;
  if (call.body !== undefined) headers["Content-Type"] = "application/json";
  const base = deps.fetchImpl ?? fetchOverride ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const guarded = createApiFetch(deps.env, base, MATON_HOSTS);
  const model = route.app ? `${route.app}/${route.op}` : `ctrl/${route.op}`;
  const started = Date.now();
  const record = async (status: "ok" | "error" | "timeout" | "unknown", error: string | null) => {
    await deps.calls
      ?.record({ provider: MATON_PROVIDER, model, purpose: deps.purpose, status, costUsd: 0, costIsEstimate: false, rateVersion: MATON_RATE_VERSION, latencyMs: Date.now() - started, error })
      .catch(() => undefined);
  };

  let res: Response;
  try {
    res = await guarded(url, {
      method: call.method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      redirect: "manual",
      signal: AbortSignal.timeout(MATON_TIMEOUTS_MS[route.kind]),
    });
  } catch (e) {
    if (e instanceof OutboundBlockedError) throw new MatonPolicyError("outbound host not allowlisted.");
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    const msg = timeout ? "Maton did not answer in time." : "Could not reach Maton (network error).";
    await record(timeout ? "timeout" : "unknown", msg);
    throw new MatonApiError(0, timeout ? "timeout" : "network", msg);
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    const msg = `Maton answered with a redirect (HTTP ${res.status}); not followed.`;
    await record("error", msg);
    throw new MatonApiError(res.status, "bad_response", msg);
  }
  let text: string | null;
  try {
    text = await readCapped(res, MATON_MAX_BYTES[route.kind]);
  } catch {
    const msg = "Maton's response could not be read (timeout or network error).";
    await record("timeout", msg);
    throw new MatonApiError(0, "timeout", msg);
  }
  if (text === null) {
    const msg = "Maton's response was too large and was not read.";
    await record("error", msg);
    throw new MatonApiError(res.status, "too_large", msg);
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const upstream = scrubKey(upstreamMessage(json), deps.apiKey).slice(0, 300);
    const err = errorFor(res.status, route, upstream);
    await record("error", scrubKey(err.message, deps.apiKey));
    throw err;
  }
  if (json === null) {
    const msg = "Maton returned a response that is not JSON.";
    await record("error", msg);
    throw new MatonApiError(res.status, "bad_response", msg);
  }
  await record("ok", null);
  return json;
}

function upstreamMessage(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const j = json as { error?: unknown; message?: unknown };
  if (typeof j.error === "string") return j.error;
  if (j.error && typeof j.error === "object" && typeof (j.error as { message?: unknown }).message === "string") return (j.error as { message: string }).message;
  if (typeof j.message === "string") return j.message;
  return "";
}

function errorFor(status: number, route: MatonRoute, upstream: string): MatonApiError {
  const suffix = upstream ? `: ${upstream}` : "";
  const appName =
    route.app === "google-sheets" ? "Google Sheets" : route.app === "google-search-console" ? "Search Console" : route.app?.startsWith("google-analytics") ? "Google Analytics" : "Maton";
  if (status === 401) return new MatonApiError(401, "unauthorized", "Maton rejected the API key (HTTP 401). Update the key on the Integrations page.", upstream);
  if (status === 429) return new MatonApiError(429, "rate_limited", `Rate limited (HTTP 429; Maton allows 10 requests per second per account, and ${appName} quotas apply). Try again shortly.`, upstream);
  if (status === 400 && route.kind !== "ctrl" && /connection/i.test(upstream)) {
    return new MatonApiError(400, "missing_connection", `Maton has no active ${route.app} connection for this key (HTTP 400). Connect ${appName} at maton.ai, then test the key again.`, upstream);
  }
  if (status === 403) return new MatonApiError(403, "forbidden", `${appName} refused access through Maton (HTTP 403)${suffix}`, upstream);
  if (status === 404) return new MatonApiError(404, "not_found", `${appName} answered HTTP 404 through Maton${suffix}`, upstream);
  if (status === 400) return new MatonApiError(400, "bad_request", `${appName} answered HTTP 400 through Maton${suffix}`, upstream);
  return new MatonApiError(status, "upstream", `${appName} answered HTTP ${status} through Maton${suffix}`, upstream);
}

// ------------------------------------------------------------------ typed calls
export interface MatonConnection {
  app: MatonListedApp;
  connectionId: string;
  status: string;
  createdAt: string | null;
}

/** Parse the documented list shape; keeps only the listed apps and documented fields (never `url` or `metadata`). */
export function parseConnections(json: unknown): MatonConnection[] {
  const list = (json as { connections?: unknown } | null)?.connections;
  if (!Array.isArray(list)) return [];
  const out: MatonConnection[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const r = c as { connection_id?: unknown; app?: unknown; status?: unknown; creation_time?: unknown };
    if (typeof r.connection_id !== "string" || !CONNECTION_ID.test(r.connection_id)) continue;
    if (typeof r.app !== "string" || !(MATON_LISTED_APPS as readonly string[]).includes(r.app)) continue;
    if (typeof r.status !== "string") continue;
    out.push({
      app: r.app as MatonListedApp,
      connectionId: r.connection_id,
      status: r.status.slice(0, 20),
      createdAt: typeof r.creation_time === "string" ? r.creation_time.slice(0, 40) : null,
    });
  }
  out.sort((a, b) => (a.app === b.app ? (a.createdAt ?? "").localeCompare(b.createdAt ?? "") : a.app.localeCompare(b.app)));
  return out;
}

/** ACTIVE connections of the apps Okara lists (one control-plane request; other apps are discarded unread). */
export async function listActiveConnections(deps: MatonDeps): Promise<MatonConnection[]> {
  const json = await matonRequest(deps, { method: "GET", url: `https://${MATON_CTRL_HOST}/connections?status=ACTIVE` });
  if (!json || typeof json !== "object" || !Array.isArray((json as { connections?: unknown }).connections)) {
    throw new MatonApiError(200, "bad_response", "Maton's connection list did not have the documented shape.");
  }
  return parseConnections(json).filter((c) => c.status === "ACTIVE");
}

export function assertSpreadsheetId(id: string): string {
  if (!SPREADSHEET_ID.test(id)) throw new MatonPolicyError("invalid spreadsheet id.");
  return id;
}

/** GET /google-sheets/v4/spreadsheets/{id}?fields=... (native Spreadsheet resource). */
export async function sheetsGetSpreadsheet(deps: MatonDeps, connectionId: string | null, spreadsheetId: string, fields: string): Promise<unknown> {
  const url = `https://${MATON_GATEWAY_HOST}/google-sheets/v4/spreadsheets/${assertSpreadsheetId(spreadsheetId)}?fields=${encodeURIComponent(fields)}`;
  return matonRequest(deps, { method: "GET", url, connectionId });
}

/** GET /google-sheets/v4/spreadsheets/{id}/values/{range} (native ValueRange); the range is percent-encoded. */
export async function sheetsGetValues(deps: MatonDeps, connectionId: string | null, spreadsheetId: string, range: string): Promise<unknown> {
  const url = `https://${MATON_GATEWAY_HOST}/google-sheets/v4/spreadsheets/${assertSpreadsheetId(spreadsheetId)}/values/${encodeRangeSegment(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
  return matonRequest(deps, { method: "GET", url, connectionId });
}

/** encodeURIComponent leaves ' ( ) ! * unescaped; ':' is escaped, so a range can never select another method. */
export function encodeRangeSegment(range: string): string {
  return encodeURIComponent(range);
}

/** GET /google-search-console/webmasters/v3/sites (native SitesListResponse). */
export async function gscListSites(deps: MatonDeps, connectionId: string | null): Promise<unknown> {
  return matonRequest(deps, { method: "GET", url: `https://${MATON_GATEWAY_HOST}/google-search-console/webmasters/v3/sites`, connectionId });
}

/** POST /google-search-console/webmasters/v3/sites/{siteUrl}/searchAnalytics/query (native body and response). */
export async function gscSearchAnalytics(deps: MatonDeps, connectionId: string | null, siteUrl: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `https://${MATON_GATEWAY_HOST}/google-search-console/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  return matonRequest(deps, { method: "POST", url, connectionId, body });
}

/** GET /google-analytics-admin/v1beta/accountSummaries (native ListAccountSummariesResponse). */
export async function gaAccountSummaries(deps: MatonDeps, connectionId: string | null, pageToken?: string | null): Promise<unknown> {
  const q = new URLSearchParams({ pageSize: "200" });
  if (pageToken) q.set("pageToken", pageToken.slice(0, 500));
  return matonRequest(deps, { method: "GET", url: `https://${MATON_GATEWAY_HOST}/google-analytics-admin/v1beta/accountSummaries?${q.toString()}`, connectionId });
}

/** POST /google-analytics-data/v1beta/properties/{id}:runReport (native RunReportRequest / RunReportResponse). */
export async function gaRunReportRaw(deps: MatonDeps, connectionId: string | null, propertyId: string, body: Record<string, unknown>): Promise<unknown> {
  const id = normalizeGaPropertyId(propertyId);
  if (!id) throw new MatonPolicyError("invalid Google Analytics property id (numeric, or properties/<number>).");
  return matonRequest(deps, { method: "POST", url: `https://${MATON_GATEWAY_HOST}/google-analytics-data/v1beta/properties/${id}:runReport`, connectionId, body });
}

/** "properties/521310447" | "521310447" -> "521310447"; null when not numeric. */
export function normalizeGaPropertyId(raw: string): string | null {
  const m = /^(?:properties\/)?(\d{1,20})$/.exec(String(raw).trim());
  return m ? m[1]! : null;
}

// ------------------------------------------------------------------ tenant-scoped helpers (Okara features, Ask Okara)
/**
 * Who is asking. Every helper resolves the key and connection of `workspaceId` only (tenancy), records each request
 * in provider_calls against workspace/project/run, and returns plain, size-capped data with a source label.
 * The caller is responsible for having checked that the user may act on `workspaceId` (and `projectId`).
 */
export interface MatonScope {
  env: Env;
  db: Db;
  workspaceId: string;
  projectId?: string | null;
  runId?: string | null;
  /** provider_calls.purpose, e.g. "chat_maton". */
  purpose: string;
  clock?: () => Date;
  /** Base fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface MatonResult<T> {
  data: T;
  /** "Maton (connection 1a2b3c4d (added 2026-01-02)), fetched 2026-10-03T12:00:00.000Z" */
  source: string;
  connectionLabel: string;
  fetchedAt: string;
  truncated: boolean;
}

/** No key, an undecryptable key, or no active connection for the app: report setup_required, never fake data. */
export class MatonSetupRequiredError extends Error {
  readonly code = "setup_required";
  constructor(
    public readonly app: MatonListedApp,
    message: string,
  ) {
    super(message);
  }
}

const APP_NAME: Record<MatonListedApp, string> = {
  "google-sheets": "Google Sheets",
  "google-search-console": "Google Search Console",
  "google-analytics-data": "Google Analytics Data",
  "google-analytics-admin": "Google Analytics Admin",
};

async function scoped(scope: MatonScope, app: MatonListedApp): Promise<{ deps: MatonDeps; t: MatonTransport }> {
  let t: MatonTransport | null;
  try {
    t = await matonTransport(scope.env, scope.db, scope.workspaceId, app);
  } catch {
    throw new MatonSetupRequiredError(app, "The saved Maton key could not be decrypted; the workspace owner should enter it again on the Integrations page.");
  }
  if (!t) {
    throw new MatonSetupRequiredError(
      app,
      `No Maton key with an active ${APP_NAME[app]} connection for this workspace. The owner can add the key on the Integrations page (Maton.ai card), connect ${APP_NAME[app]} at maton.ai, then press Test.`,
    );
  }
  const calls = createCallRecorder(scope.db, { workspaceId: scope.workspaceId, projectId: scope.projectId ?? null, runId: scope.runId ?? null });
  return { t, deps: { env: scope.env, apiKey: t.apiKey, calls, purpose: scope.purpose, fetchImpl: scope.fetchImpl } };
}

function result<T>(scope: MatonScope, t: MatonTransport, data: T, truncated: boolean): MatonResult<T> {
  const fetchedAt = iso((scope.clock ?? (() => new Date()))());
  return { data, source: `Maton (${t.label}), fetched ${fetchedAt}`, connectionLabel: t.label, fetchedAt, truncated };
}

const clipStr = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : v === null || v === undefined ? "" : String(v).slice(0, n));

/** Connected apps, chosen connections, key hint; never the key. No network call. */
export async function matonStatus(_env: Env, db: Db, workspaceId: string): Promise<MatonStatus> {
  return matonWorkspaceStatus(db, workspaceId);
}

/** Spreadsheet title and grid tabs. */
export async function readSheetTabs(scope: MatonScope, spreadsheetId: string): Promise<MatonResult<SheetTabsResult>> {
  const { deps, t } = await scoped(scope, "google-sheets");
  const meta = parseSpreadsheet(await sheetsGetSpreadsheet(deps, t.connectionId, spreadsheetId, SPREADSHEET_FIELDS), spreadsheetId);
  const tabs = meta.tabs.slice(0, 200);
  return result(scope, t, { ...meta, tabs }, meta.tabs.length > tabs.length);
}

export const SHEET_VALUES_LIMITS = { maxRows: 5000, maxColumns: 100, maxCellChars: 500 } as const;

/**
 * Values of an A1 range ("'Tab name'!A1:F200" or "Tab name"), at most `maxRows` rows (<= 5000), 100 columns and 500
 * characters per cell. Cell text is untrusted data (render as plain text, never follow it).
 */
export async function readSheetValues(scope: MatonScope, spreadsheetId: string, range: string, maxRows = 500): Promise<MatonResult<{ range: string; rows: string[][] }>> {
  if (typeof range !== "string" || !range.trim() || range.length > 300) throw new MatonPolicyError("invalid A1 range.");
  const { deps, t } = await scoped(scope, "google-sheets");
  const cap = Math.max(1, Math.min(SHEET_VALUES_LIMITS.maxRows, Math.floor(maxRows)));
  const all = parseValueRange(await sheetsGetValues(deps, t.connectionId, spreadsheetId, range.trim()));
  let truncated = all.length > cap;
  const rows = all.slice(0, cap).map((r) => {
    if (r.length > SHEET_VALUES_LIMITS.maxColumns) truncated = true;
    return r.slice(0, SHEET_VALUES_LIMITS.maxColumns).map((c) => {
      if (c.length > SHEET_VALUES_LIMITS.maxCellChars) truncated = true;
      return c.slice(0, SHEET_VALUES_LIMITS.maxCellChars);
    });
  });
  return result(scope, t, { range: range.trim(), rows }, truncated);
}

/** Search Console properties of the workspace's Maton google-search-console connection. */
export async function gscSites(scope: MatonScope): Promise<MatonResult<Array<{ siteUrl: string; permissionLevel: string }>>> {
  const { deps, t } = await scoped(scope, "google-search-console");
  const json = (await gscListSites(deps, t.connectionId)) as { siteEntry?: Array<{ siteUrl?: unknown; permissionLevel?: unknown }> } | null;
  const all = (Array.isArray(json?.siteEntry) ? json!.siteEntry : [])
    .filter((e): e is { siteUrl: string; permissionLevel: string } => typeof e?.siteUrl === "string" && typeof e?.permissionLevel === "string")
    .map((e) => ({ siteUrl: e.siteUrl.slice(0, 300), permissionLevel: e.permissionLevel.slice(0, 40) }));
  return result(scope, t, all.slice(0, 500), all.length > 500);
}

export interface GscQueryInput {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: Array<"query" | "page" | "country" | "device" | "date" | "searchAppearance">;
  type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
  dataState?: "final" | "all";
  rowLimit?: number;
  startRow?: number;
  dimensionFilterGroups?: Array<{ groupType?: "and"; filters: Array<{ dimension: string; operator: string; expression: string }> }>;
}

export interface GscQueryRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

const GSC_DIMENSIONS = new Set(["query", "page", "country", "device", "date", "searchAppearance"]);
const GSC_OPERATORS = new Set(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const GSC_QUERY_MAX_ROWS = 25_000;

/** One Search Analytics query (rowLimit <= 25,000; Google's documented maximum). */
export async function gscQuery(scope: MatonScope, input: GscQueryInput): Promise<MatonResult<{ rows: GscQueryRow[]; responseAggregationType: string | null }>> {
  if (!input || typeof input.siteUrl !== "string" || !input.siteUrl || input.siteUrl.length > 300) throw new MatonPolicyError("invalid Search Console property.");
  if (!DATE.test(input.startDate) || !DATE.test(input.endDate)) throw new MatonPolicyError("dates must be YYYY-MM-DD.");
  const dimensions = (input.dimensions ?? []).filter((d) => GSC_DIMENSIONS.has(d)).slice(0, 4);
  const groups = (input.dimensionFilterGroups ?? []).slice(0, 5).map((g) => ({
    groupType: "and" as const,
    filters: (g.filters ?? [])
      .filter((f) => GSC_DIMENSIONS.has(f.dimension) && f.dimension !== "date" && GSC_OPERATORS.has(f.operator) && typeof f.expression === "string")
      .slice(0, 10)
      .map((f) => ({ dimension: f.dimension, operator: f.operator, expression: f.expression.slice(0, 500) })),
  })).filter((g) => g.filters.length > 0);
  const body: Record<string, unknown> = {
    startDate: input.startDate,
    endDate: input.endDate,
    dimensions,
    type: input.type ?? "web",
    dataState: input.dataState ?? "final",
    rowLimit: Math.max(1, Math.min(GSC_QUERY_MAX_ROWS, Math.floor(input.rowLimit ?? 1000))),
    startRow: Math.max(0, Math.floor(input.startRow ?? 0)),
    ...(groups.length ? { dimensionFilterGroups: groups } : {}),
  };
  const { deps, t } = await scoped(scope, "google-search-console");
  const json = (await gscSearchAnalytics(deps, t.connectionId, input.siteUrl, body)) as { rows?: unknown; responseAggregationType?: unknown } | null;
  const rows: GscQueryRow[] = (Array.isArray(json?.rows) ? (json!.rows as unknown[]) : []).flatMap((r) => {
    const x = r as { keys?: unknown; clicks?: unknown; impressions?: unknown; ctr?: unknown; position?: unknown };
    if (!x || typeof x.clicks !== "number" || typeof x.impressions !== "number") return [];
    return [{
      keys: Array.isArray(x.keys) ? x.keys.slice(0, 4).map((k) => clipStr(k, 500)) : [],
      clicks: x.clicks,
      impressions: x.impressions,
      ctr: typeof x.ctr === "number" ? x.ctr : 0,
      position: typeof x.position === "number" ? x.position : 0,
    }];
  });
  return result(scope, t, { rows, responseAggregationType: typeof json?.responseAggregationType === "string" ? json.responseAggregationType.slice(0, 40) : null }, false);
}

export interface GaProperty {
  /** "properties/521310447" */
  property: string;
  propertyId: string;
  displayName: string;
  /** "accounts/123" */
  account: string;
  accountName: string;
}

/** GA4 properties visible to the Maton google-analytics-admin connection (accountSummaries; at most 5 pages). */
export async function gaListProperties(scope: MatonScope): Promise<MatonResult<GaProperty[]>> {
  const { deps, t } = await scoped(scope, "google-analytics-admin");
  const out: GaProperty[] = [];
  let pageToken: string | null = null;
  let truncated = false;
  for (let page = 0; page < 5; page++) {
    const json = (await gaAccountSummaries(deps, t.connectionId, pageToken)) as {
      accountSummaries?: Array<{ account?: unknown; displayName?: unknown; propertySummaries?: Array<{ property?: unknown; displayName?: unknown }> }>;
      nextPageToken?: unknown;
    } | null;
    for (const a of Array.isArray(json?.accountSummaries) ? json!.accountSummaries : []) {
      for (const p of Array.isArray(a?.propertySummaries) ? a.propertySummaries : []) {
        const id = typeof p?.property === "string" ? normalizeGaPropertyId(p.property) : null;
        if (!id) continue;
        if (out.length >= 500) {
          truncated = true;
          break;
        }
        out.push({ property: `properties/${id}`, propertyId: id, displayName: clipStr(p.displayName, 200), account: clipStr(a.account, 60), accountName: clipStr(a.displayName, 200) });
      }
    }
    pageToken = typeof json?.nextPageToken === "string" && json.nextPageToken ? json.nextPageToken : null;
    if (!pageToken) break;
    if (page === 4) truncated = true;
  }
  return result(scope, t, out, truncated);
}

export interface GaReportInput {
  dateRanges: Array<{ startDate: string; endDate: string; name?: string }>;
  dimensions?: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  dimensionFilter?: Record<string, unknown>;
  metricFilter?: Record<string, unknown>;
  orderBys?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
  keepEmptyRows?: boolean;
  currencyCode?: string;
}

export interface GaReport {
  dimensionHeaders: string[];
  metricHeaders: Array<{ name: string; type: string }>;
  rows: Array<{ dimensions: string[]; metrics: string[] }>;
  rowCount: number | null;
  currencyCode: string | null;
  timeZone: string | null;
}

export const GA_REPORT_MAX_ROWS = 10_000;
const GA_NAME = /^[A-Za-z][A-Za-z0-9_:]{0,99}$/;
const GA_DATE = /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d{1,4}daysAgo)$/;

/**
 * One GA4 Data API runReport (read-only). The request is rebuilt from the documented RunReportRequest fields only
 * (dateRanges <= 4, dimensions <= 9, metrics <= 10, limit <= 10,000); unknown fields are dropped. Values come back
 * as strings exactly as Google returns them (no invented metrics).
 */
export async function gaRunReport(scope: MatonScope, propertyId: string, input: GaReportInput): Promise<MatonResult<GaReport>> {
  const id = normalizeGaPropertyId(propertyId);
  if (!id) throw new MatonPolicyError("invalid Google Analytics property id (numeric, or properties/<number>).");
  const dateRanges = (input?.dateRanges ?? []).filter((d) => GA_DATE.test(d?.startDate) && GA_DATE.test(d?.endDate)).slice(0, 4)
    .map((d) => ({ startDate: d.startDate, endDate: d.endDate, ...(typeof d.name === "string" && GA_NAME.test(d.name) ? { name: d.name } : {}) }));
  const metrics = (input?.metrics ?? []).filter((m) => GA_NAME.test(m?.name)).slice(0, 10).map((m) => ({ name: m.name }));
  const dimensions = (input?.dimensions ?? []).filter((d) => GA_NAME.test(d?.name)).slice(0, 9).map((d) => ({ name: d.name }));
  if (dateRanges.length === 0 || metrics.length === 0) throw new MatonPolicyError("a GA report needs at least one valid date range and one metric.");
  const limit = Math.max(1, Math.min(GA_REPORT_MAX_ROWS, Math.floor(input.limit ?? 1000)));
  const body: Record<string, unknown> = {
    dateRanges,
    metrics,
    ...(dimensions.length ? { dimensions } : {}),
    ...(input.dimensionFilter && typeof input.dimensionFilter === "object" ? { dimensionFilter: input.dimensionFilter } : {}),
    ...(input.metricFilter && typeof input.metricFilter === "object" ? { metricFilter: input.metricFilter } : {}),
    ...(Array.isArray(input.orderBys) ? { orderBys: input.orderBys.slice(0, 5) } : {}),
    limit,
    ...(typeof input.offset === "number" && input.offset > 0 ? { offset: Math.floor(input.offset) } : {}),
    ...(typeof input.keepEmptyRows === "boolean" ? { keepEmptyRows: input.keepEmptyRows } : {}),
    ...(typeof input.currencyCode === "string" && /^[A-Z]{3}$/.test(input.currencyCode) ? { currencyCode: input.currencyCode } : {}),
  };
  if (JSON.stringify(body).length > 16_000) throw new MatonPolicyError("GA report request is too large.");
  const { deps, t } = await scoped(scope, "google-analytics-data");
  const json = (await gaRunReportRaw(deps, t.connectionId, id, body)) as {
    dimensionHeaders?: Array<{ name?: unknown }>;
    metricHeaders?: Array<{ name?: unknown; type?: unknown }>;
    rows?: Array<{ dimensionValues?: Array<{ value?: unknown }>; metricValues?: Array<{ value?: unknown }> }>;
    rowCount?: unknown;
    metadata?: { currencyCode?: unknown; timeZone?: unknown };
  } | null;
  const rawRows = Array.isArray(json?.rows) ? json!.rows : [];
  const rows = rawRows.slice(0, GA_REPORT_MAX_ROWS).map((r) => ({
    dimensions: (Array.isArray(r?.dimensionValues) ? r.dimensionValues : []).map((v) => clipStr(v?.value, 500)),
    metrics: (Array.isArray(r?.metricValues) ? r.metricValues : []).map((v) => clipStr(v?.value, 60)),
  }));
  const rowCount = typeof json?.rowCount === "number" ? json.rowCount : null;
  return result(
    scope,
    t,
    {
      dimensionHeaders: (Array.isArray(json?.dimensionHeaders) ? json!.dimensionHeaders : []).map((h) => clipStr(h?.name, 100)),
      metricHeaders: (Array.isArray(json?.metricHeaders) ? json!.metricHeaders : []).map((h) => ({ name: clipStr(h?.name, 100), type: clipStr(h?.type, 40) })),
      rows,
      rowCount,
      currencyCode: typeof json?.metadata?.currencyCode === "string" ? json.metadata.currencyCode.slice(0, 3) : null,
      timeZone: typeof json?.metadata?.timeZone === "string" ? json.metadata.timeZone.slice(0, 60) : null,
    },
    rawRows.length > rows.length || (rowCount !== null && rowCount > rows.length),
  );
}
