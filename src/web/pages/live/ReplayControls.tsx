/**
 * Replay controls (docs/live-view-design.md section 9): role="toolbar", play / pause, restart, skip to end,
 * speed 1× / 10× / 30× (aria-pressed), a labelled run-time scrubber, and a "Keyboard" disclosure. The
 * keyboard shortcuts themselves are handled by the Live view root (focus inside the view, not in a field).
 */
import { useId, useState } from "react";
import { cx } from "@web/components/ui";
import { SPEEDS, type ReplayClock, type Speed } from "./engine";
import { clockText } from "./text";

const btn =
  "inline-flex h-7 items-center justify-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs font-medium text-zinc-800 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

export const SHORTCUTS: Array<[string, string]> = [
  ["Space or K", "Play / pause"],
  ["Home", "Restart"],
  ["End", "Skip to end"],
  ["1, 2, 3", "Speed 1×, 10×, 30×"],
  ["← →", "Seek 5 s"],
  ["Shift + ← →", "Seek 30 s"],
  ["F", "Full screen"],
];

export function ReplayControls({
  clock,
  onToggle,
  onRestart,
  onEnd,
  onSpeed,
  onSeek,
}: {
  clock: ReplayClock;
  onToggle: () => void;
  onRestart: () => void;
  onEnd: () => void;
  onSpeed: (s: Speed) => void;
  onSeek: (absMs: number) => void;
}) {
  const [help, setHelp] = useState(false);
  const scrubId = useId();
  const total = Math.max(0, clock.tEnd - clock.t0);
  const at = Math.max(0, clock.p - clock.t0);
  const valueText = `Run time ${clockText(at)} of ${clockText(total)}`;
  return (
    <div className="min-w-0 space-y-1">
      <div role="toolbar" aria-label="Replay controls" className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button type="button" className={btn} onClick={onToggle} aria-label={clock.finished ? "Restart replay" : clock.playing ? "Pause replay" : "Play replay"}>
          <span aria-hidden="true">{clock.playing ? "❚❚" : "▶"}</span>
          <span>{clock.finished ? "Restart" : clock.playing ? "Pause" : "Play"}</span>
        </button>
        <button type="button" className={btn} onClick={onRestart} aria-label="Restart replay">
          <span aria-hidden="true">⏮</span>
        </button>
        <button type="button" className={btn} onClick={onEnd} aria-label="Skip to end">
          <span aria-hidden="true">⏭</span>
        </button>
        <div role="group" aria-label="Speed" className="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={clock.speed === s}
              onClick={() => onSpeed(s)}
              className={cx(
                "px-2 py-0.5 font-mono text-xs focus-visible:outline-2 focus-visible:outline-sky-600",
                clock.speed === s ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-white text-zinc-700 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300",
              )}
            >
              {s}×
            </button>
          ))}
        </div>
        <label htmlFor={scrubId} className="sr-only">
          Replay position (run time)
        </label>
        <input
          id={scrubId}
          type="range"
          min={0}
          max={Math.max(1, Math.round(total / 1000))}
          step={1}
          value={Math.round(at / 1000)}
          aria-valuetext={valueText}
          onChange={(e) => onSeek(clock.t0 + Number(e.target.value) * 1000)}
          className="h-7 min-w-24 flex-1 accent-sky-700 dark:accent-sky-400"
        />
        <span className="font-mono text-[11px] text-zinc-600 tabular-nums dark:text-zinc-400" aria-hidden="true">
          {clockText(at)} / {clockText(total)}
        </span>
        <button type="button" className={btn} aria-expanded={help} onClick={() => setHelp((h) => !h)}>
          Keyboard
        </button>
      </div>
      {help && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md border border-zinc-200 bg-white p-2 text-[11px] dark:border-zinc-800 dark:bg-zinc-900">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-zinc-800 dark:text-zinc-200">{k}</dt>
              <dd className="text-zinc-600 dark:text-zinc-400">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {clock.finished && <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">Replay finished · Restart to play again</p>}
    </div>
  );
}
