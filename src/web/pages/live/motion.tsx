/**
 * Live view motion (docs/live-view-design.md section 8). Every animation is triggered by a stored row
 * arriving (live) or being revealed (replay); nothing moves on its own timer except the elapsed clock and
 * loops that mark GENUINELY pending work (shimmer, live dot). Animations use transform and opacity only.
 * prefers-reduced-motion: CSS keyframes are wrapped in `no-preference`, and tweens are disabled in code.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cx } from "@web/components/ui";
import { retarget, tweenDone, tweenValue, type Tween } from "./engine";

export const LIVE_CSS = [
  "@keyframes lv-row-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}",
  "@keyframes lv-card-in{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:none}}",
  "@keyframes lv-fade{from{opacity:0}to{opacity:1}}",
  "@keyframes lv-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
  "@keyframes lv-hl{from{background-color:var(--lv-hl)}to{background-color:transparent}}",
  "@keyframes lv-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}",
  "@keyframes lv-ping{0%{transform:scale(1);opacity:.6}80%,100%{transform:scale(2.4);opacity:0}}",
  "@keyframes lv-stripes{from{background-position:0 0}to{background-position:24px 0}}",
  "@keyframes lv-pulse{0%,100%{opacity:1}50%{opacity:.35}}",
  "@keyframes lv-tick{from{stroke-dashoffset:14}to{stroke-dashoffset:0}}",
  "@keyframes lv-pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.15);opacity:1}100%{transform:scale(1)}}",
  ".lv-root{--lv-hl:rgb(224 242 254 / .9)}",
  ".dark .lv-root,.lv-root.dark{--lv-hl:rgb(12 74 110 / .45)}",
  "@media (prefers-color-scheme:dark){.lv-root{--lv-hl:rgb(12 74 110 / .45)}}",
  ".lv-shimmer{background-image:linear-gradient(90deg,rgb(228 228 231) 0%,rgb(244 244 245) 50%,rgb(228 228 231) 100%);background-size:200% 100%}",
  "@media (prefers-color-scheme:dark){.lv-shimmer{background-image:linear-gradient(90deg,rgb(39 39 42) 0%,rgb(63 63 70) 50%,rgb(39 39 42) 100%)}}",
  ".lv-stripes{background-image:repeating-linear-gradient(45deg,rgb(14 165 233 / .25) 0 6px,transparent 6px 12px);background-size:24px 24px}",
  ".lv-hatch{background-image:repeating-linear-gradient(45deg,rgb(161 161 170 / .35) 0 3px,transparent 3px 6px)}",
  ".lv-blur{filter:blur(3px)}",
  ".lv-strip{scrollbar-width:thin}",
  "@media (prefers-reduced-motion:no-preference){",
  ".lv-row-in{animation:lv-row-in 240ms ease-out both,lv-hl 1200ms ease-out 240ms both}",
  ".lv-card-in{animation:lv-card-in 280ms ease-out both}",
  ".lv-fade{animation:lv-fade 200ms ease-out both}",
  ".lv-rise{animation:lv-rise 200ms ease-out both}",
  ".lv-shimmer{animation:lv-shimmer 1.6s linear infinite}",
  ".lv-ping{animation:lv-ping 2s cubic-bezier(0,0,.2,1) infinite}",
  ".lv-stripes-run{animation:lv-stripes 1s linear infinite}",
  ".lv-pulse{animation:lv-pulse 1.5s ease-in-out infinite}",
  ".lv-tick path{stroke-dasharray:14;animation:lv-tick 200ms ease-out both}",
  ".lv-pop{animation:lv-pop 300ms ease-in-out both}",
  ".lv-blur{transition:filter 180ms ease-out}",
  ".lv-bar{transition:width 400ms ease-out}",
  ".lv-move{transition:transform 300ms ease-in-out}",
  "}",
  "@media (prefers-reduced-motion:reduce){.lv-row-in{box-shadow:inset 2px 0 0 rgb(14 165 233)}.lv-blur{filter:none}}",
].join("");

/** True when the viewer asked for reduced motion (SSR/tests: false). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => (typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches),
    () => false,
  );
}

/**
 * A number that tweens from its previous RECEIVED value to the new one (600 ms easeOutCubic, one tween in
 * flight, retargeted). Reduced motion: instant. The first render shows the value as is.
 */
export function useTweened(value: number, reduced: boolean): number {
  const tw = useRef<Tween | null>(null);
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (typeof requestAnimationFrame === "undefined" || reduced) {
      tw.current = retarget(null, value, 0, true);
      setShown(value);
      return;
    }
    const now = performance.now();
    tw.current = retarget(tw.current ?? { from: shown, to: shown, start: now, duration: 0 }, value, now, false);
    let raf = 0;
    const step = () => {
      const t = performance.now();
      const cur = tw.current!;
      setShown(tweenValue(cur, t));
      if (!tweenDone(cur, t)) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduced]);
  return shown;
}

/** Tweened integer with tabular figures; the final text is always the exact received value. */
export function AnimatedNumber({ value, reduced, className, format }: { value: number; reduced: boolean; className?: string; format?: (n: number) => string }) {
  const v = useTweened(value, reduced);
  const f = format ?? ((n: number) => Math.round(n).toLocaleString("en-US"));
  return <span className={cx("tabular-nums", className)}>{f(v === value ? value : v)}</span>;
}

/** Pulsing live dot (solid under reduced motion). Decorative. */
export function PulseDot({ className, tone = "emerald" }: { className?: string; tone?: "emerald" | "sky" }) {
  const bg = tone === "sky" ? "bg-sky-500" : "bg-emerald-500";
  return (
    <span aria-hidden="true" className={cx("relative inline-flex h-2 w-2 shrink-0", className)}>
      <span className={cx("lv-ping absolute inline-flex h-full w-full rounded-full opacity-60", bg)} />
      <span className={cx("relative inline-flex h-2 w-2 rounded-full", bg)} />
    </span>
  );
}

/** Shimmer block for GENUINELY pending work only (static muted text under reduced motion). */
export function Shimmer({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cx("lv-shimmer inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium text-sky-800 dark:text-sky-200", className)}>{label}</span>
  );
}

/** Crossfade wrapper: re-mounts (and fades in) when `k` changes. */
export function Crossfade({ k, children, className }: { k: string; children: ReactNode; className?: string }) {
  return (
    <div key={k} className={cx("lv-fade min-w-0", className)}>
      {children}
    </div>
  );
}
