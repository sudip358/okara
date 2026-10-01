/**
 * Live view building blocks: the numbered panel frame, verdict / Jev chips, block bars, status dots,
 * engine letter badges and the lane gauge. Light and dark use existing zinc / accent tokens only; status
 * always pairs colour with a word. Untrusted text is passed in as plain strings.
 */
import { useId, type ReactNode } from "react";
import type { FactorStatus, LiveSeoVerdict, Ratio } from "@shared/types";
import { cx } from "@web/components/ui";
import { GAUGE, engineGlyph, engineName, gaugePaths } from "@web/pages/geo/board/lib";
import { AnimatedNumber, Shimmer, useTweened } from "./motion";

export type Accent = "sky" | "amber" | "emerald" | "rose" | "zinc";

/**
 * Chip background, top border, counter text and the resolved-row wash per accent (design section 4). The
 * row wash marks rows that hold a stored result (as in the reference, where judged rows are tinted and
 * rows still pending are not); it is decoration, never the only signal.
 */
export const ACCENT: Record<Accent, { chip: string; border: string; text: string; row: string }> = {
  sky: {
    chip: "bg-sky-700 text-white dark:bg-sky-400 dark:text-zinc-950",
    border: "border-t-sky-700 dark:border-t-sky-400",
    text: "text-sky-700 dark:text-sky-400",
    row: "bg-sky-50/70 dark:bg-sky-950/25",
  },
  amber: {
    chip: "bg-amber-700 text-white dark:bg-amber-400 dark:text-zinc-950",
    border: "border-t-amber-600 dark:border-t-amber-400",
    text: "text-amber-600 dark:text-amber-400",
    row: "bg-amber-50/60 dark:bg-amber-950/20",
  },
  emerald: {
    chip: "bg-emerald-700 text-white dark:bg-emerald-400 dark:text-zinc-950",
    border: "border-t-emerald-700 dark:border-t-emerald-400",
    text: "text-emerald-700 dark:text-emerald-400",
    row: "bg-emerald-50/60 dark:bg-emerald-950/20",
  },
  rose: {
    chip: "bg-rose-600 text-white dark:bg-rose-400 dark:text-zinc-950",
    border: "border-t-rose-600 dark:border-t-rose-400",
    text: "text-rose-600 dark:text-rose-400",
    row: "bg-rose-50/60 dark:bg-rose-950/20",
  },
  zinc: {
    chip: "bg-zinc-700 text-white dark:bg-zinc-300 dark:text-zinc-950",
    border: "border-t-zinc-700 dark:border-t-zinc-300",
    text: "text-zinc-700 dark:text-zinc-300",
    row: "bg-zinc-50 dark:bg-zinc-800/30",
  },
};

/** Sticky table head inside a scrolling panel body (the bottom rule is a shadow so it sticks with the head). */
export const THEAD =
  "sticky top-0 z-[1] bg-white shadow-[inset_0_-1px_0_rgb(228_228_231)] dark:bg-zinc-900 dark:shadow-[inset_0_-1px_0_rgb(39_39_42)]";

export interface CounterSpec {
  value: number;
  /** Text right after the number, e.g. "to change". */
  suffix: string;
  /** Second line, e.g. "of 3,910 judged in this run". */
  sub?: string;
  /** Display of the (tweened) value, e.g. a percentage computed by code from stored rows. */
  format?: (n: number) => string;
}

/**
 * One stage panel: 2 px accent top border, numbered chip (aria-hidden; the number is part of the heading
 * text), large bold title, subtitle, big coloured counter on the right, and a body that scrolls inside.
 */
export function Panel({
  num,
  title,
  accent,
  subtitle,
  counter,
  captions,
  reduced,
  className,
  bodyClassName,
  children,
  testId,
  toolbar,
}: {
  num: string;
  title: string;
  accent: Accent;
  subtitle?: ReactNode;
  counter?: CounterSpec | null;
  captions?: ReactNode[];
  reduced: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
  testId?: string;
  /** Filters and other controls between the header and the scrolling body (they never scroll away). */
  toolbar?: ReactNode;
}) {
  const id = useId();
  const a = ACCENT[accent];
  const caps = (captions ?? []).filter(Boolean);
  return (
    <section
      aria-labelledby={id}
      data-panel={testId}
      className={cx(
        "@container flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-t-2 border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900",
        a.border,
        className,
      )}
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1 basis-52">
          <h2 id={id} className="flex min-w-0 items-start gap-2.5 text-base leading-tight font-semibold tracking-tight text-zinc-950 @xl:text-lg @4xl:text-xl dark:text-zinc-50">
            <span aria-hidden="true" className={cx("mt-px inline-flex h-6 min-w-8 shrink-0 items-center justify-center rounded px-1.5 font-mono text-xs font-semibold", a.chip)}>
              {num}
            </span>
            <span className="sr-only">{num} </span>
            <span className="line-clamp-2 min-w-0 pt-0.5 break-words text-balance" title={title}>
              {title}
            </span>
          </h2>
          {subtitle && <p className="mt-1 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">{subtitle}</p>}
        </div>
        {counter && (
          <div className="ml-auto max-w-full shrink-0 text-right">
            <p className="flex items-baseline justify-end gap-1.5">
              <AnimatedNumber value={counter.value} reduced={reduced} format={counter.format} className={cx("font-sans text-3xl leading-none font-semibold tracking-tight tabular-nums @lg:text-[40px]", a.text)} />
              <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">{counter.suffix}</span>
            </p>
            {/* The sub line wraps under the number instead of widening the counter (titles stay on one line). */}
            {counter.sub && <p className="mt-0.5 ml-auto max-w-32 font-mono text-[11px] leading-snug text-balance text-zinc-500 dark:text-zinc-400">{counter.sub}</p>}
          </div>
        )}
      </header>
      {/* Captions and controls share one wrapping row, so the table starts right under the header. */}
      {(caps.length > 0 || toolbar) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-4 pb-1.5">
          {caps.map((c, i) => (
            <span key={i} className="inline-flex max-w-full items-center rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              {c}
            </span>
          ))}
          {toolbar}
        </div>
      )}
      <div data-panel-body="" className={cx("min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-3", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ chips
const VERDICT_TONE: Record<LiveSeoVerdict, { square: string; text: string; label: string }> = {
  keep: { square: "bg-emerald-600 dark:bg-emerald-400", text: "text-emerald-800 dark:text-emerald-300", label: "Keep" },
  change: { square: "bg-rose-600 dark:bg-rose-400", text: "text-rose-700 dark:text-rose-300", label: "Change" },
  review: { square: "bg-amber-500 dark:bg-amber-400", text: "text-amber-800 dark:text-amber-300", label: "Review" },
};

/**
 * Square + word (Keep / Change / Review). Pending rows: the "Reading…" shimmer while the step that stores
 * them is running, or a static "Up next" chip (replay rows later in the run, step not started yet).
 */
export function VerdictChip({ verdict, pending, pendingLabel = "Reading…", pendingStatic = false }: { verdict: LiveSeoVerdict | null; pending?: boolean; pendingLabel?: string; pendingStatic?: boolean }) {
  if ((pending || !verdict) && pendingStatic) return <PendingChip label={pendingLabel} />;
  if (pending || !verdict) return <Shimmer label={pendingLabel} />;
  const v = VERDICT_TONE[verdict];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap", v.text)}>
      <span aria-hidden="true" className={cx("h-2.5 w-2.5 shrink-0 rounded-[2px]", v.square)} />
      {v.label}
    </span>
  );
}

/** Static muted chip for a replay row that is later in the run (no shimmer: nothing is being read yet). */
export function PendingChip({ label }: { label: string }) {
  return <span className="inline-flex items-center rounded border border-dashed border-zinc-300 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">{label}</span>;
}

export type ToneName = "keep" | "change" | "review" | "info" | "none";
const TONE_CHIP: Record<ToneName, string> = {
  keep: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  change: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  review: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  info: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  none: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

/** Small coloured chip with a dot and a word (colour is never the only signal). */
export function ToneChip({ tone, children, title, className }: { tone: ToneName; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cx("inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", TONE_CHIP[tone], className)}>
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** "Jev act · 0.92" in mono; flag tier amber with "unsure"; tooltip carries basis, provider and model. */
export function JevChip({ text, tier, title }: { text: string; tier: string | null; title?: string }) {
  const tone = tier === "act" ? "text-zinc-800 dark:text-zinc-200" : tier === "flag" ? "text-amber-800 dark:text-amber-300" : "text-zinc-500 dark:text-zinc-400";
  return (
    <span title={title} className={cx("inline-block max-w-full truncate font-mono text-[11px] tabular-nums", tone)}>
      {text}
      {tier === "flag" && <span className="ml-1 font-sans">unsure</span>}
    </span>
  );
}

// ------------------------------------------------------------------ bars and dots
const LEVEL_BLOCKS: Record<FactorStatus, number> = { present: 4, partial: 2, missing: 0, unknown: -1 };
const STATUS_WORD: Record<FactorStatus, string> = { present: "present", partial: "partial", missing: "missing", unknown: "unknown" };

/** Four-block bar for a check status: present 4, partial 2, missing an empty outline, unknown hatched. */
export function BlockBar({ status, label, title, accent = "amber" }: { status: FactorStatus; label: string; title?: string; accent?: "amber" | "rose" | "sky" }) {
  const n = LEVEL_BLOCKS[status];
  const fill = accent === "rose" ? "bg-rose-500 dark:bg-rose-400" : accent === "sky" ? "bg-sky-600 dark:bg-sky-400" : "bg-amber-600 dark:bg-amber-400";
  return (
    <span role="img" aria-label={`${label}: ${STATUS_WORD[status]}`} title={title ?? `${label}: ${STATUS_WORD[status]}`} className="inline-flex items-center gap-[2px]">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cx(
            "h-2 w-1.5 rounded-[1px]",
            n < 0 ? "lv-hatch border border-zinc-300 dark:border-zinc-600" : i < n ? fill : "border border-zinc-300 dark:border-zinc-600",
          )}
        />
      ))}
    </span>
  );
}

const DOT_TONE: Record<FactorStatus, string> = {
  present: "bg-emerald-600 dark:bg-emerald-400",
  partial: "bg-amber-500 dark:bg-amber-400",
  missing: "border border-rose-500 bg-transparent dark:border-rose-400",
  unknown: "lv-hatch border border-zinc-300 dark:border-zinc-600",
};

/** One status dot (present filled, partial amber, missing hollow, unknown hatched) with an accessible name. */
export function StatusDot({ status, label, title }: { status: FactorStatus; label: string; title?: string }) {
  return <span role="img" aria-label={`${label}: ${STATUS_WORD[status]}`} title={title ?? `${label}: ${STATUS_WORD[status]}`} className={cx("inline-block h-2.5 w-2.5 rounded-full", DOT_TONE[status])} />;
}

/** Horizontal fill bar for a 0..1 measured value (e.g. overlap score); never a projection. */
export function MiniBar({ value, label, className }: { value: number | null; label: string; className?: string }) {
  const w = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(1, value));
  return (
    <span aria-hidden="true" title={label} className={cx("inline-block h-1.5 w-12 overflow-hidden rounded-full bg-zinc-200 align-middle dark:bg-zinc-700", className)}>
      <span className="lv-bar block h-full rounded-full bg-emerald-600 dark:bg-emerald-400" style={{ width: `${Math.round(w * 100)}%` }} />
    </span>
  );
}

// ------------------------------------------------------------------ engines
/** Letter badge for an engine lane (never a vendor logo or colour); title = real lane label. */
export function EngineBadge({ provider, label, size = "sm" }: { provider: string; label?: string | null; size?: "sm" | "md" }) {
  return (
    <span
      title={label ?? engineName(provider)}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded border border-zinc-300 font-mono font-semibold text-zinc-700 dark:border-zinc-600 dark:text-zinc-200",
        size === "md" ? "h-8 w-8 rounded-lg text-sm" : "h-5 w-5 text-[10px]",
      )}
    >
      <span aria-hidden="true">{engineGlyph(provider)}</span>
      <span className="sr-only">{label ?? engineName(provider)}</span>
    </span>
  );
}

/**
 * Semicircle gauge of a lane ratio from this run's stored answers (numerator and denominator printed);
 * the arc sweeps from the previous received value (instant under reduced motion).
 */
export function LaneGauge({ ratio, caption, reduced }: { ratio: Ratio; caption: string; reduced: boolean }) {
  const has = ratio.denominator > 0 && ratio.value !== null;
  const f = useTweened(has ? ratio.value! : 0, reduced);
  const g = gaugePaths({ numerator: ratio.numerator, denominator: Math.max(1, ratio.denominator), value: has ? f : 0 });
  const pct = has ? `${Math.round(ratio.value! * 1000) / 10}%` : "—";
  const label = has ? `${caption}: ${pct}, ${ratio.numerator} of ${ratio.denominator} answers` : `${caption}: no answers yet`;
  // The value sits inside the arc (reference gauge); caption and n of m sit under it.
  return (
    <div className="flex min-w-0 shrink-0 flex-col items-center text-center">
      <div className="relative h-[62px] w-28 shrink-0">
        <svg role="img" aria-label={label} viewBox={`0 0 ${GAUGE.width} ${GAUGE.height}`} className="absolute inset-0 h-full w-full">
          <path d={g.track} fill="none" strokeWidth={7} strokeLinecap="round" className="stroke-zinc-200 dark:stroke-zinc-700" />
          {has && g.value && <path d={g.value} fill="none" strokeWidth={7} strokeLinecap="round" className="stroke-emerald-600 dark:stroke-emerald-400" />}
        </svg>
        <p aria-hidden="true" className="absolute inset-x-0 bottom-0.5 font-mono text-xl leading-none font-bold text-emerald-700 tabular-nums dark:text-emerald-400">
          {pct}
        </p>
      </div>
      <p className="text-[11px] leading-tight text-zinc-600 dark:text-zinc-400">{caption}</p>
      <p className="font-mono text-[11px] leading-tight text-zinc-500 tabular-nums dark:text-zinc-400">{has ? `${ratio.numerator} of ${ratio.denominator} answers` : "No answers yet"}</p>
    </div>
  );
}

/** Muted empty caption inside a panel. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-zinc-600 dark:text-zinc-400">{children}</p>;
}

/** Table header cell (mono, muted) for the dense live tables; `tight` for narrow status columns. */
export function LTH({ children, className, title, tight }: { children?: ReactNode; className?: string; title?: string; tight?: boolean }) {
  return (
    <th
      scope="col"
      title={title}
      className={cx(
        "overflow-hidden py-1 text-left align-bottom font-mono font-normal text-ellipsis whitespace-nowrap text-zinc-500 first:pl-0 last:pr-0 dark:text-zinc-400",
        tight ? "px-0.5 text-[10px]" : "px-1.5 text-[11px]",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function LTD({ children, className, title, tight }: { children?: ReactNode; className?: string; title?: string; tight?: boolean }) {
  return (
    <td title={title} className={cx("min-w-0 truncate py-1 align-middle first:pl-0 last:pr-0", tight ? "px-0.5" : "px-1.5", className)}>
      {children}
    </td>
  );
}
