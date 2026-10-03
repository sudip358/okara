/** Run history table. OWNED BY: web-shell. */
import { scopeLabel } from "@shared/run-scope";
import { engineName } from "@web/pages/geo/board/lib";
import { useState } from "react";
import { Link } from "react-router";
import type { AgentKind, RunSummary } from "@shared/types";
import { useApi, usePolling } from "@web/lib/hooks";
import { agentLabel, formatDateTime, humanize } from "@web/lib/format";
import { projectPath, useProject } from "@web/lib/project-context";
import { RunNowButton } from "@web/components/RunNowButton";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge, TBody, TD, TH, THead, TR, Table } from "@web/components/ui";

export function duration(r: Pick<RunSummary, "startedAt" | "finishedAt">): string {
  if (!r.startedAt) return "—";
  const end = r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - new Date(r.startedAt).getTime()) / 1000));
  const txt = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return r.finishedAt ? txt : `${txt} so far`;
}

/** Shallow, primitive-only rendering of a run summary object (untrusted-safe: plain text). */
export function summaryPairs(summary: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(summary)
    .filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => [humanize(k), v === null ? "—" : String(v)]);
}

export function RunHistoryPage() {
  const { projectId } = useProject();
  const runs = useApi<RunSummary[]>(`/projects/${encodeURIComponent(projectId)}/runs`);
  const [agent, setAgent] = useState<AgentKind | "all">("all");
  const active = (runs.data ?? []).some((r) => r.status === "running" || r.status === "pending");
  usePolling(runs.reload, active, 8000);
  const shown = (runs.data ?? []).filter((r) => agent === "all" || r.agent === agent);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Runs"
        description="Every agent run with its real status. Manual runs are quota-limited."
        actions={
          <>
            <RunNowButton projectId={projectId} agent="seo" onStarted={runs.reload} />
            <RunNowButton projectId={projectId} agent="geo" onStarted={runs.reload} />
          </>
        }
      />
      <Card>
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter by agent">
          {(["all", "seo", "geo"] as const).map((a) => (
            <Button key={a} size="sm" variant={agent === a ? "primary" : "secondary"} aria-pressed={agent === a} onClick={() => setAgent(a)}>
              {a === "all" ? "All agents" : agentLabel(a)}
            </Button>
          ))}
        </div>
        {runs.loading && !runs.data ? (
          <LoadingState />
        ) : runs.error ? (
          <ErrorState error={runs.error} onRetry={runs.reload} />
        ) : shown.length === 0 ? (
          <EmptyState title="No runs yet." />
        ) : (
          <Table caption="Runs">
            <THead>
              <TR>
                <TH>Run</TH>
                <TH>Status</TH>
                <TH>Trigger</TH>
                <TH>Created</TH>
                <TH>Duration</TH>
                <TH>Summary</TH>
              </TR>
            </THead>
            <TBody>
              {shown.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link to={projectPath(projectId, `runs/${r.id}`)} className="font-medium">
                      {agentLabel(r.agent)} run
                    </Link>
                    <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{r.id.slice(0, 12)}</div>
                    {r.scope && <div className="text-xs font-medium text-sky-800 dark:text-sky-300">{scopeLabel(r.scope, engineName)}</div>}
                  </TD>
                  <TD>
                    <StatusBadge status={r.status} />
                  </TD>
                  <TD>{r.trigger === "demo" ? <Badge tone="demo">Demo</Badge> : humanize(r.trigger)}</TD>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(r.createdAt)}</TD>
                  <TD className="whitespace-nowrap text-xs">{duration(r)}</TD>
                  <TD className="min-w-48 text-xs">
                    {r.error && <p className="break-words text-red-700 dark:text-red-400">{r.error}</p>}
                    {summaryPairs(r.summary)
                      .slice(0, 4)
                      .map(([k, v]) => (
                        <span key={k} className="mr-2 inline-block">
                          <span className="text-zinc-500 dark:text-zinc-400">{k}:</span> {v}
                        </span>
                      ))}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
