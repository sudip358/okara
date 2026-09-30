/**
 * Jev decisions for SEO candidates. Code builds compact state, asks only the relevant questions for
 * one candidate in ONE call ([A13] batching), tiers each answer with the versioned policy, and
 * decides in code which answers count. Duplicate pairs go up to 40 per call as pairwise Noul
 * questions ([A15]). Jev never does arithmetic; normalized values feed priority.ts.
 */
import type { Tier } from "@shared/types";
import type { DecisionAnswer, DecisionQuestion, DecisionResult } from "../../providers/types";
import { hashJson } from "../../lib/hash";
import type { RunContext } from "../../runs/context";
import { DEFAULT_NOUL_BANDS, QUESTION_POLICY, runnerUp, tierFor } from "../../runs/policy";
import { safeMessage } from "../gsc/sync";
import {
  ACTION_CHOICE_OPTIONS,
  ISSUE_SEVERITY_LEVELS,
  QUESTION,
  pageOverlapQuestion,
  questionsForState,
  versionFor,
  type ActionChoice,
} from "../questions";
import type { Candidate } from "./candidates";
import type { CandidateInputs, PageInfo } from "./inputs";
import { severityFromScore } from "./priority";

export const PAGE_EXCERPT_CHARS = 300;
export const MAX_PAIRS_PER_CALL = 40;

export interface JudgedQuestion {
  questionId: string;
  questionVersion: string;
  answer: DecisionAnswer | undefined;
  tier: Tier;
}

export interface Judgment {
  provider: string;
  model: string;
  stateHash: string;
  questions: JudgedQuestion[];
}

export class DecisionCallError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}

const LEGAL_PATH = /\/(privacy|terms|legal|policy|policies|cookie|cookies|imprint|gdpr|accessibility)(\/|$|[-_.])/i;

function pageState(p: PageInfo | null): Record<string, unknown> | undefined {
  if (!p || p.tainted) return undefined;
  if (!p.title && !p.h1) return undefined;
  try {
    if (LEGAL_PATH.test(new URL(p.url).pathname)) return undefined;
  } catch {
    /* keep */
  }
  return {
    url: p.url,
    page_type: p.pageType,
    title: p.title ?? "",
    h1: p.h1 ?? "",
    excerpt: (p.excerpt ?? "").slice(0, PAGE_EXCERPT_CHARS),
  };
}

/** State + questions for one candidate; questions whose inputs are absent are omitted. */
export function candidateDecisionRequest(
  c: Candidate,
  inputs: CandidateInputs,
  evidenceIds: string[],
): { state: Record<string, unknown>; questions: Record<string, DecisionQuestion> } {
  const page = pageState(c.page);
  const pillars = inputs.pillars?.names ?? [];
  const questions = questionsForState({
    hasQuery: !!c.query,
    hasPage: !!page,
    hasPageType: !!page?.page_type,
    isTechnical: c.kind === "technical",
    wantsIntent: c.wantsIntent,
    pillars,
    wantsPillar: c.wantsPillar,
  });
  const issue: Record<string, unknown> = {
    type: c.issueType,
    description: c.issue,
    metrics: c.metrics,
    evidence_ids: evidenceIds,
  };
  if (c.kind === "technical") {
    issue.page_type = c.pageType ?? "site";
    issue.affected_url_count = Number(c.metrics.affected ?? 1);
    if (typeof c.metrics.impressions === "number") issue.gsc_impressions = c.metrics.impressions;
    if (c.severity) issue.rule_severity = c.severity;
  }
  const state: Record<string, unknown> = {
    locale: inputs.project.locale,
    site_type: inputs.project.siteType,
    issue,
  };
  if (c.query) state.query = c.query;
  if (page) state.page = page;
  if (questions[QUESTION.pillarFit]) state.pillars = pillars;
  return { state, questions };
}

/**
 * Runtime adapters (typesafe, anthropic, openai_compatible) reserve jev_calls/provider_calls/writer
 * budgets per attempt and write provider_calls themselves; for any other implementation (or one
 * that sets `recordsCalls: false`) this module reserves and records around the call instead, so
 * nothing is double counted and nothing goes unaccounted.
 */
export const SELF_ACCOUNTING_PROVIDERS = new Set(["typesafe", "anthropic", "openai_compatible"]);
export function isSelfAccounting(p: { name: string; recordsCalls?: boolean }): boolean {
  if (typeof p.recordsCalls === "boolean") return p.recordsCalls;
  return SELF_ACCOUNTING_PROVIDERS.has(p.name);
}

/** One call to the decision provider with budget reservation and call accounting. */
export async function callDecisions(
  ctx: RunContext,
  purpose: string,
  state: unknown,
  questions: Record<string, DecisionQuestion>,
): Promise<DecisionResult> {
  const provider = ctx.decisions;
  if (!provider) throw new DecisionCallError("decision provider not configured");
  const selfAccounting = isSelfAccounting(provider);
  // Reservation errors (BudgetExceededError) propagate before any call is made.
  const reservation = selfAccounting ? null : await ctx.budget.reserve("jev_calls", 1);
  const started = Date.now();
  const selfRecording = selfAccounting;
  try {
    const res = await provider.decide({ purpose, state, questions });
    if (reservation !== null) await ctx.budget.settle(reservation, 1);
    if (!selfRecording) {
      await ctx.calls.record({
        provider: res.provider,
        model: res.model,
        purpose,
        status: "ok",
        inputTokens: res.usage?.inputTokens ?? null,
        outputTokens: res.usage?.outputTokens ?? null,
        costUsd: null, // not returned by the provider; unknown, never $0
        costIsEstimate: false,
        latencyMs: Date.now() - started,
      });
    }
    return res;
  } catch (e) {
    // The call may have reached the provider: keep it conservatively counted.
    if (reservation !== null) await ctx.budget.markUnknown(reservation);
    if (!selfRecording) {
      const timeout = e instanceof Error && /timeout|abort/i.test(`${e.name} ${e.message}`);
      await ctx.calls.record({
        provider: provider.name,
        model: null,
        purpose,
        status: timeout ? "timeout" : "error",
        costUsd: null,
        costIsEstimate: false,
        latencyMs: Date.now() - started,
        error: safeMessage(e),
      });
    }
    throw new DecisionCallError(safeMessage(e), e);
  }
}

/** Keep only answers whose primitive matches the question; others count as missing (drop). */
function validAnswer(q: DecisionQuestion, a: DecisionAnswer | undefined): DecisionAnswer | undefined {
  if (!a || a.type !== q.type) return undefined;
  if (a.type === "choice" && q.type === "choice" && !(a.choice in q.criteria)) return undefined;
  if (a.type === "score" && q.type === "score" && !(a.score >= 0 && a.score < q.criteria.length)) return undefined;
  return a;
}

export async function judgeCandidate(ctx: RunContext, c: Candidate, inputs: CandidateInputs, evidenceIds: string[]): Promise<Judgment> {
  const { state, questions } = candidateDecisionRequest(c, inputs, evidenceIds);
  const res = await callDecisions(ctx, `seo_decision:${c.kind}`, state, questions);
  const stateHash = await hashJson(state);
  const judged: JudgedQuestion[] = [];
  for (const [id, q] of Object.entries(questions)) {
    const answer = validAnswer(q, res.answers[id]);
    judged.push({ questionId: id, questionVersion: await versionFor(id, q), answer, tier: tierFor(id, answer) });
  }
  return { provider: res.provider, model: res.model, stateHash, questions: judged };
}

export interface PairJudgment {
  candidateKey: string;
  provider: string;
  model: string;
  stateHash: string;
  question: JudgedQuestion;
}

/** Pairwise overlap questions, up to MAX_PAIRS_PER_CALL per call. */
export async function judgePairs(ctx: RunContext, pairs: Candidate[]): Promise<PairJudgment[]> {
  const out: PairJudgment[] = [];
  for (let i = 0; i < pairs.length; i += MAX_PAIRS_PER_CALL) {
    const batch = pairs.slice(i, i + MAX_PAIRS_PER_CALL);
    const statePairs: Record<string, unknown> = {};
    const questions: Record<string, DecisionQuestion> = {};
    const keys: string[] = [];
    batch.forEach((c, j) => {
      const k = `p${j + 1}`;
      keys.push(k);
      statePairs[k] = {
        page_a: pageState(c.page) ?? { url: c.page?.url ?? "" },
        page_b: pageState(c.pageB) ?? { url: c.pageB?.url ?? "" },
        shared_queries: c.sharedQueries.slice(0, 10),
      };
      questions[`${QUESTION.pageOverlap}#${k}`] = pageOverlapQuestion(k);
    });
    const state = { pairs: statePairs };
    const res = await callDecisions(ctx, "seo_decision:page_overlap", state, questions);
    const stateHash = await hashJson(state);
    for (let j = 0; j < batch.length; j++) {
      const qid = `${QUESTION.pageOverlap}#${keys[j]}`;
      const answer = validAnswer(questions[qid]!, res.answers[qid]);
      out.push({
        candidateKey: batch[j]!.key,
        provider: res.provider,
        model: res.model,
        stateHash,
        question: { questionId: QUESTION.pageOverlap, questionVersion: await versionFor(QUESTION.pageOverlap, questions[qid]!), answer, tier: tierFor(QUESTION.pageOverlap, answer) },
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ evaluation (code decides)
export interface Evaluation {
  outcome: "selected" | "rejected";
  reasonCode: string | null;
  tier: Tier;
  action: ActionChoice | null;
  intent: string | null;
  /** Normalized severity from seo.issue_severity when counted (technical only). */
  severity: number | null;
  severityScore: number | null;
  fields: Record<string, number | string>;
  warnings: string[];
}

const TIER_ORDER: Record<Tier, number> = { act: 0, "n/a": 0, flag: 1, drop: 2 };
const worse = (a: Tier, b: Tier): Tier => (TIER_ORDER[b] > TIER_ORDER[a] ? b : a);

function fieldsOf(q: JudgedQuestion, out: Record<string, number | string>) {
  const a = q.answer;
  if (!a || q.tier === "drop") return; // Drop: the Jev value is withheld
  if (a.type === "noul") out[`${q.questionId}.noul`] = round(a.noul);
  else if (a.type === "choice") {
    out[`${q.questionId}.choice`] = a.choice;
    out[`${q.questionId}.confidence`] = round(a.confidence);
  } else {
    out[`${q.questionId}.score`] = a.score;
    out[`${q.questionId}.confidence`] = round(a.confidence);
  }
  if (q.tier === "flag") {
    const ru = runnerUp(a);
    if (ru) out[`${q.questionId}.runner_up`] = ru.label;
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Content (Jev-dependent, non-pair) candidate. */
export function evaluateContent(c: Candidate, j: Judgment): Evaluation {
  const by = new Map(j.questions.map((q) => [q.questionId, q]));
  const fields: Record<string, number | string> = {};
  const warnings: string[] = [];
  for (const q of j.questions) {
    fieldsOf(q, fields);
    if (!q.answer) warnings.push(`Answer missing for ${q.questionId}; dropped.`);
  }
  let tier: Tier = "act";
  const reject = (reasonCode: string, t: Tier = tier): Evaluation => ({ outcome: "rejected", reasonCode, tier: t, action: null, intent: null, severity: null, severityScore: null, fields, warnings });

  const rel = by.get(QUESTION.queryPageRelevance);
  if (rel) {
    if (rel.tier === "drop" || rel.answer?.type !== "noul") return reject("insufficient_evidence", "drop");
    const bands = { ...DEFAULT_NOUL_BANDS, ...(QUESTION_POLICY[QUESTION.queryPageRelevance]?.noul ?? {}) };
    if (rel.answer.noul <= bands.no) return reject("low_fit", rel.tier);
    tier = worse(tier, rel.answer.noul >= bands.yes ? "act" : rel.tier);
  }
  const act = by.get(QUESTION.actionChoice);
  if (!act || act.tier === "drop" || act.answer?.type !== "choice") return reject("insufficient_evidence", "drop");
  const action = act.answer.choice as ActionChoice;
  if (!ACTION_CHOICE_OPTIONS.includes(action)) return reject("insufficient_evidence", "drop");
  if (action === "no_action") return reject("low_fit", act.tier);
  tier = worse(tier, act.tier);

  // Gate: the intent answer counts only when decisive; intent_page_fit only when the intent does.
  let intent: string | null = null;
  const qi = by.get(QUESTION.queryIntent);
  if (qi?.answer?.type === "choice" && qi.tier !== "drop" && qi.answer.choice !== "insufficient_context") intent = qi.answer.choice;
  if (!intent) {
    delete fields[`${QUESTION.intentPageFit}.choice`];
    delete fields[`${QUESTION.intentPageFit}.confidence`];
    delete fields[`${QUESTION.intentPageFit}.runner_up`];
  }

  if (c.reviewRequired) tier = worse(tier, "flag");
  return { outcome: "selected", reasonCode: null, tier, action, intent, severity: null, severityScore: null, fields, warnings };
}

/** Technical candidate: Jev severity counts when not dropped; otherwise deterministic severity. */
export function evaluateTechnical(c: Candidate, j: Judgment | null): Evaluation {
  const fields: Record<string, number | string> = {};
  const warnings: string[] = [];
  const q = j?.questions.find((x) => x.questionId === QUESTION.issueSeverity);
  if (q) fieldsOf(q, fields);
  if (q && q.tier !== "drop" && q.answer?.type === "score") {
    return {
      outcome: "selected",
      reasonCode: null,
      tier: q.tier,
      action: c.defaultAction,
      intent: null,
      severity: severityFromScore(q.answer.score, ISSUE_SEVERITY_LEVELS),
      severityScore: q.answer.score,
      fields,
      warnings,
    };
  }
  if (q) warnings.push("Jev severity withheld (drop tier or missing); using the rule's deterministic severity.");
  return { outcome: "selected", reasonCode: null, tier: "n/a", action: c.defaultAction, intent: null, severity: null, severityScore: null, fields, warnings };
}

/** Duplicate pair: only confident merge-side answers select; middle band and keep-side reject. */
export function evaluatePair(p: PairJudgment): Evaluation {
  const fields: Record<string, number | string> = {};
  fieldsOf(p.question, fields);
  const base = { action: null, intent: null, severity: null, severityScore: null, fields, warnings: [] as string[] };
  const a = p.question.answer;
  if (!a || a.type !== "noul" || p.question.tier === "drop") return { ...base, outcome: "rejected", reasonCode: "insufficient_evidence", tier: "drop" };
  if (a.noul < 0.5) return { ...base, outcome: "rejected", reasonCode: "low_fit", tier: p.question.tier };
  return { ...base, outcome: "selected", reasonCode: null, tier: p.question.tier, action: "consolidate_duplicate" };
}
