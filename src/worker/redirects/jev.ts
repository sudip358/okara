/**
 * Redirect map [A23]: one Jev Choice per unresolved old URL over its deterministic shortlist.
 *
 * - Options: c0..c4 (one per shortlisted candidate, each a full sentence naming the candidate URL and
 *   its crawled title), plus the escape options `none` and `insufficient_context` [A13].
 * - Old URLs whose shortlist is empty are never asked (absent inputs are omitted, not padded).
 * - Batching: up to REDIRECT_BATCH_SIZE questions per systemOne call. State is keyed by question id:
 *   { old_<n>: { old: { url, slug_tokens }, candidates: [{ key, url, title }] } }, and each question
 *   references its own `old_<n>` paths.
 * - Tiering (policy.tierFor): choice c_k + act = auto; c_k + flag = review ("Check this yourself",
 *   runner-up named); c_k + drop = no_match with the Jev value withheld; `none` and
 *   `insufficient_context` are no_match at any tier. A missing/malformed answer or a failed call is
 *   review (the decision was unavailable; nothing is redirected blindly).
 * - Budget: the DecisionProvider reserves provider_calls + jev_calls per call (see
 *   providers/typesafe.ts). A BudgetExceededError stops further calls; the remaining rows are review.
 *   Any other call failure also stops further calls (fail closed, no retries beyond the SDK's).
 * - Every asked or budget-skipped row gets a decision_records row (agent 'seo', candidate_key
 *   'redirect:<from path>', question_version, POLICY_VERSION, raw answer for re-scoring).
 * - question_version hashes the question TEMPLATE (placeholders instead of candidate URLs/titles), so
 *   it is stable across old URLs and changes whenever the wording changes (snapshot-tested).
 */
import type { Tier } from "@shared/types";
import type { Db } from "../lib/db";
import { BudgetExceededError } from "../lib/errors";
import { hashJson } from "../lib/hash";
import { newId } from "../lib/ids";
import { iso, type Clock } from "../lib/time";
import type { DecisionAnswer, DecisionProvider, DecisionQuestion, DecisionResult } from "../providers/types";
import { POLICY_VERSION, questionVersion, runnerUp, tierFor } from "../runs/policy";

export const REDIRECT_QUESTION_ID = "seo.redirect_match";
export const REDIRECT_QUESTIONS_REVISION = "redirect-questions-2026-09-30.1";
export const REDIRECT_BATCH_SIZE = 20;
export const REDIRECT_MAX_CANDIDATES = 5;
export const REDIRECT_PURPOSE = "seo.redirect_map";
const TITLE_MAX = 150;

export interface RedirectCandidate {
  url: string;
  title: string | null;
  score: number;
}

export interface RedirectJevItem {
  /** Old path (also the decision_records candidate key suffix). */
  from: string;
  /** Old absolute URL as shown to Jev. */
  oldUrl: string;
  slugTokens: string[];
  /** Deterministic shortlist, best first (at most REDIRECT_MAX_CANDIDATES are used). */
  candidates: RedirectCandidate[];
}

export interface RedirectJevOutcome {
  status: "auto" | "review" | "no_match";
  to: string | null;
  confidence: number | null;
  tier: Tier | null;
  note: string;
  /** True when Jev actually answered this row. */
  answered: boolean;
}

export interface RedirectJevRun {
  outcomes: RedirectJevOutcome[];
  calls: number;
  asked: number;
  model: string | null;
  provider: string | null;
  stoppedBy: "budget" | "error" | null;
}

export interface RedirectJevDeps {
  decisions: DecisionProvider;
  db: Db;
  workspaceId: string;
  projectId: string;
  clock: Clock;
  batchSize?: number;
}

/** Untrusted crawled text for Jev: no control characters or backticks, collapsed, capped. */
export function sanitizeTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = title
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/`/g, "'")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

const optionKey = (i: number) => `c${i}`;

/** The Choice question for one old URL (`key` = old_<n>) over its candidates. */
export function buildRedirectQuestion(key: string, candidates: ReadonlyArray<{ url: string; title: string | null }>): DecisionQuestion {
  const criteria: Record<string, string> = {};
  candidates.slice(0, REDIRECT_MAX_CANDIDATES).forEach((c, i) => {
    const title = c.title ? `the page titled "${c.title}"` : "a page with no crawled title";
    criteria[optionKey(i)] =
      `Redirect to ${c.url}, ${title} (entry ${optionKey(i)} in \`${key}.candidates\`): it serves the same purpose as the old URL, for example the same product, category, article, or information, so visitors and search engines following the old URL should land there.`;
  });
  criteria.none = "None of these pages serves the same purpose; the old URL should not be redirected to any of them.";
  criteria.insufficient_context =
    "Insufficient context. The old URL and the candidate URLs and titles are too ambiguous or uninformative to tell which page, if any, serves the same purpose.";
  return {
    type: "choice",
    instructions:
      `A page on this site at the old URL \`${key}.old.url\` (words from its address: \`${key}.old.slug_tokens\`) is being retired and needs a permanent redirect. Which page listed in \`${key}.candidates\` serves the same purpose, so that people and search engines following the old URL should be sent there? Choose none if no candidate is a genuine replacement; a merely related page is not enough.`,
    criteria,
  };
}

/** The template used for question_version: same wording, placeholder URLs/titles, all five options. */
export const REDIRECT_QUESTION_TEMPLATE: DecisionQuestion = buildRedirectQuestion(
  "old_<n>",
  Array.from({ length: REDIRECT_MAX_CANDIDATES }, (_, i) => ({ url: `<candidate_${i}_url>`, title: `<candidate_${i}_title>` })),
);

export function redirectQuestionVersion(): Promise<string> {
  return questionVersion(REDIRECT_QUESTION_TEMPLATE);
}

interface Asked {
  item: RedirectJevItem;
  index: number;
  key: string;
  candidates: Array<{ url: string; title: string | null }>;
  state: { old: { url: string; slug_tokens: string[] }; candidates: Array<{ key: string; url: string; title: string | null }> };
}

function describeOption(label: string, cands: Asked["candidates"]): string {
  if (label === "none") return "none of these pages";
  if (label === "insufficient_context") return "insufficient context";
  const m = /^c(\d)$/.exec(label);
  const c = m ? cands[Number(m[1])] : undefined;
  return c ? c.url : label;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Map one Jev answer onto a redirect outcome (pure; see the module comment for the rules). */
export function outcomeFor(answer: DecisionAnswer | undefined, candidates: Asked["candidates"]): RedirectJevOutcome & { reason: string | null; outcome: "selected" | "rejected" } {
  if (!answer || answer.type !== "choice") {
    return {
      status: "review",
      to: null,
      confidence: null,
      tier: null,
      note: "Jev returned no usable answer for this URL; pick a candidate or leave it unredirected.",
      answered: false,
      reason: "decision_unavailable",
      outcome: "rejected",
    };
  }
  const tier = tierFor(REDIRECT_QUESTION_ID, answer);
  // [A13] Below the Flag threshold no Jev value is shown.
  const confidence = tier === "drop" ? null : answer.confidence;
  if (answer.choice === "none") {
    return {
      status: "no_match",
      to: null,
      confidence,
      tier,
      note: tier === "drop" ? "Jev's answer was below the review threshold and is withheld; no redirect is suggested." : "Jev: none of the shortlisted pages serves the same purpose, so no redirect is suggested.",
      answered: true,
      reason: tier === "drop" ? "insufficient_evidence" : "low_fit",
      outcome: "rejected",
    };
  }
  if (answer.choice === "insufficient_context") {
    return {
      status: "no_match",
      to: null,
      confidence,
      tier,
      note: "Jev: not enough context to tell which page, if any, serves the same purpose; no redirect is suggested.",
      answered: true,
      reason: "insufficient_evidence",
      outcome: "rejected",
    };
  }
  const m = /^c(\d)$/.exec(answer.choice);
  const cand = m ? candidates[Number(m[1])] : undefined;
  if (!cand) {
    return { status: "review", to: null, confidence: null, tier: null, note: "Jev chose an option that is not in the shortlist; decide this row yourself.", answered: false, reason: "decision_unavailable", outcome: "rejected" };
  }
  if (tier === "act") {
    return { status: "auto", to: cand.url, confidence, tier, note: "Jev chose this page from the shortlist.", answered: true, reason: null, outcome: "selected" };
  }
  if (tier === "flag") {
    const ru = runnerUp(answer);
    const runner = ru ? ` Runner-up: ${describeOption(ru.label, candidates)} (${pct(ru.probability)}).` : "";
    return { status: "review", to: cand.url, confidence, tier, note: `Check this yourself: Jev leaned towards this page without enough confidence to redirect automatically.${runner}`, answered: true, reason: null, outcome: "selected" };
  }
  return {
    status: "no_match",
    to: null,
    confidence: null,
    tier,
    note: "Jev's answer was below the review threshold and is withheld; no redirect is suggested.",
    answered: true,
    reason: "insufficient_evidence",
    outcome: "rejected",
  };
}

/**
 * Ask Jev about every item with a non-empty shortlist, in batches. Items with an empty shortlist are
 * returned as review without a question. Outcomes are in item order.
 */
export async function decideRedirects(items: readonly RedirectJevItem[], deps: RedirectJevDeps): Promise<RedirectJevRun> {
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? REDIRECT_BATCH_SIZE, REDIRECT_BATCH_SIZE));
  const qVersion = await redirectQuestionVersion();
  const outcomes: Array<RedirectJevOutcome | undefined> = new Array(items.length).fill(undefined);
  const askable: Asked[] = [];
  items.forEach((item, index) => {
    const candidates = item.candidates.slice(0, REDIRECT_MAX_CANDIDATES).map((c) => ({ url: c.url, title: sanitizeTitle(c.title) }));
    if (candidates.length === 0) {
      outcomes[index] = {
        status: "review",
        to: null,
        confidence: null,
        tier: null,
        note: "No new URL shares any words with this URL, so there was nothing to ask Jev; decide it yourself or leave it unredirected.",
        answered: false,
      };
      return;
    }
    askable.push({
      item,
      index,
      key: "",
      candidates,
      state: { old: { url: item.oldUrl, slug_tokens: item.slugTokens }, candidates: candidates.map((c, i) => ({ key: optionKey(i), ...c })) },
    });
  });

  let calls = 0;
  let asked = 0;
  let model: string | null = null;
  let provider: string | null = null;
  let stoppedBy: RedirectJevRun["stoppedBy"] = null;

  for (let start = 0; start < askable.length; start += batchSize) {
    const batch = askable.slice(start, start + batchSize).map((a, n) => ({ ...a, key: `old_${n}` }));
    const now = iso(deps.clock());
    const stmts: Array<[string, ...unknown[]]> = [];
    const record = async (a: Asked, fields: { res: DecisionResult | null; answer: DecisionAnswer | undefined; tier: Tier | null; outcome: "selected" | "rejected"; reason: string | null }) => {
      stmts.push([
        `INSERT INTO decision_records (id, workspace_id, project_id, run_id, agent, candidate_key, question_id, question_version, policy_version, provider, model, state_hash, answer_json, tier, outcome, reason_code, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newId("dec"), deps.workspaceId, deps.projectId, null, "seo", `redirect:${a.item.from}`.slice(0, 2100), REDIRECT_QUESTION_ID, qVersion, POLICY_VERSION,
        fields.res?.provider ?? deps.decisions.name, fields.res?.model ?? null, await hashJson(a.state),
        JSON.stringify({ answer: fields.answer ?? null, from: a.item.from, candidates: a.candidates.map((c) => c.url), revision: REDIRECT_QUESTIONS_REVISION }),
        fields.tier, fields.outcome, fields.reason, now,
      ]);
    };

    if (stoppedBy) {
      for (const a of batch) {
        outcomes[a.index] = skippedOutcome(stoppedBy);
        await record(a, { res: null, answer: undefined, tier: null, outcome: "rejected", reason: stoppedBy === "budget" ? "budget" : "decision_unavailable" });
      }
      await deps.db.batch(stmts);
      continue;
    }

    const state: Record<string, Asked["state"]> = {};
    const questions: Record<string, DecisionQuestion> = {};
    for (const a of batch) {
      state[a.key] = a.state;
      questions[a.key] = buildRedirectQuestion(a.key, a.candidates);
    }

    let res: DecisionResult | null = null;
    try {
      calls++;
      res = await deps.decisions.decide({ purpose: REDIRECT_PURPOSE, state, questions });
    } catch (e) {
      stoppedBy = e instanceof BudgetExceededError ? "budget" : "error";
      if (stoppedBy === "budget") calls--; // the provider refused before any request was sent
    }

    if (!res) {
      for (const a of batch) {
        outcomes[a.index] = skippedOutcome(stoppedBy ?? "error");
        await record(a, { res: null, answer: undefined, tier: null, outcome: "rejected", reason: stoppedBy === "budget" ? "budget" : "decision_unavailable" });
      }
      await deps.db.batch(stmts);
      continue;
    }

    model = res.model;
    provider = res.provider;
    for (const a of batch) {
      asked++;
      const answer = res.answers[a.key];
      const o = outcomeFor(answer, a.candidates);
      outcomes[a.index] = { status: o.status, to: o.to, confidence: o.confidence, tier: o.tier, note: o.note, answered: o.answered };
      await record(a, { res, answer, tier: o.answered ? o.tier : "drop", outcome: o.outcome, reason: o.reason });
    }
    await deps.db.batch(stmts);
  }

  return {
    outcomes: outcomes.map((o) => o ?? skippedOutcome("error")),
    calls,
    asked,
    model,
    provider,
    stoppedBy,
  };
}

function skippedOutcome(why: "budget" | "error"): RedirectJevOutcome {
  return {
    status: "review",
    to: null,
    confidence: null,
    tier: null,
    note:
      why === "budget"
        ? "Not sent to Jev: this project's daily Jev budget is used up. Pick a candidate or leave it unredirected."
        : "Not decided: Jev could not be reached, so no further questions were sent. Pick a candidate or leave it unredirected.",
    answered: false,
  };
}
