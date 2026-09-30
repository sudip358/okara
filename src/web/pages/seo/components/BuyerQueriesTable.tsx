/**
 * [A23] SEO · Buyer queries (GET /projects/:pid/seo/buyer-queries): non-brand Search Console queries that
 * Jev judged are typed by someone looking to buy, hire, or compare options before buying. Flag rows are
 * shown with "Check this yourself". Without a TypeSafe key the view is "Setup required" and nothing is
 * guessed. Query text and URLs are untrusted and render as plain text.
 */
import { Link } from "react-router";
import type { BuyerQueryRow, CoverageResponse, DemandSegment } from "@shared/types";
import { formatNumber } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { projectPath } from "@web/lib/project-context";
import { Badge, TBody, TD, TH, THead, TR, Table, TierBadge, buttonClass } from "@web/components/ui";
import { CoverageCard, Detail, UrlText, useOwnHosts } from "./PageAuditTable";

const INTENT_LABEL: Record<BuyerQueryRow["intent"], string> = {
  transactional: "Ready to buy (transactional)",
  commercial_investigation: "Comparing options (commercial investigation)",
};

const SEGMENT_LABEL: Record<DemandSegment, string> = { head: "Head", middle: "Middle", long_tail: "Long tail" };

export function BuyerQueriesTable({ projectId }: { projectId: string }) {
  const own = useOwnHosts();
  const state = useApi<CoverageResponse<BuyerQueryRow>>(projectId ? `/projects/${encodeURIComponent(projectId)}/seo/buyer-queries` : null);
  return (
    <CoverageCard
      title="Buyer queries"
      description="Non-brand queries from your Search Console data that Jev judged are typed by people looking to buy, hire, or compare options. Impressions are your own, not market search volume."
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
