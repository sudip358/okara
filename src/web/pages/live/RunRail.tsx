/**
 * Run rail (docs/live-view-design.md section 2): the agent's steps as a Gantt over run time, GEO lane
 * sub-bars, provider-call ticks, the cumulative spend line (only while every point is priced), counters, and
 * the Step log (replaces the Okara "CMO decisions" log). Built only from revealed `step`, `provider_call` and
 * `engine_answer` items. The spend line is decorative (aria-hidden); the counters are its text equivalent.
 */
import type { ReactNode } from "react";
import type { ActivityItem } from "@shared/types";
import { cx } from "@web/components/ui";
import { callTicks, medianLatency, parseStep, spendSeries, stepSegments, STEP_LABEL, toMs, type SegmentStatus, type StepSegment } from "./engine";
import { EngineBadge } from "./parts";
import { clipText, clockText, fmtInt, fmtUsd } from "./text";

/**
 * What the rail draws: a step still "running" when the run is over (and the view is not mid-replay) ended
 * without a terminal event, so it is drawn as "ended without a result", never as running.
 */
type RailStatus = SegmentStatus | "ended";

const SEG_TONE: Record<RailStatus, string> = {
  not_started: "bg-zinc-100 dark:bg-zinc-800",
  ended: "bg-zinc-400 dark:bg-zinc-600",
  running: "bg-sky-500 dark:bg-sky-400",
  completed: "bg-emerald-600 dark:bg-emerald-500",
  partial: "bg-amber-500 dark:bg-amber-400",
  failed: "bg-rose-600 dark:bg-rose-500",
  skipped: "lv-hatch bg-zinc-200 dark:bg-zinc-700",
};
const SEG_WORD: Record<RailStatus, string> = {
  not_started: "not started",
  ended: "ended without a result",
  running: "running",
  completed: "completed",
  partial: "partial",
  failed: "failed",
  skipped: "skipped",
};
const CHIP_TONE: Record<RailStatus, string> = {
  not_started: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  ended: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  running: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  completed: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  partial: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  skipped: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};

function pct(t: number, t0: number, span: number): number {
  return Math.max(0, Math.min(100, ((t - t0) / span) * 100));
}

/** Display status of a segment: running is only shown while the run can still be running at this point. */
export function railStatus(status: SegmentStatus, runOver: boolean): RailStatus {
  return status === "running" && runOver ? "ended" : status;
}

function Segment({ s, t0, span, now, runOver }: { s: StepSegment; t0: number; span: number; now: number; runOver: boolean }) {
  if (s.start === null) return null;
  const status = railStatus(s.status, runOver);
  const end = s.end ?? now;
  const left = pct(s.start, t0, span);
  const width = Math.max(0.6, pct(end, t0, span) - left);
  return (
    <span
      title={`${s.label}: ${SEG_WORD[status]}${s.message ? ` · ${clipText(s.message, 120)}` : ""}`}
      className={cx("absolute top-0 bottom-0 overflow-hidden rounded-sm", SEG_TONE[status])}
      style={{ left: `${left}%`, width: `${width}%` }}
    >
      {status === "running" && <span className="lv-pulse absolute top-0 right-0 bottom-0 w-1 bg-white/70" />}
      <span className={cx("block truncate px-1 text-[10px] leading-4 font-medium", status === "skipped" || status === "not_started" ? "text-zinc-700 dark:text-zinc-200" : "text-white dark:text-zinc-950")}>{s.lane ? "" : s.label}</span>
    </span>
  );
}

export function RunRail({
  agent,
  items,
  t0,
  axisEnd,
  playhead,
  pages,
  decisions,
  providerCalls,
  laneLabels,
  runOver = false,
  controls,
}: {
  /** Replay controls, drawn at the top of the rail (they drive the same run-time axis). */
  controls?: ReactNode;
  agent: "seo" | "geo";
  /** Revealed items, ascending. */
  items: ActivityItem[];
  t0: number;
  /** Right edge of the time axis: now (live) or the run's end (replay / finished). */
  axisEnd: number;
  /** Replay playhead (a vertical marker), else null. */
  playhead: number | null;
  pages: { read: number; planned: number | null } | null;
  decisions: { act: number; flag: number; drop: number };
  providerCalls: number;
  laneLabels: ReadonlyMap<string, string>;
  /** The run is not active and the view is not mid-replay: a step without a terminal event ended without one. */
  runOver?: boolean;
}) {
  const span = Math.max(1000, axisEnd - t0);
  const now = playhead ?? axisEnd;
  const { steps, lanes } = stepSegments(items, agent);
  const ticks = callTicks(items);
  const p50 = medianLatency(ticks);
  const spend = spendSeries(ticks);
  const maxUsd = spend.points.length ? spend.points[spend.points.length - 1]!.usd : 0;
  const line =
    spend.points.length >= 2 && maxUsd > 0
      ? spend.points.map((pt) => `${(pct(pt.t, t0, span) * 10).toFixed(1)},${(38 - (pt.usd / maxUsd) * 34).toFixed(1)}`).join(" ")
      : null;
  const stepLog = items.filter((it) => it.kind === "step");
  const shownTicks = ticks.slice(-300);
  return (
    <section aria-label="Run rail" className="min-w-0 space-y-1.5 rounded-xl border border-zinc-200 bg-white px-4 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {controls}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <ol className="lv-strip flex min-w-0 items-center gap-1 text-[11px] max-md:w-full max-md:overflow-x-auto md:flex-wrap" aria-label="Steps">
          {steps.map((s, i) => {
            const status = railStatus(s.status, runOver);
            return (
              <li key={s.step} className="flex shrink-0 items-center gap-1">
                {i > 0 && (
                  <span aria-hidden="true" className="text-zinc-400">
                    ▸
                  </span>
                )}
                <span className={cx("inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium", CHIP_TONE[status])} title={status === "ended" ? "No terminal event was stored for this step" : undefined}>
                  {STEP_LABEL[s.step] ?? s.step}
                  {status === "ended" ? <span className="font-normal"> · ended without a result</span> : <span className="sr-only"> {SEG_WORD[status]}</span>}
                  {status === "running" && <span aria-hidden="true" className="lv-pulse h-1.5 w-1.5 rounded-full bg-current" />}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="flex flex-wrap gap-x-3 font-mono text-[11px] text-zinc-700 tabular-nums dark:text-zinc-300">
          <span>calls {fmtInt(providerCalls)}</span>
          {p50 !== null && <span title="Median stored latency of this run's calls">p50 {fmtInt(p50)} ms</span>}
          <span>
            Jev act {fmtInt(decisions.act)} · flag {fmtInt(decisions.flag)} · drop {fmtInt(decisions.drop)}
          </span>
          {pages && (
            <span>
              pages {fmtInt(pages.read)}
              {pages.planned !== null ? ` / ${fmtInt(pages.planned)}` : ""}
            </span>
          )}
        </p>
        <details className="text-[11px] open:basis-full">
          <summary className="cursor-pointer text-zinc-700 dark:text-zinc-300">Step log ({fmtInt(stepLog.length)})</summary>
          <ol role="log" aria-live="off" aria-label="Step log" className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded bg-zinc-950 p-2 font-mono text-zinc-200">
            {stepLog.length === 0 && <li className="text-zinc-400">No step stored yet.</li>}
            {stepLog.map((it) => {
              const s = parseStep(it);
              const st = s?.status ?? null;
              return (
                <li key={it.id} className="flex min-w-0 gap-2">
                  <span className="shrink-0 text-zinc-500">+{clockText(toMs(it.at) - t0)}</span>
                  <span className="shrink-0 text-sky-300">{s ? (STEP_LABEL[s.step] ?? s.step) : "step"}</span>
                  <span
                    className={cx(
                      "shrink-0",
                      st === "failed" ? "text-rose-300" : st === "completed" ? "text-emerald-300" : st === "started" ? "text-sky-200" : st === "info" || st === null ? "text-zinc-400" : "text-amber-200",
                    )}
                  >
                    {st ?? "—"}
                  </span>
                  <span className="min-w-0 truncate" title={it.title}>
                    {clipText(it.title, 160)}
                  </span>
                </li>
              );
            })}
          </ol>
        </details>
      </div>
      {/* Every row shares one time axis: with lane rows, all rows keep the badge gutter on the left. */}
      <div className={cx("hidden md:block", lanes.length > 0 && "pl-[1.625rem]")}>
        <div className="relative h-4 rounded-sm bg-zinc-100 dark:bg-zinc-950" aria-hidden="true">
          {steps.map((s) => (
            <Segment key={s.step} s={s} t0={t0} span={span} now={now} runOver={runOver} />
          ))}
          {playhead !== null && <span className="absolute -top-1 -bottom-1 z-[1] w-0.5 bg-zinc-900 dark:bg-zinc-100" style={{ left: `${pct(playhead, t0, span)}%` }} />}
        </div>
        {lanes.map((l) => (
          <div key={l.step} className="relative mt-0.5 h-5" aria-hidden="true">
            <span className="absolute top-0 -left-[1.625rem]">
              <EngineBadge provider={l.lane!} label={laneLabels.get(l.lane!) ?? null} />
            </span>
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-sm bg-zinc-100 dark:bg-zinc-950">
              <Segment s={l} t0={t0} span={span} now={now} runOver={runOver} />
            </div>
            {playhead !== null && <span className="absolute top-0.5 bottom-0.5 w-px bg-zinc-900/60 dark:bg-zinc-100/60" style={{ left: `${pct(playhead, t0, span)}%` }} />}
          </div>
        ))}
        <div className={cx("relative mt-1", line ? "h-8" : "h-2.5")} aria-hidden="true">
          {shownTicks.map((tk) => (
            <span
              key={tk.id}
              title={`${tk.provider ?? "provider"} · ${tk.latencyMs !== null ? `${fmtInt(tk.latencyMs)} ms` : "latency not recorded"} · ${tk.costUsd !== null ? `${fmtUsd(tk.costUsd)} (${tk.isEstimate ? "estimate" : "actual"})` : "cost unknown"}`}
              className="absolute bottom-0 h-2 w-0.5 bg-zinc-400 dark:bg-zinc-500"
              style={{ left: `${pct(tk.t, t0, span)}%` }}
            />
          ))}
          {line && (
            <svg viewBox="0 0 1000 40" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
              <polyline points={line} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className="stroke-emerald-600 dark:stroke-emerald-400" />
            </svg>
          )}
          {spend.unpricedFrom !== null && (
            <span className="absolute top-0 bottom-0 border-l border-dashed border-amber-600 pl-1 text-[10px] whitespace-nowrap text-amber-800 dark:border-amber-400 dark:text-amber-300" style={{ left: `${pct(spend.unpricedFrom, t0, span)}%` }}>
              unpriced calls from here
            </span>
          )}
        </div>
        <p className="flex justify-between font-mono text-[10px] text-zinc-500 dark:text-zinc-400" aria-hidden="true">
          <span>+00:00</span>
          <span>{line ? `spend line ${fmtUsd(maxUsd)}` : ""}</span>
          <span>+{clockText(span)}</span>
        </p>
      </div>
    </section>
  );
}
