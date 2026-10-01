/**
 * Batched per-query Jev questions with a 7-day decision cache [A13]/[A23]. Used by the query relevance
 * pre-filter (agent run) and the buyer-query view (route).
 *
 * - One keyed question per query and spec (`<id>#q<n>`), pointing at `queries.q<n>` in a shared state
 *   (the state is deduplicated: business/brand/locale once, the queries once). At most
 *   QUERY_BATCH_QUESTIONS questions per systemOne call.
 * - Cache: decision_records rows of this project with the same question id, question_version, and
 *   candidate key `<prefix>:<normalized query>`, answered by a provider within QUERY_CACHE_DAYS days.
 *   A stored "no usable answer" (null, i.e. Drop) is reused too, so a query is not re-asked for 7 days
 *   either way. Tiers are recomputed from the stored raw answer with the current policy, so a threshold
 *   change re-scores without new calls.
 * - Every asked (query, question) gets a decision_records row (run id when inside a run, else null).
 * - A budget refusal or a failed call stops further calls; queries not asked stay unclassified.
 * - maxCalls bounds the calls of one invocation (callers page through large query sets across requests:
 *   the next invocation reuses the cache and continues). Hitting it sets hitMaxCalls (stoppedBy stays
 *   "budget" for existing callers).
 * - The cache lookup binds every spec id and a chunk of keys in one statement, within D1's 100 bound
 *   parameters per statement.
 */
import type { Tier } from "@shared/types";
import { BudgetExceededError } from "../../lib/errors";
import type { Db } from "../../lib/db";
import { hashJson } from "../../lib/hash";
import { newId } from "../../lib/ids";
import { iso } from "../../lib/time";
import type { DecisionAnswer, DecisionQuestion, DecisionResult } from "../../providers/types";
import { POLICY_VERSION, tierFor } from "../../runs/policy";
import { normalizeDemandQuery } from "../gsc/demand";
import { safeMessage } from "../gsc/sync";
import { versionFor } from "../questions";

export const QUERY_BATCH_QUESTIONS = 50;
export const QUERY_CACHE_DAYS = 7;
export const QUERY_KEY_MAX = 300;
/** D1 allows 100 bound parameters per statement; the cache lookup binds 3 fixed values, the spec ids and versions, and the keys. */
const D1_MAX_PARAMS = 100;
const CACHE_LOOKUP_FIXED_PARAMS = 3;
/** At most this many question specs per judgeQueries call (keeps the key chunk large). */
export const QUERY_MAX_SPECS = 10;

export interface QueryBatchDeps {
  db: Db;
  workspaceId: string;
  projectId: string;
  runId: string | null;
  now: Date;
  call: (purpose: string, state: unknown, questions: Record<string, DecisionQuestion>) => Promise<DecisionResult>;
}

export interface QueryQuestionSpec {
  /** Base question id (decision_records.question_id). */
  id: string;
  /** Question pointing at a state path (e.g. `queries.q7`). */
  make: (path: string) => DecisionQuestion;
}

export interface QueryAnswer {
  answer: DecisionAnswer | undefined;
  tier: Tier;
  questionVersion: string;
}

export interface QueryJudgment {
  query: string;
  key: string;
  answers: Record<string, QueryAnswer>;
  provider: string;
  model: string;
  cached: boolean;
}

export interface QueryBatchResult {
  results: Map<string, QueryJudgment>;
  asked: number;
  cached: number;
  calls: number;
  stoppedBy: "budget" | "error" | null;
  /** True when opts.maxCalls stopped further calls (more queries remain uncached). */
  hitMaxCalls: boolean;
  error: string | null;
}

export const queryCacheKey = (prefix: string, query: string) => `${prefix}:${normalizeDemandQuery(query)}`.slice(0, QUERY_KEY_MAX);

function validNoulOrChoice(q: DecisionQuestion, a: DecisionAnswer | undefined): DecisionAnswer | undefined {
  if (!a || a.type !== q.type) return undefined;
  if (a.type === "choice" && q.type === "choice" && !(a.choice in q.criteria)) return undefined;
  if (a.type === "score" && q.type === "score" && !(a.score >= 0 && a.score < q.criteria.length)) return undefined;
  return a;
}

const isBudget = (e: unknown) => e instanceof BudgetExceededError || (e instanceof Error && e.cause instanceof BudgetExceededError);

export async function judgeQueries(
  deps: QueryBatchDeps,
  opts: {
    purpose: string;
    cachePrefix: string;
    specs: QueryQuestionSpec[];
    baseState: Record<string, unknown>;
    queries: string[];
    /** Decision outcome written on each asked row. */
    outcome: (j: QueryJudgment) => { outcome: "selected" | "rejected"; reasonCode: string | null };
    maxCalls?: number;
  },
): Promise<QueryBatchResult> {
  const results = new Map<string, QueryJudgment>();
  const unique = new Map<string, string>();
  for (const q of opts.queries) {
    const k = queryCacheKey(opts.cachePrefix, q);
    if (k.length > opts.cachePrefix.length + 1 && !unique.has(k)) unique.set(k, q);
  }
  const versions: Record<string, string> = {};
  for (const s of opts.specs) versions[s.id] = await versionFor(s.id, s.make("queries.q1"));

  // 1. Cache.
  const since = iso(new Date(deps.now.getTime() - QUERY_CACHE_DAYS * 86400_000));
  const keys = [...unique.keys()];
  const hits = new Map<string, Map<string, { answer: DecisionAnswer | null; provider: string; model: string }>>();
  if (opts.specs.length === 0 || opts.specs.length > QUERY_MAX_SPECS) throw new Error(`judgeQueries takes 1..${QUERY_MAX_SPECS} question specs`);
  const specIds = opts.specs.map((s) => s.id);
  const versionList = [...new Set(specIds.map((id) => versions[id]!))];
  const chunkSize = D1_MAX_PARAMS - CACHE_LOOKUP_FIXED_PARAMS - specIds.length - versionList.length;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    // One statement per chunk for all specs; each spec has its own version, matched in code below.
    const rows = await deps.db.all<{ candidate_key: string; question_id: string; question_version: string; answer_json: string | null; provider: string | null; model: string | null }>(
      `SELECT candidate_key, question_id, question_version, answer_json, provider, model FROM decision_records
        WHERE workspace_id = ? AND project_id = ? AND created_at >= ? AND provider IS NOT NULL
          AND question_id IN (${specIds.map(() => "?").join(",")})
          AND question_version IN (${versionList.map(() => "?").join(",")})
          AND candidate_key IN (${chunk.map(() => "?").join(",")})
        ORDER BY created_at DESC`,
      deps.workspaceId,
      deps.projectId,
      since,
      ...specIds,
      ...versionList,
      ...chunk,
    );
    for (const r of rows) {
      if (versions[r.question_id] !== r.question_version) continue; // older question wording: ask again
      let answer: DecisionAnswer | null = null;
      try {
        answer = (JSON.parse(r.answer_json ?? "{}") as { answer?: DecisionAnswer | null }).answer ?? null;
      } catch {
        continue; // unreadable row: ask again
      }
      const m = hits.get(r.candidate_key) ?? new Map();
      if (!m.has(r.question_id)) m.set(r.question_id, { answer, provider: r.provider!, model: r.model ?? "" });
      hits.set(r.candidate_key, m);
    }
  }
  let cached = 0;
  const toAsk: Array<[string, string]> = [];
  for (const [k, q] of unique) {
    const m = hits.get(k);
    if (m && opts.specs.every((s) => m.has(s.id))) {
      const first = m.get(opts.specs[0]!.id)!;
      const answers: Record<string, QueryAnswer> = {};
      for (const s of opts.specs) {
        const a = m.get(s.id)!.answer ?? undefined;
        answers[s.id] = { answer: a, tier: tierFor(s.id, a), questionVersion: versions[s.id]! };
      }
      results.set(k, { query: q, key: k, answers, provider: first.provider, model: first.model, cached: true });
      cached++;
    } else toAsk.push([k, q]);
  }

  // 2. Ask the rest in batches.
  const perCall = Math.max(1, Math.floor(QUERY_BATCH_QUESTIONS / Math.max(1, opts.specs.length)));
  let calls = 0;
  let asked = 0;
  let stoppedBy: QueryBatchResult["stoppedBy"] = null;
  let hitMaxCalls = false;
  let error: string | null = null;
  for (let i = 0; i < toAsk.length; i += perCall) {
    if (opts.maxCalls !== undefined && calls >= opts.maxCalls) {
      stoppedBy = "budget";
      hitMaxCalls = true;
      break;
    }
    const batch = toAsk.slice(i, i + perCall);
    const queries: Record<string, string> = {};
    const questions: Record<string, DecisionQuestion> = {};
    batch.forEach(([, q], j) => {
      const ref = `q${j + 1}`;
      queries[ref] = q;
      for (const s of opts.specs) questions[`${s.id}#${ref}`] = s.make(`queries.${ref}`);
    });
    const state = { ...opts.baseState, queries };
    let res: DecisionResult;
    try {
      calls++;
      res = await deps.call(opts.purpose, state, questions);
    } catch (e) {
      stoppedBy = isBudget(e) ? "budget" : "error";
      error = safeMessage(e);
      break;
    }
    const stateHash = await hashJson(state);
    const now = iso(deps.now);
    for (let j = 0; j < batch.length; j++) {
      const [k, q] = batch[j]!;
      const ref = `q${j + 1}`;
      const answers: Record<string, QueryAnswer> = {};
      for (const s of opts.specs) {
        const qid = `${s.id}#${ref}`;
        const a = validNoulOrChoice(questions[qid]!, res.answers[qid]);
        answers[s.id] = { answer: a, tier: tierFor(s.id, a), questionVersion: versions[s.id]! };
      }
      const judgment: QueryJudgment = { query: q, key: k, answers, provider: res.provider, model: res.model, cached: false };
      results.set(k, judgment);
      asked++;
      const out = opts.outcome(judgment);
      for (const s of opts.specs) {
        const a = answers[s.id]!;
        await deps.db.insert("decision_records", {
          id: newId("dec"),
          workspace_id: deps.workspaceId,
          project_id: deps.projectId,
          run_id: deps.runId,
          agent: "seo",
          candidate_key: k,
          question_id: s.id,
          question_version: a.questionVersion,
          policy_version: POLICY_VERSION,
          provider: res.provider,
          model: res.model,
          state_hash: stateHash,
          answer_json: JSON.stringify({ answer: a.answer ?? null, query: q, questionTier: a.tier }),
          tier: a.tier,
          outcome: out.outcome,
          reason_code: out.reasonCode,
          created_at: now,
        });
      }
    }
  }
  return { results, asked, cached, calls, stoppedBy, hitMaxCalls, error };
}
