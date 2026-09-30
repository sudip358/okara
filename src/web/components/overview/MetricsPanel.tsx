/**
 * [A12] region 3: metrics panel with SEO and GEO tabs. SEO = GSC impressions → clicks → CTR with exact
 * windows, sync time, and source; GEO = one lane per engine [A8]. No projections [A11].
 * OWNED BY: web-shell.
 */
import { Link } from "react-router";
import type { GeoLane, GeoResults, SeoOverview, SourceType } from "@shared/types";
import { useApi } from "@web/lib/hooks";
import { formatDateTime, formatNumber, formatPercent, formatRatio, formatUsd, formatWindow, humanize } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { LineChart } from "../LineChart";
import { DemandCurveChart } from "../DemandCurveChart";
import { Badge, CompletenessNote, ErrorState, LoadingState, MetricTile, StateBadge, StateBanner, Tabs, buttonClass } from "../ui";

export function MetricsPanel({ projectId }: { projectId: string }) {
  return (
    <section aria-labelledby="metrics-heading" className="min-w-0 rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 id="metrics-heading" className="px-4 pt-3 text-sm font-semibold">
        Metrics
      </h2>
      <div className="px-4 pb-4">
        <Tabs
          label="Metrics"
          tabs={[
            { id: "seo", label: "SEO", content: <SeoMetrics projectId={projectId} /> },
            { id: "geo", label: "GEO", content: <GeoSummary projectId={projectId} /> },
          ]}
        />
      </div>
    </section>
  );
}

const SEO_SOURCE: Record<NonNullable<SeoOverview["source"]>, string> = {
  api: "Google Search Console API",
  csv_import: "GSC CSV import (user-uploaded)",
  demo: "Demo fixture",
};

function delta(cur: number, prev: number | undefined): string {
  if (prev === undefined) return "No previous window";
  const diff = cur - prev;
  const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
  const pct = prev === 0 ? "" : ` (${sign}${Math.abs((diff / prev) * 100).toFixed(1)}%)`;
  return `Previous: ${formatNumber(prev)} · ${sign}${formatNumber(Math.abs(diff))}${pct}`;
}

function SeoMetrics({ projectId }: { projectId: string }) {
  const { data, error, loading, reload } = useApi<SeoOverview>(`/projects/${encodeURIComponent(projectId)}/seo/overview`);
  if (loading && !data) return <LoadingState label="Loading Search Console metrics…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  if (data.state === "setup_required" || data.state === "disabled" || data.state === "error") {
    return (
      <StateBanner
        state={data.state === "setup_required" ? "not_connected" : data.state}
        title={data.state === "setup_required" ? "Search Console not connected" : undefined}
        message="Connect Google Search Console (or import a GSC CSV export) to see impressions, clicks, and CTR."
        action={
          <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
            Integrations
          </Link>
        }
      />
    );
  }

  const cur = data.totals.current;
  const prev = data.totals.previous ?? undefined;
  const source = data.source ? SEO_SOURCE[data.source] : "Unknown source";
  const curWindow = formatWindow(data.current);
  const freshness = `Synced ${formatDateTime(data.syncedAt)}`;

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Source: {source}
        {data.property && <> · Property: <span className="font-mono">{data.property}</span></>} · {freshness}
        <br />
        Current: {curWindow} · Previous: {formatWindow(data.previous)}
      </p>
      {data.truncated && (
        <StateBanner state="partial" message="GSC rows were truncated at the project row cap; page/query slices are not exhaustive. Totals use property aggregates." />
      )}
      {!cur ? (
        <StateBanner state="no_data" message="Search Console returned no rows for the latest finalized window." />
      ) : (
        <>
          <ol className="grid gap-2 sm:grid-cols-3" aria-label="Search funnel, current window">
            <li>
              <MetricTile label="Impressions" value={formatNumber(cur.impressions)} sublabel={delta(cur.impressions, prev?.impressions)} window={curWindow} source="GSC" />
            </li>
            <li>
              <MetricTile label="→ Clicks" value={formatNumber(cur.clicks)} sublabel={delta(cur.clicks, prev?.clicks)} window={curWindow} source="GSC" />
            </li>
            <li>
              <MetricTile
                label="→ CTR (clicks / impressions)"
                value={cur.ctr.value === null ? "Unavailable" : formatPercent(cur.ctr.value, 2)}
                sublabel={`${formatRatio(cur.ctr, "impressions", 2)}${prev ? ` · Previous: ${formatRatio(prev.ctr, "impressions", 2)}` : ""}`}
                window={curWindow}
              />
            </li>
          </ol>
          <div className="grid gap-2 sm:grid-cols-3">
            <MetricTile
              label="Average position"
              value={cur.position === null ? "Unavailable" : cur.position.toFixed(1)}
              sublabel={prev?.position != null ? `Previous: ${prev.position.toFixed(1)} (GSC aggregate)` : "GSC property aggregate"}
            />
            <MetricTile label="Visits" value="Not connected" sublabel="No analytics source in this version" state="not_connected" />
            <MetricTile label="Revenue" value="Not connected" sublabel="No analytics source in this version" state="not_connected" />
          </div>
        </>
      )}
      {data.daily.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <LineChart title="Daily clicks" unit="clicks" points={data.daily.map((d) => ({ date: d.date, value: d.clicks }))} annotations={data.annotations} />
          <LineChart
            title="Daily impressions"
            unit="impressions"
            points={data.daily.map((d) => ({ date: d.date, value: d.impressions }))}
            annotations={data.annotations}
          />
        </div>
      )}
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Finalized days only; incomplete recent days are excluded. Dashed lines mark configuration changes.
      </p>
      {data.demandCurve && <DemandCurveChart curve={data.demandCurve} />}
      <CompletenessNote completeness={data.completeness} />
      {data.limitations.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-600 dark:text-zinc-400">
          {data.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  brand_page: "brand page",
  listicle_roundup: "listicle / roundup",
  review_site: "review site",
  forum_ugc: "forum / UGC",
  publisher: "publisher",
  marketplace: "marketplace",
  other: "other / unknown",
};

function GeoSummary({ projectId }: { projectId: string }) {
  const { data, error, loading, reload } = useApi<GeoResults>(`/projects/${encodeURIComponent(projectId)}/geo/results`);
  if (loading && !data) return <LoadingState label="Loading GEO results…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const fullLink = (
    <Link to={projectPath(projectId, "geo/results")} className={buttonClass("secondary", "sm")}>
      Full GEO results
    </Link>
  );

  return (
    <div className="space-y-3">
      {data.labels.length > 0 && (
        <ul className="space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
          {data.labels.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {data.state === "setup_required" && (
        <StateBanner
          state="setup_required"
          message="Add a GEO provider key and approve prompts to start API-sampled visibility tracking."
          action={
            <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
              Integrations
            </Link>
          }
        />
      )}
      {data.lanes.length === 0 ? (
        data.state !== "setup_required" && <StateBanner state="no_data" message="No GEO batch has run yet." />
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {data.lanes.map((lane) => (
            <li key={`${lane.provider}-${lane.cohortKey ?? ""}`}>
              <LaneCard lane={lane} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-zinc-600 dark:text-zinc-400">{data.promptSetVersion !== null ? `Prompt set v${data.promptSetVersion}` : "No active prompt set"}</p>
        {fullLink}
      </div>
    </div>
  );
}

function LaneCard({ lane }: { lane: GeoLane }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{lane.label}</p>
          <p className="break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{lane.model ?? "model not recorded"}</p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">Grounding: {lane.groundingMode ? humanize(lane.groundingMode) : "not grounded"}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          {lane.state !== "ready" && <StateBadge state={lane.state} />}
          {lane.smallSampleWarning && <Badge tone="warning">Small sample</Badge>}
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-zinc-600 dark:text-zinc-400">Mention rate</dt>
          <dd className="font-medium tabular-nums">{formatRatio(lane.mentionRate, "valid responses")}</dd>
        </div>
        <div>
          <dt className="text-zinc-600 dark:text-zinc-400">Citation rate</dt>
          <dd className="font-medium tabular-nums">{formatRatio(lane.citationRate, "grounded responses")}</dd>
        </div>
        <div>
          <dt className="text-zinc-600 dark:text-zinc-400">Prompts run / responses</dt>
          <dd className="tabular-nums">
            {lane.promptsRun} · {lane.counts.valid} valid, {lane.counts.grounded} grounded, {lane.counts.failed} failed, {lane.counts.incomplete} incomplete
          </dd>
        </div>
        <div>
          <dt className="text-zinc-600 dark:text-zinc-400">Top cited instead</dt>
          <dd className="break-words">
            {lane.topCitedInstead
              ? `${lane.topCitedInstead.entity} via ${SOURCE_TYPE_LABEL[lane.topCitedInstead.sourceType]} (${lane.topCitedInstead.count}×)`
              : "None recorded"}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-600 dark:text-zinc-400">Engine search queries</dt>
          <dd>{lane.searchQueries.state === "captured" ? `${lane.searchQueries.count} captured` : "Not exposed by provider"}</dd>
        </div>
        <div>
          <dt className="text-zinc-600 dark:text-zinc-400">Cost so far</dt>
          <dd className="tabular-nums">{formatUsd(lane.cost.usd, lane.cost.isEstimate)}</dd>
        </div>
      </dl>
    </div>
  );
}
