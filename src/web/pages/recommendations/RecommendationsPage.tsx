/**
 * Recommendations list: SEO | GEO tabs, status filter, [A2] cards with quick status actions.
 * Route: /projects/:projectId/recommendations
 */
import { useState } from "react";
import { useParams, useSearchParams } from "react-router";
import type { AgentKind, Recommendation, RecommendationStatus } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { useApi } from "@web/lib/hooks";
import { EmptyState, ErrorState, LoadingState, PageHeader, SelectField, StateBanner, Tabs } from "@web/components/ui";
import { RecommendationCard } from "./components/RecommendationCard";
import { STATUSES, STATUS_LABEL } from "./lib";

function isAgent(v: string | null): v is AgentKind {
  return v === "seo" || v === "geo";
}
function isStatus(v: string | null): v is RecommendationStatus {
  return v === "open" || v === "approved" || v === "dismissed" || v === "implemented";
}

export function RecommendationsPage() {
  const { projectId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const agentParam = params.get("agent");
  const statusParam = params.get("status");
  const agent: AgentKind = isAgent(agentParam) ? agentParam : "seo";
  const status: RecommendationStatus = isStatus(statusParam) ? statusParam : "open";

  const update = (next: { agent?: AgentKind; status?: RecommendationStatus }) => {
    const p = new URLSearchParams(params);
    p.set("agent", next.agent ?? agent);
    p.set("status", next.status ?? status);
    setParams(p, { replace: true });
  };

  return (
    <div className="min-w-0">
      <PageHeader
        title="Recommendations"
        description="Evidence-backed proposals from the SEO and GEO agents. Approving records your decision only; nothing is published to your site."
      />
      <Tabs
        label="Agent"
        value={agent}
        onChange={(id) => update({ agent: id as AgentKind })}
        tabs={[
          { id: "seo", label: "SEO", content: <RecommendationList projectId={projectId} agent="seo" status={status} onStatus={(s) => update({ status: s })} /> },
          { id: "geo", label: "GEO", content: <RecommendationList projectId={projectId} agent="geo" status={status} onStatus={(s) => update({ status: s })} /> },
        ]}
      />
    </div>
  );
}

function RecommendationList({
  projectId,
  agent,
  status,
  onStatus,
}: {
  projectId: string;
  agent: AgentKind;
  status: RecommendationStatus;
  onStatus: (s: RecommendationStatus) => void;
}) {
  const path = projectId
    ? `/projects/${encodeURIComponent(projectId)}/recommendations?agent=${agent}&status=${status}`
    : null;
  const { data, error, loading, reload, setData } = useApi<Recommendation[]>(path);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const changeStatus = async (rec: Recommendation, next: RecommendationStatus) => {
    setBusyId(rec.id);
    setActionError(null);
    setNotice(null);
    try {
      await api<unknown>(`/recommendations/${encodeURIComponent(rec.id)}`, { method: "PATCH", body: { status: next } });
      // Remove from the current filtered view; it now lives under a different status filter.
      if (next !== status && data) setData(data.filter((r) => r.id !== rec.id));
      else reload();
      setNotice(
        next === "approved"
          ? "Approved. Implement the change on your site yourself; publishing is not connected."
          : next === "implemented"
            ? "Marked implemented. Any outcome will only be shown after a measured post-change window."
            : next === "dismissed"
              ? "Dismissed. It will stay dismissed on future runs."
              : "Reopened.",
      );
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const filterId = `rec-status-${agent}`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-full sm:w-56">
          <SelectField id={filterId} label="Status" value={status} onChange={(e) => onStatus(e.target.value as RecommendationStatus)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </SelectField>
        </div>
        {data && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400" aria-live="polite">
            {data.length} {STATUS_LABEL[status].toLowerCase()} {agent.toUpperCase()} recommendation{data.length === 1 ? "" : "s"}
          </p>
        )}
      </div>

      {notice && <StateBanner state="completed" title="Saved" message={notice} />}
      {actionError && <StateBanner state="failed" title="Could not update" message={actionError} />}

      {loading && !data ? (
        <LoadingState label="Loading recommendations…" />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data || data.length === 0 ? (
        status === "open" ? (
          <EmptyState title="No new verified opportunities today.">
            The {agent.toUpperCase()} agent emits zero to two evidence-backed recommendations per day, only when the evidence supports them.
          </EmptyState>
        ) : (
          <EmptyState title={`No ${STATUS_LABEL[status].toLowerCase()} ${agent.toUpperCase()} recommendations.`} />
        )
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((rec) => (
            <RecommendationCard
              key={rec.id}
              rec={rec}
              projectId={projectId}
              busy={busyId === rec.id}
              onStatus={(s) => void changeStatus(rec, s)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
