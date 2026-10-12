/**
 * Pure helpers for the internal links "Live" panel ([A41], docs/live-view-design.md section 20). No DOM, no JSX:
 * unit-tested in tests/links-live-web.test.ts. Everything is derived from stored progress events and the stored run
 * totals (GET .../internal-links/live); nothing is projected or interpolated.
 */
import type { ReplayClock } from "../live/engine";
import type { LinkLiveEvent, LinkLiveKind, LinkLiveResponse, LinkLiveRunView, LinkLiveStage, LinkLiveTotals, LinkLiveVerdict } from "@shared/link-live";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "demo";

// ------------------------------------------------------------------ stage rail

export type LiveChipId = "graph" | "verify" | "candidates" | "jev" | "drafts" | "saved";
/**
 * not_started: no event yet · running: started, not finished (pulses while live) · done · partial · skipped ·
 * failed · ended: the run is over and this stage never stored a final event · not_reached: the run ended first.
 */
export type ChipStatus = "not_started" | "running" | "done" | "partial" | "skipped" | "failed" | "ended" | "not_reached";

export const CHIP_LABEL: Record<LiveChipId, string> = {
  graph: "Graph",
  verify: "Verify placed",
  candidates: "Candidates",
  jev: "Jev judging",
  drafts: "Draft sentences",
  saved: "Saved",
};

/** Stages per chip, in execution order (the chip is finished when its LAST stage stored a final event). */
export function chipStages(kind: LinkLiveKind): Array<[LiveChipId, LinkLiveStage[]]> {
  if (kind === "graph") {
    return [
      ["graph", ["graph.load", "graph.edges", "graph.clusters", "graph.anchors"]],
      ["verify", ["graph.verify"]],
      ["saved", ["graph.save"]],
    ];
  }
  return [
    ["graph", ["graph.load", "graph.edges", "graph.clusters", "graph.anchors", "graph.save"]],
    ["verify", ["graph.verify"]],
    ["candidates", ["pages", "candidates", "sentences"]],
    ["jev", ["jev"]],
    ["drafts", ["drafts"]],
    ["saved", ["save"]],
  ];
}

export interface ChipState {
  id: LiveChipId;
  label: string;
  status: ChipStatus;
  /** Counts from the chip's latest stored events, e.g. "412 pairs · 38 matched"; null before any. */
  count: string | null;
}

const nf = new Intl.NumberFormat("en-US");
export const fmt = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : nf.format(Math.round(n)));
const FINAL = new Set(["completed", "partial", "skipped", "failed"]);

function latest(events: readonly LinkLiveEvent[], stage: LinkLiveStage): LinkLiveEvent | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.stage === stage) return events[i]!;
  return null;
}

/** The latest event of a stage with a final status (counts), else the latest event of it. */
function finalOf(events: readonly LinkLiveEvent[], stage: LinkLiveStage): LinkLiveEvent | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.stage === stage && FINAL.has(events[i]!.status)) return events[i]!;
  return null;
}

const n = (e: LinkLiveEvent | null, k: string): number | null => {
  const v = e?.detail.n?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

function chipCount(id: LiveChipId, events: readonly LinkLiveEvent[]): string | null {
  switch (id) {
    case "graph": {
      const edges = finalOf(events, "graph.edges");
      if (edges) return `${fmt(n(edges, "urls"))} URLs · ${fmt(n(edges, "edges"))} links`;
      const load = finalOf(events, "graph.load");
      return load ? `${fmt(n(load, "pages"))} pages loaded` : null;
    }
    case "verify": {
      const v = finalOf(events, "graph.verify");
      if (!v) return null;
      if (v.status === "skipped") return "no placed links";
      return `${fmt(n(v, "verified"))} verified · ${fmt(n(v, "notFound"))} not found of ${fmt(n(v, "checked"))}`;
    }
    case "candidates": {
      const c = finalOf(events, "candidates");
      const s = finalOf(events, "sentences");
      if (!c) return null;
      return `${fmt(n(c, "considered"))} pairs${s ? ` · ${fmt(n(s, "matched"))} matched` : ""}`;
    }
    case "jev": {
      const e = latest(events, "jev");
      if (!e) return null;
      if (e.status === "skipped") return "not called";
      if (e.status === "started") return `${fmt(n(e, "pairs"))} pairs · ${fmt(n(e, "batches"))} batches`;
      const judged = `${fmt(n(e, "judged"))} judged · ${fmt(n(e, "kept"))} kept · ${fmt(n(e, "dropped"))} dropped`;
      return e.status === "progress" ? `batch ${fmt(n(e, "batch"))} of ${fmt(n(e, "batches"))} · ${judged}` : judged;
    }
    case "drafts": {
      const e = latest(events, "drafts");
      if (!e) return null;
      if (e.status === "skipped") return "none drafted";
      const pool = n(events.find((x) => x.stage === "drafts" && x.status === "started") ?? null, "pool");
      return `${fmt(n(e, "drafted") ?? 0)} drafted${pool !== null ? ` of ${fmt(pool)}` : ""}`;
    }
    case "saved": {
      const save = finalOf(events, "save");
      if (save) return `${fmt(n(save, "rows"))} suggestions`;
      const gs = finalOf(events, "graph.save");
      if (gs && events.every((e) => e.stage !== "pages")) return gs.status === "skipped" ? "not stored" : `${fmt(n(gs, "urls"))} URLs stored`;
      return null;
    }
  }
}

/**
 * Chip states from the revealed events. `runOver`: the run (or the replay at this playhead) has no more events
 * to come, so a chip still "running" ended without a final event (failed when the run failed there).
 */
export function stageRail(kind: LinkLiveKind, events: readonly LinkLiveEvent[], runOver: boolean, runFailed = false): ChipState[] {
  return chipStages(kind).map(([id, stages]) => {
    const evs = events.filter((e) => stages.includes(e.stage));
    const last = stages[stages.length - 1]!;
    let status: ChipStatus;
    if (evs.some((e) => e.status === "failed")) status = "failed";
    else if (evs.length === 0) status = runOver ? "not_reached" : "not_started";
    else {
      const lastFinal = finalOf(events, last);
      const finals = evs.filter((e) => FINAL.has(e.status));
      if (lastFinal) {
        status = finals.some((e) => e.status === "partial") ? "partial" : finals.every((e) => e.status === "skipped") ? "skipped" : "done";
      } else status = runOver ? (runFailed ? "failed" : "ended") : "running";
    }
    return { id, label: CHIP_LABEL[id], status, count: chipCount(id, events) };
  });
}

export const CHIP_WORD: Record<ChipStatus, string> = {
  not_started: "not started",
  running: "running",
  done: "done",
  partial: "partial",
  skipped: "skipped",
  failed: "failed",
  ended: "ended without a result",
  not_reached: "not reached",
};

/**
 * What the agent is waiting on right now, only while the run is live and a stage started but has no final event
 * (design section 0 rule 3: placeholders only for genuinely pending work). null otherwise.
 */
export function nowWaiting(events: readonly LinkLiveEvent[], live: boolean): string | null {
  if (!live || events.length === 0) return null;
  const last = events[events.length - 1]!;
  if (last.stage === "run" && last.status !== "started") return null;
  const open = (stage: LinkLiveStage) => {
    const e = latest(events, stage);
    return e && !FINAL.has(e.status) ? e : null;
  };
  const jev = open("jev");
  if (jev) {
    const batches = n(jev, "batches");
    const k = jev.status === "progress" ? (n(jev, "batch") ?? 0) + 1 : 1;
    return batches !== null && k <= batches ? `Waiting for Jev · batch ${fmt(k)} of ${fmt(batches)}` : "Waiting for Jev";
  }
  const drafts = open("drafts");
  if (drafts) {
    const calls = n(drafts, "calls");
    const k = drafts.status === "progress" ? (n(drafts, "call") ?? 0) + 1 : 1;
    return calls !== null && k <= calls ? `Waiting for the writer · call ${fmt(k)} of ${fmt(calls)}` : "Waiting for the writer";
  }
  const save = open("save");
  if (save) return `Saving ${fmt(n(save, "rows"))} suggestions`;
  const gsave = open("graph.save");
  if (gsave) return `Storing the link graph · ${fmt(n(gsave, "urls"))} URLs`;
  if (open("graph.load")) return "Loading stored snapshots";
  return null;
}

// ------------------------------------------------------------------ link flow lane

export const VERDICT: Record<LinkLiveVerdict, { label: string; tone: BadgeTone }> = {
  candidate: { label: "candidate", tone: "neutral" },
  matched: { label: "sentence found", tone: "info" },
  kept: { label: "kept by Jev", tone: "success" },
  review: { label: "Jev: check yourself", tone: "warning" },
  dropped: { label: "dropped by Jev", tone: "danger" },
  no_answer: { label: "no Jev answer", tone: "neutral" },
  not_sent: { label: "not sent to Jev", tone: "neutral" },
  drafted: { label: "drafted", tone: "success" },
  draft_rejected: { label: "draft rejected", tone: "danger" },
  not_drafted: { label: "not drafted", tone: "neutral" },
  verified: { label: "verified", tone: "success" },
  not_found: { label: "not found", tone: "danger" },
  pending: { label: "pending crawl", tone: "neutral" },
  source_unavailable: { label: "source unavailable", tone: "warning" },
};

export interface FlowChip {
  v: LinkLiveVerdict;
  seq: number;
}

export interface FlowRow {
  key: string;
  source: string;
  target: string;
  anchor: string | null;
  priority: number | null;
  chips: FlowChip[];
  /** seq of the event that first showed the row, and of its latest update. */
  firstSeq: number;
  lastSeq: number;
  /** Position of the item in its latest event (rows of one event read top to bottom). */
  idx: number;
}

export const FLOW_MAX_ROWS = 24;

/**
 * Pairs from the events' items, keyed by source -> target: each new verdict is appended as a chip (a repeated
 * verdict is not), the latest anchor and priority win. Most recently updated first, at most `max` rows.
 */
export function flowRows(events: readonly LinkLiveEvent[], max = FLOW_MAX_ROWS): FlowRow[] {
  const rows = new Map<string, FlowRow>();
  for (const e of events) {
    (e.detail.items ?? []).forEach((it, idx) => {
      if (!it || typeof it.s !== "string" || typeof it.t !== "string" || !(it.v in VERDICT)) return;
      const key = `${it.s}\u0000${it.t}`;
      let r = rows.get(key);
      if (!r) {
        r = { key, source: it.s, target: it.t, anchor: null, priority: null, chips: [], firstSeq: e.seq, lastSeq: e.seq, idx };
        rows.set(key, r);
      }
      if (it.a) r.anchor = it.a;
      if (typeof it.p === "number") r.priority = it.p;
      if (r.chips[r.chips.length - 1]?.v !== it.v) r.chips.push({ v: it.v, seq: e.seq });
      r.lastSeq = e.seq;
      r.idx = idx;
    });
  }
  return [...rows.values()].sort((a, b) => b.lastSeq - a.lastSeq || a.idx - b.idx).slice(0, Math.max(0, max));
}

// ------------------------------------------------------------------ counters

export interface Counter {
  key: string;
  label: string;
  value: number;
  sub?: string;
}

/** Totals derived from revealed events (replay before the end); the same fields the server stores. */
export function totalsFromEvents(events: readonly LinkLiveEvent[]): LinkLiveTotals {
  const t: LinkLiveTotals = {};
  for (const e of events) {
    const d = (k: string) => n(e, k);
    switch (e.stage) {
      case "graph.load":
        if (e.status === "completed") t.pages = d("pages");
        break;
      case "graph.edges":
        t.urls = d("urls");
        t.edges = d("edges");
        break;
      case "graph.verify":
        t.verifyChecked = d("checked");
        t.verified = d("verified");
        t.notFound = d("notFound");
        break;
      case "candidates":
        t.pairsConsidered = d("considered");
        break;
      case "sentences":
        t.pairsMatched = d("matched");
        break;
      case "jev":
        if (e.status === "progress" || e.status === "completed" || e.status === "partial") {
          t.judged = d("judged");
          t.jevKept = d("kept");
          t.jevReview = d("review");
          t.jevDropped = d("dropped");
          t.jevCalls = d("calls");
        }
        break;
      case "drafts":
        if (e.status === "started") t.draftPool = d("pool");
        if (e.status === "progress" || e.status === "completed" || e.status === "partial") {
          t.drafted = d("drafted");
          t.draftRejected = d("rejected");
        }
        break;
      case "save":
        if (e.status === "completed") t.saved = d("rows");
        break;
      default:
        break;
    }
  }
  return t;
}

/** The counters shown under the rail: only figures the run stored (a stage that did not report is left out). */
export function counters(kind: LinkLiveKind, t: LinkLiveTotals): Counter[] {
  const out: Counter[] = [];
  const add = (key: string, label: string, v: number | null | undefined, sub?: string) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push({ key, label, value: v, ...(sub ? { sub } : {}) });
  };
  add("pages", "pages loaded", t.pages);
  if (kind === "graph") {
    add("urls", "URLs in the graph", t.urls, t.edges !== null && t.edges !== undefined ? `${fmt(t.edges)} links` : undefined);
  }
  add("pairs", "pairs considered", kind === "analysis" ? t.pairsConsidered : null, t.pairsMatched !== null && t.pairsMatched !== undefined ? `${fmt(t.pairsMatched)} with a fitting sentence` : undefined);
  add("judged", "judged by Jev", t.judged, t.jevCalls !== null && t.jevCalls !== undefined ? `${fmt(t.jevCalls)} call${t.jevCalls === 1 ? "" : "s"}` : undefined);
  add("kept", "kept by Jev", t.jevKept, t.jevDropped !== null && t.jevDropped !== undefined ? `${fmt(t.jevDropped)} dropped · ${fmt(t.jevReview ?? 0)} to check` : undefined);
  add("drafted", "sentences drafted", t.drafted, t.draftPool !== null && t.draftPool !== undefined ? `of ${fmt(t.draftPool)} pairs without a sentence` : undefined);
  add("verified", "placed links verified", t.verified, t.verifyChecked !== null && t.verifyChecked !== undefined ? `of ${fmt(t.verifyChecked)} checked · ${fmt(t.notFound ?? 0)} not found` : undefined);
  add("saved", "suggestions saved", kind === "analysis" ? t.saved : null);
  return out;
}

// ------------------------------------------------------------------ labels and state

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Oct 2026, 14:02" (local time). */
export function runDate(iso: string | null | undefined): string {
  if (!iso) return "an unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown date";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const KIND_LABEL: Record<LinkLiveKind, string> = { analysis: "link analysis", graph: "link graph rebuild" };

export const DEMO_PREFIX = "Demo project (seeded crawl data)";

/** Strip under the header: what the viewer is looking at, always stated. */
export function modeLabel(run: LinkLiveRunView, mode: "live" | "replay", play: { playing: boolean; paused?: boolean; speed: number; gaps: boolean } | null): string {
  const how = play?.playing ? ` · ${play.speed}× speed${play.gaps ? " · idle gaps over 10 s shortened" : ""}` : play?.paused ? " · paused (▶ plays at stored times, Step shows the next stored event)" : "";
  const base =
    mode === "live"
      ? `Live from this ${KIND_LABEL[run.kind]}'s stored progress events · nothing is projected`
      : `Replay of the ${KIND_LABEL[run.kind]} on ${runDate(run.startedAt)} · real stored events${how}`;
  return run.isDemo ? `${DEMO_PREFIX} · ${base}` : base;
}

export function statusText(run: LinkLiveRunView): { word: string; tone: BadgeTone } {
  switch (run.status) {
    case "running":
      return { word: "Live", tone: "info" };
    case "completed":
      return { word: "Completed", tone: "success" };
    case "partial":
      return { word: "Partial", tone: "warning" };
    case "failed":
      return { word: "Failed", tone: "danger" };
    case "interrupted":
      return { word: "Interrupted", tone: "warning" };
  }
}

/** Poll while the stored run is running, or while this page has a start request in flight. */
export function shouldPoll(run: LinkLiveRunView | null, busy: boolean): boolean {
  return busy || run?.status === "running";
}

/** Merge a page of the live endpoint into the client state (new run id: start over). Events stay sorted by seq. */
export function mergeLive(prev: { run: LinkLiveRunView | null; events: LinkLiveEvent[] } | null, res: LinkLiveResponse): { run: LinkLiveRunView | null; events: LinkLiveEvent[]; cursor: number } {
  if (!res.run) return { run: null, events: [], cursor: 0 };
  const same = prev?.run?.id === res.run.id;
  const base = same ? prev!.events : [];
  const seen = new Set(base.map((e) => e.seq));
  const events = [...base, ...res.events.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
  return { run: res.run, events, cursor: events.length ? events[events.length - 1]!.seq : 0 };
}

/** Query string for the next poll: the cursor only applies to the run it came from. */
export function liveQuery(run: LinkLiveRunView | null, cursor: number): string {
  if (!run) return "";
  const p = new URLSearchParams({ run: run.id, after: String(cursor) });
  return `?${p.toString()}`;
}

/** "0.4 s" under a minute (runs are often short), else "06:42" / "1:03:12"; "--:--" when unknown. */
export function durationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "--:--";
  if (ms < 100) return "under 0.1 s";
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const sec = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`;
}

/** Elapsed ms: live = now - start; finished = finish - start; replay at a playhead = playhead - start. */
export function elapsedMs(run: LinkLiveRunView, nowMs: number, playhead: number | null): number | null {
  const t0 = Date.parse(run.startedAt);
  if (!Number.isFinite(t0)) return null;
  if (playhead !== null) return Math.max(0, playhead - t0);
  if (run.status === "running") return Math.max(0, nowMs - t0);
  const end = Date.parse(run.finishedAt ?? run.updatedAt);
  return Number.isFinite(end) ? Math.max(0, end - t0) : null;
}

/**
 * Step: pause and move the replay playhead to the next stored event's time (several events stored in the same
 * millisecond appear together). From the end, start over at the first event.
 */
export function stepClock(c: ReplayClock, times: readonly number[]): ReplayClock {
  const from = c.finished ? c.t0 - 1 : c.p;
  const next = times.find((t) => t > from);
  if (next === undefined || next >= c.tEnd) return { ...c, p: c.tEnd, playing: false, finished: true };
  return { ...c, p: Math.max(c.t0, next), playing: false, finished: false };
}
