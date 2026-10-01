/**
 * [A23] Buyer-query view (BUYER_QUERIES_VERSION): non-brand current-window Search Console queries that
 * Jev judges are typed by someone looking to buy, hire, or compare options before buying.
 *
 * Method:
 *  1. Latest usable sync; current-window query rows summed per normalized query (clicks, impressions;
 *     position = impression-weighted mean of the query's rows, a labelled approximation; top page = the
 *     page with the most impressions for the query, null for CSV query exports).
 *  2. Self-brand queries are excluded (gsc/brand.ts); competitor-name queries stay in and are counted.
 *  3. All non-brand queries with impressions, up to a configurable cap (BUYER_MAX_QUERIES = 5,000 by
 *     default; deps.maxQueries / env BUYER_QUERIES_MAX, never above BUYER_MAX_QUERIES_LIMIT), ordered by
 *     impressions, are classified with two Noul questions per query (<= QUERY_BATCH_QUESTIONS = 50
 *     questions, i.e. 25 queries, per systemOne call; query-batch.ts, cached 7 days per query and
 *     question version). Stored rows are read in pages of GSC_PAGE_ROWS (keyset on id). One POST asks
 *     at most BUYER_CALLS_PER_REQUEST calls (200 queries); the next POST reuses the cache and continues,
 *     so the full export is worked through across requests (and days) within the daily jev_calls budget.
 *     The response says "classified N of M" honestly and what stopped it (request limit, budget, error).
 *       seo.buyer_query  yes band (Act) -> listed; middle band -> listed as Flag ("Check this yourself");
 *                        no band or no usable answer -> not listed
 *       seo.buyer_ready  labels a listed row: noul >= 0.5 -> transactional, else commercial_investigation;
 *                        a middle-band answer makes the row Flag; no usable answer -> not listed
 *                        (intents are never guessed)
 *     intentTier = the worse of the two tiers (act < flag).
 *  4. Without Jev (no TypeSafe key): state setup_required and no rows. Demo projects never call Jev.
 *  5. classify=false (the GET view) reads the decision cache only and never calls Jev; queries without a
 *     cached answer are reported as not classified yet. Only the POST action (classify=true) spends budget.
 * Budget: every call reserves jev_calls (and provider_calls for the TypeSafe adapter) before dispatch; a
 * refusal stops further calls and the remaining queries stay unclassified (completeness says so).
 */
import type { BuyerQueryRow, CoverageResponse, Tier } from "@shared/types";
import type { Db } from "../../lib/db";
import type { ProjectRow } from "../../platform/access";
import type { CallRecorder, DecisionProvider } from "../../providers/types";
import type { Budget } from "../../runs/context";
import { weightedPosition } from "../gsc/aggregate";
import { demandLookup, normalizeDemandQuery } from "../gsc/demand";
import { projectBrandClassifier } from "../gsc/overview";
import { latestUsableSync } from "../gsc/overview";
import { windowLabel } from "../gsc/windows";
import { localeCountryAlpha2 } from "../gsc/countries";
import { buyerQueryQuestion, buyerReadyQuestion, QUESTION } from "../questions";
import { callDecisions, noulBand } from "./decide";
import { judgeQueries, queryCacheKey, type QueryJudgment } from "./query-batch";

export const BUYER_QUERIES_VERSION = "buyer-queries-2026-10-01.1";
/** Default cap on non-brand queries in scope (by impressions). */
export const BUYER_MAX_QUERIES = 5000;
/** Hard ceiling for a configured cap. */
export const BUYER_MAX_QUERIES_LIMIT = 20000;
/** Jev calls one POST may make (25 queries per call); further queries wait for the next POST. */
export const BUYER_CALLS_PER_REQUEST = 8;
/** Classify POSTs per project per day (routes/seo-overview.ts), separate from the shared Jev budget. */
export const BUYER_CLASSIFY_DAILY_LIMIT = 3;
/** Stored Search Console rows read per page. */
export const GSC_PAGE_ROWS = 2000;

/** Effective cap: a positive integer from config, clamped to the hard ceiling; otherwise the default. */
export function buyerQueryCap(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n < 1) return BUYER_MAX_QUERIES;
  return Math.min(BUYER_MAX_QUERIES_LIMIT, Math.floor(n));
}
export const BUYER_CACHE_PREFIX = "buyer";

export const BUYER_LABELS = {
  method:
    'Buyer intent judged by Jev (TypeSafe) with one yes/no question per query: "Is this query typed by someone looking to buy, hire, or compare options before buying?" A second yes/no question separates ready-to-buy (transactional) from still-comparing (commercial investigation).',
  flag: "Rows marked flag are uncertain: check them yourself.",
  notVolume: "Impressions and clicks are from your own Search Console data, not market search volume; no ranking or revenue is implied.",
  position: "Position is an impression-weighted average of query+page rows (an approximation, not Google's aggregate).",
  noJev: "Buyer queries need Jev (TypeSafe) to judge search intent. Add a TypeSafe key in Integrations; intents are never guessed without it.",
  noGsc: "Connect Search Console or import a Queries CSV export to see buyer queries.",
  demo: "Demo data - simulated run: buyer intents are not classified for demo projects.",
} as const;

export interface BuyerQueriesDeps {
  db: Db;
  project: ProjectRow;
  now: Date;
  /** null = TypeSafe not configured (setup required). Ignored for demo projects. */
  decisions: DecisionProvider | null;
  budget: Budget;
  calls: CallRecorder;
  /** false: cached decisions only, no Jev calls (GET). true: ask Jev for uncached queries (POST). */
  classify: boolean;
  /** Cap on queries in scope (default BUYER_MAX_QUERIES; see buyerQueryCap). */
  maxQueries?: number;
  /** Jev calls per invocation when classify=true (default BUYER_CALLS_PER_REQUEST). */
  maxCallsPerRequest?: number;
}

type GscQueryRow = { id: number; query: string; page: string | null; clicks: number; impressions: number; position: number };

/** All current-window query rows of a sync, read in keyset pages (bounded statement size and memory per page). */
async function readQueryRows(db: Db, workspaceId: string, projectId: string, syncId: string): Promise<GscQueryRow[]> {
  const out: GscQueryRow[] = [];
  let after = 0;
  for (;;) {
    const page = await db.all<GscQueryRow>(
      `SELECT id, query, page, clicks, impressions, position FROM gsc_metrics
        WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'current' AND query IS NOT NULL AND id > ?
        ORDER BY id LIMIT ?`,
      workspaceId,
      projectId,
      syncId,
      after,
      GSC_PAGE_ROWS,
    );
    out.push(...page);
    if (page.length < GSC_PAGE_ROWS) return out;
    after = page[page.length - 1]!.id;
  }
}

interface QueryAgg {
  query: string;
  key: string;
  clicks: number;
  impressions: number;
  rows: Array<{ page: string | null; impressions: number; position: number }>;
}

const TIER_RANK: Record<Tier, number> = { act: 0, "n/a": 0, flag: 1, drop: 2 };
const worseTier = (a: Tier, b: Tier): Tier => (TIER_RANK[b] > TIER_RANK[a] ? b : a);

/** Row for one judged query, or null when it is not a buyer query or its label is unavailable. Pure. */
export function buyerRowFrom(j: QueryJudgment, agg: { impressions: number; clicks: number; position: number | null; topPage: string | null }, segment: BuyerQueryRow["segment"]): BuyerQueryRow | null {
  const bq = j.answers[QUESTION.buyerQuery];
  const ready = j.answers[QUESTION.buyerReady];
  if (!bq || !ready) return null;
  const gate = noulBand({ questionId: QUESTION.buyerQuery, questionVersion: bq.questionVersion, answer: bq.answer, tier: bq.tier });
  if (gate !== "yes" && gate !== "middle") return null;
  const label = noulBand({ questionId: QUESTION.buyerReady, questionVersion: ready.questionVersion, answer: ready.answer, tier: ready.tier });
  if (label === null || ready.answer?.type !== "noul") return null;
  const intent: BuyerQueryRow["intent"] = ready.answer.noul >= 0.5 ? "transactional" : "commercial_investigation";
  const tier = worseTier(gate === "yes" ? "act" : "flag", label === "middle" ? "flag" : "act");
  return { query: j.query, intent, intentTier: tier, impressions: agg.impressions, clicks: agg.clicks, position: agg.position, topPage: agg.topPage, segment };
}

export async function buildBuyerQueries(deps: BuyerQueriesDeps): Promise<CoverageResponse<BuyerQueryRow>> {
  const { db, project, now } = deps;
  const generatedAt = now.toISOString();
  const isDemo = project.is_demo === 1;
  const sync = await latestUsableSync(db, project.workspace_id, project.id);
  if (!sync) {
    return { state: isDemo ? "demo" : "setup_required", generatedAt, rows: [], completeness: { note: "No Search Console data imported yet.", covered: null, total: null }, labels: [BUYER_LABELS.noGsc] };
  }
  const window = windowLabel({ start: sync.window_start, end: sync.window_end });
  const raw = await readQueryRows(db, project.workspace_id, project.id, sync.id);
  const cap = buyerQueryCap(deps.maxQueries);
  const classifier = await projectBrandClassifier(db, project);
  const byKey = new Map<string, QueryAgg>();
  let competitor = 0;
  for (const r of raw) {
    const key = normalizeDemandQuery(r.query);
    if (!key) continue;
    const a = byKey.get(key) ?? { query: r.query, key, clicks: 0, impressions: 0, rows: [] };
    a.clicks += Math.round(r.clicks);
    a.impressions += Math.round(r.impressions);
    a.rows.push({ page: r.page, impressions: Math.round(r.impressions), position: Number(r.position) || 0 });
    byKey.set(key, a);
  }
  const nonBrand: QueryAgg[] = [];
  let brandCount = 0;
  for (const a of byKey.values()) {
    const m = classifier.classify(a.query);
    if (m.kind === "self_brand") brandCount++;
    else {
      if (m.kind === "competitor_brand") competitor++;
      nonBrand.push(a);
    }
  }
  nonBrand.sort((x, y) => y.impressions - x.impressions || (x.key < y.key ? -1 : 1));
  const withImpressions = nonBrand.filter((a) => a.impressions > 0);
  const eligible = withImpressions.slice(0, cap);
  const capped = withImpressions.length > eligible.length;
  const scopeNote = capped
    ? `top ${formatInt(cap)} of ${formatInt(withImpressions.length)} by impressions (cap)`
    : `all ${formatInt(eligible.length)} with impressions`;
  const segments = demandLookup(nonBrand.map((a) => ({ query: a.query, clicks: a.clicks, impressions: a.impressions })), project.language);
  const scope = `Non-brand queries from your Search Console data for ${window}${sync.source === "csv_import" ? " (CSV import)" : ""}: ${brandCount} brand ${brandCount === 1 ? "query is" : "queries are"} excluded; ${competitor} ${competitor === 1 ? "query names" : "queries name"} a competitor and ${competitor === 1 ? "is" : "are"} included.`;
  const labels: string[] = [BUYER_LABELS.method, BUYER_LABELS.flag, scope, BUYER_LABELS.position, BUYER_LABELS.notVolume];

  if (isDemo) {
    return { state: "demo", generatedAt, rows: [], completeness: { note: `${eligible.length} non-brand queries; not classified in demo mode.`, covered: 0, total: eligible.length }, labels: [BUYER_LABELS.demo, ...labels] };
  }
  if (!deps.decisions) {
    return {
      state: "setup_required",
      generatedAt,
      rows: [],
      completeness: { note: `${eligible.length} non-brand queries are waiting for intent classification.`, covered: 0, total: eligible.length },
      labels: [BUYER_LABELS.noJev, scope],
    };
  }

  const res = await judgeQueries(
    {
      db,
      workspaceId: project.workspace_id,
      projectId: project.id,
      runId: null,
      now,
      call: (purpose, state, questions) => callDecisions({ decisions: deps.decisions, budget: deps.budget, calls: deps.calls }, purpose, state, questions),
    },
    {
      purpose: "seo.buyer_queries",
      cachePrefix: BUYER_CACHE_PREFIX,
      specs: [
        { id: QUESTION.buyerQuery, make: buyerQueryQuestion },
        { id: QUESTION.buyerReady, make: buyerReadyQuestion },
      ],
      baseState: {
        country: localeCountryAlpha2(project.locale),
        locale: project.locale,
        language: project.language,
        site_type: project.site_type,
        brand_terms: { self: classifier.terms.self, competitors: classifier.terms.competitors },
      },
      queries: eligible.map((a) => a.query),
      maxCalls: deps.classify ? Math.max(1, Math.floor(deps.maxCallsPerRequest ?? BUYER_CALLS_PER_REQUEST)) : 0,
      outcome: (j) => {
        const bq = j.answers[QUESTION.buyerQuery]!;
        const band = noulBand({ questionId: QUESTION.buyerQuery, questionVersion: bq.questionVersion, answer: bq.answer, tier: bq.tier });
        return band === "yes" || band === "middle" ? { outcome: "selected", reasonCode: null } : { outcome: "rejected", reasonCode: band === null ? "insufficient_evidence" : "out_of_scope" };
      },
    },
  );

  const rows: BuyerQueryRow[] = [];
  let unlabelled = 0;
  for (const a of eligible) {
    const j = res.results.get(queryCacheKey(BUYER_CACHE_PREFIX, a.query));
    if (!j) continue;
    const top = [...a.rows].filter((r) => r.page).sort((x, y) => y.impressions - x.impressions)[0];
    const row = buyerRowFrom(j, { impressions: a.impressions, clicks: a.clicks, position: weightedPosition(a.rows), topPage: top?.page ?? null }, segments.get(a.key)?.segment ?? null);
    if (row) rows.push(row);
    else {
      const bq = j.answers[QUESTION.buyerQuery];
      const gate = bq ? noulBand({ questionId: QUESTION.buyerQuery, questionVersion: bq.questionVersion, answer: bq.answer, tier: bq.tier }) : null;
      if (gate === "yes" || gate === "middle") unlabelled++;
    }
  }
  const classified = res.results.size;
  const remaining = eligible.length - classified;
  const stopped =
    remaining <= 0
      ? ""
      : !deps.classify
        ? `; ${formatInt(remaining)} not classified yet (Classify with Jev asks for them)`
        : res.hitMaxCalls
          ? `; ${formatInt(remaining)} not classified yet: one request asks Jev at most ${deps.maxCallsPerRequest ?? BUYER_CALLS_PER_REQUEST} times, so Classify with Jev again to continue (up to ${BUYER_CLASSIFY_DAILY_LIMIT} requests per project per day)`
          : res.stoppedBy === "budget"
            ? `; the daily Jev budget was reached, so ${formatInt(remaining)} are unclassified (cached answers are kept; continue tomorrow)`
            : res.stoppedBy === "error"
              ? `; Jev was unavailable (${res.error ?? "error"}), so ${formatInt(remaining)} are unclassified`
              : "";
  const note = `${formatInt(classified)} of ${formatInt(eligible.length)} non-brand queries classified (${scopeNote}; ${formatInt(res.cached)} from the 7-day cache, ${res.calls} Jev call${res.calls === 1 ? "" : "s"})${stopped}. ${formatInt(rows.length)} buyer queries.${unlabelled ? ` ${unlabelled} buyer queries had no usable ready-to-buy answer and are not listed.` : ""}`;
  return {
    state: "ready",
    generatedAt,
    rows: rows.sort((x, y) => y.impressions - x.impressions || (x.query < y.query ? -1 : 1)),
    completeness: { note, covered: classified, total: eligible.length },
    labels: [...labels, `Method ${BUYER_QUERIES_VERSION}.`],
  };
}

const formatInt = (n: number) => n.toLocaleString("en-US");
