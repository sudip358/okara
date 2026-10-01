/**
 * One engine lane of the board (design §1-§6): header, then A prompt feed, B our pages, C cited pages,
 * D rewrite plans. Desktop/tablet stack the sections; on mobile the lane is a collapsible <details> and
 * B-D are tabs. Setup / disabled / error / no-answer lanes keep the header and show an honest state only.
 * A custom GEO engine lane (no web search) shows only A plus a note: B-D come from the citation pipeline and
 * the per-engine skip-factor API, which never have data for an ungrounded lane.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { CompetitorPageAssessment, EngineLaneSummary, RewritePlan } from "@shared/types";
import { formatDateTime } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { EmptyState, ErrorState, LoadingState, StateBanner, Tabs, buttonClass } from "@web/components/ui";
import { LaneHeader } from "./LaneHeader";
import { PromptFeed } from "./PromptFeed";
import { SkipFactorsBody, skipSectionTitle, type SkipInputs } from "./SkipFactorsPanel";
import { CompetitorBody } from "./CompetitorPanel";
import { RewritePlansBody } from "./RewritePlansPanel";
import { CUSTOM_LANE_BODY_NOTE, assessmentsForEngine, engineName, engineVendor, isCustomEngine, laneBodyMode, plansForEngine } from "./lib";

export interface ListState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export interface EngineColumnProps {
  projectId: string;
  lane: EngineLaneSummary;
  compact: boolean;
  defaultOpen?: boolean;
  competitors: ListState<CompetitorPageAssessment[]>;
  plans: ListState<RewritePlan[]>;
  skipInputs: SkipInputs;
  onNeedSkipInputs: () => void;
  onOpenObservation?: (observationId: string, title: string) => void;
  onApproved: (a: CompetitorPageAssessment) => void;
}

function SectionHeading({ letter, children, inline }: { letter: string; children: ReactNode; inline?: boolean }) {
  return (
    <h4 className={inline ? "inline text-xs font-semibold text-zinc-900 dark:text-zinc-100" : "text-xs font-semibold text-zinc-900 dark:text-zinc-100"}>
      <span aria-hidden="true" className="mr-1 font-mono text-zinc-500 dark:text-zinc-400">
        {letter}
      </span>
      {children}
    </h4>
  );
}

function ListGate<T>({ state, label, children }: { state: ListState<T>; label: string; children: (data: T) => ReactNode }) {
  if (state.loading && state.data === null) return <LoadingState label={label} />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (state.data === null) return null;
  return <>{children(state.data)}</>;
}

/** Body for lanes that are not ready to show answers (design §2 "Lane empty / setup states"). */
export function LaneStateBody({ projectId, lane }: { projectId: string; lane: EngineLaneSummary }) {
  const mode = laneBodyMode(lane);
  if (mode === "setup")
    return (
      <EmptyState
        title={`Connect ${engineVendor(lane.provider)} to sample answers`}
        action={
          <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
            Go to integrations
          </Link>
        }
      >
        {lane.stateDetail ?? "An API key and a model are required."}
      </EmptyState>
    );
  if (mode === "disabled")
    return (
      <EmptyState
        title="Turned off for this project"
        action={
          <Link to={projectPath(projectId, "settings")} className={buttonClass("secondary", "sm")}>
            Settings
          </Link>
        }
      >
        {lane.stateDetail ?? undefined}
      </EmptyState>
    );
  if (mode === "error")
    return (
      <StateBanner
        state="error"
        message={
          <>
            <span className="block">{lane.stateDetail ?? "The last run failed."}</span>
            <span className="block text-xs">{lane.lastRunAt ? `Last successful run ${formatDateTime(lane.lastRunAt)}` : "No successful run yet"}</span>
          </>
        }
      />
    );
  return (
    <EmptyState title="No answers yet">
      Approve prompts, then run GEO.{" "}
      <Link to={projectPath(projectId, "geo/prompts")} className="underline">
        Review GEO prompts
      </Link>
    </EmptyState>
  );
}

export function EngineColumn(props: EngineColumnProps) {
  const { projectId, lane, compact, competitors, plans, skipInputs, onNeedSkipInputs, onOpenObservation, onApproved } = props;
  const mode = laneBodyMode(lane);
  const ready = mode === "ready";
  const name = engineName(lane.provider);
  const [skipOpen, setSkipOpen] = useState(false);

  const competitorBody = (showRadar: boolean) => (
    <ListGate state={competitors} label="Loading cited pages…">
      {(all) => <CompetitorBody projectId={projectId} lane={lane} all={all} assessments={assessmentsForEngine(all, lane.provider)} showRadar={showRadar} onApproved={onApproved} />}
    </ListGate>
  );
  const plansBody = (
    <ListGate state={plans} label="Loading rewrite plans…">
      {(list) => <RewritePlansBody plans={plansForEngine(list, lane.provider)} projectId={projectId} />}
    </ListGate>
  );
  const skipBody = <SkipFactorsBody projectId={projectId} lane={lane} inputs={skipInputs} onNeed={onNeedSkipInputs} />;

  const customBody = (
    <div className="min-w-0 space-y-3">
      <PromptFeed lane={lane} layout={compact ? "list" : "row"} onOpen={onOpenObservation} />
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{CUSTOM_LANE_BODY_NOTE}</p>
    </div>
  );

  const body = !ready ? (
    <LaneStateBody projectId={projectId} lane={lane} />
  ) : isCustomEngine(lane.provider) ? (
    customBody
  ) : compact ? (
    <div className="min-w-0 space-y-3">
      <Tabs
        label={`${name} sections`}
        tabs={[
          { id: "prompts", label: "Prompts", content: <PromptFeed lane={lane} layout="list" onOpen={onOpenObservation} /> },
          { id: "ours", label: "Our pages", content: skipBody },
          { id: "cited", label: "Cited pages", content: competitorBody(false) },
          { id: "plans", label: "Plans", content: plansBody },
        ]}
      />
    </div>
  ) : (
    <div className="min-w-0 space-y-4">
      <PromptFeed lane={lane} layout="row" onOpen={onOpenObservation} />
      <details className="group min-w-0" onToggle={(e) => setSkipOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="cursor-pointer">
          <SectionHeading letter="B" inline>
            {skipSectionTitle(lane)}
          </SectionHeading>
        </summary>
        <div className="mt-2">{skipOpen && skipBody}</div>
      </details>
      <section className="min-w-0 space-y-2" aria-label={`Pages ${name} cites instead`}>
        <SectionHeading letter="C">Pages {name} cites: what they do</SectionHeading>
        {competitorBody(true)}
      </section>
      <section className="min-w-0 space-y-2" aria-label={`Pages to rewrite for ${name}`}>
        <SectionHeading letter="D">Pages to rewrite for {name}</SectionHeading>
        {plansBody}
      </section>
    </div>
  );

  const inner = (
    <>
      <LaneHeader lane={lane} showMetrics={ready} />
      <div className="mt-4 min-w-0">{body}</div>
    </>
  );

  const shell = "min-w-0 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900";
  if (compact)
    return (
      <details className={shell} open={props.defaultOpen} aria-label={`${name} lane`}>
        <summary className="cursor-pointer text-sm font-semibold text-zinc-900 dark:text-zinc-100">{name}</summary>
        <div className="mt-3 min-w-0">{inner}</div>
      </details>
    );
  return (
    <article className={shell} aria-label={`${name} lane`}>
      {inner}
    </article>
  );
}
