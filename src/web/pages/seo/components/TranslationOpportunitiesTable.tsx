/**
 * [A25] SEO · Translation opportunities (GET /projects/:pid/seo/translation-opportunities): countries
 * outside your locale's country with a meaningful share of your Search Console impressions. This is
 * demand from those markets, not a promise of rankings. Served language is unknown until the crawler
 * stores hreflang/lang. URLs and notes render as plain text.
 */
import type { CoverageResponse, TranslationOpportunityRow } from "@shared/types";
import { formatNumber, formatRatio } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { Badge, TBody, TD, TH, THead, TR, Table } from "@web/components/ui";
import { CoverageCard, Detail, UrlText, useOwnHosts } from "./PageAuditTable";

function served(v: boolean | null) {
  if (v === null) return <Badge tone="neutral">Unknown</Badge>;
  return v ? <Badge tone="success">Served</Badge> : <Badge tone="warning">Not served</Badge>;
}

export function TranslationOpportunitiesTable({ projectId }: { projectId: string }) {
  const own = useOwnHosts();
  const state = useApi<CoverageResponse<TranslationOpportunityRow>>(projectId ? `/projects/${encodeURIComponent(projectId)}/seo/translation-opportunities` : null);
  return (
    <CoverageCard
      title="Translation opportunities"
      description="Countries outside your locale's country where your pages already earn a meaningful share of Search Console impressions. Demand from those markets, not a promise of rankings or traffic."
      state={state}
      emptyTitle="No other country meets the threshold."
      setupHint="Country data arrives with the next Search Console API sync."
    >
      {(d) => (
        <Table caption="Translation opportunities">
          <THead>
            <TR>
              <TH>Country</TH>
              <TH className="text-right">Impressions</TH>
              <TH className="text-right">Clicks</TH>
              <TH>Share of impressions</TH>
              <TH>Top pages</TH>
              <TH>Your language for this market</TH>
            </TR>
          </THead>
          <TBody>
            {d.rows.map((r) => (
              <TR key={r.country}>
                <TD className="min-w-32">
                  <span className="font-mono text-xs uppercase">{r.country}</span>
                  <Detail>{r.note}</Detail>
                </TD>
                <TD className="text-right tabular-nums">{formatNumber(r.impressions)}</TD>
                <TD className="text-right tabular-nums">{formatNumber(r.clicks)}</TD>
                <TD className="min-w-36 text-xs tabular-nums">{formatRatio(r.shareOfImpressions, "impressions")}</TD>
                <TD className="min-w-44 max-w-72">
                  {r.topPages.length === 0 ? (
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">Not in data</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {r.topPages.map((u) => (
                        <li key={u}>
                          <UrlText url={u} own={own} />
                        </li>
                      ))}
                    </ul>
                  )}
                </TD>
                <TD>{served(r.servedLanguage)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </CoverageCard>
  );
}
