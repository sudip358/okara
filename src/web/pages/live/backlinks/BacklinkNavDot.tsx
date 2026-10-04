/**
 * Pulsing dot on the "Live Backlinks" nav entry while a backlink check job is queued or running (LiveNavDot style,
 * with screen-reader text). Kept tiny: the sidebar imports it eagerly.
 */
import { jobActive } from "@web/pages/backlinks/lib";
import { useBacklinkJob } from "./job-store";

const CSS =
  "@keyframes lv-bl-ping{0%{transform:scale(1);opacity:.6}80%,100%{transform:scale(2.4);opacity:0}}" +
  "@media (prefers-reduced-motion:no-preference){.lv-bl-ping{animation:lv-bl-ping 2s cubic-bezier(0,0,.2,1) infinite}}";

export function BacklinkNavDot({ projectId }: { projectId: string }) {
  const job = useBacklinkJob(projectId);
  if (!jobActive(job)) return null;
  return <BacklinkDot />;
}

export function BacklinkDot() {
  return (
    <>
      <style>{CSS}</style>
      <span aria-hidden="true" className="relative ml-1.5 inline-flex h-2 w-2 align-middle" data-testid="backlink-nav-dot">
        <span className="lv-bl-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      <span className="sr-only"> (backlink check in progress)</span>
    </>
  );
}
