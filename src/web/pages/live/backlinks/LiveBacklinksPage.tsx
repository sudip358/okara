/**
 * Live Backlinks (/projects/:pid/live/backlinks, docs/live-view-design.md section 19): four containers built only from
 * stored backlink checks, each with its own run button (section 16 dialog): 01 Backlink live check, 02 Dofollow /
 * nofollow check, 03 Current status, 04 New status (changes).
 *
 * Data plan: summary, rows (first 100 by status) and events load once and again when a check ends or a run button
 * finished. While a check job is queued/running the page calls POST /backlinks/check/advance at most every 2 s
 * (sequentially, visible tab only): each call runs one more bounded batch of the job in a fresh invocation and returns
 * the job progress plus the checks stored since the last call, which appear in 01. No polling while idle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { BacklinkEventsResponse, BacklinkFeed, BacklinkFeedItem, BacklinkListResponse, BacklinkSummary } from "@shared/backlinks";
import { LIVE_POLL_MS } from "@shared/backlinks";
import { api } from "@web/lib/api";
import { useApi } from "@web/lib/hooks";
import { projectPath, useProject } from "@web/lib/project-context";
import { DemoBanner, cx } from "@web/components/ui";
import { backlinksBase, jobActive, recheckCandidates } from "@web/pages/backlinks/lib";
import { LIVE_CSS, useReducedMotion } from "../motion";
import { RunActionsProvider, SectionButton } from "../RunActions";
import { recheckAction, runCheckAction } from "./actions";
import { ChangesPanel, CurrentStatusPanel, LiveCheckPanel, RelCheckPanel } from "./BacklinkContainers";
import { setBacklinkJob } from "./job-store";

const FEED_KEEP = 50;

/** Newest first, deduplicated by check id, capped. */
export function mergeFeed(prev: readonly BacklinkFeedItem[], incoming: readonly BacklinkFeedItem[]): BacklinkFeedItem[] {
  const seen = new Set<string>();
  const out: BacklinkFeedItem[] = [];
  for (const i of [...incoming, ...prev]) {
    if (seen.has(i.checkId)) continue;
    seen.add(i.checkId);
    out.push(i);
  }
  return out.sort((a, b) => (a.checkedAt < b.checkedAt ? 1 : a.checkedAt > b.checkedAt ? -1 : 0)).slice(0, FEED_KEEP);
}

export function LiveBacklinksPage() {
  const { project, projectId } = useProject();
  const reduced = useReducedMotion();
  const base = backlinksBase(projectId);
  const [reloadKey, setReloadKey] = useState(0);
  const summary = useApi<BacklinkSummary>(`${base}/summary`, [reloadKey]);
  const rows = useApi<BacklinkListResponse>(`${base}?sort=status&dir=asc&limit=100`, [reloadKey]);
  const events = useApi<BacklinkEventsResponse>(`${base}/events`, [reloadKey]);
  const [feed, setFeed] = useState<BacklinkFeed | null>(null);
  const [feedError, setFeedError] = useState<unknown>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const feedRef = useRef<BacklinkFeed | null>(null);
  feedRef.current = feed;

  const applyFeed = useCallback(
    (next: BacklinkFeed, incremental: boolean) => {
      const prev = feedRef.current;
      const wasActive = jobActive(prev?.job);
      const sameJob = prev?.job?.id === next.job?.id;
      const items = incremental && sameJob ? mergeFeed(prev?.items ?? [], next.items) : next.items;
      setFresh(new Set(incremental && sameJob ? next.items.map((i) => i.checkId) : []));
      setFeed({ job: next.job, items });
      setFeedError(null);
      setBacklinkJob(projectId, next.job);
      // A check ended (or a new one started): reload the stored state the other containers show.
      if ((wasActive && !jobActive(next.job)) || (prev && !sameJob)) setReloadKey((k) => k + 1);
    },
    [projectId],
  );

  const loadFeed = useCallback(async () => {
    try {
      applyFeed(await api<BacklinkFeed>(`${base}/feed`), false);
    } catch (e) {
      setFeedError(e);
    }
  }, [applyFeed, base]);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  // While a job runs: one advance call at a time, at most every LIVE_POLL_MS, only while the tab is visible.
  const running = jobActive(feed?.job);
  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        const newest = feedRef.current?.items[0]?.checkedAt ?? null;
        try {
          const next = await api<BacklinkFeed>(`${base}/check/advance`, { method: "POST", body: { after: newest } });
          if (!stopped) applyFeed(next, true);
        } catch (e) {
          if (!stopped) setFeedError(e);
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), LIVE_POLL_MS);
    };
    timer = setTimeout(() => void tick(), LIVE_POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [running, base, applyFeed]);

  const onReload = useCallback(() => {
    setReloadKey((k) => k + 1);
    void loadFeed();
  }, [loadFeed]);

  const s = summary.data ? { ...summary.data, job: feed?.job && jobActive(feed.job) ? feed.job : summary.data.job } : null;
  const recheckIds = useMemo(() => recheckCandidates(rows.data?.rows ?? []), [rows.data]);
  const env = { projectId, demo: project.isDemo, summary: s, recheckIds };
  const run = runCheckAction(env);
  const recheck = recheckAction(env);
  const sumState = { data: s, error: summary.error, loading: summary.loading };
  const feedState = { data: feed, error: feedError, loading: feed === null && !feedError };
  const common = { projectId, reduced, demo: project.isDemo };

  return (
    <div className="lv-root min-w-0 space-y-4" data-testid="live-backlinks">
      <style>{LIVE_CSS}</style>
      {project.isDemo && <DemoBanner />}
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">Live Backlinks</h1>
          <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
            Your built links from the master sheet, checked on the live article: is the link to your page there, and is it dofollow or nofollow?
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link className="text-sm" to={projectPath(projectId, "backlinks")}>
            Open Backlinks ›
          </Link>
        </div>
      </header>
      <RunActionsProvider projectId={projectId} onStarted={() => onReload()} onReload={onReload}>
        <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Backlink check controls">
          <SectionButton action={run} />
        </div>
        <div className={cx("grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-12")}>
          <LiveCheckPanel {...common} feed={feedState} summary={sumState} action={run} fresh={fresh} />
          <RelCheckPanel {...common} summary={sumState} rows={rows} action={run} />
          <CurrentStatusPanel {...common} summary={sumState} rows={rows} action={recheck} />
          <ChangesPanel {...common} summary={sumState} events={events} action={run} />
        </div>
      </RunActionsProvider>
    </div>
  );
}
