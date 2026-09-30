/**
 * SEO priority formula (versioned; code-owned — Jev never does arithmetic). Stored on every
 * recommendation with PRIORITY_VERSION so a weight change can be re-scored from stored raw inputs.
 *
 *   metric   = sqrt(max(impressionShare, clickShare))           in [0,1], null if no GSC metrics
 *              impressionShare = candidate impressions / property impressions (current window)
 *              clickShare      = candidate clicks / property clicks
 *              (sqrt keeps small-but-real shares visible: 1% -> 0.10, 25% -> 0.50)
 *   severity = normalized severity in [0,1] (finding severity or seo.issue_severity score / 4), null for content
 *   reach    = affected URLs / crawled URLs in [0,1], null when not applicable
 *
 *   base     = weighted mean of the available components (weights W below renormalized over the
 *              non-null ones; a missing component is dropped, never replaced by a default)
 *   priority = 100 * base * effortFactor[effort] * tierMultiplier[tier]
 *
 *   effortFactor:    low 1.0 | medium 0.85 | high 0.7
 *   tierMultiplier:  act 1.0 | flag 0.7 | n/a (deterministic-only, no Jev question asked) 1.0
 *                    drop -> null: excluded from Jev-dependent ranking
 *
 * With equal severity, reach makes a site-wide issue outrank a single-page one [A16]; a critical
 * finding outranks a cosmetic one through the severity term.
 *
 * Inputs are the project's own measurements only. The checklist's external "SEO tactics" reference
 * tier (S-D) [A21] never enters this formula, and no projected traffic or ranking value does [A11].
 */
import type { Level, Severity, Tier } from "@shared/types";

export const PRIORITY_VERSION = "seo-priority-2026-09-30.1";

export const PRIORITY_WEIGHTS = { metric: 0.45, severity: 0.35, reach: 0.2 } as const;
export const EFFORT_FACTOR: Record<Level, number> = { low: 1.0, medium: 0.85, high: 0.7 };
export const TIER_MULTIPLIER: Record<Exclude<Tier, "drop">, number> = { act: 1.0, flag: 0.7, "n/a": 1.0 };
export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 1.0, major: 0.75, moderate: 0.5, minor: 0.25, advisory: 0.1 };

export interface PriorityInputs {
  impressions: number | null;
  clicks: number | null;
  /** Property totals for the same window (denominators). */
  totalImpressions: number | null;
  totalClicks: number | null;
  /** 0..1 */
  severity: number | null;
  /** 0..1 */
  reach: number | null;
  effort: Level;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function metricSignal(i: Pick<PriorityInputs, "impressions" | "clicks" | "totalImpressions" | "totalClicks">): number | null {
  const shares: number[] = [];
  if (i.impressions !== null && i.totalImpressions !== null && i.totalImpressions > 0) shares.push(clamp01(i.impressions / i.totalImpressions));
  if (i.clicks !== null && i.totalClicks !== null && i.totalClicks > 0) shares.push(clamp01(i.clicks / i.totalClicks));
  if (shares.length === 0) return null;
  return Math.sqrt(Math.max(...shares));
}

/** Score 0-4 (seo.issue_severity levels) -> 0..1. */
export const severityFromScore = (score: number, levels = 5) => clamp01(score / (levels - 1));

export interface PriorityBreakdown {
  priority: number | null;
  metric: number | null;
  severity: number | null;
  reach: number | null;
  base: number;
  effortFactor: number;
  tierMultiplier: number | null;
  version: string;
}

export function priorityBreakdown(i: PriorityInputs, tier: Tier | null): PriorityBreakdown {
  const metric = metricSignal(i);
  const severity = i.severity === null ? null : clamp01(i.severity);
  const reach = i.reach === null ? null : clamp01(i.reach);
  const parts: Array<[number, number]> = [];
  if (metric !== null) parts.push([metric, PRIORITY_WEIGHTS.metric]);
  if (severity !== null) parts.push([severity, PRIORITY_WEIGHTS.severity]);
  if (reach !== null) parts.push([reach, PRIORITY_WEIGHTS.reach]);
  const wsum = parts.reduce((s, [, w]) => s + w, 0);
  const base = wsum > 0 ? parts.reduce((s, [v, w]) => s + v * w, 0) / wsum : 0;
  const effortFactor = EFFORT_FACTOR[i.effort];
  const t = tier ?? "n/a";
  const tierMultiplier = t === "drop" ? null : TIER_MULTIPLIER[t];
  const priority = tierMultiplier === null ? null : Math.round(100 * base * effortFactor * tierMultiplier * 100) / 100;
  return { priority, metric, severity, reach, base, effortFactor, tierMultiplier, version: PRIORITY_VERSION };
}

/** Priority in [0,100], or null when the decision tier is drop (excluded). Pure. */
export function computePriority(i: PriorityInputs, tier: Tier | null): number | null {
  return priorityBreakdown(i, tier).priority;
}
