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
 *
 * Allowed (and nothing else):
 *   GET  ctrl.maton.ai     /connections                                         query: app (known apps), status=ACTIVE
 *   GET  gateway.maton.ai  /google-sheets/v4/spreadsheets/{id}                 query: fields
 *   GET  gateway.maton.ai  /google-sheets/v4/spreadsheets/{id}/values/{range}  query: majorDimension, valueRenderOption
 *   GET  gateway.maton.ai  /google-search-console/webmasters/v3/sites          no query
 *   POST gateway.maton.ai  /google-search-console/webmasters/v3/sites/{site}/searchAnalytics/query   no query
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

export const MATON_GATEWAY_HOST = "gateway.maton.ai";
export const MATON_CTRL_HOST = "ctrl.maton.ai";
export const MATON_HOSTS = [MATON_GATEWAY_HOST, MATON_CTRL_HOST] as const;
export const MATON_PROVIDER = "maton";
export const MATON_RATE_VERSION = "maton-2026-10-03";

/** Apps Okara reads through Maton. */
export const MATON_USED_APPS = ["google-sheets", "google-search-console"] as const;
/** Apps reported by the key test (google-analytics-data: "available, not used yet"). */
export const MATON_LISTED_APPS = [...MATON_USED_APPS, "google-analytics-data"] as const;
export type MatonUsedApp = (typeof MATON_USED_APPS)[number];
export type MatonListedApp = (typeof MATON_LISTED_APPS)[number];

export const MATON_TIMEOUTS_MS = { ctrl: 10_000, sheets: 25_000, gsc: 30_000 } as const;
export const MATON_MAX_BYTES = { ctrl: 1024 * 1024, sheets: 24 * 1024 * 1024, gsc: 16 * 1024 * 1024 } as const;

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
export type MatonOp = "list_connections" | "sheets.get" | "sheets.values.get" | "gsc.sites.list" | "gsc.searchanalytics.query";

export interface MatonRoute {
  op: MatonOp;
  app: MatonUsedApp | null;
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
  throw new MatonPolicyError(`${m} ${MATON_GATEWAY_HOST}${path} is not allowed (only read-only Google Sheets and Search Console requests).`);
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
  const appName = route.app === "google-sheets" ? "Google Sheets" : route.app === "google-search-console" ? "Search Console" : "Maton";
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
