/**
 * Pure helpers for the DataForSEO competitor data panel (CompetitorDataPanel.tsx). Every number shown is a
 * DataForSEO third-party estimate, never Search Console data; labels say so.
 */
import type {
  CompetitorDataPanel,
  CompetitorDomainSummary,
  CompetitorFetchSummary,
  CompetitorLocation,
  CompetitorRankBuckets,
} from "@shared/competitor-data";
import { formatDate, formatUsd } from "@web/lib/format";

export const ESTIMATE_NOTE =
  "Third-party estimates from DataForSEO Labs (modelled from Google results and keyword databases). Not Search Console data, and not measured on your site.";

export const GAP_NOTE =
  "Keywords this competitor ranks for in the top 100 where DataForSEO found no ranking for your domain. A starting list for review, not a measurement of demand you can win.";

export function locationLabel(loc: CompetitorLocation | null): string {
  return loc ? `${loc.locationName} · ${loc.languageName}` : "location not set";
}

/** "DataForSEO estimate · United States · English · fetched Oct 2, 2026 · cost $0.0366" */
export function provenanceLabel(snapshot: NonNullable<CompetitorDomainSummary["snapshot"]>): string {
  return [
    "DataForSEO estimate",
    locationLabel(snapshot.location),
    `fetched ${formatDate(snapshot.fetchedAt)}`,
    `cost ${snapshot.costUsd === null ? "unknown" : formatUsd(snapshot.costUsd)}`,
  ].join(" · ");
}

export interface BucketGroup {
  label: string;
  value: number;
}

/** Rank buckets grouped for display: #1, #2-3, #4-10, #11-20, #21-100. */
export function bucketGroups(b: CompetitorRankBuckets | null): BucketGroup[] {
  if (!b) return [];
  const rest = b.pos_21_30 + b.pos_31_40 + b.pos_41_50 + b.pos_51_60 + b.pos_61_70 + b.pos_71_80 + b.pos_81_90 + b.pos_91_100;
  return [
    { label: "#1", value: b.pos_1 },
    { label: "#2–3", value: b.pos_2_3 },
    { label: "#4–10", value: b.pos_4_10 },
    { label: "#11–20", value: b.pos_11_20 },
    { label: "#21–100", value: rest },
  ];
}

export const isActive = (f: CompetitorFetchSummary | null | undefined) => f?.status === "queued" || f?.status === "running";

/** Keep polling the panel while any refresh is queued or running. */
export function shouldPoll(panel: CompetitorDataPanel | null): boolean {
  return !!panel && panel.domains.some((d) => isActive(d.latestFetch));
}

/** "$0.0624" (4 decimals: per-refresh ceilings are a few cents). */
export const maxCostText = (usd: number) => `$${usd.toFixed(4)}`;

/** Cost disclosure shown next to "Refresh data" (published price ceiling; actual cost comes from DataForSEO). */
export function refreshCostNote(panel: CompetitorDataPanel): string {
  const p = panel.pricing;
  return `Each refresh runs 3 paid DataForSEO Labs requests: at most ${maxCostText(p.maxRefreshUsd)} at DataForSEO's published price ($${p.perTaskUsd} per request + $${p.perItemUsd} per returned row, read ${p.readOn}). The cost DataForSEO reports is recorded on the Usage page.`;
}

export interface RefreshState {
  disabled: boolean;
  reason: string | null;
}

/** Whether "Refresh data" can be pressed for a domain, and why not. */
export function refreshState(panel: CompetitorDataPanel, d: CompetitorDomainSummary): RefreshState {
  if (!panel.canManage) return { disabled: true, reason: "Only the workspace owner can refresh competitor data." };
  if (panel.state !== "ready") return { disabled: true, reason: panel.message };
  if (isActive(d.latestFetch)) return { disabled: true, reason: "A refresh is in progress." };
  if (d.refreshesToday >= panel.caps.refreshesPerDomainPerDay) {
    return { disabled: true, reason: `Daily limit reached (${panel.caps.refreshesPerDomainPerDay} refreshes per domain per UTC day).` };
  }
  if (panel.caps.fetchesToday >= panel.caps.fetchesPerProjectPerDay) {
    return { disabled: true, reason: `Project limit reached (${panel.caps.fetchesPerProjectPerDay} refreshes per UTC day).` };
  }
  return { disabled: false, reason: null };
}

export const FETCH_STATUS_LABEL: Record<CompetitorFetchSummary["status"], string> = {
  queued: "Queued",
  running: "Fetching…",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  setup_required: "Setup required",
};

/** Compact numbers for estimates ("16,249", "—" for unknown). */
export function estimate(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** "12 new domains wait for later days (10 per day)" — the auto-fetch backlog [A39]. */
export function waitingText(n: number, perDay: number): string {
  return `${n} new domain${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""} for later days (fetched automatically, at most ${perDay} refreshes per day)`;
}
