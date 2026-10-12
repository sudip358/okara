/**
 * [A41] Progress log for the link agent's work (internal links "Live" panel, 2026-10-12). OWNED BY: internal-links.
 *
 * Approach: the work stays SYNCHRONOUS in its request (POST .../internal-links/run and POST .../graph/rebuild return
 * the same payloads as before, and Ask Okara's confirmed actions call the same functions). While the request runs,
 * the real code paths append events to `link_live_events` at their stage boundaries, and the page polls
 * GET .../internal-links/live from a second request during the first one. Nothing is simulated: an event is written
 * only when the code reached that point, with the counts it computed.
 *
 * Writes are buffered and stored in a few D1 batches per run (start, before each wait: graph load, graph save, Jev,
 * each writer call, suggestion save, end). Jev batch events ride in the same D1 batch as that Jev batch's decision
 * records (no extra round trip). A failure to write progress never fails the run: the recorder disables itself.
 *
 * Bounds: at most MAX_EVENTS_PER_RUN events per run (the final 'run' event is always stored; others beyond the cap
 * are counted as dropped), at most MAX_ITEMS_PER_EVENT items per event with clipped plain-text paths and anchors, and
 * detail_json at most MAX_DETAIL_CHARS; the latest LIVE_RUNS_KEPT tracked runs per project are kept.
 */
import type {
  LinkLiveDetail,
  LinkLiveEvent,
  LinkLiveEventStatus,
  LinkLiveItem,
  LinkLiveKind,
  LinkLiveResponse,
  LinkLiveRunView,
  LinkLiveStage,
  LinkLiveTotals,
  LinkLiveVerdict,
} from "@shared/link-live";
import { LINK_LIVE_PAGE_MAX, LINK_LIVE_POLL_MS } from "@shared/link-live";
import type { Db } from "../lib/db";
import { insertStatement, parseJson } from "../lib/db";
import { newId } from "../lib/ids";
import { addSeconds, iso, systemClock, type Clock } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { multiRowInsert, runBatches } from "./sql";

export const LINK_LIVE_VERSION = "links-live-2026-10-12.1";
export const MAX_EVENTS_PER_RUN = 400;
export const MAX_ITEMS_PER_EVENT = 20;
export const MAX_DETAIL_CHARS = 4_000;
export const LIVE_RUNS_KEPT = 5;
/** A 'running' run with no stored update for this long is reported as interrupted (same as the run guards). */
export const LIVE_STALE_SECONDS = 10 * 60;
const PATH_MAX = 160;
const ANCHOR_MAX = 120;
const NOTE_MAX = 300;

type Scope = Pick<ProjectRow, "id" | "workspace_id" | "is_demo">;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Path + query of a URL (or URL key) for display; the clipped input when it does not parse. */
export function livePath(u: string): string {
  try {
    const x = new URL(u);
    return clip(`${x.pathname}${x.search}` || "/", PATH_MAX);
  } catch {
    return clip(u, PATH_MAX);
  }
}

export function pairItem(sourceUrl: string, targetUrl: string, v: LinkLiveVerdict, anchor?: string | null, priority?: number): LinkLiveItem {
  const it: LinkLiveItem = { s: livePath(sourceUrl), t: livePath(targetUrl), v };
  if (anchor) it.a = clip(anchor.replace(/\s+/g, " ").trim(), ANCHOR_MAX);
  if (priority !== undefined && Number.isFinite(priority)) it.p = Math.round(priority * 1000) / 1000;
  return it;
}

/** detail_json bounded: items capped, strings clipped, and items halved until the JSON fits MAX_DETAIL_CHARS. */
export function boundDetail(d: LinkLiveDetail): string {
  const out: LinkLiveDetail = {};
  if (d.n) {
    const n: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.n).slice(0, 24)) if (typeof v === "number" && Number.isFinite(v)) n[k.slice(0, 40)] = v;
    out.n = n;
  }
  if (d.note) out.note = clip(d.note, NOTE_MAX);
  let items = (d.items ?? []).slice(0, MAX_ITEMS_PER_EVENT).map((i) => ({ ...i, s: clip(i.s, PATH_MAX), t: clip(i.t, PATH_MAX), ...(i.a ? { a: clip(i.a, ANCHOR_MAX) } : {}) }));
  for (;;) {
    const json = JSON.stringify(items.length ? { ...out, items } : out);
    if (json.length <= MAX_DETAIL_CHARS) return json;
    if (!items.length) return JSON.stringify({ note: "Detail too large to store." });
    items = items.slice(0, Math.floor(items.length / 2));
  }
}

interface Pending {
  seq: number;
  at: string;
  stage: LinkLiveStage;
  status: LinkLiveEventStatus;
  detail: string;
}

const EVENT_COLUMNS = ["live_run_id", "workspace_id", "project_id", "seq", "at", "stage", "status", "detail_json"] as const;

/** Buffered progress recorder for one tracked run. Every method is safe to call after a write failure (no-op). */
export class LinkProgress {
  private seq = 0;
  private buf: Pending[] = [];
  private stored = 0;
  private dropped = 0;
  private done = false;
  private disabled: boolean;
  readonly totals: LinkLiveTotals = {};

  private constructor(
    private readonly db: Db | null,
    private readonly scope: Scope | null,
    readonly id: string | null,
    private readonly clock: Clock,
  ) {
    this.disabled = !db || !scope || !id;
  }

  /** A recorder that records nothing (graph builds after a crawl, the demo seed). */
  static none(): LinkProgress {
    return new LinkProgress(null, null, null, systemClock);
  }

  /**
   * Starts a tracked run: prunes the project's older tracked runs (keeps LIVE_RUNS_KEPT including this one), inserts
   * the run row and its first event in one D1 batch. Returns a disabled recorder when that fails (e.g. migration 0024
   * not applied), so the work itself never fails because of progress.
   */
  static async start(db: Db, project: Scope, opts: { kind: LinkLiveKind; refId: string | null; userId?: string | null; clock?: Clock; note?: string }): Promise<LinkProgress> {
    const clock = opts.clock ?? systemClock;
    const id = newId("llive");
    const rec = new LinkProgress(db, project, id, clock);
    const at = iso(clock());
    const old = `SELECT id FROM link_live_runs WHERE workspace_id = ? AND project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?`;
    rec.emit("run", "started", { note: opts.note ?? (opts.kind === "analysis" ? "Link analysis started." : "Link graph rebuild started.") });
    const stmts: Array<[string, ...unknown[]]> = [
      [`DELETE FROM link_live_events WHERE workspace_id = ? AND project_id = ? AND live_run_id IN (${old})`, project.workspace_id, project.id, project.workspace_id, project.id, LIVE_RUNS_KEPT - 1],
      [`DELETE FROM link_live_runs WHERE workspace_id = ? AND project_id = ? AND id IN (${old})`, project.workspace_id, project.id, project.workspace_id, project.id, LIVE_RUNS_KEPT - 1],
      insertStatement("link_live_runs", {
        id,
        workspace_id: project.workspace_id,
        project_id: project.id,
        kind: opts.kind,
        ref_id: opts.refId,
        status: "running",
        is_demo: project.is_demo === 1 ? 1 : 0,
        totals_json: "{}",
        created_by: opts.userId ?? null,
        started_at: at,
        updated_at: at,
      }),
      ...rec.drain(),
    ];
    try {
      await runBatches(db, stmts);
    } catch {
      rec.disabled = true;
    }
    return rec;
  }

  get active(): boolean {
    return !this.disabled;
  }

  /** Buffers one event (not stored until the next flush or piggybacked batch). */
  emit(stage: LinkLiveStage, status: LinkLiveEventStatus, detail: LinkLiveDetail = {}): void {
    if (this.disabled || this.done) return;
    const final = stage === "run" && status !== "started";
    if (this.seq >= MAX_EVENTS_PER_RUN && !final) {
      this.dropped++;
      return;
    }
    this.seq++;
    this.buf.push({ seq: this.seq, at: iso(this.clock()), stage, status, detail: boundDetail(detail) });
  }

  /** Merges stage totals (stored with the next flush). */
  total(t: Partial<LinkLiveTotals>): void {
    Object.assign(this.totals, t);
  }

  /** The buffered events and the run row's totals as statements, for a caller's own D1 batch (buffer cleared). */
  drain(): Array<[string, ...unknown[]]> {
    if (this.disabled || !this.scope || !this.id || this.buf.length === 0) return [];
    const rows = this.buf.map((e) => [this.id, this.scope!.workspace_id, this.scope!.id, e.seq, e.at, e.stage, e.status, e.detail]);
    const at = this.buf[this.buf.length - 1]!.at;
    this.stored += this.buf.length;
    this.buf = [];
    return [
      ...multiRowInsert("link_live_events", EVENT_COLUMNS, rows),
      [
        "UPDATE link_live_runs SET totals_json = ?, events_stored = ?, events_dropped = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?",
        JSON.stringify(this.totals),
        this.stored,
        this.dropped,
        at,
        this.id,
        this.scope.workspace_id,
        this.scope.id,
      ],
    ];
  }

  /** Stores buffered events now (one D1 batch). Never throws. */
  async flush(): Promise<void> {
    const stmts = this.drain();
    if (!stmts.length || !this.db) return;
    try {
      await runBatches(this.db, stmts);
    } catch {
      this.disabled = true;
    }
  }

  /** Final event + status. Never throws; later emits are ignored. */
  async finish(status: "completed" | "partial" | "failed", detail: LinkLiveDetail = {}): Promise<void> {
    if (this.disabled || this.done || !this.db || !this.scope) return;
    this.emit("run", status, detail);
    const stmts = this.drain();
    this.done = true;
    const at = iso(this.clock());
    stmts.push(["UPDATE link_live_runs SET status = ?, finished_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?", status, at, at, this.id, this.scope.workspace_id, this.scope.id]);
    try {
      await runBatches(this.db, stmts);
    } catch {
      this.disabled = true;
    }
  }
}

// ------------------------------------------------------------------------------------ read (GET .../live)

interface RunRow {
  id: string;
  kind: LinkLiveKind;
  status: "running" | "completed" | "partial" | "failed";
  is_demo: number;
  totals_json: string;
  events_stored: number;
  events_dropped: number;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface LinkLiveQuery {
  after: number;
  runId: string | null;
  limit: number;
}

export function toRunView(r: RunRow, now: Date): LinkLiveRunView {
  const stale = r.status === "running" && r.updated_at <= iso(addSeconds(now, -LIVE_STALE_SECONDS));
  return {
    id: r.id,
    kind: r.kind,
    status: stale ? "interrupted" : r.status,
    isDemo: r.is_demo === 1,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
    totals: parseJson<LinkLiveTotals>(r.totals_json, {}),
    eventsStored: r.events_stored,
    eventsDropped: r.events_dropped,
  };
}

/**
 * The project's latest tracked run and its events after the cursor. The cursor applies only when `runId` names that
 * latest run; otherwise (a newer run started, or no run given) events start from the beginning.
 */
export async function linkLive(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, q: LinkLiveQuery, now: Date): Promise<LinkLiveResponse> {
  const limit = Math.max(1, Math.min(LINK_LIVE_PAGE_MAX, Math.floor(q.limit)));
  let run: RunRow | null = null;
  try {
    run = await db.first<RunRow>(
      `SELECT id, kind, status, is_demo, totals_json, events_stored, events_dropped, started_at, updated_at, finished_at FROM link_live_runs
        WHERE workspace_id = ? AND project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      project.workspace_id,
      project.id,
    );
  } catch {
    run = null; // migration 0024 not applied
  }
  if (!run) return { run: null, events: [], nextCursor: 0, hasMore: false, pollMs: LINK_LIVE_POLL_MS };
  const after = q.runId === run.id ? Math.max(0, Math.floor(q.after)) : 0;
  const rows = await db.all<{ seq: number; at: string; stage: LinkLiveStage; status: LinkLiveEventStatus; detail_json: string }>(
    `SELECT seq, at, stage, status, detail_json FROM link_live_events
      WHERE workspace_id = ? AND project_id = ? AND live_run_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    project.workspace_id,
    project.id,
    run.id,
    after,
    limit + 1,
  );
  const page = rows.slice(0, limit);
  const events: LinkLiveEvent[] = page.map((r) => ({ seq: r.seq, at: r.at, stage: r.stage, status: r.status, detail: parseJson<LinkLiveDetail>(r.detail_json, {}) }));
  return {
    run: toRunView(run, now),
    events,
    nextCursor: events.length ? events[events.length - 1]!.seq : after,
    hasMore: rows.length > limit,
    pollMs: LINK_LIVE_POLL_MS,
  };
}
