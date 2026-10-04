/**
 * One shared poller of the project's backlink check job (GET /backlinks/feed?limit=0: the running or latest job, no
 * rows) for the "Live Backlinks" nav dot. 60 s idle, 5 s while a job runs, visible tab only; it stops when nothing is
 * subscribed. Pages that already know the job (after starting a check, or from their own 2 s feed) push it with
 * setBacklinkJob so the dot updates without another request.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { BacklinkFeed, BacklinkJobView } from "@shared/backlinks";
import { api } from "@web/lib/api";
import { backlinksBase, jobActive } from "@web/pages/backlinks/lib";

export const JOB_POLL = { idle: 60_000, active: 5_000 } as const;

interface Entry {
  job: BacklinkJobView | null;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
}

const entries = new Map<string, Entry>();
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

function entry(projectId: string): Entry {
  let e = entries.get(projectId);
  if (!e) {
    e = { job: null, listeners: new Set(), timer: null, inflight: false };
    entries.set(projectId, e);
  }
  return e;
}

function emit(e: Entry, job: BacklinkJobView | null) {
  e.job = job;
  for (const l of e.listeners) l();
}

function schedule(projectId: string, e: Entry) {
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  if (e.listeners.size === 0) return;
  e.timer = setTimeout(() => void poll(projectId), jobActive(e.job) ? JOB_POLL.active : JOB_POLL.idle);
}

async function poll(projectId: string) {
  const e = entry(projectId);
  if (e.listeners.size === 0 || e.inflight) return;
  if (!visible()) {
    schedule(projectId, e);
    return;
  }
  e.inflight = true;
  try {
    const res = await api<BacklinkFeed>(`${backlinksBase(projectId)}/feed?limit=0`);
    emit(e, res.job);
  } catch {
    // Keep the last known state (a missing migration or a network blip must not break the sidebar).
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
    if (e.listeners.size === 0 && e.timer) {
      clearTimeout(e.timer);
      e.timer = null;
    }
  };
}

/** A page learned the job state (started a check, polled its feed): update the dot without a request. */
export function setBacklinkJob(projectId: string, job: BacklinkJobView | null): void {
  const e = entry(projectId);
  emit(e, job);
  schedule(projectId, e);
}

export function useBacklinkJob(projectId: string): BacklinkJobView | null {
  const sub = useCallback((cb: () => void) => subscribe(projectId, cb), [projectId]);
  return useSyncExternalStore(
    sub,
    () => entry(projectId).job,
    () => null,
  );
}
