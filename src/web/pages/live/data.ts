/**
 * Live view data (docs/live-view-design.md section 3). One heartbeat, feeds on demand:
 *
 * - Heartbeat: GET /runs/:runId/activity?after= (existing). Paged from the start of the run (up to
 *   REPLAY_MAX_PAGES pages), then every 2 s while the run is active, visible tab only.
 * - Feed: GET /live/seo or /live/geo?runId=&after= (NEW). Paged from the start once, then only right after a
 *   heartbeat page that carried rows of its kind, when the run just finished, or every 6 s while active.
 *   So steady state is at most one heartbeat plus one feed request per 2 s tick, and nothing while hidden.
 * - Project-level panels reuse the existing endpoints unchanged, refetched once when the step that changes
 *   them reaches a terminal status.
 *
 * Every row shown comes from these stored rows. Cursors are opaque and committed only with the rows they
 * cover; a 404/403 on the run is final ("This run is no longer available.").
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityItem,
  AnswerCoverageRow,
  BuyerQueryRow,
  CitationEvidenceRow,
  CoverageResponse,
  EngineBoardResponse,
  GeoObservationDetail,
  LinkSuggestionReport,
  LiveGeoBoardResponse,
  LiveSeoBoardResponse,
  PageSkipFactors,
  RewritePlansResponse,
  RunActivity,
  RunSummary,
  SeoOverview,
} from "@shared/types";
import { api } from "@web/lib/api";
import { useApi } from "@web/lib/hooks";
import { POLL, activityPath, catchUp, isFinalError, mergeItems } from "@web/components/activity/lib";
import { boardPaths, useCompetitorPages } from "@web/pages/geo/board/data";
import { MAX_EVENTS, REPLAY_MAX_PAGES, REPLAY_PAGE_LIMIT, mergeById } from "./engine";

const p = (pid: string) => `/projects/${encodeURIComponent(pid)}`;
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

/** Feed fetched at least this often while the run is active (when no heartbeat signal arrived). */
export const FEED_EVERY_MS = 6_000;
/** Pages per later tick (a backlog drains on the next tick). */
const LATER_PAGES = 5;

export const livePaths = {
  feed: (pid: string, agent: "seo" | "geo", runId: string, after: string | null, limit = REPLAY_PAGE_LIMIT) => {
    const q = new URLSearchParams({ runId });
    if (after) q.set("after", after);
    q.set("limit", String(limit));
    return `${p(pid)}/live/${agent}?${q.toString()}`;
  },
  overview: (pid: string) => `${p(pid)}/seo/overview`,
  buyer: (pid: string) => `${p(pid)}/seo/buyer-queries`,
  links: (pid: string) => `${p(pid)}/seo/internal-links`,
  evidence: (pid: string) => `${p(pid)}/geo/citation-evidence`,
  skip: (pid: string, pageId: string, promptId: string | null, engine: string | null) => {
    const q = new URLSearchParams();
    if (promptId) q.set("promptId", promptId);
    if (engine) q.set("engine", engine);
    const s = q.toString();
    return `${p(pid)}/geo/pages/${encodeURIComponent(pageId)}/skip-factors${s ? `?${s}` : ""}`;
  },
  observation: (id: string) => `/geo/observations/${encodeURIComponent(id)}`,
};

/** A heartbeat page with rows of the feed's kind (fetch the feed right away). */
export function isFeedSignal(agent: "seo" | "geo", it: ActivityItem): boolean {
  if (agent === "seo") return it.kind === "jev_decision" || (it.kind === "step" && !!it.detail?.startsWith("seo."));
  return it.kind === "engine_answer" || (it.kind === "step" && (!!it.detail?.startsWith("geo.proposals") || !!it.detail?.startsWith("geo_batch:")));
}

export interface SeoFeed {
  elements: LiveSeoBoardResponse["elements"];
  queries: LiveSeoBoardResponse["queries"];
  recommendations: LiveSeoBoardResponse["recommendations"];
  gscSync: LiveSeoBoardResponse["gscSync"];
  totals: LiveSeoBoardResponse["totals"] | null;
  labels: string[];
}

export interface GeoFeed {
  answers: LiveGeoBoardResponse["answers"];
  plannedPrompts: LiveGeoBoardResponse["plannedPrompts"];
  recommendations: LiveGeoBoardResponse["recommendations"];
  totals: LiveGeoBoardResponse["totals"] | null;
  labels: string[];
}

export function mergeSeoFeed(prev: SeoFeed | null, res: LiveSeoBoardResponse): SeoFeed {
  return {
    elements: mergeById(prev?.elements ?? [], res.elements),
    queries: mergeById(prev?.queries ?? [], res.queries),
    recommendations: mergeById(prev?.recommendations ?? [], res.recommendations),
    gscSync: res.gscSync ?? prev?.gscSync ?? null,
    totals: res.totals ?? prev?.totals ?? null,
    labels: Array.from(new Set([...(prev?.labels ?? []), ...res.labels])),
  };
}

export function mergeGeoFeed(prev: GeoFeed | null, res: LiveGeoBoardResponse): GeoFeed {
  return {
    answers: mergeById(prev?.answers ?? [], res.answers),
    plannedPrompts: prev?.plannedPrompts ?? res.plannedPrompts ?? null,
    recommendations: mergeById(prev?.recommendations ?? [], res.recommendations),
    totals: res.totals ?? prev?.totals ?? null,
    labels: Array.from(new Set([...(prev?.labels ?? []), ...res.labels])),
  };
}

export interface LiveRunData {
  activity: RunActivity | null;
  items: ActivityItem[];
  seo: SeoFeed | null;
  geo: GeoFeed | null;
  /** The initial backlog is still being paged in. */
  loading: boolean;
  /** Stored rows received so far (progress while loading). */
  loaded: number;
  /** A replay cap (REPLAY_MAX_PAGES per source) was hit: only the first events are replayed. */
  capped: boolean;
  error: unknown;
  finalError: boolean;
  feedError: unknown;
  /** Ids that arrived in the latest poll after the initial load (motion + announcements). */
  arrivals: { seq: number; ids: ReadonlySet<string> };
}

const NO_ARRIVALS = { seq: 0, ids: new Set<string>() as ReadonlySet<string> };

/** Heartbeat + the agent's live feed for one run (see module comment). */
export function useLiveRun(projectId: string, runId: string | null): LiveRunData {
  const [activity, setActivity] = useState<RunActivity | null>(null);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [seo, setSeo] = useState<SeoFeed | null>(null);
  const [geo, setGeo] = useState<GeoFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(0);
  const [capped, setCapped] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [finalError, setFinalError] = useState(false);
  const [feedError, setFeedError] = useState<unknown>(null);
  const [arrivals, setArrivals] = useState(NO_ARRIVALS);

  useEffect(() => {
    setActivity(null);
    setItems([]);
    setSeo(null);
    setGeo(null);
    setLoaded(0);
    setCapped(false);
    setError(null);
    setFinalError(false);
    setFeedError(null);
    setArrivals(NO_ARRIVALS);
    if (!runId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const ctrl = new AbortController();
    const signal = ctrl.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onVisible: (() => void) | undefined;
    let cursor: string | null = null;
    let feedCursor: string | null = null;
    let initial = true;
    let wasActive: boolean | null = null;
    let lastFeed = 0;
    let seq = 0;
    let count = 0;

    const waitVisible = () => {
      if (onVisible || typeof document === "undefined") return;
      onVisible = () => {
        if (!visible()) return;
        document.removeEventListener("visibilitychange", onVisible!);
        onVisible = undefined;
        void tick();
      };
      document.addEventListener("visibilitychange", onVisible);
    };

    /** Pages the feed forward; commits each page (rows + cursor) as it lands. Returns the ids received. */
    async function pullFeed(agent: "seo" | "geo", maxPages: number): Promise<{ ids: Set<string>; capped: boolean }> {
      const ids = new Set<string>();
      for (let page = 0; page < maxPages; page++) {
        const path = livePaths.feed(projectId, agent, runId!, feedCursor);
        let n: number;
        let next: string | null;
        if (agent === "seo") {
          const res = await api<LiveSeoBoardResponse>(path, { signal });
          if (signal.aborted) return { ids, capped: false };
          n = res.elements.length + res.queries.length + res.recommendations.length;
          next = res.cursor;
          setSeo((prev) => mergeSeoFeed(prev, res));
          for (const r of res.elements) ids.add(r.id);
          for (const r of res.queries) ids.add(r.id);
          for (const r of res.recommendations) ids.add(r.id);
        } else {
          const res = await api<LiveGeoBoardResponse>(path, { signal });
          if (signal.aborted) return { ids, capped: false };
          n = res.answers.length + res.recommendations.length;
          next = res.cursor;
          setGeo((prev) => mergeGeoFeed(prev, res));
          for (const r of res.answers) ids.add(r.id);
          for (const r of res.recommendations) ids.add(r.id);
        }
        const moved = !!next && next !== feedCursor;
        if (next) feedCursor = next;
        count += n;
        if (n < REPLAY_PAGE_LIMIT || !moved) return { ids, capped: false };
        if (page === maxPages - 1) return { ids, capped: true };
      }
      return { ids, capped: false };
    }

    async function tick() {
      if (signal.aborted) return;
      if (!initial && !visible()) return waitVisible();
      try {
        const r = await catchUp(
          (after) => api<RunActivity>(activityPath(projectId, runId!, after, REPLAY_PAGE_LIMIT), { signal }),
          cursor,
          initial ? REPLAY_MAX_PAGES : LATER_PAGES,
          MAX_EVENTS,
        );
        if (signal.aborted) return;
        cursor = r.cursor;
        const res = r.last;
        const agent = res.run.agent;
        count += r.received;
        setActivity(res);
        setItems((prev) => mergeItems(prev, r.items, MAX_EVENTS));
        setError(null);
        if (initial && r.more) setCapped(true);

        const justFinished = wasActive === true && !res.active;
        const signalled = r.items.some((it) => isFeedSignal(agent, it));
        const due = res.active && Date.now() - lastFeed >= FEED_EVERY_MS;
        let feedIds = new Set<string>();
        if (initial || signalled || justFinished || due) {
          try {
            const f = await pullFeed(agent, initial ? REPLAY_MAX_PAGES : LATER_PAGES);
            if (signal.aborted) return;
            feedIds = f.ids;
            if (initial && f.capped) setCapped(true);
            setFeedError(null);
          } catch (e) {
            if (signal.aborted) return;
            // The heartbeat keeps the view going; the feed is retried on the next signal or after 6 s.
            setFeedError(e);
          }
          lastFeed = Date.now();
        }
        setLoaded(count);
        if (!initial) {
          const ids = new Set<string>(r.items.map((i) => i.id));
          for (const id of feedIds) ids.add(id);
          if (ids.size > 0) setArrivals({ seq: ++seq, ids });
        }
        wasActive = res.active;
        initial = false;
        setLoading(false);
        if (res.active) timer = setTimeout(tick, r.more ? 0 : POLL.feed);
      } catch (e) {
        if (signal.aborted) return;
        setError(e);
        setLoading(false);
        if (isFinalError(e)) setFinalError(true);
        else timer = setTimeout(tick, POLL.feed * 3);
      }
    }
    void tick();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
      if (onVisible && typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, runId]);

  return { activity, items, seo, geo, loading, loaded, capped, error, finalError, feedError, arrivals };
}

/** Emits `value` at most once per `ms` (leading and trailing), e.g. refetch keys and throttled detail fetches. */
export function useThrottled<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  const last = useRef(0);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (Object.is(value, out)) return;
    const now = Date.now();
    const wait = last.current + ms - now;
    if (wait <= 0) {
      last.current = now;
      setOut(value);
      return;
    }
    const t = setTimeout(() => {
      last.current = Date.now();
      setOut(latest.current);
    }, wait);
    return () => clearTimeout(t);
  }, [value, out, ms]);
  return out;
}

// ------------------------------------------------------------------ project-level panels (existing endpoints)
export interface SeoProjectData {
  overview: ReturnType<typeof useApi<SeoOverview>>;
  buyer: ReturnType<typeof useApi<CoverageResponse<BuyerQueryRow>>>;
  links: ReturnType<typeof useApi<LinkSuggestionReport>>;
  competitors: ReturnType<typeof useCompetitorPages>;
  coverage: ReturnType<typeof useApi<CoverageResponse<AnswerCoverageRow>>>;
  evidence: ReturnType<typeof useApi<CoverageResponse<CitationEvidenceRow>>>;
}

/** `gscKey`/`recommendKey` change when those steps reach a terminal status (one refetch each). */
export function useSeoProjectData(projectId: string, enabled: boolean, keys: { gsc: string; recommend: string }): SeoProjectData {
  const on = enabled && !!projectId;
  const overview = useApi<SeoOverview>(on ? livePaths.overview(projectId) : null, [keys.gsc]);
  const buyer = useApi<CoverageResponse<BuyerQueryRow>>(on ? livePaths.buyer(projectId) : null, [keys.recommend]);
  const links = useApi<LinkSuggestionReport>(on ? livePaths.links(projectId) : null);
  const competitors = useCompetitorPages(on ? projectId : "");
  const coverage = useApi<CoverageResponse<AnswerCoverageRow>>(on ? boardPaths.answerCoverage(projectId) : null);
  const evidence = useApi<CoverageResponse<CitationEvidenceRow>>(on ? livePaths.evidence(projectId) : null);
  // Stable identity while nothing changed, so the memoised boards skip the replay clock's 100 ms ticks.
  return useMemo(
    () => ({ overview, buyer, links, competitors, coverage, evidence }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    stateDeps([overview, buyer, links, competitors, coverage, evidence]),
  );
}

/** Dependency list for a group of ApiStates: what a panel can see changes only with data, error or loading. */
function stateDeps(states: Array<{ data: unknown; error: unknown; loading: boolean }>): unknown[] {
  return states.flatMap((st) => [st.data, st.error, st.loading]);
}

export interface GeoProjectData {
  board: ReturnType<typeof useApi<EngineBoardResponse>>;
  competitors: ReturnType<typeof useCompetitorPages>;
  plans: ReturnType<typeof useApi<RewritePlansResponse>>;
  coverage: ReturnType<typeof useApi<CoverageResponse<AnswerCoverageRow>>>;
}

/** Board after geo.batch ends; plans after geo.proposals ends; coverage after each lane ends (at most 1 per 10 s). */
export function useGeoProjectData(projectId: string, enabled: boolean, keys: { batch: string; proposals: string; lanes: string }): GeoProjectData {
  const on = enabled && !!projectId;
  const lanesKey = useThrottled(keys.lanes, 10_000);
  const board = useApi<EngineBoardResponse>(on ? boardPaths.board(projectId) : null, [keys.batch]);
  const competitors = useCompetitorPages(on ? projectId : "");
  const plans = useApi<RewritePlansResponse>(on ? boardPaths.rewritePlans(projectId) : null, [keys.proposals]);
  const coverage = useApi<CoverageResponse<AnswerCoverageRow>>(on ? boardPaths.answerCoverage(projectId) : null, [lanesKey]);
  return useMemo(
    () => ({ board, competitors, plans, coverage }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    stateDeps([board, competitors, plans, coverage]),
  );
}

/** Latest run of an agent from the run list (only needed when the other agent has no run in `current`). */
export function useRunList(projectId: string, enabled: boolean) {
  return useApi<RunSummary[]>(enabled && projectId ? boardPaths.runs(projectId) : null);
}

// ------------------------------------------------------------------ skip factors (lazy, cached)
const skipCache = new Map<string, PageSkipFactors>();

export interface SkipRequest {
  pageId: string;
  promptId: string | null;
  engine: string | null;
}

/** Skip factors for up to `max` pages, fetched once each (sequentially) and cached for the session. */
export function useSkipFactorsBatch(projectId: string, reqs: SkipRequest[], max = 8): Map<string, PageSkipFactors | "error"> {
  const list = reqs.slice(0, max);
  const key = list.map((r) => livePaths.skip(projectId, r.pageId, r.promptId, r.engine)).join("\n");
  const [state, setState] = useState<Map<string, PageSkipFactors | "error">>(() => {
    const m = new Map<string, PageSkipFactors | "error">();
    for (const path of key ? key.split("\n") : []) {
      const hit = skipCache.get(path);
      if (hit) m.set(path, hit);
    }
    return m;
  });
  useEffect(() => {
    if (!projectId || !key) return;
    const ctrl = new AbortController();
    void (async () => {
      for (const path of key.split("\n")) {
        if (ctrl.signal.aborted) return;
        const hit = skipCache.get(path);
        if (hit) {
          setState((m) => (m.get(path) === hit ? m : new Map(m).set(path, hit)));
          continue;
        }
        try {
          const res = await api<PageSkipFactors>(path, { signal: ctrl.signal });
          if (ctrl.signal.aborted) return;
          skipCache.set(path, res);
          setState((m) => new Map(m).set(path, res));
        } catch {
          if (ctrl.signal.aborted) return;
          setState((m) => new Map(m).set(path, "error"));
        }
      }
    })();
    return () => ctrl.abort();
  }, [projectId, key]);
  return state;
}

/** One answer in full (GEO panel 02), throttled by the caller. */
export function useObservation(id: string | null) {
  return useApi<GeoObservationDetail>(id ? livePaths.observation(id) : null);
}
