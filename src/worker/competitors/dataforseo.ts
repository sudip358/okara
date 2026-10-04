/**
 * Competitor data from DataForSEO Labs (docs/api.md "Competitor data (DataForSEO)").
 *
 * One refresh of one competitor domain = three paid Live tasks (providers/dataforseo.ts):
 *   ranked_keywords (overview metrics + top 100 keywords), domain_intersection with intersections:false
 *   (keyword gap vs the project's own domain, top 100), relevant_pages (top 20 pages by organic ETV).
 * Flow:
 *   enqueueFetch()  inserts a 'queued' row, atomically bounded by the daily caps and at most one active
 *                   (queued/running) refresh per (project, domain) (partial unique index).
 *   processFetch()  claims it ('running'), resolves credentials (workspace > operator) and the Labs location
 *                   (settings, else the project locale mapped through the free locations_and_languages list),
 *                   reserves provider_calls 1 + usd_micros (published-price ceiling) per task up front (all or
 *                   nothing; global operator caps when the operator's credentials are used), runs the three
 *                   tasks in parallel with a timeout each, records every call in provider_calls with the cost
 *                   DataForSEO returned (actual, not estimate), settles the reservations to that cost, stores
 *                   the parsed bounded results in competitor_snapshots and prunes old snapshots.
 * Scheduling (Workers-safe): the HTTP request only enqueues; work runs in ctx.waitUntil after the response
 * (at most INLINE_PROCESS_DOMAINS domains, i.e. <= 6 parallel subrequests, each with a 25 s timeout), and the
 * cron tick (index.ts, every 15 min) picks up anything still queued and fails refreshes stuck 'running'.
 * Many new domains at once ([A39], up to MAX_COMPETITORS = 60 competitors): onCompetitorsChanged queues the new
 * domains in the order given (sheet order for imports) up to what today's per-project cap still allows; the rest
 * are DEFERRED, not dropped: they wait in competitor_fetch_backlog (migration 0021) and the cron moves them into the
 * queue as the next UTC days' caps allow (drainFetchBacklog), so at most FETCHES_PER_PROJECT_PER_DAY refreshes
 * (manual + automatic) are made per project per day and spend stays bounded by the per-project budget as before.
 * Missing credentials -> no call, state setup_required, nothing queued or deferred. Nothing is ever simulated.
 */
import type { Competitor } from "@shared/types";
import type {
  CompetitorDataEndpoint,
  CompetitorDataPanel,
  CompetitorDomainDetail,
  CompetitorDomainSummary,
  CompetitorEndpointMeta,
  CompetitorFetchSummary,
  CompetitorGapRow,
  CompetitorKeywordRow,
  CompetitorLocation,
  CompetitorLocationOption,
  CompetitorOverview,
  CompetitorPageRow,
} from "@shared/competitor-data";
import type { Env } from "../env";
import { Db, parseJson } from "../lib/db";
import { BudgetExceededError } from "../lib/errors";
import { newId } from "../lib/ids";
import { addSeconds, iso, systemClock, utcDay, type Clock } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { dataForSeoSource, resolveDataForSeo, type ResolvedDataForSeo } from "../platform/dataforseo-credentials";
import { isMissingTableError } from "../platform/custom-providers";
import {
  DATAFORSEO_LABS_PRICE,
  DATAFORSEO_LIMITS,
  DATAFORSEO_PROVIDER,
  DATAFORSEO_RATE_VERSION,
  ENDPOINT_PATHS,
  LABS_TIMEOUT_MS,
  MAX_LABS_RESPONSE_BYTES,
  dataForSeoRequest,
  describeApiError,
  fetchLabsLocations,
  maxRefreshCostUsd,
  maxTaskCostUsd,
  parseDomainIntersection,
  parseRankedKeywords,
  parseRelevantPages,
  requestBody,
  targetDomain,
  type CallOutcome,
} from "../providers/dataforseo";
import { budgetForKeySource, createBudget } from "../runs/budget";
import { createCallRecorder } from "../runs/calls";
import type { Budget } from "../runs/context";
import { createApiFetch } from "../runs/runtime";

// ------------------------------------------------------------------ limits (engineering defaults)
/** Refreshes (manual + automatic) per competitor domain per UTC day. */
export const REFRESHES_PER_DOMAIN_PER_DAY = 2;
/** Refreshes per project per UTC day, all domains. */
export const FETCHES_PER_PROJECT_PER_DAY = 10;
/** Completed/partial refreshes whose snapshots are kept per (project, domain). */
export const KEEP_SNAPSHOTS_PER_DOMAIN = 3;
/** Refresh log rows kept per (project, domain) (>= the daily cap, so caps stay countable). */
export const KEEP_FETCH_LOG_PER_DOMAIN = 10;
/** Projects whose backlog the cron drains per tick (each moves at most today's remaining cap into the queue). */
export const BACKLOG_PROJECTS_PER_TICK = 5;
/** Backlog rows read per project per drain (>= the daily cap, so a whole day's share is always considered). */
export const BACKLOG_READ_PER_PROJECT = 25;
/** Domains processed right after a request (ctx.waitUntil); the rest wait for the cron tick. */
export const INLINE_PROCESS_DOMAINS = 2;
/** The cron picks up queued refreshes older than this (the request's waitUntil normally took them). */
export const QUEUED_PICKUP_SECONDS = 60;
/** A refresh 'running' this long was interrupted (isolate ended); it is marked failed. */
export const RUNNING_STALE_SECONDS = 600;
export const CRON_DOMAINS_PER_TICK = 4;
/** data_json ceiling per snapshot row (characters). */
export const MAX_SNAPSHOT_JSON_CHARS = 200_000;

export const ENDPOINTS: readonly CompetitorDataEndpoint[] = ["ranked_keywords", "domain_intersection", "relevant_pages"];
export const PURPOSE = "competitor_data";

export const DATA_SENT =
  "Competitor domains, your site's domain (for the keyword gap) and the project's location and language. No site content, Search Console data, context documents, or other credentials.";

export const NO_CREDENTIALS =
  "Add DataForSEO API credentials (API login and API password) on the Integrations page to pull competitor data.";

// ------------------------------------------------------------------ test hooks
let fetchOverride: typeof fetch | null = null;
/** Test hook: the base fetch behind the allowlisted API fetch (tests must never hit the network). */
export function setCompetitorDataFetch(f: typeof fetch | null) {
  fetchOverride = f;
}
export const baseFetch = (): typeof fetch => fetchOverride ?? ((input, init) => fetch(input, init));
export const apiFetchFor = (env: Env): typeof fetch => createApiFetch(env, baseFetch());

// ------------------------------------------------------------------ project helpers
export interface CompetitorDomain {
  competitorName: string;
  domain: string;
}

/** Every competitor domain of the project, normalized for DataForSEO (no scheme, no leading www.), deduped. */
export function competitorDomains(competitors: Competitor[]): CompetitorDomain[] {
  const seen = new Set<string>();
  const out: CompetitorDomain[] = [];
  for (const c of competitors) {
    for (const d of c.domains) {
      const domain = targetDomain(d);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      out.push({ competitorName: c.name, domain });
    }
  }
  return out;
}

export const projectCompetitors = (p: ProjectRow): Competitor[] => parseJson<Competitor[]>(p.competitors_json, []);

export function ownDomain(p: ProjectRow): string {
  let host = p.verified_host ?? "";
  if (!host) {
    try {
      host = new URL(p.site_url).hostname;
    } catch {
      host = "";
    }
  }
  return targetDomain(host);
}

/**
 * Domains present in `after` but in no competitor of `before`, in competitor order, or in `order` first when given
 * (e.g. the sheet's row order; domains not in `order` follow in competitor order). Never truncated: what does not
 * fit today's cap is deferred to the backlog, not dropped.
 */
export function addedCompetitorDomains(before: Competitor[], after: Competitor[], order: readonly string[] = []): CompetitorDomain[] {
  const old = new Set(competitorDomains(before).map((d) => d.domain));
  const added = competitorDomains(after).filter((d) => !old.has(d.domain));
  if (order.length === 0) return added;
  const rank = new Map<string, number>();
  order.forEach((d, i) => {
    const k = targetDomain(d);
    if (!rank.has(k)) rank.set(k, i);
  });
  return added
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (rank.get(a.d.domain) ?? order.length + a.i) - (rank.get(b.d.domain) ?? order.length + b.i))
    .map((x) => x.d);
}

// ------------------------------------------------------------------ cost estimate (import preview, chat cards)
export interface FetchEstimate {
  newDomains: number;
  perDomainUsd: number;
  maxUsd: number;
  perDay: number;
  /** UTC days needed at the per-project cap (ignoring refreshes already made today). */
  days: number;
  /** "N new competitor domains → up to N × $0.0624 DataForSEO (≈$X), fetched at most 10 per day" */
  text: string;
}

/** Per-domain ceiling: exact published price ("$0.0624"). */
const usdExact = (n: number) => `$${n.toFixed(4).replace(/(\.\d\d)(\d*?)0+$/, "$1$2")}`;
/** Approximate total, in cents ("≈$3.24"; never "$0.00" for a positive amount). */
const usdApprox = (n: number) => `$${(n > 0 && n < 0.01 ? 0.01 : n).toFixed(2)}`;

/** Published-price ceiling for refreshing `n` new competitor domains, and how the daily cap spreads them. */
export function estimateCompetitorFetch(n: number): FetchEstimate {
  const per = maxRefreshCostUsd();
  const max = Math.round(n * per * 1e4) / 1e4;
  const days = Math.ceil(n / FETCHES_PER_PROJECT_PER_DAY);
  const noun = n === 1 ? "domain" : "domains";
  return {
    newDomains: n,
    perDomainUsd: per,
    maxUsd: max,
    perDay: FETCHES_PER_PROJECT_PER_DAY,
    days,
    text: `${n} new competitor ${noun} → up to ${n} × ${usdExact(per)} DataForSEO (≈${usdApprox(max)}), fetched at most ${FETCHES_PER_PROJECT_PER_DAY} per day${days > 1 ? ` (about ${days} days)` : ""}`,
  };
}

// ------------------------------------------------------------------ location
/** Two-letter region subtag of a BCP 47 locale ("en-US" -> "US"); null when there is none. */
export function regionOf(locale: string): string | null {
  const parts = locale.trim().split(/[-_]/).slice(1);
  for (const p of parts) if (/^[A-Za-z]{2}$/.test(p)) return p.toUpperCase();
  return null;
}

/**
 * Map a project locale to a Labs location/language (Google source only). Exact language code first
 * ("pt-br"), then the primary subtag ("pt"). null when DataForSEO lists no such pair.
 */
export function matchLocation(options: CompetitorLocationOption[], locale: string, language: string): CompetitorLocation | null {
  const region = regionOf(locale);
  if (!region) return null;
  const loc = options.find((o) => (o.countryIsoCode ?? "").toUpperCase() === region);
  if (!loc) return null;
  const want = language.trim().toLowerCase();
  const primary = want.split(/[-_]/)[0] ?? want;
  const lang =
    loc.languages.find((l) => l.languageCode.toLowerCase() === want) ??
    loc.languages.find((l) => l.languageCode.toLowerCase() === primary) ??
    loc.languages.find((l) => (l.languageCode.toLowerCase().split(/[-_]/)[0] ?? "") === primary);
  if (!lang) return null;
  return { locationCode: loc.locationCode, locationName: loc.locationName, languageCode: lang.languageCode, languageName: lang.languageName };
}

interface SettingsRow {
  location_code: number | null;
  location_name: string | null;
  language_code: string | null;
  language_name: string | null;
  location_source: "auto" | "user" | null;
  resolved_for_locale: string | null;
  auto_fetch: number;
}

export async function loadSettings(db: Db, workspaceId: string, projectId: string): Promise<SettingsRow | null> {
  try {
    return await db.first<SettingsRow>(
      `SELECT location_code, location_name, language_code, language_name, location_source, resolved_for_locale, auto_fetch
         FROM competitor_data_settings WHERE workspace_id = ? AND project_id = ?`,
      workspaceId,
      projectId,
    );
  } catch (e) {
    if (isMissingTableError(e)) return null;
    throw e;
  }
}

const localeKey = (p: ProjectRow) => `${p.locale}|${p.language}`;

function settingsLocation(s: SettingsRow | null): CompetitorLocation | null {
  if (!s || s.location_code === null || !s.language_code) return null;
  return {
    locationCode: s.location_code,
    locationName: s.location_name ?? `Location ${s.location_code}`,
    languageCode: s.language_code,
    languageName: s.language_name ?? s.language_code,
  };
}

/** The stored location when it is still valid for the project (user choice, or auto for the current locale). */
export function usableLocation(s: SettingsRow | null, p: ProjectRow): CompetitorLocation | null {
  const loc = settingsLocation(s);
  if (!loc) return null;
  return s!.location_source === "user" || s!.resolved_for_locale === localeKey(p) ? loc : null;
}

export async function saveSettings(
  db: Db,
  p: ProjectRow,
  patch: { location?: CompetitorLocation | null; source?: "auto" | "user"; autoFetch?: boolean },
  userId: string | null,
  now: Date,
): Promise<void> {
  const cur = await loadSettings(db, p.workspace_id, p.id);
  const loc = patch.location !== undefined ? patch.location : settingsLocation(cur);
  const source = patch.location !== undefined ? (patch.location ? (patch.source ?? "user") : null) : (cur?.location_source ?? null);
  const resolvedFor = patch.location !== undefined ? (patch.location ? localeKey(p) : null) : (cur?.resolved_for_locale ?? null);
  const autoFetch = patch.autoFetch !== undefined ? patch.autoFetch : (cur?.auto_fetch ?? 1) === 1;
  await db.run(
    `INSERT INTO competitor_data_settings (project_id, workspace_id, location_code, location_name, language_code, language_name, location_source, resolved_for_locale, auto_fetch, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET location_code = excluded.location_code, location_name = excluded.location_name,
       language_code = excluded.language_code, language_name = excluded.language_name, location_source = excluded.location_source,
       resolved_for_locale = excluded.resolved_for_locale, auto_fetch = excluded.auto_fetch, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at
     WHERE competitor_data_settings.workspace_id = excluded.workspace_id`,
    p.id,
    p.workspace_id,
    loc?.locationCode ?? null,
    loc?.locationName ?? null,
    loc?.languageCode ?? null,
    loc?.languageName ?? null,
    source,
    resolvedFor,
    autoFetch ? 1 : 0,
    userId,
    iso(now),
  );
}

/** Message when the project locale cannot be mapped to a Labs location. */
export function unmappedLocaleMessage(p: ProjectRow): string {
  return `DataForSEO Labs has no location for the project locale "${p.locale}" / language "${p.language}". Choose a location and language for competitor data.`;
}

// ------------------------------------------------------------------ queue
export interface FetchRow {
  id: string;
  workspace_id: string;
  project_id: string;
  domain: string;
  trigger: "competitor_added" | "manual";
  status: CompetitorFetchSummary["status"];
  requested_by: string | null;
  location_code: number | null;
  language_code: string | null;
  cost_usd: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function toFetchSummary(r: FetchRow): CompetitorFetchSummary {
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    costUsd: r.cost_usd,
    error: r.error,
  };
}

const dayStart = (now: Date) => `${utcDay(now)}T00:00:00.000Z`;

export type EnqueueResult =
  | { kind: "queued"; fetch: FetchRow }
  | { kind: "existing"; fetch: FetchRow }
  | { kind: "capped"; scope: "domain" | "project"; message: string };

/**
 * Queue a refresh. One conditional INSERT: refused when the domain or project daily cap is reached
 * (setup_required rows never count: nothing was called), ignored when one is already queued/running.
 */
export async function enqueueFetch(
  db: Db,
  p: ProjectRow,
  domain: string,
  trigger: FetchRow["trigger"],
  userId: string | null,
  now: Date,
): Promise<EnqueueResult> {
  const id = newId("cfetch");
  const since = dayStart(now);
  const r = await db.run(
    `INSERT OR IGNORE INTO competitor_fetches (id, workspace_id, project_id, domain, trigger, status, requested_by, created_at)
     SELECT ?, ?, ?, ?, ?, 'queued', ?, ?
      WHERE (SELECT COUNT(*) FROM competitor_fetches WHERE workspace_id = ? AND project_id = ? AND domain = ? AND created_at >= ? AND status <> 'setup_required') < ?
        AND (SELECT COUNT(*) FROM competitor_fetches WHERE workspace_id = ? AND project_id = ? AND created_at >= ? AND status <> 'setup_required') < ?`,
    id,
    p.workspace_id,
    p.id,
    domain,
    trigger,
    userId,
    iso(now),
    p.workspace_id,
    p.id,
    domain,
    since,
    REFRESHES_PER_DOMAIN_PER_DAY,
    p.workspace_id,
    p.id,
    since,
    FETCHES_PER_PROJECT_PER_DAY,
  );
  if (r.changes === 1) return { kind: "queued", fetch: (await loadFetch(db, p.workspace_id, id))! };
  const active = await db.first<FetchRow>(
    `SELECT * FROM competitor_fetches WHERE workspace_id = ? AND project_id = ? AND domain = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC LIMIT 1`,
    p.workspace_id,
    p.id,
    domain,
  );
  if (active) return { kind: "existing", fetch: active };
  const counts = await todayCounts(db, p, now);
  if ((counts.byDomain.get(domain) ?? 0) >= REFRESHES_PER_DOMAIN_PER_DAY) {
    return { kind: "capped", scope: "domain", message: `Refresh limit reached for ${domain} (${REFRESHES_PER_DOMAIN_PER_DAY} per domain per UTC day).` };
  }
  return { kind: "capped", scope: "project", message: `Competitor data refresh limit reached for this project (${FETCHES_PER_PROJECT_PER_DAY} per UTC day).` };
}

export async function loadFetch(db: Db, workspaceId: string, id: string): Promise<FetchRow | null> {
  return db.first<FetchRow>("SELECT * FROM competitor_fetches WHERE workspace_id = ? AND id = ?", workspaceId, id);
}

async function todayCounts(db: Db, p: ProjectRow, now: Date): Promise<{ total: number; byDomain: Map<string, number> }> {
  const rows = await db.all<{ domain: string; n: number }>(
    `SELECT domain, COUNT(*) AS n FROM competitor_fetches
      WHERE workspace_id = ? AND project_id = ? AND created_at >= ? AND status <> 'setup_required' GROUP BY domain`,
    p.workspace_id,
    p.id,
    dayStart(now),
  );
  const byDomain = new Map(rows.map((r) => [r.domain, Number(r.n)]));
  return { total: rows.reduce((s, r) => s + Number(r.n), 0), byDomain };
}

async function finish(db: Db, f: FetchRow, status: FetchRow["status"], fields: { error?: string | null; cost?: number | null; loc?: CompetitorLocation | null }, now: Date) {
  await db.run(
    `UPDATE competitor_fetches SET status = ?, error = ?, cost_usd = ?, location_code = ?, language_code = ?, finished_at = ?
      WHERE workspace_id = ? AND id = ?`,
    status,
    fields.error ? fields.error.slice(0, 1000) : null,
    fields.cost ?? null,
    fields.loc?.locationCode ?? null,
    fields.loc?.languageCode ?? null,
    iso(now),
    f.workspace_id,
    f.id,
  );
}

// ------------------------------------------------------------------ processing
export interface ProcessDeps {
  /** Base fetch behind the allowlist (tests). */
  fetchImpl?: typeof fetch;
  clock?: Clock;
}

/**
 * The free Labs locations_and_languages list (Google languages only), recorded in provider_calls with the
 * cost DataForSEO returned (0 for this free endpoint).
 */
export async function listLocations(
  db: Db,
  p: ProjectRow,
  resolved: ResolvedDataForSeo,
  apiFetch: typeof fetch,
  clock: Clock = systemClock,
): Promise<{ ok: true; locations: CompetitorLocationOption[] } | { ok: false; message: string }> {
  const calls = createCallRecorder(db, { workspaceId: p.workspace_id, projectId: p.id, runId: null }, clock);
  const res = await fetchLabsLocations(apiFetch, resolved.creds);
  if (!res.ok) {
    const o = res.outcome;
    const message = o.kind === "api_error" ? describeApiError(o) : o.message;
    if (o.kind !== "not_sent") {
      await calls.record({
        provider: DATAFORSEO_PROVIDER,
        model: "labs/locations_and_languages",
        purpose: PURPOSE,
        status: o.kind === "unknown" ? (o.timeout ? "timeout" : "unknown") : "error",
        requestId: o.kind === "api_error" ? o.taskId : null,
        costUsd: o.kind === "api_error" ? o.costUsd : null,
        costIsEstimate: false,
        rateVersion: DATAFORSEO_RATE_VERSION,
        latencyMs: o.latencyMs,
        error: message,
      });
    }
    return { ok: false, message };
  }
  await calls.record({
    provider: DATAFORSEO_PROVIDER,
    model: "labs/locations_and_languages",
    purpose: PURPOSE,
    status: "ok",
    requestId: res.taskId,
    costUsd: res.costUsd,
    costIsEstimate: false,
    rateVersion: DATAFORSEO_RATE_VERSION,
    latencyMs: res.latencyMs,
  });
  return { ok: true, locations: res.locations };
}

/**
 * Resolve the Labs location for a project: a stored usable choice, else the locale mapped through the free
 * locations_and_languages list (stored as an automatic choice). The free call is recorded in provider_calls.
 */
export async function resolveLocation(
  env: Env,
  db: Db,
  p: ProjectRow,
  resolved: ResolvedDataForSeo,
  apiFetch: typeof fetch,
  clock: Clock,
): Promise<{ ok: true; location: CompetitorLocation } | { ok: false; setup: boolean; message: string }> {
  const settings = await loadSettings(db, p.workspace_id, p.id);
  const stored = usableLocation(settings, p);
  if (stored) return { ok: true, location: stored };
  if (!regionOf(p.locale)) return { ok: false, setup: true, message: unmappedLocaleMessage(p) };
  const res = await listLocations(db, p, resolved, apiFetch, clock);
  if (!res.ok) return { ok: false, setup: false, message: `Could not load DataForSEO locations: ${res.message}` };
  const match = matchLocation(res.locations, p.locale, p.language);
  if (!match) return { ok: false, setup: true, message: unmappedLocaleMessage(p) };
  await saveSettings(db, p, { location: match, source: "auto" }, null, clock());
  return { ok: true, location: match };
}

interface EndpointResult {
  endpoint: CompetitorDataEndpoint;
  outcome: CallOutcome;
}

const micros = (usd: number) => Math.max(0, Math.round(usd * 1_000_000));

/** Reserve provider_calls + usd_micros for every endpoint, all or nothing. */
async function reserveAll(budget: Budget, endpoints: readonly CompetitorDataEndpoint[]) {
  const held: Array<{ endpoint: CompetitorDataEndpoint; calls: string; usd: string }> = [];
  try {
    for (const e of endpoints) {
      const calls = await budget.reserve("provider_calls", 1);
      let usd: string;
      try {
        usd = await budget.reserve("usd_micros", micros(maxTaskCostUsd(e)));
      } catch (err) {
        await budget.release(calls);
        throw err;
      }
      held.push({ endpoint: e, calls, usd });
    }
    return held;
  } catch (err) {
    for (const h of held) {
      await budget.release(h.calls);
      await budget.release(h.usd);
    }
    throw err;
  }
}

/** Settle one endpoint's reservations from what is known about the call. */
async function settle(budget: Budget, h: { calls: string; usd: string }, o: CallOutcome) {
  if (o.kind === "not_sent") {
    await budget.release(h.calls);
    await budget.release(h.usd);
    return;
  }
  await budget.settle(h.calls, 1);
  const cost = o.kind === "unknown" ? null : o.costUsd;
  // Unknown cost (timeout, unreadable body, error without a cost): keep the full ceiling counted.
  if (cost === null) await budget.markUnknown(h.usd);
  else await budget.settle(h.usd, micros(cost));
}

function snapshotJson(data: Record<string, unknown>, listKey: string): { json: string; items: number } {
  const list = Array.isArray(data[listKey]) ? (data[listKey] as unknown[]) : [];
  let n = list.length;
  let json = JSON.stringify({ ...data, [listKey]: list });
  // Rows are already clipped; this only guards the row size if a provider returns unusually long text.
  while (json.length > MAX_SNAPSHOT_JSON_CHARS && n > 0) {
    n = Math.floor(n * 0.8);
    json = JSON.stringify({ ...data, [listKey]: list.slice(0, n) });
  }
  return { json, items: n };
}

function parseFor(endpoint: CompetitorDataEndpoint, result: Record<string, unknown> | null, loc: CompetitorLocation) {
  switch (endpoint) {
    case "ranked_keywords": {
      const r = parseRankedKeywords(result);
      return { totalCount: r.totalCount, ...snapshotJson({ location: loc, overview: r.overview, keywords: r.keywords }, "keywords") };
    }
    case "domain_intersection": {
      const r = parseDomainIntersection(result);
      return { totalCount: r.totalCount, ...snapshotJson({ location: loc, rows: r.rows }, "rows") };
    }
    case "relevant_pages": {
      const r = parseRelevantPages(result);
      return { totalCount: r.totalCount, ...snapshotJson({ location: loc, rows: r.rows }, "rows") };
    }
  }
}

/**
 * Claim and run one queued refresh. Never throws for provider problems (the row records them); returns the
 * final row (or null when it was not claimable).
 */
export async function processFetch(env: Env, workspaceId: string, fetchId: string, deps: ProcessDeps = {}): Promise<FetchRow | null> {
  const db = new Db(env.DB);
  const clock = deps.clock ?? systemClock;
  const claimed = await db.run(
    "UPDATE competitor_fetches SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ? AND status = 'queued'",
    iso(clock()),
    workspaceId,
    fetchId,
  );
  if (claimed.changes !== 1) return null;
  const f = (await loadFetch(db, workspaceId, fetchId))!;
  try {
    await runFetch(env, db, f, deps, clock);
  } catch (e) {
    // Unexpected failure (D1 error, bug): never leave the row running.
    await finish(db, f, "failed", { error: "Refresh failed unexpectedly. Try again later." }, clock()).catch(() => undefined);
    console.error("competitor data refresh failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
  }
  return loadFetch(db, workspaceId, fetchId);
}

async function runFetch(env: Env, db: Db, f: FetchRow, deps: ProcessDeps, clock: Clock): Promise<void> {
  const p = await db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", f.workspace_id, f.project_id);
  if (!p) return finish(db, f, "failed", { error: "Project not found." }, clock());
  if (p.is_demo === 1) return finish(db, f, "failed", { error: "Competitor data is not fetched for demo projects." }, clock());
  const domains = competitorDomains(projectCompetitors(p));
  if (!domains.some((d) => d.domain === f.domain)) return finish(db, f, "failed", { error: "This domain is no longer a tracked competitor." }, clock());

  let resolved: ResolvedDataForSeo | null;
  try {
    resolved = await resolveDataForSeo(env, db, p.workspace_id);
  } catch {
    return finish(db, f, "setup_required", { error: "The saved DataForSEO credentials could not be decrypted; re-enter them on the Integrations page." }, clock());
  }
  if (!resolved) return finish(db, f, "setup_required", { error: NO_CREDENTIALS }, clock());

  const apiFetch = createApiFetch(env, deps.fetchImpl ?? baseFetch());
  const loc = await resolveLocation(env, db, p, resolved, apiFetch, clock);
  if (!loc.ok) return finish(db, f, loc.setup ? "setup_required" : "failed", { error: loc.message }, clock());
  const location = loc.location;

  const own = ownDomain(p);
  // No gap against yourself (a competitor domain equal to the project's own domain).
  const endpoints = ENDPOINTS.filter((e) => e !== "domain_intersection" || (own && own !== f.domain));
  const budget = budgetForKeySource(createBudget(db, env, { workspaceId: p.workspace_id, projectId: p.id, runId: null }, clock), resolved.source);
  let held: Awaited<ReturnType<typeof reserveAll>>;
  try {
    held = await reserveAll(budget, endpoints);
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      const scope = /Global/i.test(e.message) ? "the operator's global daily allowance" : "this project's daily limit";
      return finish(db, f, "failed", { error: `Not fetched: ${scope} for ${e.resource === "usd_micros" ? "spend" : "provider calls"} is reached. Try again tomorrow or raise the project limits on the Usage page.`, loc: location }, clock());
    }
    throw e;
  }

  const calls = createCallRecorder(db, { workspaceId: p.workspace_id, projectId: p.id, runId: null }, clock);
  const results: EndpointResult[] = await Promise.all(
    held.map(async (h): Promise<EndpointResult> => {
      const outcome = await dataForSeoRequest(apiFetch, resolved!.creds, "POST", ENDPOINT_PATHS[h.endpoint], requestBody(h.endpoint, f.domain, own, location), {
        timeoutMs: LABS_TIMEOUT_MS,
        maxBytes: MAX_LABS_RESPONSE_BYTES,
        now: () => clock().getTime(),
      });
      if (outcome.kind !== "not_sent") {
        await calls.record({
          provider: DATAFORSEO_PROVIDER,
          model: `labs/google/${h.endpoint}`,
          purpose: PURPOSE,
          status: outcome.kind === "ok" ? "ok" : outcome.kind === "api_error" ? "error" : outcome.timeout ? "timeout" : "unknown",
          requestId: outcome.kind === "unknown" ? null : outcome.taskId,
          costUsd: outcome.kind === "unknown" ? null : outcome.costUsd,
          // The cost DataForSEO returned is the billed amount, not an estimate (null when absent = unknown).
          costIsEstimate: false,
          rateVersion: DATAFORSEO_RATE_VERSION,
          latencyMs: outcome.latencyMs,
          error: outcome.kind === "ok" ? null : outcome.kind === "api_error" ? describeApiError(outcome) : outcome.message,
        });
      }
      await settle(budget, h, outcome);
      return { endpoint: h.endpoint, outcome };
    }),
  );

  const now = clock();
  const stmts: Array<[string, ...unknown[]]> = [];
  const errors: string[] = [];
  let okCount = 0;
  let total = 0;
  let costKnown = true;
  for (const r of results) {
    const o = r.outcome;
    const cost = o.kind === "ok" || o.kind === "api_error" ? o.costUsd : null;
    if (o.kind !== "not_sent") {
      if (cost === null) costKnown = false;
      else total += cost;
    }
    let status: "ok" | "error" = "error";
    let data = "{}";
    let items = 0;
    let totalCount: number | null = null;
    let error: string | null = null;
    if (o.kind === "ok") {
      const parsed = parseFor(r.endpoint, o.result, location);
      status = "ok";
      data = parsed.json;
      items = parsed.items;
      totalCount = parsed.totalCount;
      okCount++;
    } else {
      error = o.kind === "api_error" ? describeApiError(o) : o.message;
      errors.push(`${r.endpoint}: ${error}`);
    }
    stmts.push([
      `INSERT INTO competitor_snapshots (id, workspace_id, project_id, fetch_id, domain, endpoint, location_code, language_code, status, cost_usd, total_count, item_count, data_json, error, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId("csnap"),
      p.workspace_id,
      p.id,
      f.id,
      f.domain,
      r.endpoint,
      location.locationCode,
      location.languageCode,
      status,
      cost,
      totalCount,
      items,
      data,
      error ? error.slice(0, 500) : null,
      iso(now),
    ]);
  }
  await db.batch(stmts);
  const status: FetchRow["status"] = okCount === results.length ? "completed" : okCount > 0 ? "partial" : "failed";
  await finish(db, f, status, { error: errors.length ? errors.join(" ") : null, cost: costKnown ? Math.round(total * 1e6) / 1e6 : null, loc: location }, now);
  await prune(db, p, f.domain, domains.map((d) => d.domain));
}

/** Retention: keep the newest KEEP_SNAPSHOTS_PER_DOMAIN refreshes' snapshots and KEEP_FETCH_LOG_PER_DOMAIN log rows. */
export async function prune(db: Db, p: ProjectRow, domain: string, currentDomains: string[]): Promise<void> {
  const w = p.workspace_id;
  const stmts: Array<[string, ...unknown[]]> = [
    [
      `DELETE FROM competitor_snapshots WHERE workspace_id = ? AND project_id = ? AND domain = ? AND fetch_id NOT IN (
         SELECT id FROM competitor_fetches WHERE workspace_id = ? AND project_id = ? AND domain = ? AND status IN ('completed', 'partial')
          ORDER BY created_at DESC, id DESC LIMIT ?)`,
      w, p.id, domain, w, p.id, domain, KEEP_SNAPSHOTS_PER_DOMAIN,
    ],
    [
      `DELETE FROM competitor_fetches WHERE workspace_id = ? AND project_id = ? AND domain = ? AND status NOT IN ('queued', 'running') AND id NOT IN (
         SELECT id FROM competitor_fetches WHERE workspace_id = ? AND project_id = ? AND domain = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
      w, p.id, domain, w, p.id, domain, KEEP_FETCH_LOG_PER_DOMAIN,
    ],
  ];
  await db.batch(stmts);
  // Snapshots of domains that are no longer competitors (the refresh log stays, so daily caps hold). Up to
  // MAX_COMPETITORS x 5 domains are current, more than D1's 100 bound parameters, so the stale domains are found
  // first (distinct domains with snapshots; bounded) and deleted in chunks.
  const keep = new Set(currentDomains);
  const present = await db.all<{ domain: string }>(
    "SELECT DISTINCT domain FROM competitor_snapshots WHERE workspace_id = ? AND project_id = ? LIMIT 1000",
    w,
    p.id,
  );
  const stale = present.map((r) => r.domain).filter((d) => !keep.has(d));
  for (let i = 0; i < stale.length; i += 90) {
    const chunk = stale.slice(i, i + 90);
    await db.run(
      `DELETE FROM competitor_snapshots WHERE workspace_id = ? AND project_id = ? AND domain IN (${chunk.map(() => "?").join(",")})`,
      w,
      p.id,
      ...chunk,
    );
  }
}

/** Process several queued refreshes, at most `limit` (sequentially; each runs its tasks in parallel). */
export async function processMany(env: Env, items: Array<{ workspaceId: string; id: string }>, deps: ProcessDeps = {}): Promise<void> {
  for (const it of items) {
    try {
      await processFetch(env, it.workspaceId, it.id, deps);
    } catch (e) {
      console.error("competitor data refresh failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    }
  }
}

/**
 * Cron: fail refreshes stuck 'running' (isolate ended), move deferred domains into the queue as today's caps allow
 * (drainFetchBacklogs), then process a few queued ones.
 */
export async function processQueuedCompetitorFetches(env: Env, now: Date, deps: ProcessDeps = {}): Promise<{ failedStale: number; processed: number; promoted: number }> {
  const db = new Db(env.DB);
  let stale: { changes: number };
  try {
    stale = await db.run(
      `UPDATE competitor_fetches SET status = 'failed', finished_at = ?, error = 'Refresh was interrupted before it finished. Try again.'
        WHERE status = 'running' AND started_at < ?`,
      iso(now),
      iso(addSeconds(now, -RUNNING_STALE_SECONDS)),
    );
  } catch (e) {
    if (isMissingTableError(e)) return { failedStale: 0, processed: 0, promoted: 0 };
    throw e;
  }
  const promoted = await drainFetchBacklogs(env, now);
  // Rows promoted by this tick are picked up right away; requests' own rows wait QUEUED_PICKUP_SECONDS for their waitUntil.
  const queued = await db.all<{ id: string; workspace_id: string }>(
    "SELECT id, workspace_id FROM competitor_fetches WHERE status = 'queued' AND (created_at < ? OR created_at = ?) ORDER BY created_at LIMIT ?",
    iso(addSeconds(now, -QUEUED_PICKUP_SECONDS)),
    iso(now),
    CRON_DOMAINS_PER_TICK,
  );
  await processMany(env, queued.map((q) => ({ workspaceId: q.workspace_id, id: q.id })), deps);
  return { failedStale: stale.changes, processed: queued.length, promoted };
}

// ------------------------------------------------------------------ backlog (deferred auto-fetch, migration 0021)
interface BacklogRow {
  id: string;
  workspace_id: string;
  project_id: string;
  domain: string;
  position: number;
  requested_by: string | null;
  created_at: string;
}

/** Defer domains to the backlog (keeps the earliest position of a domain already waiting). */
async function deferDomains(db: Db, p: ProjectRow, domains: string[], userId: string | null, now: Date): Promise<number> {
  if (domains.length === 0) return 0;
  const last = await db.first<{ m: number | null }>(
    "SELECT MAX(position) AS m FROM competitor_fetch_backlog WHERE workspace_id = ? AND project_id = ?",
    p.workspace_id,
    p.id,
  );
  let pos = Number(last?.m ?? -1) + 1;
  const stmts: Array<[string, ...unknown[]]> = domains.map((d) => [
    `INSERT OR IGNORE INTO competitor_fetch_backlog (id, workspace_id, project_id, domain, position, requested_by, created_at) VALUES (?,?,?,?,?,?,?)`,
    newId("cfbk"),
    p.workspace_id,
    p.id,
    d,
    pos++,
    userId,
    iso(now),
  ]);
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

/** Domains of the project waiting in the backlog (bounded read; missing table = none). */
export async function backlogDomains(db: Db, p: ProjectRow, limit = 400): Promise<string[]> {
  try {
    const rows = await db.all<{ domain: string }>(
      "SELECT domain FROM competitor_fetch_backlog WHERE workspace_id = ? AND project_id = ? ORDER BY position, id LIMIT ?",
      p.workspace_id,
      p.id,
      limit,
    );
    return rows.map((r) => r.domain);
  } catch (e) {
    if (isMissingTableError(e)) return [];
    throw e;
  }
}

async function deleteBacklog(db: Db, p: ProjectRow, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await db.run(
      `DELETE FROM competitor_fetch_backlog WHERE workspace_id = ? AND project_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
      p.workspace_id,
      p.id,
      ...chunk,
    );
  }
}

/**
 * Move one project's waiting domains into the refresh queue, in backlog order, while today's caps allow.
 * Domains no longer tracked are dropped; a domain at its own per-domain cap waits for tomorrow; the per-project cap
 * stops the drain (the rest wait). Auto-fetch off, demo project or no credentials -> the backlog is cleared (nothing
 * is called; the owner can refresh per competitor later). Returns the queued fetch ids.
 */
export async function drainFetchBacklog(env: Env, db: Db, p: ProjectRow, now: Date): Promise<{ queued: string[]; dropped: number; waiting: number }> {
  const rows = await db.all<BacklogRow>(
    "SELECT * FROM competitor_fetch_backlog WHERE workspace_id = ? AND project_id = ? ORDER BY position, id LIMIT ?",
    p.workspace_id,
    p.id,
    BACKLOG_READ_PER_PROJECT,
  );
  if (rows.length === 0) return { queued: [], dropped: 0, waiting: 0 };
  const settings = await loadSettings(db, p.workspace_id, p.id);
  if (p.is_demo === 1 || (settings && settings.auto_fetch === 0) || !(await dataForSeoSource(env, db, p.workspace_id))) {
    await db.run("DELETE FROM competitor_fetch_backlog WHERE workspace_id = ? AND project_id = ?", p.workspace_id, p.id);
    return { queued: [], dropped: rows.length, waiting: 0 };
  }
  const tracked = new Set(competitorDomains(projectCompetitors(p)).map((d) => d.domain));
  const done: string[] = [];
  const queued: string[] = [];
  let dropped = 0;
  for (const r of rows) {
    if (!tracked.has(r.domain)) {
      done.push(r.id);
      dropped++;
      continue;
    }
    const res = await enqueueFetch(db, p, r.domain, "competitor_added", r.requested_by, now);
    if (res.kind === "queued") {
      queued.push(res.fetch.id);
      done.push(r.id);
    } else if (res.kind === "existing") {
      done.push(r.id);
    } else if (res.scope === "project") {
      break; // project cap reached: everything else waits for the next UTC day
    }
    // per-domain cap: this domain waits for tomorrow; try the next one
  }
  await deleteBacklog(db, p, done);
  const left = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM competitor_fetch_backlog WHERE workspace_id = ? AND project_id = ?", p.workspace_id, p.id);
  return { queued, dropped, waiting: Number(left?.n ?? 0) };
}

/** Cron: drain the backlog of a few projects (oldest waiting first). */
export async function drainFetchBacklogs(env: Env, now: Date): Promise<number> {
  const db = new Db(env.DB);
  let projects: Array<{ workspace_id: string; project_id: string }>;
  try {
    projects = await db.all<{ workspace_id: string; project_id: string }>(
      `SELECT workspace_id, project_id, MIN(created_at) AS oldest FROM competitor_fetch_backlog
        GROUP BY workspace_id, project_id ORDER BY oldest LIMIT ?`,
      BACKLOG_PROJECTS_PER_TICK,
    );
  } catch (e) {
    if (isMissingTableError(e)) return 0;
    throw e;
  }
  let moved = 0;
  for (const it of projects) {
    const p = await db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", it.workspace_id, it.project_id);
    if (!p) continue;
    try {
      moved += (await drainFetchBacklog(env, db, p, now)).queued.length;
    } catch (e) {
      console.error("competitor backlog drain failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    }
  }
  return moved;
}

export interface CompetitorsChangedOptions {
  /** False: queue nothing (import option "Fetch DataForSEO data for new competitors" unticked). Default true. */
  fetch?: boolean;
  /** Preferred order of the new domains (the sheet's row order); others follow in competitor order. */
  order?: readonly string[];
}

/**
 * After a project create/update or an import: queue the newly added competitor domains when DataForSEO
 * credentials exist, auto-fetch is on and the caller did not opt out. Domains go to the queue in order up to
 * today's remaining per-project cap; the rest are deferred to the backlog (drained by the cron on later days),
 * never dropped. Up to INLINE_PROCESS_DOMAINS run via `schedule` (ctx.waitUntil) or inline when no scheduler is
 * available (tests/dev). Never throws (a failure here must not fail the project save).
 */
export async function onCompetitorsChanged(
  env: Env,
  db: Db,
  p: ProjectRow,
  before: Competitor[],
  userId: string | null,
  now: Date,
  schedule?: (work: Promise<unknown>) => void,
  deps: ProcessDeps = {},
  opts: CompetitorsChangedOptions = {},
): Promise<{ queued: string[]; deferred: string[] }> {
  try {
    if (p.is_demo === 1 || opts.fetch === false) return { queued: [], deferred: [] };
    const added = addedCompetitorDomains(before, projectCompetitors(p), opts.order ?? []);
    if (added.length === 0) return { queued: [], deferred: [] };
    if (!(await dataForSeoSource(env, db, p.workspace_id))) return { queued: [], deferred: [] };
    const settings = await loadSettings(db, p.workspace_id, p.id);
    if (settings && settings.auto_fetch === 0) return { queued: [], deferred: [] };
    const queued: string[] = [];
    const deferred: string[] = [];
    let projectCapped = false;
    for (const d of added) {
      if (projectCapped) {
        deferred.push(d.domain);
        continue;
      }
      const r = await enqueueFetch(db, p, d.domain, "competitor_added", userId, now);
      if (r.kind === "queued") queued.push(r.fetch.id);
      else if (r.kind === "capped") {
        deferred.push(d.domain);
        if (r.scope === "project") projectCapped = true;
      }
    }
    try {
      await deferDomains(db, p, deferred, userId, now);
    } catch (e) {
      if (!isMissingTableError(e)) throw e;
      console.error("competitor backlog unavailable (migration 0021 pending); deferred domains were not kept");
    }
    const work = processMany(env, queued.slice(0, INLINE_PROCESS_DOMAINS).map((id) => ({ workspaceId: p.workspace_id, id })), deps);
    if (schedule) schedule(work);
    else await work;
    return { queued, deferred };
  } catch (e) {
    if (!isMissingTableError(e)) console.error("competitor auto-fetch failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return { queued: [], deferred: [] };
  }
}

// ------------------------------------------------------------------ reads
interface SnapshotRow {
  fetch_id: string;
  domain: string;
  endpoint: CompetitorDataEndpoint;
  status: "ok" | "error";
  cost_usd: number | null;
  total_count: number | null;
  item_count: number;
  data_json: string;
  error: string | null;
  fetched_at: string;
}

interface DomainData {
  latestFetch: FetchRow | null;
  dataFetch: FetchRow | null;
  snapshots: SnapshotRow[];
}

async function loadDomainData(db: Db, p: ProjectRow, domains: string[], withLists: boolean): Promise<Map<string, DomainData>> {
  const out = new Map<string, DomainData>(domains.map((d) => [d, { latestFetch: null, dataFetch: null, snapshots: [] }]));
  if (domains.length === 0) return out;
  // Chunked under D1's 100 bound parameters (up to MAX_COMPETITORS x 5 domains); the refresh log keeps at most
  // KEEP_FETCH_LOG_PER_DOMAIN rows per domain, so each read is bounded.
  const fetches: FetchRow[] = [];
  for (let i = 0; i < domains.length; i += 90) {
    const list = domains.slice(i, i + 90);
    fetches.push(
      ...(await db.all<FetchRow>(
        `SELECT * FROM competitor_fetches WHERE workspace_id = ? AND project_id = ? AND domain IN (${list.map(() => "?").join(",")})
          ORDER BY created_at DESC, id DESC LIMIT ?`,
        p.workspace_id,
        p.id,
        ...list,
        list.length * (KEEP_FETCH_LOG_PER_DOMAIN + 2),
      )),
    );
  }
  fetches.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  for (const f of fetches) {
    const d = out.get(f.domain);
    if (!d) continue;
    d.latestFetch ??= f;
    if (!d.dataFetch && (f.status === "completed" || f.status === "partial")) d.dataFetch = f;
  }
  const ids = [...out.values()].map((d) => d.dataFetch?.id).filter((x): x is string => !!x);
  if (ids.length) {
    // Lists are only needed on the detail route; the summary reads data_json of ranked_keywords (overview).
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const rows = await db.all<SnapshotRow>(
        `SELECT fetch_id, domain, endpoint, status, cost_usd, total_count, item_count,
                ${withLists ? "data_json" : "CASE WHEN endpoint = 'ranked_keywords' THEN data_json ELSE '{}' END AS data_json"}, error, fetched_at
           FROM competitor_snapshots WHERE workspace_id = ? AND project_id = ? AND fetch_id IN (${chunk.map(() => "?").join(",")})`,
        p.workspace_id,
        p.id,
        ...chunk,
      );
      for (const r of rows) out.get(r.domain)?.snapshots.push(r);
    }
  }
  return out;
}

function summaryFor(cd: CompetitorDomain, d: DomainData | undefined, refreshesToday: number): CompetitorDomainSummary {
  const snaps = d?.snapshots ?? [];
  const ranked = snaps.find((s) => s.endpoint === "ranked_keywords");
  const rankedData = ranked && ranked.status === "ok" ? parseJson<{ overview?: CompetitorOverview; location?: CompetitorLocation }>(ranked.data_json, {}) : null;
  const anyData = snaps.map((s) => parseJson<{ location?: CompetitorLocation }>(s.endpoint === "ranked_keywords" ? s.data_json : "{}", {}));
  const location = rankedData?.location ?? anyData.find((x) => x.location)?.location ?? null;
  const endpoints: CompetitorEndpointMeta[] = ENDPOINTS.flatMap((e) => {
    const s = snaps.find((x) => x.endpoint === e);
    return s
      ? [{ endpoint: e, status: s.status, fetchedAt: s.fetched_at, costUsd: s.cost_usd, totalCount: s.total_count, itemCount: s.item_count, error: s.error }]
      : [];
  });
  return {
    competitorName: cd.competitorName,
    domain: cd.domain,
    latestFetch: d?.latestFetch ? toFetchSummary(d.latestFetch) : null,
    snapshot: d?.dataFetch
      ? {
          fetchId: d.dataFetch.id,
          fetchedAt: d.dataFetch.finished_at ?? d.dataFetch.created_at,
          location,
          costUsd: d.dataFetch.cost_usd,
          overview: rankedData?.overview ?? null,
          endpoints,
        }
      : null,
    refreshesToday,
  };
}

export async function competitorPanel(env: Env, db: Db, p: ProjectRow, canManage: boolean, now: Date): Promise<CompetitorDataPanel> {
  const domains = competitorDomains(projectCompetitors(p));
  let source: Awaited<ReturnType<typeof dataForSeoSource>> = null;
  let migrationPending = false;
  try {
    source = await dataForSeoSource(env, db, p.workspace_id);
    await db.first("SELECT 1 FROM competitor_fetches WHERE workspace_id = ? AND project_id = ? LIMIT 1", p.workspace_id, p.id);
  } catch (e) {
    if (!isMissingTableError(e)) throw e;
    migrationPending = true;
  }
  const settings = migrationPending ? null : await loadSettings(db, p.workspace_id, p.id);
  const data = migrationPending ? new Map<string, DomainData>() : await loadDomainData(db, p, domains.map((d) => d.domain), false);
  const counts = migrationPending ? { total: 0, byDomain: new Map<string, number>() } : await todayCounts(db, p, now);
  const location = usableLocation(settings, p);
  const waiting = new Set(migrationPending ? [] : await backlogDomains(db, p));

  let state: CompetitorDataPanel["state"] = "ready";
  let message: string | null = null;
  if (p.is_demo === 1) {
    state = "disabled";
    message = "Competitor data is not fetched for demo projects.";
  } else if (migrationPending) {
    state = "setup_required";
    message = "Competitor data needs database migration 0014_dataforseo_competitors.sql to be applied.";
  } else if (!source) {
    state = "setup_required";
    message = NO_CREDENTIALS;
  } else if (!location && !regionOf(p.locale)) {
    state = "setup_required";
    message = unmappedLocaleMessage(p);
  } else if (!location) {
    // Mapped from the locale on the first refresh; a failed mapping is reported by that refresh.
    const unmapped = [...data.values()].some((d) => d.latestFetch?.status === "setup_required" && (d.latestFetch.error ?? "").includes("has no location"));
    if (unmapped) {
      state = "setup_required";
      message = unmappedLocaleMessage(p);
    }
  }
  return {
    state,
    message,
    credentialSource: source ?? "none",
    canManage,
    location,
    locationSource: location ? (settings?.location_source ?? null) : null,
    autoFetch: (settings?.auto_fetch ?? 1) === 1,
    caps: {
      refreshesPerDomainPerDay: REFRESHES_PER_DOMAIN_PER_DAY,
      fetchesPerProjectPerDay: FETCHES_PER_PROJECT_PER_DAY,
      fetchesToday: counts.total,
      keepSnapshotsPerDomain: KEEP_SNAPSHOTS_PER_DOMAIN,
      waitingDomains: waiting.size,
    },
    pricing: {
      perTaskUsd: DATAFORSEO_LABS_PRICE.perTaskUsd,
      perItemUsd: DATAFORSEO_LABS_PRICE.perItemUsd,
      maxRefreshUsd: maxRefreshCostUsd(),
      readOn: DATAFORSEO_LABS_PRICE.readOn,
      sourceUrl: DATAFORSEO_LABS_PRICE.sourceUrl,
    },
    limits: { ...DATAFORSEO_LIMITS },
    ownDomain: ownDomain(p),
    domains: domains.map((d) => ({ ...summaryFor(d, data.get(d.domain), counts.byDomain.get(d.domain) ?? 0), waiting: waiting.has(d.domain) })),
  };
}

/** Full tables for one competitor domain (null when the domain is not a current competitor). */
export async function competitorDomainDetail(db: Db, p: ProjectRow, domain: string, now: Date): Promise<CompetitorDomainDetail | null> {
  const cd = competitorDomains(projectCompetitors(p)).find((d) => d.domain === targetDomain(domain));
  if (!cd) return null;
  const data = (await loadDomainData(db, p, [cd.domain], true)).get(cd.domain);
  const counts = await todayCounts(db, p, now);
  const summary = summaryFor(cd, data, counts.byDomain.get(cd.domain) ?? 0);
  const snap = (e: CompetitorDataEndpoint) => {
    const s = data?.snapshots.find((x) => x.endpoint === e && x.status === "ok");
    return s ? parseJson<Record<string, unknown>>(s.data_json, {}) : {};
  };
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    ...summary,
    topKeywords: arr<CompetitorKeywordRow>(snap("ranked_keywords").keywords),
    keywordGap: arr<CompetitorGapRow>(snap("domain_intersection").rows),
    ownDomain: ownDomain(p),
    topPages: arr<CompetitorPageRow>(snap("relevant_pages").rows),
  };
}
