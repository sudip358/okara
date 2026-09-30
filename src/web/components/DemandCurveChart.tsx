/**
 * First-party search demand curve: the site's GSC queries ranked by impressions on a log scale,
 * shaded by head / middle / long-tail segments (cut by cumulative impression share).
 * This is where the site is already visible, not market search volume.
 */
import { useId, useState } from "react";
import type { DemandCurve, DemandSegment } from "@shared/types";
import { formatNumber, formatRatio, formatWindow } from "@web/lib/format";
import { Button, Table, TBody, TD, TH, THead, TR } from "./ui";

const LABEL: Record<DemandSegment, string> = { head: "Head", middle: "Middle", long_tail: "Long tail" };
const FILL: Record<DemandSegment, string> = {
  head: "fill-indigo-500/25 dark:fill-indigo-400/25",
  middle: "fill-indigo-500/15 dark:fill-indigo-400/15",
  long_tail: "fill-indigo-500/5 dark:fill-indigo-400/10",
};

const W = 640;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 52 };

export function DemandCurveChart({ curve }: { curve: DemandCurve }) {
  const titleId = useId();
  const [showTable, setShowTable] = useState(false);
  const pts = curve.points.filter((p) => p.impressions > 0);
  if (pts.length < 2) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">Not enough query data to draw a demand curve.</p>;
  }

  const maxRank = Math.max(...pts.map((p) => p.rank));
  const maxImp = Math.max(...pts.map((p) => p.impressions));
  const topExp = Math.max(1, Math.ceil(Math.log10(maxImp)));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (rank: number) => PAD.left + ((rank - 1) / Math.max(1, maxRank - 1)) * innerW;
  const y = (imp: number) => PAD.top + innerH - (Math.log10(Math.max(1, imp)) / topExp) * innerH;

  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.rank).toFixed(1)},${y(p.impressions).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts[pts.length - 1]!.rank).toFixed(1)},${PAD.top + innerH} L${x(pts[0]!.rank).toFixed(1)},${PAD.top + innerH} Z`;

  // Segment boundaries by cumulative query counts (segments are ordered head -> middle -> long tail).
  let start = 1;
  const bands = curve.segments
    .filter((s) => s.queryCount > 0)
    .map((s) => {
      const from = start;
      const to = start + s.queryCount - 1;
      start = to + 1;
      return { segment: s.segment, from, to };
    });

  const ticks = Array.from({ length: topExp + 1 }, (_, i) => 10 ** i);
  const summary = curve.segments
    .map((s) => `${LABEL[s.segment]}: ${formatNumber(s.queryCount)} queries, ${formatRatio(s.shareOfImpressions, "impressions")} of impressions`)
    .join("; ");

  return (
    <figure className="space-y-3">
      <figcaption id={titleId} className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Your search demand curve</span>
        <span className="text-xs text-zinc-600 dark:text-zinc-400">
          {formatNumber(curve.totalQueries)} queries · {formatWindow(curve.window)} · GSC impressions{curve.truncated ? " (row cap reached)" : ""}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full text-zinc-500" role="img" aria-labelledby={titleId} aria-describedby={`${titleId}-desc`}>
        <desc id={`${titleId}-desc`}>{summary}</desc>
        {bands.map((b) => (
          <rect key={b.segment} x={x(b.from)} y={PAD.top} width={Math.max(1, x(b.to) - x(b.from))} height={innerH} className={FILL[b.segment]} />
        ))}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="stroke-zinc-200 dark:stroke-zinc-800" />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="fill-current text-[10px]">
              {t >= 1000 ? `${t / 1000}k` : t}
            </text>
          </g>
        ))}
        <path d={area} className="fill-indigo-500/10 dark:fill-indigo-400/10" />
        <path d={line} fill="none" strokeWidth={2} className="stroke-indigo-600 dark:stroke-indigo-300" />
        {bands.map((b) => (
          <text key={`l-${b.segment}`} x={(x(b.from) + x(b.to)) / 2} y={H - 8} textAnchor="middle" className="fill-current text-[10px]">
            {LABEL[b.segment]}
          </text>
        ))}
      </svg>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{curve.note}</p>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Segments: {curve.segmentation} (method {curve.methodVersion}). “Strong intent” is a heuristic based on modifiers such as “buy”, “price”, or “best”.
      </p>
      <Button size="sm" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
        {showTable ? "Hide segment table" : "Show segment table"}
      </Button>
      {showTable && (
        <div className="overflow-x-auto">
          <Table caption="Demand segments from your Search Console queries">
            <THead>
              <TR>
                <TH>Segment</TH>
                <TH>Queries</TH>
                <TH>Share of impressions</TH>
                <TH>Clicks</TH>
                <TH>CTR</TH>
                <TH>Median words</TH>
                <TH>Strong-intent queries</TH>
                <TH>Examples</TH>
              </TR>
            </THead>
            <TBody>
              {curve.segments.map((s) => (
                <TR key={s.segment}>
                  <TD>{LABEL[s.segment]}</TD>
                  <TD>{formatNumber(s.queryCount)}</TD>
                  <TD>{formatRatio(s.shareOfImpressions, "impressions")}</TD>
                  <TD>{formatNumber(s.clicks)}</TD>
                  <TD>{formatRatio(s.ctr, "impressions", 2)}</TD>
                  <TD>{s.medianWords ?? "—"}</TD>
                  <TD>{formatRatio(s.strongIntentShare, "queries")}</TD>
                  <TD className="max-w-xs">{s.examples.join(" · ") || "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </figure>
  );
}
