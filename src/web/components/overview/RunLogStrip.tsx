/** [A12] region 1: run log strip from run_events, prefixed [SEO]/[GEO]. OWNED BY: web-shell. */
import { useState } from "react";
import { Link } from "react-router";
import type { RunEvent, RunSummary } from "@shared/types";
import { formatDateTime, formatTime } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { Button, cx } from "../ui";

const statusColor: Record<RunEvent["status"], string> = {
  started: "text-sky-700 dark:text-sky-300",
  completed: "text-emerald-700 dark:text-emerald-300",
  skipped: "text-zinc-500 dark:text-zinc-400",
  failed: "text-red-700 dark:text-red-400",
  partial: "text-amber-700 dark:text-amber-300",
  info: "text-zinc-600 dark:text-zinc-400",
};

export function RunLogStrip({ projectId, events, runs }: { projectId: string; events: RunEvent[]; runs: RunSummary[] }) {
  const [expanded, setExpanded] = useState(false);
  const agentByRun = new Map(runs.map((r) => [r.id, r.agent]));
  const sorted = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const shown = expanded ? sorted : sorted.slice(0, 3);
  const listId = "run-log-list";

  return (
    <section aria-labelledby="run-log-heading" className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="run-log-heading" className="text-sm font-semibold">
          Run log
        </h2>
        <div className="flex items-center gap-2">
          <Link to={projectPath(projectId, "runs")} className="text-xs">
            All runs
          </Link>
          {sorted.length > 3 && (
            <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((e) => !e)}>
              {expanded ? "Collapse" : `Show all ${sorted.length}`}
            </Button>
          )}
        </div>
      </div>
      {sorted.length === 0 ? (
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">No runs yet. Start one from the attention feed below.</p>
      ) : (
        <ol id={listId} className={cx("mt-2 space-y-1 font-mono text-xs", expanded && "max-h-80 overflow-y-auto")}>
          {shown.map((e) => {
            const agent = agentByRun.get(e.runId);
            return (
              <li key={e.id} className="flex min-w-0 gap-2">
                <time dateTime={e.createdAt} title={formatDateTime(e.createdAt)} className="shrink-0 text-zinc-500 dark:text-zinc-400">
                  {formatTime(e.createdAt)}
                </time>
                <Link to={projectPath(projectId, `runs/${e.runId}`)} className="min-w-0 break-words text-zinc-800 no-underline hover:underline dark:text-zinc-200">
                  <span className="font-semibold">[{agent ? agent.toUpperCase() : "RUN"}]</span> {e.step} ·{" "}
                  <span className={statusColor[e.status]}>{e.status}</span>
                  {e.message ? ` · ${e.message}` : ""}
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
