/**
 * GEO results. Route: /projects/:projectId/geo/results
 * Mandatory disclosure labels, one lane per engine [A8], tracked-brand SOV, per-cohort trends,
 * prompt × provider matrix with a raw-answer drawer, and a separate manual-import form.
 */
import { useState } from "react";
import { Link, useParams } from "react-router";
import type { GeoResults } from "@shared/types";
import { useApi } from "@web/lib/hooks";
import { projectPath } from "@web/lib/project-context";
import { Card, EmptyState, ErrorState, LoadingState, PageHeader, StateBadge, StateBanner, buttonClass } from "@web/components/ui";
import { EngineLane } from "./components/EngineLane";
import { ShareOfVoiceTable } from "./components/ShareOfVoiceTable";
import { TrendChart } from "./components/TrendChart";
import { PromptMatrix } from "./components/PromptMatrix";
import { ObservationDrawer } from "./components/ObservationDrawer";
import { ManualImportForm } from "./components/ManualImportForm";

export function GeoResultsPage() {
  const { projectId = "" } = useParams();
  const { data, error, loading, reload } = useApi<GeoResults>(projectId ? `/projects/${encodeURIComponent(projectId)}/geo/results` : null);
  const [drawer, setDrawer] = useState<{ id: string; title: string } | null>(null);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="GEO results"
        description="How AI APIs answered your buyer prompts. Measured from real API responses only; nothing here is a prediction."
        actions={
          <>
            {data && <StateBadge state={data.state} />}
            {data?.promptSetVersion != null && <span className="text-xs text-zinc-600 dark:text-zinc-400">Prompt set v{data.promptSetVersion}</span>}
          </>
        }
      />

      {loading && !data ? (
        <LoadingState label="Loading GEO results…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data ? (
        <>
          <Disclosures labels={data.labels} />
          {data.state === "setup_required" && (
            <StateBanner
              state="setup_required"
              message="No GEO provider is configured. Add a Gemini or Perplexity API key, then approve prompts."
              action={
                <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
                  Go to integrations
                </Link>
              }
            />
          )}
          {data.state === "demo" && <StateBanner state="demo" message="Demo data – simulated run. No provider was called." />}

          <section aria-labelledby="lanes-h" className="space-y-2">
            <h2 id="lanes-h" className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Engine lanes
            </h2>
            {data.lanes.length === 0 ? (
              <EmptyState title="No engines have run yet.">
                <Link to={projectPath(projectId, "geo/prompts")} className="underline">
                  Review and approve prompts
                </Link>{" "}
                so the next scheduled batch can run.
              </EmptyState>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {data.lanes.map((l) => (
                  <EngineLane key={`${l.provider}-${l.cohortKey ?? ""}`} lane={l} />
                ))}
              </div>
            )}
          </section>

          <div className="grid min-w-0 gap-4 lg:grid-cols-3">
            <Card title="Tracked-brand share of voice" className="lg:col-span-1">
              <ShareOfVoiceTable rows={data.shareOfVoice} />
            </Card>
            <Card
              title="Trend by cohort"
              description="Compared only within the same prompt set, model, and configuration. A change starts a new cohort; lines never connect across cohorts."
              className="lg:col-span-2"
            >
              <TrendChart trend={data.trend} />
            </Card>
          </div>

          <Card title="Prompt × engine results" description="Select a cell to read the raw answer, citations, and search queries.">
            <PromptMatrix results={data} onOpen={(id, title) => setDrawer({ id, title })} />
          </Card>
        </>
      ) : null}

      <ManualImportForm projectId={projectId} onImported={reload} />

      <ObservationDrawer observationId={drawer?.id ?? null} title={drawer?.title ?? ""} onClose={() => setDrawer(null)} />
    </div>
  );
}

function Disclosures({ labels }: { labels: string[] }) {
  const items = labels.length > 0 ? labels : ["API-sampled visibility; not consumer-app answers, AI Overviews presence, or market share."];
  return (
    <div role="note" aria-label="Measurement disclosures" className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
      <ul className="space-y-0.5">
        {items.map((l, i) => (
          <li key={i} className={i === 0 ? "font-semibold" : undefined}>
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}
