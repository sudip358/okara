/**
 * One shared poller of GET /projects/:pid/activity/current per project, for the Live view and its nav dot
 * (useSyncExternalStore). Same cadence as the Activity launcher: 10 s idle, 3 s while a run is active,
 * visible tab only; it stops when nothing is subscribed. Never polls more than once per tick however many
 * components read it.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { CurrentActivityResponse } from "@shared/types";
import { api } from "@web/lib/api";
import { POLL, currentPath, runIsActive } from "@web/components/activity/lib";

export interface CurrentRunsSnapshot {
  runs: CurrentActivityResponse["runs"] | null;
  error: unknown;
  anyActive: boolean;
}

interface Entry {
  snap: CurrentRunsSnapshot;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
  onVisible: (() => void) | null;
}

const EMPTY: CurrentRunsSnapshot = { runs: null, error: null, anyActive: false };
const entries = new Map<string, Entry>();
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

function entry(projectId: string): Entry {
  let e = entries.get(projectId);
  if (!e) {
    e = { snap: EMPTY, listeners: new Set(), timer: null, inflight: false, onVisible: null };
    entries.set(projectId, e);
  }
  return e;
}

function emit(e: Entry, snap: CurrentRunsSnapshot) {
  e.snap = snap;
  for (const l of e.listeners) l();
}

function schedule(projectId: string, e: Entry) {
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (e.listeners.size === 0) return;
  e.timer = setTimeout(() => void poll(projectId), e.snap.anyActive ? POLL.currentActive : POLL.currentIdle);
}

async function poll(projectId: string) {
  const e = entry(projectId);
  if (e.listeners.size === 0 || e.inflight) return;
  if (!visible()) {
    if (!e.onVisible && typeof document !== "undefined") {
      e.onVisible = () => {
        if (!visible()) return;
        document.removeEventListener("visibilitychange", e.onVisible!);
        e.onVisible = null;
        void poll(projectId);
      };
      document.addEventListener("visibilitychange", e.onVisible);
    }
    return;
  }
  e.inflight = true;
  try {
    const res = await api<CurrentActivityResponse>(currentPath(projectId));
    emit(e, { runs: res.runs, error: null, anyActive: res.runs.some((r) => runIsActive(r.status)) });
  } catch (err) {
    emit(e, { ...e.snap, error: err });
  } finally {
    e.inflight = false;
    schedule(projectId, e);
  }
}

function subscribe(projectId: string, cb: () => void): () => void {
  const e = entry(projectId);
  e.listeners.add(cb);
  if (e.listeners.size === 1) void poll(projectId);
  return () => {
    e.listeners.delete(cb);
    if (e.listeners.size === 0) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      if (e.onVisible && typeof document !== "undefined") document.removeEventListener("visibilitychange", e.onVisible);
      e.onVisible = null;
    }
  };
}

/** Re-poll now (e.g. after a run was started from the Live view). */
export function refreshCurrentRuns(projectId: string): void {
  void poll(projectId);
}

export function useCurrentRuns(projectId: string): CurrentRunsSnapshot & { reload: () => void } {
  const sub = useCallback((cb: () => void) => subscribe(projectId, cb), [projectId]);
  const snap = useSyncExternalStore(
    sub,
    () => entry(projectId).snap,
    () => EMPTY,
  );
  const reload = useCallback(() => refreshCurrentRuns(projectId), [projectId]);
  return { ...snap, reload };
}
