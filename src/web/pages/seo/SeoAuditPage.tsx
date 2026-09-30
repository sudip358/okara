/**
 * SEO audit. Route: /projects/:projectId/seo
 * Honest states: setup_required when the site is not verified; completeness + skipped reasons beside findings.
 */
import { Link, useParams } from "react-router";
import type { PageRow, SeoAudit, SeoOverview } from "@shared/types";
import { formatDateTime, formatNumber, formatRatio, formatWindow } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { projectPath, useProject } from "@web/lib/project-context";
import {
  Badge,
  Card,
  CompletenessNote,
  ErrorState,
  LoadingState,
  MetricTile,
  PageHeader,
  StateBadge,
  StateBanner,
  buttonClass,
} from "@web/components/ui";
import { FindingsPanel } from "./components/FindingsPanel";
import { AiCrawlerPanel } from "./components/AiCrawlerPanel";
import { PagesTable } from "./components/PagesTable";
import { CsvImportPanel } from "./components/CsvImportPanel";

export function SeoAuditPage() {
  const { projectId = "" } = useParams();
  const { project } = useProject();
  const base = `/projects/${encodeURIComponent(projectId)}`;
  const audit = useApi<SeoAudit>(projectId ? `${base}/seo/audit` : null);
  const pages = useApi<PageRow[]>(projectId ? `${base}/pages` : null);
  const overview = useApi<SeoOverview>(projectId ? `${base}/seo/overview` : null);

  const unverified = !project.verifiedAt;
  const a = audit.data;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="SEO audit"
        description="Deterministic checks on crawled pages from your verified site. Findings cover only the pages checked; they are not a ranking forecast."
        actions={a ? <StateBadge state={a.state} /> : undefined}
      />

      {unverified || a?.state === "setup_required" ? (
        <StateBanner
          state="setup_required"
          message={
            unverified
              ? "Verify ownership of your site (Search Console, DNS, or file) before Okara can crawl it. Until then no live audit findings are produced."
              : "The audit needs setup before it can run."
          }
          action={
            <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
              Go to integrations
            </Link>
          }
        />
      ) : null}
      {a?.state === "demo" && <StateBanner state="demo" message="Demo data – simulated crawl. Nothing here was fetched from a live site." />}

      <GscSourceCard overview={overview.data} loading={overview.loading} error={overview.error} reload={overview.reload} />

      {audit.loading && !a ? (
        <LoadingState label="Loading audit…" />
      ) : audit.error ? (
        <ErrorState error={audit.error} onRetry={audit.reload} />
      ) : a ? (
        <>
          <Card title="Crawl coverage">
            <div className="space-y-3">
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div className="flex gap-2">
                  <dt className="text-zinc-600 dark:text-zinc-400">Crawled</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">{a.crawledAt ? formatDateTime(a.crawledAt) : "Not yet crawled"}</dd>
                </div>
                {project.verifiedHost && (
                  <div className="flex gap-2">
                    <dt className="text-zinc-600 dark:text-zinc-400">Verified host</dt>
                    <dd className="break-all text-zinc-900 dark:text-zinc-100">{project.verifiedHost}</dd>
                  </div>
                )}
              </dl>
              <CompletenessNote completeness={a.completeness} />
              {a.skipped.length > 0 && (
                <details className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                  <summary className="cursor-pointer rounded font-medium text-zinc-800 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-zinc-200">
                    Skipped pages ({a.skipped.length})
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {a.skipped.map((s) => (
                      <li key={s.url} className="flex min-w-0 flex-wrap gap-x-2 text-xs">
                        <span className="break-all text-zinc-800 dark:text-zinc-200">{s.url}</span>
                        <Badge tone="warning">{s.reason}</Badge>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </Card>

          <FindingsPanel findings={a.findings} completeness={a.completeness} />
          <AiCrawlerPanel access={a.aiCrawlerAccess} />
        </>
      ) : null}

      {pages.loading && !pages.data ? (
        <LoadingState label="Loading pages…" />
      ) : pages.error ? (
        <ErrorState error={pages.error} onRetry={pages.reload} title="Pages unavailable" />
      ) : pages.data ? (
        <PagesTable
          projectId={projectId}
          pages={pages.data}
          onChanged={(row) => pages.setData((pages.data ?? []).map((p) => (p.id === row.id ? row : p)))}
        />
      ) : null}

      <CsvImportPanel projectId={projectId} onImported={overview.reload} />

      <Limitations items={[...(a?.limitations ?? []), ...(overview.data?.limitations ?? [])]} />
    </div>
  );
}

function sourceLabel(source: SeoOverview["source"]): string {
  if (source === "api") return "Search Console API";
  if (source === "csv_import") return "Imported CSV (not live API)";
  if (source === "demo") return "Demo data";
  return "No source";
}

function GscSourceCard({
  overview,
  loading,
  error,
  reload,
}: {
  overview: SeoOverview | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
}) {
  if (loading && !overview) return <LoadingState label="Loading Search Console data…" />;
  if (error) return <ErrorState error={error} onRetry={reload} title="Search Console data unavailable" />;
  if (!overview) return null;
  const cur = overview.totals.current;
  return (
    <Card
      title="Search Console data"
      description="First-party data used for content opportunities. Page/query slices are not an exhaustive property total."
      actions={
        <>
          <StateBadge state={overview.state} />
          <Badge tone={overview.source === "csv_import" ? "warning" : overview.source === "demo" ? "demo" : "neutral"}>{sourceLabel(overview.source)}</Badge>
        </>
      }
    >
      {overview.state === "setup_required" || !cur ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          No Search Console data yet. Connect Search Console on the integrations page, or import a CSV below.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricTile label="Clicks" value={formatNumber(cur.clicks)} window={formatWindow(overview.current)} />
            <MetricTile label="Impressions" value={formatNumber(cur.impressions)} window={formatWindow(overview.current)} />
            <MetricTile label="CTR (clicks / impressions)" value={formatRatio(cur.ctr, "impressions")} window={formatWindow(overview.current)} />
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
            <div>
              <dt className="inline">Property: </dt>
              <dd className="inline break-all">{overview.property ?? "—"}</dd>
            </div>
            <div>
              <dt className="inline">Synced: </dt>
              <dd className="inline">{formatDateTime(overview.syncedAt)}</dd>
            </div>
            {overview.truncated && (
              <div>
                <Badge tone="warning">Rows truncated at project cap</Badge>
              </div>
            )}
          </dl>
          <CompletenessNote completeness={overview.completeness} />
        </div>
      )}
    </Card>
  );
}

function Limitations({ items }: { items: string[] }) {
  const unique = Array.from(new Set(items.filter(Boolean)));
  if (unique.length === 0) return null;
  return (
    <Card title="Limitations">
      <ul className="list-inside list-disc space-y-1 text-sm text-zinc-700 dark:text-zinc-300">
        {unique.map((l) => (
          <li key={l} className="break-words">
            {l}
          </li>
        ))}
      </ul>
    </Card>
  );
}
