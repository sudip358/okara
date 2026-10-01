/**
 * D · Pages to rewrite (design §6). A read-only manual checklist with measured evidence; GSC clicks and
 * impressions and stored AI citations as measured (never projected). Publishing is manual: no "Publish".
 */
import { Link } from "react-router";
import type { RewritePlan } from "@shared/types";
import { formatNumber, formatWindow } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { Badge, cx } from "@web/components/ui";
import { ExternalUrl } from "@web/components/ExternalUrl";
import { LABELS, PLAN_ITEM_STATUS, engineName, methodLabel, planItemLabel, planProgress } from "./lib";

export function RewritePlanCard({ plan, projectId }: { plan: RewritePlan; projectId: string }) {
  return (
    <article className="min-w-0 space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <ExternalUrl url={plan.url} />
      <p className="break-words text-sm font-semibold text-zinc-900 dark:text-zinc-100">{plan.question}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
        <span>{plan.engine ? engineName(plan.engine) : "All engines"}</span>
        <span aria-hidden="true">·</span>
        <span>{planProgress(plan.items)}</span>
      </div>
      <ul className="min-w-0 space-y-1" aria-label="Rewrite checklist">
        {plan.items.map((it) => {
          const st = PLAN_ITEM_STATUS[it.status];
          return (
            <li key={it.key} className="flex min-w-0 gap-2 text-xs">
              <span
                aria-hidden="true"
                className={cx(
                  "w-4 shrink-0 text-center font-semibold",
                  it.status === "done" ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500 dark:text-zinc-400",
                )}
              >
                {st.glyph}
              </span>
              <div className="min-w-0">
                <p className="break-words text-zinc-900 dark:text-zinc-100">
                  <span className="sr-only">{st.label}: </span>
                  {planItemLabel(it)}
                </p>
                <p className="break-words text-[11px] text-zinc-600 dark:text-zinc-400">
                  {[it.evidence ?? (it.method === "manual" ? null : "No evidence recorded"), methodLabel(it.method)]
                    .filter((x, i, arr): x is string => x !== null && arr.indexOf(x) === i)
                    .join(" · ")}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      <dl className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-[11px] text-zinc-600 dark:text-zinc-400">Google Search Console</dt>
          <dd className="text-zinc-900 dark:text-zinc-100">
            {plan.gsc ? (
              <>
                Clicks {formatNumber(plan.gsc.clicks)} · Impressions {formatNumber(plan.gsc.impressions)}
                <span className="block text-[11px] text-zinc-600 dark:text-zinc-400">{formatWindow(plan.gsc.window)}</span>
              </>
            ) : (
              "GSC not connected"
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] text-zinc-600 dark:text-zinc-400">AI citations</dt>
          <dd className="text-zinc-900 dark:text-zinc-100">
            {plan.aiCitations ? (
              <>
                Cited in {formatNumber(plan.aiCitations.count)} stored answer{plan.aiCitations.count === 1 ? "" : "s"}
                <span className="block text-[11px] text-zinc-600 dark:text-zinc-400">{formatWindow(plan.aiCitations.window)}</span>
              </>
            ) : (
              "No GEO data"
            )}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {plan.recommendationId && <Link to={projectPath(projectId, `recommendations/${encodeURIComponent(plan.recommendationId)}`)}>Open recommendation</Link>}
        <Link to={projectPath(projectId, "draft-check")}>Draft check</Link>
      </div>
    </article>
  );
}

export function RewritePlansBody({ plans, projectId }: { plans: RewritePlan[]; projectId: string }) {
  return (
    <div className="min-w-0 space-y-2">
      <Badge tone="neutral" className="whitespace-normal">
        {LABELS.manualPlan}
      </Badge>
      {plans.length === 0 ? (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">No rewrite plan for this engine yet. Plans appear for pages with an open GEO recommendation or an “Adapt” assessment.</p>
      ) : (
        plans.map((p) => <RewritePlanCard key={`${p.pageId}:${p.promptId ?? ""}`} plan={p} projectId={projectId} />)
      )}
    </div>
  );
}
