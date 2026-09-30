/**
 * SEO recommendation step: shortlist -> dedup -> Jev -> priority -> writer -> validate -> save.
 * Emits 0-2 new recommendations per day (DAILY_CAP), never necessarily two. Every candidate
 * considered gets decision_records rows (selected or rejected with a reason code), keyed by the
 * recommendation dedup key so the detail view can join them.
 *
 * Without Jev (ctx.decisions null): technical candidates are ranked deterministically; content
 * opportunities are rejected with reason 'decision_unavailable' — rankings are never faked.
 *
 * Dedup key = hash(project, url | template | site, issue type, evidence identity). The evidence
 * identity is the stable part of the evidence (rule + group, or query + page), not its metric
 * values, so a rerun with fresh numbers still matches an open/dismissed/implemented recommendation.
 *
 * Drafting: the writer (SEO_WRITER_SYSTEM + recommendation.v1 schema) output is zod-parsed and run
 * through validateDraft; a failing draft is rejected 'validation_failed' and never saved. If the
 * writer is not configured or cannot be reached, a deterministic template drafts from evidence
 * (writer provider null). Draft attempts per run are capped (paid calls).
 *
 * The card's decision fields are the headline question's answer under the provider's real field
 * names (choice/confidence, score/confidence, noul); every raw answer is on decision_records.
 *
 * [A21] Readiness-checklist gaps join the shortlist as kind 'checklist' (checklist-candidates.ts): the
 * deterministic ones skip Jev like technical findings, heuristic content ones need seo.action_choice,
 * and a blocked search-engine crawler adds a critical robots.txt candidate whose snippet is the
 * advisor's suggestion (drafted by the deterministic template only; the snippet is code-owned).
 * Checklist dedup key = hash(project, 'checklist', item id, target). The daily cap is unchanged.
 *
 * [A23] Before candidates: the query relevance pre-filter (relevance.ts; Jev only, cached 7 days) drops
 * lookalike queries and flags uncertain ones. New kinds (freshness, schema_mismatch, answer_clarity) are
 * judged by their gate question only (decide.evaluateGate); thin-content findings are always sent for
 * seo.thin_content confirmation when Jev is configured (not limited by maxTechnicalJudged).
 * [A25] Internal link suggestions (act tier) are drafted deterministically with the suggester's Jev tier
 * (no re-ask); dedup key = hash(project, 'internal_link', source, target). Declining pages whose dip
 * matches last year are logged as seasonal and not proposed.
 */
import type { Tier } from "@shared/types";
import { BudgetExceededError } from "../../lib/errors";
import { hashJson } from "../../lib/hash";
import { newId } from "../../lib/ids";
import { iso } from "../../lib/time";
import { createEvidence } from "../../recommendations/evidence";
import { isDuplicate, remainingToday, saveRecommendation } from "../../recommendations/store";
import type { RunContext } from "../../runs/context";
import { POLICY_VERSION } from "../../runs/policy";
import { baseQuestionId } from "../questions";
import { buildCandidates, CANDIDATE_RULES_VERSION, seasonalSuppressions, type Candidate, type CandidateConfig } from "./candidates";
import { buildSeoChecklistCandidates } from "./checklist-candidates";
import {
  DecisionCallError,
  evaluateContent,
  evaluateGate,
  evaluateLinkSuggestion,
  evaluatePair,
  evaluateTechnical,
  GATE_KINDS,
  isThinCandidate,
  judgeCandidate,
  judgePairs,
  type Evaluation,
  type JudgedQuestion,
  type Judgment,
} from "./decide";
import { prejudgeQueryRelevance } from "./relevance";
import { draftDeterministic, draftWithWriter, effortFor, type DraftResult, type StoredEvidence } from "./draft";
import { loadCandidateInputs, type CandidateInputs } from "./inputs";
import { computePriority, PRIORITY_VERSION } from "./priority";

export interface RecommendSummary {
  candidates: number;
  created: number;
  rejected: number;
  note: string;
}

export interface GenerateOptions {
  candidateConfig?: Partial<CandidateConfig>;
  /** Content candidates sent to Jev per run (one call each); the rest are rejected 'budget'. */
  maxJudged?: number;
  /** Technical candidates whose severity is asked of Jev per run; the rest stay deterministic. */
  maxTechnicalJudged?: number;
  /** Drafts attempted per run (writer calls are paid); the rest are rejected 'budget'. */
  maxDraftAttempts?: number;
  /** [A21] Feed readiness-checklist gaps and the robots.txt advisor into the shortlist (default true). */
  checklist?: boolean;
  /** [A21] Per-page checklists evaluated for up to this many top pages (default 10). */
  checklistTopPages?: number;
  /** [A23] Run the query relevance pre-filter when Jev is configured (default true). */
  queryRelevance?: boolean;
  /** Wall-clock ms after the step starts past which no new Jev judgment or draft is started. */
  deadlineMs?: number;
}

export const DEFAULT_MAX_JUDGED = 6;
export const DEFAULT_MAX_TECHNICAL_JUDGED = 3;
export const DEFAULT_MAX_DRAFT_ATTEMPTS = 6;
/**
 * No new Jev judgment or writer draft starts after this much of the step has elapsed. One draft can
 * take 3 writer attempts x 90 s plus backoff (~4.7 min), so the step ends within ~27 min, under its
 * 30-minute Workflow step timeout (runs/workflow.ts); a timed-out step would be re-run from the top.
 */
export const RECOMMEND_DRAFT_DEADLINE_MS = 22 * 60_000;
export const NO_NEW_OPPORTUNITIES = "No new verified opportunities.";

interface Pending {
  c: Candidate;
  dedupKey: string;
  evidence?: StoredEvidence[];
  judgment?: { provider: string; model: string; stateHash: string; questions: JudgedQuestion[] };
  evaluation?: Evaluation;
  priority?: number | null;
}

/** Dedup key: project + target (url/template/site) + issue type + hash of the stable evidence identity. */
export async function dedupKeyFor(projectId: string, c: Candidate): Promise<string> {
  if (c.kind === "checklist") {
    // [A21] hash(project, 'checklist', item id, scope target): reruns with fresh counts still match.
    const id = c.identity as { checklist: string; target: string };
    const h = await hashJson({ p: projectId, k: "checklist", i: id.checklist, t: id.target });
    return `seo:checklist:${h.slice(0, 24)}`;
  }
  if (c.linkSuggestion) {
    // [A25] hash(project, 'internal_link', source, target).
    const id = c.identity as { source: string; target: string };
    const h = await hashJson({ p: projectId, k: "internal_link", s: id.source, t: id.target });
    return `seo:internal_link:${h.slice(0, 24)}`;
  }
  const target = c.target.url ?? c.target.template ?? "site";
  const h = await hashJson({ p: projectId, t: target, i: c.issueType, e: c.identity });
  return `seo:${c.issueType}:${h.slice(0, 24)}`;
}

export async function generateSeoRecommendations(ctx: RunContext, opts: GenerateOptions = {}): Promise<RecommendSummary> {
  const step = "seo_recommend";
  const startedAt = ctx.clock().getTime();
  const pastDeadline = () => ctx.clock().getTime() - startedAt >= (opts.deadlineMs ?? RECOMMEND_DRAFT_DEADLINE_MS);
  const remaining = await remainingToday(ctx, "seo");
  if (remaining === 0) {
    const note = "Daily limit reached: no more SEO recommendations today.";
    await ctx.log.event(step, "skipped", note);
    return { candidates: 0, created: 0, rejected: 0, note };
  }

  const inputs = await loadCandidateInputs(ctx);
  if (!inputs.sync && !inputs.crawl && inputs.engineQueries.length === 0) {
    const note = `No Search Console data, crawl, or engine queries yet. ${NO_NEW_OPPORTUNITIES}`;
    await ctx.log.event(step, "skipped", note);
    return { candidates: 0, created: 0, rejected: 0, note };
  }

  // [A23] Query relevance pre-filter (Jev only; never fatal: without it every query is kept).
  if (ctx.decisions && opts.queryRelevance !== false && (inputs.sync || inputs.engineQueries.length)) {
    try {
      const rel = await prejudgeQueryRelevance(ctx, inputs, opts.candidateConfig);
      inputs.queryFilter = rel.filter;
      if (rel.note) await ctx.log.event(step, "info", rel.note);
    } catch (e) {
      await ctx.log.event(step, "info", `Query relevance pre-filter unavailable (${e instanceof Error ? e.message.slice(0, 200) : "error"}); all queries kept.`);
    }
  }
  const seasonal = seasonalSuppressions(inputs, opts.candidateConfig);
  if (seasonal.length) {
    await ctx.log.event(
      step,
      "info",
      `Year-over-year: ${seasonal.length} declining page(s) not proposed because clicks match the same window last year (seasonal): ${seasonal.slice(0, 3).map((x) => x.url).join(", ")}.`,
    );
  }

  let all = buildCandidates(inputs, opts.candidateConfig);
  if (opts.checklist !== false) {
    // [A21] Checklist gaps + robots.txt advisor. Never fatal: without them the run continues as before.
    try {
      const cl = await buildSeoChecklistCandidates(ctx, inputs, all, { topPages: opts.checklistTopPages });
      if (cl.supersedes.length) all = all.filter((c) => !cl.supersedes.includes(c.key));
      // [A23] The AEO answer-clarity candidate for a page supersedes that page's "answer in the first lines" gap.
      const aeoPages = new Set(all.filter((c) => c.kind === "answer_clarity").map((c) => c.page?.norm));
      all.push(...cl.candidates.filter((c) => !(c.checklist?.itemId === "seo.on_page.answer_first_lines" && c.page && aeoPages.has(c.page.norm))));
      for (const n of cl.notes) await ctx.log.event(step, "info", n);
    } catch (e) {
      await ctx.log.event(step, "info", `Checklist gaps unavailable this run (${e instanceof Error ? e.message.slice(0, 200) : "error"}); continuing without them.`);
    }
  }
  const byKind = all.reduce<Record<string, number>>((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
  await ctx.log.event(
    step,
    "info",
    `Shortlisted ${all.length} candidates (${CANDIDATE_RULES_VERSION}): ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}.`,
  );

  let rejected = 0;
  const reject = async (p: Pending, reasonCode: string, tier: Tier | null = null) => {
    rejected++;
    await recordOutcome(ctx, p, "rejected", reasonCode, tier);
  };

  // 1. Dedup against open / dismissed / recently implemented recommendations (and within this run).
  const live: Pending[] = [];
  const seen = new Set<string>();
  for (const c of all) {
    const p: Pending = { c, dedupKey: await dedupKeyFor(ctx.project.id, c) };
    if (seen.has(p.dedupKey)) continue;
    seen.add(p.dedupKey);
    const reason = await duplicateReason(ctx, p.dedupKey);
    if (reason) {
      await reject(p, reason);
      continue;
    }
    live.push(p);
  }

  // 2. Decisions.
  const selected: Pending[] = [];
  const provisional = (p: Pending) => computePriority(p.c.priority, "act") ?? 0;
  if (!ctx.decisions) {
    let unavailable = 0;
    for (const p of live) {
      if (p.c.jevDependent) {
        unavailable++;
        await reject(p, "decision_unavailable");
      } else {
        p.evaluation = p.c.linkSuggestion ? evaluateLinkSuggestion(p.c) : evaluateTechnical(p.c, null);
        selected.push(p);
      }
    }
    if (unavailable) {
      await ctx.log.event(step, "info", `Jev is not configured: semantic ranking unavailable; ${unavailable} content candidate(s) rejected (decision_unavailable).`);
    }
  } else {
    let budgetOut = false;
    const content = live.filter((p) => p.c.jevDependent && p.c.kind !== "duplicate").sort((a, b) => provisional(b) - provisional(a));
    const technical = live.filter((p) => !p.c.jevDependent).sort((a, b) => provisional(b) - provisional(a));
    const pairs = live.filter((p) => p.c.kind === "duplicate");
    const maxJudged = opts.maxJudged ?? DEFAULT_MAX_JUDGED;
    const maxTech = opts.maxTechnicalJudged ?? DEFAULT_MAX_TECHNICAL_JUDGED;

    for (const [i, p] of content.entries()) {
      if (i >= maxJudged || budgetOut || pastDeadline()) {
        await reject(p, "budget");
        continue;
      }
      try {
        const ev = await ensureEvidence(ctx, p);
        p.judgment = await judgeCandidate(ctx, p.c, inputs, ev.map((e) => e.id));
        p.evaluation = GATE_KINDS.has(p.c.kind) ? evaluateGate(p.c, p.judgment) : evaluateContent(p.c, p.judgment);
        for (const w of p.evaluation.warnings) await ctx.log.event(step, "info", `${p.c.kind}: ${w}`);
        if (p.evaluation.outcome === "rejected") await reject(p, p.evaluation.reasonCode ?? "low_fit", p.evaluation.tier);
        else selected.push(p);
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          budgetOut = true;
          await ctx.log.event(step, "partial", "Decision budget exhausted; remaining candidates were not judged.");
          await reject(p, "budget");
        } else {
          await ctx.log.event(step, "failed", `Jev call failed for a ${p.c.kind} candidate: ${e instanceof DecisionCallError ? e.message : "error"}`);
          await reject(p, "decision_unavailable");
        }
      }
    }

    let techJudged = 0;
    for (const p of technical) {
      if (p.c.linkSuggestion) {
        // [A25] The suggester's Jev tier is reused; no question is asked again.
        p.evaluation = evaluateLinkSuggestion(p.c);
        selected.push(p);
        continue;
      }
      let j: Judgment | null = null;
      // Deterministic checklist candidates carry their own documented severity: no Jev question.
      // [A23] Thin-content findings always get their seo.thin_content confirmation (budget permitting).
      if (p.c.kind === "technical" && (techJudged < maxTech || isThinCandidate(p.c)) && !budgetOut && !pastDeadline()) {
        techJudged++;
        try {
          const ev = await ensureEvidence(ctx, p);
          j = await judgeCandidate(ctx, p.c, inputs, ev.map((e) => e.id));
          p.judgment = j;
        } catch (e) {
          if (e instanceof BudgetExceededError) budgetOut = true;
          await ctx.log.event(step, "info", `Severity judgment unavailable for ${p.c.issueType}; using deterministic severity.`);
        }
      }
      p.evaluation = evaluateTechnical(p.c, j);
      for (const w of p.evaluation.warnings) await ctx.log.event(step, "info", `${p.c.issueType}: ${w}`);
      if (p.evaluation.outcome === "rejected") await reject(p, p.evaluation.reasonCode ?? "low_fit", p.evaluation.tier);
      else selected.push(p);
    }

    if (pairs.length) {
      if (budgetOut) for (const p of pairs) await reject(p, "budget");
      else {
        try {
          const results = await judgePairs(ctx, pairs.map((p) => p.c));
          const byKey = new Map(results.map((r) => [r.candidateKey, r]));
          for (const p of pairs) {
            const r = byKey.get(p.c.key);
            if (!r) {
              await reject(p, "insufficient_evidence");
              continue;
            }
            p.judgment = { provider: r.provider, model: r.model, stateHash: r.stateHash, questions: [r.question] };
            p.evaluation = evaluatePair(r);
            if (p.evaluation.outcome === "rejected") await reject(p, p.evaluation.reasonCode ?? "low_fit", p.evaluation.tier);
            else selected.push(p);
          }
        } catch (e) {
          const reason = e instanceof BudgetExceededError ? "budget" : "decision_unavailable";
          await ctx.log.event(step, reason === "budget" ? "partial" : "failed", "Duplicate-pair judgment unavailable; pairs not considered.");
          for (const p of pairs) await reject(p, reason);
        }
      }
    }
  }

  // 3. Priority (code-owned formula) and ranking.
  for (const p of selected) {
    const ev = p.evaluation!;
    const inputsForPriority = {
      ...p.c.priority,
      effort: effortFor(p.c, ev.action, ev.pageAction ?? null),
      severity: ev.severity ?? p.c.priority.severity,
    };
    p.priority = computePriority(inputsForPriority, ev.tier);
  }
  const ranked = selected.filter((p) => p.priority !== null).sort((a, b) => b.priority! - a.priority!);
  for (const p of selected.filter((x) => x.priority === null)) await reject(p, "insufficient_evidence", "drop");

  // 4. Draft, validate, save the top `remaining`.
  let created = 0;
  let attempts = 0;
  const maxAttempts = opts.maxDraftAttempts ?? DEFAULT_MAX_DRAFT_ATTEMPTS;
  const contextDocs = pillarContext(inputs);
  for (const p of ranked) {
    if (created >= remaining || attempts >= maxAttempts || pastDeadline()) {
      await reject(p, "budget", p.evaluation!.tier);
      continue;
    }
    attempts++;
    if (await ctx.isCancelled()) {
      await reject(p, "out_of_scope", p.evaluation!.tier);
      continue;
    }
    const evidence = await ensureEvidence(ctx, p);
    const ev = p.evaluation!;
    const draftInput = {
      candidate: p.c,
      action: ev.action,
      tier: ev.tier,
      intent: ev.intent,
      severityScore: ev.severityScore,
      evidence,
      contextDocs: ev.fields["seo.pillar_fit.choice"] ? contextDocs : [],
      pageAction: ev.pageAction ?? null,
    };
    let result: DraftResult;
    try {
      result = ctx.writer && !p.c.checklist?.deterministicOnly && !p.c.deterministicOnly ? await draftWithWriter(ctx, draftInput) : draftDeterministic(draftInput);
    } catch (e) {
      const why = e instanceof BudgetExceededError ? "Writer budget exhausted." : e instanceof Error ? e.message.slice(0, 200) : "writer error";
      result = { ok: false, reason: "writer_failed", errors: [why] };
    }
    if (!result.ok && result.reason === "writer_failed") {
      // The writer could not be reached (or its budget is spent): fall back to the deterministic
      // template, labelled with no writer provider. A draft the validator rejects is never rescued.
      await ctx.log.event(step, "info", `Writer unavailable for a ${p.c.kind} draft (${result.errors[0] ?? "error"}); used the deterministic template.`);
      result = draftDeterministic(draftInput);
    }
    if (!result.ok) {
      await ctx.log.event(step, "failed", `Draft for ${p.c.kind} rejected (${result.reason}): ${result.errors.slice(0, 3).join("; ")}`);
      await reject(p, result.reason, ev.tier);
      continue;
    }
    // The 0-2/day cap and dedup are re-checked at save time: drafting is slow, and another attempt of
    // this step (a Workflow retry, or a concurrent manual run) may have saved in the meantime.
    if ((await remainingToday(ctx, "seo")) <= 0) {
      await reject(p, "budget", ev.tier);
      continue;
    }
    const dupNow = await duplicateReason(ctx, p.dedupKey);
    if (dupNow) {
      await reject(p, dupNow, ev.tier);
      continue;
    }
    const d = result.draft;
    // The card shows Jev's tier only with a Jev value (drop/deterministic -> no decision shown).
    const decisionTier: Tier | null = ev.decisionFields ? ev.tier : null;
    const savedId = await saveRecommendation(ctx, {
      agent: "seo",
      scope: p.c.scope,
      target: p.c.target,
      issueType: p.c.issueType,
      trigger: d.trigger,
      issue: d.issue,
      action: d.action,
      suggestedSnippet: d.suggestedSnippet,
      rationale: d.rationale,
      effort: d.effort,
      uncertainty: d.uncertainty,
      limitations: d.limitations,
      verified: d.verified,
      priority: p.priority!,
      priorityVersion: PRIORITY_VERSION,
      decisionTier,
      decisionFields: ev.decisionFields,
      evidenceIds: d.evidenceIds,
      evidenceBullets: d.evidenceBullets,
      confirmPlaceholders: d.confirmPlaceholders,
      dedupKey: p.dedupKey,
      writerProvider: d.writerProvider,
      writerModel: d.writerModel,
    });
    if (savedId === null) {
      // Another attempt filled the daily cap between the re-check and the (atomic) insert.
      await reject(p, "budget", ev.tier);
      continue;
    }
    await recordOutcome(ctx, p, "selected", null, ev.tier);
    created++;
  }

  const considered = all.length;
  const note =
    created === 0
      ? NO_NEW_OPPORTUNITIES
      : `${created} new recommendation${created === 1 ? "" : "s"} from ${considered} candidates (${PRIORITY_VERSION}).`;
  await ctx.log.event(step, "completed", `${note} ${rejected} rejected.${ctx.decisions ? "" : " Semantic ranking unavailable (Jev not configured)."}`);
  return { candidates: considered, created, rejected, note };
}

// ------------------------------------------------------------------ helpers
async function duplicateReason(ctx: RunContext, dedupKey: string): Promise<"duplicate" | "dismissed_recently" | null> {
  if (!(await isDuplicate(ctx, dedupKey))) return null;
  const row = await ctx.db.first<{ status: string }>(
    "SELECT status FROM recommendations WHERE workspace_id = ? AND project_id = ? AND dedup_key = ? ORDER BY updated_at DESC LIMIT 1",
    ctx.project.workspaceId,
    ctx.project.id,
    dedupKey,
  );
  return row?.status === "dismissed" ? "dismissed_recently" : "duplicate";
}

async function ensureEvidence(ctx: RunContext, p: Pending): Promise<StoredEvidence[]> {
  if (p.evidence) return p.evidence;
  const out: StoredEvidence[] = [];
  for (const spec of p.c.evidence) {
    const id = await createEvidence(ctx, { source: spec.source, refId: spec.refId, window: spec.window, text: spec.text, data: spec.data, tainted: spec.tainted });
    out.push({ id, spec });
  }
  p.evidence = out;
  return out;
}

/** One decision_record per asked question (raw answer kept for re-scoring); one row when none asked. */
async function recordOutcome(ctx: RunContext, p: Pending, outcome: "selected" | "rejected", reasonCode: string | null, tier: Tier | null): Promise<void> {
  const now = iso(ctx.clock());
  const base = {
    workspace_id: ctx.project.workspaceId,
    project_id: ctx.project.id,
    run_id: ctx.runId,
    agent: "seo",
    candidate_key: p.dedupKey,
    policy_version: POLICY_VERSION,
    outcome,
    reason_code: reasonCode,
    created_at: now,
  };
  const j = p.judgment;
  if (!j || j.questions.length === 0) {
    await ctx.db.insert("decision_records", {
      id: newId("dec"),
      ...base,
      question_id: null,
      question_version: null,
      provider: null,
      model: null,
      state_hash: null,
      answer_json: JSON.stringify({
        candidate: p.c.key,
        kind: p.c.kind,
        rules: CANDIDATE_RULES_VERSION,
        ...(p.c.linkSuggestion ? { linkSuggestionId: p.c.linkSuggestion.id, suggestionTier: p.c.linkSuggestion.tier, shouldExist: p.c.linkSuggestion.shouldExist } : {}),
      }),
      tier: tier ?? "n/a",
    });
    return;
  }
  for (const q of j.questions) {
    const baseId = baseQuestionId(q.questionId);
    await ctx.db.insert("decision_records", {
      id: newId("dec"),
      ...base,
      question_id: baseId,
      question_version: q.questionVersion,
      provider: j.provider,
      model: j.model,
      state_hash: j.stateHash,
      answer_json: JSON.stringify({ answer: q.answer ?? null, candidate: p.c.key, questionTier: q.tier, ...(baseId !== q.questionId ? { key: q.questionId } : {}) }),
      tier: q.tier,
    });
  }
}

function pillarContext(inputs: CandidateInputs): Array<{ id: string; kind: string; version: number; excerpt: string }> {
  if (!inputs.pillars) return [];
  return [{ id: inputs.pillars.docId, kind: "pillars", version: inputs.pillars.version, excerpt: inputs.pillars.names.join("; ").slice(0, 600) }];
}
