/** [A8] one lane per GEO provider. Every rate shows numerator/denominator; null → Unavailable. */
import type { GeoLane } from "@shared/types";
import { formatNumber, formatRatio, formatUsd } from "@web/lib/format";
import { Badge, StateBadge } from "@web/components/ui";
import { sourceTypeLabel } from "../lib";

function costLabel(cost: GeoLane["cost"], provider: string): { value: string; note: string } {
  if (cost.usd === null && provider.startsWith("custom_geo:")) return { value: "Unknown", note: "Custom provider: no verified price, so cost is recorded as unknown, not $0" };
  if (cost.usd === null) return { value: "Unknown", note: "Provider returned no usage/price data; not counted as $0" };
  return cost.isEstimate
    ? { value: formatUsd(cost.usd, true), note: "Estimate from versioned configured rates" }
    : { value: formatUsd(cost.usd, false), note: "Actual, as returned by the provider" };
}

export function EngineLane({ lane }: { lane: GeoLane }) {
  const cost = costLabel(lane.cost, lane.provider);
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold text-zinc-900 dark:text-zinc-100">{lane.label}</h3>
          <p className="mt-0.5 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{lane.model ?? "Model not recorded"}</p>
        </div>
        <StateBadge state={lane.state} />
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-zinc-600 dark:text-zinc-400">Grounding</dt>
        <dd className="break-words text-zinc-900 dark:text-zinc-100">{lane.groundingMode ?? "Not grounded"}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">Prompts run</dt>
        <dd className="tabular-nums text-zinc-900 dark:text-zinc-100">{formatNumber(lane.promptsRun)}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">Responses</dt>
        <dd className="text-zinc-900 dark:text-zinc-100">
          {formatNumber(lane.counts.valid)} valid · {formatNumber(lane.counts.grounded)} grounded · {formatNumber(lane.counts.failed)} failed ·{" "}
          {formatNumber(lane.counts.incomplete)} incomplete
        </dd>
      </dl>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Mention rate</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{formatRatio(lane.mentionRate, "valid responses")}</p>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Valid responses mentioning brand / valid responses</p>
        </div>
        <div className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Citation rate</p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{formatRatio(lane.citationRate, "grounded responses")}</p>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Grounded responses citing your domain / grounded responses</p>
        </div>
      </div>

      <dl className="space-y-1 text-xs">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-zinc-600 dark:text-zinc-400">Top cited instead</dt>
          <dd className="min-w-0 break-words text-zinc-900 dark:text-zinc-100">
            {lane.topCitedInstead
              ? `${lane.topCitedInstead.entity} via ${sourceTypeLabel(lane.topCitedInstead.sourceType)} (${lane.topCitedInstead.count}×)`
              : "None recorded"}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-zinc-600 dark:text-zinc-400">Search queries</dt>
          <dd className="text-zinc-900 dark:text-zinc-100">
            {lane.searchQueries.state === "captured" ? `${formatNumber(lane.searchQueries.count)} captured` : "Not exposed by provider"}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-zinc-600 dark:text-zinc-400">Cost so far</dt>
          <dd className="text-zinc-900 dark:text-zinc-100" title={cost.note}>
            {cost.value} <span className="text-zinc-500 dark:text-zinc-400">({cost.note})</span>
          </dd>
        </div>
      </dl>

      {lane.smallSampleWarning && (
        <Badge tone="warning" className="self-start whitespace-normal">
          Small sample – do not read changes as trends
        </Badge>
      )}
      {lane.cohortKey && <p className="break-all text-[11px] text-zinc-500 dark:text-zinc-400">Cohort {lane.cohortKey}</p>}
    </article>
  );
}
