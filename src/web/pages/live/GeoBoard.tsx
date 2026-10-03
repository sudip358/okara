/**
 * GEO mode (docs/live-view-design.md section 5): one column per engine lane of the run (board order), each
 * with header, gauge, stats and sections A–D, then 01 Prompt × engine, 02 Inside the latest answer,
 * 03 Cited instead, 04 Do our pages answer what people ask AI?, 05 Proposals drafted and checked.
 * Everything is from this run's stored answers (revealed so far) or the existing project endpoints.
 */
import { memo, useMemo, useRef, useState, type ReactElement } from "react";
import { Link } from "react-router";
import type { EngineFeedItem, GeoObservationDetail, LiveGeoAnswerRow, RunActivity } from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx, EmptyState, StateBanner } from "@web/components/ui";
import { useMinWidth } from "@web/pages/geo/board/data";
import { approvalCandidates, assessmentsForEngine, engineName, plansForEngine, plansWithoutEngine, urlKey } from "@web/pages/geo/board/lib";
import { ObservationDrawer } from "@web/pages/geo/components/ObservationDrawer";
import {
  MAX_PENDING,
  answerIndex,
  answerKey,
  answersOf,
  citedInsteadBars,
  heatCell,
  itemsOf,
  laneStateAt,
  laneStrip,
  laneTotalsFrom,
  latestSkipped,
  recsOf,
  type TimelineEvent,
} from "./engine";
import type { GeoFeed, GeoProjectData } from "./data";
import { livePaths, useObservation, useSkipFactorsBatch, useThrottled } from "./data";
import { CoveragePanel } from "./ProjectPanels";
import { RecsPanel } from "./RecsPanel";
import { CitedInsteadPanel, HeatmapPanel, LatestAnswerPanel } from "./geo/GeoPanels";
import { LaneColumn } from "./geo/LaneColumn";
import { EngineBadge } from "./parts";
import { urlPath, type LiveMode } from "./text";
import { LazyMount } from "./more/common";
import { useLiveMore } from "./more/data";
import { GEO_CONTAINERS } from "./more/registry";
import { BrandsContainer, CitedDomainsContainer, EngineQueriesContainer, PromptHistoryContainer } from "./more/GeoContainers";
import { BudgetContainer, SheetsContainer } from "./more/SharedContainers";

export interface GeoBoardProps {
  projectId: string;
  ownHost: string;
  demo: boolean;
  activity: RunActivity;
  revealed: TimelineEvent[];
  upcoming: TimelineEvent[];
  replaying: boolean;
  atEnd: boolean;
  mode: LiveMode;
  fresh: ReadonlySet<string>;
  reduced: boolean;
  geo: GeoFeed | null;
  feedError: unknown;
  data: GeoProjectData;
}

/** Minimal feed shape for the board's approval-candidate helper (only citedInstead and promptText are read). */
function asFeedItem(a: LiveGeoAnswerRow): EngineFeedItem {
  return {
    promptId: a.promptId ?? "",
    promptText: a.promptText,
    observationId: a.observationId,
    status: a.outcome === "cited" ? "cited" : a.outcome === "named" ? "named" : "missing",
    position: a.position,
    sentiment: a.sentiment,
    latencyMs: a.latencyMs,
    grounded: a.grounded,
    citedInstead: a.citedInstead,
    observedAt: a.at,
  };
}

export const GeoBoard = memo(function GeoBoard(p: GeoBoardProps) {
  const wide = useMinWidth(768);
  const more = useLiveMore();
  const [laneTab, setLaneTab] = useState<string | null>(null);
  const [extraTab, setExtraTab] = useState<string | null>(null);
  const [obs, setObs] = useState<{ id: string; title: string } | null>(null);
  const liveActive = p.mode === "live" && p.activity.active;
  const board = p.data.board.data;
  const competitors = p.data.competitors.data ?? [];
  const plans = p.data.plans.data?.plans ?? [];

  const d = useMemo(() => {
    const items = itemsOf(p.revealed);
    const answers = answersOf(p.revealed);
    const upcoming = p.replaying ? answersOf(p.upcoming) : [];
    const pendingKeys = new Set(upcoming.slice(0, MAX_PENDING).map(answerKey).filter((k): k is string => !!k));
    const futureKeys = new Set(upcoming.map(answerKey).filter((k): k is string => !!k));
    return { items, answers, upcoming, pendingKeys, futureKeys, index: answerIndex(answers), recs: recsOf(p.revealed), bars: citedInsteadBars(answers) };
  }, [p.revealed, p.upcoming, p.replaying]);
  // Mid-replay: at-playhead state from revealed events; live, finished and at the end: the server's state.
  const midReplay = p.replaying && !p.atEnd;

  // Lanes of the run, in board order (built-in engines, then custom).
  const order = new Map((board?.lanes ?? []).map((l, i) => [l.provider as string, i]));
  const lanes = p.activity.lanes.slice().sort((a, b) => (order.get(a.provider) ?? 99) - (order.get(b.provider) ?? 99));
  const laneInfo = lanes.map((lane) => {
    const answeredSoFar = d.answers.filter((a) => a.provider === lane.provider).length;
    const laneState = midReplay ? laneStateAt(d.items, lane.provider, answeredSoFar) : lane.state;
    const busy = laneState === "asking" || laneState === "queued";
    const bl = board?.lanes.find((l) => l.provider === lane.provider);
    const own = d.answers.filter((a) => a.provider === lane.provider);
    const server = p.atEnd ? p.geo?.totals?.lanes.find((t) => t.provider === lane.provider) : undefined;
    const totals = server ?? laneTotalsFrom(d.answers, lane.provider);
    const skipped = latestSkipped(d.answers, lane.provider);
    const assessments = assessmentsForEngine(competitors, lane.provider);
    const latestInstead = [...own].reverse().find((a) => a.citedInstead?.url)?.citedInstead?.url ?? null;
    const assessment =
      (latestInstead ? assessments.find((a) => urlKey(a.url) === urlKey(latestInstead)) : undefined) ??
      assessments.filter((a) => a.state === "assessed").sort((a, b) => ((b.fetchedAt ?? b.approvedAt) < (a.fetchedAt ?? a.approvedAt) ? -1 : 1))[0] ??
      assessments[0] ??
      null;
    const approval = assessment ? null : (approvalCandidates([...own].reverse().map(asFeedItem), competitors, 1)[0] ?? null);
    const lanePlans = plansForEngine(plans, lane.provider as never);
    const enginePlan = lanePlans.find((pl) => skipped.row?.matchedPage?.pageId && pl.pageId === skipped.row.matchedPage.pageId) ?? lanePlans[0] ?? null;
    // No plan for this engine: the page-level plan (no engine) of the page shown in B, labelled as such.
    const pagePlan = enginePlan ? null : (plansWithoutEngine(plans).find((pl) => !!skipped.row?.matchedPage?.pageId && pl.pageId === skipped.row.matchedPage.pageId) ?? null);
    // The model and grounding stored with this lane's newest answer of the run.
    const withModel = [...own].reverse().find((a) => a.model);
    return {
      lane,
      bl,
      totals,
      // A failed call is not an answer: answered = analysed or awaiting analysis.
      answered: totals.cited + totals.named + totals.missing + totals.pending,
      runModel: own.length > 0 ? { model: withModel?.model ?? null, groundingMode: withModel?.groundingMode ?? own[own.length - 1]!.groundingMode ?? null } : null,
      laneState,
      strip: laneStrip(d.answers, lane.provider),
      queued: liveActive ? (p.activity.queued.find((q) => q.provider === lane.provider) ?? null) : null,
      // Replay: the lane's next stored answer is pending only while the lane is asking at the playhead.
      pending: p.replaying && busy ? (d.upcoming.find((a) => a.provider === lane.provider) ?? null) : null,
      skipped,
      assessments,
      assessment,
      approval,
      plans: lanePlans,
      plan: enginePlan ?? pagePlan,
      planFallback: !enginePlan && !!pagePlan,
    };
  });

  // B cards: one skip-factor request per lane, throttled (at most one change per 4 s).
  const skipKey = laneInfo
    .map((l) => (l.skipped.row?.matchedPage?.pageId ? `${l.skipped.row.matchedPage.pageId}|${l.skipped.row.promptId ?? ""}|${l.lane.provider}` : ""))
    .join("\n");
  const skipKeyT = useThrottled(skipKey, 4_000);
  const skipReqs = useMemo(
    () =>
      skipKeyT
        .split("\n")
        .filter(Boolean)
        .map((k) => {
          const [pageId, promptId, engine] = k.split("|");
          return { pageId: pageId!, promptId: promptId || null, engine: engine || null };
        }),
    [skipKeyT],
  );
  const skip = useSkipFactorsBatch(p.projectId, skipReqs, 8);
  // Exact key: factors measured for THIS prompt and engine (answer-first is judged against the prompt text).
  const skipFor = (row: LiveGeoAnswerRow | null, provider: string) => {
    const pageId = row?.matchedPage?.pageId;
    if (!row || !pageId) return undefined;
    return skip.get(livePaths.skip(p.projectId, pageId, row.promptId ?? null, provider));
  };

  // 02: newest revealed answer that is not a failed call, throttled (live 1 per 4 s; replay 1 per 2 s of
  // playback). The previous answer stays on screen until the next one has loaded.
  const newest = [...d.answers].reverse().find((a) => a.outcome !== "failed") ?? d.answers[d.answers.length - 1] ?? null;
  const obsId = useThrottled(newest?.observationId ?? null, p.replaying ? 2_000 : 4_000);
  const detail = useObservation(obsId);
  const lastDetail = useRef<GeoObservationDetail | null>(null);
  if (detail.data && detail.data.id === obsId) lastDetail.current = detail.data;
  const shownDetail = detail.data && detail.data.id === obsId ? detail.data : lastDetail.current && d.answers.some((a) => a.observationId === lastDetail.current!.id) ? lastDetail.current : null;
  const shownId = shownDetail?.id ?? obsId;
  const newestShown = shownId ? (d.answers.find((a) => a.observationId === shownId) ?? newest) : newest;

  // 01 / 04 inputs. Heatmap rows: the planned prompts (current approvals and cap), plus every prompt this run
  // has stored answers for (a row only; its cells fill as the answers are revealed) that is not planned any
  // more, so stored answers are never hidden.
  const observed = Array.from(
    new Map((p.geo?.answers ?? d.answers).filter((a) => a.promptId).map((a) => [a.promptId!, { promptId: a.promptId!, text: a.promptText }])).values(),
  );
  const plannedList = p.geo?.plannedPrompts ?? [];
  const plannedIds = new Set(plannedList.map((x) => x.promptId));
  const planned = [...plannedList, ...observed.filter((x) => !plannedIds.has(x.promptId))];
  const laneBusy = new Map(laneInfo.map((l) => [l.lane.provider, l.laneState === "queued" || l.laneState === "asking"]));
  const pendingKeys = new Set(Array.from(d.pendingKeys).filter((k) => laneBusy.get(k.slice(k.indexOf("|") + 1))));
  const cell = (promptId: string, provider: string) => heatCell(d.index, pendingKeys, d.futureKeys, promptId, provider, { liveActive, laneBusy: laneBusy.get(provider) ?? false });
  const textToId = new Map(planned.map((pp) => [pp.text, pp.promptId]));
  const asking = new Set<string>();
  if (liveActive) for (const q of p.activity.queued) {
    const id = textToId.get(q.promptText);
    if (id) asking.add(id);
  }
  const answersByPrompt = new Map<string, LiveGeoAnswerRow>();
  for (const a of d.answers) if (a.promptId && a.outcome !== null) answersByPrompt.set(a.promptId, a);
  const planPages = new Set(plans.map((pl) => urlPath(pl.url)));
  const projCaptions = p.replaying ? ["Current state, not replayed"] : [];
  const laneLabels = laneInfo.map((l) => ({ provider: l.lane.provider, label: l.bl?.label ?? l.lane.label }));

  const open = (id: string, title: string) => setObs({ id, title });

  const columns = laneInfo.map((l) => (
    <LaneColumn
      key={l.lane.provider}
      provider={l.lane.provider}
      lane={l.lane}
      board={l.bl}
      laneState={l.laneState}
      totals={l.totals}
      answered={l.answered}
      runModel={l.runModel}
      runActive={liveActive}
      planFallback={l.planFallback}
      strip={l.strip}
      queued={l.queued}
      pending={l.pending}
      skipped={l.skipped}
      skipFactors={skipFor(l.skipped.row, l.lane.provider)}
      assessments={l.assessments}
      assessment={l.assessment}
      approval={l.approval}
      plans={l.plans}
      plan={l.plan}
      replaying={p.replaying}
      fresh={p.fresh}
      reduced={p.reduced}
      projectId={p.projectId}
      demo={p.demo}
      onOpen={open}
      onApproved={p.data.competitors.reload}
    />
  ));

  const allExtras: Array<{ key: string; label: string; cls: string; el: ReactElement }> = [
    { key: "heatmap", label: "01 Prompts", cls: "xl:col-span-6 xl:min-h-[280px] xl:max-h-[420px]", el: <HeatmapPanel prompts={planned} lanes={laneLabels} cell={cell} reduced={p.reduced} fresh={p.fresh} onOpen={open} captions={[]} /> },
    {
      key: "latest-answer",
      label: "02 Latest answer",
      cls: "xl:col-span-6 xl:min-h-[280px] xl:max-h-[420px]",
      el: <LatestAnswerPanel answer={newestShown} detail={shownDetail} error={detail.error} reduced={p.reduced} ownHost={p.ownHost} />,
    },
    { key: "cited-instead", label: "03 Cited instead", cls: "xl:col-span-4 xl:max-h-[420px]", el: <CitedInsteadPanel bars={d.bars} reduced={p.reduced} /> },
    {
      key: "coverage",
      label: "04 Coverage",
      cls: "xl:col-span-8 xl:max-h-[420px]",
      el: (
        <CoveragePanel
          num="04"
          state={p.data.coverage}
          reduced={p.reduced}
          projectId={p.projectId}
          ownHost={p.ownHost}
          captions={projCaptions}
          askingPrompts={asking}
          answersByPrompt={answersByPrompt}
          planPages={planPages}
        />
      ),
    },
    {
      key: "recs",
      label: "05 Proposals",
      cls: "xl:col-span-12 xl:max-h-[360px]",
      el: (
        <RecsPanel
          num="05"
          title="Proposals drafted and checked"
          recs={d.recs}
          pipeline={midReplay ? null : (p.geo?.totals?.pipeline ?? null)}
          replaying={midReplay}
          fresh={p.fresh}
          reduced={p.reduced}
          projectId={p.projectId}
          finished={p.mode !== "live" && (!p.replaying || p.atEnd)}
        />
      ),
    },
    // Section 17: project-level containers, each fetching its own stored aggregate (lazily below the fold).
    { key: "engine-queries", label: "06 Engine searches", cls: "xl:col-span-6 xl:h-[420px]", el: <EngineQueriesContainer projectId={p.projectId} reduced={p.reduced} /> },
    { key: "brands", label: "07 Brands", cls: "xl:col-span-6 xl:h-[420px]", el: <BrandsContainer projectId={p.projectId} reduced={p.reduced} /> },
    { key: "cited-domains", label: "08 Cited domains", cls: "xl:col-span-6 xl:h-[420px]", el: <CitedDomainsContainer projectId={p.projectId} reduced={p.reduced} /> },
    { key: "prompt-history", label: "09 History", cls: "xl:col-span-6 xl:h-[420px]", el: <PromptHistoryContainer projectId={p.projectId} reduced={p.reduced} /> },
    { key: "sheet-prompts", label: "10 Sheet questions", cls: "xl:col-span-6 xl:h-[400px]", el: <SheetsContainer projectId={p.projectId} reduced={p.reduced} mode="geo" /> },
    { key: "budget", label: "11 Budget", cls: "xl:col-span-6 xl:h-[400px]", el: <BudgetContainer projectId={p.projectId} reduced={p.reduced} mode="geo" /> },
  ];
  const extras = allExtras.filter((x) => !more.hidden.has(x.key));
  const lazyDef = (key: string) => GEO_CONTAINERS.find((c) => c.key === key && c.more) ?? null;
  const showLanes = !more.hidden.has("lanes");

  const feedBanner =
    !p.geo && p.feedError ? (
      <StateBanner state="error" title="The live GEO feed could not be loaded" message="Engine columns and panels wait for it; the run rail shows the stored events it has." />
    ) : null;

  const drawer = <ObservationDrawer observationId={obs?.id ?? null} title={obs?.title ?? ""} onClose={() => setObs(null)} />;

  const noLanes =
    lanes.length === 0 ? (
      <EmptyState title="Connect an AI engine" action={<Link to={projectPath(p.projectId, "integrations")}>Open Integrations</Link>}>
        This run has no engine lane. Configure an API-sampled engine to ask your approved prompts.
      </EmptyState>
    ) : null;

  if (lanes.length === 0) {
    // The project containers (section 17) still show stored state without a lane in this run.
    const more17 = extras.filter((x) => lazyDef(x.key));
    return (
      <div className="min-w-0 space-y-4">
        {feedBanner}
        {noLanes}
        {more17.length > 0 && (
          <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
            {more17.map((x) => (
              <div key={x.key} className={cx("flex min-h-0 min-w-0 flex-col max-xl:max-h-[70vh] [&>section]:flex-1", x.cls)}>
                <LazyMount def={lazyDef(x.key)!} reduced={p.reduced}>
                  {x.el}
                </LazyMount>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (!wide) {
    const sel = laneInfo.find((l) => l.lane.provider === laneTab) ?? laneInfo[0]!;
    const idx = laneInfo.indexOf(sel);
    const extraSel = extras.find((x) => x.key === extraTab) ?? extras[0] ?? null;
    return (
      <div className="min-w-0 space-y-3">
        {feedBanner}
        {showLanes && (
        <>
        <div role="tablist" aria-label="Engines" className="lv-strip relative flex gap-1 overflow-x-auto pb-1" tabIndex={0}>
          {laneInfo.map((l) => (
            <button
              key={l.lane.provider}
              type="button"
              role="tab"
              aria-selected={l === sel}
              onClick={() => setLaneTab(l.lane.provider)}
              className={cx("inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium", l === sel ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300")}
            >
              <span className={cx("inline-flex rounded", l === sel && "bg-white dark:bg-zinc-900")}>
                <EngineBadge provider={l.lane.provider} label={l.bl?.label ?? l.lane.label} />
              </span>
              {engineName(l.lane.provider)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="min-w-0">
          {columns[idx]}
        </div>
        </>
        )}
        {extras.length > 0 && (
          <div role="tablist" aria-label="Panels" className="lv-strip relative flex gap-1 overflow-x-auto pb-1" tabIndex={0}>
            {extras.map((x) => (
              <button
                key={x.key}
                type="button"
                role="tab"
                aria-selected={extraSel?.key === x.key}
                onClick={() => setExtraTab(x.key)}
                className={cx("shrink-0 rounded-md px-2.5 py-1 text-xs font-medium", extraSel?.key === x.key ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300")}
              >
                {x.label}
              </button>
            ))}
          </div>
        )}
        {extraSel && (
          <div role="tabpanel" aria-label={extraSel.label} className="flex max-h-[70vh] min-w-0 flex-col [&>section]:flex-1">
            {extraSel.el}
          </div>
        )}
        {!showLanes && extras.length === 0 && <p className="py-6 text-center text-xs text-zinc-600 dark:text-zinc-400">Every container is hidden. Use “Containers” in the header to show them again.</p>}
        {drawer}
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {feedBanner}
      {!showLanes && extras.length === 0 && <p className="py-6 text-center text-xs text-zinc-600 dark:text-zinc-400">Every container is hidden. Use “Containers” in the header to show them again.</p>}
      {showLanes && <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(380px,1fr))] xl:gap-y-3">{columns}</div>}
      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-12">
        {extras.map((x) => {
          const def = lazyDef(x.key);
          return (
            <div key={x.key} className={cx("flex min-h-0 min-w-0 flex-col max-xl:max-h-[70vh] [&>section]:flex-1", x.cls)}>
              {def ? (
                <LazyMount def={def} reduced={p.reduced}>
                  {x.el}
                </LazyMount>
              ) : (
                x.el
              )}
            </div>
          );
        })}
      </div>
      {drawer}
    </div>
  );
});
