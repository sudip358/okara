/**
 * [A21] SEO and GEO readiness checklists. Route: /projects/:projectId/checklists?tab=seo|geo
 * Items are measured from stored data where possible and labelled Measured / Heuristic / Manual.
 */
import { Link, useParams, useSearchParams } from "react-router";
import type { Checklist, ChecklistKind } from "@shared/types";
import { useApi } from "@web/lib/hooks";
import { projectPath } from "@web/lib/project-context";
import { ErrorState, LoadingState, PageHeader, StateBadge, StateBanner, Tabs, buttonClass } from "@web/components/ui";
import { ChecklistView, Disclaimer, SourcesLine, TIER_HINT, withItem } from "./components/ChecklistView";

type Tab = Extract<ChecklistKind, "seo" | "geo">;
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "seo", label: "SEO checklist" },
  { id: "geo", label: "GEO checklist" },
];

export function ChecklistsPage() {
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "geo" ? "geo" : "seo";
  const base = `/projects/${encodeURIComponent(projectId)}/checklists`;

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", id);
    setParams(next, { replace: true });
  };

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Readiness checklists"
        description="SEO and GEO practices checked against your latest crawl, Search Console data, and API-sampled AI answers. Items that cannot be measured are marked manual; missing data sources show as not connected."
      />
      <Tabs
        label="Checklist type"
        value={tab}
        onChange={select}
        tabs={TABS.map((t) => ({ id: t.id, label: t.label, content: t.id === tab ? <ChecklistTab key={t.id} kind={t.id} projectId={projectId} base={base} /> : null }))}
      />
    </div>
  );
}

function ChecklistTab({ kind, projectId, base }: { kind: Tab; projectId: string; base: string }) {
  const { data, error, loading, reload, setData } = useApi<Checklist>(projectId ? `${base}/${kind}` : null);

  if (loading && !data) return <LoadingState label={`Loading ${kind.toUpperCase()} checklist…`} />;
  if (error && !data) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <Disclaimer text={data.disclaimer} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SourcesLine checklist={data} />
        <StateBadge state={data.state} />
      </div>
      {data.state === "setup_required" && (
        <StateBanner
          state="setup_required"
          message="No crawl, Search Console data, or GEO observations yet, so most items cannot be measured. Verify your site and connect Search Console, or run the GEO agent."
          action={
            <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
              Go to integrations
            </Link>
          }
        />
      )}
      {data.state === "demo" && <StateBanner state="demo" message="Demo data – simulated run. Statuses are computed from fictional fixtures." />}
      {kind === "seo" && (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-semibold">Reference tiers:</span> {TIER_HINT}
        </p>
      )}
      <ChecklistView
        checklist={data}
        projectId={projectId}
        putPath={(itemId) => `${base}/${kind}/${encodeURIComponent(itemId)}`}
        onItemSaved={(item) => setData(withItem(data, item))}
      />
    </div>
  );
}
