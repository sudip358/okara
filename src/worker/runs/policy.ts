/**
 * [A13] Jev decision policy: one versioned place for tiers and thresholds.
 * Starting thresholds are ENGINEERING DEFAULTS until fitted on the labelled evaluation set.
 * Noul has no confidence field; it is tiered by probability bands only.
 */
import type { Tier } from "@shared/types";
import type { DecisionAnswer, DecisionQuestion } from "../providers/types";
import { hashJson } from "../lib/hash";

export const POLICY_VERSION = "policy-2026-09-30.1";

export interface TierThresholds {
  /** Choice/Score confidence at or above which the answer is Act. */
  act: number;
  /** Choice/Score confidence at or above which the answer is Flag (below = Drop). */
  flag: number;
}

export interface NoulBands {
  /** noul >= yes => confident yes (act); noul <= no => confident no (act); between = flag or drop. */
  yes: number;
  no: number;
  middle: "flag" | "drop";
}

export const DEFAULT_THRESHOLDS: TierThresholds = { act: 0.8, flag: 0.45 };
export const DEFAULT_NOUL_BANDS: NoulBands = { yes: 0.8, no: 0.2, middle: "flag" };

/** Per-question overrides, keyed by question id. */
export const QUESTION_POLICY: Record<string, Partial<TierThresholds> & { noul?: Partial<NoulBands> }> = {
  "seo.page_overlap": { noul: { yes: 0.85, no: 0.2, middle: "drop" } },
  "evidence.injection_risk": { noul: { yes: 0.7, no: 0.3, middle: "flag" } },
};

export function tierFor(questionId: string, answer: DecisionAnswer | undefined): Tier {
  if (!answer) return "drop";
  const o = QUESTION_POLICY[questionId] ?? {};
  if (answer.type === "noul") {
    const b = { ...DEFAULT_NOUL_BANDS, ...(o.noul ?? {}) };
    if (!Number.isFinite(answer.noul)) return "drop";
    if (answer.noul >= b.yes || answer.noul <= b.no) return "act";
    return b.middle;
  }
  const t = { act: o.act ?? DEFAULT_THRESHOLDS.act, flag: o.flag ?? DEFAULT_THRESHOLDS.flag };
  const conf = answer.confidence;
  if (!Number.isFinite(conf)) return "drop";
  if (conf >= t.act) return "act";
  if (conf >= t.flag) return "flag";
  return "drop";
}

/** Runner-up option/level for Flag display. */
export function runnerUp(answer: DecisionAnswer | undefined): { label: string; probability: number } | null {
  if (!answer || answer.type === "noul") return null;
  const sorted = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
  const second = sorted[1];
  return second ? { label: second[0], probability: second[1] } : null;
}

/** Probability mass above and below the rubric midpoint, for Score decisiveness. */
export function scoreSide(answer: Extract<DecisionAnswer, { type: "score" }>, levels: number): { above: number; below: number } {
  const mid = (levels - 1) / 2;
  let above = 0;
  let below = 0;
  for (const [k, p] of Object.entries(answer.probabilities)) {
    const lvl = Number(k);
    if (lvl > mid) above += p;
    else if (lvl < mid) below += p;
  }
  return { above, below };
}

/** Normalize an answer to 0..1 for code-owned composite scoring. */
export function normalize(answer: DecisionAnswer, levels?: number): number {
  if (answer.type === "noul") return answer.noul;
  if (answer.type === "score") return levels && levels > 1 ? answer.score / (levels - 1) : answer.score;
  return answer.confidence;
}

/** question_version = hash of the exact question definition (text, options, levels). */
export function questionVersion(q: DecisionQuestion): Promise<string> {
  return hashJson(q).then((h) => h.slice(0, 16));
}
