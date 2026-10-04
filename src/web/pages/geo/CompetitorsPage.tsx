/**
 * Competitor comparisons. Route: /projects/:projectId/competitors
 * "Cited instead" leaderboard [A1], engine search queries [A6], tracked-brand share of voice, and DataForSEO
 * search data per competitor domain (third-party estimates; CompetitorDataPanel.tsx).
 */
import { Link, useParams } from "react-router";
import type { DisplacementSummary, GeoResults, SearchQuerySummary } from "@shared/types";
import { formatNumber } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { projectPath, useProject } from "@web/lib/project-context";
import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHeader, TBody, TD, TH, THead, TR, Table, type BadgeTone } from "@web/components/ui";
import { ExternalUrl } from "@web/components/ExternalUrl";
import { ShareOfVoiceTable } from "./components/ShareOfVoiceTable";
import { CompetitorDataSection } from "./CompetitorDataPanel";
import { SheetCompetitorMetrics } from "@web/pages/import/ImportedPanels";
import { sourceTypeLabel } from "./lib";
import { MAX_COMPETITORS } from "@shared/competitors";

const GSC_MATCH: Record<SearchQuerySummary["gscMatch"], { label: string; tone: BadgeTone; hint: string }> = {
  ranking: { label: "Already ranking", tone: "success", hint: "Reinforce the existing page" },
  impressions_weak_position: { label: "Impressions, weak position", tone: "info", hint: "Candidate to improve" },
  no_matching_page: { label: "No matching page – Needs human review", tone: "warning", hint: "Possible content opportunity; review before acting" },
  unknown: { label: "Unknown", tone: "neutral", hint: "No Search Console data to match against" },
};

export function CompetitorsPage() {
  const { projectId = "" } = useParams();
  const { project } = useProject();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const displacements = useApi<DisplacementSummary[]>(projectId ? `${base}/geo/displacements` : null);
  const queries = useApi<SearchQuerySummary[]>(projectId ? `${base}/geo/search-queries` : null);
  const results = useApi<GeoResults>(projectId ? `${base}/geo/results` : null);

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Competitors"
        description="Who AI APIs cite or recommend in your place, from API-sampled answers to your prompts, plus DataForSEO search estimates per competitor domain when connected. Okara does not crawl competitor sites."
      />

      <Card
        title={`Tracked competitors (${project.competitors.length} of ${MAX_COMPETITORS})`}
        description="From project settings or your sheet import. Aliases and domains are used for deterministic mention and citation detection."
        actions={
          <Link to={projectPath(projectId, "settings")} className="rounded text-xs text-sky-700 underline focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-sky-400">
            Edit
          </Link>
        }
      >
        {project.competitors.length === 0 ? (
          <EmptyState title="No competitors configured.">
            Add up to {MAX_COMPETITORS} competitors in project settings, or import your sheet's competitor tab on the Import page, to track share of voice.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {project.competitors.map((c) => (
              <li key={c.name} className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                <p className="break-words font-medium text-zinc-900 dark:text-zinc-100">{c.name}</p>
                <p className="mt-0.5 break-all text-xs text-zinc-600 dark:text-zinc-400">{c.domains.length ? c.domains.join(", ") : "No domains"}</p>
                {c.aliases.length > 0 && <p className="mt-0.5 break-words text-xs text-zinc-500 dark:text-zinc-400">Aliases: {c.aliases.join(", ")}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CompetitorDataSection projectId={projectId} />
      <SheetCompetitorMetrics projectId={projectId} />

      <Card
        title="Cited instead"
        description="Entities and pages AI answers recommended or cited where your brand was absent, aggregated across the current cohort."
      >
        <p className="mb-3 text-xs text-zinc-600 dark:text-zinc-400">Links are for manual review; Okara does not crawl them.</p>
        {displacements.loading && !displacements.data ? (
          <LoadingState />
        ) : displacements.error ? (
          <ErrorState error={displacements.error} onRetry={displacements.reload} />
        ) : !displacements.data || displacements.data.length === 0 ? (
          <EmptyState title="No displacements recorded." />
        ) : (
          <Table caption="Cited instead leaderboard">
            <THead>
              <TR>
                <TH>Entity</TH>
                <TH>Source type</TH>
                <TH>URL</TH>
                <TH className="text-right">Times</TH>
                <TH>Prompts</TH>
              </TR>
            </THead>
            <TBody>
              {displacements.data
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((d, i) => (
                  <TR key={`${d.entity}-${d.url ?? ""}-${i}`}>
                    <TD className="break-words font-medium">{d.entity}</TD>
                    <TD className="whitespace-nowrap">
                      <Badge>{sourceTypeLabel(d.sourceType)}</Badge>
                    </TD>
                    <TD className="min-w-48 max-w-xs">
                      {d.url ? (
                        <ExternalUrl url={d.url}>
                          <span className="sr-only"> (opens in new tab)</span>
                        </ExternalUrl>
                      ) : (
                        <span className="text-xs text-zinc-500">No URL</span>
                      )}
                    </TD>
                    <TD className="text-right tabular-nums">{formatNumber(d.count)}</TD>
                    <TD className="min-w-56">
                      <ul className="space-y-0.5 text-xs text-zinc-700 dark:text-zinc-300">
                        {d.prompts.slice(0, 3).map((p, j) => (
                          <li key={j} className="break-words">
                            {p}
                          </li>
                        ))}
                        {d.prompts.length > 3 && <li className="text-zinc-500">+{d.prompts.length - 3} more</li>}
                      </ul>
                    </TD>
                  </TR>
                ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Card
        title="Engine search queries"
        description="Web searches the providers reported issuing while answering your prompts. Only queries a provider actually exposes are shown; none are inferred."
      >
        {queries.loading && !queries.data ? (
          <LoadingState />
        ) : queries.error ? (
          <ErrorState error={queries.error} onRetry={queries.reload} />
        ) : !queries.data || queries.data.length === 0 ? (
          <EmptyState title="No search queries captured.">Some providers do not expose the searches they run.</EmptyState>
        ) : (
          <Table caption="Engine search queries">
            <THead>
              <TR>
                <TH>Query (normalized)</TH>
                <TH className="text-right">Count</TH>
                <TH>Providers</TH>
                <TH>Search Console match</TH>
                <TH className="text-right">Impressions</TH>
                <TH className="text-right">Avg. position</TH>
              </TR>
            </THead>
            <TBody>
              {queries.data
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((q) => {
                  const m = GSC_MATCH[q.gscMatch];
                  return (
                    <TR key={q.normalized}>
                      <TD className="min-w-48 break-words">{q.normalized}</TD>
                      <TD className="text-right tabular-nums">{formatNumber(q.count)}</TD>
                      <TD className="text-xs">{q.providers.join(", ")}</TD>
                      <TD>
                        <Badge tone={m.tone} title={m.hint} className="whitespace-normal">
                          {m.label}
                        </Badge>
                      </TD>
                      <TD className="text-right tabular-nums">{q.gscImpressions === null ? "—" : formatNumber(q.gscImpressions)}</TD>
                      <TD className="text-right tabular-nums">{q.gscPosition === null ? "—" : q.gscPosition.toFixed(1)}</TD>
                    </TR>
                  );
                })}
            </TBody>
          </Table>
        )}
      </Card>

      <Card title="Share of voice by tracked brand">
        {results.loading && !results.data ? (
          <LoadingState />
        ) : results.error ? (
          <ErrorState error={results.error} onRetry={results.reload} />
        ) : results.data ? (
          <ShareOfVoiceTable rows={results.data.shareOfVoice} />
        ) : null}
      </Card>
    </div>
  );
}
