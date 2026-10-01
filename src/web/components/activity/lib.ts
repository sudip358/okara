/**
 * Pure helpers for the run Activity window. Everything shown is derived from the stored rows the API
 * returns (RunActivity); nothing here simulates progress, projects totals, or computes rates.
 * OWNED BY: web-activity.
 */
import type { ActivityItem, ActivityItemKind, ActivityLane, RunActivity } from "@shared/types";
import { engineName } from "@web/pages/geo/board/lib";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "demo";

/** Polling cadences (ms). */
export const POLL = {
  /** GET /activity/current while no run is active (tab visible only). */
  currentIdle: 10_000,
  /** GET /activity/current while a run is active. */
  currentActive: 3_000,
  /** GET /runs/:id/activity?after= while the shown run is active. */
  feed: 2_000,
} as const;

/** Page size requested from the activity endpoint (contract max 200). */
export const PAGE_LIMIT = 200;
/** Max catch-up pages fetched back-to-back in one poll. */
export const MAX_CATCHUP_PAGES = 5;
/** Items kept client-side (newest win). */
export const MAX_ITEMS = 400;
/** Max length of plain text rendered from a stored row (server already clips to 160). */
export const MAX_TEXT = 160;

export const LABELS = {
  live: "Live from this run's stored events",
  replay: "Last run",
  apiSampled: "API-sampled",
  apiSampledTip: "Answers from the provider's API with web search; consumer apps may answer differently.",
} as const;

export function runIsActive(status: string | null | undefined): boolean {
  return status === "pending" || status === "running";
}

/** Clip untrusted text for plain-text rendering. */
export function clip(s: string | null | undefined, max = MAX_TEXT): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function cmpItem(a: ActivityItem, b: ActivityItem): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merge a newer page into the kept items: dedupe by id (newer copy wins), keep ascending (at, id),
 * and cap at `max` (dropping the oldest).
 */
export function mergeItems(prev: ActivityItem[], next: ActivityItem[], max = MAX_ITEMS): ActivityItem[] {
  if (next.length === 0) return prev.length > max ? prev.slice(prev.length - max) : prev;
  const byId = new Map<string, ActivityItem>();
  for (const it of prev) byId.set(it.id, it);
  for (const it of next) byId.set(it.id, it);
  const out = Array.from(byId.values()).sort(cmpItem);
  return out.length > max ? out.slice(out.length - max) : out;
}

/** Newest first, for the feed. */
export function newestFirst(items: ActivityItem[]): ActivityItem[] {
  return items.slice().sort((a, b) => -cmpItem(a, b));
}

/** "7m 12s", "45s", "1h 03m"; "—" when unknown. */
export function formatElapsed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Elapsed time for the header: ticks from startedAt while active; the stored duration once finished.
 * Returns null when the run has not started.
 */
export function elapsedMs(run: RunActivity["run"], active: boolean, now: number): number | null {
  if (!active) {
    if (run.elapsedMs !== null) return run.elapsedMs;
    if (run.startedAt && run.finishedAt) return Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt));
    return null;
  }
  if (!run.startedAt) return null;
  const start = Date.parse(run.startedAt);
  return Number.isFinite(start) ? Math.max(0, now - start) : null;
}

export function formatLatency(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
}

/** "$0.0123", "~$0.12 est.", "Unknown" (null is never shown as $0). */
export function formatCost(usd: number | null | undefined, isEstimate: boolean): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "Unknown";
  const digits = usd !== 0 && Math.abs(usd) < 0.01 ? 4 : usd < 1 ? 3 : 2;
  const s = `$${usd.toFixed(digits)}`;
  return isEstimate ? `~${s} est.` : s;
}

/** Spend line with honesty labels: value + basis note (Estimate / N calls unknown). */
export function spendText(spend: RunActivity["totals"]["spend"]): { value: string; note: string | null } {
  const notes: string[] = [];
  if (spend.usd !== null && spend.isEstimate) notes.push("Estimate");
  if (spend.unknownCalls > 0) notes.push(`${spend.unknownCalls.toLocaleString()} call${spend.unknownCalls === 1 ? "" : "s"} with unknown cost`);
  return {
    value: spend.usd === null ? "Unknown" : formatCost(spend.usd, false),
    note: notes.length ? notes.join(" · ") : null,
  };
}

/** "12 of 50" or "12" when the plan is unknown. */
export function ofText(done: number, planned: number | null | undefined): string {
  return planned === null || planned === undefined ? done.toLocaleString() : `${done.toLocaleString()} of ${planned.toLocaleString()}`;
}

export function pagesText(t: RunActivity["totals"]): string {
  return `${ofText(t.pagesRead, t.pagesPlanned)} page${t.pagesPlanned === null && t.pagesRead === 1 ? "" : "s"} read`;
}

export function answersText(a: RunActivity["totals"]["answers"]): string {
  return `${a.cited.toLocaleString()} cited · ${a.named.toLocaleString()} named · ${a.missing.toLocaleString()} missing · ${a.failed.toLocaleString()} failed`;
}

export function decisionsText(d: RunActivity["totals"]["decisions"]): string {
  return `${d.act.toLocaleString()} act · ${d.flag.toLocaleString()} flag · ${d.drop.toLocaleString()} drop`;
}

export const LANE_STATE: Record<ActivityLane["state"], { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  asking: { label: "Asking…", tone: "info" },
  done: { label: "Done", tone: "success" },
  idle: { label: "Idle", tone: "neutral" },
};

export function laneStateLabel(state: ActivityLane["state"]): string {
  return LANE_STATE[state]?.label ?? state;
}

export const OUTCOME: Record<NonNullable<ActivityItem["outcome"]>, { label: string; tone: Tone }> = {
  cited: { label: "Cited", tone: "success" },
  named: { label: "Named", tone: "info" },
  missing: { label: "Missing", tone: "danger" },
  failed: { label: "Failed", tone: "warning" },
  act: { label: "Act", tone: "success" },
  flag: { label: "Flag", tone: "warning" },
  drop: { label: "Drop", tone: "neutral" },
};

export function outcomeChip(outcome: ActivityItem["outcome"]): { label: string; tone: Tone } | null {
  return outcome ? (OUTCOME[outcome] ?? { label: outcome, tone: "neutral" }) : null;
}

/** Short text badge per item kind (no icons/emoji). */
export const KIND_BADGE: Record<ActivityItemKind, { letters: string; label: string }> = {
  step: { letters: "ST", label: "Run step" },
  page_read: { letters: "PG", label: "Page read" },
  engine_answer: { letters: "AI", label: "Engine answer" },
  jev_decision: { letters: "JV", label: "Jev decision" },
  provider_call: { letters: "PC", label: "Provider call" },
};

export function kindBadge(kind: ActivityItemKind): { letters: string; label: string } {
  return KIND_BADGE[kind] ?? { letters: "··", label: kind };
}

export const RUN_STATUS_TONE: Record<string, Tone> = {
  pending: "neutral",
  running: "info",
  completed: "success",
  partial: "warning",
  failed: "danger",
  rate_limited: "warning",
  cancelled: "neutral",
  setup_required: "warning",
};

export function runStatusChip(status: string): { label: string; tone: Tone } {
  const label = status === "running" ? "Running" : status.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  return { label, tone: RUN_STATUS_TONE[status] ?? "neutral" };
}

export function triggerLabel(trigger: string): string {
  if (trigger === "manual") return "Manual";
  if (trigger === "schedule") return "Scheduled";
  if (trigger === "demo") return "Demo";
  return trigger;
}

export function providerLabel(provider: string | null): string | null {
  if (!provider) return null;
  if (provider === "crawler") return "Crawler";
  if (provider === "writer") return "Writer";
  if (provider === "typesafe") return "Jev";
  return engineName(provider);
}

export function finishedText(run: RunActivity["run"], ms: number | null): string {
  const chip = runStatusChip(run.status);
  const verb = run.status === "completed" ? "Run finished" : `Run ended (${chip.label.toLowerCase()})`;
  return ms === null ? verb : `${verb} in ${formatElapsed(ms)}`;
}

/**
 * Screen-reader announcement for newly arrived items (throttled by the caller). One summary sentence,
 * never the untrusted titles in bulk.
 */
export function announcement(newItems: ActivityItem[]): string {
  if (newItems.length === 0) return "";
  if (newItems.length === 1) return `New activity: ${clip(newItems[0]!.title, 120)}`;
  return `${newItems.length} new activity items`;
}

/** Which run the window should show: an explicitly requested one, else the first active, else the latest finished. */
export function pickRunId(runs: Array<{ id: string; status: string }>, requested: string | null): string | null {
  if (requested) return requested;
  return (runs.find((r) => runIsActive(r.status)) ?? runs[0])?.id ?? null;
}

export function activityPath(projectId: string, runId: string, after: string | null, limit = PAGE_LIMIT): string {
  const q = new URLSearchParams();
  if (after) q.set("after", after);
  q.set("limit", String(limit));
  return `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/activity?${q.toString()}`;
}

export function currentPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/activity/current`;
}
