/**
 * Lane header (design §2): engine name, exact model, grounding, citation-rate gauge, stats. No brand logos.
 * A custom GEO engine lane shows the citation gauge and stats like any engine when its cohort has grounded
 * answers (provider-reported sources); without any, it shows its mention rate instead of a citation gauge and
 * no citation-based stats ("Citation rate: not measured (no sources returned)").
 */
import type { EngineLaneSummary, Ratio } from "@shared/types";
import { formatDateTime, formatNumber, formatRelative } from "@web/lib/format";
import { Badge, StateBadge } from "@web/components/ui";
import {
  CUSTOM_CITATION_NOT_MEASURED,
  CUSTOM_ENGINE_NOTE,
  GAUGE,
  LABELS,
  apiSampledTipFor,
  citedInsteadShare,
  customLaneHasSources,
  customSourcesLine,
  costDisplay,
  countsLine,
  engineGlyph,
  engineName,
  gaugeAriaLabel,
  gaugePaths,
  gaugeText,
  isCustomEngine,
  mentionStatText,
  searchQueriesLine,
} from "./lib";

export function CitationGauge({ rate }: { rate: Ratio }) {
  const g = gaugePaths(rate);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <svg
        role="img"
        aria-label={gaugeAriaLabel(rate)}
        viewBox={`0 0 ${GAUGE.width} ${GAUGE.height}`}
        className="h-12 w-20 shrink-0"
      >
        <path d={g.track} fill="none" strokeWidth={8} strokeLinecap="round" className="stroke-zinc-200 dark:stroke-zinc-700" />
        {g.value && <path d={g.value} fill="none" strokeWidth={8} strokeLinecap="round" className="stroke-sky-600 dark:stroke-sky-400" />}
      </svg>
      <div className="min-w-0">
        <p className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{gaugeText(rate)}</p>
        <p className="text-[11px] text-zinc-600 dark:text-zinc-400">Citation rate (valid answers citing your site)</p>
      </div>
    </div>
  );
}

function Stat({ label, value, title, sub }: { label: string; value: string; title?: string; sub?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="break-words text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</dd>
      {sub && <dd className="break-words text-[11px] text-zinc-600 dark:text-zinc-400">{sub}</dd>}
    </div>
  );
}

export function LaneHeader({ lane, showMetrics }: { lane: EngineLaneSummary; showMetrics: boolean }) {
  const cost = costDisplay(lane.costUsd);
  const name = engineName(lane.provider);
  const custom = isCustomEngine(lane.provider);
  // A custom lane without any grounded answer in its cohort: mention rate only.
  const mentionOnly = custom && !customLaneHasSources(lane);
  return (
    <header className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-start gap-2">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-300 text-sm font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
        >
          {engineGlyph(lane.provider)}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-sm font-semibold text-zinc-900 dark:text-zinc-100">{name}</h3>
          <p className="break-words text-xs text-zinc-600 dark:text-zinc-400">{lane.label}</p>
          <p className="mt-0.5 text-xs text-zinc-700 dark:text-zinc-300">
            <span className="break-all font-mono">{lane.model ?? "Model not set"}</span>
            {" · "}
            <span className="break-all">{lane.groundingMode ?? "Grounding not set"}</span>
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <StateBadge state={lane.state} />
        <Badge tone="info" title={apiSampledTipFor(lane.provider)}>
          {LABELS.apiSampled}
        </Badge>
        {custom && (
          <Badge
            tone="warning"
            className="whitespace-normal"
            title="No tool is requested. Answers count toward citation rate only when the provider returns web sources; answers without sources count toward mention rate only."
          >
            {CUSTOM_ENGINE_NOTE}
          </Badge>
        )}
        {lane.smallSampleWarning && (
          <Badge tone="warning" className="whitespace-normal">
            Small sample – do not read changes as trends
          </Badge>
        )}
        <span className="text-xs text-zinc-600 dark:text-zinc-400" title={lane.lastRunAt ? formatDateTime(lane.lastRunAt) : undefined}>
          {lane.lastRunAt ? `Last run ${formatRelative(lane.lastRunAt)}` : "Not run yet"}
        </span>
      </div>

      {showMetrics && mentionOnly && (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Stat label="Mention rate" value={mentionStatText(lane.mentionRate)} title="Valid answers that name your brand" />
            <Stat label="Answers skipping us" value={formatNumber(lane.answersSkippingUs)} title="Valid answers that do not name you" />
            <Stat label="Cost (latest cohort)" value={cost.value} sub={cost.basis} />
          </dl>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{CUSTOM_CITATION_NOT_MEASURED}</p>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{customSourcesLine(lane)}</p>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{countsLine(lane.counts)}</p>
          {lane.cohortKey && <p className="break-all text-[11px] text-zinc-500 dark:text-zinc-400">Cohort {lane.cohortKey}</p>}
        </>
      )}
      {showMetrics && !mentionOnly && (
        <>
          <CitationGauge rate={lane.citationRate} />
          {custom && <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{customSourcesLine(lane)}</p>}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Stat
              label="Answers citing us"
              value={formatNumber(lane.answersCitingUs)}
              sub={lane.mentionRate.denominator > 0 ? `Named in ${formatNumber(lane.mentionRate.numerator)} of ${formatNumber(lane.mentionRate.denominator)}` : undefined}
            />
            <Stat label="Answers skipping us" value={formatNumber(lane.answersSkippingUs)} title="Valid answers that neither name nor cite you" />
            <Stat label="Cited instead" value={lane.citedInstead ? lane.citedInstead.host : "—"} sub={lane.citedInstead ? citedInsteadShare(lane.citedInstead) : "No other source dominates"} />
            <Stat label="Cost (latest cohort)" value={cost.value} sub={cost.basis} />
          </dl>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
            {countsLine(lane.counts)} · {searchQueriesLine(lane.searchQueries)}
          </p>
          {lane.cohortKey && <p className="break-all text-[11px] text-zinc-500 dark:text-zinc-400">Cohort {lane.cohortKey}</p>}
        </>
      )}
    </header>
  );
}
