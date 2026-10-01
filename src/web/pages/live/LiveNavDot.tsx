/**
 * Pulsing dot on the "Live" nav entry while any run of the project is pending or running, with sr-only
 * text. Reads the shared /activity/current store (one poller per project, shared with the Live view).
 * Kept tiny: the sidebar imports it eagerly; the Live view itself is lazy-loaded.
 */
import { useCurrentRuns } from "./current-store";

const CSS =
  "@keyframes lv-nav-ping{0%{transform:scale(1);opacity:.6}80%,100%{transform:scale(2.4);opacity:0}}" +
  "@media (prefers-reduced-motion:no-preference){.lv-nav-ping{animation:lv-nav-ping 2s cubic-bezier(0,0,.2,1) infinite}}";

export function LiveNavDot({ projectId }: { projectId: string }) {
  const { anyActive } = useCurrentRuns(projectId);
  if (!anyActive) return null;
  return (
    <>
      <style>{CSS}</style>
      <span aria-hidden="true" className="relative ml-1.5 inline-flex h-2 w-2 align-middle">
        <span className="lv-nav-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      <span className="sr-only"> (run in progress)</span>
    </>
  );
}
