/** Run detail: events timeline, decision log [A3] with feedback [A18], cancel. OWNED BY: web-shell. */
import { Link, useParams } from "react-router";
import type { RunDetail, RunEvent } from "@shared/types";
import { api } from "@web/lib/api";
import { useApi, useMutation, usePolling } from "@web/lib/hooks";
import { agentLabel, formatDateTime, formatTime, humanize } from "@web/lib/format";
import { projectPath, useProject } from "@web/lib/project-context";
import { DecisionLog } from "@web/components/DecisionLog";
import { Badge, Button, Card, Definition, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge, cx } from "@web/components/ui";
import { duration, summaryPairs } from "./RunHistory";

const dot: Record<RunEvent["status"], string> = {
  started: "bg-sky-600",
  completed: "bg-emerald-600",
  skipped: "bg-zinc-400",
  failed: "bg-red-600",
  partial: "bg-amber-500",
  info: "bg-zinc-400",
};

export function RunDetailPage() {
  const { projectId } = useProject();
  const { runId } = useParams();
  const run = useApi<RunDetail>(runId ? `/runs/${encodeURIComponent(runId)}` : null);
  const active = run.data?.status === "running" || run.data?.status === "pending";
  usePolling(run.reload, active, 5000);
  const cancel = useMutation(() => api<unknown>(`/runs/${encodeURIComponent(runId ?? "")}/cancel`, { method: "POST" }));

  const back = (
    <p className="mb-2 text-sm">
      <Link to={projectPath(projectId, "runs")}>← All runs</Link>
    </p>
  );
  if (run.loading && !run.data) return <LoadingState />;
  if (run.error) {
    return (
      <div>
        {back}
        <ErrorState error={run.error} onRetry={run.reload} />
      </div>
    );
  }
  const r = run.data;
  if (!r) return null;
  const events = [...r.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const pairs = summaryPairs(r.summary);

  return (
    <div className="space-y-4">
      {back}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {agentLabel(r.agent)} run <StatusBadge status={r.status} />
            {r.trigger === "demo" && <Badge tone="demo">Demo</Badge>}
          </span>
        }
        description={<span className="font-mono text-xs">{r.id}</span>}
        actions={
          active ? (
            <Button
              variant="danger"
              loading={cancel.loading}
              onClick={async () => {
                const ok = await cancel.run();
                if (ok !== undefined) run.reload();
              }}
            >
              Cancel run
            </Button>
          ) : undefined
        }
      />
      {cancel.error !== null && <ErrorState error={cancel.error} />}
      {active && <p className="text-xs text-zinc-600 dark:text-zinc-400">Cancelling stops future steps; a step already in progress finishes first.</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-1">
          <dl className="space-y-1">
            <Definition term="Trigger">{humanize(r.trigger)}</Definition>
            <Definition term="Created">{formatDateTime(r.createdAt)}</Definition>
            <Definition term="Started">{formatDateTime(r.startedAt)}</Definition>
            <Definition term="Finished">{formatDateTime(r.finishedAt)}</Definition>
            <Definition term="Duration">{duration(r)}</Definition>
            {pairs.map(([k, v]) => (
              <Definition key={k} term={k}>
                {v}
              </Definition>
            ))}
          </dl>
          {r.error && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-red-700 dark:text-red-400">{r.error}</p>}
        </Card>

        <Card title={`Steps (${events.length})`} className="lg:col-span-2">
          {events.length === 0 ? (
            <EmptyState title="No step events recorded yet." />
          ) : (
            <ol className="relative space-y-3 border-l border-zinc-200 pl-4 dark:border-zinc-800">
              {events.map((e) => (
                <li key={e.id} className="relative">
                  <span aria-hidden="true" className={cx("absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full", dot[e.status])} />
                  <p className="text-sm">
                    <span className="font-medium">{e.step}</span> · <span className="text-zinc-700 dark:text-zinc-300">{e.status}</span>{" "}
                    <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)} className="text-xs text-zinc-500 dark:text-zinc-400">
                      {formatTime(e.createdAt)}
                    </time>
                  </p>
                  {e.message && <p className="whitespace-pre-wrap break-words text-xs text-zinc-600 dark:text-zinc-400">{e.message}</p>}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <Card
        title={`Decision log (${r.decisions.length} candidates)`}
        description="Every candidate considered in this run, including rejected ones with reason codes. Use Disagree to label a Jev judgment you think is wrong."
      >
        <DecisionLog decisions={r.decisions} />
      </Card>
    </div>
  );
}
