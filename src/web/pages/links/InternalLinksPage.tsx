/**
 * Internal links workbench [A25] + 2026-10-03. Route: /projects/:projectId/internal-links?tab=<tab>
 * Tabs: Suggestions (priority-sorted, filters, bulk accept/dismiss, sheet export), Clusters (hubs and spokes with
 * their missing links), Link graph (per-URL table), Broken links, Anchors (anchor text audit), Placed & verified.
 * Everything is built from the latest snapshot of every crawled page (the rolling crawl covers the whole sitemap over
 * successive runs); coverage is shown on every tab. Okara never edits pages.
 */
import { useParams, useSearchParams } from "react-router";
import type { LinkGraphSummary, LinkSuggestion, LinkSuggestionReport } from "@shared/types";
import { api, ApiError, errorMessage } from "@web/lib/api";
import { useApi, useMutation } from "@web/lib/hooks";
import { Button, ErrorState, LoadingState, PageHeader, StateBadge, StateBanner, Tabs } from "@web/components/ui";
import { AnchorsTab } from "./AnchorsTab";
import { BrokenTab } from "./BrokenTab";
import { ClustersTab } from "./ClustersTab";
import { GraphTab } from "./GraphTab";
import { LINK_LABEL_CONFIDENCE, LINK_LABEL_REVIEW, WORKBENCH_TABS, tabFromParam, type WorkbenchTab } from "./lib";
import { CoverageStrip } from "./parts";
import { PlacedTab } from "./PlacedTab";
import { SuggestionsTab } from "./SuggestionsTab";

export function InternalLinksPage() {
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = tabFromParam(params.get("tab"));
  const base = `/projects/${encodeURIComponent(projectId)}/seo/internal-links`;
  const report = useApi<LinkSuggestionReport>(projectId ? base : null);
  const runner = useMutation(() => api<LinkSuggestionReport>(`${base}/run`, { method: "POST" }));
  const rebuilder = useMutation(() => api<LinkGraphSummary>(`${base}/graph/rebuild`, { method: "POST" }));
  const r = report.data;

  const run = async () => {
    const next = await runner.run();
    if (next) report.setData(next);
  };
  const rebuild = async () => {
    const g = await rebuilder.run();
    if (g && r) report.setData({ ...r, graph: g });
  };
  const replaceSuggestions = (changed: LinkSuggestion[]) => {
    if (!r) return;
    const byId = new Map(changed.map((s) => [s.id, s]));
    report.setData({ ...r, suggestions: r.suggestions.map((x) => byId.get(x.id) ?? x) });
  };
  const setTab = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === "suggestions") next.delete("tab");
    else next.set("tab", id);
    setParams(next, { replace: true });
  };

  const content = (id: WorkbenchTab) => {
    switch (id) {
      case "suggestions":
        return report.loading && !r ? (
          <LoadingState label="Loading internal-link suggestions…" />
        ) : report.error ? (
          <ErrorState error={report.error} onRetry={report.reload} />
        ) : r ? (
          <SuggestionsTab report={r} projectId={projectId} base={base} onChange={replaceSuggestions} />
        ) : null;
      case "clusters":
        return <ClustersTab base={base} />;
      case "graph":
        return <GraphTab base={base} />;
      case "broken":
        return <BrokenTab base={base} />;
      case "anchors":
        return <AnchorsTab base={base} />;
      case "placed":
        return <PlacedTab base={base} projectId={projectId} />;
    }
  };

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Internal links"
        description="Your full-site internal link graph from the latest snapshot of every crawled page: suggestions sorted by Search Console priority, hubs and clusters, broken and redirected links, anchor text, and the links you placed, verified by the next crawl."
        actions={
          <>
            {r && <StateBadge state={r.state} />}
            <Button onClick={() => void rebuild()} loading={rebuilder.loading} disabled={!projectId} title="Rebuild the link graph from stored crawl snapshots (no paid calls)">
              {rebuilder.loading ? "Rebuilding…" : "Rebuild graph"}
            </Button>
            <Button variant="primary" onClick={() => void run()} loading={runner.loading} disabled={!projectId}>
              {runner.loading ? "Analysing…" : r?.generatedAt ? "Run again" : "Run analysis"}
            </Button>
          </>
        }
      />

      <div role="note" aria-label="How to read these suggestions" className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
        <p className="font-semibold">{LINK_LABEL_REVIEW}</p>
        <p className="mt-1">{LINK_LABEL_CONFIDENCE}</p>
      </div>

      {runner.error ? <ActionError error={runner.error} title="Could not run the analysis" /> : null}
      {rebuilder.error ? <ActionError error={rebuilder.error} title="Could not rebuild the graph" /> : null}
      <CoverageStrip graph={r?.graph ?? null} />

      <Tabs label="Internal links views" value={tab} onChange={setTab} tabs={WORKBENCH_TABS.map((t) => ({ id: t.id, label: t.label, content: content(t.id) }))} />
    </div>
  );
}

function ActionError({ error, title }: { error: unknown; title: string }) {
  if (error instanceof ApiError && error.status === 409) return <StateBanner state="running" title="Already running" message={errorMessage(error)} />;
  if (error instanceof ApiError && error.status === 429) return <StateBanner state="rate_limited" message={errorMessage(error)} />;
  return <ErrorState error={error} title={title} />;
}
