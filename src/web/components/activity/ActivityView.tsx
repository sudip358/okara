/**
 * Presentational pieces of the Activity window. Renders only what RunActivity carries (stored rows of
 * the run). Untrusted text (prompts, titles, URLs) is rendered as plain text children. No rates, no
 * projections, no aggregated score. OWNED BY: web-activity.
 */
import type { ActivityItem, ActivityLane, ActivityQueuedItem, RunActivity } from "@shared/types";
import { Link } from "react-router";
import { projectPath } from "@web/lib/project-context";
import { agentLabel } from "@web/lib/format";
import { Badge, cx } from "@web/components/ui";
import {
  LABELS,
  LANE_STATE,
  answersText,
  clip,
  decisionsText,
  elapsedMs,
  finishedText,
  formatCost,
  formatElapsed,
  formatLatency,
  kindBadge,
  ofText,
  outcomeChip,
  pagesText,
  providerLabel,
  runStatusChip,
  spendText,
  triggerLabel,
} from "./lib";

/** Keyframes for the slide-in of newly arrived items; disabled under prefers-reduced-motion. */
export const ACTIVITY_CSS =
  "@keyframes okara-activity-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}" +
  "@media (prefers-reduced-motion:no-preference){.okara-activity-in{animation:okara-activity-in 240ms ease-out}}";

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function RunHeader({ activity, now, replay }: { activity: RunActivity; now: number; replay: boolean }) {
  const { run, totals, active } = activity;
  const chip = runStatusChip(run.status);
  const ms = elapsedMs(run, active, now);
  const spend = spendText(totals.spend);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{agentLabel(run.agent)} run</span>
        <Badge tone={chip.tone}>
          {active && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" />}
          {chip.label}
        </Badge>
        <Badge>{triggerLabel(run.trigger)}</Badge>
        {replay && <Badge tone="neutral">{LABELS.replay}</Badge>}
      </div>
      <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{active ? LABELS.live : "Replay of this run's stored events"}</p>
      <dl className="grid grid-cols-3 gap-2">
        <div className="min-w-0 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
          <dt className="text-[11px] text-zinc-600 dark:text-zinc-400">{active ? "Elapsed" : "Duration"}</dt>
          <dd className="font-mono text-base tabular-nums text-zinc-900 dark:text-zinc-50" data-testid="activity-elapsed">
            {run.startedAt || !active ? formatElapsed(ms) : "Not started"}
          </dd>
        </div>
        <div className="min-w-0 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
          <dt className="text-[11px] text-zinc-600 dark:text-zinc-400">Spend so far</dt>
          <dd className="font-mono text-base tabular-nums text-zinc-900 dark:text-zinc-50">{spend.value}</dd>
          {spend.note && <dd className="text-[10px] leading-tight text-amber-800 dark:text-amber-300">{spend.note}</dd>}
        </div>
        <div className="min-w-0 rounded-lg border border-zinc-200 p-2 dark:border-zinc-800">
          <dt className="text-[11px] text-zinc-600 dark:text-zinc-400">Provider calls</dt>
          <dd className="font-mono text-base tabular-nums text-zinc-900 dark:text-zinc-50">{totals.providerCalls.toLocaleString()}</dd>
        </div>
      </dl>
    </div>
  );
}

export function Counters({ activity }: { activity: RunActivity }) {
  const { totals, run } = activity;
  const a = totals.answers;
  const anyAnswers = a.cited + a.named + a.missing + a.failed > 0;
  return (
    <dl className="space-y-1 text-xs text-zinc-700 dark:text-zinc-300">
      {(run.agent === "seo" || totals.pagesRead > 0 || totals.pagesPlanned !== null) && (
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-zinc-900 dark:text-zinc-100">Pages</dt>
          <dd>{pagesText(totals)}</dd>
        </div>
      )}
      {(run.agent === "geo" || anyAnswers) && (
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium text-zinc-900 dark:text-zinc-100">Answers</dt>
          <dd>{answersText(a)}</dd>
        </div>
      )}
      <div className="flex flex-wrap gap-x-2">
        <dt className="font-medium text-zinc-900 dark:text-zinc-100">Jev</dt>
        <dd>{decisionsText(totals.decisions)}</dd>
      </div>
    </dl>
  );
}

export function LaneRow({ lane }: { lane: ActivityLane }) {
  const st = LANE_STATE[lane.state] ?? { label: lane.state, tone: "neutral" as const };
  const latency = formatLatency(lane.lastLatencyMs);
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg border border-zinc-200 px-2.5 py-1.5 dark:border-zinc-800">
      <span className="min-w-0 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={lane.label}>
        {lane.label}
      </span>
      <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-600 tabular-nums dark:text-zinc-400">
        <Badge tone={st.tone}>{st.label}</Badge>
        <span>{ofText(lane.done, lane.planned)}</span>
        {latency && <span>last {latency}</span>}
      </span>
    </li>
  );
}

export function Lanes({ lanes }: { lanes: ActivityLane[] }) {
  if (lanes.length === 0) return null;
  return (
    <section aria-label="AI engines in this run" className="space-y-1.5">
      <h3 className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
        Engines
        <span className="text-[11px] font-normal text-zinc-600 dark:text-zinc-400" title={LABELS.apiSampledTip}>
          {LABELS.apiSampled}
        </span>
      </h3>
      <ul className="space-y-1.5">
        {lanes.map((l) => (
          <LaneRow key={l.provider} lane={l} />
        ))}
      </ul>
    </section>
  );
}

export function NowReading({ nowReading }: { nowReading: RunActivity["nowReading"] }) {
  if (!nowReading) return null;
  return (
    <p className="min-w-0 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
      <span className="font-semibold">Now reading </span>
      <span className="break-all font-mono">{clip(nowReading.url, 200)}</span>
    </p>
  );
}

export function QueuedCards({ queued }: { queued: ActivityQueuedItem[] }) {
  if (queued.length === 0) return null;
  return (
    <section aria-label="Queued prompts" className="space-y-1.5">
      <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Queued ({queued.length.toLocaleString()})</h3>
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {queued.map((q, i) => (
          <li
            key={`${q.provider}:${i}:${q.promptText}`}
            className="min-w-0 rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-2 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-500"
          >
            <p className="text-[11px]">Queued · {q.label}</p>
            <p className="line-clamp-2 break-words text-xs">{clip(q.promptText)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function FeedItem({ item, fresh }: { item: ActivityItem; fresh?: boolean }) {
  const kb = kindBadge(item.kind);
  const chip = outcomeChip(item.outcome);
  const latency = formatLatency(item.latencyMs);
  const provider = providerLabel(item.provider);
  const showCost = item.costUsd !== null || item.kind === "provider_call" || item.kind === "engine_answer";
  const border =
    item.status === "error"
      ? "border-l-red-500"
      : item.status === "warn"
        ? "border-l-amber-500"
        : item.status === "ok"
          ? "border-l-emerald-500"
          : "border-l-zinc-300 dark:border-l-zinc-700";
  return (
    <li
      className={cx(
        "min-w-0 rounded-lg border border-l-4 border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900",
        border,
        fresh && "okara-activity-in",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-600 tabular-nums dark:text-zinc-400">
        <span
          title={kb.label}
          className="inline-flex h-5 min-w-6 items-center justify-center rounded bg-zinc-100 px-1 font-mono text-[10px] font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <span aria-hidden="true">{kb.letters}</span>
          <span className="sr-only">{kb.label}</span>
        </span>
        <time dateTime={item.at}>{timeOf(item.at)}</time>
        {provider && <span>{provider}</span>}
        {latency && <span>{latency}</span>}
        {showCost && <span>{formatCost(item.costUsd, item.costIsEstimate)}</span>}
        {item.kind === "engine_answer" && <span title={LABELS.apiSampledTip}>{LABELS.apiSampled}</span>}
        {chip && (
          <Badge tone={chip.tone} className="ml-auto">
            {chip.label}
          </Badge>
        )}
      </div>
      <p className="mt-1 break-words text-sm text-zinc-900 dark:text-zinc-100">{clip(item.title)}</p>
      {item.detail && <p className="mt-0.5 break-words text-xs text-zinc-600 dark:text-zinc-400">{clip(item.detail)}</p>}
      {item.url && item.kind === "page_read" && (
        <p className="mt-0.5 break-all font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{clip(item.url, 200)}</p>
      )}
    </li>
  );
}

export function Feed({
  items,
  freshIds,
  announcement,
}: {
  /** Newest first. */
  items: ActivityItem[];
  freshIds?: ReadonlySet<string>;
  /** Throttled summary for screen readers. */
  announcement: string;
}) {
  return (
    <section aria-label="Activity feed" className="space-y-1.5">
      <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">Feed</h3>
      <div role="log" aria-live="polite" aria-label="Run activity">
        <p className="sr-only">{announcement}</p>
        {items.length === 0 ? (
          <p aria-live="off" className="text-xs text-zinc-600 dark:text-zinc-400">
            No stored events for this run yet.
          </p>
        ) : (
          <ol aria-live="off" className="space-y-1.5">
            {items.map((it) => (
              <FeedItem key={it.id} item={it} fresh={freshIds?.has(it.id)} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export function FinishedBanner({ activity, projectId }: { activity: RunActivity; projectId: string }) {
  if (activity.active) return null;
  const ms = elapsedMs(activity.run, false, 0);
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <p className="font-medium text-zinc-900 dark:text-zinc-100">{finishedText(activity.run, ms)}</p>
      <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
        <Link to={projectPath(projectId, `runs/${encodeURIComponent(activity.run.id)}`)}>Run details</Link>
        <Link to={projectPath(projectId, "runs")}>Runs</Link>
        <Link to={projectPath(projectId, "geo/board")}>AI engines</Link>
      </p>
    </div>
  );
}

/** Full body of the window for one run. */
export function ActivityBody({
  activity,
  items,
  projectId,
  now,
  replay,
  freshIds,
  announcement,
}: {
  activity: RunActivity;
  /** Merged items, newest first. */
  items: ActivityItem[];
  projectId: string;
  now: number;
  replay: boolean;
  freshIds?: ReadonlySet<string>;
  announcement: string;
}) {
  return (
    <div className="space-y-3">
      <RunHeader activity={activity} now={now} replay={replay} />
      <FinishedBanner activity={activity} projectId={projectId} />
      <Counters activity={activity} />
      {activity.active && <NowReading nowReading={activity.nowReading} />}
      <Lanes lanes={activity.lanes} />
      {activity.active && <QueuedCards queued={activity.queued} />}
      <Feed items={items} freshIds={freshIds} announcement={announcement} />
    </div>
  );
}
