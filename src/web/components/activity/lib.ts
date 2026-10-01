/**
 * Pure helpers for the run Activity window. Everything shown is derived from the stored rows the API
 * returns (RunActivity); nothing here simulates progress, projects totals, or computes rates.
 * OWNED BY: web-activity.
 */
import type {
  ActivityItem,
  ActivityItemKind,
  ActivityLane,
  RunActivity,
} from "@shared/types";
import {
  engineGlyph,
  engineName,
  engineVendor,
} from "@web/pages/geo/board/lib";

export type Tone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "demo";

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
/** Max pages fetched back-to-back in one tick; if the last is still full, the next tick runs immediately. */
export const MAX_CATCHUP_PAGES = 50;
/** Items kept client-side (newest win). */
export const MAX_ITEMS = 400;
/** Max length of plain text rendered from a stored row (server already clips to 160). */
export const MAX_TEXT = 160;

export const LABELS = {
  live: "Live from this run's stored events",
  replayFeed: "Replay of this run's stored events",
  liveTitle: "Live activity",
  replay: "Last run",
  loadingEarlier: "Loading earlier events…",
  gone: "This run is no longer available.",
  reconnecting: "Reconnecting… the feed shows the last stored events received.",
  apiSampled: "API-sampled",
  apiSampledTip:
    "Answers from the provider's API with web search; consumer apps may answer differently.",
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
export function mergeItems(
  prev: ActivityItem[],
  next: ActivityItem[],
  max = MAX_ITEMS,
): ActivityItem[] {
  if (next.length === 0)
    return prev.length > max ? prev.slice(prev.length - max) : prev;
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
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0)
    return "—";
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
export function elapsedMs(
  run: RunActivity["run"],
  active: boolean,
  now: number,
): number | null {
  if (!active) {
    if (run.elapsedMs !== null) return run.elapsedMs;
    if (run.startedAt && run.finishedAt)
      return Math.max(
        0,
        Date.parse(run.finishedAt) - Date.parse(run.startedAt),
      );
    return null;
  }
  if (!run.startedAt) return null;
  const start = Date.parse(run.startedAt);
  return Number.isFinite(start) ? Math.max(0, now - start) : null;
}

/** Big clock for the header: "06:42", "1:03:12"; "--:--" when unknown. */
export function formatClock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0)
    return "--:--";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatLatency(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0)
    return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
}

/** "$0.0123", "~$0.12 est.", "Unknown" (null is never shown as $0). */
export function formatCost(
  usd: number | null | undefined,
  isEstimate: boolean,
): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd))
    return "Unknown";
  const digits = usd !== 0 && Math.abs(usd) < 0.01 ? 4 : usd < 1 ? 3 : 2;
  const s = `$${usd.toFixed(digits)}`;
  return isEstimate ? `~${s} est.` : s;
}

/** Spend line with honesty labels: value + basis note (Estimate / N calls unknown). */
export function spendText(spend: RunActivity["totals"]["spend"]): {
  value: string;
  note: string | null;
} {
  const notes: string[] = [];
  if (spend.usd !== null && spend.isEstimate) notes.push("Estimate");
  if (spend.unknownCalls > 0)
    notes.push(
      `${spend.unknownCalls.toLocaleString()} call${spend.unknownCalls === 1 ? "" : "s"} with unknown cost`,
    );
  return {
    value: spend.usd === null ? "Unknown" : formatCost(spend.usd, false),
    note: notes.length ? notes.join(" · ") : null,
  };
}

/** "12 of 50" or "12" when the plan is unknown. */
export function ofText(
  done: number,
  planned: number | null | undefined,
): string {
  return planned === null || planned === undefined
    ? done.toLocaleString()
    : `${done.toLocaleString()} of ${planned.toLocaleString()}`;
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

export const LANE_STATE: Record<
  ActivityLane["state"],
  { label: string; tone: Tone }
> = {
  queued: { label: "Queued", tone: "neutral" },
  asking: { label: "Asking & reading", tone: "info" },
  done: { label: "Done", tone: "success" },
  idle: { label: "Idle", tone: "neutral" },
};

export function laneStateLabel(state: ActivityLane["state"]): string {
  return LANE_STATE[state]?.label ?? state;
}

export const OUTCOME: Record<
  NonNullable<ActivityItem["outcome"]>,
  { label: string; tone: Tone }
> = {
  cited: { label: "Cited", tone: "success" },
  named: { label: "Named", tone: "warning" },
  missing: { label: "Missing", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
  act: { label: "Act", tone: "success" },
  flag: { label: "Flag", tone: "warning" },
  drop: { label: "Drop", tone: "neutral" },
};

export function outcomeChip(
  outcome: ActivityItem["outcome"],
): { label: string; tone: Tone } | null {
  return outcome
    ? (OUTCOME[outcome] ?? { label: outcome, tone: "neutral" })
    : null;
}

/** Chip for a feed card: the stored outcome, else "Read" for page reads, "Failed" for errored rows. */
export function itemChip(
  item: ActivityItem,
): { label: string; tone: Tone } | null {
  const c = outcomeChip(item.outcome);
  if (c) return c;
  if (item.kind === "page_read")
    return item.status === "error"
      ? { label: "Failed", tone: "danger" }
      : { label: "Read", tone: "info" };
  if (item.kind === "engine_answer")
    return { label: "Stored", tone: "neutral" };
  if (item.status === "error") return { label: "Failed", tone: "danger" };
  return null;
}

/** Vendor glyph letter + vendor name for an engine lane. */
export function laneMeta(provider: string): { glyph: string; vendor: string } {
  return { glyph: engineGlyph(provider), vendor: engineVendor(provider) };
}

/** Lane progress 0..1 from stored done/planned; null when the plan is unknown. */
export function laneProgress(
  lane: Pick<ActivityLane, "done" | "planned">,
): number | null {
  if (lane.planned === null || lane.planned === undefined || lane.planned <= 0)
    return null;
  return Math.max(0, Math.min(1, lane.done / lane.planned));
}

const CALL_STATUS = new Set([
  "ok",
  "error",
  "unknown",
  "failed",
  "timeout",
  "rate_limited",
]);

/** Model of the newest stored provider call for `provider` (server detail "<status> · <model> …"), else null. */
export function laneModel(
  items: ActivityItem[],
  provider: string,
): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind !== "provider_call" || it.provider !== provider || !it.detail)
      continue;
    const parts = it.detail.split(" · ");
    if (parts.length >= 2 && CALL_STATUS.has(parts[0]!) && parts[1])
      return clip(parts[1], 40);
  }
  return null;
}

/**
 * Most frequent host engines cited instead of you, among the loaded engine answers (from the server's
 * "cited instead: <host>" detail). Null when none. Counts are over loaded items only and say so.
 */
export function topCitedInstead(
  items: ActivityItem[],
): { host: string; count: number; of: number } | null {
  const counts = new Map<string, number>();
  let of = 0;
  for (const it of items) {
    if (
      it.kind !== "engine_answer" ||
      (it.outcome !== "missing" && it.outcome !== "named")
    )
      continue;
    of++;
    const m = /cited instead: ([^\s;·]+)\s*$/.exec(it.detail ?? "");
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  let best: { host: string; count: number } | null = null;
  for (const [host, count] of counts)
    if (
      !best ||
      count > best.count ||
      (count === best.count && host < best.host)
    )
      best = { host, count };
  return best ? { host: clip(best.host, 60), count: best.count, of } : null;
}

/** Newest-first engine answers for one lane (for the expanded strip). */
export function laneAnswers(
  items: ActivityItem[],
  provider: string,
  max = 12,
): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < max; i--) {
    const it = items[i]!;
    if (it.kind === "engine_answer" && it.provider === provider) out.push(it);
  }
  return out;
}

/** "Last page read · host" label pieces for nowReading. */
export function readingParts(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return {
      host: u.host,
      path: clip(`${u.host}${u.pathname}${u.search}`, 200),
    };
  } catch {
    return { host: "", path: clip(url, 200) };
  }
}

/** Short text badge per item kind (no icons/emoji). */
export const KIND_BADGE: Record<
  ActivityItemKind,
  { letters: string; label: string }
> = {
  step: { letters: "ST", label: "Run step" },
  page_read: { letters: "PG", label: "Page read" },
  engine_answer: { letters: "AI", label: "Engine answer" },
  jev_decision: { letters: "JV", label: "Jev decision" },
  provider_call: { letters: "PC", label: "Provider call" },
};

export function kindBadge(kind: ActivityItemKind): {
  letters: string;
  label: string;
} {
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
  const label =
    status === "running"
      ? "Running"
      : status.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
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

export function finishedText(
  run: RunActivity["run"],
  ms: number | null,
): string {
  const chip = runStatusChip(run.status);
  const verb =
    run.status === "completed"
      ? "Run finished"
      : `Run ended (${chip.label.toLowerCase()})`;
  return ms === null ? verb : `${verb} in ${formatElapsed(ms)}`;
}

/**
 * Screen-reader announcement for newly arrived items (throttled by the caller). One summary sentence,
 * never the untrusted titles in bulk.
 */
export function announcement(newItems: ActivityItem[]): string {
  if (newItems.length === 0) return "";
  if (newItems.length === 1)
    return `New activity: ${clip(newItems[0]!.title, 120)}`;
  return `${newItems.length} new activity items`;
}

export interface RunRef {
  id: string;
  status: string;
  /** Optional: when the API sends it, the replay picks the most recently finished run across agents. */
  finishedAt?: string | null;
  createdAt?: string | null;
}

/** Most recent run first: by finishedAt (else createdAt) when present, keeping API order otherwise. */
export function latestFinished<T extends RunRef>(runs: T[]): T | null {
  let best: T | null = null;
  let bestKey = "";
  for (const r of runs) {
    const key = r.finishedAt ?? r.createdAt ?? "";
    if (best === null || key > bestKey) {
      best = r;
      bestKey = key;
    }
  }
  return best;
}

/**
 * Which run the window should show: an explicitly requested (or pinned, already on screen) one, else the
 * first active, else the most recently finished.
 */
export function pickRunId(
  runs: RunRef[],
  requested: string | null,
): string | null {
  if (requested) return requested;
  return (
    (runs.find((r) => runIsActive(r.status)) ?? latestFinished(runs))?.id ??
    null
  );
}

export function isFinalError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return (
    typeof status === "number" &&
    (status === 404 || status === 403) &&
    e instanceof Error
  );
}

export interface CatchUpResult {
  last: RunActivity;
  /** Merged (ascending, capped) items from every page of this tick. */
  items: ActivityItem[];
  /** Cursor after the last page; the caller commits it only when this resolves. */
  cursor: string | null;
  /** The last page was still full: more stored events are waiting. */
  more: boolean;
  received: number;
}

/**
 * Pages GET /activity?after= from `cursor` until a page comes back short (or `maxPages`). Throws on any
 * page error without touching the caller's cursor, so nothing fetched before the error is skipped.
 * The cursor is opaque: it is only passed back.
 */
export async function catchUp(
  fetchPage: (after: string | null) => Promise<RunActivity>,
  cursor: string | null,
  maxPages = MAX_CATCHUP_PAGES,
  max = MAX_ITEMS,
): Promise<CatchUpResult> {
  let next = cursor;
  let items: ActivityItem[] = [];
  let received = 0;
  let pages = 0;
  let res: RunActivity;
  let full: boolean;
  do {
    const before = next;
    res = await fetchPage(next);
    if (res.cursor) next = res.cursor;
    items = mergeItems(items, res.items, max);
    received += res.items.length;
    pages++;
    // A full page whose cursor did not move would loop forever; treat it as exhausted.
    full =
      res.items.length >= PAGE_LIMIT && !!res.cursor && res.cursor !== before;
  } while (full && pages < maxPages);
  return { last: res, items, cursor: next, more: full, received };
}

/** Delay before the next feed tick: now while a backlog remains, 2s while active, none once finished. */
export function nextFeedDelay(more: boolean, active: boolean): number | null {
  if (more) return 0;
  return active ? POLL.feed : null;
}

export function activityPath(
  projectId: string,
  runId: string,
  after: string | null,
  limit = PAGE_LIMIT,
): string {
  const q = new URLSearchParams();
  if (after) q.set("after", after);
  q.set("limit", String(limit));
  return `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/activity?${q.toString()}`;
}

export function currentPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/activity/current`;
}
