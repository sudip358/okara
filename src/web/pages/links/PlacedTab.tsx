/**
 * Placed & verified tab: links you accepted or marked implemented and links your imported sheet says are placed, each
 * checked after crawls against the latest snapshot of the source page ("verified on <date>" / "not found in crawl of
 * <date>" / pending). Sheet imports and reference tables stay on the Import page.
 */
import { Link } from "react-router";
import type { PlacedLinksReport } from "@shared/types";
import { formatNumber } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { projectPath } from "@web/lib/project-context";
import { PlacedLinksPanel } from "@web/pages/import/ImportedPanels";
import { Badge, Card, EmptyState, ErrorState, LoadingState, MetricTile, StateBanner, TBody, TD, TH, THead, TR, Table, buttonClass } from "@web/components/ui";
import { exportHref, shortUrl } from "./lib";
import { MethodNotes, UrlText, VerificationBadge } from "./parts";

const ORIGIN_LABEL: Record<"implemented" | "accepted" | "sheet", string> = { implemented: "Implemented", accepted: "Accepted", sheet: "From your sheet" };

export function PlacedTab({ base, projectId }: { base: string; projectId: string }) {
  const report = useApi<PlacedLinksReport>(`${base}/placed`);
  if (report.loading && !report.data) return <LoadingState label="Loading placed links…" />;
  if (report.error) return <ErrorState error={report.error} onRetry={report.reload} />;
  return report.data ? <PlacedView report={report.data} base={base} projectId={projectId} /> : null;
}

export function PlacedView({ report: r, base, projectId }: { report: PlacedLinksReport; base: string; projectId: string }) {
  return (
    <div className="space-y-4">
      <Card
        title="Placed and verified"
        description="Each link is checked when the source page is next crawled."
        actions={
          r.rows.length > 0 ? (
            <a href={exportHref(base, "sheet", { userStatus: ["accepted", "implemented"] })} download className={buttonClass("secondary", "sm")}>
              Export sheet format
            </a>
          ) : null
        }
      >
        {r.state === "setup_required" && <StateBanner state="setup_required" className="mb-3" message="Verify your site first; links are verified against crawls of your verified site." />}
        {r.state === "demo" && <StateBanner state="demo" className="mb-3" message="Demo data – fictional pages." />}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <MetricTile label="Links" value={formatNumber(r.counts.total)} />
          <MetricTile label="Verified" value={formatNumber(r.counts.verified)} />
          <MetricTile label="Not found" value={formatNumber(r.counts.notFound)} sublabel="In the latest crawl of the source" />
          <MetricTile label="Pending crawl" value={formatNumber(r.counts.pending + r.counts.notChecked)} />
          <MetricTile label="Source unavailable" value={formatNumber(r.counts.sourceUnavailable)} />
        </div>
        <div className="mt-3">
          <MethodNotes notes={r.labels} title="How links are verified" />
        </div>
        <div className="mt-3">
          {r.rows.length === 0 ? (
            <EmptyState title="No placed links yet.">
              Accept or mark suggestions implemented, or import your sheet of placed links on the <Link to={projectPath(projectId, "import")}>Import page</Link>.
            </EmptyState>
          ) : (
            <Table caption="Placed links and their verification">
              <THead>
                <TR>
                  <TH>Source page</TH>
                  <TH>Target and anchor</TH>
                  <TH>Origin</TH>
                  <TH>Method · hub</TH>
                  <TH>Verification</TH>
                </TR>
              </THead>
              <TBody>
                {r.rows.map((x) => (
                  <TR key={x.key}>
                    <TD className="min-w-48 max-w-xs break-all text-xs">
                      <UrlText url={x.sourceUrl} />
                    </TD>
                    <TD className="min-w-48 max-w-xs text-xs">
                      <p className="break-all">
                        <UrlText url={x.targetUrl} />
                      </p>
                      {x.anchor && <p className="mt-0.5 font-medium">“{x.anchor}”</p>}
                    </TD>
                    <TD className="text-xs">
                      <div className="flex flex-wrap gap-1">
                        {x.origins.map((o) => (
                          <Badge key={o} tone={o === "sheet" ? "neutral" : "info"}>
                            {ORIGIN_LABEL[o]}
                          </Badge>
                        ))}
                      </div>
                      {x.placedOn && <p className="mt-0.5 text-zinc-500">since {x.placedOn}</p>}
                    </TD>
                    <TD className="text-xs">
                      {x.method ?? "—"}
                      {x.hub ? ` · ${shortUrl(x.hub)}` : ""}
                    </TD>
                    <TD className="min-w-40 text-xs">
                      <VerificationBadge v={x.verification} />
                      {x.verification.detail && <p className="mt-0.5 break-words text-zinc-600 dark:text-zinc-400">{x.verification.detail}</p>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </Card>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-zinc-800 dark:text-zinc-200">Sheet imports and reference tables</summary>
        <div className="mt-2">
          <PlacedLinksPanel projectId={projectId} />
        </div>
      </details>
    </div>
  );
}
