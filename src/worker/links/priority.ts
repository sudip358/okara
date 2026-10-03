/**
 * Suggestion priority (internal-links workbench 2026-10-03, item 3). Code-owned arithmetic, versioned
 * (LINK_PRIORITY_VERSION); Jev never computes it. Inputs are stored measurements only: the candidate's topical
 * relevance, the target's and source's Search Console figures from the latest stored sync (current window, the
 * site's own impressions and clicks, never market search volume), and the source's inlinks in the link graph.
 *
 *   priority = relevance x impact x cluster
 *   relevance = the candidate's term-overlap score with its orphan / low-inlink boost (candidates.ts), without the
 *               older Search Console boost (impact replaces it)
 *   impact    = target x source, where
 *     target  = impressionFactor x positionFactor       (1 when the project has no Search Console data)
 *       impressionFactor = 1 + min(1, log10(1 + impressions) / 4)            (0 -> 1.00, 100 -> 1.50, 10,000 -> 2.00)
 *       positionFactor   = 1.50 for average position 8–20 (striking distance), 1.20 for 3–8, 1.05 for 1–3 (already
 *                          on top: lower boost), 1.10 beyond 20, 1 without a position
 *     source  = min(SOURCE_CAP, inlinkFactor x clickFactor)
 *       inlinkFactor = 1 + min(0.5, log10(1 + source inlinks in the graph) / 4)
 *       clickFactor  = 1 + min(0.4, log10(1 + source clicks) / 5)          (1 without Search Console data)
 *   cluster   = CLUSTER_GAP_BOOST when the link adds a missing hub -> spoke or spoke -> hub link, else 1
 * Rounded to 4 decimals. The numbers behind every priority are stored with the suggestion and shown in the UI.
 */
import type { GscPageMetric } from "./gsc";

export const LINK_PRIORITY_VERSION = "links-priority-2026-10-03.1";
export const CLUSTER_GAP_BOOST = 1.3;
export const SOURCE_CAP = 2;
export const STRIKING_DISTANCE = { min: 8, max: 20 } as const;

export type PositionBand = "top_3" | "near_top" | "striking_distance" | "beyond_20" | "none";

export interface PriorityInput {
  relevance: number;
  target: GscPageMetric | null;
  source: GscPageMetric | null;
  sourceInlinks: number;
  /** false = the project has no Search Console sync (impact factors stay neutral). */
  hasGsc: boolean;
  clusterGap: "hub_to_spoke" | "spoke_to_hub" | null;
}

export interface PriorityBreakdown {
  version: string;
  value: number;
  relevance: number;
  impact: number;
  targetFactor: number;
  impressionFactor: number;
  positionFactor: number;
  positionBand: PositionBand;
  sourceFactor: number;
  inlinkFactor: number;
  clickFactor: number;
  clusterFactor: number;
  target: { impressions: number | null; clicks: number | null; position: number | null; basis: GscPageMetric["basis"] | null };
  source: { inlinks: number; clicks: number | null };
  clusterGap: PriorityInput["clusterGap"];
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function positionBand(position: number | null | undefined): PositionBand {
  if (position === null || position === undefined || !Number.isFinite(position) || position <= 0) return "none";
  if (position <= 3) return "top_3";
  if (position < STRIKING_DISTANCE.min) return "near_top";
  if (position <= STRIKING_DISTANCE.max) return "striking_distance";
  return "beyond_20";
}

export const POSITION_FACTOR: Record<PositionBand, number> = { top_3: 1.05, near_top: 1.2, striking_distance: 1.5, beyond_20: 1.1, none: 1 };

export function computePriority(p: PriorityInput): PriorityBreakdown {
  const relevance = Math.max(0, Number.isFinite(p.relevance) ? p.relevance : 0);
  const imp = p.hasGsc ? (p.target?.impressions ?? 0) : null;
  const impressionFactor = imp !== null ? 1 + Math.min(1, Math.log10(1 + Math.max(0, imp)) / 4) : 1;
  const band = p.hasGsc && imp ? positionBand(p.target?.position) : "none";
  const positionFactor = POSITION_FACTOR[band];
  const targetFactor = impressionFactor * positionFactor;
  const inlinkFactor = 1 + Math.min(0.5, Math.log10(1 + Math.max(0, p.sourceInlinks)) / 4);
  const clicks = p.hasGsc ? (p.source?.clicks ?? 0) : null;
  const clickFactor = clicks !== null ? 1 + Math.min(0.4, Math.log10(1 + Math.max(0, clicks)) / 5) : 1;
  const sourceFactor = Math.min(SOURCE_CAP, inlinkFactor * clickFactor);
  const clusterFactor = p.clusterGap ? CLUSTER_GAP_BOOST : 1;
  const impact = targetFactor * sourceFactor;
  return {
    version: LINK_PRIORITY_VERSION,
    value: r4(relevance * impact * clusterFactor),
    relevance: r4(relevance),
    impact: r4(impact),
    targetFactor: r4(targetFactor),
    impressionFactor: r4(impressionFactor),
    positionFactor,
    positionBand: band,
    sourceFactor: r4(sourceFactor),
    inlinkFactor: r4(inlinkFactor),
    clickFactor: r4(clickFactor),
    clusterFactor,
    target: {
      impressions: p.hasGsc ? (p.target?.impressions ?? 0) : null,
      clicks: p.hasGsc ? (p.target?.clicks ?? 0) : null,
      position: p.hasGsc ? (p.target?.position ?? null) : null,
      basis: p.target?.basis ?? null,
    },
    source: { inlinks: p.sourceInlinks, clicks },
    clusterGap: p.clusterGap,
  };
}

const POSITION_TEXT: Record<PositionBand, string> = {
  top_3: "positions 1–3, lower boost",
  near_top: "positions 3–8",
  striking_distance: "striking distance 8–20",
  beyond_20: "beyond position 20",
  none: "no position",
};

/** Plain-text lines explaining a priority (shown on each suggestion). */
export function explainPriority(b: PriorityBreakdown, gscLabel: string | null): string[] {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const lines = [`Priority ${b.value.toFixed(2)} = relevance ${b.relevance.toFixed(2)} × impact ${b.impact.toFixed(2)}${b.clusterFactor !== 1 ? ` × cluster gap ${b.clusterFactor}` : ""} (formula ${b.version}).`];
  if (b.target.impressions === null) lines.push("Target impact: no Search Console data (neutral ×1).");
  else
    lines.push(
      `Target: ${fmt(b.target.impressions)} impressions, ${fmt(b.target.clicks ?? 0)} clicks${b.target.position !== null ? `, average position ${b.target.position.toFixed(1)}` : ""} (${POSITION_TEXT[b.positionBand]}; ×${b.impressionFactor.toFixed(2)} impressions, ×${b.positionFactor} position)${b.target.basis === "query_page_rows" ? "; summed from query rows (lower bound)" : ""}.`,
    );
  lines.push(`Source: ${fmt(b.source.inlinks)} inlinks in the link graph${b.source.clicks !== null ? `, ${fmt(b.source.clicks)} clicks` : ""} (×${b.sourceFactor.toFixed(2)}).`);
  if (gscLabel) lines.push(`Search Console figures: ${gscLabel}. These are your Search Console impressions, not search volume.`);
  return lines;
}
