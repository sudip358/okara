/**
 * Jev decisions for SEO candidates. Code builds compact state, asks only the relevant questions for
 * one candidate in ONE call ([A13] batching), tiers each answer with the versioned policy, and
 * decides in code which answers count. Duplicate pairs go up to 40 per call as pairwise Noul
 * questions ([A15]). Jev never does arithmetic; normalized values feed priority.ts.
 *
 * [A23] per-kind questions (asked in the same call as the candidate's other questions; Noul answers are
 * tiered by probability bands only):
 *   weak_ctr        seo.title_matches_query + seo.meta_matches_query (top GSC query in `top_query`): a
 *                   confident "no" (Act) makes the action rewrite_title_meta even if seo.action_choice
 *                   said otherwise or nothing; confident "yes" on both caps a title rewrite at Flag.
 *   coverage_gap    seo.covers_topic#t<n>, one per topic (GSC gap queries + engine queries), aggregated by
 *                   topicCoverage(): all confident yes = covered (rejected low_fit); all confident no =
 *                   missing; some confident no = partial; no confident no but some middle band = uncertain
 *                   (Flag). missing/partial can stand in for a missing action_choice (default action).
 *   declining       seo.page_action: keep (Act) rejects low_fit; merge (Act) -> consolidate_duplicate;
 *                   remove -> verified false, human-review wording, Flag at best.
 *   technical SEO-CONTENT-THIN  seo.thin_content#e<n> for up to 3 example pages (+ seo.page_action for a
 *                   single page): all answered pages confident "not thin" rejects low_fit; no confident
 *                   "thin" caps at Flag; no usable answer keeps the deterministic finding.
 *   freshness       seo.outdated_information only (today's date in state).
 *   schema_mismatch seo.schema_content_match only (confident "no" = mismatch confirmed).
 *   answer_clarity  seo.answer_is_direct only (confident "no" = the opening needs work).
 *   seo.query_intent `mixed` (not drop) caps the candidate at Flag (human review) and never gates fit.
 * Internal link suggestions reuse the suggester's own Jev tier (no re-ask): evaluateLinkSuggestion.
 */
import type { Tier } from "@shared/types";
import type { DecisionAnswer, DecisionQuestion, DecisionResult } from "../../providers/types";
import { hashJson } from "../../lib/hash";
import type { RunContext } from "../../runs/context";
import { DEFAULT_NOUL_BANDS, QUESTION_POLICY, runnerUp, tierFor } from "../../runs/policy";
import { safeMessage } from "../gsc/sync";
import {
  ACTION_CHOICE_OPTIONS,
  ANSWER_IS_DIRECT,
  baseQuestionId,
  coversTopicQuestion,
  ISSUE_SEVERITY_LEVELS,
  META_MATCHES_QUERY,
  OUTDATED_INFORMATION,
  PAGE_ACTION,
  QUESTION,
  pageOverlapQuestion,
  questionsForState,
  SCHEMA_CONTENT_MATCH,
  thinContentQuestion,
  TITLE_MATCHES_QUERY,
  versionFor,
  type ActionChoice,
  type PageAction,
} from "../questions";
import { normalizeUrl } from "./text";
import type { Candidate } from "./candidates";
import type { CandidateInputs, PageInfo } from "./inputs";
import { severityFromScore } from "./priority";

export const PAGE_EXCERPT_CHARS = 300;
export const MAX_PAIRS_PER_CALL = 40;
/** Page text sent for seo.covers_topic (authoring rule: cap excerpts, e.g. 6,000 characters). */
export const PAGE_TEXT_CHARS = 6000;
export const OPENING_CHARS = 1000;
export const MAX_TOPICS = 8;
export const MAX_THIN_EXAMPLES = 3;
export const TOPIC_COVERAGE_VERSION = "topic-coverage-2026-09-30.1";
/** Kinds judged only by their own gate question (no seo.action_choice). */
export const GATE_KINDS: ReadonlySet<Candidate["kind"]> = new Set(["freshness", "schema_mismatch", "answer_clarity"]);
export const THIN_RULE_ID = "SEO-CONTENT-THIN";
export const isThinCandidate = (c: Pick<Candidate, "kind" | "issueType">) => c.kind === "technical" && c.issueType === `technical:${THIN_RULE_ID}`;

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
  const questions: Record<string, DecisionQuestion> = GATE_KINDS.has(c.kind)
    ? {}
    : questionsForState({
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
  if (questions[QUESTION.queryIntent]) {
    // [A23] Intent state: brand terms (self + competitors), country, language.
    state.country = inputs.project.country ?? null;
    state.language = inputs.project.language;
    state.brand_terms = { self: inputs.project.brandTerms?.self ?? [], competitors: inputs.project.brandTerms?.competitors ?? [] };
  }
  addKindQuestions(c, inputs, state, questions);
  return { state, questions };
}

/** [A23] Kind-specific questions (see the file header). Mutates state/questions. */
function addKindQuestions(c: Candidate, inputs: CandidateInputs, state: Record<string, unknown>, questions: Record<string, DecisionQuestion>): void {
  const page = state.page as Record<string, unknown> | undefined;
  if (c.kind === "weak_ctr" && page && c.query) {
    state.top_query = c.query;
    if (c.page?.title) questions[QUESTION.titleMatchesQuery] = TITLE_MATCHES_QUERY;
    if (c.page?.metaDescription) {
      page.meta_description = c.page.metaDescription;
      questions[QUESTION.metaMatchesQuery] = META_MATCHES_QUERY;
    }
  }
  if (c.kind === "coverage_gap" && page && c.page) {
    const topics = (c.coverageQueries ?? (c.query ? [c.query] : [])).slice(0, MAX_TOPICS);
    if (topics.length) {
      page.headings = c.page.headings.slice(0, 40);
      page.text = (c.page.excerpt ?? "").slice(0, PAGE_TEXT_CHARS);
      const t: Record<string, string> = {};
      topics.forEach((topic, i) => {
        t[`t${i + 1}`] = topic;
        questions[`${QUESTION.coversTopic}#t${i + 1}`] = coversTopicQuestion(`topics.t${i + 1}`);
      });
      state.topics = t;
    }
  }
  if (c.kind === "declining" && page) questions[QUESTION.pageAction] = PAGE_ACTION;
  if (isThinCandidate(c)) {
    const examples: PageInfo[] = [];
    if (c.page) examples.push(c.page);
    for (const u of c.target.exampleUrls ?? []) {
      const p = inputs.pages.find((x) => x.norm === normalizeUrl(u));
      if (p && !examples.includes(p)) examples.push(p);
    }
    const thin: Record<string, unknown> = {};
    examples.slice(0, MAX_THIN_EXAMPLES).forEach((p, i) => {
      const ps = pageState(p);
      if (!ps) return;
      const key = `e${i + 1}`;
      thin[key] = { ...ps, word_count: p.wordCount ?? null };
      questions[`${QUESTION.thinContent}#${key}`] = thinContentQuestion(`thin_pages.${key}`);
    });
    if (Object.keys(thin).length) state.thin_pages = thin;
    if (c.scope === "page" && page) questions[QUESTION.pageAction] = PAGE_ACTION;
  }
  if (c.kind === "freshness" && page) {
    state.today = inputs.today ?? null;
    page.dated_references = (c.datedReferences ?? []).slice(0, 10);
    questions[QUESTION.outdatedInformation] = OUTDATED_INFORMATION;
  }
  if (c.kind === "schema_mismatch" && page && c.page) {
    page.structured_data_types = (c.page.jsonLdTypes ?? []).slice(0, 30);
    page.headings = c.page.headings.slice(0, 40);
    questions[QUESTION.schemaContentMatch] = SCHEMA_CONTENT_MATCH;
  }
  if (c.kind === "answer_clarity" && page && c.page && c.query) {
    state.top_query = c.query;
    page.opening = (c.page.firstParagraph ?? c.page.excerpt ?? "").slice(0, OPENING_CHARS);
    questions[QUESTION.answerIsDirect] = ANSWER_IS_DIRECT;
  }
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
  ctx: Pick<RunContext, "decisions" | "budget" | "calls">,
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
  // Nothing to ask (e.g. a gate question whose page state is absent): no call; evaluation rejects.
  if (Object.keys(questions).length === 0) return { provider: "none", model: "", stateHash: await hashJson(state), questions: [] };
  const res = await callDecisions(ctx, `seo_decision:${c.kind}`, state, questions);
  const stateHash = await hashJson(state);
  const judged: JudgedQuestion[] = [];
  for (const [id, q] of Object.entries(questions)) {
    const answer = validAnswer(q, res.answers[id]);
    judged.push({ questionId: id, questionVersion: await versionFor(id, q), answer, tier: tierFor(baseQuestionId(id), answer) });
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
  /** [A23] seo.page_action when it counted (remove -> verified false + human review wording). */
  pageAction?: PageAction | null;
  severityScore: number | null;
  /** Every counted answer, namespaced by question id (internal: logs, pillar gate). */
  fields: Record<string, number | string>;
  /**
   * The headline question's answer for the recommendation card, using the provider's real field names
   * only (choice/confidence for Choice, score/confidence for Score, noul for Noul) plus `question`.
   * null when no Jev value is shown (drop tier or no question asked).
   */
  decisionFields: Record<string, number | string> | null;
  warnings: string[];
}

/** Card fields for one judged question; never invents a confidence (Noul has none). */
export function headlineFields(q: JudgedQuestion | undefined): Record<string, number | string> | null {
  const a = q?.answer;
  if (!q || !a || q.tier === "drop") return null;
  const question = baseQuestionId(q.questionId);
  if (a.type === "noul") return { question, noul: round(a.noul) };
  if (a.type === "choice") return { question, choice: a.choice, confidence: round(a.confidence) };
  return { question, score: a.score, confidence: round(a.confidence) };
}

/** Noul band of an answered question under the policy (null when dropped or not a Noul). */
export function noulBand(q: JudgedQuestion | undefined): "yes" | "no" | "middle" | null {
  if (!q || q.tier === "drop" || q.answer?.type !== "noul") return null;
  const b = { ...DEFAULT_NOUL_BANDS, ...(QUESTION_POLICY[baseQuestionId(q.questionId)]?.noul ?? {}) };
  return q.answer.noul >= b.yes ? "yes" : q.answer.noul <= b.no ? "no" : "middle";
}

/** [A23] Snippet vs top query from seo.title_matches_query / seo.meta_matches_query. */
export function snippetAlignment(questions: JudgedQuestion[]): { verdict: "misaligned" | "aligned" | "uncertain" | null; driver: JudgedQuestion | null } {
  const qs = questions.filter((q) => q.questionId === QUESTION.titleMatchesQuery || q.questionId === QUESTION.metaMatchesQuery);
  const bands = qs.map((q) => [q, noulBand(q)] as const).filter(([, b]) => b !== null);
  if (bands.length === 0) return { verdict: null, driver: null };
  const no = bands.find(([, b]) => b === "no");
  if (no) return { verdict: "misaligned", driver: no[0] };
  if (bands.length === qs.length && bands.every(([, b]) => b === "yes")) return { verdict: "aligned", driver: bands[0]![0] };
  return { verdict: "uncertain", driver: null };
}

/** [A23] Aggregate seo.covers_topic#t<n> answers (TOPIC_COVERAGE_VERSION; see the file header). */
export function topicCoverage(questions: JudgedQuestion[]): { result: "covered" | "partial" | "missing" | "uncertain" | null; covered: number; missing: number; middle: number; driver: JudgedQuestion | null } {
  const qs = questions.filter((q) => baseQuestionId(q.questionId) === QUESTION.coversTopic);
  let covered = 0;
  let missing = 0;
  let middle = 0;
  let driver: JudgedQuestion | null = null;
  for (const q of qs) {
    const b = noulBand(q);
    if (b === "yes") covered++;
    else if (b === "no") {
      missing++;
      driver ??= q;
    } else if (b === "middle") middle++;
  }
  const answered = covered + missing + middle;
  if (answered === 0) return { result: null, covered, missing, middle, driver: null };
  const result = covered === answered ? "covered" : missing === answered ? "missing" : missing > 0 ? "partial" : "uncertain";
  return { result, covered, missing, middle, driver: driver ?? qs.find((q) => noulBand(q) !== null) ?? null };
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
  const reject = (reasonCode: string, t: Tier = tier): Evaluation => ({
    outcome: "rejected",
    reasonCode,
    tier: t,
    action: null,
    intent: null,
    severity: null,
    severityScore: null,
    fields,
    decisionFields: null,
    warnings,
  });

  const rel = by.get(QUESTION.queryPageRelevance);
  if (rel) {
    if (rel.tier === "drop" || rel.answer?.type !== "noul") return reject("insufficient_evidence", "drop");
    const bands = { ...DEFAULT_NOUL_BANDS, ...(QUESTION_POLICY[QUESTION.queryPageRelevance]?.noul ?? {}) };
    if (rel.answer.noul <= bands.no) return reject("low_fit", rel.tier);
    tier = worse(tier, rel.answer.noul >= bands.yes ? "act" : rel.tier);
  }
  // [A23] Page action (declining / thin pages): keep = leave as is; merge/remove shape the action.
  let pageAction: PageAction | null = null;
  const pa = by.get(QUESTION.pageAction);
  if (pa?.answer?.type === "choice" && pa.tier !== "drop" && pa.answer.choice !== "insufficient_context") {
    pageAction = pa.answer.choice as PageAction;
    if (pageAction === "keep" && pa.tier === "act") return reject("low_fit", pa.tier);
  }
  // [A23] Topic coverage (coverage_gap): a page that already covers every topic is not a gap.
  const cov = topicCoverage(j.questions);
  if (cov.result === "covered") return reject("low_fit", cov.driver?.tier ?? tier);
  // [A23] Snippet vs top query (weak_ctr).
  const snippet = snippetAlignment(j.questions);

  const act = by.get(QUESTION.actionChoice);
  let action: ActionChoice | null = act && act.tier !== "drop" && act.answer?.type === "choice" && ACTION_CHOICE_OPTIONS.includes(act.answer.choice as ActionChoice) ? (act.answer.choice as ActionChoice) : null;
  let headline: JudgedQuestion | undefined = action ? act : undefined;
  if (action) tier = worse(tier, act!.tier);
  const noAction = action === "no_action";
  if (!action || noAction) {
    // A confident narrow answer can stand in for a missing or "no action" action choice.
    if (snippet.verdict === "misaligned" && snippet.driver?.tier === "act") {
      action = "rewrite_title_meta";
      headline = snippet.driver;
      warnings.push("The title or meta description does not match the page's top query (Act); the action is rewrite_title_meta.");
    } else if ((cov.result === "missing" || cov.result === "partial") && cov.driver?.tier === "act" && c.defaultAction) {
      action = c.defaultAction;
      headline = cov.driver;
    } else if ((pageAction === "update" || pageAction === "merge") && pa!.tier === "act") {
      action = pageAction === "merge" ? "consolidate_duplicate" : (c.defaultAction ?? "improve_intro_answer");
      headline = pa;
    } else if (noAction) return reject("low_fit", act!.tier);
    else return reject("insufficient_evidence", "drop");
    if (headline) tier = worse(tier, headline.tier);
  } else {
    if (snippet.verdict === "misaligned" && snippet.driver?.tier === "act" && action !== "rewrite_title_meta" && c.kind === "weak_ctr") {
      warnings.push(`The title or meta description does not match the page's top query (Act); action changed from ${action} to rewrite_title_meta.`);
      action = "rewrite_title_meta";
    } else if (snippet.verdict === "aligned" && action === "rewrite_title_meta") {
      tier = worse(tier, "flag");
      warnings.push("Jev judged the title and description already match the top query; a rewrite is shown as Check this yourself.");
    }
  }
  if (pageAction === "merge" && pa!.tier === "act" && action !== "consolidate_duplicate") {
    warnings.push(`seo.page_action chose merge (Act); action changed from ${action} to consolidate_duplicate.`);
    action = "consolidate_duplicate";
  }
  if (pageAction === "remove") {
    tier = worse(tier, "flag");
    warnings.push("seo.page_action chose remove: shown as unverified and routed to human review.");
  }
  if (cov.result === "uncertain") tier = worse(tier, "flag");

  // Gate: the intent answer counts only when decisive; intent_page_fit only when the intent does.
  let intent: string | null = null;
  const qi = by.get(QUESTION.queryIntent);
  if (qi?.answer?.type === "choice" && qi.tier !== "drop" && qi.answer.choice !== "insufficient_context") intent = qi.answer.choice;
  if (intent === "mixed") {
    // [A23] Mixed intent: routed to human review, never used to gate intent/page fit.
    tier = worse(tier, "flag");
    warnings.push("Query intent is mixed; routed to human review (Check this yourself).");
  }
  if (!intent || intent === "mixed") {
    delete fields[`${QUESTION.intentPageFit}.choice`];
    delete fields[`${QUESTION.intentPageFit}.confidence`];
    delete fields[`${QUESTION.intentPageFit}.runner_up`];
  }
  // A confident mismatch between the query's intent and this page type means improving this page is
  // the wrong move, unless the action itself routes elsewhere (new page, consolidation, linking) or
  // the candidate is already about the query landing on the wrong page.
  const fit = by.get(QUESTION.intentPageFit);
  if (
    intent &&
    intent !== "mixed" &&
    fit?.tier === "act" &&
    fit.answer?.type === "choice" &&
    fit.answer.choice === "mismatch" &&
    c.kind !== "query_page_mismatch" &&
    !MISMATCH_SAFE_ACTIONS.has(action)
  ) {
    return reject("low_fit", fit.tier);
  }

  if (c.reviewRequired || c.tierCap === "flag") tier = worse(tier, "flag");
  return { outcome: "selected", reasonCode: null, tier, action, intent, severity: null, severityScore: null, fields, decisionFields: headlineFields(headline), warnings, pageAction };
}

/**
 * [A23] Kinds judged by one gate question (freshness, schema_mismatch, answer_clarity). The polarity of
 * each Noul is fixed in code: which answer confirms the problem.
 */
const GATE: Record<string, { question: string; confirms: "yes" | "no"; action: (c: Candidate) => ActionChoice | null }> = {
  freshness: { question: QUESTION.outdatedInformation, confirms: "yes", action: () => null },
  schema_mismatch: { question: QUESTION.schemaContentMatch, confirms: "no", action: () => "fix_structured_data" },
  answer_clarity: { question: QUESTION.answerIsDirect, confirms: "no", action: () => "improve_intro_answer" },
};

export function evaluateGate(c: Candidate, j: Judgment): Evaluation {
  const g = GATE[c.kind];
  const fields: Record<string, number | string> = {};
  const warnings: string[] = [];
  for (const q of j.questions) fieldsOf(q, fields);
  const base = { action: null, intent: null, severity: null, severityScore: null, fields, decisionFields: null, warnings };
  const q = g ? j.questions.find((x) => x.questionId === g.question) : undefined;
  const band = noulBand(q);
  if (!g || !q || band === null) {
    if (q && !q.answer) warnings.push(`Answer missing for ${q.questionId}; dropped.`);
    return { ...base, outcome: "rejected", reasonCode: "insufficient_evidence", tier: "drop" };
  }
  if (band !== "middle" && band !== g.confirms) return { ...base, outcome: "rejected", reasonCode: "low_fit", tier: q.tier };
  let tier: Tier = band === "middle" ? "flag" : q.tier;
  if (c.reviewRequired || c.tierCap === "flag") tier = worse(tier, "flag");
  return { ...base, outcome: "selected", reasonCode: null, tier, action: g.action(c), decisionFields: headlineFields(q) };
}

/** [A25] Internal link suggestion: the suggester already asked Jev (act tier only reaches here). */
export function evaluateLinkSuggestion(c: Candidate): Evaluation {
  const s = c.linkSuggestion!;
  const decisionFields = s.shouldExist !== null ? { question: "links.should_exist", noul: round(s.shouldExist) } : null;
  return { outcome: "selected", reasonCode: null, tier: s.tier, action: "add_internal_links", intent: null, severity: null, severityScore: null, fields: {}, decisionFields, warnings: [] };
}

const MISMATCH_SAFE_ACTIONS: ReadonlySet<ActionChoice> = new Set(["new_page_candidate", "consolidate_duplicate", "add_internal_links"]);

/**
 * Technical candidate: Jev severity counts when not dropped; otherwise deterministic severity.
 * [A23] Thin content (SEO-CONTENT-THIN) also needs seo.thin_content confirmation when it was asked.
 */
export function evaluateTechnical(c: Candidate, j: Judgment | null): Evaluation {
  const fields: Record<string, number | string> = {};
  const warnings: string[] = [];
  for (const x of j?.questions ?? []) fieldsOf(x, fields);
  const q = j?.questions.find((x) => x.questionId === QUESTION.issueSeverity);
  let ev: Evaluation;
  if (q && q.tier !== "drop" && q.answer?.type === "score") {
    ev = {
      outcome: "selected",
      reasonCode: null,
      tier: q.tier,
      action: c.defaultAction,
      intent: null,
      severity: severityFromScore(q.answer.score, ISSUE_SEVERITY_LEVELS),
      severityScore: q.answer.score,
      fields,
      decisionFields: headlineFields(q),
      warnings,
    };
  } else {
    if (q) warnings.push("Jev severity withheld (drop tier or missing); using the rule's deterministic severity.");
    ev = { outcome: "selected", reasonCode: null, tier: "n/a", action: c.defaultAction, intent: null, severity: null, severityScore: null, fields, decisionFields: null, warnings };
  }
  const thin = (j?.questions ?? []).filter((x) => baseQuestionId(x.questionId) === QUESTION.thinContent);
  if (thin.length === 0) return ev;
  const bands = thin.map((x) => [x, noulBand(x)] as const).filter(([, b]) => b !== null);
  if (bands.length === 0) {
    warnings.push("Thin-content confirmation unavailable (drop tier or missing); the deterministic rule finding is kept.");
    return ev;
  }
  const yes = bands.filter(([, b]) => b === "yes").map(([x]) => x);
  if (yes.length === 0 && bands.every(([, b]) => b === "no")) {
    return { ...ev, outcome: "rejected", reasonCode: "low_fit", tier: bands[0]![0].tier, action: null, decisionFields: null };
  }
  let tier: Tier = ev.tier === "n/a" ? (yes[0]?.tier ?? "flag") : ev.tier;
  if (yes.length === 0) {
    tier = worse(tier === "n/a" ? "act" : tier, "flag");
    warnings.push("Jev could not confirm the page is thin (middle band); shown as Check this yourself.");
  }
  let action = ev.action;
  let pageAction: PageAction | null = null;
  const pa = j?.questions.find((x) => x.questionId === QUESTION.pageAction);
  if (pa?.answer?.type === "choice" && pa.tier !== "drop" && pa.answer.choice !== "insufficient_context") {
    pageAction = pa.answer.choice as PageAction;
    if (pageAction === "keep" && pa.tier === "act") return { ...ev, outcome: "rejected", reasonCode: "low_fit", tier: pa.tier, action: null, decisionFields: null };
    if (pageAction === "merge" && pa.tier === "act") action = "consolidate_duplicate";
    if (pageAction === "remove") tier = worse(tier === "n/a" ? "act" : tier, "flag");
  }
  return { ...ev, tier, action, decisionFields: ev.decisionFields ?? headlineFields(yes[0] ?? bands[0]![0]), pageAction };
}

/** Duplicate pair: only confident merge-side answers select; middle band and keep-side reject. */
export function evaluatePair(p: PairJudgment): Evaluation {
  const fields: Record<string, number | string> = {};
  fieldsOf(p.question, fields);
  const base = { action: null, intent: null, severity: null, severityScore: null, fields, decisionFields: null, warnings: [] as string[] };
  const a = p.question.answer;
  // seo.page_overlap policy: middle band is 'drop' (dead band), so only confident answers reach here.
  if (!a || a.type !== "noul" || p.question.tier === "drop") return { ...base, outcome: "rejected", reasonCode: "insufficient_evidence", tier: "drop" };
  if (a.noul < 0.5) return { ...base, outcome: "rejected", reasonCode: "low_fit", tier: p.question.tier };
  return { ...base, outcome: "selected", reasonCode: null, tier: p.question.tier, action: "consolidate_duplicate", decisionFields: headlineFields(p.question) };
}
