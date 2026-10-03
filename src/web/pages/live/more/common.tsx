/**
 * Shared bits of the Live view's project containers (docs/live-view-design.md section 17): loading and setup
 * states, captions, the lazy mount for containers below the fold, and the "Showing N of M" note. Untrusted
 * text is always passed as plain strings.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ErrorState } from "@web/components/ui";
import { projectPath } from "@web/lib/project-context";
import { Shimmer } from "../motion";
import { Panel, PanelEmpty } from "../parts";
import { LIVE_TEXT, fmtInt } from "../text";
import type { ContainerDef } from "./registry";

export interface Loadable<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

/** Loading (a request genuinely in flight) or the error with a retry-free message. */
export function LoadState({ state, what }: { state: Loadable<unknown>; what: string }) {
  if (state.error) return <ErrorState error={state.error} title={`Could not load ${what}`} />;
  return <Shimmer label={`Loading ${what}…`} />;
}

/** "Setup required" body: the server's plain-text message and the page that fixes it. */
export function SetupNote({ message, projectId, to, linkLabel }: { message: string | null; projectId: string; to: string; linkLabel: string }) {
  return (
    <div className="space-y-2 py-4 text-center text-xs text-zinc-700 dark:text-zinc-300">
      <p className="text-sm font-medium">Setup required</p>
      {message && <p className="mx-auto max-w-md">{message}</p>}
      <Link to={projectPath(projectId, to)}>{linkLabel}</Link>
    </div>
  );
}

/** Captions of a project container: its source caption, then "Current state, not replayed" during a replay. */
export function captionsFor(base: Array<string | null | undefined>, replaying: boolean, labels: readonly string[] = []): string[] {
  const out = base.filter((x): x is string => !!x);
  for (const l of labels) if (/demo data/i.test(l) && !out.includes(l)) out.unshift(l);
  if (replaying) out.push(LIVE_TEXT.projectLevel);
  return out;
}

/** "Showing 50 of 132" when a list is cut (the counter carries the full count). */
export function ShowingNote({ shown, total, what }: { shown: number; total: number; what: string }) {
  if (total <= shown) return null;
  return (
    <p className="pt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
      Showing {fmtInt(shown)} of {fmtInt(total)} {what}.
    </p>
  );
}

/** Data notes of an insight (basis, caps), muted under the body; the demo label is a caption instead. */
export function Notes({ labels }: { labels: readonly string[] }) {
  const rest = labels.filter((l) => !/demo data/i.test(l));
  if (rest.length === 0) return null;
  return (
    <ul className="space-y-0.5 pt-2 text-[11px] text-zinc-500 dark:text-zinc-400" aria-label="Data notes">
      {rest.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

/**
 * Mounts `children` (a container that fetches its own data) only once it is near the viewport, so containers
 * below the fold do not load until scrolled to. Where IntersectionObserver is missing it mounts at once. The
 * placeholder is a quiet frame with the heading (no shimmer: nothing is being read for it yet).
 */
export function LazyMount({ def, children, reduced }: { def: ContainerDef; children: ReactNode; reduced: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (on) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setOn(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setOn(true);
        io.disconnect();
      }
    }, { rootMargin: "400px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [on]);
  if (on) return <>{children}</>;
  return (
    <div ref={ref} className="flex min-h-[220px] min-w-0 flex-1 flex-col [&>section]:flex-1" data-lazy={def.key}>
      <Panel num={def.num} title={def.title} accent={def.accent} reduced={reduced}>
        <PanelEmpty>Loads when it scrolls into view.</PanelEmpty>
      </Panel>
    </div>
  );
}
