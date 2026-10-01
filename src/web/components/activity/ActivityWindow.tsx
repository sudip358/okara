/**
 * Activity window: launcher button (with live dot) + non-modal side panel showing one run's stored
 * events as they land. Polls GET /activity/current (10s idle, 3s while a run is active; visible tab only)
 * and GET /runs/:id/activity?after=<cursor> every 2s while the shown run is active. OWNED BY: web-activity.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type { ActivityItem, CurrentActivityResponse, RunActivity } from "@shared/types";
import { ApiError, api } from "@web/lib/api";
import { useApi, usePolling } from "@web/lib/hooks";
import { agentLabel } from "@web/lib/format";
import { EmptyState, ErrorState, LoadingState, buttonClass, cx } from "@web/components/ui";
import { ACTIVITY_CSS, ActivityBody } from "./ActivityView";
import { onOpenActivity } from "./bus";
import {
  MAX_CATCHUP_PAGES,
  PAGE_LIMIT,
  POLL,
  activityPath,
  announcement,
  currentPath,
  mergeItems,
  newestFirst,
  pickRunId,
  runIsActive,
  runStatusChip,
} from "./lib";

const ANNOUNCE_EVERY_MS = 10_000;

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

export interface RunActivityState {
  activity: RunActivity | null;
  items: ActivityItem[];
  freshIds: ReadonlySet<string>;
  announcement: string;
  error: unknown;
  loading: boolean;
}

/** Loads a run's activity, then polls ?after=cursor every 2s while it is active. */
export function useRunActivity(projectId: string, runId: string | null, enabled: boolean): RunActivityState {
  const [activity, setActivity] = useState<RunActivity | null>(null);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const [announce, setAnnounce] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setActivity(null);
    setItems([]);
    setFreshIds(new Set());
    setAnnounce("");
    setError(null);
    if (!enabled || !runId) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: string | null = null;
    let first = true;
    let pendingNew: ActivityItem[] = [];
    let lastAnnounce = 0;
    setLoading(true);

    const schedule = (ms: number) => {
      timer = setTimeout(tick, ms);
    };
    async function tick() {
      if (ctrl.signal.aborted) return;
      if (!first && !visible()) return schedule(POLL.feed);
      try {
        let res: RunActivity;
        const got: ActivityItem[] = [];
        let pages = 0;
        do {
          res = await api<RunActivity>(activityPath(projectId, runId!, cursor), { signal: ctrl.signal });
          if (res.cursor) cursor = res.cursor;
          got.push(...res.items);
          pages++;
        } while (res.items.length >= PAGE_LIMIT && res.cursor && pages < MAX_CATCHUP_PAGES);
        if (ctrl.signal.aborted) return;
        setActivity(res);
        setItems((prev) => mergeItems(prev, got));
        setError(null);
        if (!first && got.length > 0) {
          setFreshIds(new Set(got.map((i) => i.id)));
          pendingNew = pendingNew.concat(got);
          const now = Date.now();
          if (now - lastAnnounce >= ANNOUNCE_EVERY_MS) {
            setAnnounce(announcement(pendingNew));
            pendingNew = [];
            lastAnnounce = now;
          }
        }
        first = false;
        setLoading(false);
        if (res.active) schedule(POLL.feed);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e);
        setLoading(false);
        // Keep trying while the run may still be going; a 404 is final.
        if (!(e instanceof ApiError && (e.status === 404 || e.status === 403))) schedule(POLL.feed * 3);
      }
    }
    void tick();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, runId, enabled]);

  return { activity, items, freshIds, announcement: announce, error, loading };
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

export function ActivityPanel({
  projectId,
  isDemo,
  runs,
  runId,
  onSelectRun,
  onClose,
  returnFocusTo,
}: {
  projectId: string;
  isDemo: boolean;
  runs: CurrentActivityResponse["runs"] | null;
  runId: string | null;
  onSelectRun: (id: string) => void;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const state = useRunActivity(projectId, runId, true);
  const active = state.activity?.active ?? false;
  const now = useNow(active);
  const items = useMemo(() => newestFirst(state.items), [state.items]);

  useEffect(() => {
    closeRef.current?.focus();
    const back = returnFocusTo?.current;
    return () => back?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const anyActive = (runs ?? []).some((r) => runIsActive(r.status));
  const replay = state.activity !== null && !state.activity.active && !anyActive;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className={cx(
        "fixed inset-0 z-40 flex flex-col bg-white dark:bg-zinc-900",
        "sm:inset-auto sm:top-4 sm:right-4 sm:bottom-4 sm:w-[420px] sm:max-w-[calc(100vw-2rem)] sm:rounded-xl sm:border sm:border-zinc-200 sm:shadow-2xl sm:dark:border-zinc-800",
      )}
    >
      <style>{ACTIVITY_CSS}</style>
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <h2 id={titleId} className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Activity
        </h2>
        <button ref={closeRef} type="button" className={buttonClass("ghost", "sm")} onClick={onClose} aria-label="Close activity window">
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {isDemo && (
        <p role="note" className="border-b border-fuchsia-300 bg-fuchsia-100 px-4 py-1 text-xs font-semibold text-fuchsia-900 dark:border-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-100">
          Demo data – simulated run. Nothing here was measured from a live source.
        </p>
      )}
      {runs && runs.length > 1 && (
        <div role="group" aria-label="Choose run" className="flex flex-wrap gap-1.5 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          {runs.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={r.id === runId}
              onClick={() => onSelectRun(r.id)}
              className={cx(
                "rounded-md px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-sky-600",
                r.id === runId
                  ? "bg-zinc-900 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
              )}
            >
              {agentLabel(r.agent)} · {runStatusChip(r.status).label}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-3">
        {!runId ? (
          runs === null ? (
            <LoadingState label="Looking for runs…" />
          ) : (
            <EmptyState title="No runs yet">Start an SEO or GEO run and its stored events will appear here as they land.</EmptyState>
          )
        ) : state.activity ? (
          <ActivityBody
            activity={state.activity}
            items={items}
            projectId={projectId}
            now={now}
            replay={replay}
            freshIds={state.freshIds}
            announcement={state.announcement}
          />
        ) : state.error ? (
          <ErrorState error={state.error} title="Could not load this run's activity" />
        ) : (
          <LoadingState label="Loading run activity…" />
        )}
        {state.activity && state.error !== null && (
          <p role="status" className="mt-2 text-xs text-amber-800 dark:text-amber-300">
            Reconnecting… the feed shows the last stored events received.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Header button + window, mounted once in the project shell. Opens on click, or via `openActivity()`
 * from the bus (e.g. right after a "Run … now" button started a run).
 */
export function ActivityLauncher({ projectId, isDemo, className }: { projectId: string; isDemo: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = useApi<CurrentActivityResponse>(currentPath(projectId), [projectId]);
  const runs = current.data?.runs ?? null;
  const anyActive = (runs ?? []).some((r) => runIsActive(r.status));
  usePolling(current.reload, true, anyActive ? POLL.currentActive : POLL.currentIdle);

  const reloadCurrent = current.reload;
  useEffect(
    () =>
      onOpenActivity((req) => {
        if (req.projectId !== projectId) return;
        setRequested(req.runId ?? null);
        setOpen(true);
        reloadCurrent();
      }),
    [projectId, reloadCurrent],
  );
  useEffect(() => {
    setOpen(false);
    setRequested(null);
  }, [projectId]);

  const runId = pickRunId(runs ?? [], requested);
  const close = useCallback(() => setOpen(false), []);

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
          setOpen((o) => !o);
        }}
      >
        {anyActive && (
          <span aria-hidden="true" className="relative inline-flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
        )}
        Activity
        {anyActive && <span className="sr-only"> (a run is in progress)</span>}
      </button>
      {open && (
        <ActivityPanel
          projectId={projectId}
          isDemo={isDemo}
          runs={runs}
          runId={runId}
          onSelectRun={(id) => setRequested(id)}
          onClose={close}
          returnFocusTo={buttonRef}
        />
      )}
    </>
  );
}
