/**
 * Workspace custom providers: an OpenAI-compatible endpoint (OpenRouter, Groq, Together, DeepSeek, Mistral,
 * a self-hosted gateway, ...) that the workspace owner adds with a base URL, an API key and a model id, and
 * selects as the workspace's writer (role 'writer'), or adds as a custom GEO engine lane (role 'geo', at most
 * 2; citation rate only for answers with provider-reported sources, else mention rate only; see geo/custom-lanes.ts). Table: workspace_custom_providers (migrations
 * 0010, 0011 adds `role`). A GEO row is never the writer.
 *
 * Safety rules (CLAUDE.md, build kit SSRF rules):
 *  - The base URL is validated before it is stored and again before every use: https only, no credentials,
 *    no IP literal (v4 or v6, any encoding), a public-looking hostname (has a dot, LDH labels, alphabetic or
 *    IDN TLD, not localhost / .local / .internal / .lan / .home.arpa / reserved test names / cluster
 *    service-discovery suffixes / loopback wildcard-DNS services, no IPv4 address spelled in the name),
 *    default port, no query or fragment, and never this app's own host (APP_ORIGIN). Names are not resolved:
 *    the residual risk (a public name pointing at a private address) is covered by Workers egress, which
 *    cannot reach private addresses (same note as seo/ssrf.ts).
 *  - Outbound requests go through the guarded API fetch (runs/runtime.ts createApiFetch) with only the
 *    provider's host added, `redirect: "manual"` (a 3xx is reported, never followed) and a timeout.
 *  - The key is stored with the AES-GCM envelope (lib/crypto.ts), AAD bound to workspace and row (NOT to the
 *    host), and is never returned, logged or exported. Provider response bodies are never echoed; model ids
 *    parsed from a model list are untrusted strings (clipped, control characters removed, rendered as plain
 *    text).
 *  - A saved key is sent only to the host it was saved for, unless the owner explicitly moves it: a PATCH to
 *    a new host needs a new key or `keepKeyForNewHost: true` (tunnel hosts such as *.trycloudflare.com change
 *    on every restart). Because the AAD binds workspace and row only, a kept key stays decryptable and bound
 *    to its row without re-encryption. Every change is recorded in workspace_custom_provider_changes
 *    (migration 0012: when, who, which fields, old/new host, whether the key was kept). At use, the URL, host,
 *    model and key are read in one statement (resolveCustomProviderRow), so a concurrent move can never pair
 *    the old host with a new key.
 *  - No prices are invented: custom-provider calls record cost as unknown (NULL).
 */
import type { CustomProviderChange, CustomProviderStatus } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { decryptSecret } from "../lib/crypto";
import { readCapped } from "../lib/read-capped";
import { classifyHost, normalizeHost } from "../seo/ssrf";

export const MAX_CUSTOM_PROVIDERS = 5;
export const CUSTOM_PROVIDER_TIMEOUT_MS = 10_000;
/** Model lists can be large (OpenRouter lists hundreds of models with descriptions); bounded read. */
export const MAX_MODEL_LIST_BYTES = 8 * 1024 * 1024;
export const MAX_MODELS_RETURNED = 500;
export const MAX_MODEL_ID_LENGTH = 200;
export const MAX_LABEL_LENGTH = 60;
export const MAX_BASE_URL_LENGTH = 300;
/** Upper bound on list entries inspected (a hostile list cannot make us loop forever). */
const MAX_MODEL_ENTRIES_SCANNED = 10_000;

export const customProviderAad = (workspaceId: string, id: string) => `workspace_custom_providers:${workspaceId}:${id}`;

/** True for "no such table" errors (code deployed before migration 0010 was applied). */
export function isMissingTableError(e: unknown): boolean {
  return /no such table/i.test(String((e as Error)?.message ?? e));
}

/**
 * True when workspace_custom_providers has no `role` column yet (code deployed before migration 0011). SQLite
 * (and D1) report a missing column as "no such column: role" in a SELECT / WHERE, but as "table ... has no
 * column named role" in an INSERT column list; both must take the pre-0011 fallback.
 */
export function isMissingRoleColumnError(e: unknown): boolean {
  return /no such column:?\s*"?role\b|has no column named "?role\b/i.test(String((e as Error)?.message ?? e));
}

// ------------------------------------------------------------------ base URL validation

export type BaseUrlRejectReason =
  | "invalid_url"
  | "too_long"
  | "not_https"
  | "credentials"
  | "port"
  | "query"
  | "ip_literal"
  | "local_host"
  | "not_public_host"
  | "own_origin";

export type BaseUrlCheck = { ok: true; baseUrl: string; host: string } | { ok: false; reason: BaseUrlRejectReason; message: string };

/**
 * Names that never resolve to a public provider: RFC 6761/6762/8375/9476 names, ICANN private-use .internal,
 * common LAN suffixes, cluster-internal service-discovery suffixes (Kubernetes .svc / .cluster, Consul,
 * Docker), and public wildcard-DNS services that resolve to loopback or to the IP spelled in the name
 * (nip.io, sslip.io, xip.io, localtest.me, lvh.me, vcap.me, localhost.direct).
 */
const NON_PUBLIC_SUFFIXES = [
  "localhost",
  "localdomain",
  "local",
  "internal",
  "lan",
  "home.arpa",
  "intranet",
  "corp",
  "home",
  "private",
  "test",
  "example",
  "invalid",
  "onion",
  "alt",
  "arpa",
  "svc",
  "cluster",
  "consul",
  "docker",
  "kube",
  "k8s",
  "nip.io",
  "sslip.io",
  "xip.io",
  "localtest.me",
  "lvh.me",
  "vcap.me",
  "localhost.direct",
];

/**
 * A hostname that spells an IPv4 address in four dot- or dash-separated groups (127.0.0.1.example.com,
 * 10-0-0-1.example.com): the convention of wildcard-DNS services that resolve such names to that address.
 */
const EMBEDDED_IPV4 = /(?:^|[.-])(?:\d{1,3}[.-]){3}\d{1,3}(?:[.-]|$)/;
/**
 * Actionable: random ngrok names for IPv4 clients have the form <hex>-<a>-<b>-<c>-<d>.ngrok-free.app and are
 * refused by the rule above like any name with an embedded IPv4 address.
 */
export const EMBEDDED_IPV4_MESSAGE =
  "Base URL must not be a hostname that spells an IP address (wildcard-DNS services resolve such names to that address). ngrok tunnel names are allowed.";

/**
 * ngrok's random names for IPv4 clients embed the client's address (<hex>-a-b-c-d.ngrok-free.app), but ngrok's
 * wildcard DNS answers every such name with ngrok's own edge addresses, never the embedded one (checked
 * 2026-10-01 via dns.google: 7c3e-103-21-58-191.ngrok-free.app and 127-0-0-1.ngrok-free.app both resolve
 * to ngrok edge IPs). So for exactly one label under these ngrok domains the embedded-IP rule is lifted.
 */
const NGROK_TUNNEL_SUFFIXES = [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.io"];
export function isNgrokTunnelHost(host: string): boolean {
  const suffix = NGROK_TUNNEL_SUFFIXES.find((x) => host.endsWith(x));
  if (!suffix) return false;
  const label = host.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".");
}

const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Endpoint suffixes people paste by mistake; the base URL is what precedes them. */
const ENDPOINT_SUFFIXES = ["/chat/completions", "/completions", "/models"];

const reject = (reason: BaseUrlRejectReason, message: string): BaseUrlCheck => ({ ok: false, reason, message });

/**
 * Validate and normalise a custom provider base URL. The result has no trailing slash, no query, no
 * fragment, a lowercase punycode host, and is what `/models` and `/chat/completions` are appended to.
 */
export function validateCustomBaseUrl(raw: unknown, appOrigin?: string | null): BaseUrlCheck {
  if (typeof raw !== "string" || !raw.trim()) return reject("invalid_url", "Enter the provider's base URL, e.g. https://openrouter.ai/api/v1.");
  const input = raw.trim();
  if (input.length > MAX_BASE_URL_LENGTH) return reject("too_long", `Base URL must be at most ${MAX_BASE_URL_LENGTH} characters.`);
  if (/[\x00-\x20\x7f]/.test(input)) return reject("invalid_url", "Base URL must not contain spaces or control characters.");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return reject("invalid_url", "Base URL is not a valid URL.");
  }
  if (url.protocol !== "https:") return reject("not_https", "Base URL must use https://.");
  if (url.username || url.password) return reject("credentials", "Base URL must not contain a user name or password; put the key in the API key field.");
  // The WHATWG parser already drops an explicit default port (":443"), so any port left is non-default.
  if (url.port !== "") return reject("port", "Base URL must use the default https port (443).");
  if (url.search || url.hash || input.includes("?") || input.includes("#")) return reject("query", "Base URL must not contain a query string or fragment.");

  const host = normalizeHost(url.hostname);
  const cls = classifyHost(host);
  // Any IP literal is refused, public or not: a provider is addressed by name (and the parser has already
  // turned decimal/octal/hex IPv4 forms into dotted quads, which classifyHost also parses loosely).
  if (cls.kind !== "name") return reject("ip_literal", "Base URL must use a hostname, not an IP address.");
  const labels = host.split(".");
  if (host === "localhost" || labels.length < 2 || NON_PUBLIC_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return reject("local_host", "Base URL must be a public hostname (local and private network names are refused).");
  }
  // Names are never resolved here (Workers egress cannot reach private addresses, as for the crawler in
  // seo/ssrf.ts); this refuses the names that are well known to resolve to the address they spell.
  if (EMBEDDED_IPV4.test(host) && !isNgrokTunnelHost(host)) return reject("local_host", EMBEDDED_IPV4_MESSAGE);
  if (!labels.every((l) => LDH_LABEL.test(l)) || !TLD.test(labels[labels.length - 1]!)) {
    return reject("not_public_host", "Base URL must be a public hostname with a valid top-level domain.");
  }
  if (appOrigin) {
    let own: string | null = null;
    try {
      own = normalizeHost(new URL(appOrigin).hostname);
    } catch {
      own = null;
    }
    if (own && own === host) return reject("own_origin", "Base URL must not point at this app.");
  }

  let path = url.pathname.replace(/\/+$/, "");
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, -suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  if (path.length > 200) return reject("too_long", "Base URL path is too long.");
  return { ok: true, baseUrl: `https://${host}${path}`, host };
}

// ------------------------------------------------------------------ field cleaning

/** Model id as typed or picked: trimmed, 1-200 characters, no control characters. null when invalid. */
export function cleanModelId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > MAX_MODEL_ID_LENGTH || /[\x00-\x1f\x7f]/.test(v)) return null;
  return v;
}

/** Display label: whitespace collapsed, control characters removed, at most 60 characters. null when empty. */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  if (!v) return null;
  return v.slice(0, MAX_LABEL_LENGTH);
}

// ------------------------------------------------------------------ model list

export interface ModelListResult {
  /**
   * true: the model list request succeeded (the key was not rejected; some providers list models without
   * checking the key, so this is not proof the key works); false: rejected, failed, or the answer was not a
   * model list (wrong base URL); null: not confirmed (rate limited).
   */
  ok: boolean | null;
  detail: string;
  /** Untrusted model ids from the provider, deduped, sorted, at most 500, each at most 200 characters. */
  models: string[];
  /** Distinct usable ids the provider listed (before the 500 cap). */
  total: number;
  truncated: boolean;
}

/**
 * Model ids from a /models body. Accepts the OpenAI shape `{data: [{id}]}`, `{models: [{id | name}]}`
 * (Ollama-style gateways) and a bare array of objects or strings (Together). Ids longer than 200
 * characters or with control characters are dropped (they could not be saved as a model id anyway).
 * `recognized` is true only when the body has one of those shapes (an array, or an object with a `data` or
 * `models` array); anything else (an HTML page, `{error: ...}`) is not a model list.
 */
export function extractModelIds(json: unknown): { ids: string[]; total: number; truncated: boolean; recognized: boolean } {
  let items: unknown[] = [];
  let recognized = false;
  if (Array.isArray(json)) {
    items = json;
    recognized = true;
  } else if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o.data)) {
      items = o.data;
      recognized = true;
    } else if (Array.isArray(o.models)) {
      items = o.models;
      recognized = true;
    }
  }
  const seen = new Set<string>();
  for (const it of items.slice(0, MAX_MODEL_ENTRIES_SCANNED)) {
    let raw: unknown = null;
    if (typeof it === "string") raw = it;
    else if (it && typeof it === "object") {
      const r = it as Record<string, unknown>;
      raw = typeof r.id === "string" ? r.id : typeof r.name === "string" ? r.name : typeof r.model === "string" ? r.model : null;
    }
    const id = cleanModelId(raw);
    if (id) seen.add(id);
  }
  const sorted = [...seen].sort((a, b) => {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  return { ids: sorted.slice(0, MAX_MODELS_RETURNED), total: sorted.length, truncated: sorted.length > MAX_MODELS_RETURNED, recognized };
}

/**
 * GET {baseUrl}/models with the key as a Bearer token. `fetchImpl` must be the guarded API fetch with the
 * provider's host admitted. 10 s timeout covering headers and body; a 3xx is reported, never followed; the
 * provider's response body is never echoed (only parsed model ids are returned). A 2xx answer that is not an
 * OpenAI-style model list (for example a web page because the base URL lacks /v1, or `{error: ...}`) is a
 * failure, never "key accepted"; and a model list only shows that the key was not rejected.
 */
export async function fetchModelList(fetchImpl: typeof fetch, baseUrl: string, apiKey: string, timeoutMs = CUSTOM_PROVIDER_TIMEOUT_MS): Promise<ModelListResult> {
  const fail = (ok: boolean | null, detail: string): ModelListResult => ({ ok, detail, models: [], total: 0, truncated: false });
  const notRejected = (detail: string): ModelListResult => ({ ok: true, detail, models: [], total: 0, truncated: false });
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return fail(false, "Could not reach the provider (network error or timeout).");
  }
  const discard = () => res.body?.cancel().catch(() => undefined);
  if (res.status >= 300 && res.status < 400) {
    await discard();
    return fail(false, `Provider answered with a redirect (HTTP ${res.status}); not followed. Check the base URL.`);
  }
  if (res.status === 401 || res.status === 403) {
    await discard();
    return fail(false, `Key rejected by provider (HTTP ${res.status}).`);
  }
  if (res.status === 429) {
    await discard();
    return fail(null, "Provider rate-limited the request; key not confirmed. Try again later.");
  }
  if (!res.ok) {
    await discard();
    return fail(
      false,
      res.status === 404
        ? "Provider returned HTTP 404 for the model list (check the base URL, e.g. it may need /v1; some providers have no model list, then type a model id)."
        : `Provider returned HTTP ${res.status}.`,
    );
  }
  let text: string | null;
  try {
    text = await readCapped(res, MAX_MODEL_LIST_BYTES);
  } catch {
    return notRejected("The key was not rejected, but the model list could not be read (network error or timeout); type a model id.");
  }
  if (text === null) return notRejected("The key was not rejected, but the model list is too large to read; type a model id.");
  const notAList = fail(
    false,
    `The provider answered HTTP ${res.status}, but the response is not an OpenAI-style model list. Check the base URL (it usually ends in /v1, e.g. https://openrouter.ai/api/v1).`,
  );
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return notAList;
  }
  const { ids, total, truncated, recognized } = extractModelIds(json);
  if (!recognized) return notAList;
  if (ids.length === 0) return notRejected("Model list received, but it has no model ids; the key was not rejected. Type a model id.");
  return {
    ok: true,
    detail: truncated
      ? `Model list received (${total} models, showing the first ${MAX_MODELS_RETURNED}); the key was not rejected.`
      : `Model list received (${total} model${total === 1 ? "" : "s"}); the key was not rejected.`,
    models: ids,
    total,
    truncated,
  };
}

export interface CustomProviderTestResult {
  ok: boolean | null;
  detail: string;
  /**
   * Whether the saved model id is in the provider's model list: true listed; false not in a complete list
   * (the UI offers "Change model", e.g. after a tunnel URL moved to another machine); null unknown (no list,
   * a truncated list, or the request failed).
   */
  modelListed: boolean | null;
}

/** Test-button semantics (same as the other key tests), plus whether the saved model is listed. */
export async function testCustomProvider(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  model: string,
  finalCheck = "the first draft",
): Promise<CustomProviderTestResult> {
  const r = await fetchModelList(fetchImpl, baseUrl, apiKey);
  if (r.ok !== true) return { ok: r.ok, detail: r.detail, modelListed: null };
  let detail = `Model list request succeeded; the key was not rejected (some providers list models without checking the key, so ${finalCheck} is the final check).`;
  let modelListed: boolean | null = null;
  if (r.models.includes(model)) {
    detail += " The saved model is listed.";
    modelListed = true;
  } else if (r.models.length > 0 && !r.truncated) {
    detail += ` The saved model id is not in the provider's model list; check it.`;
    modelListed = false;
  }
  return { ok: true, detail, modelListed };
}

// ------------------------------------------------------------------ rows

export type CustomProviderRole = "writer" | "geo";

/** Most custom GEO engine lanes (role 'geo') per workspace; counted separately from writer rows. */
export const MAX_CUSTOM_GEO_ENGINES = 2;

export interface CustomProviderRow {
  id: string;
  workspace_id: string;
  role: CustomProviderRole;
  label: string;
  base_url: string;
  host: string;
  model: string;
  key_hint: string;
  is_writer: number;
  last_tested_at: string | null;
  last_test_ok: number | null;
  last_test_detail: string | null;
  created_at: string;
  updated_at: string;
}

/** Columns selected everywhere a row leaves the database without its key. */
export const CUSTOM_PROVIDER_COLUMNS =
  "id, workspace_id, role, label, base_url, host, model, key_hint, is_writer, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at";
/** The same columns before migration 0011 (every row was a writer). */
const LEGACY_COLUMNS =
  "id, workspace_id, 'writer' AS role, label, base_url, host, model, key_hint, is_writer, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at";

/**
 * Run a query that selects provider columns and may filter by role, falling back to the pre-0011 schema (no
 * role column: every row is a writer) so the writer keeps working when code is deployed before the
 * migration. `roleIs(r)` is an SQL condition on the role; `r` is always one of the two fixed literals.
 */
export async function withRoleColumns<T>(fn: (columns: string, roleIs: (r: CustomProviderRole) => string) => Promise<T>): Promise<T> {
  try {
    return await fn(CUSTOM_PROVIDER_COLUMNS, (r) => `role = '${r === "geo" ? "geo" : "writer"}'`);
  } catch (e) {
    if (!isMissingRoleColumnError(e)) throw e;
    return fn(LEGACY_COLUMNS, (r) => (r === "geo" ? "0 = 1" : "1 = 1"));
  }
}

export function toCustomProviderStatus(row: CustomProviderRow, changes: CustomProviderChange[] = []): CustomProviderStatus {
  return {
    id: row.id,
    role: row.role === "geo" ? "geo" : "writer",
    label: row.label,
    baseUrl: row.base_url,
    host: row.host,
    model: row.model,
    keyHint: row.key_hint,
    isWriter: row.is_writer === 1,
    lastTestedAt: row.last_tested_at,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    lastTestDetail: row.last_test_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    changes,
  };
}

// ------------------------------------------------------------------ change log (migration 0012)

/** Changes returned per provider (newest first). */
export const CUSTOM_PROVIDER_CHANGES_SHOWN = 5;

export type CustomProviderChangeField = CustomProviderChange["fields"][number];
const FIELD_COLUMN: Record<CustomProviderChangeField, string> = { label: "label", baseUrl: "base_url", model: "model", apiKey: "api_key" };
const COLUMN_FIELD: Record<string, CustomProviderChangeField> = { label: "label", base_url: "baseUrl", model: "model", api_key: "apiKey" };

export interface CustomProviderChangeRecord {
  workspaceId: string;
  providerId: string;
  changedBy: string | null;
  changedAt: string;
  fields: CustomProviderChangeField[];
  /** Base URLs and hosts before and after; recorded only when the base URL changed. */
  from: { baseUrl: string; host: string } | null;
  to: { baseUrl: string; host: string } | null;
  keyKeptForNewHost: boolean;
}

/** INSERT statement for one change (no key material), for a db.batch together with the UPDATE. */
export function customProviderChangeStatement(id: string, r: CustomProviderChangeRecord): [string, ...unknown[]] {
  return [
    `INSERT INTO workspace_custom_provider_changes
       (id, workspace_id, provider_id, changed_by, changed_at, fields, old_base_url, new_base_url, old_host, new_host, key_kept_for_new_host)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    r.workspaceId,
    r.providerId,
    r.changedBy,
    r.changedAt,
    r.fields.map((f) => FIELD_COLUMN[f]).join(","),
    r.from?.baseUrl ?? null,
    r.to?.baseUrl ?? null,
    r.from?.host ?? null,
    r.to?.host ?? null,
    r.keyKeptForNewHost ? 1 : 0,
  ];
}

interface ChangeRow {
  provider_id: string;
  changed_at: string;
  fields: string;
  old_base_url: string | null;
  new_base_url: string | null;
  old_host: string | null;
  new_host: string | null;
  key_kept_for_new_host: number;
  name: string | null;
  email: string | null;
}

/**
 * The newest CUSTOM_PROVIDER_CHANGES_SHOWN changes of each of the workspace's custom providers, newest first.
 * Empty before migration 0012 (the change log is informational; it never blocks the provider routes).
 */
export async function listCustomProviderChanges(db: Db, workspaceId: string): Promise<Map<string, CustomProviderChange[]>> {
  const out = new Map<string, CustomProviderChange[]>();
  let rows: ChangeRow[];
  try {
    rows = await db.all<ChangeRow>(
      `SELECT provider_id, changed_at, fields, old_base_url, new_base_url, old_host, new_host, key_kept_for_new_host, name, email
         FROM (
           SELECT ch.provider_id, ch.changed_at, ch.fields, ch.old_base_url, ch.new_base_url, ch.old_host, ch.new_host,
                  ch.key_kept_for_new_host, u.name, u.email,
                  ROW_NUMBER() OVER (PARTITION BY ch.provider_id ORDER BY ch.changed_at DESC, ch.rowid DESC) AS n
             FROM workspace_custom_provider_changes ch
             LEFT JOIN users u ON u.id = ch.changed_by
            WHERE ch.workspace_id = ?
         )
        WHERE n <= ${CUSTOM_PROVIDER_CHANGES_SHOWN}
        ORDER BY provider_id, n`,
      workspaceId,
    );
  } catch (e) {
    if (isMissingTableError(e)) return out;
    throw e;
  }
  for (const r of rows) {
    const list = out.get(r.provider_id) ?? [];
    list.push({
      at: r.changed_at,
      by: r.name || r.email || null,
      fields: r.fields
        .split(",")
        .map((f) => COLUMN_FIELD[f])
        .filter((f): f is CustomProviderChangeField => f !== undefined),
      fromBaseUrl: r.old_base_url,
      toBaseUrl: r.new_base_url,
      fromHost: r.old_host,
      toHost: r.new_host,
      keyKeptForNewHost: r.key_kept_for_new_host === 1,
    });
    out.set(r.provider_id, list);
  }
  return out;
}

/** Every custom provider of the workspace (writers and GEO engines), oldest first. */
export async function listCustomProviders(db: Db, workspaceId: string): Promise<CustomProviderRow[]> {
  return withRoleColumns((cols) =>
    db.all<CustomProviderRow>(
      `SELECT ${cols} FROM workspace_custom_providers WHERE workspace_id = ? ORDER BY created_at, id LIMIT ${(MAX_CUSTOM_PROVIDERS + MAX_CUSTOM_GEO_ENGINES) * 2}`,
      workspaceId,
    ),
  );
}

/** The workspace's custom GEO engines (role 'geo'), oldest first; [] before migrations 0010/0011. No decryption. */
export async function listCustomGeoEngines(db: Db, workspaceId: string): Promise<CustomProviderRow[]> {
  try {
    return await withRoleColumns((cols, roleIs) =>
      db.all<CustomProviderRow>(
        `SELECT ${cols} FROM workspace_custom_providers WHERE workspace_id = ? AND ${roleIs("geo")} ORDER BY created_at, id LIMIT ${MAX_CUSTOM_GEO_ENGINES}`,
        workspaceId,
      ),
    );
  } catch (e) {
    if (isMissingTableError(e)) return [];
    throw e;
  }
}

/** The workspace's selected custom writer, without decrypting anything. null = the default writer (or no table yet). */
export async function selectedCustomWriter(db: Db, workspaceId: string): Promise<CustomProviderRow | null> {
  try {
    return await withRoleColumns((cols, roleIs) =>
      db.first<CustomProviderRow>(
        `SELECT ${cols} FROM workspace_custom_providers WHERE workspace_id = ? AND is_writer = 1 AND ${roleIs("writer")}`,
        workspaceId,
      ),
    );
  } catch (e) {
    if (isMissingTableError(e)) return null;
    throw e;
  }
}

export interface ResolvedCustomProvider {
  id: string;
  label: string;
  baseUrl: string;
  host: string;
  model: string;
  key: string;
}

export type CustomWriterResolution =
  | { status: "none" }
  | { status: "ready"; provider: ResolvedCustomProvider }
  /** Selected but unusable (stored URL no longer validates, or the key cannot be decrypted). Never falls back. */
  | { status: "unusable"; id: string; label: string; host: string; model: string; detail: string };

export type CustomProviderUse =
  | { status: "ready"; provider: ResolvedCustomProvider }
  | { status: "unusable"; id: string; label: string; host: string; model: string; detail: string };

/**
 * Re-validate a saved row and decrypt its key (writer or GEO engine). Never falls back to anything else.
 *
 * Only `row.id` is used from the row passed in: the base URL, host, model, label and key are read together in
 * ONE statement and validated as read. The row may have been read earlier (listCustomGeoEngines in
 * buildRunContext, selectedCustomWriter) and a PATCH may have moved the provider to a new host with a new key
 * since; pairing the stale host with the fresh key would send the new key to the old host (with tunnels, a
 * name that may now belong to someone else). null when the row no longer exists.
 */
export async function resolveCustomProviderRow(env: Env, db: Db, workspaceId: string, row: Pick<CustomProviderRow, "id">): Promise<CustomProviderUse | null> {
  const fresh = await db.first<{ label: string; base_url: string; host: string; model: string; key_enc: string }>(
    "SELECT label, base_url, host, model, key_enc FROM workspace_custom_providers WHERE workspace_id = ? AND id = ?",
    workspaceId,
    row.id,
  );
  if (!fresh) return null;
  const base = { id: row.id, label: fresh.label, host: fresh.host, model: fresh.model };
  const check = validateCustomBaseUrl(fresh.base_url, env.APP_ORIGIN);
  if (!check.ok || check.host !== fresh.host) {
    return { status: "unusable", ...base, detail: `The saved base URL is no longer accepted (${check.ok ? "host mismatch" : check.message}). Re-enter it.` };
  }
  const model = cleanModelId(fresh.model);
  if (!model) return { status: "unusable", ...base, detail: "The saved model id is invalid. Choose a model again." };
  let key: string;
  try {
    key = await decryptSecret(env, fresh.key_enc, customProviderAad(workspaceId, row.id));
  } catch {
    return { status: "unusable", ...base, detail: "The saved API key could not be decrypted. Re-enter it." };
  }
  return { status: "ready", provider: { id: row.id, label: fresh.label, baseUrl: check.baseUrl, host: check.host, model, key } };
}

/**
 * The selected custom writer with its decrypted key, re-validated before use. When a custom writer is
 * selected but unusable, callers report setup_required instead of silently switching to the default writer
 * (which could send the workspace's evidence to a different provider and spend operator budget).
 */
export async function resolveCustomWriter(env: Env, db: Db, workspaceId: string): Promise<CustomWriterResolution> {
  const row = await selectedCustomWriter(db, workspaceId);
  if (!row) return { status: "none" };
  return (await resolveCustomProviderRow(env, db, workspaceId, row)) ?? { status: "none" };
}
