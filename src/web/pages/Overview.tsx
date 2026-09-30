/** [A12] Overview: run log strip, context panel, metrics panel, needs-attention feed. OWNED BY: web-shell. */
import type { AttentionFeed as Feed, RunSummary } from "@shared/types";
import { useApi, usePolling } from "@web/lib/hooks";
import { useProject } from "@web/lib/project-context";
import { ErrorState, LoadingState, PageHeader } from "@web/components/ui";
import { RunLogStrip } from "@web/components/overview/RunLogStrip";
import { AttentionFeed } from "@web/components/overview/AttentionFeed";
import { ContextPanel } from "@web/components/overview/ContextPanel";
import { MetricsPanel } from "@web/components/overview/MetricsPanel";

export function OverviewPage() {
  const { project, projectId } = useProject();
  const pid = encodeURIComponent(projectId);
  const attention = useApi<Feed>(`/projects/${pid}/attention`);
  const runs = useApi<RunSummary[]>(`/projects/${pid}/runs`);
  const active = (runs.data ?? []).some((r) => r.status === "running" || r.status === "pending");
  const reloadAll = () => {
    attention.reload();
    runs.reload();
  };
  usePolling(reloadAll, active, 8000);

  return (
    <div className="space-y-4">
      <PageHeader title="Overview" description={project.siteUrl} />
      {attention.loading && !attention.data ? (
        <LoadingState />
      ) : attention.error ? (
        <ErrorState error={attention.error} onRetry={attention.reload} />
      ) : attention.data ? (
        <>
          <RunLogStrip projectId={projectId} events={attention.data.recentEvents} runs={runs.data ?? []} />
          <AttentionFeed projectId={projectId} feed={attention.data} onRunStarted={reloadAll} />
        </>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-4">
          <ContextPanel project={project} />
        </div>
        <div className="min-w-0 lg:col-span-8">
          <MetricsPanel projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
