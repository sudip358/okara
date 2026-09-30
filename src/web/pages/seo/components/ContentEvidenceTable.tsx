/**
 * [A22] SEO · Content evidence for your own pages: depth (word count), proof (outbound sources, tables),
 * freshness (last-updated date in the HTML), Search Console impressions/clicks, and the computed priority
 * (GET /projects/:pid/seo/content-evidence). No competitor columns: competitor pages are never crawled
 * automatically. Priority is a ranking signal from stored metrics, never a traffic projection.
 */
import type { ContentEvidenceRow, CoverageResponse } from "@shared/types";
import { formatDate, formatNumber, formatWindow } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { Badge, TBody, TD, TH, THead, TR, Table, type BadgeTone } from "@web/components/ui";
import { PAGE_TYPE_LABEL } from "../lib";
import { CellChip, CoverageCard, Detail, UrlText, useOwnHosts } from "./PageAuditTable";

const PROOF_META: Record<ContentEvidenceRow["proof"]["status"], { label: string; tone: BadgeTone }> = {
  present: { label: "Present", tone: "success" },
  missing: { label: "Missing", tone: "danger" },
  unknown: { label: "Unknown", tone: "neutral" },
};

const PRIORITY_TONE: Record<"high" | "medium" | "low", BadgeTone> = { high: "warning", medium: "info", low: "neutral" };

function isParseableDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(new Date(v).getTime());
}

export function ContentEvidenceTable({ projectId }: { projectId: string }) {
  const own = useOwnHosts();
  const state = useApi<CoverageResponse<ContentEvidenceRow>>(projectId ? `/projects/${encodeURIComponent(projectId)}/seo/content-evidence` : null);
  return (
    <CoverageCard
      title="Content evidence"
      description="Depth, proof, and freshness of your own pages from the latest crawl, with Search Console impressions for the stated window. Competitor columns appear only for competitor URLs you approve."
      state={state}
      emptyTitle="No analysable pages in the latest crawl."
      setupHint="Verify your site and run a crawl first."
    >
      {(d) => (
        <Table caption="Content evidence">
          <THead>
            <TR>
              <TH>Page</TH>
              <TH>Depth</TH>
              <TH>Proof</TH>
              <TH>Freshness</TH>
              <TH>Search Console</TH>
              <TH>Priority</TH>
            </TR>
          </THead>
          <TBody>
            {d.rows.map((r) => {
              const proof = PROOF_META[r.proof.status];
              return (
                <TR key={r.pageId}>
                  <TD className="min-w-44 max-w-64">
                    <UrlText url={r.url} own={own} />
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{PAGE_TYPE_LABEL[r.pageType] ?? r.pageType}</p>
                  </TD>
                  <TD className="min-w-24">
                    <CellChip status={r.depth.status} />
                    <Detail>{r.depth.wordCount === null ? "Word count not recorded" : `${formatNumber(r.depth.wordCount)} words`}</Detail>
                  </TD>
                  <TD className="min-w-28">
                    <Badge tone={proof.tone}>{proof.label}</Badge>
                    <Detail>
                      {r.proof.outboundCitations === null ? "Sources not recorded" : `${formatNumber(r.proof.outboundCitations)} outbound source link(s)`}
                      {" · "}
                      {r.proof.tables === null ? "tables not recorded" : `${formatNumber(r.proof.tables)} table(s)`}
                    </Detail>
                  </TD>
                  <TD className="min-w-28">
                    <CellChip status={r.freshness.status} />
                    <Detail>
                      {r.freshness.lastUpdated === null
                        ? "No last-updated date found"
                        : isParseableDate(r.freshness.lastUpdated)
                          ? `${formatDate(r.freshness.lastUpdated)}${r.freshness.ageDays !== null ? ` (${formatNumber(r.freshness.ageDays)} days)` : ""}`
                          : `Unreadable date: ${r.freshness.lastUpdated}`}
                    </Detail>
                  </TD>
                  <TD className="min-w-32 text-xs">
                    {r.gsc.window === null ? (
                      <Badge tone="neutral">No Search Console data</Badge>
                    ) : (
                      <>
                        <p className="tabular-nums">
                          {formatNumber(r.gsc.impressions)} impressions · {formatNumber(r.gsc.clicks)} clicks
                        </p>
                        <Detail>{formatWindow(r.gsc.window)}</Detail>
                      </>
                    )}
                  </TD>
                  <TD className="min-w-40">
                    {r.priority.value === null || r.priority.label === null ? (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">Not computed</span>
                    ) : (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <Badge tone={PRIORITY_TONE[r.priority.label]} title={r.priority.version ?? undefined}>
                          {r.priority.label}
                        </Badge>
                        <span className="text-xs tabular-nums">{r.priority.value.toFixed(1)}</span>
                      </span>
                    )}
                    <Detail>{r.priority.basis}</Detail>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </CoverageCard>
  );
}
