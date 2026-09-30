/**
 * GEO trend as small multiples, one panel per consecutive cohort, so no line ever crosses a cohort
 * change. Null ratios (denominator 0) are gaps, not zeros. A table view is always available.
 */
import type { GeoResults, Ratio } from "@shared/types";
import { formatDateTime, formatRatio } from "@web/lib/format";
import { Badge, EmptyState, TBody, TD, TH, THead, TR, Table } from "@web/components/ui";
import { groupTrendByCohort, type TrendPoint } from "../lib";

const W = 320;
const H = 150;
const PAD = { l: 34, r: 10, t: 10, b: 22 };

const SERIES = [
  {
    key: "mentionRate" as const,
    label: "Mention rate",
    stroke: "stroke-[#2a78d6] dark:stroke-[#3987e5]",
    fill: "fill-[#2a78d6] dark:fill-[#3987e5]",
    dash: undefined as string | undefined,
  },
  {
    key: "citationRate" as const,
    label: "Citation rate",
    stroke: "stroke-[#eb6834] dark:stroke-[#d95926]",
    fill: "fill-[#eb6834] dark:fill-[#d95926]",
    dash: "5 3",
  },
];

function xFor(i: number, n: number): number {
  const inner = W - PAD.l - PAD.r;
  return n <= 1 ? PAD.l + inner / 2 : PAD.l + (inner * i) / (n - 1);
}
function yFor(v: number): number {
  const inner = H - PAD.t - PAD.b;
  return PAD.t + inner * (1 - Math.max(0, Math.min(1, v)));
}

/** Split a series into contiguous runs of non-null points (gaps where unavailable). */
function paths(points: TrendPoint[], key: "mentionRate" | "citationRate"): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  points.forEach((p, i) => {
    const v = (p[key] as Ratio).value;
    if (v === null) {
      if (cur.length > 1) out.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${cur.length === 0 ? "M" : "L"}${xFor(i, points.length).toFixed(1)},${yFor(v).toFixed(1)}`);
  });
  if (cur.length > 1) out.push(cur.join(" "));
  return out;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function CohortPanel({ cohortKey, points, index }: { cohortKey: string; points: TrendPoint[]; index: number }) {
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <figure className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <figcaption className="mb-1 flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <Badge>Cohort {index + 1}</Badge>
        <span className="break-all font-mono">{cohortKey}</span>
        <span>
          · {points.length} run{points.length === 1 ? "" : "s"}
        </span>
      </figcaption>
      {points.length < 2 && (
        <p className="mb-1 text-xs text-amber-800 dark:text-amber-300">Single run in this cohort – no trend can be read from one sample.</p>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Mention and citation rate for cohort ${index + 1}; see table for values`}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={yFor(t)} y2={yFor(t)} className="stroke-zinc-200 dark:stroke-zinc-800" strokeWidth={1} />
            <text x={PAD.l - 6} y={yFor(t) + 3} textAnchor="end" className="fill-zinc-500 text-[9px] dark:fill-zinc-400">
              {t * 100}%
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          p.annotation ? (
            <g key={`a-${i}`}>
              <line
                x1={xFor(i, points.length)}
                x2={xFor(i, points.length)}
                y1={PAD.t}
                y2={H - PAD.b}
                strokeDasharray="2 3"
                className="stroke-zinc-400 dark:stroke-zinc-500"
                strokeWidth={1}
              />
              <title>{p.annotation}</title>
            </g>
          ) : null,
        )}
        {SERIES.map((s) =>
          paths(points, s.key).map((d, j) => (
            <path key={`${s.key}-${j}`} d={d} fill="none" strokeWidth={2} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" className={s.stroke} />
          )),
        )}
        {SERIES.map((s) =>
          points.map((p, i) => {
            const r = p[s.key];
            if (r.value === null) return null;
            return (
              <g key={`${s.key}-pt-${i}`}>
                <circle cx={xFor(i, points.length)} cy={yFor(r.value)} r={4} strokeWidth={2} className={`${s.fill} stroke-white dark:stroke-zinc-900`} />
                <circle cx={xFor(i, points.length)} cy={yFor(r.value)} r={10} fill="transparent">
                  <title>{`${s.label} · ${formatDateTime(p.runAt)}: ${formatRatio(r)}`}</title>
                </circle>
              </g>
            );
          }),
        )}
        {first && (
          <text x={xFor(0, points.length)} y={H - 6} textAnchor={points.length > 1 ? "start" : "middle"} className="fill-zinc-500 text-[9px] dark:fill-zinc-400">
            {shortDate(first.runAt)}
          </text>
        )}
        {last && points.length > 1 && (
          <text x={xFor(points.length - 1, points.length)} y={H - 6} textAnchor="end" className="fill-zinc-500 text-[9px] dark:fill-zinc-400">
            {shortDate(last.runAt)}
          </text>
        )}
      </svg>
    </figure>
  );
}

export function TrendChart({ trend }: { trend: GeoResults["trend"] }) {
  if (trend.length === 0) return <EmptyState title="No runs yet.">Trends appear after scheduled runs complete.</EmptyState>;
  const groups = groupTrendByCohort(trend);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-700 dark:text-zinc-300" aria-hidden="true">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <svg width="22" height="8" viewBox="0 0 22 8">
              <line x1="1" x2="21" y1="4" y2="4" strokeWidth={2} strokeDasharray={s.dash} className={s.stroke} />
            </svg>
            {s.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="12" viewBox="0 0 10 12">
            <line x1="5" x2="5" y1="0" y2="12" strokeDasharray="2 3" className="stroke-zinc-400" strokeWidth={1} />
          </svg>
          Annotation
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {groups.map((g, i) => (
          <div key={`${g.cohortKey}-${i}`} className="min-w-0 space-y-2">
            {i > 0 && (
              <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Cohort changed{g.points[0]?.annotation ? `: ${g.points[0].annotation}` : ""}. Results are not compared across cohorts.
              </p>
            )}
            <CohortPanel cohortKey={g.cohortKey} points={g.points} index={i} />
          </div>
        ))}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer rounded text-xs font-medium text-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-zinc-300">
          Show trend as a table
        </summary>
        <div className="mt-2">
          <Table caption="GEO trend by run">
            <THead>
              <TR>
                <TH>Run</TH>
                <TH>Cohort</TH>
                <TH>Mention rate</TH>
                <TH>Citation rate</TH>
                <TH>Annotation</TH>
              </TR>
            </THead>
            <TBody>
              {groups.flatMap((g) =>
                g.points.map((p, i) => (
                  <TR key={`${g.cohortKey}-${p.runAt}-${i}`}>
                    <TD className="whitespace-nowrap text-xs">{formatDateTime(p.runAt)}</TD>
                    <TD className="break-all font-mono text-xs">{p.cohortKey}</TD>
                    <TD className="whitespace-nowrap text-xs tabular-nums">{formatRatio(p.mentionRate)}</TD>
                    <TD className="whitespace-nowrap text-xs tabular-nums">{formatRatio(p.citationRate, "grounded responses")}</TD>
                    <TD className="text-xs">{p.annotation ?? ""}</TD>
                  </TR>
                )),
              )}
            </TBody>
          </Table>
        </div>
      </details>
    </div>
  );
}
