/**
 * DataForSEO API v3 client (docs/provider-contracts.md "DataForSEO Labs", verified 2026-10-02).
 *
 * Auth: HTTP Basic, `Authorization: Basic base64(login:password)` with the API login and API password from
 * https://app.dataforseo.com/api-access (https://docs.dataforseo.com/v3/auth/). Credentials go only in that
 * header, never in the URL. Base URL https://api.dataforseo.com/ (allowlisted in runs/runtime.ts).
 *
 * Endpoints used (all JSON; one task per Live call; `tasks[0].result[0]` holds the data):
 *  - GET  /v3/appendix/user_data                                    free; money.balance (credential test)
 *  - GET  /v3/dataforseo_labs/locations_and_languages               free; location/language codes
 *  - POST /v3/dataforseo_labs/google/ranked_keywords/live           paid; overview metrics + top keywords
 *  - POST /v3/dataforseo_labs/google/domain_intersection/live       paid; keyword gap (intersections: false)
 *  - POST /v3/dataforseo_labs/google/relevant_pages/live            paid; top pages by organic ETV
 * Cost: every response carries `cost` (total, USD) and `tasks[i].cost`; that value is recorded as the
 * actual cost. The published price below is only the reservation ceiling. Status: `status_code` 20000 = ok
 * at both the envelope and the task level; other codes are errors (https://docs.dataforseo.com/v3/appendix/errors/).
 *
 * Everything parsed out of a response is untrusted third-party text (keywords, URLs): clipped and stored as
 * plain data, never instructions. Response bodies are read with a byte cap.
 */
import type {
  CompetitorDataEndpoint,
  CompetitorGapRow,
  CompetitorKeywordRow,
  CompetitorLocationOption,
  CompetitorOverview,
  CompetitorPageRow,
  CompetitorRankBuckets,
} from "@shared/competitor-data";
import { readCapped } from "../lib/read-capped";

export const DATAFORSEO_API = "https://api.dataforseo.com";
export const DATAFORSEO_PROVIDER = "dataforseo";

/**
 * Published DataForSEO Labs Google price, "All other endpoints", Live mode: $0.012 per task + $0.00012 per
 * returned item (https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api, read 2026-10-02).
 * Used only to size budget reservations and to show an upper bound before a refresh; the recorded cost is
 * always the `cost` DataForSEO returns. Bump DATAFORSEO_RATE_VERSION when these change.
 */
export const DATAFORSEO_LABS_PRICE = {
  perTaskUsd: 0.012,
  perItemUsd: 0.00012,
  readOn: "2026-10-02",
  sourceUrl: "https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api",
} as const;
export const DATAFORSEO_RATE_VERSION = "dataforseo-labs-2026-10-02";

/** Item limits per task (each returned item is billed). */
export const DATAFORSEO_LIMITS = { topKeywords: 100, keywordGap: 100, topPages: 20 } as const;

export const ENDPOINT_PATHS: Record<CompetitorDataEndpoint, string> = {
  ranked_keywords: "/v3/dataforseo_labs/google/ranked_keywords/live",
  domain_intersection: "/v3/dataforseo_labs/google/domain_intersection/live",
  relevant_pages: "/v3/dataforseo_labs/google/relevant_pages/live",
};

export const ENDPOINT_ITEM_LIMIT: Record<CompetitorDataEndpoint, number> = {
  ranked_keywords: DATAFORSEO_LIMITS.topKeywords,
  domain_intersection: DATAFORSEO_LIMITS.keywordGap,
  relevant_pages: DATAFORSEO_LIMITS.topPages,
};

/** Ceiling for one task at the published price: per-task fee + item limit x per-item fee (USD). */
export function maxTaskCostUsd(endpoint: CompetitorDataEndpoint): number {
  return round6(DATAFORSEO_LABS_PRICE.perTaskUsd + ENDPOINT_ITEM_LIMIT[endpoint] * DATAFORSEO_LABS_PRICE.perItemUsd);
}

/** Ceiling for one refresh of one domain (all three tasks). */
export function maxRefreshCostUsd(): number {
  return round6((Object.keys(ENDPOINT_PATHS) as CompetitorDataEndpoint[]).reduce((s, e) => s + maxTaskCostUsd(e), 0));
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface DataForSeoCredentials {
  login: string;
  password: string;
}

/** `Authorization: Basic base64(login:password)` (RFC 7617; the login may not contain ':'). */
export function basicAuthHeader(c: DataForSeoCredentials): string {
  return `Basic ${btoa(`${c.login}:${c.password}`)}`;
}

/** Login/password field rules: 1-200 printable ASCII characters, no whitespace; the login has no ':'. */
export const CREDENTIAL_CHARS = /^[\x21-\x7e]+$/;

// ------------------------------------------------------------------ requests

/** Domain as DataForSEO wants it: hostname without scheme and without a leading "www.". */
export function targetDomain(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

export interface LabsLocale {
  locationCode: number;
  languageCode: string;
}

/**
 * Request bodies (one task per POST array). Fields as documented on each endpoint page; no clickstream
 * (doubles the price) and organic results only.
 */
export function requestBody(endpoint: CompetitorDataEndpoint, competitor: string, ownDomain: string, loc: LabsLocale): unknown[] {
  const base = { location_code: loc.locationCode, language_code: loc.languageCode };
  switch (endpoint) {
    case "ranked_keywords":
      return [
        {
          target: targetDomain(competitor),
          ...base,
          item_types: ["organic"],
          limit: DATAFORSEO_LIMITS.topKeywords,
          order_by: ["keyword_data.keyword_info.search_volume,desc"],
        },
      ];
    case "domain_intersection":
      // intersections: false -> keywords target1 ranks for and target2 does not (default order: search volume desc).
      return [
        {
          target1: targetDomain(competitor),
          target2: targetDomain(ownDomain),
          ...base,
          intersections: false,
          item_types: ["organic"],
          limit: DATAFORSEO_LIMITS.keywordGap,
        },
      ];
    case "relevant_pages":
      return [
        {
          target: targetDomain(competitor),
          ...base,
          item_types: ["organic"],
          limit: DATAFORSEO_LIMITS.topPages,
          order_by: ["metrics.organic.etv,desc"],
        },
      ];
  }
}

// ------------------------------------------------------------------ transport

/** Response size caps (bytes): Labs responses with 100 items are a few hundred KB. */
export const MAX_LABS_RESPONSE_BYTES = 6_000_000;
export const MAX_SMALL_RESPONSE_BYTES = 2_000_000;
export const LABS_TIMEOUT_MS = 25_000;
export const FREE_TIMEOUT_MS = 10_000;

export type CallOutcome =
  | {
      kind: "ok";
      /** tasks[0].result[0] (may be null when DataForSEO returned no result object). */
      result: Record<string, unknown> | null;
      /** tasks[0].result (every entry; locations_and_languages returns one entry per location). */
      results: unknown[];
      costUsd: number | null;
      taskId: string | null;
      latencyMs: number;
    }
  | {
      /** DataForSEO answered with an error status (envelope or task). The call happened; cost from the body if any. */
      kind: "api_error";
      httpStatus: number;
      statusCode: number | null;
      message: string;
      costUsd: number | null;
      taskId: string | null;
      latencyMs: number;
    }
  | {
      /** Network error, timeout, oversized or unparseable body: whether DataForSEO billed it is unknown. */
      kind: "unknown";
      timeout: boolean;
      message: string;
      latencyMs: number;
    }
  | {
      /** The request never left (blocked by the outbound allowlist). */
      kind: "not_sent";
      message: string;
    };

interface Envelope {
  status_code?: unknown;
  status_message?: unknown;
  cost?: unknown;
  tasks?: Array<{ id?: unknown; status_code?: unknown; status_message?: unknown; cost?: unknown; result?: unknown }>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Plain-text DataForSEO status message, clipped (untrusted). */
function statusText(code: number | null, message: unknown): string {
  const m = str(message, 200);
  return `DataForSEO ${code ?? "error"}${m ? `: ${m}` : ""}`;
}

/** Cost of the call from the envelope: top-level `cost`, else tasks[0].cost; null when absent. */
function envelopeCost(env: Envelope): number | null {
  return num(env.cost) ?? num(env.tasks?.[0]?.cost);
}

/**
 * One DataForSEO request through the allowlisted fetch. Never throws for HTTP/network problems: the
 * outcome says whether the call happened (and so whether a reservation must be settled, kept or released).
 */
export async function dataForSeoRequest(
  fetchImpl: typeof fetch,
  creds: DataForSeoCredentials,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  opts: { timeoutMs: number; maxBytes: number; now?: () => number },
): Promise<CallOutcome> {
  const now = opts.now ?? Date.now;
  const started = now();
  let res: Response;
  try {
    res = await fetchImpl(`${DATAFORSEO_API}${path}`, {
      method,
      headers: {
        Authorization: basicAuthHeader(creds),
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    if (name === "OutboundBlockedError" || (e instanceof Error && /Outbound request blocked/.test(e.message))) {
      return { kind: "not_sent", message: "Outbound request blocked by the provider allowlist." };
    }
    const timeout = name === "TimeoutError" || name === "AbortError";
    return { kind: "unknown", timeout, message: timeout ? "DataForSEO did not answer in time." : "Could not reach DataForSEO (network error).", latencyMs: now() - started };
  }
  const latencyMs = () => now() - started;
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "api_error", httpStatus: res.status, statusCode: null, message: `DataForSEO answered with a redirect (HTTP ${res.status}); not followed.`, costUsd: null, taskId: null, latencyMs: latencyMs() };
  }
  let text: string | null;
  try {
    text = await readCapped(res, opts.maxBytes);
  } catch {
    return { kind: "unknown", timeout: true, message: "DataForSEO response could not be read (timeout or connection reset).", latencyMs: latencyMs() };
  }
  if (text === null) return { kind: "unknown", timeout: false, message: "DataForSEO response was larger than the allowed size.", latencyMs: latencyMs() };
  let env: Envelope | null = null;
  try {
    env = JSON.parse(text) as Envelope;
  } catch {
    env = null;
  }
  if (!env || typeof env !== "object") {
    if (res.status === 401 || res.status === 403) {
      return { kind: "api_error", httpStatus: res.status, statusCode: null, message: `Credentials rejected by DataForSEO (HTTP ${res.status}).`, costUsd: null, taskId: null, latencyMs: latencyMs() };
    }
    // A 2xx with an unreadable body: the task may have run and been billed.
    if (res.ok) return { kind: "unknown", timeout: false, message: "DataForSEO returned an unreadable response.", latencyMs: latencyMs() };
    return { kind: "api_error", httpStatus: res.status, statusCode: null, message: `DataForSEO returned HTTP ${res.status}.`, costUsd: null, taskId: null, latencyMs: latencyMs() };
  }
  const code = int(env.status_code);
  const task = env.tasks?.[0];
  const taskId = str(task?.id, 64);
  const cost = envelopeCost(env);
  if (!res.ok || code !== 20000) {
    return { kind: "api_error", httpStatus: res.status, statusCode: code, message: statusText(code, env.status_message), costUsd: cost, taskId, latencyMs: latencyMs() };
  }
  const taskCode = int(task?.status_code);
  if (!task || taskCode !== 20000) {
    return { kind: "api_error", httpStatus: res.status, statusCode: taskCode, message: statusText(taskCode, task?.status_message), costUsd: cost, taskId, latencyMs: latencyMs() };
  }
  const results = Array.isArray(task.result) ? (task.result as unknown[]) : [];
  return { kind: "ok", result: obj(results[0]), results, costUsd: cost, taskId, latencyMs: latencyMs() };
}

/** Plain-language message for well-known DataForSEO status codes (errors appendix), else the clipped status text. */
export function describeApiError(o: Extract<CallOutcome, { kind: "api_error" }>): string {
  switch (o.statusCode) {
    case 40100:
      return "DataForSEO rejected the credentials (40100). Check the API login and API password.";
    case 40104:
      return "The DataForSEO account must be verified before using the API (40104).";
    case 40200:
    case 40210:
      return `The DataForSEO account balance is too low (${o.statusCode}). Top up the account to continue.`;
    case 40202:
      return "DataForSEO per-minute rate limit exceeded (40202). Try again shortly.";
    case 40203:
      return "The DataForSEO account's cost limit was exceeded (40203). Raise it in the DataForSEO dashboard.";
    case 40204:
      return "This DataForSEO account has no access to DataForSEO Labs (40204).";
    case 40207:
      return "DataForSEO refused the request: the server IP is not whitelisted for this account (40207).";
    case 40209:
      return "Too many simultaneous DataForSEO requests (40209). Try again shortly.";
    default:
      if (o.httpStatus === 401 || o.httpStatus === 403) return `Credentials rejected by DataForSEO (HTTP ${o.httpStatus}).`;
      return o.message;
  }
}

// ------------------------------------------------------------------ free endpoints

/** Credential test: GET /v3/appendix/user_data (free). Reports the balance (money.balance, USD). */
export async function testCredentials(
  fetchImpl: typeof fetch,
  creds: DataForSeoCredentials,
): Promise<{ ok: boolean | null; detail: string; balanceUsd: number | null }> {
  const out = await dataForSeoRequest(fetchImpl, creds, "GET", "/v3/appendix/user_data", undefined, { timeoutMs: FREE_TIMEOUT_MS, maxBytes: MAX_SMALL_RESPONSE_BYTES });
  if (out.kind === "ok") {
    const money = obj(out.result?.money);
    const balance = num(money?.balance);
    return {
      ok: true,
      detail: balance === null ? "Credentials accepted (user_data request succeeded)." : `Credentials accepted. Balance $${balance.toFixed(2)} at test time.`,
      balanceUsd: balance,
    };
  }
  if (out.kind === "api_error") {
    if (out.statusCode === 40202 || out.statusCode === 40209 || out.httpStatus === 429) {
      return { ok: null, detail: "DataForSEO rate-limited the test request; credentials not confirmed. Try again later.", balanceUsd: null };
    }
    return { ok: false, detail: describeApiError(out), balanceUsd: null };
  }
  return { ok: false, detail: out.message, balanceUsd: null };
}

/** GET /v3/dataforseo_labs/locations_and_languages (free): countries with their Google languages. */
export async function fetchLabsLocations(
  fetchImpl: typeof fetch,
  creds: DataForSeoCredentials,
): Promise<{ ok: true; locations: CompetitorLocationOption[]; costUsd: number | null; latencyMs: number; taskId: string | null } | { ok: false; outcome: Exclude<CallOutcome, { kind: "ok" }> }> {
  const out = await dataForSeoRequest(fetchImpl, creds, "GET", "/v3/dataforseo_labs/locations_and_languages", undefined, {
    timeoutMs: FREE_TIMEOUT_MS,
    maxBytes: MAX_SMALL_RESPONSE_BYTES,
  });
  if (out.kind !== "ok") return { ok: false, outcome: out };
  return { ok: true, locations: parseLocationRows(out.results), costUsd: out.costUsd, latencyMs: out.latencyMs, taskId: out.taskId };
}

export function parseLocationRows(rows: unknown[]): CompetitorLocationOption[] {
  const out: CompetitorLocationOption[] = [];
  for (const r of rows.slice(0, 500)) {
    const o = obj(r);
    const code = int(o?.location_code);
    const name = str(o?.location_name, 120);
    if (code === null || !name) continue;
    const langs: CompetitorLocationOption["languages"] = [];
    for (const l of Array.isArray(o?.available_languages) ? (o!.available_languages as unknown[]).slice(0, 50) : []) {
      const lo = obj(l);
      const sources = Array.isArray(lo?.available_sources) ? (lo!.available_sources as unknown[]) : [];
      const lc = str(lo?.language_code, 16);
      const ln = str(lo?.language_name, 80);
      if (!lc || !ln || !sources.includes("google")) continue;
      langs.push({ languageCode: lc, languageName: ln });
    }
    if (langs.length) out.push({ locationCode: code, locationName: name, countryIsoCode: str(o?.country_iso_code, 8), languages: langs });
  }
  return out.sort((a, b) => a.locationName.localeCompare(b.locationName));
}

// ------------------------------------------------------------------ parsers (tasks[0].result[0])

const BUCKET_KEYS: Array<keyof CompetitorRankBuckets> = [
  "pos_1",
  "pos_2_3",
  "pos_4_10",
  "pos_11_20",
  "pos_21_30",
  "pos_31_40",
  "pos_41_50",
  "pos_51_60",
  "pos_61_70",
  "pos_71_80",
  "pos_81_90",
  "pos_91_100",
];

function buckets(organic: Record<string, unknown> | null): CompetitorRankBuckets | null {
  if (!organic) return null;
  const out = {} as CompetitorRankBuckets;
  let any = false;
  for (const k of BUCKET_KEYS) {
    const v = int(organic[k]);
    out[k] = v ?? 0;
    if (v !== null) any = true;
  }
  return any ? out : null;
}

const items = (result: Record<string, unknown> | null): unknown[] => (Array.isArray(result?.items) ? (result!.items as unknown[]) : []);

/** Overview (result.metrics.organic) + top keywords (result.items) from ranked_keywords. */
export function parseRankedKeywords(result: Record<string, unknown> | null): { overview: CompetitorOverview; keywords: CompetitorKeywordRow[]; totalCount: number | null } {
  const organic = obj(obj(result?.metrics)?.organic);
  const totalCount = int(result?.total_count);
  const overview: CompetitorOverview = {
    organicKeywords: int(organic?.count),
    organicEtv: num(organic?.etv),
    estimatedPaidTrafficCost: num(organic?.estimated_paid_traffic_cost),
    buckets: buckets(organic),
    isNew: int(organic?.is_new),
    isUp: int(organic?.is_up),
    isDown: int(organic?.is_down),
    isLost: int(organic?.is_lost),
    totalCount,
  };
  const keywords: CompetitorKeywordRow[] = [];
  for (const it of items(result).slice(0, DATAFORSEO_LIMITS.topKeywords)) {
    const o = obj(it);
    const kd = obj(o?.keyword_data);
    const keyword = str(kd?.keyword, 200);
    if (!keyword) continue;
    const serp = obj(obj(o?.ranked_serp_element)?.serp_item);
    keywords.push({
      keyword,
      position: int(serp?.rank_group),
      searchVolume: int(obj(kd?.keyword_info)?.search_volume),
      url: str(serp?.url, 500),
      etv: num(serp?.etv),
    });
  }
  return { overview, keywords, totalCount };
}

/** Keyword gap rows from domain_intersection with intersections: false (first_domain_serp_element = competitor). */
export function parseDomainIntersection(result: Record<string, unknown> | null): { rows: CompetitorGapRow[]; totalCount: number | null } {
  const rows: CompetitorGapRow[] = [];
  for (const it of items(result).slice(0, DATAFORSEO_LIMITS.keywordGap)) {
    const o = obj(it);
    const kd = obj(o?.keyword_data);
    const keyword = str(kd?.keyword, 200);
    if (!keyword) continue;
    const info = obj(kd?.keyword_info);
    const first = obj(o?.first_domain_serp_element);
    rows.push({
      keyword,
      searchVolume: int(info?.search_volume),
      competitorPosition: int(first?.rank_group),
      competitorUrl: str(first?.url, 500),
      etv: num(first?.etv),
      keywordDifficulty: int(obj(kd?.keyword_properties)?.keyword_difficulty),
      cpc: num(info?.cpc),
    });
  }
  return { rows, totalCount: int(result?.total_count) };
}

/** Top pages from relevant_pages (page_address, metrics.organic). */
export function parseRelevantPages(result: Record<string, unknown> | null): { rows: CompetitorPageRow[]; totalCount: number | null } {
  const rows: CompetitorPageRow[] = [];
  for (const it of items(result).slice(0, DATAFORSEO_LIMITS.topPages)) {
    const o = obj(it);
    const url = str(o?.page_address, 500);
    if (!url) continue;
    const organic = obj(obj(o?.metrics)?.organic);
    const p1 = int(organic?.pos_1);
    const p23 = int(organic?.pos_2_3);
    rows.push({
      url,
      etv: num(organic?.etv),
      keywords: int(organic?.count),
      top3: p1 === null && p23 === null ? null : (p1 ?? 0) + (p23 ?? 0),
    });
  }
  return { rows, totalCount: int(result?.total_count) };
}
