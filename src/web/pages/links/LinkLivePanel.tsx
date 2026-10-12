/**
 * Internal links "Live" panel ([A41], docs/live-view-design.md section 20): what the link agent is doing right now,
 * built only from the progress events the real analysis run / graph rebuild stored (GET .../internal-links/live).
 *
 * - Live (a run is 'running', or this page has a start request in flight): polls every pollMs (1.5 s), one request at
 *   a time, visible tab only; the stage rail pulses on the stage that started and has no final event; counters tween
 *   from the stored totals; source -> target pairs from the events slide into the flow lane with their verdict chips.
 * - Otherwise: the latest run as a labelled replay ("Replay of the link analysis on <date> · real stored events"),
 *   shown at its final state; ▶ Play reveals the stored events at their stored times (1× / 10× / 30×, idle gaps over
 *   10 s shortened, the shared replay clock of the Live view).
 * - prefers-reduced-motion: no slides, pops, pulses or tweens; content still updates.
 * Page paths and anchors are untrusted page text: React text only, never HTML.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { LinkLiveEvent, LinkLiveResponse, LinkLiveRunView } from "@shared/link-live";
import { LINK_LIVE_POLL_MS } from "@shared/link-live";
import { api } from "@web/lib/api";
import { Badge, cx } from "@web/components/ui";
import { advanceClock, DEFAULT_SPEED, hasLongGaps, initClock, MAX_ANIMATED, replayBounds, restartClock, setClockSpeed, skipToEnd, SPEEDS, togglePlay, toMs, type ReplayClock, type Speed } from "../live/engine";
import { AnimatedNumber, LIVE_CSS, PulseDot, Shimmer, useReducedMotion } from "../live/motion";
import {
  CHIP_WORD,
  counters,
  durationText,
  elapsedMs,
  flowRows,
  fmt,
  KIND_LABEL,
  liveQuery,
  mergeLive,
  modeLabel,
  nowWaiting,
  shouldPoll,
  stageRail,
  stepClock,
  statusText,
  totalsFromEvents,
  VERDICT,
  type ChipStatus,
} from "./live-lib";

const CHIP_TONE: Record<ChipStatus, string> = {
  not_started: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  not_reached: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  ended: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  running: "bg-sky-50 text-sky-800 ring-1 ring-sky-300 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-800",
  done: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  partial: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  skipped: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  failed: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
};
const CHIP_GLYPH: Record<ChipStatus, string> = { not_started: "○", not_reached: "○", ended: "■", running: "●", done: "✓", partial: "◐", skipped: "–", failed: "✗" };

const btn =
  "inline-flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs font-medium text-zinc-800 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

export interface LinkLiveViewProps {
  run: LinkLiveRunView | null;
  /** All loaded events of the run, ascending by seq. */
  events: LinkLiveEvent[];
  loading: boolean;
  error: unknown;
  reduced: boolean;
  /** Wall clock for the live elapsed time. */
  nowMs: number;
  /** Replay clock (finished runs); null while live. */
  clock: ReplayClock | null;
  /** Items of events with seq > freshFrom animate in (Infinity: nothing animates). */
  freshFrom: number;
  /** A start request of this page is in flight and its run has not appeared yet. */
  starting: string | null;
  open: boolean;
  onToggle: () => void;
  onRetry?: () => void;
  /** The page's own "Run link analysis" / "Rebuild graph" buttons (same handlers, limits and states). */
  actions: ReactNode;
  replay?: { onToggle: () => void; onStep: () => void; onRestart: () => void; onEnd: () => void; onSpeed: (s: Speed) => void };
}

/** Presentational panel (pure props; tests render it with renderToStaticMarkup). */
export function LinkLiveView(p: LinkLiveViewProps) {
  const headingId = useId();
  const bodyId = useId();
  const { run } = p;
  const live = run?.status === "running";
  const revealed = useMemo(() => (p.clock && !live ? p.events.filter((e) => toMs(e.at) <= p.clock!.p) : p.events), [p.events, p.clock, live]);
  const atEnd = !p.clock || p.clock.finished || revealed.length === p.events.length;
  const runOver = !live && atEnd;
  const playhead = p.clock && !live && !p.clock.finished ? p.clock.p : null;
  const status = run ? statusText(run) : null;
  const elapsed = run ? elapsedMs(run, p.nowMs, playhead) : null;
  const gaps = p.clock ? hasLongGaps(p.events.map((e) => toMs(e.at)), p.clock.t0, p.clock.tEnd) : false;
  const label = run ? modeLabel(run, live ? "live" : "replay", p.clock ? { playing: p.clock.playing, paused: !p.clock.playing && !p.clock.finished, speed: p.clock.speed, gaps } : null) : null;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="link-live"
      data-mode={!run ? "empty" : live ? "live" : "replay"}
      className="lv-root relative min-w-0 overflow-hidden rounded-xl border border-t-2 border-zinc-200 border-t-sky-700 bg-white shadow-sm dark:border-zinc-800 dark:border-t-sky-400 dark:bg-zinc-900"
    >
      <style>{LIVE_CSS}</style>
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3 pb-2">
        <h2 id={headingId} className="flex min-w-0 items-center gap-2 text-base font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          {live ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded bg-sky-700 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-white dark:bg-sky-400 dark:text-zinc-950">
              <PulseDot tone="sky" className={p.reduced ? "[&>span:first-child]:hidden" : undefined} />
              LIVE
            </span>
          ) : run ? (
            <span className="shrink-0 rounded bg-zinc-700 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-white dark:bg-zinc-300 dark:text-zinc-950">REPLAY</span>
          ) : null}
          <span className="min-w-0 truncate">What the link agent is doing</span>
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          {run && status && (
            <Badge tone={status.tone} title={`The ${KIND_LABEL[run.kind]}'s stored status`}>
              {KIND_LABEL[run.kind]} · {status.word}
            </Badge>
          )}
          {run && (
            <span className="font-mono text-zinc-700 tabular-nums dark:text-zinc-300" title={live ? "Wall-clock time since the run started" : "Run time from its stored start and end"}>
              {live ? "elapsed" : playhead !== null ? "run time" : "took"} {durationText(elapsed)}
            </span>
          )}
          <button type="button" className={btn} aria-expanded={p.open} aria-controls={bodyId} onClick={p.onToggle}>
            {p.open ? "Hide" : "Show"}
          </button>
        </div>
      </header>

      {label && (
        <p role="note" className="mx-4 mb-2 rounded-md bg-zinc-50 px-2 py-1 text-[11px] text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
          {label}
        </p>
      )}

      <div id={bodyId} hidden={!p.open} className="min-w-0 space-y-3 px-4 pb-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {p.actions}
          {p.replay && p.clock && !live && <ReplayButtons clock={p.clock} {...p.replay} />}
        </div>
        {p.starting && (
          <p role="status" className="text-xs">
            <Shimmer label={p.starting} />
          </p>
        )}
        {p.error ? (
          <p className="text-xs text-rose-700 dark:text-rose-300">
            Could not load the live progress.{" "}
            {p.onRetry && (
              <button type="button" className="underline" onClick={p.onRetry}>
                Retry
              </button>
            )}
          </p>
        ) : null}
        {!run ? (
          p.loading ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading the latest run…</p>
          ) : (
            <p className="rounded-lg border border-dashed border-zinc-300 px-3 py-4 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
              No link analysis or graph rebuild has been recorded yet. Start one with the buttons above: each stage (graph, placed-link
              checks, candidate pairs, Jev judging, drafted sentences, saving) shows here as the run stores it.
            </p>
          )
        ) : (
          <RunBody run={run} events={revealed} live={live} runOver={runOver} reduced={p.reduced} freshFrom={p.freshFrom} final={atEnd} />
        )}
      </div>
    </section>
  );
}

function ReplayButtons({ clock, onToggle, onStep, onRestart, onEnd, onSpeed }: { clock: ReplayClock } & NonNullable<LinkLiveViewProps["replay"]>) {
  return (
    <div role="toolbar" aria-label="Replay controls" className="flex min-w-0 flex-wrap items-center gap-1.5">
      <button type="button" className={btn} onClick={onToggle} aria-label={clock.playing ? "Pause replay" : "Play replay of the stored events"}>
        <span aria-hidden="true">{clock.playing ? "❚❚" : "▶"}</span>
        <span>{clock.playing ? "Pause" : clock.finished ? "Replay" : "Play"}</span>
      </button>
      <button type="button" className={btn} onClick={onStep} aria-label="Show the next stored event">
        <span>Step</span>
        <span aria-hidden="true">›</span>
      </button>
      <button type="button" className={btn} onClick={onRestart} aria-label="Restart replay">
        <span aria-hidden="true">⏮</span>
      </button>
      <button type="button" className={btn} onClick={onEnd} aria-label="Skip to end">
        <span aria-hidden="true">⏭</span>
      </button>
      <div role="group" aria-label="Replay speed" className="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={clock.speed === s}
            onClick={() => onSpeed(s)}
            className={cx(
              "px-2 py-0.5 font-mono text-xs focus-visible:outline-2 focus-visible:outline-sky-600",
              clock.speed === s ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-700 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300",
            )}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}

function RunBody({ run, events, live, runOver, reduced, freshFrom, final }: { run: LinkLiveRunView; events: LinkLiveEvent[]; live: boolean; runOver: boolean; reduced: boolean; freshFrom: number; final: boolean }) {
  const chips = stageRail(run.kind, events, runOver, run.status === "failed");
  const totals = final ? { ...totalsFromEvents(events), ...run.totals } : totalsFromEvents(events);
  const stats = counters(run.kind, totals);
  const waiting = nowWaiting(events, live);
  const rows = flowRows(events);
  const totalPairs = flowRows(events, Number.MAX_SAFE_INTEGER).length;
  const last = events[events.length - 1];
  const endNote = runOver && last?.stage === "run" && last.status !== "started" ? (last.detail.note ?? null) : null;
  let animated = 0;
  return (
    <>
      <ol aria-label="Stages" className="lv-strip relative flex min-w-0 items-stretch gap-1 overflow-x-auto pb-1 text-[11px]">
        {chips.map((c, i) => (
          <li key={c.id} className="flex shrink-0 items-center gap-1">
            {i > 0 && (
              <span aria-hidden="true" className="text-zinc-400">
                ▸
              </span>
            )}
            <span data-chip={c.id} data-status={c.status} className={cx("inline-flex flex-col rounded-md px-2 py-1", CHIP_TONE[c.status])}>
              <span className="inline-flex items-center gap-1 font-semibold">
                <span aria-hidden="true" className={cx(c.status === "running" && !reduced && "lv-pulse")}>
                  {CHIP_GLYPH[c.status]}
                </span>
                {c.label}
                <span className="sr-only"> {CHIP_WORD[c.status]}</span>
              </span>
              <span className="font-mono text-[10px] font-normal tabular-nums">{c.count ?? (c.status === "running" ? "started" : CHIP_WORD[c.status])}</span>
            </span>
          </li>
        ))}
      </ol>

      {stats.length > 0 && (
        <dl className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {stats.map((s) => (
            <div key={s.key} className="min-w-0 rounded-lg border border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
              <dt className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">{s.label}</dt>
              <dd className="text-lg leading-tight font-semibold text-zinc-950 dark:text-zinc-50">
                <AnimatedNumber value={s.value} reduced={reduced} />
              </dd>
              {s.sub && <dd className="truncate text-[10px] text-zinc-500 dark:text-zinc-400">{s.sub}</dd>}
            </div>
          ))}
        </dl>
      )}

      {(live || waiting || endNote || run.status === "interrupted") && (
        <p role="status" aria-live="polite" className="min-h-5 text-xs text-zinc-700 dark:text-zinc-300">
          {waiting ? <Shimmer label={waiting} /> : endNote ? <span>{endNote}</span> : run.status === "interrupted" ? <span>No stored update for 10 minutes: the run stopped without a final event.</span> : null}
        </p>
      )}

      <div className="min-w-0">
        <h3 className="mb-1 text-xs font-semibold text-zinc-800 dark:text-zinc-200">Link flow</h3>
        {rows.length === 0 ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{live || !final ? "No source → target pair has been stored yet at this point of the run." : "This run stored no source → target pairs."}</p>
        ) : (
          <ol aria-label="Link flow" aria-live="off" className="relative max-h-96 min-w-0 space-y-1 overflow-y-auto" data-panel-body>
            {rows.map((r) => {
              const fresh = r.firstSeq > freshFrom && animated < MAX_ANIMATED;
              if (fresh) animated++;
              return (
                <li
                  key={r.key}
                  data-flow-row
                  className={cx("min-w-0 rounded-md border border-zinc-100 px-2 py-1 text-xs dark:border-zinc-800", fresh && !reduced && "lv-row-in")}
                >
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                    <span className="min-w-0 font-mono break-all text-zinc-900 dark:text-zinc-100">{r.source}</span>
                    <span aria-hidden="true" className="text-zinc-400">
                      ⟶
                    </span>
                    <span className="sr-only">links to</span>
                    <span className="min-w-0 font-mono break-all text-sky-800 dark:text-sky-300">{r.target}</span>
                  </div>
                  <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1">
                    {r.anchor && <span className="min-w-0 break-words text-zinc-600 dark:text-zinc-400">anchor “{r.anchor}”</span>}
                    {r.priority !== null && <span className="font-mono text-[10px] text-zinc-500 tabular-nums">priority {r.priority.toFixed(2)}</span>}
                    {r.chips.map((c) => (
                      <Badge key={`${c.v}-${c.seq}`} tone={VERDICT[c.v].tone} className={cx("text-[10px]", c.seq > freshFrom && !reduced && "lv-pop")}>
                        {VERDICT[c.v].label}
                      </Badge>
                    ))}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {totalPairs > rows.length && (
          <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            Showing the {fmt(rows.length)} most recently updated of {fmt(totalPairs)} pairs stored as samples (at most 20 per stage event).
          </p>
        )}
        {run.eventsDropped > 0 && final && <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">{fmt(run.eventsDropped)} progress events were not stored (400 per run).</p>}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ container (fetch, poll, replay clock)

const OPEN_KEY = "okara.links.live.open";
const readOpen = (): boolean | null => {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
};
const writeOpen = (v: boolean) => {
  try {
    localStorage.setItem(OPEN_KEY, v ? "1" : "0");
  } catch {
    /* per-viewer convenience only */
  }
};

export function LinkLivePanel({ base, busy, starting, actions, onFinished }: { base: string; busy: boolean; starting: string | null; actions: ReactNode; onFinished: () => void }) {
  const reduced = useReducedMotion();
  const [state, setState] = useState<{ run: LinkLiveRunView | null; events: LinkLiveEvent[]; cursor: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pollMs, setPollMs] = useState(LINK_LIVE_POLL_MS);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const fetchPages = useCallback(async () => {
    try {
      for (let page = 0; page < 5; page++) {
        const cur = stateRef.current;
        const res = await api<LinkLiveResponse>(`${base}/live${liveQuery(cur?.run ?? null, cur?.cursor ?? 0)}`);
        const prev = stateRef.current;
        const next = mergeLive(prev, res);
        if (prev?.run && prev.run.id === next.run?.id && prev.run.status === "running" && next.run?.status !== "running") onFinishedRef.current();
        stateRef.current = next;
        setState(next);
        setPollMs(Math.max(1_000, Math.min(5_000, res.pollMs || LINK_LIVE_POLL_MS)));
        setError(null);
        if (!res.hasMore) break;
      }
    } catch (e) {
      setError(e);
    }
  }, [base]);

  useEffect(() => {
    void fetchPages();
  }, [fetchPages]);

  // Poll while the stored run is running or a start request of this page is in flight; one request at a time,
  // visible tab only. When the request ends, one more fetch picks up the final events.
  const run = state?.run ?? null;
  const polling = shouldPoll(run, busy);
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      if (typeof document === "undefined" || document.visibilityState === "visible") await fetchPages();
      if (!stopped) timer = setTimeout(() => void tick(), pollMs);
    };
    timer = setTimeout(() => void tick(), pollMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, pollMs, fetchPages]);
  const wasPolling = useRef(polling);
  useEffect(() => {
    if (wasPolling.current && !polling) void fetchPages();
    wasPolling.current = polling;
  }, [polling, fetchPages]);

  // Elapsed clock (the only timer, design section 0 rule 2): ticks while the stored run is running.
  const live = run?.status === "running";
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [live]);

  // Open while something runs; otherwise the viewer's last choice (default: open until a run exists, then closed).
  const [openChoice, setOpenChoice] = useState<boolean | null>(() => readOpen());
  // A run watched on this page stays open after it ends (its result is right there), until the viewer hides it.
  useEffect(() => {
    if (live || busy) setOpenChoice(true);
  }, [live, busy]);
  const open = live || busy ? true : (openChoice ?? (state !== null && run === null));
  const toggle = () => {
    const v = !open;
    setOpenChoice(v);
    writeOpen(v);
  };

  // Replay clock over the finished run's stored events (starts at the end: the final state).
  const events = state?.events ?? [];
  const times = useMemo(() => events.map((e) => toMs(e.at)), [events]);
  const runKey = run && !live ? `${run.id}:${run.status}:${events.length}` : null;
  const [clock, setClock] = useState<ReplayClock | null>(null);
  useEffect(() => {
    if (!runKey || !run) {
      setClock(null);
      return;
    }
    const b = replayBounds({ startedAt: run.startedAt, createdAt: run.startedAt, finishedAt: run.finishedAt }, times.map((t) => ({ t })));
    setClock((c) => skipToEnd(initClock(b, c?.speed ?? DEFAULT_SPEED, false)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);
  const playing = clock?.playing ?? false;
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame === "undefined") return;
    let raf = 0;
    let last = performance.now();
    const step = () => {
      const t = performance.now();
      const dt = t - last;
      last = t;
      setClock((c) => (c ? advanceClock(c, dt, times) : c));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, times]);

  // Freshness: only events revealed since the previous render animate; the first paint of a run never does.
  const revealedCount = clock && !live ? times.filter((t) => t <= clock.p).length : events.length;
  const fresh = useRef<{ id: string | null; count: number; from: number }>({ id: null, count: 0, from: Number.POSITIVE_INFINITY });
  if (fresh.current.id !== (run?.id ?? null)) fresh.current = { id: run?.id ?? null, count: revealedCount, from: Number.POSITIVE_INFINITY };
  else if (revealedCount !== fresh.current.count) {
    const from = revealedCount > fresh.current.count ? (events[fresh.current.count - 1]?.seq ?? 0) : Number.POSITIVE_INFINITY;
    fresh.current = { id: fresh.current.id, count: revealedCount, from };
  }

  const startingLabel = starting && (!run || run.status !== "running") ? starting : null;

  return (
    <LinkLiveView
      run={run}
      events={events}
      loading={state === null && !error}
      error={error}
      reduced={reduced}
      nowMs={nowMs}
      clock={clock}
      freshFrom={fresh.current.from}
      starting={startingLabel}
      open={open}
      onToggle={toggle}
      onRetry={() => void fetchPages()}
      actions={actions}
      replay={{
        onToggle: () => setClock((c) => (c ? togglePlay(c) : c)),
        onStep: () => setClock((c) => (c ? stepClock(c, times) : c)),
        onRestart: () => setClock((c) => (c ? restartClock(c) : c)),
        onEnd: () => setClock((c) => (c ? skipToEnd(c) : c)),
        onSpeed: (s) => setClock((c) => (c ? setClockSpeed(c, s) : c)),
      }}
    />
  );
}
