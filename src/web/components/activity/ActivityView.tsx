/**
 * Presentational pieces of the Activity window. Renders only what RunActivity carries (stored rows of
 * the run). Untrusted text (prompts, titles, URLs) is rendered as plain text children. No rates, no
 * projections, no aggregated score. OWNED BY: web-activity.
 */
import type { ReactNode } from "react";
import type {
  ActivityItem,
  ActivityLane,
  ActivityQueuedItem,
  RunActivity,
} from "@shared/types";
import { Link } from "react-router";
import { projectPath } from "@web/lib/project-context";
import { agentLabel } from "@web/lib/format";
import { cx } from "@web/components/ui";
import {
  LABELS,
  LANE_STATE,
  type Tone,
  clip,
  decisionsText,
  elapsedMs,
  finishedText,
  formatClock,
  formatCost,
  formatLatency,
  itemChip,
  kindBadge,
  laneAnswers,
  laneMeta,
  laneModel,
  laneProgress,
  ofText,
  providerLabel,
  readingParts,
  runStatusChip,
  spendText,
  topCitedInstead,
  triggerLabel,
} from "./lib";

/** Slide+fade for newly arrived cards and the live-dot pulse; both off under prefers-reduced-motion. */
export const ACTIVITY_CSS =
  "@keyframes okara-activity-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}" +
  "@keyframes okara-activity-pulse{0%{transform:scale(1);opacity:.6}80%,100%{transform:scale(2.4);opacity:0}}" +
  "@media (prefers-reduced-motion:no-preference){.okara-activity-in{animation:okara-activity-in 200ms ease-out both}" +
  ".okara-activity-ping{animation:okara-activity-pulse 1.6s cubic-bezier(0,0,.2,1) infinite}}" +
  ".okara-activity-strip{scrollbar-width:thin}";

const CHIP: Record<Tone, string> = {
  neutral: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  success:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  warning: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  danger: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  info: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  demo: "bg-fuchsia-50 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-300",
};

const BORDER: Record<ActivityItem["status"], string> = {
  error: "border-l-red-500",
  warn: "border-l-amber-500",
  ok: "border-l-emerald-500",
  info: "border-l-sky-400 dark:border-l-sky-600",
};

/** Missing answers get the red rail like the reference; otherwise the row status decides. */
function railClass(item: ActivityItem): string {
  if (item.outcome === "missing" || item.outcome === "failed")
    return "border-l-red-500";
  if (item.outcome === "named" || item.outcome === "flag")
    return "border-l-amber-500";
  if (item.outcome === "cited" || item.outcome === "act")
    return "border-l-emerald-500";
  if (item.outcome === "drop")
    return "border-l-zinc-300 dark:border-l-zinc-600";
  return BORDER[item.status] ?? "border-l-zinc-300";
}

/** Pulsing green dot (static under reduced motion). Decorative. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx("relative inline-flex h-2 w-2 shrink-0", className)}
    >
      <span className="okara-activity-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
    </span>
  );
}

export function Chip({
  tone,
  children,
  dot = true,
  live,
}: {
  tone: Tone;
  children: ReactNode;
  dot?: boolean;
  live?: boolean;
}) {
  return (
    <span
      className={cx(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-xs font-medium",
        CHIP[tone],
      )}
    >
      {live ? (
        <LiveDot />
      ) : dot ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
        />
      ) : null}
      {children}
    </span>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
  valueClass,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: "green" | "red" | "none";
  valueClass?: string;
  testId?: string;
}) {
  return (
    <div
      className={cx(
        "min-w-0 border-t-2 pt-1.5",
        accent === "green"
          ? "border-emerald-500"
          : accent === "red"
            ? "border-red-500"
            : "border-zinc-200 dark:border-zinc-800",
      )}
    >
      <dt className="truncate text-xs text-zinc-500 dark:text-zinc-400">
        {label}
      </dt>
      <dd
        className={cx(
          "mt-0.5 truncate font-mono text-2xl font-semibold tabular-nums tracking-tight",
          valueClass,
        )}
        data-testid={testId}
      >
        {value}
      </dd>
      {sub && (
        <dd className="mt-0.5 text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">
          {sub}
        </dd>
      )}
    </div>
  );
}

export function RunHeader({
  activity,
  items = [],
  now,
  replay,
  expanded,
}: {
  activity: RunActivity;
  /** Loaded items (any order); used only for the "Cited instead" host. */
  items?: ActivityItem[];
  now: number;
  replay: boolean;
  expanded?: boolean;
}) {
  const { run, totals, active } = activity;
  const chip = runStatusChip(run.status);
  const ms = elapsedMs(run, active, now);
  const spend = spendText(totals.spend);
  const a = totals.answers;
  const anyAnswers = a.cited + a.named + a.missing + a.failed > 0;
  const showAnswers = run.agent === "geo" || anyAnswers;
  const showPages =
    run.agent === "seo" || totals.pagesRead > 0 || totals.pagesPlanned !== null;
  const instead = showAnswers ? topCitedInstead(items) : null;
  const d = totals.decisions;
  const anyDecisions = d.act + d.flag + d.drop > 0;
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="text-base font-semibold">
              {agentLabel(run.agent)} run
            </span>
            <Chip tone={chip.tone} live={active} dot={!active}>
              {chip.label}
            </Chip>
            <Chip tone="neutral" dot={false}>
              {triggerLabel(run.trigger)}
            </Chip>
            {replay && (
              <Chip tone="neutral" dot={false}>
                {LABELS.replay}
              </Chip>
            )}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {active ? LABELS.live : LABELS.replayFeed}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {active ? "Elapsed" : "Duration"}
          </p>
          <p
            className="font-mono text-3xl font-semibold tabular-nums leading-none tracking-tight"
            data-testid="activity-elapsed"
          >
            {run.startedAt || !active ? formatClock(ms) : "Not started"}
          </p>
        </div>
      </div>
      <dl
        className={cx(
          "grid gap-x-4 gap-y-3",
          expanded
            ? "grid-cols-2 sm:grid-cols-[repeat(auto-fit,minmax(120px,1fr))]"
            : "grid-cols-2 sm:grid-cols-3",
        )}
      >
        {showPages && (
          <Stat
            label="Pages read"
            value={totals.pagesRead.toLocaleString()}
            sub={
              totals.pagesPlanned !== null
                ? `of ${totals.pagesPlanned.toLocaleString()} planned`
                : undefined
            }
          />
        )}
        {showAnswers && (
          <Stat
            label="Answers citing you"
            accent="green"
            valueClass="text-emerald-600 dark:text-emerald-400"
            value={a.cited.toLocaleString()}
            sub={
              a.named > 0
                ? `+${a.named.toLocaleString()} named, not cited`
                : undefined
            }
          />
        )}
        {showAnswers && (
          <Stat
            label="Answers skipping you"
            accent="red"
            valueClass="text-red-600 dark:text-red-400"
            value={a.missing.toLocaleString()}
            sub={
              a.failed > 0 ? `${a.failed.toLocaleString()} failed` : undefined
            }
          />
        )}
        {instead && (
          <Stat
            label="Cited instead"
            value={
              <span className="block whitespace-normal break-all font-sans text-base leading-tight font-semibold">
                {instead.host}
              </span>
            }
            sub={`in ${instead.count.toLocaleString()} of ${instead.of.toLocaleString()} loaded answers that did not cite you`}
          />
        )}
        <Stat
          label="Spend so far"
          value={spend.value}
          sub={
            spend.note ? (
              <span className="text-amber-700 dark:text-amber-300">
                {spend.note}
              </span>
            ) : undefined
          }
        />
        <Stat label="Calls" value={totals.providerCalls.toLocaleString()} />
      </dl>
      {(anyDecisions || run.agent === "seo") && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">
            Jev
          </span>{" "}
          {decisionsText(d)}
        </p>
      )}
    </div>
  );
}

export function LaneCard({
  lane,
  model,
}: {
  lane: ActivityLane;
  model?: string | null;
}) {
  const st = LANE_STATE[lane.state] ?? {
    label: lane.state,
    tone: "neutral" as const,
  };
  const latency = formatLatency(lane.lastLatencyMs);
  const meta = laneMeta(lane.provider);
  const p = laneProgress(lane);
  return (
    <div className="min-w-0 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 font-mono text-sm font-bold text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          {meta.glyph}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold">
              {providerLabel(lane.provider) ?? lane.label}
            </span>
            <Chip
              tone={st.tone}
              live={lane.state === "asking"}
              dot={lane.state !== "asking"}
            >
              {st.label}
            </Chip>
          </p>
          <p
            className="line-clamp-2 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400"
            title={lane.label}
          >
            {[clip(lane.label, 80), model].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      <div className="mt-2.5">
        <div
          className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
          role="progressbar"
          aria-label={`${lane.label} prompts asked`}
          aria-valuemin={0}
          aria-valuemax={lane.planned ?? undefined}
          aria-valuenow={lane.done}
          aria-valuetext={`${ofText(lane.done, lane.planned)} asked`}
        >
          <div
            className={cx(
              "h-full rounded-full",
              lane.state === "done" ? "bg-emerald-500" : "bg-sky-500",
            )}
            style={{ width: `${Math.round((p ?? 0) * 100)}%` }}
          />
        </div>
        <p className="mt-1 flex justify-between gap-2 font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          <span>{ofText(lane.done, lane.planned)}</span>
          {latency && <span>last {latency}</span>}
        </p>
      </div>
    </div>
  );
}

/** Greyed card for a not-yet-asked (prompt, engine) pair. */
export function QueuedCard({
  q,
  className,
}: {
  q: ActivityQueuedItem;
  className?: string;
}) {
  return (
    <li
      className={cx(
        "min-w-0 rounded-lg border border-l-4 border-dashed border-zinc-200 border-l-zinc-300 bg-zinc-50 p-2.5 text-zinc-400 dark:border-zinc-800 dark:border-l-zinc-700 dark:bg-zinc-950 dark:text-zinc-500",
        className,
      )}
    >
      <p className="flex items-center justify-between gap-2 text-xs">
        <span>Queued</span>
        <span className="truncate">{q.label}</span>
      </p>
      <p className="mt-1 line-clamp-2 break-words text-sm font-medium">
        {clip(q.promptText)}
      </p>
    </li>
  );
}

export function QueuedCards({ queued }: { queued: ActivityQueuedItem[] }) {
  if (queued.length === 0) return null;
  return (
    <section aria-label="Queued prompts" className="min-w-0 space-y-1.5">
      <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
        Up next · Queued ({queued.length.toLocaleString()})
      </h3>
      <ul
        tabIndex={0}
        aria-label="Queued prompts, scrollable"
        className="okara-activity-strip flex gap-2 overflow-x-auto pb-1 focus-visible:outline-2 focus-visible:outline-sky-600"
      >
        {queued.map((q, i) => (
          <QueuedCard
            key={`${q.provider}:${i}:${q.promptText}`}
            q={q}
            className="w-48 shrink-0"
          />
        ))}
      </ul>
    </section>
  );
}

/** Expanded view: one column per engine, lane card + horizontal strip of its stored answers. */
export function LaneColumns({
  activity,
  itemsAsc,
}: {
  activity: RunActivity;
  itemsAsc: ActivityItem[];
}) {
  const lanes = activity.lanes;
  return (
    <div
      className={cx(
        "grid min-w-0 gap-3",
        lanes.length >= 3
          ? "sm:grid-cols-3"
          : lanes.length === 2
            ? "sm:grid-cols-2"
            : "",
      )}
    >
      {lanes.map((l) => {
        const answers = laneAnswers(itemsAsc, l.provider, 10);
        const queued = activity.active
          ? activity.queued.filter((q) => q.provider === l.provider)
          : [];
        return (
          <div key={l.provider} className="min-w-0 space-y-2">
            <LaneCard lane={l} model={laneModel(itemsAsc, l.provider)} />
            {answers.length + queued.length > 0 && (
              <ul
                tabIndex={0}
                aria-label={`${l.label} answers, scrollable`}
                className="okara-activity-strip flex gap-2 overflow-x-auto pb-1 focus-visible:outline-2 focus-visible:outline-sky-600"
              >
                {answers.map((it) => (
                  <FeedItem
                    key={it.id}
                    item={it}
                    compact
                    className="w-52 shrink-0"
                  />
                ))}
                {queued.map((q, i) => (
                  <QueuedCard
                    key={`q:${i}:${q.promptText}`}
                    q={q}
                    className="w-52 shrink-0"
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Lanes({
  lanes,
  items = [],
  activity,
  expanded,
}: {
  lanes: ActivityLane[];
  items?: ActivityItem[];
  activity?: RunActivity;
  expanded?: boolean;
}) {
  if (lanes.length === 0) return null;
  return (
    <section aria-label="AI engines in this run" className="min-w-0 space-y-2">
      <h3 className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm font-semibold">
        AI engines
        <span
          className="text-[11px] font-normal text-zinc-500 dark:text-zinc-400"
          title={LABELS.apiSampledTip}
        >
          {LABELS.apiSampled}
        </span>
      </h3>
      {expanded && activity ? (
        <LaneColumns activity={activity} itemsAsc={items} />
      ) : (
        <ul className="space-y-2">
          {lanes.map((l) => (
            <li key={l.provider}>
              <LaneCard lane={l} model={laneModel(items, l.provider)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function NowReading({
  nowReading,
}: {
  nowReading: RunActivity["nowReading"];
}) {
  if (!nowReading) return null;
  const { host, path } = readingParts(nowReading.url);
  return (
    <section
      aria-label="Last page read"
      className="min-w-0 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Last page read{host ? ` · ${host}` : ""}
      </p>
      <p className="mt-1 break-all font-mono text-lg font-semibold leading-snug">
        {path}
      </p>
    </section>
  );
}

export function FeedItem({
  item,
  fresh,
  compact,
  className,
}: {
  item: ActivityItem;
  fresh?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const kb = kindBadge(item.kind);
  const chip = itemChip(item);
  const latency = formatLatency(item.latencyMs);
  const provider = providerLabel(item.provider);
  const showCost =
    item.costUsd !== null ||
    item.kind === "provider_call" ||
    item.kind === "engine_answer";
  const meta = [
    kb.label,
    provider,
    showCost ? formatCost(item.costUsd, item.costIsEstimate) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li
      className={cx(
        "min-w-0 rounded-lg border border-l-4 border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900",
        railClass(item),
        fresh && "okara-activity-in",
        className,
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate font-mono text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
          {latency ?? <time dateTime={item.at}>{timeOf(item.at)}</time>}
        </span>
        {chip && <Chip tone={chip.tone}>{chip.label}</Chip>}
      </div>
      <p className="mt-1 line-clamp-2 break-words text-sm font-semibold leading-snug">
        {clip(item.title)}
      </p>
      {item.detail && (
        <p className="mt-0.5 line-clamp-2 break-words text-xs text-zinc-600 dark:text-zinc-400">
          {clip(item.detail)}
        </p>
      )}
      {!compact && item.url && item.kind === "page_read" && (
        <p
          className="mt-0.5 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400"
          title={item.url}
        >
          {clip(item.url, 200)}
        </p>
      )}
      {!compact && (
        <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400">
          <span>{meta}</span>
          {latency && <time dateTime={item.at}>{timeOf(item.at)}</time>}
          {item.kind === "engine_answer" && (
            <span title={LABELS.apiSampledTip}>{LABELS.apiSampled}</span>
          )}
        </p>
      )}
    </li>
  );
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

export function Feed({
  items,
  freshIds,
  announcement,
  live = true,
  expanded,
  loadingEarlier,
}: {
  /** Newest first. */
  items: ActivityItem[];
  freshIds?: ReadonlySet<string>;
  /** Throttled summary for screen readers (the list itself is not a live region). */
  announcement: string;
  live?: boolean;
  expanded?: boolean;
  loadingEarlier?: boolean;
}) {
  return (
    <section aria-label="Live feed" className="min-w-0 space-y-2">
      <h3 className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm font-semibold">
        {live ? "Live feed" : "Feed"}
        <span className="text-[11px] font-normal text-zinc-500 dark:text-zinc-400">
          {live ? LABELS.live : "Replay"}
        </span>
      </h3>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {loadingEarlier && (
        <p
          className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400"
          data-testid="activity-loading-earlier"
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-sky-500"
          />
          {LABELS.loadingEarlier}
        </p>
      )}
      <div role="log" aria-live="off" aria-label="Run activity">
        {items.length === 0 ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            No stored events for this run yet.
          </p>
        ) : (
          <ol className={cx("grid gap-2", expanded && "sm:grid-cols-2")}>
            {items.map((it) => (
              <FeedItem key={it.id} item={it} fresh={freshIds?.has(it.id)} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export function FinishedBanner({
  activity,
  projectId,
}: {
  activity: RunActivity;
  projectId: string;
}) {
  if (activity.active) return null;
  const ms = elapsedMs(activity.run, false, 0);
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="font-semibold">{finishedText(activity.run, ms)}</p>
      <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
        <Link
          to={projectPath(
            projectId,
            `runs/${encodeURIComponent(activity.run.id)}`,
          )}
        >
          Run details
        </Link>
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
  expanded = false,
  freshIds,
  announcement,
  loadingEarlier = false,
}: {
  activity: RunActivity;
  /** Merged items, newest first. */
  items: ActivityItem[];
  projectId: string;
  now: number;
  replay: boolean;
  expanded?: boolean;
  freshIds?: ReadonlySet<string>;
  announcement: string;
  loadingEarlier?: boolean;
}) {
  const asc = items.slice().reverse();
  return (
    <div className="space-y-4">
      <RunHeader
        activity={activity}
        items={asc}
        now={now}
        replay={replay}
        expanded={expanded}
      />
      <FinishedBanner activity={activity} projectId={projectId} />
      {activity.active && <NowReading nowReading={activity.nowReading} />}
      <Lanes
        lanes={activity.lanes}
        items={asc}
        activity={activity}
        expanded={expanded}
      />
      {activity.active && !expanded && <QueuedCards queued={activity.queued} />}
      <Feed
        items={items}
        freshIds={freshIds}
        announcement={announcement}
        live={activity.active}
        expanded={expanded}
        loadingEarlier={loadingEarlier}
      />
    </div>
  );
}
