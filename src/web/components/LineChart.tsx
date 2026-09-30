/**
 * Single-series daily line chart (one y-axis; use two charts for two measures — never dual axes).
 * Crosshair + tooltip on pointer and keyboard (arrow keys), annotation markers, and a table view.
 * OWNED BY: web-shell.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { formatDate, formatNumber } from "@web/lib/format";
import { Button } from "./ui";

export interface LinePoint {
  date: string; // YYYY-MM-DD
  value: number;
}

const H = 140;
const PAD = { top: 10, right: 12, bottom: 22, left: 44 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * p;
}

export function LineChart({
  title,
  points,
  annotations = [],
  unit,
}: {
  title: string;
  points: LinePoint[];
  annotations?: Array<{ date: string; label: string }>;
  unit: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.max(240, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (points.length === 0) {
    return <p className="text-sm text-zinc-600 dark:text-zinc-400">{title}: no daily data in this window.</p>;
  }

  const innerW = width - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const x = (i: number) => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const ticks = [0, max / 2, max];
  const firstPoint = points[0]!;
  const lastPoint = points[points.length - 1]!;
  const indexOfDate = new Map(points.map((p, i) => [p.date, i]));
  const hovered = hover !== null ? points[hover] : undefined;

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const ratio = (px - PAD.left) / innerW;
    const i = Math.round(ratio * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };
  const onKey = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setHover((h) => {
        const cur = h ?? (e.key === "ArrowRight" ? -1 : points.length);
        return Math.min(points.length - 1, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1)));
      });
    } else if (e.key === "Escape") setHover(null);
  };

  return (
    <figure className="viz-root min-w-0">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <figcaption id={titleId} className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {title}
        </figcaption>
        <Button size="sm" variant="ghost" aria-pressed={showTable} onClick={() => setShowTable((s) => !s)}>
          {showTable ? "Hide table" : "Show table"}
        </Button>
      </div>
      <div ref={wrapRef} className="relative w-full">
        <svg
          width={width}
          height={H}
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          aria-labelledby={titleId}
          aria-describedby={`${titleId}-desc`}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          className="block max-w-full touch-none focus-visible:outline-2 focus-visible:outline-sky-600"
        >
          <desc id={`${titleId}-desc`}>
            {`${points.length} days from ${formatDate(firstPoint.date)} to ${formatDate(lastPoint.date)}; maximum ${formatNumber(
              Math.max(...points.map((p) => p.value)),
            )} ${unit}. Use left and right arrow keys to read daily values.`}
          </desc>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="stroke-zinc-200 dark:stroke-zinc-800" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-zinc-500 text-[10px] dark:fill-zinc-400">
                {formatNumber(Math.round(t))}
              </text>
            </g>
          ))}
          {annotations.map((a) => {
            const i = indexOfDate.get(a.date);
            if (i === undefined) return null;
            return (
              <g key={`${a.date}-${a.label}`}>
                <line x1={x(i)} x2={x(i)} y1={PAD.top} y2={PAD.top + innerH} className="stroke-zinc-400 dark:stroke-zinc-500" strokeDasharray="3 3" strokeWidth={1} />
                <title>{`${formatDate(a.date)}: ${a.label}`}</title>
              </g>
            );
          })}
          <path d={d} fill="none" className="stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <text x={PAD.left} y={H - 6} className="fill-zinc-500 text-[10px] dark:fill-zinc-400">
            {formatDate(firstPoint.date)}
          </text>
          <text x={width - PAD.right} y={H - 6} textAnchor="end" className="fill-zinc-500 text-[10px] dark:fill-zinc-400">
            {formatDate(lastPoint.date)}
          </text>
          {hovered && hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} className="stroke-zinc-500" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(hovered.value)} r={4} className="fill-[#2a78d6] stroke-white dark:fill-[#3987e5] dark:stroke-zinc-900" strokeWidth={2} />
            </g>
          )}
        </svg>
        {hovered && hover !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
            style={{ left: Math.min(Math.max(0, x(hover) - 60), width - 130) }}
          >
            <strong className="tabular-nums text-zinc-900 dark:text-zinc-50">{formatNumber(hovered.value)}</strong>{" "}
            <span className="text-zinc-600 dark:text-zinc-400">
              {unit} · {formatDate(hovered.date)}
            </span>
            {annotations
              .filter((a) => a.date === hovered.date)
              .map((a) => (
                <div key={a.label} className="text-zinc-600 dark:text-zinc-400">
                  {a.label}
                </div>
              ))}
          </div>
        )}
      </div>
      {showTable && (
        <div className="mt-2 max-h-56 overflow-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="text-zinc-600 dark:text-zinc-400">
                <th scope="col" className="py-1 font-medium">Date</th>
                <th scope="col" className="py-1 text-right font-medium">{unit}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.date} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1">{formatDate(p.date)}</td>
                  <td className="py-1 text-right tabular-nums">{formatNumber(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}
