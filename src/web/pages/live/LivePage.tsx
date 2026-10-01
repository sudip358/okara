/**
 * Live view (docs/live-view-design.md): a mission-control visual analysis of what the SEO and GEO agents
 * are doing, built only from stored rows of real runs.
 *
 * - LIVE: while the shown run is pending/running, the 2 s heartbeat (+ feed on signal) brings new stored
 *   rows; rows animate as they ARRIVE. Nothing ticks on a timer except the elapsed clock.
 * - REPLAY: a finished run's stored events are played back in (at, id) order on a time-compressed clock
 *   (1× / 10× / 30×), labelled "Replay of the run on <date> · real stored events · N× speed".
 * - Demo projects replay their seeded runs, labelled "Demo data - simulated run".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import type { EngineBoardResponse } from "@shared/types";
import { useApi } from "@web/lib/hooks";
import { useProject } from "@web/lib/project-context";
import { Button, DemoBanner, EmptyState, ErrorState, LoadingState, cx } from "@web/components/ui";
import { RunNowButton } from "@web/components/RunNowButton";
import { elapsedMs } from "@web/components/activity/lib";
import { boardPaths } from "@web/pages/geo/board/data";
import {
  DEFAULT_SPEED,
  MAX_EVENTS,
  advanceClock,
  animatedIds,
  arrivalSummary,
  buildTimeline,
  callTicks,
  decisionCounts,
  hasLongGaps,
  initClock,
  itemsOf,
  parseSpeed,
  pauseClock,
  pickLiveRun,
  replayBounds,
  restartClock,
  revealCount,
  seekClock,
  setClockSpeed,
  skipToEnd,
  spendSoFar,
  togglePlay,
  type ReplayClock,
  type Speed,
  type TimelineEvent,
} from "./engine";
import { useCurrentRuns } from "./current-store";
import { useGeoProjectData, useLiveRun, useRunList, useSeoProjectData } from "./data";
import { GeoBoard } from "./GeoBoard";
import { LiveHeader, LivePill } from "./LiveHeader";
import { LIVE_CSS, useReducedMotion } from "./motion";
import { ReplayControls } from "./ReplayControls";
import { RunRail } from "./RunRail";
import { SeoBoard } from "./SeoBoard";
import { LIVE_TEXT, clockText, fmtInt, pillText, spendPhrase, spendSoFarText, urlHost, type LiveMode } from "./text";

const SPEED_KEY = "okara.live.speed";
const ANNOUNCE_EVERY_MS = 5_000;
const NO_EVENTS: TimelineEvent[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

function readSpeed(): Speed {
  try {
    return parseSpeed(globalThis.localStorage?.getItem(SPEED_KEY));
  } catch {
    return DEFAULT_SPEED;
  }
}
function writeSpeed(s: Speed) {
  try {
    globalThis.localStorage?.setItem(SPEED_KEY, String(s));
  } catch {
    /* per-viewer convenience only */
  }
}

/** Wall clock ticking every second while `on` (elapsed time of a live run). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Replay clock: advances every 100 ms of visible wall time by dt × speed (idle gaps shortened in the engine). */
function useReplayClock(times: number[], bounds: { t0: number; tEnd: number } | null, enabled: boolean) {
  const [clock, setClock] = useState<ReplayClock | null>(null);
  const timesRef = useRef(times);
  timesRef.current = times;
  const t0 = bounds?.t0 ?? null;
  const tEnd = bounds?.tEnd ?? null;
  useEffect(() => {
    if (!enabled || t0 === null || tEnd === null) {
      setClock(null);
      return;
    }
    setClock(initClock({ t0, tEnd }, readSpeed(), true));
  }, [enabled, t0, tEnd]);
  const playing = clock?.playing ?? false;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(250, now - last);
      last = now;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      setClock((c) => (c ? advanceClock(c, dt, timesRef.current) : c));
    }, 100);
    return () => clearInterval(t);
  }, [playing]);
  return [clock, setClock] as const;
}

export function LivePage() {
  const { project, projectId } = useProject();
  const [params, setParams] = useSearchParams();
  const reduced = useReducedMotion();
  const requested = params.get("run");
  const modeParam = params.get("mode") === "geo" ? "geo" : params.get("mode") === "seo" ? "seo" : null;
  const current = useCurrentRuns(projectId);
  const needList = !!modeParam && !requested && current.runs !== null && !current.runs.some((r) => r.agent === modeParam);
  const list = useRunList(projectId, needList);
  const picked = pickLiveRun(current.runs, requested, modeParam, list.data);
  // Pin the run on screen so a finishing / new run does not swap it away; "Watch live" switches explicitly.
  const pinKey = `${projectId}|${requested ?? ""}|${modeParam ?? ""}`;
  const [pin, setPin] = useState<{ key: string; id: string | null }>({ key: pinKey, id: null });
  const pinned = pin.key === pinKey ? pin.id : null;
  useEffect(() => {
    if (picked && !pinned) setPin({ key: pinKey, id: picked });
  }, [picked, pinned, pinKey]);
  const runId = requested ?? pinned ?? picked;

  const live = useLiveRun(projectId, runId);
  const activity = live.activity;
  const agent: "seo" | "geo" = activity?.run.agent ?? modeParam ?? "seo";

  // ------------------------------------------------------------------ mode
  const watchedLive = useRef<string | null>(null);
  if (activity?.active) watchedLive.current = activity.run.id;
  const [replayAsked, setReplayAsked] = useState(false);
  useEffect(() => setReplayAsked(false), [runId]);
  let mode: LiveMode = "replay";
  if (activity?.active) mode = activity.run.status === "pending" ? "pending" : "live";
  else if (activity && watchedLive.current === activity.run.id && !replayAsked) mode = "finished";

  // ------------------------------------------------------------------ timeline + replay clock
  const timeline = useMemo(
    () => buildTimeline(live.items, { elements: live.seo?.elements, queries: live.seo?.queries, recommendations: live.seo?.recommendations ?? live.geo?.recommendations, answers: live.geo?.answers }),
    [live.items, live.seo, live.geo],
  );
  const times = useMemo(() => timeline.map((e) => e.t), [timeline]);
  const replayOn = mode === "replay" && !!activity && !live.loading;
  const bounds = useMemo(() => (activity ? replayBounds(activity.run, timeline) : null), [activity, timeline]);
  const [clock, setClock] = useReplayClock(times, replayOn ? bounds : null, replayOn);
  const playhead = replayOn && clock ? clock.p : null;
  const replaying = playhead !== null;
  const atEnd = !replaying || !!clock?.finished;
  const n = revealCount(timeline, playhead);
  const revealed = useMemo(() => (n === timeline.length ? timeline : timeline.slice(0, n)), [timeline, n]);
  const upcoming = useMemo(() => (replaying ? timeline.slice(n, n + 600) : NO_EVENTS), [timeline, n, replaying]);
  const gaps = useMemo(() => (bounds ? hasLongGaps(times, bounds.t0, bounds.tEnd) : false), [times, bounds]);

  // ------------------------------------------------------------------ arrivals: motion + throttled announcements
  const [fresh, setFresh] = useState<ReadonlySet<string>>(NO_IDS);
  const prevN = useRef(0);
  const [announce, setAnnounce] = useState("");
  const pendingAnnounce = useRef<TimelineEvent[]>([]);
  const lastAnnounce = useRef(0);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueAnnounce = useCallback((evs: TimelineEvent[]) => {
    if (evs.length === 0) return;
    pendingAnnounce.current = pendingAnnounce.current.concat(evs).slice(-500);
    const flush = () => {
      announceTimer.current = null;
      const text = arrivalSummary(pendingAnnounce.current);
      pendingAnnounce.current = [];
      lastAnnounce.current = Date.now();
      if (text) setAnnounce(text);
    };
    const since = Date.now() - lastAnnounce.current;
    if (since >= ANNOUNCE_EVERY_MS) flush();
    else if (!announceTimer.current) announceTimer.current = setTimeout(flush, ANNOUNCE_EVERY_MS - since);
  }, []);
  useEffect(() => () => void (announceTimer.current && clearTimeout(announceTimer.current)), []);
  // Live arrivals (after the initial backlog).
  useEffect(() => {
    if (replaying || live.arrivals.seq === 0) return;
    const evs = timeline.filter((e) => live.arrivals.ids.has(e.id));
    setFresh(animatedIds(evs));
    queueAnnounce(evs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.arrivals.seq]);
  // Replay reveals.
  useEffect(() => {
    if (!replaying) {
      prevN.current = n;
      return;
    }
    if (n > prevN.current) {
      const evs = timeline.slice(prevN.current, n);
      setFresh(animatedIds(evs));
      queueAnnounce(evs);
    } else if (n < prevN.current) setFresh(NO_IDS);
    prevN.current = n;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, replaying]);
  // Run state changes are announced at once.
  const finishedSeen = useRef<string | null>(null);
  useEffect(() => {
    if (mode === "finished" && activity && finishedSeen.current !== activity.run.id) {
      finishedSeen.current = activity.run.id;
      setAnnounce("Run finished.");
    }
  }, [mode, activity]);
  useEffect(() => {
    if (clock?.finished) setAnnounce("Replay finished.");
  }, [clock?.finished]);

  // ------------------------------------------------------------------ project-level data
  const items = useMemo(() => itemsOf(revealed), [revealed]);
  const terminal = (step: string) => {
    for (let i = live.items.length - 1; i >= 0; i--) {
      const d = live.items[i]!.detail ?? "";
      if (live.items[i]!.kind === "step" && d.startsWith(`${step} · `) && !d.endsWith("· started")) return live.items[i]!.id;
    }
    return "";
  };
  const laneTerminalKey = live.items.filter((i) => i.kind === "step" && i.detail?.startsWith("geo_batch:") && !i.detail.endsWith("· started")).length;
  const seoData = useSeoProjectData(projectId, agent === "seo" && !!activity, { gsc: terminal("seo.gsc_sync"), recommend: terminal("seo.recommend") });
  const geoData = useGeoProjectData(projectId, agent === "geo" && !!activity, { batch: terminal("geo.batch"), proposals: terminal("geo.proposals"), lanes: String(laneTerminalKey) });
  const seoBoard = useApi<EngineBoardResponse>(agent === "seo" && activity ? boardPaths.board(projectId) : null);
  const boardLanes = (agent === "geo" ? geoData.board.data : seoBoard.data)?.lanes ?? [];

  // ------------------------------------------------------------------ full screen / focus mode
  const rootRef = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  useEffect(() => {
    const on = () => setFs(typeof document !== "undefined" && document.fullscreenElement === rootRef.current && !!rootRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else if (focusMode) setFocusMode(false);
    else if (document.fullscreenEnabled && el.requestFullscreen) el.requestFullscreen().catch(() => setFocusMode(true));
    else setFocusMode(true);
  }, [focusMode]);

  // ------------------------------------------------------------------ replay actions
  const act = useCallback((f: (c: ReplayClock) => ReplayClock) => setClock((c) => (c ? f(c) : c)), [setClock]);
  const onSpeed = useCallback(
    (s: Speed) => {
      writeSpeed(s);
      act((c) => setClockSpeed(c, s));
    },
    [act],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    const tag = t.tagName;
    const isRange = tag === "INPUT" && (t as HTMLInputElement).type === "range";
    if ((tag === "INPUT" && !isRange) || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return;
    if (e.key === "Escape" && focusMode) {
      setFocusMode(false);
      return;
    }
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      toggleFullscreen();
      return;
    }
    if (!replaying || !clock) return;
    const k = e.key;
    if (k === " " || k === "k" || k === "K") {
      if (tag === "BUTTON" && k === " ") return; // the focused button handles Space itself
      e.preventDefault();
      act(togglePlay);
    } else if (k === "Home") {
      e.preventDefault();
      act(restartClock);
    } else if (k === "End") {
      e.preventDefault();
      act(skipToEnd);
    } else if (k === "1" || k === "2" || k === "3") {
      onSpeed(([1, 10, 30] as const)[Number(k) - 1]!);
    } else if ((k === "ArrowLeft" || k === "ArrowRight") && !isRange) {
      e.preventDefault();
      const step = (e.shiftKey ? 30_000 : 5_000) * (k === "ArrowLeft" ? -1 : 1);
      act((c) => seekClock(c, c.p + step));
    }
  };
  /** Screen-reader users are not chased by moving rows: focus entering a table pauses playback. */
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (replaying && clock?.playing && (e.target as HTMLElement).closest?.("table")) act(pauseClock);
  };

  // ------------------------------------------------------------------ header
  const now = useNow(mode === "live");
  const demo = project.isDemo;
  let pill = "";
  let pillSub: string | null = null;
  if (activity) {
    pill = pillText({
      mode,
      demo,
      elapsedMs: elapsedMs(activity.run, mode === "live", now),
      spend: activity.totals.spend,
      providerCalls: activity.totals.providerCalls,
      startedAt: activity.run.startedAt ?? activity.run.createdAt,
      speed: clock?.speed ?? DEFAULT_SPEED,
      gapsShortened: gaps,
    });
    if (replaying && clock) {
      const total = clock.tEnd - clock.t0;
      const spendNow = clock.finished ? spendPhrase(activity.totals.spend, activity.totals.providerCalls) : spendSoFarText(spendSoFar(revealed));
      pillSub = `Run time ${clockText(clock.p - clock.t0)} of ${clockText(total)} · ${spendNow}${live.capped ? ` · first ${fmtInt(MAX_EVENTS)} events` : ""}`;
    }
  }
  const activeOther = (current.runs ?? []).find((r) => (r.status === "pending" || r.status === "running") && r.id !== runId) ?? null;
  const engines = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of boardLanes) if (l.state !== "setup_required") m.set(l.provider, l.label);
    for (const l of activity?.lanes ?? []) if (!m.has(l.provider)) m.set(l.provider, l.label);
    return Array.from(m, ([provider, label]) => ({ provider, label }));
  }, [boardLanes, activity?.lanes]);
  const labels = [
    ...(agent === "seo" ? (live.seo?.labels ?? []) : (live.geo?.labels ?? [])),
    ...(agent === "geo" ? (geoData.board.data?.labels ?? []) : []),
    ...(demo ? ["Demo data - simulated run"] : []),
  ];
  const onSelectAgent = (a: "seo" | "geo") => {
    if (a === agent && !requested) return;
    setParams({ mode: a });
  };

  // ------------------------------------------------------------------ body
  let body;
  if (!runId) {
    body =
      current.runs === null && !current.error ? (
        <LoadingState label="Looking for runs…" />
      ) : current.error && current.runs === null ? (
        <ErrorState error={current.error} title="Could not load runs" onRetry={current.reload} />
      ) : modeParam && needList && list.loading ? (
        <LoadingState label="Looking for runs…" />
      ) : (
        <EmptyState
          title={modeParam ? `No ${modeParam.toUpperCase()} run yet` : "No runs yet"}
          action={
            demo ? undefined : (
              <div className="flex flex-wrap justify-center gap-3">
                {(!modeParam || modeParam === "seo") && <RunNowButton projectId={projectId} agent="seo" onStarted={() => current.reload()} />}
                {(!modeParam || modeParam === "geo") && <RunNowButton projectId={projectId} agent="geo" onStarted={() => current.reload()} />}
              </div>
            )
          }
        >
          The Live view shows a run's stored rows as they land, or replays the latest finished run.
        </EmptyState>
      );
  } else if (!activity) {
    body = live.finalError ? (
      <EmptyState title={LIVE_TEXT.gone}>It may have been deleted, or it belongs to a workspace you are not a member of.</EmptyState>
    ) : live.error ? (
      <ErrorState error={live.error} title="Could not load this run" />
    ) : (
      <LoadingState label={live.loaded > 0 ? `Loading stored events… ${fmtInt(live.loaded)}` : "Loading stored events…"} />
    );
  } else {
    const ownHost = urlHost(project.siteUrl) || project.verifiedHost || "";
    const providerCalls = atEnd ? activity.totals.providerCalls : callTicks(items).length;
    const t0 = bounds?.t0 ?? Date.now();
    const axisEnd = mode === "live" ? Math.max(now, t0 + 1000) : (bounds?.tEnd ?? t0);
    body = (
      <div className="min-w-0 space-y-4">
        {live.loading ? (
          <LoadingState label={`Loading stored events… ${fmtInt(live.loaded)}${live.capped ? ` · first ${fmtInt(MAX_EVENTS)} events` : ""}`} />
        ) : (
          <>
            <RunRail
              agent={agent}
              items={items}
              t0={t0}
              axisEnd={axisEnd}
              playhead={playhead}
              pages={agent === "seo" ? { read: atEnd ? activity.totals.pagesRead : items.filter((i) => i.kind === "page_read").length, planned: activity.totals.pagesPlanned } : null}
              decisions={atEnd ? activity.totals.decisions : decisionCounts(items)}
              providerCalls={providerCalls}
              laneLabels={new Map(engines.map((e) => [e.provider, e.label]))}
            />
            {agent === "seo" ? (
              <SeoBoard
                projectId={projectId}
                runId={activity.run.id}
                ownHost={ownHost}
                verified={!!project.verifiedAt}
                activity={activity}
                revealed={revealed}
                upcoming={upcoming}
                replaying={replaying}
                atEnd={atEnd}
                mode={mode}
                fresh={fresh}
                reduced={reduced}
                seo={live.seo}
                feedError={live.feedError}
                data={seoData}
              />
            ) : (
              <GeoBoard
                projectId={projectId}
                ownHost={ownHost}
                demo={demo}
                activity={activity}
                revealed={revealed}
                upcoming={upcoming}
                replaying={replaying}
                atEnd={atEnd}
                mode={mode}
                fresh={fresh}
                reduced={reduced}
                geo={live.geo}
                feedError={live.feedError}
                data={geoData}
              />
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      onFocusCapture={onFocus}
      className={cx(
        "lv-root min-w-0 space-y-4 bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100",
        (fs || focusMode) && "fixed inset-0 z-50 overflow-x-hidden overflow-y-auto p-4 sm:p-6",
      )}
    >
      <style>{LIVE_CSS}</style>
      {(fs || focusMode) && demo && <DemoBanner />}
      <LiveHeader
        agent={agent}
        domain={urlHost(project.siteUrl) || project.siteUrl}
        engines={engines}
        pill={activity ? <LivePill mode={mode} text={pill} sub={pillSub} /> : null}
        toggle={{ seo: true, geo: true, onSelect: onSelectAgent }}
        fullscreen={fs || focusMode}
        onFullscreen={toggleFullscreen}
        labels={labels}
        replaying={replaying}
        extra={
          <>
            {replaying && clock && (
              <ReplayControls
                clock={clock}
                onToggle={() => act(togglePlay)}
                onRestart={() => act(restartClock)}
                onEnd={() => act(skipToEnd)}
                onSpeed={onSpeed}
                onSeek={(p) => act((c) => seekClock(c, p))}
              />
            )}
            {mode === "finished" && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">Run finished. Panels keep the stored rows.</span>
                <Button size="sm" onClick={() => setReplayAsked(true)}>
                  Replay this run
                </Button>
              </div>
            )}
            {replaying && activeOther && (
              <p role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                A run is live now ·
                <button type="button" className="font-semibold underline" onClick={() => setParams({ run: activeOther.id })}>
                  Watch live
                </button>
              </p>
            )}
            {activity && live.error !== null && !live.finalError && (
              <p role="status" className="text-xs text-amber-800 dark:text-amber-300">
                {LIVE_TEXT.reconnecting}
              </p>
            )}
          </>
        }
      />
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {body}
    </div>
  );
}
