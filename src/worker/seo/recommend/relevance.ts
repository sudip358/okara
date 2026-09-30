/**
 * [A23] Query relevance pre-filter (RELEVANCE_VERSION): before candidates are built, Jev answers one
 * Noul per query, "Is `queries.q<n>` about this business's products, services, or audience?", for
 *   - current-window GSC queries that could drive a candidate (impressions >= the smallest query
 *     threshold in the candidate config), non-brand, top RELEVANCE_MAX_QUERIES by impressions;
 *   - engine search queries captured by the GEO agent (first maxEngineQueries groups).
 * Brand queries are not asked (they are about the business by definition).
 * Outcome per query (policy bands, seo.query_relevance; no confidence field):
 *   confident no (Act, noul <= no band)  -> dropped from candidate generation (decision row: rejected low_fit)
 *   middle band (Flag)                   -> kept; candidates built on it are capped at Flag
 *   confident yes / no usable answer     -> kept unchanged (a missing answer never filters anything)
 * Batched <= 50 questions per systemOne call and cached for 7 days in decision_records (query-batch.ts).
 */
import type { RunContext } from "../../runs/context";
import { createBrandClassifier } from "../gsc/brand";
import { normalizeDemandQuery } from "../gsc/demand";
import { QUESTION, queryRelevanceQuestion } from "../questions";
import type { CandidateConfig } from "./candidates";
import { DEFAULT_CANDIDATE_CONFIG } from "./candidates";
import { callDecisions, noulBand } from "./decide";
import type { CandidateInputs, QueryFilter } from "./inputs";
import { judgeQueries } from "./query-batch";

export const RELEVANCE_VERSION = "query-relevance-2026-09-30.1";
export const RELEVANCE_MAX_QUERIES = 100;
export const RELEVANCE_CACHE_PREFIX = "qrel";
/** Calls per run for the pre-filter (the rest of the Jev budget stays for candidates). */
export const RELEVANCE_MAX_CALLS = 3;

/** Queries worth asking about (pure). */
export function relevanceQueries(inputs: CandidateInputs, config: Partial<CandidateConfig> = {}): string[] {
  const cfg = { ...DEFAULT_CANDIDATE_CONFIG, ...config };
  const brand = createBrandClassifier(inputs.project.brandTerms ?? { self: [], competitors: [], skipped: [] });
  const min = Math.min(cfg.minImpressions, cfg.coverageGapMinQueryImpressions, cfg.answerMinImpressions);
  const agg = new Map<string, { query: string; impressions: number }>();
  for (const r of inputs.rows) {
    if (r.window !== "current" || !r.query) continue;
    const k = normalizeDemandQuery(r.query);
    if (!k) continue;
    const a = agg.get(k) ?? { query: r.query, impressions: 0 };
    a.impressions += r.impressions;
    agg.set(k, a);
  }
  const gsc = [...agg.values()]
    .filter((a) => a.impressions >= min && !brand.isSelfBrand(a.query))
    .sort((a, b) => b.impressions - a.impressions || (a.query < b.query ? -1 : 1))
    .slice(0, RELEVANCE_MAX_QUERIES)
    .map((a) => a.query);
  const engine = inputs.engineQueries
    .slice(0, cfg.maxEngineQueries)
    .map((g) => g.example)
    .filter((q) => !brand.isSelfBrand(q));
  const seen = new Set<string>();
  return [...gsc, ...engine].filter((q) => {
    const k = normalizeDemandQuery(q);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface RelevanceRun {
  filter: QueryFilter | null;
  asked: number;
  cached: number;
  calls: number;
  note: string;
}

export async function prejudgeQueryRelevance(ctx: RunContext, inputs: CandidateInputs, config: Partial<CandidateConfig> = {}): Promise<RelevanceRun> {
  const queries = relevanceQueries(inputs, config);
  if (!ctx.decisions || queries.length === 0) return { filter: null, asked: 0, cached: 0, calls: 0, note: "" };
  const p = inputs.project;
  const res = await judgeQueries(
    { db: ctx.db, workspaceId: ctx.project.workspaceId, projectId: ctx.project.id, runId: ctx.runId, now: ctx.clock(), call: (purpose, state, questions) => callDecisions(ctx, purpose, state, questions) },
    {
      purpose: "seo_decision:query_relevance",
      cachePrefix: RELEVANCE_CACHE_PREFIX,
      specs: [{ id: QUESTION.queryRelevance, make: queryRelevanceQuestion }],
      baseState: {
        business: {
          name: p.brandName ?? "",
          products: (p.productDescription ?? "").slice(0, 600),
          audience: (p.audience ?? "").slice(0, 300),
          site_type: p.siteType,
          locale: p.locale,
          language: p.language,
        },
      },
      queries,
      outcome: (j) => {
        const a = j.answers[QUESTION.queryRelevance]!;
        const band = noulBand({ questionId: QUESTION.queryRelevance, questionVersion: a.questionVersion, answer: a.answer, tier: a.tier });
        return band === "no" ? { outcome: "rejected", reasonCode: "low_fit" } : { outcome: "selected", reasonCode: band === null ? "insufficient_evidence" : null };
      },
      maxCalls: RELEVANCE_MAX_CALLS,
    },
  );
  const dropped = new Set<string>();
  const flagged = new Set<string>();
  for (const j of res.results.values()) {
    const a = j.answers[QUESTION.queryRelevance]!;
    const band = noulBand({ questionId: QUESTION.queryRelevance, questionVersion: a.questionVersion, answer: a.answer, tier: a.tier });
    const k = normalizeDemandQuery(j.query);
    if (band === "no") dropped.add(k);
    else if (band === "middle") flagged.add(k);
  }
  const unasked = queries.length - res.results.size;
  const note =
    `Query relevance (${RELEVANCE_VERSION}): ${res.results.size} of ${queries.length} queries judged (${res.cached} from the 7-day cache, ${res.calls} call${res.calls === 1 ? "" : "s"}); ` +
    `${dropped.size} dropped as not about the business, ${flagged.size} flagged for review.` +
    (unasked > 0 ? ` ${unasked} not judged (${res.stoppedBy === "budget" ? "call limit or budget" : res.stoppedBy === "error" ? `Jev unavailable: ${res.error ?? "error"}` : "skipped"}); they are kept.` : "");
  return { filter: { dropped, flagged, version: RELEVANCE_VERSION }, asked: res.asked, cached: res.cached, calls: res.calls, note };
}
