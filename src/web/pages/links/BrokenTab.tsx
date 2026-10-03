/**
 * Broken links tab: internal links whose target redirected (with every hop and the final URL) or returned 4xx/5xx in
 * its latest snapshot, with the source page, the anchor, and the fix. CSV export of every listed link.
 */
import type { BrokenLinksReport } from "@shared/types";
import { formatDate, formatNumber } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { Badge, Card, EmptyState, ErrorState, LoadingState, MetricTile, StateBanner, TBody, TD, TH, THead, TR, Table, buttonClass } from "@web/components/ui";
import { KIND_LABEL, chainText, issueLabel, issueTone, shortUrl } from "./lib";
import { MethodNotes, UrlText } from "./parts";

export function BrokenTab({ base }: { base: string }) {
  const report = useApi<BrokenLinksReport>(`${base}/broken`);
  if (report.loading && !report.data) return <LoadingState label="Loading broken and redirected links…" />;
  if (report.error) return <ErrorState error={report.error} onRetry={report.reload} />;
  return report.data ? <BrokenView report={report.data} base={base} /> : null;
}

export function BrokenView({ report: r, base }: { report: BrokenLinksReport; base: string }) {
  if (r.state === "setup_required") return <StateBanner state="setup_required" message={r.labels.join(" ")} />;
  const errors = r.rows.filter((x) => x.issue !== "redirect").length;
  return (
    <Card
      title="Broken and redirected links"
      description="Fix the link on the source page: point it at the final URL, or remove or replace it."
      actions={
        r.rows.length > 0 ? (
          <a href={`/api${base}/broken?format=csv`} download className={buttonClass("secondary", "sm")}>
            Export CSV
          </a>
        ) : null
      }
    >
      {r.state === "demo" && <StateBanner state="demo" className="mb-3" message="Demo data – fictional pages." />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricTile label="Links listed" value={formatNumber(r.rows.length)} sublabel={r.truncated ? "partial list" : undefined} />
        <MetricTile label="To errors (4xx/5xx)" value={formatNumber(errors)} />
        <MetricTile label="To redirects" value={formatNumber(r.rows.length - errors)} />
        <MetricTile label="Not checked yet" value={formatNumber(r.unchecked)} sublabel="Linked URLs not crawled yet" />
      </div>
      <div className="mt-3">
        <MethodNotes notes={r.labels} title="What is checked" />
      </div>
      <div className="mt-3">
        {r.rows.length === 0 ? (
          <EmptyState title={r.graphId ? "No broken or redirected internal links in the analysed pages." : "No link graph yet."} />
        ) : (
          <Table caption="Broken and redirected internal links">
            <THead>
              <TR>
                <TH>Source page and anchor</TH>
                <TH>Current target</TH>
                <TH>Status</TH>
                <TH>Fix</TH>
              </TR>
            </THead>
            <TBody>
              {r.rows.map((x, i) => (
                <TR key={`${x.sourceUrl}|${x.targetUrl}|${i}`}>
                  <TD className="min-w-48 max-w-xs">
                    <p className="break-words font-medium">{x.sourceTitle ?? shortUrl(x.sourceUrl)}</p>
                    <p className="break-all text-xs">
                      <UrlText url={x.sourceUrl} />
                    </p>
                    <p className="mt-1 text-xs">
                      {x.anchor ? <span className="font-medium">“{x.anchor}”</span> : <span className="text-zinc-500">no anchor recorded</span>}{" "}
                      <Badge tone="neutral">{KIND_LABEL[x.kind]}</Badge>
                    </p>
                    {x.kind === "navigation" && x.linkedFrom > 10 && <p className="text-xs text-zinc-600 dark:text-zinc-400">Linked from {formatNumber(x.linkedFrom)} pages: likely a navigation or template link (fix it once in the theme).</p>}
                  </TD>
                  <TD className="min-w-48 max-w-xs break-all text-xs">
                    <UrlText url={x.targetUrl} />
                    {x.chain.length > 0 && <p className="mt-1 text-zinc-600 dark:text-zinc-400">Chain: {chainText(x.chain)}</p>}
                    {x.targetCheckedAt && <p className="text-zinc-500">checked {formatDate(x.targetCheckedAt)}</p>}
                  </TD>
                  <TD className="whitespace-nowrap">
                    <Badge tone={issueTone(x.issue)}>{issueLabel(x.issue, x.statusCode)}</Badge>
                    {x.stale && (
                      <Badge tone="warning" className="ml-1">
                        Stale
                      </Badge>
                    )}
                  </TD>
                  <TD className="min-w-48 max-w-sm break-words text-sm">{x.fix}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </Card>
  );
}
