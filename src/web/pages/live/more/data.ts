/**
 * Data for the Live view's project containers (docs/live-view-design.md section 17). Each container fetches
 * its own aggregate when it mounts (containers below the fold mount lazily) and again only when:
 *   - the step that changes it reaches a terminal status in the heartbeat the page already polls
 *     (seo.gsc_sync -> 10/11, seo.crawl -> 12, geo.batch -> GEO 06-09; budget after any terminal step,
 *     throttled), or
 *   - a run button of the view finished (a sheet "Sync now", a DataForSEO refresh, a started run).
 * There is no polling loop of its own, so the section 3 budget (one heartbeat + one feed per 2 s) holds.
 */
import { createContext, useContext, useEffect, useState } from "react";
import type { CompetitorDataPanel, CompetitorDomainDetail } from "@shared/competitor-data";
import type { LiveInsight, LiveInsightKind } from "@shared/types";
import { api } from "@web/lib/api";
import { useApi, type ApiState } from "@web/lib/hooks";

const p = (pid: string) => `/projects/${encodeURIComponent(pid)}`;

export const morePaths = {
  insight: (pid: string, kind: LiveInsightKind) => `${p(pid)}/live/insights?kind=${kind}`,
  competitorPanel: (pid: string) => `${p(pid)}/competitors/dataforseo`,
  competitorDomain: (pid: string, domain: string) => `${p(pid)}/competitors/dataforseo/domains/${encodeURIComponent(domain)}`,
  syncNow: (pid: string, syncId: string) => `${p(pid)}/import/syncs/${encodeURIComponent(syncId)}/run`,
  competitorRefresh: (pid: string) => `${p(pid)}/competitors/dataforseo/refresh`,
};

/** Refetch keys: the id of a step's latest terminal event in the shown run ("" = none), or a counter. */
export interface MoreKeys {
  gsc: string;
  crawl: string;
  batch: string;
  /** Changes when any step of the shown run ends (throttled) or after a start / tool call. */
  budget: string;
}

/** Bumped by the run controls when a tool call finished (the container reloads). */
export interface MoreReloads {
  sheets: number;
  gap: number;
}

export interface LiveMoreValue {
  /** The run on screen (captions say when a container's data is not from it). */
  runId: string | null;
  demo: boolean;
  /** A replay is on screen: project containers show current state, "not replayed". */
  replaying: boolean;
  keys: MoreKeys;
  reloads: MoreReloads;
  /** Containers the viewer hid for the shown mode ("Containers" menu). */
  hidden: ReadonlySet<string>;
}

export const NO_HIDDEN: ReadonlySet<string> = new Set();

export const LiveMoreContext = createContext<LiveMoreValue>({
  runId: null,
  demo: false,
  replaying: false,
  keys: { gsc: "", crawl: "", batch: "", budget: "" },
  reloads: { sheets: 0, gap: 0 },
  hidden: NO_HIDDEN,
});

export const useLiveMore = () => useContext(LiveMoreContext);

/** Which refetch key each insight follows. */
export function insightDeps(kind: LiveInsightKind, v: Pick<LiveMoreValue, "keys" | "reloads">): unknown[] {
  switch (kind) {
    case "striking":
    case "movers":
      return [v.keys.gsc];
    case "technical":
      return [v.keys.crawl];
    case "engine_queries":
    case "brands":
    case "cited_domains":
    case "prompt_history":
      return [v.keys.batch];
    case "sheets":
      return [v.reloads.sheets];
    case "budget":
      return [v.keys.budget];
  }
}

/** One insight of the project (GET /live/insights?kind=), refetched only on its key. */
export function useInsight<T extends LiveInsight>(projectId: string, kind: LiveInsightKind): ApiState<T> {
  const v = useLiveMore();
  return useApi<T>(projectId ? morePaths.insight(projectId, kind) : null, insightDeps(kind, v));
}

/** SEO 13: the existing DataForSEO panel (state, prices, caps, domains with their latest refresh). */
export function useCompetitorPanel(projectId: string, reload: number): ApiState<CompetitorDataPanel> {
  return useApi<CompetitorDataPanel>(projectId ? morePaths.competitorPanel(projectId) : null, [reload]);
}

/** SEO 13: the stored detail (keyword gap) of ONE domain, only for a domain with stored data (null = none). */
export function useCompetitorDetail(projectId: string, domain: string | null, reload: number): { data: CompetitorDomainDetail | null; error: unknown } | null {
  const [detail, setDetail] = useState<{ domain: string; data: CompetitorDomainDetail | null; error: unknown } | null>(null);
  useEffect(() => {
    if (!projectId || !domain) return;
    const ctrl = new AbortController();
    api<CompetitorDomainDetail>(morePaths.competitorDomain(projectId, domain), { signal: ctrl.signal })
      .then((d) => {
        if (!ctrl.signal.aborted) setDetail({ domain, data: d, error: null });
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setDetail({ domain, data: null, error: e });
      });
    return () => ctrl.abort();
  }, [projectId, domain, reload]);
  return detail && domain && detail.domain === domain ? detail : null;
}
