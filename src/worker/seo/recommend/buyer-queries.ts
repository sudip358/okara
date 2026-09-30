/**
 * [A23] Buyer-query view (BUYER_QUERIES_VERSION): non-brand current-window Search Console queries that
 * Jev judges are typed by someone looking to buy, hire, or compare options before buying.
 *
 * Method:
 *  1. Latest usable sync; current-window query rows summed per normalized query (clicks, impressions;
 *     position = impression-weighted mean of the query's rows, a labelled approximation; top page = the
 *     page with the most impressions for the query, null for CSV query exports).
 *  2. Self-brand queries are excluded (gsc/brand.ts); competitor-name queries stay in and are counted.
 *  3. The top BUYER_MAX_QUERIES (300) by impressions are classified with two Noul questions per query in
 *     one batch (<= 50 questions per systemOne call; query-batch.ts, cached 7 days per query and
 *     question version):
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

export const BUYER_QUERIES_VERSION = "buyer-queries-2026-09-30.1";
export const BUYER_MAX_QUERIES = 300;
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
  const raw = await db.all<{ query: string; page: string | null; clicks: number; impressions: number; position: number }>(
    `SELECT query, page, clicks, impressions, position FROM gsc_metrics
      WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'current' AND query IS NOT NULL`,
    project.workspace_id,
    project.id,
    sync.id,
  );
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
  const eligible = nonBrand.filter((a) => a.impressions > 0).slice(0, BUYER_MAX_QUERIES);
  const segments = demandLookup(nonBrand.map((a) => ({ query: a.query, clicks: a.clicks, impressions: a.impressions })), project.language);
  const scope = `Non-brand queries from your Search Console data for ${window}${sync.source === "csv_import" ? " (CSV import)" : ""}: ${brandCount} brand ${brandCount === 1 ? "query is" : "queries are"} excluded; ${competitor} ${competitor === 1 ? "query names" : "queries name"} a competitor and ${competitor === 1 ? "is" : "are"} included.`;
  const labels: string[] = [BUYER_LABELS.method, BUYER_LABELS.flag, scope, BUYER_LABELS.position, BUYER_LABELS.notVolume];

  if (isDemo) {
    return { state: "demo", generatedAt, rows: [], completeness: { note: `${eligible.length} non-brand queries; not classified in demo mode.`, covered: 0, total: nonBrand.length }, labels: [BUYER_LABELS.demo, ...labels] };
  }
  if (!deps.decisions) {
    return {
      state: "setup_required",
      generatedAt,
      rows: [],
      completeness: { note: `${eligible.length} non-brand queries are waiting for intent classification.`, covered: 0, total: nonBrand.length },
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
      maxCalls: deps.classify ? undefined : 0,
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
  const stopped =
    !deps.classify && classified < eligible.length
      ? "; the rest are not classified yet (Classify with Jev asks for them)"
      : res.stoppedBy === "budget"
      ? "; the daily Jev budget was reached, so the rest are unclassified"
      : res.stoppedBy === "error"
        ? `; Jev was unavailable (${res.error ?? "error"}), so the rest are unclassified`
        : "";
  const note = `${classified} of ${eligible.length} non-brand queries classified (top ${BUYER_MAX_QUERIES} by impressions; ${res.cached} from the 7-day cache, ${res.calls} Jev call${res.calls === 1 ? "" : "s"})${stopped}. ${rows.length} buyer queries.${unlabelled ? ` ${unlabelled} buyer queries had no usable ready-to-buy answer and are not listed.` : ""}`;
  return {
    state: "ready",
    generatedAt,
    rows: rows.sort((x, y) => y.impressions - x.impressions || (x.query < y.query ? -1 : 1)),
    completeness: { note, covered: classified, total: nonBrand.length },
    labels: [...labels, `Method ${BUYER_QUERIES_VERSION}.`],
  };
}
