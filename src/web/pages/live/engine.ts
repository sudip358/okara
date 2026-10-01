/**
 * Live view engine (docs/live-view-design.md sections 3, 8 and 9). Pure: no React, no DOM, no fetch, so
 * it is unit-tested in tests/live-web-engine.test.ts and used by both modes:
 *
 * - LIVE: every stored row received so far is revealed (playhead null). Motion happens only when a new
 *   stored row ARRIVES from a poll.
 * - REPLAY: the stored events of a finished run are played back in (at, id) order on a time-compressed
 *   clock. A row is revealed when the playhead reaches its stored time; rows not reached yet are the only
 *   "pending" rows (at most MAX_PENDING per panel).
 *
 * Nothing here invents data: counters are counts of revealed stored rows (or the server's whole-run
 * totals), tweens only interpolate between two RECEIVED values, and the clock never moves faster than the
 * chosen speed except to shorten idle gaps longer than IDLE_GAP_MS (which the replay label discloses).
 */
import type {
  ActivityItem,
  CostUsd,
  LiveGeoAnswerRow,
  LiveGeoLaneTotals,
  LiveRecommendationRow,
  LiveSeoElementRow,
  LiveSeoQueryRow,
  Ratio,
  RunActivity,
  SourceType,
} from "@shared/types";

// ------------------------------------------------------------------ constants
export const SPEEDS = [1, 10, 30] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_SPEED: Speed = 10;
/** Replay: run-time gaps longer than this between stored events are shortened (and labelled). */
export const IDLE_GAP_MS = 10_000;
/** Replay: after a shortened gap the playhead lands this long before the next stored event. */
export const GAP_LEAD_MS = 1_000;
/** Replay: pending ("Reading…") rows shown per panel. */
export const MAX_PENDING = 8;
/** Live: unlabelled skeleton rows while the recommend step runs. */
export const MAX_LIVE_SKELETONS = 3;
/** Counter tween duration (design section 8). */
export const TWEEN_MS = 600;
/** When one tick brings more rows than this into a panel, only the newest animate. */
export const MAX_ANIMATED = 12;
/** Answer cards kept per engine strip. */
export const STRIP_MAX = 12;
/** p50 latency is shown only from this many calls with a stored latency. */
export const MIN_LATENCY_SAMPLES = 5;
/** Replay loading caps: 25 pages of 200 rows per source. */
export const REPLAY_PAGE_LIMIT = 200;
export const REPLAY_MAX_PAGES = 25;
export const MAX_EVENTS = REPLAY_PAGE_LIMIT * REPLAY_MAX_PAGES;

// ------------------------------------------------------------------ time
/** Date.parse that never yields NaN (invalid stamps sort first, at 0). */
export function toMs(at: string | null | undefined): number {
  if (!at) return 0;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
}

// ------------------------------------------------------------------ timeline
/**
 * One stored row of the run. Rows from different sources with the same id are the SAME stored row
 * (`dec:<id>` decision = element/query row, `obs:<id>` answer = engine_answer item): the feed row carries
 * the structured fields and the activity item stays attached as the "something arrived" signal.
 */
export interface TimelineEvent {
  id: string;
  at: string;
  t: number;
  item: ActivityItem | null;
  element: LiveSeoElementRow | null;
  query: LiveSeoQueryRow | null;
  rec: LiveRecommendationRow | null;
  answer: LiveGeoAnswerRow | null;
}

export interface FeedRows {
  elements?: readonly LiveSeoElementRow[];
  queries?: readonly LiveSeoQueryRow[];
  recommendations?: readonly LiveRecommendationRow[];
  answers?: readonly LiveGeoAnswerRow[];
}

export function compareEvents(a: { t: number; id: string }, b: { t: number; id: string }): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Union of activity items and feed rows, joined by id (feed rows win for `at`), sorted by (at, id). */
export function buildTimeline(items: readonly ActivityItem[], feed: FeedRows = {}): TimelineEvent[] {
  const byId = new Map<string, TimelineEvent>();
  const get = (id: string, at: string): TimelineEvent => {
    let ev = byId.get(id);
    if (!ev) {
      ev = { id, at, t: toMs(at), item: null, element: null, query: null, rec: null, answer: null };
      byId.set(id, ev);
    }
    return ev;
  };
  const setAt = (ev: TimelineEvent, at: string) => {
    ev.at = at;
    ev.t = toMs(at);
  };
  for (const it of items) get(it.id, it.at).item = it;
  for (const r of feed.elements ?? []) {
    const ev = get(r.id, r.at);
    ev.element = r;
    setAt(ev, r.at);
  }
  for (const r of feed.queries ?? []) {
    const ev = get(r.id, r.at);
    ev.query = r;
    setAt(ev, r.at);
  }
  for (const r of feed.recommendations ?? []) {
    const ev = get(r.id, r.at);
    ev.rec = r;
    setAt(ev, r.at);
  }
  for (const r of feed.answers ?? []) {
    const ev = get(r.id, r.at);
    ev.answer = r;
    setAt(ev, r.at);
  }
  return Array.from(byId.values()).sort(compareEvents);
}

/** Merge a newer page of rows into kept rows by id (newer copy wins); ascending (at, id); capped (newest kept). */
export function mergeById<T extends { id: string; at: string }>(prev: readonly T[], next: readonly T[], max = MAX_EVENTS): T[] {
  if (next.length === 0) return prev.length > max ? prev.slice(prev.length - max) : (prev as T[]);
  const byId = new Map<string, T>();
  for (const r of prev) byId.set(r.id, r);
  for (const r of next) byId.set(r.id, r);
  const out = Array.from(byId.values()).sort((a, b) => compareEvents({ t: toMs(a.at), id: a.id }, { t: toMs(b.at), id: b.id }));
  return out.length > max ? out.slice(out.length - max) : out;
}

/** Number of events at or before the playhead (binary search; events ascending). null playhead = all. */
export function revealCount(events: readonly { t: number }[], playhead: number | null): number {
  if (playhead === null) return events.length;
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid]!.t <= playhead) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Revealed rows and the next pending ones (ascending). Live (playhead null): everything revealed, nothing pending. */
export function splitAt<T extends { t: number }>(events: readonly T[], playhead: number | null, maxPending = MAX_PENDING): { revealed: T[]; pending: T[] } {
  const n = revealCount(events, playhead);
  return { revealed: events.slice(0, n), pending: playhead === null ? [] : events.slice(n, n + Math.max(0, maxPending)) };
}

// ------------------------------------------------------------------ replay clock
export interface ReplayBounds {
  t0: number;
  tEnd: number;
}

/** t0 = run.startedAt ?? run.createdAt (or the first event when earlier); tEnd = finishedAt ?? last event (never before it). */
export function replayBounds(run: Pick<RunActivity["run"], "startedAt" | "createdAt" | "finishedAt">, events: readonly { t: number }[]): ReplayBounds {
  const first = events[0]?.t;
  const last = events[events.length - 1]?.t;
  let t0 = toMs(run.startedAt ?? run.createdAt);
  if (first !== undefined && (t0 === 0 || first < t0)) t0 = first;
  let tEnd = run.finishedAt ? toMs(run.finishedAt) : (last ?? t0);
  if (last !== undefined && last > tEnd) tEnd = last;
  if (tEnd < t0) tEnd = t0;
  return { t0, tEnd };
}

export interface ReplayClock {
  t0: number;
  tEnd: number;
  /** Playhead in absolute ms (run time). */
  p: number;
  speed: Speed;
  playing: boolean;
  finished: boolean;
}

export function initClock(b: ReplayBounds, speed: Speed = DEFAULT_SPEED, playing = true): ReplayClock {
  const finished = b.tEnd <= b.t0;
  return { t0: b.t0, tEnd: b.tEnd, p: finished ? b.tEnd : b.t0, speed, playing: playing && !finished, finished };
}

/** First event time strictly after p (times ascending), or null. */
export function nextTimeAfter(times: readonly number[], p: number): number | null {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= p) lo = mid + 1;
    else hi = mid;
  }
  return lo < times.length ? times[lo]! : null;
}

/**
 * Advance the playhead by `dtWallMs × speed`. When the next stored event (or the end) is more than
 * IDLE_GAP_MS of run time ahead, the playhead first jumps to GAP_LEAD_MS before it.
 */
export function advanceClock(c: ReplayClock, dtWallMs: number, times: readonly number[]): ReplayClock {
  if (!c.playing || c.finished) return c;
  let p = c.p;
  const next = nextTimeAfter(times, p) ?? c.tEnd;
  if (next - p > IDLE_GAP_MS) p = next - GAP_LEAD_MS;
  p += Math.max(0, Number.isFinite(dtWallMs) ? dtWallMs : 0) * c.speed;
  if (p >= c.tEnd) return { ...c, p: c.tEnd, playing: false, finished: true };
  return { ...c, p };
}

export function seekClock(c: ReplayClock, p: number): ReplayClock {
  const q = Math.min(c.tEnd, Math.max(c.t0, Number.isFinite(p) ? p : c.t0));
  const finished = q >= c.tEnd;
  return { ...c, p: q, finished, playing: finished ? false : c.playing };
}

export function restartClock(c: ReplayClock): ReplayClock {
  return { ...c, p: c.t0, playing: c.tEnd > c.t0, finished: c.tEnd <= c.t0 };
}

export function skipToEnd(c: ReplayClock): ReplayClock {
  return { ...c, p: c.tEnd, playing: false, finished: true };
}

export function togglePlay(c: ReplayClock): ReplayClock {
  if (c.finished) return restartClock(c);
  return { ...c, playing: !c.playing };
}

export function pauseClock(c: ReplayClock): ReplayClock {
  return c.playing ? { ...c, playing: false } : c;
}

export function setClockSpeed(c: ReplayClock, speed: Speed): ReplayClock {
  return { ...c, speed };
}

export function parseSpeed(v: unknown): Speed {
  const n = typeof v === "string" ? Number(v) : v;
  return (SPEEDS as readonly unknown[]).includes(n) ? (n as Speed) : DEFAULT_SPEED;
}

/** True when the replay will shorten at least one idle gap (the label then says so). */
export function hasLongGaps(times: readonly number[], t0: number, tEnd: number): boolean {
  let prev = t0;
  for (const t of times) {
    if (t - prev > IDLE_GAP_MS) return true;
    if (t > prev) prev = t;
  }
  return tEnd - prev > IDLE_GAP_MS;
}

// ------------------------------------------------------------------ tweens (between RECEIVED values only)
export interface Tween {
  from: number;
  to: number;
  start: number;
  duration: number;
}

export function easeOutCubic(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return 1 - (1 - c) ** 3;
}

export function tweenValue(tw: Tween, now: number): number {
  if (tw.duration <= 0 || now >= tw.start + tw.duration) return tw.to;
  if (now <= tw.start) return tw.from;
  return tw.from + (tw.to - tw.from) * easeOutCubic((now - tw.start) / tw.duration);
}

export function tweenDone(tw: Tween, now: number): boolean {
  return tw.duration <= 0 || now >= tw.start + tw.duration;
}

/** Retarget a counter to a newly received value; starts from wherever the running tween is now (one tween per counter). */
export function retarget(tw: Tween | null, to: number, now: number, reduced = false, duration = TWEEN_MS): Tween {
  if (reduced || !tw) return { from: to, to, start: now, duration: 0 };
  if (tw.to === to) return tw;
  return { from: tweenValue(tw, now), to, start: now, duration };
}

// ------------------------------------------------------------------ selectors over revealed events
export function itemsOf(events: readonly TimelineEvent[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const e of events) if (e.item) out.push(e.item);
  return out;
}
export function elementsOf(events: readonly TimelineEvent[]): LiveSeoElementRow[] {
  const out: LiveSeoElementRow[] = [];
  for (const e of events) if (e.element) out.push(e.element);
  return out;
}
export function queriesOf(events: readonly TimelineEvent[]): LiveSeoQueryRow[] {
  const out: LiveSeoQueryRow[] = [];
  for (const e of events) if (e.query) out.push(e.query);
  return out;
}
export function recsOf(events: readonly TimelineEvent[]): LiveRecommendationRow[] {
  const out: LiveRecommendationRow[] = [];
  for (const e of events) if (e.rec) out.push(e.rec);
  return out;
}
export function answersOf(events: readonly TimelineEvent[]): LiveGeoAnswerRow[] {
  const out: LiveGeoAnswerRow[] = [];
  for (const e of events) if (e.answer) out.push(e.answer);
  return out;
}

// ------------------------------------------------------------------ SEO: element rows
export interface ElementCounts {
  judged: number;
  keep: number;
  change: number;
  review: number;
}

/** Candidate keys that have an element-question row (their action row folds into a "Next:" note). */
function elementCandidates(rows: readonly LiveSeoElementRow[]): Set<string> {
  const s = new Set<string>();
  for (const r of rows) if (r.role === "element" && r.candidateKey) s.add(r.candidateKey);
  return s;
}

/** Same rule as the server's totals: element and rule rows, plus action rows of candidates with no element row. */
export function elementCounts(rows: readonly LiveSeoElementRow[]): ElementCounts {
  const withElement = elementCandidates(rows);
  const c: ElementCounts = { judged: 0, keep: 0, change: 0, review: 0 };
  for (const r of rows) {
    if (r.role === "action" && r.candidateKey && withElement.has(r.candidateKey)) continue;
    c.judged++;
    c[r.verdict]++;
  }
  return c;
}

export interface ElementDisplayRow {
  row: LiveSeoElementRow;
  /** "Next: Title + meta" when the candidate's action row was folded into this element row. */
  next: string | null;
  /** Replay only: the row's stored time has not been reached yet. */
  pending: boolean;
}

/**
 * Rows for panel 04, in one strictly descending time order: pending rows (replay; the next ones at the
 * bottom of the pending block, right above the newest resolved row) then resolved rows, newest first.
 * Action rows show only for candidates with no element row; otherwise they become a "Next:" note.
 */
export function elementDisplay(revealed: readonly LiveSeoElementRow[], pending: readonly LiveSeoElementRow[] = [], maxResolved = 200): ElementDisplayRow[] {
  const all = [...revealed, ...pending];
  const withElement = elementCandidates(all);
  const nextNote = new Map<string, string>();
  for (const r of revealed) if (r.role === "action" && r.candidateKey && withElement.has(r.candidateKey)) nextNote.set(r.candidateKey, `Next: ${r.element}`);
  const keep = (r: LiveSeoElementRow) => !(r.role === "action" && r.candidateKey && withElement.has(r.candidateKey));
  const resolved: ElementDisplayRow[] = [];
  const noted = new Set<string>();
  for (let i = revealed.length - 1; i >= 0 && resolved.length < maxResolved; i--) {
    const r = revealed[i]!;
    if (!keep(r)) continue;
    let next: string | null = null;
    if (r.role === "element" && r.candidateKey && !noted.has(r.candidateKey) && nextNote.has(r.candidateKey)) {
      next = nextNote.get(r.candidateKey)!;
      noted.add(r.candidateKey);
    }
    resolved.push({ row: r, next, pending: false });
  }
  const pend: ElementDisplayRow[] = [];
  for (let i = pending.length - 1; i >= 0; i--) {
    const r = pending[i]!;
    if (keep(r)) pend.push({ row: r, next: null, pending: true });
  }
  return [...pend, ...resolved];
}

// ------------------------------------------------------------------ SEO: queries
export interface QueryGroup {
  queryKey: string;
  query: string;
  t: number;
  relevance: LiveSeoQueryRow | null;
  intent: LiveSeoQueryRow | null;
  buyer: LiveSeoQueryRow | null;
  buyerReady: LiveSeoQueryRow | null;
  gsc: LiveSeoQueryRow["gsc"];
  pending: boolean;
}

/** Group answers by query (newest group first); a group's cells fill as its answers are revealed. */
export function queryGroups(revealed: readonly LiveSeoQueryRow[], pending: readonly LiveSeoQueryRow[] = [], max = 200): QueryGroup[] {
  const build = (rows: readonly LiveSeoQueryRow[], isPending: boolean, skip: Set<string>) => {
    const map = new Map<string, QueryGroup>();
    for (const r of rows) {
      if (skip.has(r.queryKey)) continue;
      let g = map.get(r.queryKey);
      if (!g) {
        g = { queryKey: r.queryKey, query: r.query, t: 0, relevance: null, intent: null, buyer: null, buyerReady: null, gsc: null, pending: isPending };
        map.set(r.queryKey, g);
      }
      g.t = Math.max(g.t, toMs(r.at));
      if (r.questionId === "seo.query_relevance") g.relevance = r;
      else if (r.questionId === "seo.query_intent") g.intent = r;
      else if (r.questionId === "seo.buyer_query") g.buyer = r;
      else if (r.questionId === "seo.buyer_ready") g.buyerReady = r;
      if (!g.gsc && r.gsc) g.gsc = r.gsc;
    }
    return Array.from(map.values()).sort((a, b) => b.t - a.t || (a.queryKey < b.queryKey ? -1 : 1));
  };
  const resolved = build(revealed, false, new Set()).slice(0, max);
  const seen = new Set(resolved.map((g) => g.queryKey));
  const pend = build(pending, true, seen);
  return [...pend, ...resolved];
}

export interface QueryCounts {
  distinct: number;
  relevant: number;
  notRelevant: number;
  unsure: number;
}

export function queryCounts(rows: readonly LiveSeoQueryRow[]): QueryCounts {
  const keys = new Set<string>();
  const c: QueryCounts = { distinct: 0, relevant: 0, notRelevant: 0, unsure: 0 };
  for (const r of rows) {
    keys.add(r.queryKey);
    if (r.questionId !== "seo.query_relevance") continue;
    if (r.band === "yes") c.relevant++;
    else if (r.band === "no") c.notRelevant++;
    else if (r.band === "middle") c.unsure++;
  }
  c.distinct = keys.size;
  return c;
}

// ------------------------------------------------------------------ SEO: crawl
export function pageReads(items: readonly ActivityItem[], max = 8): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < max; i--) if (items[i]!.kind === "page_read") out.push(items[i]!);
  return out;
}

export function countPageReads(items: readonly ActivityItem[]): number {
  let n = 0;
  for (const it of items) if (it.kind === "page_read") n++;
  return n;
}

/** "Skipped: <reason>" details (docs/api.md "Run activity") counted by reason, most frequent first. */
export function skippedReasons(items: readonly ActivityItem[]): Array<{ reason: string; count: number }> {
  const m = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== "page_read" || !it.detail?.startsWith("Skipped: ")) continue;
    const reason = it.detail.slice("Skipped: ".length).trim() || "unknown";
    m.set(reason, (m.get(reason) ?? 0) + 1);
  }
  return Array.from(m, ([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
}

// ------------------------------------------------------------------ run rail
export const RAIL_STEPS: Record<"seo" | "geo", string[]> = {
  seo: ["seo.validate", "seo.crawl", "seo.gsc_sync", "seo.recommend"],
  geo: ["geo.validate", "geo.batch", "geo.proposals"],
};

export const STEP_LABEL: Record<string, string> = {
  "seo.validate": "Validate",
  "seo.crawl": "Crawl",
  "seo.gsc_sync": "Search Console sync",
  "seo.recommend": "Judge and draft",
  "seo.summary": "Summary",
  "geo.validate": "Validate",
  "geo.batch": "Ask engines",
  "geo.proposals": "Proposals",
  "geo.summary": "Summary",
};

export type StepStatus = "started" | "completed" | "partial" | "failed" | "skipped";
const TERMINAL = new Set<StepStatus>(["completed", "partial", "failed", "skipped"]);

/** Step name and status from a `step` item (server detail "<step> · <status>"). */
export function parseStep(it: ActivityItem): { step: string; status: StepStatus } | null {
  if (it.kind !== "step" || !it.detail) return null;
  const i = it.detail.lastIndexOf(" · ");
  if (i <= 0) return null;
  const step = it.detail.slice(0, i).trim();
  const raw = it.detail.slice(i + 3).trim();
  const status: StepStatus = TERMINAL.has(raw as StepStatus) ? (raw as StepStatus) : "started";
  return step ? { step, status } : null;
}

export type SegmentStatus = "not_started" | "running" | "completed" | "partial" | "failed" | "skipped";

export interface StepSegment {
  step: string;
  label: string;
  /** Lane provider for geo_batch:<engine> sub-bars. */
  lane: string | null;
  start: number | null;
  end: number | null;
  status: SegmentStatus;
  /** Stored message of the latest event (plain text). */
  message: string | null;
}

function segmentFor(step: string, events: Array<{ t: number; status: StepStatus; message: string }>, lane: string | null): StepSegment {
  let start: number | null = null;
  let end: number | null = null;
  let status: SegmentStatus = "not_started";
  let message: string | null = null;
  for (const e of events) {
    message = e.message;
    if (e.status === "started") {
      if (status !== "running") start = e.t;
      end = null;
      status = "running";
    } else {
      if (start === null) start = e.t;
      end = e.t;
      status = e.status;
    }
  }
  return { step, label: lane ? lane : (STEP_LABEL[step] ?? step), lane, start, end, status, message };
}

/** Step segments (agent order, no summary) plus GEO lane sub-bars, from revealed step items. */
export function stepSegments(items: readonly ActivityItem[], agent: "seo" | "geo"): { steps: StepSegment[]; lanes: StepSegment[] } {
  const by = new Map<string, Array<{ t: number; status: StepStatus; message: string }>>();
  for (const it of items) {
    const s = parseStep(it);
    if (!s) continue;
    const list = by.get(s.step) ?? [];
    list.push({ t: toMs(it.at), status: s.status, message: it.title });
    by.set(s.step, list);
  }
  const steps = RAIL_STEPS[agent].map((st) => segmentFor(st, by.get(st) ?? [], null));
  const lanes: StepSegment[] = [];
  for (const [step, evs] of by) if (step.startsWith("geo_batch:")) lanes.push(segmentFor(step, evs, step.slice("geo_batch:".length)));
  lanes.sort((a, b) => (a.lane! < b.lane! ? -1 : 1));
  return { steps, lanes };
}

export function stepStatus(items: readonly ActivityItem[], step: string): SegmentStatus {
  let st: SegmentStatus = "not_started";
  for (const it of items) {
    const s = parseStep(it);
    if (s?.step === step) st = s.status === "started" ? "running" : s.status;
  }
  return st;
}

export interface CallTick {
  id: string;
  t: number;
  provider: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  isEstimate: boolean;
}

/** Provider calls and engine answers (engine calls are folded into answers server-side, so no double count). */
export function callTicks(items: readonly ActivityItem[]): CallTick[] {
  const out: CallTick[] = [];
  for (const it of items) {
    if (it.kind !== "provider_call" && it.kind !== "engine_answer") continue;
    out.push({ id: it.id, t: toMs(it.at), provider: it.provider, latencyMs: it.latencyMs, costUsd: it.costUsd, isEstimate: it.costIsEstimate });
  }
  return out;
}

/** Median stored latency; null with fewer than MIN_LATENCY_SAMPLES samples. */
export function medianLatency(ticks: readonly CallTick[]): number | null {
  const v = ticks.map((t) => t.latencyMs).filter((x): x is number => x !== null && Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length < MIN_LATENCY_SAMPLES) return null;
  const mid = v.length >>> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** Cumulative spend points; the line stops at the first unpriced call (unpricedFrom = its time). */
export function spendSeries(ticks: readonly CallTick[]): { points: Array<{ t: number; usd: number }>; unpricedFrom: number | null } {
  const points: Array<{ t: number; usd: number }> = [];
  let sum = 0;
  for (const tk of ticks) {
    if (tk.costUsd === null || !Number.isFinite(tk.costUsd)) return { points, unpricedFrom: tk.t };
    sum += tk.costUsd;
    points.push({ t: tk.t, usd: sum });
  }
  return { points, unpricedFrom: null };
}

export interface SpendSoFar {
  usd: number;
  unpriced: number;
  priced: number;
  isEstimate: boolean;
}

/** Sum of revealed cost-bearing rows (provider calls and engine answers); unpriced ones are counted, never $0. */
export function spendSoFar(events: readonly TimelineEvent[]): SpendSoFar {
  const s: SpendSoFar = { usd: 0, unpriced: 0, priced: 0, isEstimate: false };
  for (const e of events) {
    const it = e.item;
    let cost: number | null;
    let est: boolean;
    if (it && (it.kind === "provider_call" || it.kind === "engine_answer")) {
      cost = it.costUsd;
      est = it.costIsEstimate;
    } else if (e.answer) {
      cost = e.answer.cost.value;
      est = e.answer.cost.isEstimate;
    } else continue;
    if (cost === null || !Number.isFinite(cost)) s.unpriced++;
    else {
      s.usd += cost;
      s.priced++;
      s.isEstimate ||= est;
    }
  }
  s.usd = Math.round(s.usd * 1e6) / 1e6;
  return s;
}

export function decisionCounts(items: readonly ActivityItem[]): { act: number; flag: number; drop: number } {
  const c = { act: 0, flag: 0, drop: 0 };
  for (const it of items) if (it.kind === "jev_decision" && (it.outcome === "act" || it.outcome === "flag" || it.outcome === "drop")) c[it.outcome]++;
  return c;
}

// ------------------------------------------------------------------ GEO
/** This lane's answers by outcome, from revealed rows (replay counters; the server totals replace them at the end). */
export function laneTotalsFrom(answers: readonly LiveGeoAnswerRow[], provider: string): LiveGeoLaneTotals {
  const t: LiveGeoLaneTotals = { provider: provider as LiveGeoLaneTotals["provider"], cited: 0, named: 0, missing: 0, failed: 0, pending: 0, cost: { value: null, isEstimate: false }, citedInstead: null };
  let sum = 0;
  let any = false;
  let unknown = false;
  let est = false;
  const hosts = new Map<string, { sourceType: SourceType; answers: number }>();
  for (const a of answers) {
    if (a.provider !== provider) continue;
    if (a.outcome === null) t.pending++;
    else t[a.outcome]++;
    any = true;
    if (a.cost.value === null || !Number.isFinite(a.cost.value)) unknown = true;
    else {
      sum += a.cost.value;
      est ||= a.cost.isEstimate;
    }
    if ((a.outcome === "missing" || a.outcome === "named") && a.citedInstead) {
      const h = hosts.get(a.citedInstead.host) ?? { sourceType: a.citedInstead.sourceType, answers: 0 };
      h.answers++;
      hosts.set(a.citedInstead.host, h);
    }
  }
  t.cost = !any ? { value: null, isEstimate: false } : unknown ? { value: null, isEstimate: est } : { value: Math.round(sum * 1e6) / 1e6, isEstimate: est };
  let best: LiveGeoLaneTotals["citedInstead"] = null;
  for (const [host, h] of hosts) if (!best || h.answers > best.answers || (h.answers === best.answers && host < best.host)) best = { host, sourceType: h.sourceType, answers: h.answers };
  t.citedInstead = best;
  return t;
}

/** Gauge ratio for a lane: citation rate cited/(cited+named+missing); custom lanes: mention rate (cited+named)/valid. */
export function laneRatio(t: Pick<LiveGeoLaneTotals, "cited" | "named" | "missing">, custom: boolean): Ratio {
  const denominator = t.cited + t.named + t.missing;
  const numerator = custom ? t.cited + t.named : t.cited;
  return { numerator, denominator, value: denominator > 0 ? numerator / denominator : null };
}

/** Newest STRIP_MAX revealed answers of a lane, oldest first (newest at the right of the strip). */
export function laneStrip(answers: readonly LiveGeoAnswerRow[], provider: string, max = STRIP_MAX): LiveGeoAnswerRow[] {
  const out: LiveGeoAnswerRow[] = [];
  for (let i = answers.length - 1; i >= 0 && out.length < max; i--) if (answers[i]!.provider === provider) out.push(answers[i]!);
  return out.reverse();
}

/** Newest revealed answer of this lane that did not cite us (B card); prefers one with a matched page. */
export function latestSkipped(answers: readonly LiveGeoAnswerRow[], provider: string): { row: LiveGeoAnswerRow | null; total: number; withPage: number } {
  let row: LiveGeoAnswerRow | null = null;
  let fallback: LiveGeoAnswerRow | null = null;
  const prompts = new Set<string>();
  const withPage = new Set<string>();
  for (let i = answers.length - 1; i >= 0; i--) {
    const a = answers[i]!;
    if (a.provider !== provider || (a.outcome !== "missing" && a.outcome !== "named")) continue;
    const key = a.promptId ?? a.promptText;
    prompts.add(key);
    if (a.matchedPage) withPage.add(key);
    if (!row && a.matchedPage) row = a;
    if (!fallback) fallback = a;
  }
  return { row: row ?? fallback, total: prompts.size, withPage: withPage.size };
}

export interface CitedInsteadBar {
  host: string;
  sourceType: SourceType;
  count: number;
  providers: string[];
}

/** Hosts by how many of this run's answers cited them first instead of us (top `max`). */
export function citedInsteadBars(answers: readonly LiveGeoAnswerRow[], max = 8): CitedInsteadBar[] {
  const m = new Map<string, CitedInsteadBar>();
  for (const a of answers) {
    if (!a.citedInstead) continue;
    const b = m.get(a.citedInstead.host) ?? { host: a.citedInstead.host, sourceType: a.citedInstead.sourceType, count: 0, providers: [] };
    b.count++;
    if (!b.providers.includes(a.provider)) b.providers.push(a.provider);
    m.set(b.host, b);
  }
  return Array.from(m.values())
    .sort((a, b) => b.count - a.count || (a.host < b.host ? -1 : 1))
    .slice(0, max);
}

export type HeatCell =
  | { kind: "answer"; outcome: NonNullable<LiveGeoAnswerRow["outcome"]>; answer: LiveGeoAnswerRow }
  | { kind: "analysing"; answer: LiveGeoAnswerRow }
  | { kind: "pending" }
  | { kind: "not_run" }
  | { kind: "none" };

/**
 * Prompt × engine cell. pending = genuinely pending (live: lane queued/asking while the run is active;
 * replay: the stored answer's time is not reached yet). not_run = the run is over and no answer exists.
 */
export function heatCell(
  revealed: ReadonlyMap<string, LiveGeoAnswerRow>,
  upcoming: ReadonlySet<string>,
  promptId: string,
  provider: string,
  opts: { active: boolean; laneBusy: boolean; replaying: boolean },
): HeatCell {
  const key = `${promptId}|${provider}`;
  const a = revealed.get(key);
  if (a) return a.outcome === null ? { kind: "analysing", answer: a } : { kind: "answer", outcome: a.outcome, answer: a };
  if (opts.replaying && upcoming.has(key)) return { kind: "pending" };
  if (opts.active && opts.laneBusy) return { kind: "pending" };
  if (!opts.active) return { kind: "not_run" };
  return { kind: "none" };
}

/** Latest revealed answer per (promptId, provider). */
export function answerIndex(answers: readonly LiveGeoAnswerRow[]): Map<string, LiveGeoAnswerRow> {
  const m = new Map<string, LiveGeoAnswerRow>();
  for (const a of answers) if (a.promptId) m.set(`${a.promptId}|${a.provider}`, a);
  return m;
}

export function sumCost(costs: readonly CostUsd[]): CostUsd {
  let sum = 0;
  let est = false;
  for (const c of costs) {
    if (c.value === null || !Number.isFinite(c.value)) return { value: null, isEstimate: est || c.isEstimate };
    sum += c.value;
    est ||= c.isEstimate;
  }
  return { value: costs.length ? Math.round(sum * 1e6) / 1e6 : null, isEstimate: est };
}

// ------------------------------------------------------------------ arrivals (animation + announcements)
/** Ids to animate for one batch of arrivals: the newest MAX_ANIMATED only (the rest insert instantly). */
export function animatedIds(arrived: readonly { id: string; t: number }[], max = MAX_ANIMATED): Set<string> {
  const sorted = arrived.slice().sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1));
  return new Set(sorted.slice(0, max).map((e) => e.id));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** One summary sentence for screen readers: "6 new judgments: 2 change, 4 keep. 3 new answers: 1 cited." Never untrusted text. */
export function arrivalSummary(events: readonly TimelineEvent[]): string {
  const parts: string[] = [];
  const el = events.filter((e) => e.element).map((e) => e.element!);
  if (el.length) {
    const c = { change: 0, keep: 0, review: 0 };
    for (const r of el) c[r.verdict]++;
    const sub = (["change", "keep", "review"] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`);
    parts.push(`${plural(el.length, "new judgment")}: ${sub.join(", ")}.`);
  }
  const q = events.filter((e) => e.query).length;
  if (q) parts.push(`${plural(q, "query answer")} stored.`);
  const ans = events.filter((e) => e.answer).map((e) => e.answer!);
  if (ans.length) {
    const cited = ans.filter((a) => a.outcome === "cited").length;
    parts.push(`${plural(ans.length, "new answer")}: ${cited} cited.`);
  } else {
    const ea = events.filter((e) => e.item?.kind === "engine_answer").length;
    if (ea) parts.push(`${plural(ea, "new answer")}.`);
  }
  const pages = events.filter((e) => e.item?.kind === "page_read").length;
  if (pages) parts.push(`${plural(pages, "page")} read.`);
  const recs = events.filter((e) => e.rec).length;
  if (recs) parts.push(`${plural(recs, "recommendation")} drafted.`);
  return parts.join(" ");
}
