/**
 * 09 Recommendations drafted and checked (SEO) / 05 Proposals drafted and checked (GEO). The pipeline bar is
 * the run's whole-run stored counts (shown live and at the end of a replay; mid-replay the stations show "—",
 * since whole-run totals would reveal what the replay has not reached); "Awaiting approval" and "Implemented"
 * are the recommendations' CURRENT status. Cards are this run's recommendation rows (newest first). Priority
 * is code-computed with its formula version. Publishing is never offered.
 */
import { Link } from "react-router";
import type { LivePipelineTotals, LiveRecommendationRow } from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx, TierBadge } from "@web/components/ui";
import { reasonLabel } from "@web/components/DecisionLog";
import { AnimatedNumber, staggerStyle } from "./motion";
import { Panel, PanelEmpty, ToneChip, type Accent } from "./parts";
import { clipText, fmtInt } from "./text";

export const PIPELINE_LABELS = ["Candidates", "Judged by Jev", "Drafted", "Awaiting approval", "Implemented"] as const;

export function pipelineStations(p: LivePipelineTotals): Array<{ label: string; value: number }> {
  return [
    { label: "Candidates", value: p.candidates },
    { label: "Judged by Jev", value: p.judged },
    { label: "Drafted", value: p.created },
    { label: "Awaiting approval", value: p.byStage.awaiting_approval ?? 0 },
    { label: "Implemented", value: p.byStatus.implemented ?? 0 },
  ];
}

const ISSUE = (s: string) => s.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

export function RecsPanel({
  num,
  title,
  accent = "zinc",
  recs,
  pipeline,
  replaying = false,
  fresh,
  reduced,
  projectId,
  finished,
  className,
}: {
  num: string;
  title: string;
  accent?: Accent;
  /** Revealed rows, ascending. */
  recs: LiveRecommendationRow[];
  pipeline: LivePipelineTotals | null;
  /** Mid-replay: whole-run totals are withheld until the replay reaches the end of the run. */
  replaying?: boolean;
  fresh: ReadonlySet<string>;
  reduced: boolean;
  projectId: string;
  finished: boolean;
  className?: string;
}) {
  const cards = recs.slice().reverse().slice(0, 60);
  const rejected = pipeline ? Object.entries(pipeline.rejectedByReason).filter(([, n]) => n > 0) : [];
  return (
    <Panel
      num={num}
      title={title}
      accent={accent}
      reduced={reduced}
      testId="recs"
      className={className}
      counter={{ value: recs.length, suffix: "drafted", sub: "in this run · nothing is published" }}
      subtitle="Writers draft only from stored evidence; priority is computed by code. Approval and publishing stay manual."
    >
      {!pipeline && replaying && (
        <div className="mb-2">
          <p className="mb-1 text-[11px] text-zinc-600 dark:text-zinc-400">Pipeline totals appear at the end of the replay.</p>
          <ol className="grid grid-cols-2 gap-1 sm:grid-cols-5" aria-label="Pipeline, whole run: shown at the end of the replay">
            {PIPELINE_LABELS.map((label, i) => (
              <li key={label} className="relative min-w-0 rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">
                <p className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">
                  <span aria-hidden="true" className="mr-1 font-mono">
                    {i + 1}
                  </span>
                  {label}
                </p>
                <span className="font-mono text-lg font-bold text-zinc-400 dark:text-zinc-500">—</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {pipeline && (
        <div className="mb-2">
          <p className="mb-1 text-[11px] text-zinc-600 dark:text-zinc-400">Whole run · approval and implemented are current status</p>
          <ol className="grid grid-cols-2 gap-1 sm:grid-cols-5" aria-label="Pipeline, whole run (stored counts; approval and implemented are current status)">
            {pipelineStations(pipeline).map((s, i) => (
              <li key={s.label} className="relative min-w-0 rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">
                <p className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">
                  <span aria-hidden="true" className="mr-1 font-mono">
                    {i + 1}
                  </span>
                  {s.label}
                </p>
                <AnimatedNumber value={s.value} reduced={reduced} className="font-mono text-lg font-bold text-zinc-900 dark:text-zinc-100" />
              </li>
            ))}
          </ol>
          {rejected.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-1">
              <span className="text-[11px] text-zinc-600 dark:text-zinc-400">Rejected:</span>
              {rejected.map(([code, n]) => (
                <ToneChip key={code} tone="none">
                  {fmtInt(n)} {reasonLabel(code).toLowerCase()}
                </ToneChip>
              ))}
            </p>
          )}
        </div>
      )}
      {cards.length === 0 ? (
        <PanelEmpty>{finished ? "This run drafted no recommendation." : "No recommendation drafted in this run yet."}</PanelEmpty>
      ) : (
        <ol className="grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-2" aria-label="Recommendations of this run, newest first">
          {cards.map((r) => (
            <li key={r.id} className={cx("min-w-0 rounded-lg border border-zinc-200 p-2.5 text-xs dark:border-zinc-800", fresh.has(r.id) && "lv-row-in")} style={staggerStyle(fresh, r.id)}>
              <p className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate font-mono font-semibold text-zinc-900 dark:text-zinc-100" title={r.targetLabel}>
                  {r.targetLabel}
                </span>
                <TierBadge tier={r.tier} />
              </p>
              <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{ISSUE(r.issueType)}</p>
              <p className="mt-1 line-clamp-2 text-zinc-800 dark:text-zinc-200">{clipText(r.action, 200)}</p>
              {r.suggestedSnippet && (
                <p className="mt-1 line-clamp-2 rounded bg-zinc-50 px-1.5 py-1 font-mono text-[11px] text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">{clipText(r.suggestedSnippet, 200)}</p>
              )}
              <p className="mt-1.5 flex flex-wrap items-center gap-1">
                <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300" title="Computed by code, not by Jev">
                  Priority {r.priority.toFixed(2)} ({r.priorityVersion})
                </span>
                <ToneChip tone="none">Effort {r.effort}</ToneChip>
                <ToneChip tone="none">Uncertainty {r.uncertainty}</ToneChip>
              </p>
              <p className="mt-1 flex flex-wrap items-center justify-between gap-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                <span>
                  {fmtInt(r.evidenceCount)} evidence item{r.evidenceCount === 1 ? "" : "s"}
                  {r.writer.model ? ` · writer ${clipText(r.writer.model, 40)}` : ""}
                </span>
                <Link to={projectPath(projectId, `recommendations/${encodeURIComponent(r.recommendationId)}`)}>Open</Link>
              </p>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
