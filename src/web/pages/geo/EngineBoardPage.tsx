/**
 * AI engines board. Route: /projects/:projectId/geo/board (docs/geo-board-design.md).
 * Layout follows the reference "Jev for SEO/GEO" board (engine columns; prompt feed; why we are skipped;
 * why they are cited; rewrite checklist), but every number is stored data: no simulated run, no projected
 * traffic/revenue, no citability score. Reads GET /geo/board, /geo/competitor-pages, /geo/rewrite-plans;
 * the only write is the confirmed single-page approval. No total "$ spent" ticker: cost lives in each lane
 * header (latest cohort). Polls every 8 s while the latest GEO run is pending/running.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { CompetitorPageAssessment } from "@shared/types";
import { formatDateTime, formatRelative } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { ErrorState, LoadingState, PageHeader, StateBadge, StateBanner, buttonClass } from "@web/components/ui";
import { RunNowButton } from "@web/components/RunNowButton";
import { usePolling } from "@web/lib/hooks";
import { ObservationDrawer } from "./components/ObservationDrawer";
import { useCompetitorPages, useEngineBoard, useGeoRuns, useMinWidth, useRewritePlans, useSkipInputs } from "./board/data";
import { EngineColumn } from "./board/EngineColumn";
import { RewritePlanCard } from "./board/RewritePlansPanel";
import { DEFAULT_DISCLOSURES, LABELS, firstOpenLane, formatDuration, laneGridClass, latestGeoRun, plansWithoutEngine, runDurationMs, runIsActive, runJustFinished } from "./board/lib";

export function EngineBoardPage() {
  const { projectId = "" } = useParams();
  const board = useEngineBoard(projectId);
  const runs = useGeoRuns(projectId);
  const competitors = useCompetitorPages(projectId);
  const plans = useRewritePlans(projectId);
  const [needSkip, setNeedSkip] = useState(false);
  const skip = useSkipInputs(projectId, needSkip);
  const onNeedSkip = useCallback(() => setNeedSkip(true), []);
  const [drawer, setDrawer] = useState<{ id: string; title: string } | null>(null);
  const wide = useMinWidth(768);

  const data = board.data;
  const onApproved = useCallback(
    (a: CompetitorPageAssessment) => {
      competitors.setData([a, ...(competitors.data ?? []).filter((x) => x.id !== a.id)]);
      competitors.reload();
    },
    [competitors],
  );

  const run = latestGeoRun(runs.data);
  // While the latest GEO run is pending/running, poll runs + board + plans (same cadence as Overview),
  // then reload board and plans once when it finishes so the lanes show the new cohort.
  const active = runIsActive(run);
  usePolling(
    () => {
      runs.reload();
      board.reload();
      plans.reload();
    },
    active,
    8000,
  );
  const wasActive = useRef(false);
  const runStatus = run?.status;
  useEffect(() => {
    if (runJustFinished(wasActive.current, run)) {
      board.reload();
      plans.reload();
    }
    wasActive.current = active;
    // Fires on run status transitions only (reload functions are not stable deps).
  }, [run?.id, runStatus, active]);
  const openLane = data ? firstOpenLane(data.lanes) : null;
  const unassignedPlans = plans.data ? plansWithoutEngine(plans.data.plans) : [];

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="AI engines"
        description="How API-sampled AI answers treat your prompts, and what the cited pages do differently."
        actions={
          <>
            {data && <StateBadge state={data.state} />}
            {data?.promptSetVersion != null && <span className="text-xs text-zinc-600 dark:text-zinc-400">Prompt set v{data.promptSetVersion}</span>}
            {data && (
              <span className="text-xs text-zinc-600 dark:text-zinc-400" title={formatDateTime(data.generatedAt)}>
                Updated {formatRelative(data.generatedAt)}
              </span>
            )}
            <RunNowButton projectId={projectId} agent="geo" onStarted={() => runs.reload()} />
            <Link to={projectPath(projectId, "usage")} className="text-xs">
              Usage
            </Link>
          </>
        }
      />

      {board.loading && !data ? (
        <LoadingState label="Loading AI engines…" />
      ) : board.error && !data ? (
        <ErrorState error={board.error} onRetry={board.reload} />
      ) : data ? (
        <>
          <div role="note" aria-label="Measurement disclosures" className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
            <ul className="flex flex-wrap gap-x-4 gap-y-0.5">
              {(data.labels.length > 0 ? data.labels : DEFAULT_DISCLOSURES).map((l, i) => (
                <li key={i} className="min-w-0 break-words">
                  {l}
                </li>
              ))}
            </ul>
          </div>

          <dl aria-label="Last GEO run" className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex gap-1">
              <dt className="text-zinc-600 dark:text-zinc-400">Last GEO run</dt>
              <dd className="text-zinc-900 dark:text-zinc-100">
                {runs.loading && !runs.data ? "Loading…" : run ? (
                  <Link to={projectPath(projectId, `runs/${encodeURIComponent(run.id)}`)}>
                    {formatDateTime(run.finishedAt ?? run.startedAt ?? run.createdAt)} ({run.status})
                  </Link>
                ) : (
                  "None yet"
                )}
              </dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-zinc-600 dark:text-zinc-400">Duration</dt>
              <dd className="tabular-nums text-zinc-900 dark:text-zinc-100">{formatDuration(runDurationMs(run))}</dd>
            </div>
          </dl>

          {data.state === "setup_required" && (
            <StateBanner
              state="setup_required"
              message="No AI engine is configured. Add an engine API key and model, then approve prompts."
              action={
                <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
                  Go to integrations
                </Link>
              }
            />
          )}

          <div className={laneGridClass(data.lanes.length)}>
            {data.lanes.map((lane) => (
              <EngineColumn
                key={lane.provider}
                projectId={projectId}
                lane={lane}
                compact={!wide}
                defaultOpen={lane.provider === openLane}
                competitors={competitors}
                plans={{ ...plans, data: plans.data?.plans ?? null }}
                skipInputs={skip}
                onNeedSkipInputs={onNeedSkip}
                onOpenObservation={(id, title) => setDrawer({ id, title })}
                onApproved={onApproved}
              />
            ))}
          </div>

          {unassignedPlans.length > 0 && (
            <section aria-labelledby="plans-all-h" className="space-y-2">
              <h2 id="plans-all-h" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Pages to rewrite (not tied to one engine)
              </h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">{LABELS.manualPlan}</p>
              <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {unassignedPlans.map((p) => (
                  <RewritePlanCard key={`${p.pageId}:${p.promptId ?? ""}`} plan={p} projectId={projectId} />
                ))}
              </div>
            </section>
          )}

          <p className="text-xs text-zinc-600 dark:text-zinc-400">{LABELS.footer}</p>
        </>
      ) : null}

      <ObservationDrawer observationId={drawer?.id ?? null} title={drawer?.title ?? ""} onClose={() => setDrawer(null)} />
    </div>
  );
}
