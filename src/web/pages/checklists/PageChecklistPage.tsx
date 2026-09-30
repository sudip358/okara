/**
 * [A21] On-page checklist for one crawled URL. Route: /projects/:projectId/pages/:pageId/checklist
 * Linked from the SEO audit's crawled pages table.
 */
import { Link, useParams } from "react-router";
import type { Checklist } from "@shared/types";
import { formatDateTime } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { projectPath } from "@web/lib/project-context";
import { Badge, ErrorState, LoadingState, PageHeader, StateBadge, StateBanner, buttonClass } from "@web/components/ui";
import { ChecklistView, Disclaimer, SourcesLine, withItem } from "./components/ChecklistView";

export function PageChecklistPage() {
  const { projectId = "", pageId = "" } = useParams();
  const base = `/projects/${encodeURIComponent(projectId)}/pages/${encodeURIComponent(pageId)}/checklist`;
  const { data, error, loading, reload, setData } = useApi<Checklist>(projectId && pageId ? base : null);
  const back = (
    <Link to={projectPath(projectId, "seo")} className={buttonClass("secondary", "sm")}>
      Back to SEO audit
    </Link>
  );

  if (loading && !data) return <LoadingState label="Loading page checklist…" />;
  if (error && !data) {
    return (
      <div className="space-y-4">
        <PageHeader title="On-page checklist" actions={back} />
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  }
  if (!data) return null;
  const p = data.page;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="On-page checklist"
        description="Sixteen on-page practices for one URL, measured from its latest snapshot, its Search Console queries, and Jev intent judgments where available."
        actions={back}
      />
      {p && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex min-w-0 gap-2">
            <dt className="text-zinc-600 dark:text-zinc-400">URL</dt>
            <dd className="min-w-0 break-all text-zinc-900 dark:text-zinc-100">{p.url}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-zinc-600 dark:text-zinc-400">Page type</dt>
            <dd>
              <Badge>{p.pageType}</Badge>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-zinc-600 dark:text-zinc-400">Snapshot</dt>
            <dd className="text-zinc-900 dark:text-zinc-100">{p.snapshotAt ? formatDateTime(p.snapshotAt) : "Not crawled yet"}</dd>
          </div>
          <div className="flex min-w-0 gap-2">
            <dt className="text-zinc-600 dark:text-zinc-400">Top GSC query</dt>
            <dd className="min-w-0 break-words text-zinc-900 dark:text-zinc-100">{p.topQuery ?? "None in the latest sync"}</dd>
          </div>
        </dl>
      )}
      <Disclaimer text={data.disclaimer} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SourcesLine checklist={data} />
        <StateBadge state={data.state} />
      </div>
      {data.state === "setup_required" && <StateBanner state="setup_required" message="This page has no crawl snapshot yet; run an SEO crawl of the verified site to measure it." />}
      {data.state === "demo" && <StateBanner state="demo" message="Demo data – simulated run. Statuses are computed from fictional fixtures." />}
      <ChecklistView
        checklist={data}
        projectId={projectId}
        putPath={(itemId) => `${base}/${encodeURIComponent(itemId)}`}
        onItemSaved={(item) => setData(withItem(data, item))}
      />
    </div>
  );
}
