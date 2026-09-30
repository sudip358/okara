/**
 * [A25] Jev questions for internal-link candidates: four questions per source -> target pair, asked for
 * up to LINK_BATCH_SIZE pairs in ONE systemOne call (gate and dependent questions in the same batch; code
 * decides which answers count).
 *
 * Question ids per call: `link_<n>.should_exist` (Noul), `link_<n>.sentence` (Choice s0..s3 + none),
 * `link_<n>.anchor` (Choice a0..a4 + none), `link_<n>.role` (Choice over the six roles +
 * insufficient_context). State is keyed per pair: { link_<n>: { source, target, sentences, anchors } }
 * with source/target titles and URLs, the target's defining terms, and the candidate sentences/anchors.
 * Options are full sentences quoting the (sanitized) sentence or phrase. A pair without sentences or
 * anchors is never asked (absent inputs are omitted, not padded).
 *
 * Tiering (runs/policy.tierFor, policy ids LINK_POLICY_IDS):
 *   - should_exist is a Noul: tiered by probability bands only (never a confidence field).
 *     noul <= "no" band (act) -> rejected. Missing/malformed -> the pair's decision is unavailable and the
 *     caller falls back to the deterministic pick (review).
 *   - sentence / anchor: `none` at act or flag tier -> rejected. A Drop-tier answer is withheld and the
 *     deterministic pick is used instead.
 *   - suggestion tier = min(tier(should_exist), tier(sentence), tier(anchor)); role never gates.
 *   - status: rejected (above) > suggested when the tier is act and should_exist is a confident yes >
 *     review otherwise (flag = "Check this yourself" with the runner-up named; drop = withheld).
 *   - role: `insufficient_context` or a Drop-tier answer -> no role.
 *   - An anchor that does not occur in Jev's chosen sentence is shown with its own sentence, as review.
 * Budget: the DecisionProvider reserves provider_calls + jev_calls per call (providers/typesafe.ts). A
 * BudgetExceededError, or any other call failure, stops further calls; remaining pairs fall back to
 * deterministic review. Every asked or skipped pair gets a decision_records row (agent 'seo',
 * candidate_key 'link:<source page id>><target page id>', question_version, POLICY_VERSION, raw answers).
 */
import type { LinkRole, Tier } from "@shared/types";
import type { Db } from "../lib/db";
import { BudgetExceededError } from "../lib/errors";
import { hashJson } from "../lib/hash";
import { newId } from "../lib/ids";
import { iso, type Clock } from "../lib/time";
import type { DecisionAnswer, DecisionProvider, DecisionQuestion, DecisionResult } from "../providers/types";
import { POLICY_VERSION, runnerUp, tierFor } from "../runs/policy";

export const LINK_QUESTIONS_REVISION = "link-questions-2026-09-30.1";
export const LINK_BATCH_SIZE = 10;
export const LINK_PURPOSE = "seo.internal_links";
export const LINK_DECISION_QUESTION_ID = "links.pair";
export const LINK_POLICY_IDS = {
  shouldExist: "links.should_exist",
  sentence: "links.sentence",
  anchor: "links.anchor",
  role: "links.role",
} as const;

export const LINK_ROLES: readonly LinkRole[] = ["explains_concept", "deeper_detail", "broader_guide", "next_step", "product_service", "comparison"];

const ROLE_CRITERIA: Record<LinkRole | "insufficient_context", string> = {
  explains_concept: "Explains a concept: the target page defines or explains a term, material, or idea that the source page mentions.",
  deeper_detail: "Deeper detail: the target page covers one specific aspect of the source page's topic in more depth.",
  broader_guide: "Broader guide: the target page is a wider overview, category, or hub that the source page's topic belongs to.",
  next_step: "Next step: the target page is what a reader of the source page would naturally do or read next, such as a how-to, checklist, or setup page.",
  product_service: "Product or service: the target page is a product, collection, or service page that a reader of the source page might buy or use.",
  comparison: "Comparison: the target page compares options that the source page mentions or helps the reader choose between them.",
  insufficient_context: "Insufficient context: the titles, terms, and sentences are too sparse or ambiguous to tell what role the link would play.",
};

const TEXT_MAX = { title: 150, sentence: 240, anchor: 80, url: 300, term: 40 } as const;

/** Untrusted crawled text for Jev: no control characters, backticks, or double quotes; collapsed; capped. */
export function sanitizeForJev(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const t = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[`"“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface LinkJevPair {
  /** `<source page id>><target page id>` */
  pairKey: string;
  source: { url: string; title: string | null };
  target: { url: string; title: string | null; h1: string | null; terms: string[] };
  /** Ranked candidate sentences, keys s0..s3. */
  sentences: Array<{ key: string; text: string }>;
  /** Anchor candidates, keys a0..a4, each with the key of the sentence it comes from. */
  anchors: Array<{ key: string; text: string; sentenceKey: string }>;
  /** Deterministic pick used when Jev's choice is withheld or unavailable. */
  fallback: { sentenceKey: string; anchorKey: string };
}

interface PairState {
  source: { url: string; title: string | null };
  target: { url: string; title: string | null; h1: string | null; terms: string[] };
  sentences: Array<{ key: string; text: string }>;
  anchors: Array<{ key: string; text: string; sentence: string }>;
}

export function pairState(p: LinkJevPair): PairState {
  return {
    source: { url: p.source.url.slice(0, TEXT_MAX.url), title: sanitizeForJev(p.source.title, TEXT_MAX.title) },
    target: {
      url: p.target.url.slice(0, TEXT_MAX.url),
      title: sanitizeForJev(p.target.title, TEXT_MAX.title),
      h1: sanitizeForJev(p.target.h1, TEXT_MAX.title),
      terms: p.target.terms.map((t) => sanitizeForJev(t, TEXT_MAX.term)).filter((t): t is string => !!t),
    },
    sentences: p.sentences.map((s) => ({ key: s.key, text: sanitizeForJev(s.text, TEXT_MAX.sentence) ?? "" })),
    anchors: p.anchors.map((a) => ({ key: a.key, text: sanitizeForJev(a.text, TEXT_MAX.anchor) ?? "", sentence: a.sentenceKey })),
  };
}

export function buildShouldExistQuestion(key: string): DecisionQuestion {
  return {
    type: "noul",
    instructions: `Should the page \`${key}.source\` link to the page \`${key}.target\` from inside its body text? \`${key}.target.terms\` are the words that define the target page, and \`${key}.sentences\` are sentences from the source page that mention them. Judge whether a reader of the source page would genuinely benefit from following the link, not merely whether the two pages share words.`,
    criteria: {
      true: "Yes. The target page explains, expands on, or is a natural next step for something the source page discusses, so a reader of the source page would find the link useful.",
      false: "No. The pages only share words, or cover a different topic or intent, so the link would be irrelevant, distracting, or misleading for a reader of the source page.",
    },
  };
}

export function buildSentenceQuestion(key: string, sentences: ReadonlyArray<{ key: string; text: string }>): DecisionQuestion {
  const criteria: Record<string, string> = {};
  for (const s of sentences) {
    criteria[s.key] = `Sentence ${s.key} in \`${key}.sentences\`: "${s.text}". It talks about the target page's topic directly, so a link placed in it reads naturally and tells the reader what they will find.`;
  }
  criteria.none = "None of the sentences is a natural place for this link; each mentions the target's words only in passing or in a different sense.";
  return {
    type: "choice",
    instructions: `Which sentence from \`${key}.sentences\` is the most natural place in the source page \`${key}.source\` for a link to the target page \`${key}.target\`? Prefer a sentence that discusses the target's topic directly, so the link reads naturally and sets the right expectation. Choose none if no sentence is a natural place for the link.`,
    criteria,
  };
}

export function buildAnchorQuestion(key: string, anchors: ReadonlyArray<{ key: string; text: string; sentence: string }>): DecisionQuestion {
  const criteria: Record<string, string> = {};
  for (const a of anchors) {
    criteria[a.key] = `Phrase ${a.key} in \`${key}.anchors\`: "${a.text}" (from sentence ${a.sentence}). It describes what the target page is about, so a reader knows where the link leads.`;
  }
  criteria.none = "None of these phrases describes the target page accurately enough to be its link text.";
  return {
    type: "choice",
    instructions: `Which phrase from \`${key}.anchors\` is the best link text (anchor) for a link from the source page \`${key}.source\` to the target page \`${key}.target\`? Good link text describes the target page accurately and reads naturally in its sentence. Choose none if no phrase describes the target page accurately.`,
    criteria,
  };
}

export function buildRoleQuestion(key: string): DecisionQuestion {
  return {
    type: "choice",
    instructions: `What role would a link from the source page \`${key}.source\` to the target page \`${key}.target\` play for a reader, given \`${key}.target.terms\` and \`${key}.sentences\`?`,
    criteria: { ...ROLE_CRITERIA },
  };
}

/** The four questions for one pair, keyed `<key>.should_exist`, `<key>.sentence`, `<key>.anchor`, `<key>.role`. */
export function buildPairQuestions(key: string, state: PairState): Record<string, DecisionQuestion> {
  return {
    [`${key}.should_exist`]: buildShouldExistQuestion(key),
    [`${key}.sentence`]: buildSentenceQuestion(key, state.sentences),
    [`${key}.anchor`]: buildAnchorQuestion(key, state.anchors),
    [`${key}.role`]: buildRoleQuestion(key),
  };
}

/** Templates (placeholder texts, all four sentences and five anchors) used for question_version. */
export const LINK_QUESTION_TEMPLATES: Record<string, DecisionQuestion> = buildPairQuestions("link_<n>", {
  source: { url: "<source_url>", title: "<source_title>" },
  target: { url: "<target_url>", title: "<target_title>", h1: "<target_h1>", terms: ["<term>"] },
  sentences: Array.from({ length: 4 }, (_, i) => ({ key: `s${i}`, text: `<sentence_${i}>` })),
  anchors: Array.from({ length: 5 }, (_, i) => ({ key: `a${i}`, text: `<anchor_${i}>`, sentence: `<sentence_key_${i}>` })),
});

export async function linkQuestionVersion(): Promise<string> {
  return (await hashJson(LINK_QUESTION_TEMPLATES)).slice(0, 16);
}

// ------------------------------------------------------------------------------------ answer mapping

const TIER_RANK: Record<Tier, number> = { drop: 0, flag: 1, act: 2, "n/a": 2 };
export function minTier(...tiers: Tier[]): Tier {
  return tiers.reduce((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a), "act" as Tier);
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

export interface LinkAnswers {
  shouldExist: DecisionAnswer | undefined;
  sentence: DecisionAnswer | undefined;
  anchor: DecisionAnswer | undefined;
  role: DecisionAnswer | undefined;
}

export interface LinkJevOutcome {
  status: "suggested" | "review" | "rejected";
  tier: Tier;
  /** Final sentence/anchor keys (Jev's choice when usable, else the deterministic pick). */
  sentenceKey: string;
  anchorKey: string;
  role: LinkRole | null;
  shouldExist: number | null;
  sentenceConfidence: number | null;
  anchorConfidence: number | null;
  roleConfidence: number | null;
  reasons: string[];
  outcome: "selected" | "rejected";
  reasonCode: string | null;
}

/**
 * Map one pair's four answers onto a suggestion outcome (pure). Returns null when should_exist has no
 * usable answer: the decision is unavailable and the caller keeps the deterministic review suggestion.
 */
export function outcomeForPair(a: LinkAnswers, pair: LinkJevPair): LinkJevOutcome | null {
  if (!a.shouldExist || a.shouldExist.type !== "noul") return null;
  const reasons: string[] = [];
  let rejected: string | null = null;
  let reasonCode: string | null = null;

  const seTier = tierFor(LINK_POLICY_IDS.shouldExist, a.shouldExist);
  const noul = a.shouldExist.noul;
  const shouldExist = seTier === "drop" ? null : noul;
  if (seTier === "act" && noul < 0.5) {
    rejected = `Jev: this link should not exist (probability of yes ${noul.toFixed(2)}).`;
    reasonCode = "low_fit";
  } else if (seTier === "act") reasons.push(`Jev: the link should exist (probability of yes ${noul.toFixed(2)}).`);
  else if (seTier === "flag") reasons.push(`Check this yourself: Jev is unsure whether this link should exist (probability of yes ${noul.toFixed(2)}).`);
  else reasons.push("Jev's answer on whether the link should exist is withheld (below the policy threshold).");

  const choice = (ans: DecisionAnswer | undefined, policyId: string) => {
    if (!ans || ans.type !== "choice") return { tier: "drop" as Tier, choice: null as string | null, confidence: null as number | null, ans: undefined };
    const tier = tierFor(policyId, ans);
    return { tier, choice: tier === "drop" ? null : ans.choice, confidence: tier === "drop" ? null : ans.confidence, ans };
  };
  const s = choice(a.sentence, LINK_POLICY_IDS.sentence);
  const an = choice(a.anchor, LINK_POLICY_IDS.anchor);
  const r = choice(a.role, LINK_POLICY_IDS.role);

  const sentenceKeys = new Set(pair.sentences.map((x) => x.key));
  const anchorByKey = new Map(pair.anchors.map((x) => [x.key, x]));
  const sentenceText = (k: string) => pair.sentences.find((x) => x.key === k)?.text ?? "";

  if (s.choice === "none") {
    rejected ??= "Jev: none of the candidate sentences is a natural place for this link.";
    reasonCode ??= "low_fit";
  } else if (s.choice && !sentenceKeys.has(s.choice)) {
    s.choice = null; // not an offered option: treat as unusable
  }
  if (an.choice === "none") {
    rejected ??= "Jev: none of the candidate phrases describes the target page well enough to be its link text.";
    reasonCode ??= "low_fit";
  } else if (an.choice && !anchorByKey.has(an.choice)) {
    an.choice = null;
  }
  if (!s.ans) reasons.push("Jev returned no usable sentence choice; the deterministic best sentence is shown.");
  else if (s.tier === "drop") reasons.push("Jev's sentence choice is withheld (below the policy threshold); the deterministic best sentence is shown.");
  if (!an.ans) reasons.push("Jev returned no usable anchor choice; the deterministic best anchor is shown.");
  else if (an.tier === "drop") reasons.push("Jev's anchor choice is withheld (below the policy threshold); the deterministic best anchor is shown.");
  for (const [label, c] of [["sentence", s], ["anchor", an]] as const) {
    if (c.tier === "flag" && c.ans?.type === "choice") {
      const ru = runnerUp(c.ans);
      reasons.push(`Check this yourself: Jev's ${label} choice ${c.ans.choice} has ${pct(c.ans.confidence)} confidence${ru ? `; runner-up ${ru.label} (${pct(ru.probability)})` : ""}.`);
    }
  }

  // Resolve the final sentence and anchor.
  const jevSentence = s.choice && s.choice !== "none" ? s.choice : null;
  const jevAnchor = an.choice && an.choice !== "none" ? an.choice : null;
  let sentenceKey = jevSentence ?? (jevAnchor ? anchorByKey.get(jevAnchor)!.sentenceKey : pair.fallback.sentenceKey);
  let anchorKey = jevAnchor ?? pair.anchors.find((x) => x.sentenceKey === sentenceKey)?.key ?? pair.fallback.anchorKey;
  let mismatch = false;
  const anchor = anchorByKey.get(anchorKey);
  if (anchor && !sentenceText(sentenceKey).toLowerCase().includes(anchor.text.toLowerCase())) {
    if (jevSentence && jevAnchor) {
      mismatch = true;
      reasons.push(`Jev chose sentence ${jevSentence}, but anchor ${jevAnchor} comes from sentence ${anchor.sentenceKey}; the anchor is shown with its own sentence. Check this yourself.`);
    }
    sentenceKey = anchor.sentenceKey;
  }
  if (!anchor) anchorKey = pair.fallback.anchorKey;

  let role: LinkRole | null = null;
  if (r.choice && (LINK_ROLES as readonly string[]).includes(r.choice)) role = r.choice as LinkRole;
  else if (r.choice === "insufficient_context") reasons.push("Jev: not enough context to name the link's role.");
  if (r.tier === "flag" && role) reasons.push(`Check this yourself: the role has ${pct(r.confidence ?? 0)} confidence.`);

  const tier = minTier(seTier, s.tier, an.tier);
  let status: LinkJevOutcome["status"];
  if (rejected) status = "rejected";
  else if (tier === "act" && noul >= 0.5 && !mismatch) status = "suggested";
  else status = "review";
  if (rejected) reasons.unshift(rejected);
  if (!rejected && tier === "drop") reasonCode = "insufficient_evidence";

  return {
    status,
    tier,
    sentenceKey,
    anchorKey,
    role,
    shouldExist,
    sentenceConfidence: s.confidence,
    anchorConfidence: an.confidence,
    roleConfidence: role ? r.confidence : null,
    reasons,
    outcome: status === "rejected" ? "rejected" : "selected",
    reasonCode,
  };
}

// ------------------------------------------------------------------------------------ batched calls

export interface LinkJevDeps {
  decisions: DecisionProvider;
  db: Db;
  workspaceId: string;
  projectId: string;
  linkRunId: string;
  clock: Clock;
  batchSize?: number;
}

export interface LinkJevRun {
  /** Per pair: the Jev outcome, or null when Jev did not answer usably (not sent, failed, or no should_exist answer). */
  outcomes: Array<LinkJevOutcome | null>;
  /** Per pair: why it was not sent ("budget" | "error"), else null. */
  skipped: Array<"budget" | "error" | null>;
  /** Per pair: the decision_records id. */
  decisionIds: Array<string | null>;
  calls: number;
  asked: number;
  answered: number;
  model: string | null;
  provider: string | null;
  stoppedBy: "budget" | "error" | null;
  questionVersion: string;
}

export async function decideLinks(pairs: readonly LinkJevPair[], deps: LinkJevDeps): Promise<LinkJevRun> {
  const batchSize = Math.max(1, Math.min(deps.batchSize ?? LINK_BATCH_SIZE, LINK_BATCH_SIZE));
  const qVersion = await linkQuestionVersion();
  const outcomes: Array<LinkJevOutcome | null> = pairs.map(() => null);
  const skipped: Array<"budget" | "error" | null> = pairs.map(() => null);
  const decisionIds: Array<string | null> = pairs.map(() => null);
  const askable = pairs.map((p, i) => ({ p, i })).filter(({ p }) => p.sentences.length > 0 && p.anchors.length > 0);

  let calls = 0;
  let asked = 0;
  let answered = 0;
  let model: string | null = null;
  let provider: string | null = null;
  let stoppedBy: LinkJevRun["stoppedBy"] = null;

  for (let start = 0; start < askable.length; start += batchSize) {
    const batch = askable.slice(start, start + batchSize).map((x, n) => ({ ...x, key: `link_${n}`, state: pairState(x.p) }));
    const now = iso(deps.clock());
    const stmts: Array<[string, ...unknown[]]> = [];
    const record = async (x: (typeof batch)[number], f: { res: DecisionResult | null; answers: LinkAnswers | null; tier: Tier | null; outcome: "selected" | "rejected"; reason: string | null }) => {
      const id = newId("dec");
      decisionIds[x.i] = id;
      stmts.push([
        `INSERT INTO decision_records (id, workspace_id, project_id, run_id, agent, candidate_key, question_id, question_version, policy_version, provider, model, state_hash, answer_json, tier, outcome, reason_code, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, deps.workspaceId, deps.projectId, null, "seo", `link:${x.p.pairKey}`.slice(0, 500), LINK_DECISION_QUESTION_ID, qVersion, POLICY_VERSION,
        f.res?.provider ?? deps.decisions.name, f.res?.model ?? null, await hashJson(x.state),
        JSON.stringify({
          answers: f.answers
            ? { should_exist: f.answers.shouldExist ?? null, sentence: f.answers.sentence ?? null, anchor: f.answers.anchor ?? null, role: f.answers.role ?? null }
            : null,
          revision: LINK_QUESTIONS_REVISION,
          linkRunId: deps.linkRunId,
          source: x.p.source.url,
          target: x.p.target.url,
          sentences: x.state.sentences.map((s) => s.key),
          anchors: x.state.anchors.map((a) => a.key),
        }),
        f.tier, f.outcome, f.reason, now,
      ]);
    };

    if (stoppedBy) {
      for (const x of batch) {
        skipped[x.i] = stoppedBy;
        await record(x, { res: null, answers: null, tier: null, outcome: "rejected", reason: stoppedBy === "budget" ? "budget" : "decision_unavailable" });
      }
      await deps.db.batch(stmts);
      continue;
    }

    const state: Record<string, PairState> = {};
    const questions: Record<string, DecisionQuestion> = {};
    for (const x of batch) {
      state[x.key] = x.state;
      Object.assign(questions, buildPairQuestions(x.key, x.state));
    }

    let res: DecisionResult | null = null;
    try {
      calls++;
      res = await deps.decisions.decide({ purpose: LINK_PURPOSE, state, questions });
    } catch (e) {
      stoppedBy = e instanceof BudgetExceededError ? "budget" : "error";
      if (stoppedBy === "budget") calls--; // refused before any request was sent
    }

    if (!res) {
      for (const x of batch) {
        skipped[x.i] = stoppedBy ?? "error";
        await record(x, { res: null, answers: null, tier: null, outcome: "rejected", reason: stoppedBy === "budget" ? "budget" : "decision_unavailable" });
      }
      await deps.db.batch(stmts);
      continue;
    }

    model = res.model;
    provider = res.provider;
    for (const x of batch) {
      asked++;
      const answers: LinkAnswers = {
        shouldExist: res.answers[`${x.key}.should_exist`],
        sentence: res.answers[`${x.key}.sentence`],
        anchor: res.answers[`${x.key}.anchor`],
        role: res.answers[`${x.key}.role`],
      };
      const o = outcomeForPair(answers, x.p);
      outcomes[x.i] = o;
      if (o) answered++;
      await record(x, {
        res,
        answers,
        tier: o ? o.tier : "drop",
        outcome: o ? o.outcome : "rejected",
        reason: o ? o.reasonCode : "decision_unavailable",
      });
    }
    await deps.db.batch(stmts);
  }

  return { outcomes, skipped, decisionIds, calls, asked, answered, model, provider, stoppedBy, questionVersion: qVersion };
}
