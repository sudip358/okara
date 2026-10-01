/**
 * Live view header (docs/live-view-design.md section 2): logo square, "Live · SEO agent", project domain,
 * engine letter badges (no vendor logos), SEO | GEO toggle, the status pill with exact honesty wording, the
 * full-screen button, and the honesty strip with deduped label chips.
 */
import type { ReactNode } from "react";
import { cx } from "@web/components/ui";
import { PulseDot } from "./motion";
import { EngineBadge } from "./parts";
import { LIVE_TEXT, dedupeLabels, type LiveMode } from "./text";

export function LivePill({ mode, text, sub }: { mode: LiveMode; text: string; sub?: string | null }) {
  return (
    <div className="min-w-0 text-right">
      <p
        data-testid="live-pill"
        className={cx(
          "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs tabular-nums",
          mode === "live" ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "border-zinc-300 bg-white text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200",
        )}
      >
        {mode === "live" ? (
          <PulseDot />
        ) : (
          <span aria-hidden="true" className="shrink-0">
            {mode === "replay" ? "▶" : mode === "pending" ? "○" : "■"}
          </span>
        )}
        <span className="min-w-0 break-words whitespace-normal">{text}</span>
      </p>
      {sub && <p className="mt-0.5 font-mono text-[11px] text-zinc-600 tabular-nums dark:text-zinc-400">{sub}</p>}
    </div>
  );
}

export function LiveHeader({
  agent,
  domain,
  engines,
  pill,
  toggle,
  fullscreen,
  onFullscreen,
  labels,
  replaying,
  extra,
}: {
  agent: "seo" | "geo";
  domain: string;
  engines: Array<{ provider: string; label: string }>;
  pill: ReactNode;
  toggle: { seo: boolean; geo: boolean; onSelect: (agent: "seo" | "geo") => void };
  fullscreen: boolean;
  onFullscreen: () => void;
  labels: string[];
  replaying: boolean;
  extra?: ReactNode;
}) {
  const chips = dedupeLabels([...labels, agent === "geo" ? LIVE_TEXT.apiSampled : null]);
  return (
    <header className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span aria-hidden="true" className="relative inline-block h-5 w-5 shrink-0">
            <span className="absolute inset-0 right-1 bottom-1 rounded-[3px] bg-sky-700 dark:bg-sky-400" />
            <span className="absolute right-0 bottom-0 h-2 w-2 rounded-[2px] bg-amber-600 dark:bg-amber-400" />
          </span>
          <h1 className="text-xl font-bold tracking-tight text-zinc-950 sm:text-2xl dark:text-zinc-50">Live · {agent === "seo" ? "SEO" : "GEO"} agent</h1>
          <span className="max-w-full truncate font-mono text-xs text-zinc-600 dark:text-zinc-400" title={domain}>
            {domain}
          </span>
          {engines.length > 0 && (
            <span className="flex flex-wrap gap-1" aria-label="AI engines">
              {engines.map((e) => (
                <EngineBadge key={e.provider} provider={e.provider} label={e.label} />
              ))}
            </span>
          )}
          <div role="group" aria-label="Agent" className="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
            {(["seo", "geo"] as const).map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={agent === a}
                onClick={() => toggle.onSelect(a)}
                className={cx(
                  "px-2.5 py-0.5 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-sky-600",
                  agent === a ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-700 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
                )}
              >
                {a.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 items-start gap-2">
          {pill}
          <button
            type="button"
            aria-pressed={fullscreen}
            onClick={onFullscreen}
            title={fullscreen ? "Exit full screen (F)" : "Enter full screen (F)"}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs text-zinc-800 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <span aria-hidden="true">⛶</span>
            <span className="sr-only sm:not-sr-only">{fullscreen ? "Exit full screen" : "Enter full screen"}</span>
          </button>
        </div>
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
        <span>{replaying ? LIVE_TEXT.honestyReplay : LIVE_TEXT.honestyLive}</span>
        {chips.map((l) => (
          <span key={l} className="max-w-full truncate rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {l}
          </span>
        ))}
      </p>
      {extra}
    </header>
  );
}
