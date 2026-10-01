/**
 * [A23] SEO · Buyer queries (GET /projects/:pid/seo/buyer-queries): non-brand Search Console queries that
 * Jev judged are typed by someone looking to buy, hire, or compare options before buying. Flag rows are
 * shown with "Check this yourself". Without a TypeSafe key the view is "Setup required" and nothing is
 * guessed. Query text and URLs are untrusted and render as plain text.
 * The GET shows cached judgments only; "Classify with Jev" (POST, spends budget) asks for the next batch
 * (up to 500 queries per request). Progress is shown as "classified N of M" from completeness; the
 * full Search Console export is worked through across requests within the daily Jev budget.
 */
import { Link } from "react-router";
import type { BuyerQueryRow, CoverageResponse, DemandSegment } from "@shared/types";
import { formatNumber } from "@web/lib/format";
import { api, errorMessage } from "@web/lib/api";
import { useApi, useMutation } from "@web/lib/hooks";
import { projectPath } from "@web/lib/project-context";
import { Badge, TBody, TD, TH, THead, TR, Table, TierBadge, buttonClass } from "@web/components/ui";
import { CoverageCard, Detail, UrlText, useOwnHosts } from "./PageAuditTable";
import { buyerProgress } from "../lib";

const INTENT_LABEL: Record<BuyerQueryRow["intent"], string> = {
  transactional: "Ready to buy (transactional)",
  commercial_investigation: "Comparing options (commercial investigation)",
};

const SEGMENT_LABEL: Record<DemandSegment, string> = { head: "Head", middle: "Middle", long_tail: "Long tail" };

export function BuyerQueriesTable({ projectId }: { projectId: string }) {
  const own = useOwnHosts();
  const path = projectId ? `/projects/${encodeURIComponent(projectId)}/seo/buyer-queries` : null;
  const state = useApi<CoverageResponse<BuyerQueryRow>>(path);
  const classify = useMutation(() => api<CoverageResponse<BuyerQueryRow>>(path!, { method: "POST" }));
  const progress = buyerProgress(state.data);
  const onClassify = async () => {
    const next = await classify.run();
    if (next) state.setData(next);
  };
  return (
    <CoverageCard
      title="Buyer queries"
      description={
        <>
          Non-brand queries from your Search Console data that Jev judged are typed by people looking to buy, hire, or compare options. Impressions are your own, not market search volume.
          {state.data?.state === "ready" ? (
            <span className="mt-2 flex flex-wrap items-center gap-2">
              {progress ? (
                <span className="flex items-center gap-2">
                  <progress className="h-2 w-32 accent-sky-600" max={Math.max(1, progress.total)} value={progress.covered} aria-label={progress.label} />
                  <span className="tabular-nums">{progress.label}</span>
                </span>
              ) : null}
              <button type="button" className={buttonClass("secondary", "sm")} onClick={onClassify} disabled={classify.loading || progress?.done === true}>
                {classify.loading ? "Classifying…" : progress?.done ? "All classified" : progress && progress.covered > 0 ? "Classify next batch" : "Classify with Jev"}
              </button>
              <span>Asks Jev about up to 500 queries without a cached answer per click; uses your daily Jev budget.</span>
              {classify.error ? <span role="alert" className="text-red-700 dark:text-red-400">{errorMessage(classify.error)}</span> : null}
            </span>
          ) : null}
        </>
      }
      state={state}
      emptyTitle="No buyer queries found in the classified queries."
      setupHint={
        <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
          Add a TypeSafe key in Integrations
        </Link>
      }
    >
      {(d) => (
        <Table caption="Buyer queries">
          <THead>
            <TR>
              <TH>Query</TH>
              <TH>Intent</TH>
              <TH>Jev</TH>
              <TH className="text-right">Impressions</TH>
              <TH className="text-right">Clicks</TH>
              <TH className="text-right">Position</TH>
              <TH>Top page</TH>
              <TH>Segment</TH>
            </TR>
          </THead>
          <TBody>
            {d.rows.map((r) => (
              <TR key={r.query}>
                <TD className="min-w-40 max-w-64 break-words text-sm">{r.query}</TD>
                <TD className="min-w-36">
                  <Badge tone={r.intent === "transactional" ? "info" : "neutral"}>{INTENT_LABEL[r.intent]}</Badge>
                </TD>
                <TD className="min-w-28">
                  <TierBadge tier={r.intentTier} />
                </TD>
                <TD className="text-right tabular-nums">{formatNumber(r.impressions)}</TD>
                <TD className="text-right tabular-nums">{formatNumber(r.clicks)}</TD>
                <TD className="text-right tabular-nums">
                  {r.position === null ? "—" : r.position.toFixed(1)}
                  <Detail>approx.</Detail>
                </TD>
                <TD className="min-w-40 max-w-64">{r.topPage ? <UrlText url={r.topPage} own={own} /> : <span className="text-xs text-zinc-500 dark:text-zinc-400">Not in data</span>}</TD>
                <TD className="text-xs">{r.segment ? SEGMENT_LABEL[r.segment] : "—"}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </CoverageCard>
  );
}
