/**
 * [A5]/[A13] Evaluation harness: replays hand-labelled rows through a DecisionProvider and reports
 * agreement with the human label (overall and by Act/Flag/Drop tier), latency p50/p95, and cost per
 * call (actual / estimate / unknown). Pure except for the provider call, so it is unit-testable.
 */
import type { DecisionAnswer, DecisionProvider, DecisionQuestion, ProviderCallRecord } from "../providers/types";
import { POLICY_VERSION, questionVersion, tierFor } from "../runs/policy";
import { SEO_STATIC_QUESTIONS, seoQuestionFor, versionFor } from "../seo/questions";
import { GEO_QUESTION_IDS, geoQuestion, type GeoQuestionId } from "../geo/questions";

export interface LabelRow {
  id: string;
  question_id: string;
  question_version?: string;
  state: unknown;
  human_answer: string | number | boolean;
  /** GEO templates are instantiated for one state key / brand. */
  ref?: string;
  brand?: string;
}

/**
 * Every SEO question id is registered from seo/questions.ts (SEO_STATIC_QUESTIONS), including the [A23]
 * ones: seo.query_relevance, seo.thin_content, seo.page_action, seo.schema_content_match,
 * seo.title_matches_query, seo.meta_matches_query, seo.covers_topic, seo.outdated_information,
 * seo.answer_is_direct, seo.buyer_query, seo.buyer_ready. Templated questions point at `row.ref` (a state
 * path such as "query" or "queries.q1") or their default path; their question_version is the template's.
 */
const GEO_IDS = new Set<string>(Object.values(GEO_QUESTION_IDS));

export const SEO_EVAL_QUESTION_IDS: readonly string[] = Object.keys(SEO_STATIC_QUESTIONS);

export function questionFor(row: LabelRow): DecisionQuestion | null {
  if (SEO_STATIC_QUESTIONS[row.question_id]) return seoQuestionFor(row.question_id, row.ref);
  if (GEO_IDS.has(row.question_id)) return geoQuestion(row.question_id as GeoQuestionId, row.ref ?? "subject", row.brand);
  return null;
}

/** Does the model answer agree with the human label? Noul: yes/no at 0.5; Score: nearest level. */
export function agrees(answer: DecisionAnswer, human: LabelRow["human_answer"]): boolean {
  if (answer.type === "choice") return answer.choice === String(human);
  if (answer.type === "noul") {
    const h = typeof human === "boolean" ? human : ["yes", "true", "1"].includes(String(human).toLowerCase());
    return answer.noul >= 0.5 === h;
  }
  return Math.round(answer.score) === Number(human);
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

export interface RowResult {
  id: string;
  questionId: string;
  questionVersion: string;
  labelVersionMatches: boolean | null;
  status: "ok" | "no_answer" | "error" | "unknown_question";
  agree: boolean | null;
  tier: "act" | "flag" | "drop" | null;
  latencyMs: number | null;
  error: string | null;
}

export interface EvalReport {
  generatedAt: string;
  provider: string;
  model: string | null;
  policyVersion: string;
  rows: number;
  perQuestion: Record<
    string,
    {
      n: number;
      answered: number;
      agreement: { numerator: number; denominator: number; value: number | null };
      byTier: Record<"act" | "flag" | "drop", { numerator: number; denominator: number; value: number | null }>;
      latencyMs: { p50: number | null; p95: number | null };
      versionMismatches: number;
    }
  >;
  cost: { calls: number; actualUsd: number; estimatedUsd: number; unknownCostCalls: number };
  notes: string[];
  results: RowResult[];
}

const ratio = (n: number, d: number) => ({ numerator: n, denominator: d, value: d === 0 ? null : n / d });

export async function runEval(
  rows: LabelRow[],
  provider: DecisionProvider,
  opts: { now?: () => Date; recordedCalls?: ProviderCallRecord[] } = {},
): Promise<EvalReport> {
  const now = opts.now ?? (() => new Date());
  const results: RowResult[] = [];
  let model: string | null = null;
  for (const row of rows) {
    const q = questionFor(row);
    if (!q) {
      results.push({ id: row.id, questionId: row.question_id, questionVersion: "", labelVersionMatches: null, status: "unknown_question", agree: null, tier: null, latencyMs: null, error: null });
      continue;
    }
    const version = row.question_id.startsWith("seo.") ? await versionFor(row.question_id, q) : await questionVersion(q);
    const started = Date.now();
    try {
      const res = await provider.decide({ purpose: "eval", state: row.state, questions: { [row.question_id]: q } });
      model = res.model ?? model;
      const answer = res.answers[row.question_id];
      const latencyMs = Date.now() - started;
      results.push({
        id: row.id,
        questionId: row.question_id,
        questionVersion: version,
        labelVersionMatches: row.question_version ? row.question_version === version : null,
        status: answer ? "ok" : "no_answer",
        agree: answer ? agrees(answer, row.human_answer) : null,
        tier: answer ? (tierFor(row.question_id, answer) as "act" | "flag" | "drop") : "drop",
        latencyMs,
        error: null,
      });
    } catch (e) {
      results.push({ id: row.id, questionId: row.question_id, questionVersion: version, labelVersionMatches: null, status: "error", agree: null, tier: null, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : "error" });
    }
  }

  const perQuestion: EvalReport["perQuestion"] = {};
  for (const qid of [...new Set(results.map((r) => r.questionId))]) {
    const rs = results.filter((r) => r.questionId === qid);
    const answered = rs.filter((r) => r.status === "ok");
    const tierRatio = (t: "act" | "flag" | "drop") => {
      const inTier = answered.filter((r) => r.tier === t);
      return ratio(inTier.filter((r) => r.agree).length, inTier.length);
    };
    perQuestion[qid] = {
      n: rs.length,
      answered: answered.length,
      agreement: ratio(answered.filter((r) => r.agree).length, answered.length),
      byTier: { act: tierRatio("act"), flag: tierRatio("flag"), drop: tierRatio("drop") },
      latencyMs: { p50: percentile(answered.map((r) => r.latencyMs ?? 0), 50), p95: percentile(answered.map((r) => r.latencyMs ?? 0), 95) },
      versionMismatches: rs.filter((r) => r.labelVersionMatches === false).length,
    };
  }

  const calls = opts.recordedCalls ?? [];
  const notes = [
    "Agreement is measured against hand labels; small samples (<30 rows per question) are not enough to fit thresholds.",
    "Rows whose question_version differs from the current question were labelled against older wording; relabel or treat as a new cohort.",
  ];
  if (calls.some((c) => c.costUsd === null)) notes.push("Some calls have unknown cost (no verified rate configured); they are counted, never shown as $0.");
  return {
    generatedAt: now().toISOString(),
    provider: provider.name,
    model,
    policyVersion: POLICY_VERSION,
    rows: rows.length,
    perQuestion,
    cost: {
      calls: calls.length,
      actualUsd: calls.filter((c) => c.costUsd !== null && !c.costIsEstimate).reduce((a, c) => a + (c.costUsd ?? 0), 0),
      estimatedUsd: calls.filter((c) => c.costUsd !== null && c.costIsEstimate).reduce((a, c) => a + (c.costUsd ?? 0), 0),
      unknownCostCalls: calls.filter((c) => c.costUsd === null).length,
    },
    notes,
    results,
  };
}

export function parseJsonl(text: string): LabelRow[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l, i) => {
      const row = JSON.parse(l) as LabelRow;
      if (!row.id || !row.question_id || row.human_answer === undefined) throw new Error(`Invalid label row ${i + 1}: needs id, question_id, human_answer`);
      return row;
    });
}
