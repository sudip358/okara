/** [A12] region 4: needs-attention feed, one row per agent. OWNED BY: web-shell. */
import { Link } from "react-router";
import type { AttentionFeed as Feed } from "@shared/types";
import { agentLabel, formatRelative } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { RunNowButton } from "../RunNowButton";
import { StateBadge, StatusBadge } from "../ui";

export function AttentionFeed({ projectId, feed, onRunStarted }: { projectId: string; feed: Feed; onRunStarted: () => void }) {
  return (
    <section aria-labelledby="attention-heading" className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 id="attention-heading" className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold dark:border-zinc-800">
        Needs your attention
      </h2>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {feed.agents.map((a) => (
          <li key={a.agent} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{agentLabel(a.agent)} agent</span>
                {a.state !== "ready" && <StateBadge state={a.state} />}
              </div>
              <p className="text-sm">
                <Link to={`${projectPath(projectId, "recommendations")}?agent=${a.agent}`}>
                  {a.newToday} new today
                </Link>
                <span className="text-zinc-500 dark:text-zinc-400"> (0–2 per day)</span>
                {" · "}
                <Link to={`${projectPath(projectId, "recommendations")}?agent=${a.agent}&status=open`}>{a.openApprovals} awaiting approval</Link>
              </p>
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                Last run:{" "}
                {a.lastRun ? (
                  <>
                    <StatusBadge status={a.lastRun.status} />
                    <Link to={projectPath(projectId, `runs/${a.lastRun.id}`)}>{formatRelative(a.lastRun.finishedAt ?? a.lastRun.startedAt ?? a.lastRun.createdAt)}</Link>
                  </>
                ) : (
                  "never"
                )}
              </p>
              {a.newToday === 0 && (
                <p className="text-sm text-zinc-700 dark:text-zinc-300">{a.zeroStateMessage ?? "No new verified opportunities today."}</p>
              )}
            </div>
            <RunNowButton
              projectId={projectId}
              agent={a.agent}
              onStarted={onRunStarted}
              disabled={a.lastRun?.status === "running" || a.lastRun?.status === "pending"}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
