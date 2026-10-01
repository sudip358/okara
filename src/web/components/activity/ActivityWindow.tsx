/**
 * Activity window: launcher button (with live dot) + non-modal side panel showing one run's stored
 * events as they land. Polls GET /activity/current (10s idle, 3s while a run is active; visible tab only)
 * and GET /runs/:id/activity?after=<cursor> every 2s while the shown run is active (backlogs drain
 * immediately, up to MAX_CATCHUP_PAGES pages per tick). The panel sits below the app header and the
 * demo banner (measured from a layout anchor, not a fixed offset). OWNED BY: web-activity.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type {
  ActivityItem,
  CurrentActivityResponse,
  RunActivity,
} from "@shared/types";
import { api } from "@web/lib/api";
import { useCurrentRuns } from "@web/pages/live/current-store";
import { agentLabel } from "@web/lib/format";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  buttonClass,
  cx,
} from "@web/components/ui";
import { ACTIVITY_CSS, ActivityBody, LiveDot } from "./ActivityView";
import { onOpenActivity } from "./bus";
import {
  LABELS,
  POLL,
  activityPath,
  announcement,
  catchUp,
  elapsedMs,
  finishedText,
  isFinalError,
  mergeItems,
  newestFirst,
  nextFeedDelay,
  pickRunId,
  runIsActive,
  runStatusChip,
} from "./lib";

const ANNOUNCE_EVERY_MS = 10_000;

const visible = () =>
  typeof document === "undefined" || document.visibilityState === "visible";

export interface RunActivityState {
  activity: RunActivity | null;
  items: ActivityItem[];
  freshIds: ReadonlySet<string>;
  announcement: string;
  error: unknown;
  /** 404/403: the run is gone or not ours; polling stopped for good. */
  finalError: boolean;
  loading: boolean;
  /** A backlog of stored events is still being paged in. */
  loadingEarlier: boolean;
}

/** Loads a run's activity, then polls ?after=cursor every 2s while it is active. */
export function useRunActivity(
  projectId: string,
  runId: string | null,
  enabled: boolean,
): RunActivityState {
  const [activity, setActivity] = useState<RunActivity | null>(null);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const [announce, setAnnounce] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [finalError, setFinalError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  useEffect(() => {
    setActivity(null);
    setItems([]);
    setFreshIds(new Set());
    setAnnounce("");
    setError(null);
    setFinalError(false);
    setLoadingEarlier(false);
    if (!enabled || !runId) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let announceTimer: ReturnType<typeof setTimeout> | undefined;
    let onVisible: (() => void) | undefined;
    let cursor: string | null = null;
    /** True until the initial backlog has been paged in (those items are not "new"). */
    let initial = true;
    let wasActive: boolean | null = null;
    let pendingNew: ActivityItem[] = [];
    let lastAnnounce = 0;
    setLoading(true);

    const flush = () => {
      announceTimer = undefined;
      if (ctrl.signal.aborted || pendingNew.length === 0) return;
      setAnnounce(announcement(pendingNew));
      pendingNew = [];
      lastAnnounce = Date.now();
    };
    const schedule = (ms: number) => {
      timer = setTimeout(tick, ms);
    };
    const waitVisible = () => {
      if (onVisible) return;
      onVisible = () => {
        if (!visible()) return;
        document.removeEventListener("visibilitychange", onVisible!);
        onVisible = undefined;
        void tick();
      };
      document.addEventListener("visibilitychange", onVisible);
    };

    async function tick() {
      if (ctrl.signal.aborted) return;
      if (!initial && !visible()) return waitVisible();
      try {
        const r = await catchUp(
          (after) =>
            api<RunActivity>(activityPath(projectId, runId!, after), {
              signal: ctrl.signal,
            }),
          cursor,
        );
        if (ctrl.signal.aborted) return;
        // Commit the cursor only now, together with the items it covers.
        cursor = r.cursor;
        const res = r.last;
        setActivity(res);
        setItems((prev) => mergeItems(prev, r.items));
        setError(null);
        if (!initial && r.items.length > 0) {
          setFreshIds(new Set(r.items.map((i) => i.id)));
          pendingNew = pendingNew.concat(r.items);
          const since = Date.now() - lastAnnounce;
          if (since >= ANNOUNCE_EVERY_MS) flush();
          else if (!announceTimer)
            announceTimer = setTimeout(flush, ANNOUNCE_EVERY_MS - since);
        }
        if (wasActive === true && !res.active) {
          if (announceTimer) clearTimeout(announceTimer);
          announceTimer = undefined;
          pendingNew = [];
          setAnnounce(finishedText(res.run, elapsedMs(res.run, false, 0)));
        }
        wasActive = res.active;
        if (!r.more) initial = false;
        setLoadingEarlier(r.more);
        setLoading(false);
        const delay = nextFeedDelay(r.more, res.active);
        if (delay !== null) schedule(delay);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e);
        setLoading(false);
        setLoadingEarlier(false);
        // Keep trying while the run may still be going; a 404/403 is final.
        if (isFinalError(e)) setFinalError(true);
        else schedule(POLL.feed * 3);
      }
    }
    void tick();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
      if (announceTimer) clearTimeout(announceTimer);
      if (onVisible)
        document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, runId, enabled]);

  return {
    activity,
    items,
    freshIds,
    announcement: announce,
    error,
    finalError,
    loading,
    loadingEarlier,
  };
}

/** Ticks `Date.now()` every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * Top offset (px) for the desktop panel: the bottom of the app header (the anchor sits right after it)
 * or of a sticky banner right after the anchor, whichever is lower, plus a small gap. Re-measured on
 * scroll/resize, so it follows the header scrolling away and the sticky demo banner.
 */
export function useShellTop(
  anchor: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
  gap = 8,
): number {
  const [top, setTop] = useState(16);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const a = anchor?.current;
      if (!a) return setTop(16);
      let t = a.getBoundingClientRect().top;
      const sib = a.nextElementSibling as HTMLElement | null;
      if (sib && getComputedStyle(sib).position === "sticky")
        t = Math.max(t, sib.getBoundingClientRect().bottom);
      setTop(Math.max(0, Math.round(t)) + gap);
    };
    const onChange = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onChange, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", onChange);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onChange, { capture: true });
      window.removeEventListener("resize", onChange);
    };
  }, [anchor, enabled, gap]);
  return top;
}

export function ActivityPanel({
  projectId,
  isDemo,
  runs,
  runsError,
  onRetryRuns,
  runId,
  onSelectRun,
  onClose,
  returnFocusTo,
  opener,
  topAnchor,
  defaultExpanded = false,
}: {
  projectId: string;
  isDemo: boolean;
  runs: CurrentActivityResponse["runs"] | null;
  runsError?: unknown;
  onRetryRuns?: () => void;
  runId: string | null;
  onSelectRun: (id: string) => void;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** The element that opened the panel, if known (focus goes back there on close). */
  opener?: HTMLElement | null;
  topAnchor?: RefObject<HTMLElement | null>;
  defaultExpanded?: boolean;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const state = useRunActivity(projectId, runId, true);
  const active = state.activity?.active ?? false;
  const now = useNow(active);
  const items = useMemo(() => newestFirst(state.items), [state.items]);
  const top = useShellTop(topAnchor, true);

  useEffect(() => {
    // Return focus to whatever opened the panel (launcher or a "Run … now" button).
    const active =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    const prev = opener ?? (active && active !== document.body ? active : null);
    closeRef.current?.focus();
    return () => {
      const target = prev?.isConnected ? prev : returnFocusTo?.current;
      target?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const title =
    state.activity && !state.activity.active ? LABELS.replay : LABELS.liveTitle;
  const style = { "--okara-activity-top": `${top}px` } as CSSProperties;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-expanded={expanded ? "true" : "false"}
      style={style}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className={cx(
        "okara-activity fixed inset-0 z-50 flex flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100",
        "sm:inset-auto sm:top-[var(--okara-activity-top)] sm:right-4 sm:bottom-4 sm:z-40 sm:max-w-[calc(100vw-2rem)] sm:overflow-hidden sm:rounded-2xl sm:border sm:border-zinc-200 sm:shadow-2xl sm:dark:border-zinc-800",
        expanded ? "sm:w-[880px]" : "sm:w-[460px]",
      )}
    >
      <style>{ACTIVITY_CSS}</style>
      <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <span
          aria-hidden="true"
          className="inline-flex h-4 w-4 shrink-0 overflow-hidden rounded-sm"
        >
          <span className="w-1/3 bg-emerald-500" />
          <span className="w-1/3 bg-sky-500" />
          <span className="w-1/3 bg-red-500" />
        </span>
        <h2
          id={titleId}
          className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight"
        >
          {title}
        </h2>
        <button
          type="button"
          className={cx(buttonClass("ghost", "sm"), "max-sm:hidden")}
          aria-pressed={expanded}
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
        <button
          ref={closeRef}
          type="button"
          className={buttonClass("ghost", "sm")}
          onClick={onClose}
          aria-label="Close activity window"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {isDemo && (
        <p
          role="note"
          className="border-b border-fuchsia-200 bg-fuchsia-50 px-4 py-1 text-[11px] font-medium text-fuchsia-900 dark:border-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200"
        >
          Demo data – simulated run.
        </p>
      )}
      {runs && runs.length > 1 && (
        <div
          role="group"
          aria-label="Choose run"
          className="flex gap-1.5 overflow-x-auto border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900"
        >
          {runs.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={r.id === runId}
              onClick={() => onSelectRun(r.id)}
              className={cx(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-sky-600",
                r.id === runId
                  ? "bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700",
              )}
            >
              {runIsActive(r.status) && <LiveDot />}
              {agentLabel(r.agent)} · {runStatusChip(r.status).label}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-4">
        {!runId ? (
          runs === null ? (
            runsError ? (
              <ErrorState
                error={runsError}
                title="Could not load runs"
                onRetry={onRetryRuns}
              />
            ) : (
              <LoadingState label="Looking for runs…" />
            )
          ) : (
            <EmptyState title="No runs yet">
              Start an SEO or GEO run and its stored events will appear here as
              they land.
            </EmptyState>
          )
        ) : state.activity ? (
          <ActivityBody
            activity={state.activity}
            items={items}
            projectId={projectId}
            now={now}
            replay={!state.activity.active}
            expanded={expanded}
            freshIds={state.freshIds}
            announcement={state.announcement}
            loadingEarlier={state.loadingEarlier}
          />
        ) : state.finalError ? (
          <EmptyState title={LABELS.gone}>
            It may have been deleted, or it belongs to a workspace you are not a
            member of.
          </EmptyState>
        ) : state.error ? (
          <ErrorState
            error={state.error}
            title="Could not load this run's activity"
          />
        ) : (
          <LoadingState label="Loading run activity…" />
        )}
        {state.activity && state.error !== null && (
          <p
            role="status"
            className="mt-2 text-xs text-amber-800 dark:text-amber-300"
          >
            {state.finalError ? LABELS.gone : LABELS.reconnecting}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The panel renders into document.body: the launcher lives in the sticky sidebar, which is its own
 * stacking context, so a fixed panel inside it could be painted under page content.
 */
function portal(node: ReactNode): ReactNode {
  return typeof document === "undefined"
    ? node
    : createPortal(node, document.body);
}

/**
 * Header button + window, mounted once in the project shell. Opens on click, or via `openActivity()`
 * from the bus (e.g. right after a "Run … now" button started a run). The run on screen stays pinned
 * until the user picks another one or closes the window.
 */
export function ActivityLauncher({
  projectId,
  isDemo,
  className,
  topAnchor,
}: {
  projectId: string;
  isDemo: boolean;
  className?: string;
  /** Element placed right below the app header (and right before the sticky demo banner, if any). */
  topAnchor?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The one shared poller of /activity/current per project (also read by the Live view and its nav dot).
  const current = useCurrentRuns(projectId);
  const runs = current.runs;
  const anyActive = current.anyActive;

  const reloadCurrent = current.reload;
  useEffect(
    () =>
      onOpenActivity((req) => {
        if (req.projectId !== projectId) return;
        setRequested(req.runId ?? null);
        setShown(null);
        setOpener(req.opener ?? null);
        setOpen(true);
        reloadCurrent();
      }),
    [projectId, reloadCurrent],
  );
  useEffect(() => {
    setOpen(false);
    setRequested(null);
    setShown(null);
  }, [projectId]);

  const runId = pickRunId(runs ?? [], requested ?? shown);
  // Pin the run once it is on screen, so a finishing run does not make the window jump to another one.
  useEffect(() => {
    if (open && runId && runId !== shown) setShown(runId);
  }, [open, runId, shown]);

  const close = useCallback(() => {
    setOpen(false);
    setShown(null);
  }, []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={cx(buttonClass("secondary", "sm"), className)}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setRequested(null);
          setShown(null);
          setOpener(null);
          setOpen((o) => !o);
        }}
      >
        {anyActive && <LiveDot />}
        Activity
        {anyActive && <span className="sr-only"> (a run is in progress)</span>}
      </button>
      {open &&
        portal(
          <ActivityPanel
            projectId={projectId}
            isDemo={isDemo}
            runs={runs}
            runsError={current.error}
            onRetryRuns={reloadCurrent}
            runId={runId}
            onSelectRun={(id) => setRequested(id)}
            onClose={close}
            returnFocusTo={buttonRef}
            opener={opener}
            topAnchor={topAnchor}
          />,
        )}
    </>
  );
}
