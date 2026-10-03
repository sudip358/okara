/**
 * SEO mode (docs/live-view-design.md section 4): nine stage panels, each one real stage of the agent's work.
 * Run-scoped panels (01–04, 08, 09) are fed by this run's revealed stored rows; project-level panels (05–07)
 * show current stored state with a caption saying they are not part of this run. Counters: during a replay,
 * counts of revealed rows; live and at the end of a replay, the server's whole-run totals.
 */
import { memo, useMemo, useState, type ReactElement } from "react";
import type { RunActivity } from "@shared/types";
import { cx, StateBanner } from "@web/components/ui";
import { useMinWidth } from "@web/pages/geo/board/data";
import {
  MAX_LIVE_SKELETONS,
  MAX_PENDING,
  countPageReads,
  elementCounts,
  elementDisplay,
  elementsOf,
  itemsOf,
  pageReads,
  queriesOf,
  queryCounts,
  queryGroups,
  recsOf,
  skippedReasons,
  stepSegments,
  stepStatus,
  type TimelineEvent,
} from "./engine";
import type { SeoFeed, SeoProjectData } from "./data";
import { livePaths, useSkipFactorsBatch } from "./data";
import { AiAnswersPanel, CompetitorsPanel, CoveragePanel, evidencePages } from "./ProjectPanels";
import { RecsPanel } from "./RecsPanel";
import { ElementsPanel } from "./seo/ElementsPanel";
import { LinksPanel } from "./seo/LinksPanel";
import { GscPanel, PagesPanel, QueriesPanel } from "./seo/RunPanels";
import type { LiveMode } from "./text";
import { LazyMount } from "./more/common";
import { useLiveMore } from "./more/data";
import { SEO_CONTAINERS, type ContainerDef } from "./more/registry";
import { CompetitorGapContainer, MoversContainer, StrikingContainer, TechnicalContainer } from "./more/SeoContainers";
import { BudgetContainer, SheetsContainer } from "./more/SharedContainers";

export interface SeoBoardProps {
  projectId: string;
  runId: string;
  ownHost: string;
  verified: boolean;
  activity: RunActivity;
  revealed: TimelineEvent[];
  upcoming: TimelineEvent[];
  /** A replay is on screen (playhead set). */
  replaying: boolean;
  /** Live / finished, or the replay reached its end: whole-run server totals apply. */
  atEnd: boolean;
  mode: LiveMode;
  fresh: ReadonlySet<string>;
  reduced: boolean;
  seo: SeoFeed | null;
  feedError: unknown;
  data: SeoProjectData;
}

/** Pending (replay) rows shown per panel: the next stored rows after the playhead, within MAX_PENDING. */
const PENDING_ELEMENTS = Math.min(8, MAX_PENDING);
const PENDING_QUERIES = Math.min(5, MAX_PENDING);
/** Panel 07 loads measured page attributes (skip factors) for this many pages only. */
export const SKIP_FACTOR_PAGES = 8;

/**
 * Grid cell per container (design section 4; section 17 for 10-15): fixed heights at >= 1280, so arriving rows
 * never shift the page; the project-level containers 10-15 sit in pairs under 08 / 09.
 */
const CELL: Record<string, string> = {
  pages: "xl:col-span-3 xl:h-[340px]",
  gsc: "xl:col-span-4 xl:h-[340px]",
  queries: "md:col-span-2 xl:col-span-5 xl:h-[340px]",
  elements: "md:col-span-2 xl:col-span-6 xl:h-[480px]",
  competitors: "md:col-span-2 xl:col-span-6 xl:h-[480px]",
  coverage: "xl:col-span-6 xl:max-h-[460px]",
  "ai-answers": "xl:col-span-6 xl:max-h-[460px]",
  links: "xl:col-span-6 xl:h-[400px]",
  recs: "xl:col-span-6 xl:h-[400px]",
  striking: "xl:col-span-6 xl:h-[420px]",
  movers: "xl:col-span-6 xl:h-[420px]",
  technical: "xl:col-span-6 xl:h-[420px]",
  "competitor-gap": "xl:col-span-6 xl:h-[420px]",
  sheets: "xl:col-span-6 xl:h-[400px]",
  budget: "xl:col-span-6 xl:h-[400px]",
};

export const SeoBoard = memo(function SeoBoard(p: SeoBoardProps) {
  const wide = useMinWidth(768);
  const more = useLiveMore();
  // Phone width: until the viewer picks a panel, the tab follows the step that is running (crawl, Search
  // Console sync, judging), so the panel on screen is the one where stored rows are arriving.
  const [picked, setTab] = useState<string | null>(null);
  const d = useMemo(() => {
    const items = itemsOf(p.revealed);
    const recs = recsOf(p.revealed);
    // Replay: "now → proposed" only once the recommendation that drafted the snippet has been revealed.
    const drafted = new Set(recs.map((r) => r.recommendationId));
    const els = p.replaying
      ? elementsOf(p.revealed).map((e) => (e.proposed !== null && (!e.recommendationId || !drafted.has(e.recommendationId)) ? { ...e, proposed: null } : e))
      : elementsOf(p.revealed);
    // Replay: the next stored rows after the playhead are pending (design section 9). They read "Reading…"
    // while the step that stores them is running at the playhead, and "Up next" (static) before it starts.
    const judging = p.replaying && stepStatus(items, "seo.recommend") === "running";
    const pendingEls = p.replaying ? elementsOf(p.upcoming).slice(0, PENDING_ELEMENTS).map((e) => ({ ...e, proposed: null })) : [];
    const qs = queriesOf(p.revealed);
    const pendingQs = p.replaying ? queriesOf(p.upcoming).slice(0, PENDING_QUERIES) : [];
    const segs = stepSegments(items, "seo").steps;
    const seg = (s: string) => segs.find((x) => x.step === s) ?? null;
    return {
      items,
      els,
      rows: elementDisplay(els, pendingEls),
      revealedCounts: elementCounts(els),
      groups: queryGroups(qs, pendingQs),
      qCounts: queryCounts(qs),
      reads: pageReads(items),
      readCount: countPageReads(items),
      skipped: skippedReasons(items),
      crawl: stepStatus(items, "seo.crawl"),
      crawlMsg: seg("seo.crawl")?.message ?? null,
      gsc: stepStatus(items, "seo.gsc_sync"),
      gscMsg: seg("seo.gsc_sync")?.message ?? null,
      recommend: stepStatus(items, "seo.recommend"),
      links: els.filter((e) => e.element === "Links" && e.linkSuggestionId),
      recs,
      latestRead: items.filter((i) => i.kind === "page_read").pop() ?? null,
      pendingLabel: (judging ? "Reading…" : "Up next") as "Reading…" | "Up next",
    };
  }, [p.revealed, p.upcoming, p.replaying]);

  const totals = p.seo?.totals ?? null;
  const server = p.atEnd && totals !== null;
  const counts = server ? totals.elements : d.revealedCounts;
  const notReplayed = p.replaying && p.atEnd && totals ? Math.max(0, totals.elements.judged - d.revealedCounts.judged) : 0;
  const qRelevant = server ? totals.queries.relevance.yes : d.qCounts.relevant;
  const qDistinct = server ? totals.queries.distinct : d.qCounts.distinct;
  const pagesRead = p.atEnd ? Math.max(p.activity.totals.pagesRead, d.readCount) : d.readCount;
  const nowReading = p.replaying ? (d.crawl === "running" && d.latestRead?.url ? { url: d.latestRead.url, at: d.latestRead.at } : null) : p.activity.active ? p.activity.nowReading : null;
  const skeletons = p.mode === "live" && d.recommend === "running" ? MAX_LIVE_SKELETONS : 0;
  const finished = p.mode !== "live" && p.mode !== "pending" && (!p.replaying || p.atEnd);
  // Only once the run (or its replay) is over: while live, Jev rows may still be stored.
  const jevMissing = finished && d.els.length > 0 && d.els.every((e) => e.role === "rule");

  const projCaptions = [`From your latest GEO data, not part of this run`, p.replaying ? "Current state, not replayed" : null].filter((x): x is string => !!x);
  const coverageRows = p.data.coverage.data?.rows ?? null;
  const evidenceRows = useMemo(() => (p.data.evidence.data ? evidencePages(p.data.evidence.data.rows, coverageRows ?? []) : []), [p.data.evidence.data, coverageRows]);
  const skipReqs = useMemo(
    () => evidenceRows.filter((r) => r.pageId).slice(0, SKIP_FACTOR_PAGES).map((r) => ({ pageId: r.pageId!, promptId: null, engine: null })),
    [evidenceRows],
  );
  const skip = useSkipFactorsBatch(p.projectId, skipReqs, SKIP_FACTOR_PAGES);
  const requested = useMemo(() => new Set(skipReqs.map((r) => r.pageId)), [skipReqs]);
  // Exact page-level key; pages beyond the first SKIP_FACTOR_PAGES are never fetched ("not_loaded", no shimmer).
  const skipFor = (pageId: string) => (requested.has(pageId) ? skip.get(livePaths.skip(p.projectId, pageId, null, null)) : ("not_loaded" as const));

  const panels: Record<string, ReactElement> = {
    pages: (
      <PagesPanel
        reads={d.reads}
        pagesRead={pagesRead}
        pagesPlanned={p.activity.totals.pagesPlanned}
        nowReading={nowReading}
        crawl={d.crawl}
        crawlMessage={d.crawlMsg}
        skipped={d.skipped}
        finished={finished}
        fresh={p.fresh}
        reduced={p.reduced}
        projectId={p.projectId}
        verified={p.verified}
      />
    ),
    gsc: (
      <GscPanel
        overview={p.data.overview.data}
        overviewError={p.data.overview.error}
        sync={p.seo?.gscSync ?? null}
        step={d.gsc}
        stepMessage={d.gscMsg}
        reduced={p.reduced}
        projectId={p.projectId}
        replaying={p.replaying}
      />
    ),
    queries: (
      <QueriesPanel
        groups={d.groups}
        relevant={qRelevant}
        distinct={qDistinct}
        buyer={p.data.buyer.data?.rows ?? null}
        fresh={p.fresh}
        reduced={p.reduced}
        finished={finished}
        pendingLabel={d.pendingLabel}
      />
    ),
    elements: (
      <ElementsPanel
        rows={d.rows}
        change={counts.change}
        judged={counts.judged}
        skeletons={skeletons}
        fresh={p.fresh}
        reduced={p.reduced}
        projectId={p.projectId}
        runId={p.runId}
        notReplayed={notReplayed}
        jevMissing={jevMissing}
        pendingLabel={d.pendingLabel}
      />
    ),
    competitors: <CompetitorsPanel state={p.data.competitors} reduced={p.reduced} projectId={p.projectId} captions={projCaptions} />,
    coverage: <CoveragePanel state={p.data.coverage} reduced={p.reduced} projectId={p.projectId} ownHost={p.ownHost} captions={projCaptions} />,
    "ai-answers": <AiAnswersPanel evidence={p.data.evidence} coverage={coverageRows} skipFor={skipFor} factorPages={SKIP_FACTOR_PAGES} reduced={p.reduced} captions={projCaptions} />,
    links: <LinksPanel report={p.data.links} runRows={d.links} reduced={p.reduced} projectId={p.projectId} replaying={p.replaying} />,
    recs: (
      <RecsPanel
        num="09"
        title="Recommendations drafted and checked"
        recs={d.recs}
        pipeline={p.replaying && !p.atEnd ? null : (totals?.pipeline ?? null)}
        replaying={p.replaying && !p.atEnd}
        fresh={p.fresh}
        reduced={p.reduced}
        projectId={p.projectId}
        finished={finished}
      />
    ),
    // Section 17: project-level containers, each fetching its own stored aggregate (lazily below the fold).
    striking: <StrikingContainer projectId={p.projectId} reduced={p.reduced} />,
    movers: <MoversContainer projectId={p.projectId} reduced={p.reduced} />,
    technical: <TechnicalContainer projectId={p.projectId} reduced={p.reduced} />,
    "competitor-gap": <CompetitorGapContainer projectId={p.projectId} reduced={p.reduced} />,
    sheets: <SheetsContainer projectId={p.projectId} reduced={p.reduced} mode="seo" />,
    budget: <BudgetContainer projectId={p.projectId} reduced={p.reduced} mode="seo" />,
  };

  const shown: ContainerDef[] = SEO_CONTAINERS.filter((c) => !more.hidden.has(c.key));
  const following = d.crawl === "running" ? "pages" : d.gsc === "running" ? "gsc" : "elements";
  const tab = [picked, following].find((k) => !!k && shown.some((c) => c.key === k)) ?? shown[0]?.key ?? null;
  const tabDef = shown.find((c) => c.key === tab) ?? null;

  const feedBanner =
    !p.seo && p.feedError ? (
      <StateBanner state="error" title="The live SEO feed could not be loaded" message="Panels 03, 04 and 09 wait for it; the other panels show the stored rows they have." />
    ) : null;

  const allHidden = shown.length === 0 ? <p className="py-6 text-center text-xs text-zinc-600 dark:text-zinc-400">Every container is hidden. Use “Containers” in the header to show them again.</p> : null;

  if (!wide) {
    return (
      <div className="min-w-0 space-y-3">
        {feedBanner}
        {allHidden}
        {shown.length > 0 && (
          <div role="tablist" aria-label="Panels" className="lv-strip relative flex gap-1 overflow-x-auto pb-1" tabIndex={0}>
            {shown.map((c) => (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={tab === c.key}
                onClick={() => setTab(c.key)}
                className={cx(
                  "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium focus-visible:outline-2 focus-visible:outline-sky-600",
                  tab === c.key ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
                )}
              >
                {c.tab}
              </button>
            ))}
          </div>
        )}
        {tabDef && (
          <div role="tabpanel" aria-label={tabDef.tab} className="min-w-0 [&>section]:max-h-[70vh]">
            {panels[tabDef.key]}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {feedBanner}
      {allHidden}
      {/* Rows (design section 4): 01 02 03 | 04 05 | 06 07 | 08 09, then section 17: 10 11 | 12 13 | 14 15. Panels
          fed by rows of this run keep a fixed height so arriving rows never shift the page; the project-level rows
          size to their content (capped); containers 10-15 mount when they come near the viewport. */}
      <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
        {shown.map((c) => (
          <Cell key={c.key} cls={CELL[c.key] ?? "xl:col-span-6"}>
            {c.more ? (
              <LazyMount def={c} reduced={p.reduced}>
                {panels[c.key]!}
              </LazyMount>
            ) : (
              panels[c.key]!
            )}
          </Cell>
        ))}
      </div>
    </div>
  );
});

/** Grid cell: sizes the panel (fixed height at ≥ 1280, capped at 70vh below). */
function Cell({ cls, children }: { cls: string; children: ReactElement }) {
  return <div className={cx("flex min-h-0 min-w-0 flex-col max-xl:max-h-[70vh] [&>section]:flex-1", cls)}>{children}</div>;
}
