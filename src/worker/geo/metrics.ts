/**
 * GEO visibility metrics. Pure functions; versioned. Definitions (docs/build-kit.md, GEO AGENT):
 *
 * - Mention rate  = successful valid responses mentioning the brand / successful valid responses.
 *                   "Successful valid" = status 'ok'. Failed and incomplete responses are excluded from
 *                   the denominator (never counted as absences) and reported as separate counts.
 * - Citation rate = successful grounded responses citing the brand's verified domain / successful
 *                   grounded responses. Ungrounded responses are excluded; citation detection is by
 *                   parsed hostname (see detect.ts), never text substring.
 * - Tracked-brand share of voice = binary response-level mention count for a brand / sum of those
 *                   counts over all configured brands (self + competitors) in the same sample.
 *                   Restricted to tracked brands; not market share.
 * - Every metric is a Ratio {numerator, denominator, value}; denominator 0 => value null (unavailable,
 *   not zero).
 * - Only observations with the same cohort_key (prompt-set version + provider + model + grounding
 *   config) are aggregated into one rate or compared over time. Mixing cohorts throws.
 * - Default visibility metrics use API measurements of DISCOVERY prompts only. Reputation prompts are
 *   reported separately (promptType: 'reputation'); manual imports are never part of API metrics.
 * - smallSampleWarning when the denominator is below SMALL_SAMPLE_MIN.
 */
import type { Ratio } from "@shared/types";

export const METRICS_VERSION = "geo-metrics-2026-09-30.1";
export const SMALL_SAMPLE_MIN = 10;

export interface MetricBrand {
  brandKey: string;
  isSelf: boolean;
  mentioned: boolean;
  cited: boolean;
}

export interface MetricObservation {
  id: string;
  cohortKey: string;
  provider: string;
  promptId: string | null;
  promptType: "discovery" | "reputation";
  measurementType: "api" | "manual_import";
  status: "ok" | "failed" | "incomplete";
  grounded: boolean;
  runId: string | null;
  createdAt: string;
  brands: MetricBrand[];
}

export interface MetricFilter {
  promptType?: "discovery" | "reputation";
  measurementType?: "api" | "manual_import";
}

export class CrossCohortError extends Error {
  constructor(public readonly cohortKeys: string[]) {
    super(`Metrics cannot mix cohorts: ${cohortKeys.join(", ")}`);
  }
}

export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator > 0 ? numerator / denominator : null };
}

export function smallSampleWarning(r: Ratio, min = SMALL_SAMPLE_MIN): boolean {
  return r.denominator < min;
}

/** Apply the default sample filter: API measurements of discovery prompts unless overridden. */
export function sample(obs: MetricObservation[], f: MetricFilter = {}): MetricObservation[] {
  const promptType = f.promptType ?? "discovery";
  const measurementType = f.measurementType ?? "api";
  return obs.filter((o) => o.promptType === promptType && o.measurementType === measurementType);
}

export function assertSingleCohort(obs: MetricObservation[]): void {
  const keys = [...new Set(obs.map((o) => o.cohortKey))];
  if (keys.length > 1) throw new CrossCohortError(keys);
}

function brandOf(o: MetricObservation, brandKey: string): MetricBrand | undefined {
  return o.brands.find((b) => b.brandKey === brandKey);
}

/** Mention rate for one brand (default 'self') within ONE cohort. */
export function mentionRate(obs: MetricObservation[], brandKey = "self", f: MetricFilter = {}): Ratio {
  const s = sample(obs, f);
  assertSingleCohort(s);
  const valid = s.filter((o) => o.status === "ok");
  return ratio(valid.filter((o) => brandOf(o, brandKey)?.mentioned === true).length, valid.length);
}

/** Citation rate for one brand (default 'self') within ONE cohort; grounded responses only. */
export function citationRate(obs: MetricObservation[], brandKey = "self", f: MetricFilter = {}): Ratio {
  const s = sample(obs, f);
  assertSingleCohort(s);
  const grounded = s.filter((o) => o.status === "ok" && o.grounded);
  return ratio(grounded.filter((o) => brandOf(o, brandKey)?.cited === true).length, grounded.length);
}

/**
 * Tracked-brand share of voice over one sample. `brandKeys` is every configured brand (self first);
 * brands never mentioned still appear with numerator 0. Denominator 0 => every value null.
 */
export function shareOfVoice(obs: MetricObservation[], brandKeys: string[], f: MetricFilter = {}): Array<{ brandKey: string; ratio: Ratio }> {
  const valid = sample(obs, f).filter((o) => o.status === "ok");
  const counts = brandKeys.map((k) => valid.filter((o) => brandOf(o, k)?.mentioned === true).length);
  const total = counts.reduce((a, b) => a + b, 0);
  return brandKeys.map((k, i) => ({ brandKey: k, ratio: ratio(counts[i]!, total) }));
}

export interface LaneCounts {
  valid: number;
  grounded: number;
  failed: number;
  incomplete: number;
}

export function laneCounts(obs: MetricObservation[]): LaneCounts {
  return {
    valid: obs.filter((o) => o.status === "ok").length,
    grounded: obs.filter((o) => o.status === "ok" && o.grounded).length,
    failed: obs.filter((o) => o.status === "failed").length,
    incomplete: obs.filter((o) => o.status === "incomplete").length,
  };
}

export interface TrendPoint {
  cohortKey: string;
  provider: string;
  runKey: string;
  runAt: string;
  mentionRate: Ratio;
  citationRate: Ratio;
  annotation: string | null;
}

/**
 * One point per (cohort, run) for the default sample, oldest first. When a provider's cohort changes
 * between consecutive points, the first point of the new cohort carries an annotation and no
 * comparison with earlier points is implied (a new series starts).
 */
export function buildTrend(obs: MetricObservation[], brandKey = "self", f: MetricFilter = {}): TrendPoint[] {
  const s = sample(obs, f);
  const groups = new Map<string, MetricObservation[]>();
  for (const o of s) {
    const runKey = o.runId ?? o.createdAt.slice(0, 10);
    const k = `${o.cohortKey}\u0000${runKey}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(o);
  }
  const points: TrendPoint[] = [...groups.values()].map((g) => {
    const first = g[0]!;
    return {
      cohortKey: first.cohortKey,
      provider: first.provider,
      runKey: first.runId ?? first.createdAt.slice(0, 10),
      runAt: g.map((o) => o.createdAt).sort()[0]!,
      mentionRate: mentionRate(g, brandKey, f),
      citationRate: citationRate(g, brandKey, f),
      annotation: null,
    };
  });
  points.sort((a, b) => (a.runAt < b.runAt ? -1 : a.runAt > b.runAt ? 1 : a.cohortKey.localeCompare(b.cohortKey)));
  const lastCohortByProvider = new Map<string, string>();
  for (const p of points) {
    const prev = lastCohortByProvider.get(p.provider);
    if (prev !== undefined && prev !== p.cohortKey) {
      p.annotation = `Configuration changed for ${p.provider} (prompt set, model, or grounding): new series started; not compared with earlier points.`;
    }
    lastCohortByProvider.set(p.provider, p.cohortKey);
  }
  return points;
}

/**
 * Difference between two rates, only when both belong to the same cohort and both are available.
 * Returns null otherwise (no cross-cohort or unavailable comparisons).
 */
export function compareRates(a: { cohortKey: string; ratio: Ratio }, b: { cohortKey: string; ratio: Ratio }): number | null {
  if (a.cohortKey !== b.cohortKey) return null;
  if (a.ratio.value === null || b.ratio.value === null) return null;
  return b.ratio.value - a.ratio.value;
}
