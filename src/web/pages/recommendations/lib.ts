/**
 * Pure helpers for recommendation pages. No projections, no invented fields:
 * decision values are displayed under the provider's actual field names.
 */
import type {
  DecisionRecord,
  EvidenceSource,
  RecommendationStage,
  RecommendationStatus,
  Tier,
} from "@shared/types";

export const STAGES: Array<{ key: RecommendationStage; label: string }> = [
  { key: "collected", label: "Collected" },
  { key: "judged", label: "Judged" },
  { key: "drafted", label: "Drafted" },
  { key: "awaiting_approval", label: "Awaiting approval" },
  { key: "marked_implemented", label: "Marked implemented" },
];

export const STATUSES: RecommendationStatus[] = ["open", "approved", "dismissed", "implemented"];

export const STATUS_LABEL: Record<RecommendationStatus, string> = {
  open: "Open",
  approved: "Approved",
  dismissed: "Dismissed",
  implemented: "Implemented",
};

export const SOURCE_LABEL: Record<EvidenceSource, string> = {
  gsc: "GSC",
  crawl: "Crawl",
  context_doc: "Context doc",
  geo_observation: "GEO observation",
  manual_import: "Manual import",
  rule: "Rule",
};

export function sourceLabel(s: string): string {
  return (SOURCE_LABEL as Record<string, string>)[s] ?? s;
}

export const TIER_LABEL: Record<Tier, string> = {
  act: "Act",
  flag: "Flag",
  drop: "Drop",
  "n/a": "No judgment",
};

/** Format a number as it came from the provider (no rounding beyond 2 decimals, no % conversion). */
export function formatFieldValue(v: number | string): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "—";
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return v;
}

/**
 * Decision fields displayed with their real names ("confidence 0.83", "noul 0.91").
 * Returns [] when there are no fields; callers must not substitute a made-up value.
 */
export function decisionFieldPairs(fields: Record<string, number | string> | null | undefined): Array<{ name: string; value: string }> {
  if (!fields) return [];
  return Object.entries(fields).map(([name, value]) => ({ name, value: formatFieldValue(value) }));
}

type AnyAnswer = Record<string, unknown>;

function isRecord(x: unknown): x is AnyAnswer {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Summarize a stored decision answer in plain text, using only fields present in it. */
export function answerSummary(answer: unknown): string {
  if (answer === null || answer === undefined) return "No answer stored";
  if (!isRecord(answer)) return String(answer);
  const parts: string[] = [];
  if ("choice" in answer && answer.choice !== undefined) parts.push(`choice ${String(answer.choice)}`);
  if ("score" in answer && typeof answer.score === "number") parts.push(`score ${formatFieldValue(answer.score)}`);
  if ("confidence" in answer && typeof answer.confidence === "number") parts.push(`confidence ${formatFieldValue(answer.confidence)}`);
  if ("noul" in answer && typeof answer.noul === "number") parts.push(`noul ${formatFieldValue(answer.noul)}`);
  if (parts.length === 0) {
    try {
      const s = JSON.stringify(answer);
      return s.length > 160 ? `${s.slice(0, 157)}…` : s;
    } catch {
      return "Unreadable answer";
    }
  }
  return parts.join(" · ");
}

/** Runner-up option/level from the answer's probabilities (Choice/Score only). Noul has none. */
export function runnerUpFromAnswer(answer: unknown): { label: string; probability: number } | null {
  if (!isRecord(answer) || !isRecord(answer.probabilities)) return null;
  const entries = Object.entries(answer.probabilities).filter((e): e is [string, number] => typeof e[1] === "number");
  if (entries.length < 2) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const second = entries[1];
  return second ? { label: second[0], probability: second[1] } : null;
}

/** For a Drop tier no provider value is shown ([A13]). */
export function showsJevValue(d: Pick<DecisionRecord, "tier">): boolean {
  return d.tier !== "drop";
}

export function humanize(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
