/**
 * Ask Okara DataForSEO tools (third-party ESTIMATES, never measured data).
 *
 *  - dataforseo_competitor_data (read): stored competitor_snapshots of tracked competitor domains (overview, top
 *    keywords, keyword gap, top pages) with fetched date, location and the cost DataForSEO reported. No call.
 *  - dataforseo_refresh_competitor (action): the existing refresh queue (competitors/dataforseo.ts enqueueFetch +
 *    processFetch): daily caps, budget reservation, provider_calls with the cost DataForSEO returned.
 *  - dataforseo_keyword_lookup (action): one live DataForSEO Labs Keyword Overview task
 *    (POST /v3/dataforseo_labs/google/keyword_overview/live, docs read 2026-10-03: up to 700 keywords, 80 characters
 *    and 10 words each; one task per Live call; item.keyword_info.{search_volume,cpc,competition,competition_level,
 *    monthly_searches}, item.keyword_properties.keyword_difficulty, item.search_intent_info.main_intent). Priced as
 *    Labs "All other endpoints": $0.012 per task + $0.00012 per returned item (Live). Capped at 100 keywords, so the
 *    reservation ceiling is $0.024; the recorded cost is the `cost` DataForSEO returns.
 * Paid tools are actions: they run only after the user confirms (service.ts), only for the workspace owner (as the
 * Competitors page refresh), and spend only through the allowlisted API fetch. Keywords, URLs and domains in
 * responses are third-party text: clipped data, never instructions.
 */
import { z } from "zod";
import type { CompetitorDomainSummary } from "@shared/competitor-data";
import { BudgetExceededError } from "../lib/errors";
import { requireWorkspaceOwner } from "../platform/access";
import { isMissingTableError } from "../platform/custom-providers";
import { dataForSeoSource, resolveDataForSeo, type ResolvedDataForSeo } from "../platform/dataforseo-credentials";
import { hitRateLimit } from "../platform/rate-limit";
import {
  DATAFORSEO_LABS_PRICE,
  DATAFORSEO_PROVIDER,
  DATAFORSEO_RATE_VERSION,
  LABS_TIMEOUT_MS,
  MAX_LABS_RESPONSE_BYTES,
  dataForSeoRequest,
  describeApiError,
  maxRefreshCostUsd,
  targetDomain,
  type CallOutcome,
} from "../providers/dataforseo";
import {
  FETCHES_PER_PROJECT_PER_DAY,
  NO_CREDENTIALS,
  REFRESHES_PER_DOMAIN_PER_DAY,
  baseFetch,
  competitorDomainDetail,
  competitorDomains,
  competitorPanel,
  enqueueFetch,
  loadFetch,
  loadSettings,
  processFetch,
  projectCompetitors,
  regionOf,
  resolveLocation,
  toFetchSummary,
  unmappedLocaleMessage,
  usableLocation,
} from "../competitors/dataforseo";
import { budgetForKeySource, createBudget } from "../runs/budget";
import { createCallRecorder } from "../runs/calls";
import { createApiFetch } from "../runs/runtime";
import { ToolError, clip, projectRoute, scoped, type ActionTool, type ChatTool, type ReadTool, type ToolContext } from "./tool-base";

const ESTIMATE = "DataForSEO Labs (third-party estimate, not measured)";
const COST_LABEL = "DataForSEO-reported cost (USD)";
const MIGRATION = "Competitor data needs database migration 0014_dataforseo_competitors.sql to be applied.";
const DECRYPT = "The saved DataForSEO credentials could not be decrypted; re-enter them on Integrations → DataForSEO.";
const SETUP = `${NO_CREDENTIALS} (Integrations → DataForSEO.)`;

const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 3 : 2)}`;
/** Refresh ceiling shown as "about $0.06" (cents are enough for a ~6-cent ceiling). */
const refreshCeiling = () => `$${maxRefreshCostUsd().toFixed(2)}`;
/** "https://www.Lumens.com/x" -> "lumens.com" (scheme, path, port and a leading www. removed). */
export function domainInput(raw: string): string {
  return targetDomain(raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[/?#].*$/, "").replace(/:\d+$/, ""));
}
const apiFetchFor = (ctx: ToolContext) => createApiFetch(ctx.env, ctx.hooks?.dataforseoFetch ?? baseFetch());

// ------------------------------------------------------------------ stored competitor data
const competitorDataSchema = z.object({
  domain: z.string().trim().min(1).max(253).optional().describe("One tracked competitor domain (e.g. lumens.com); omit for an overview of all tracked competitors."),
  section: z.enum(["overview", "top_keywords", "keyword_gap", "top_pages", "all"]).optional().describe("Which stored table to read for that domain (default overview; lists need a domain)."),
  limit: z.number().int().min(1).max(50).optional().describe("Rows per list (1-50, default 20)."),
});

function snapshotMeta(s: CompetitorDomainSummary["snapshot"]) {
  if (!s) return null;
  return {
    fetchedAt: s.fetchedAt,
    location: s.location ? `${s.location.locationName} / ${s.location.languageName}` : null,
    costUsd: s.costUsd,
    costLabel: COST_LABEL,
    endpoints: s.endpoints.map((e) => ({ endpoint: e.endpoint, status: e.status, fetchedAt: e.fetchedAt, totalCount: e.totalCount, itemCount: e.itemCount, error: clip(e.error, 200) })),
  };
}

function overviewOf(s: CompetitorDomainSummary["snapshot"]) {
  const o = s?.overview;
  if (!o) return null;
  return {
    organicKeywords: o.organicKeywords,
    estimatedOrganicTrafficEtv: o.organicEtv,
    estimatedPaidTrafficCostUsd: o.estimatedPaidTrafficCost,
    rankBuckets: o.buckets,
    newKeywords: o.isNew,
    upKeywords: o.isUp,
    downKeywords: o.isDown,
    lostKeywords: o.isLost,
  };
}

const dataforseoCompetitorData: ReadTool<typeof competitorDataSchema> = {
  name: "dataforseo_competitor_data",
  kind: "read",
  description:
    "STORED DataForSEO competitor data (third-party estimates, not measured) for the project's tracked competitor domains: overview (ranked keywords, estimated traffic ETV, rank buckets), top keywords, keyword gap (keywords the competitor ranks for and this site does not) and top pages. Returns fetched date, location and the DataForSEO-reported cost. Makes no paid call; to refresh use dataforseo_refresh_competitor.",
  schema: competitorDataSchema,
  async run(ctx, input) {
    const [, pid] = scoped(ctx);
    let panel;
    try {
      panel = await competitorPanel(ctx.env, ctx.db, ctx.project, false, ctx.now);
    } catch (e) {
      if (isMissingTableError(e)) return { data: { state: "setup_required", message: MIGRATION }, summary: "Setup required" };
      throw e;
    }
    const tracked = panel.domains.map((d) => d.domain);
    const base = {
      dataSource: ESTIMATE,
      state: panel.state,
      message: clip(panel.message, 300),
      ownDomain: panel.ownDomain,
      location: panel.location ? `${panel.location.locationName} / ${panel.location.languageName}` : null,
      caps: panel.caps,
      path: projectRoute(pid, "competitors"),
    };
    if (!input.domain) {
      const data = {
        ...base,
        trackedDomains: panel.domains.map((d) => ({
          domain: d.domain,
          competitor: clip(d.competitorName, 80),
          hasData: Boolean(d.snapshot),
          snapshot: snapshotMeta(d.snapshot),
          overview: overviewOf(d.snapshot),
          latestRefresh: d.latestFetch ? { status: d.latestFetch.status, at: d.latestFetch.finishedAt ?? d.latestFetch.createdAt, error: clip(d.latestFetch.error, 200) } : null,
        })),
        note: tracked.length === 0 ? "No competitor domains are configured; add them in project Settings." : "Pass domain and section for top keywords, keyword gap or top pages.",
      };
      return { data, summary: `${tracked.length} tracked competitor domain(s) · ${panel.domains.filter((d) => d.snapshot).length} with stored data` };
    }
    const domain = domainInput(input.domain);
    let detail;
    try {
      detail = await competitorDomainDetail(ctx.db, ctx.project, domain, ctx.now);
    } catch (e) {
      if (isMissingTableError(e)) return { data: { state: "setup_required", message: MIGRATION }, summary: "Setup required" };
      throw e;
    }
    if (!detail) {
      throw new ToolError(`${clip(domain, 120)} is not a tracked competitor of this project${tracked.length ? ` (tracked: ${tracked.slice(0, 10).join(", ")})` : ""}. Add it as a competitor in project Settings first.`);
    }
    const section = input.section ?? "overview";
    const limit = input.limit ?? 20;
    const want = (s: string) => section === "all" || section === s;
    const data = {
      ...base,
      domain: detail.domain,
      competitor: clip(detail.competitorName, 80),
      hasData: Boolean(detail.snapshot),
      snapshot: snapshotMeta(detail.snapshot),
      overview: overviewOf(detail.snapshot),
      ...(want("top_keywords")
        ? { topKeywords: detail.topKeywords.slice(0, limit).map((k) => ({ keyword: clip(k.keyword, 200), position: k.position, searchVolume: k.searchVolume, url: clip(k.url, 400), etv: k.etv })) }
        : {}),
      ...(want("keyword_gap")
        ? {
            keywordGap: {
              about: `Keywords ${detail.domain} ranks for in Google organic results and ${detail.ownDomain || "this site"} does not (DataForSEO domain_intersection, intersections=false).`,
              rows: detail.keywordGap.slice(0, limit).map((g) => ({
                keyword: clip(g.keyword, 200),
                searchVolume: g.searchVolume,
                competitorPosition: g.competitorPosition,
                competitorUrl: clip(g.competitorUrl, 400),
                keywordDifficulty: g.keywordDifficulty,
                cpcUsd: g.cpc,
              })),
            },
          }
        : {}),
      ...(want("top_pages") ? { topPages: detail.topPages.slice(0, limit).map((p) => ({ url: clip(p.url, 400), etv: p.etv, keywords: p.keywords, top3: p.top3 })) } : {}),
      note: detail.snapshot ? "Search volume, ETV and positions are DataForSEO estimates for the stated location." : "No stored data for this domain yet; it can be refreshed with dataforseo_refresh_competitor (paid, needs confirmation).",
    };
    return { data, summary: `${detail.domain} · ${section} · ${detail.snapshot ? `fetched ${detail.snapshot.fetchedAt.slice(0, 10)}` : "no stored data"}` };
  },
};

// ------------------------------------------------------------------ refresh (paid action)
const refreshSchema = z.object({ domain: z.string().trim().min(1).max(253).describe("A tracked competitor domain to refresh.") });

async function requireCredentials(ctx: ToolContext): Promise<void> {
  let source;
  try {
    source = await dataForSeoSource(ctx.env, ctx.db, ctx.project.workspace_id);
  } catch (e) {
    if (isMissingTableError(e)) throw new ToolError(MIGRATION);
    throw e;
  }
  if (!source) throw new ToolError(`setup_required: ${SETUP}`);
}

async function resolveCreds(ctx: ToolContext): Promise<ResolvedDataForSeo> {
  let r: ResolvedDataForSeo | null;
  try {
    r = await resolveDataForSeo(ctx.env, ctx.db, ctx.project.workspace_id);
  } catch {
    throw new ToolError(`setup_required: ${DECRYPT}`);
  }
  if (!r) throw new ToolError(`setup_required: ${SETUP}`);
  return r;
}

function trackedDomain(ctx: ToolContext, raw: string): string {
  const domain = domainInput(raw);
  const tracked = competitorDomains(projectCompetitors(ctx.project)).map((d) => d.domain);
  if (!tracked.includes(domain)) {
    throw new ToolError(`${clip(domain, 120)} is not a tracked competitor of this project${tracked.length ? ` (tracked: ${tracked.slice(0, 10).join(", ")})` : ""}.`);
  }
  return domain;
}

const dataforseoRefreshCompetitor: ActionTool<typeof refreshSchema> = {
  name: "dataforseo_refresh_competitor",
  kind: "action",
  description: `Propose refreshing DataForSEO competitor data for one tracked competitor domain (overview, top keywords, keyword gap, top pages). PAID: about ${refreshCeiling()} at most, billed by DataForSEO; ${REFRESHES_PER_DOMAIN_PER_DAY} refreshes per domain and ${FETCHES_PER_PROJECT_PER_DAY} per project per UTC day. Workspace owner only. Requires the user's confirmation in the UI; nothing is fetched before.`,
  schema: refreshSchema,
  async prepare(ctx, input) {
    if (ctx.project.is_demo === 1) throw new ToolError("Competitor data is not fetched for demo projects.");
    await requireWorkspaceOwner(ctx.db, ctx.userId, ctx.project.workspace_id);
    const domain = trackedDomain(ctx, input.domain);
    await requireCredentials(ctx);
    const [ws, pid] = scoped(ctx);
    const since = `${ctx.now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    let counts: Array<{ domain: string; n: number; active: number }>;
    try {
      counts = await ctx.db.all<{ domain: string; n: number; active: number }>(
        `SELECT domain, COUNT(*) AS n, SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS active FROM competitor_fetches
          WHERE workspace_id = ? AND project_id = ? AND created_at >= ? AND status <> 'setup_required' GROUP BY domain`,
        ws,
        pid,
        since,
      );
    } catch (e) {
      if (isMissingTableError(e)) throw new ToolError(MIGRATION);
      throw e;
    }
    const mine = counts.find((c) => c.domain === domain);
    if (mine && Number(mine.active) > 0) throw new ToolError(`A refresh of ${domain} is already queued or running.`);
    if ((mine?.n ?? 0) >= REFRESHES_PER_DOMAIN_PER_DAY) throw new ToolError(`Refresh limit reached for ${domain} (${REFRESHES_PER_DOMAIN_PER_DAY} per domain per UTC day).`);
    if (counts.reduce((s, c) => s + Number(c.n), 0) >= FETCHES_PER_PROJECT_PER_DAY) throw new ToolError(`Competitor data refresh limit reached for this project (${FETCHES_PER_PROJECT_PER_DAY} per UTC day).`);
    return {
      title: `Refresh DataForSEO competitor data for ${domain}?`,
      detail: `About ${refreshCeiling()} at most, billed by DataForSEO; daily caps apply (${REFRESHES_PER_DOMAIN_PER_DAY} per domain, ${FETCHES_PER_PROJECT_PER_DAY} per project per UTC day). Pulls overview + top keywords, keyword gap and top pages (third-party estimates) and uses this project's provider budget.`,
    };
  },
  async execute(ctx, input) {
    if (ctx.project.is_demo === 1) throw new ToolError("Competitor data is not fetched for demo projects.");
    await requireWorkspaceOwner(ctx.db, ctx.userId, ctx.project.workspace_id);
    const domain = trackedDomain(ctx, input.domain);
    await resolveCreds(ctx);
    const rl = await hitRateLimit(ctx.db, `dfs_refresh:${ctx.project.id}:${ctx.userId}`, 10, 60, ctx.now);
    if (!rl.allowed) throw new ToolError("Too many refresh requests. Try again in a minute.");
    const r = await enqueueFetch(ctx.db, ctx.project, domain, "manual", ctx.userId, ctx.now);
    if (r.kind === "capped") throw new ToolError(r.message);
    const nav = { path: projectRoute(ctx.project.id, "competitors"), label: "Open Competitors" };
    if (r.kind === "existing") return { data: { fetch: toFetchSummary(r.fetch), existing: true }, summary: `A refresh of ${domain} is already ${r.fetch.status}`, navigate: nav };
    const work = processFetch(ctx.env, ctx.project.workspace_id, r.fetch.id, { fetchImpl: ctx.hooks?.dataforseoFetch });
    if (ctx.waitUntil) ctx.waitUntil(work);
    else await work;
    const latest = (await loadFetch(ctx.db, ctx.project.workspace_id, r.fetch.id)) ?? r.fetch;
    const f = toFetchSummary(latest);
    return {
      data: { domain, fetch: { ...f, error: clip(f.error, 300) }, costLabel: COST_LABEL, next: "Read the stored result with dataforseo_competitor_data once the status is completed or partial." },
      summary: `DataForSEO refresh of ${domain}: ${f.status}${typeof f.costUsd === "number" ? ` · ${usd(f.costUsd)} reported` : ""}`,
      navigate: nav,
    };
  },
};

// ------------------------------------------------------------------ keyword lookup (paid action)
export const KEYWORD_OVERVIEW_PATH = "/v3/dataforseo_labs/google/keyword_overview/live";
/** Keywords per lookup (DataForSEO allows 700; each returned item is billed). */
export const KEYWORD_LOOKUP_MAX = 100;
export const KEYWORD_LOOKUP_USER_LIMIT = { limit: 10, windowSeconds: 600 } as const;
export const KEYWORD_LOOKUP_PURPOSE = "chat_keyword_lookup";

/** Reservation ceiling at the published Labs price: one task + one billed item per keyword (USD). */
export function maxKeywordLookupCostUsd(keywords: number): number {
  return Math.round((DATAFORSEO_LABS_PRICE.perTaskUsd + keywords * DATAFORSEO_LABS_PRICE.perItemUsd) * 1e6) / 1e6;
}

const keywordSchema = z.object({
  keywords: z
    .array(z.string().trim().min(1).max(80))
    .min(1)
    .max(KEYWORD_LOOKUP_MAX)
    .describe(`Keywords the user asked about, verbatim (1-${KEYWORD_LOOKUP_MAX}; max 80 characters and 10 words each).`),
});

/** Normalized, deduplicated keywords; throws for phrases DataForSEO would refuse. */
export function normalizeKeywords(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const k = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (!k) continue;
    if (k.length > 80) throw new ToolError(`Keyword too long (max 80 characters): ${clip(k, 60)}`);
    if (k.split(" ").length > 10) throw new ToolError(`Keyword has more than 10 words: ${clip(k, 60)}`);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  if (out.length === 0) throw new ToolError("No keywords to look up.");
  return out;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export interface KeywordOverviewRow {
  keyword: string;
  searchVolume: number | null;
  cpcUsd: number | null;
  competition: number | null;
  competitionLevel: string | null;
  keywordDifficulty: number | null;
  mainIntent: string | null;
  monthlySearches: Array<{ month: string; searchVolume: number | null }>;
  lastUpdated: string | null;
}

/** items[] of keyword_overview tasks[0].result[0] (fields per the endpoint docs, read 2026-10-03). */
export function parseKeywordOverview(result: Record<string, unknown> | null, max = KEYWORD_LOOKUP_MAX): KeywordOverviewRow[] {
  const items = Array.isArray(result?.items) ? (result!.items as unknown[]) : [];
  const rows: KeywordOverviewRow[] = [];
  for (const it of items.slice(0, max)) {
    const o = obj(it);
    const keyword = clip(o?.keyword, 200);
    if (!keyword) continue;
    const info = obj(o?.keyword_info);
    const monthly = Array.isArray(info?.monthly_searches) ? (info!.monthly_searches as unknown[]) : [];
    rows.push({
      keyword,
      searchVolume: num(info?.search_volume),
      cpcUsd: num(info?.cpc),
      competition: num(info?.competition),
      competitionLevel: clip(info?.competition_level, 20),
      keywordDifficulty: num(obj(o?.keyword_properties)?.keyword_difficulty),
      mainIntent: clip(obj(o?.search_intent_info)?.main_intent, 30),
      monthlySearches: monthly
        .slice(0, 12)
        .map((m) => obj(m))
        .filter((m): m is Record<string, unknown> => !!m && num(m.year) !== null && num(m.month) !== null)
        .map((m) => ({ month: `${num(m.year)}-${String(num(m.month)).padStart(2, "0")}`, searchVolume: num(m.search_volume) })),
      lastUpdated: clip(info?.last_updated_time, 40),
    });
  }
  return rows;
}

const micros = (n: number) => Math.max(0, Math.round(n * 1_000_000));

const dataforseoKeywordLookup: ActionTool<typeof keywordSchema> = {
  name: "dataforseo_keyword_lookup",
  kind: "action",
  description: `Propose a live DataForSEO Labs Keyword Overview lookup for keywords the user asked about: monthly search volume, CPC, competition, keyword difficulty (0-100), main intent and 12-month volumes for the project's competitor-data location (Google). Third-party ESTIMATES. PAID: $${DATAFORSEO_LABS_PRICE.perTaskUsd} per lookup + $${DATAFORSEO_LABS_PRICE.perItemUsd} per keyword (at most ${usd(maxKeywordLookupCostUsd(KEYWORD_LOOKUP_MAX))} for ${KEYWORD_LOOKUP_MAX} keywords), billed by DataForSEO. Workspace owner only. Requires the user's confirmation; nothing is fetched before.`,
  schema: keywordSchema,
  async prepare(ctx, input) {
    if (ctx.project.is_demo === 1) throw new ToolError("Demo projects do not call DataForSEO.");
    await requireWorkspaceOwner(ctx.db, ctx.userId, ctx.project.workspace_id);
    const keywords = normalizeKeywords(input.keywords);
    await requireCredentials(ctx);
    let settings = null;
    try {
      settings = await loadSettings(ctx.db, ctx.project.workspace_id, ctx.project.id);
    } catch (e) {
      if (!isMissingTableError(e)) throw e;
    }
    const loc = usableLocation(settings, ctx.project);
    if (!loc && !regionOf(ctx.project.locale)) throw new ToolError(`setup_required: ${unmappedLocaleMessage(ctx.project)}`);
    const where = loc ? `${loc.locationName} / ${loc.languageName}` : `the project locale ${ctx.project.locale} (resolved with DataForSEO's free locations list)`;
    const shown = keywords.slice(0, 5).map((k) => `"${clip(k, 60)}"`).join(", ");
    return {
      title: `Look up ${keywords.length} keyword${keywords.length === 1 ? "" : "s"} in DataForSEO?`,
      detail: `${shown}${keywords.length > 5 ? ` and ${keywords.length - 5} more` : ""} · Google, ${where}. About ${usd(maxKeywordLookupCostUsd(keywords.length))} at most, billed by DataForSEO; uses this project's daily provider budget.`,
    };
  },
  async execute(ctx, input) {
    if (ctx.project.is_demo === 1) throw new ToolError("Demo projects do not call DataForSEO.");
    await requireWorkspaceOwner(ctx.db, ctx.userId, ctx.project.workspace_id);
    const keywords = normalizeKeywords(input.keywords);
    const resolved = await resolveCreds(ctx);
    const rl = await hitRateLimit(ctx.db, `chat_dfs_keywords:${ctx.userId}`, KEYWORD_LOOKUP_USER_LIMIT.limit, KEYWORD_LOOKUP_USER_LIMIT.windowSeconds, ctx.now);
    if (!rl.allowed) throw new ToolError(`Keyword lookup limit reached (${KEYWORD_LOOKUP_USER_LIMIT.limit} per 10 minutes). Try again later.`);
    const [ws, pid] = scoped(ctx);
    const apiFetch = apiFetchFor(ctx);
    const clock = () => ctx.now;
    const loc = await resolveLocation(ctx.env, ctx.db, ctx.project, resolved, apiFetch, clock);
    if (!loc.ok) throw new ToolError(loc.setup ? `setup_required: ${loc.message}` : loc.message);
    const location = loc.location;

    const budget = budgetForKeySource(createBudget(ctx.db, ctx.env, { workspaceId: ws, projectId: pid, runId: null }, clock), resolved.source);
    const ceiling = maxKeywordLookupCostUsd(keywords.length);
    let callsHeld: string;
    let usdHeld: string;
    try {
      callsHeld = await budget.reserve("provider_calls", 1);
      try {
        usdHeld = await budget.reserve("usd_micros", micros(ceiling));
      } catch (e) {
        await budget.release(callsHeld);
        throw e;
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        throw new ToolError(`Not looked up: ${/Global/i.test(e.message) ? "the operator's global daily allowance" : "this project's daily limit"} for ${e.resource === "usd_micros" ? "spend" : "provider calls"} is reached. Try again tomorrow or raise the project limits on the Usage page.`);
      }
      throw e;
    }

    const body = [{ keywords, location_code: location.locationCode, language_code: location.languageCode }];
    const outcome: CallOutcome = await dataForSeoRequest(apiFetch, resolved.creds, "POST", KEYWORD_OVERVIEW_PATH, body, { timeoutMs: LABS_TIMEOUT_MS, maxBytes: MAX_LABS_RESPONSE_BYTES });
    const calls = createCallRecorder(ctx.db, { workspaceId: ws, projectId: pid, runId: null }, clock);
    if (outcome.kind !== "not_sent") {
      await calls.record({
        provider: DATAFORSEO_PROVIDER,
        model: "labs/google/keyword_overview",
        purpose: KEYWORD_LOOKUP_PURPOSE,
        status: outcome.kind === "ok" ? "ok" : outcome.kind === "api_error" ? "error" : outcome.timeout ? "timeout" : "unknown",
        requestId: outcome.kind === "unknown" ? null : outcome.taskId,
        // The cost DataForSEO returned is the billed amount (null when absent = unknown).
        costUsd: outcome.kind === "unknown" ? null : outcome.costUsd,
        costIsEstimate: false,
        rateVersion: DATAFORSEO_RATE_VERSION,
        latencyMs: outcome.latencyMs,
        error: outcome.kind === "ok" ? null : outcome.kind === "api_error" ? describeApiError(outcome) : outcome.message,
      });
    }
    // Settle the reservations from what is known about the call.
    if (outcome.kind === "not_sent") {
      await budget.release(callsHeld);
      await budget.release(usdHeld);
      throw new ToolError(outcome.message);
    }
    await budget.settle(callsHeld, 1);
    const cost = outcome.kind === "unknown" ? null : outcome.costUsd;
    if (cost === null) await budget.markUnknown(usdHeld);
    else await budget.settle(usdHeld, micros(cost));
    if (outcome.kind === "api_error") throw new ToolError(describeApiError(outcome));
    if (outcome.kind === "unknown") throw new ToolError(`${outcome.message} The call may have been billed; it is counted at the ${usd(ceiling)} ceiling.`);

    const rows = parseKeywordOverview(outcome.result);
    const found = new Set(rows.map((r) => r.keyword.toLowerCase()));
    const data = {
      dataSource: `${ESTIMATE}: Keyword Overview, Google, ${location.locationName} / ${location.languageName}`,
      fetchedAt: ctx.now.toISOString(),
      costUsd: outcome.costUsd,
      costLabel: COST_LABEL,
      keywords: rows,
      noDataFor: keywords.filter((k) => !found.has(k)).map((k) => clip(k, 80)),
      notes: [
        "Search volume is DataForSEO's monthly average estimate (Google Ads based), not this site's Search Console impressions.",
        "Keyword difficulty is DataForSEO's 0-100 estimate of how hard it is to reach the top 10.",
      ],
    };
    return {
      data,
      summary: `DataForSEO keyword lookup: ${rows.length} of ${keywords.length} keyword(s) with data${typeof outcome.costUsd === "number" ? ` · ${usd(outcome.costUsd)} reported` : ""}`,
    };
  },
};

export const DATAFORSEO_CHAT_TOOLS = [dataforseoCompetitorData, dataforseoRefreshCompetitor, dataforseoKeywordLookup] as ChatTool[];
