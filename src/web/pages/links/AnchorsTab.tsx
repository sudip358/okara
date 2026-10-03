/**
 * Anchors tab: per target page, the anchor texts of content links pointing to it, the exact-match share against its
 * keyword (top Search Console query, else H1), repeated, generic and empty anchors, and anchors missing the page's
 * query terms. Flags come with the threshold they crossed.
 */
import { useState } from "react";
import type { AnchorAuditReport } from "@shared/types";
import { formatNumber } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { Badge, Card, EmptyState, ErrorState, LoadingState, StateBanner } from "@web/components/ui";
import { ANCHOR_FLAG_LABEL, KEYWORD_BASIS_LABEL, pct, shortUrl } from "./lib";
import { MethodNotes, UrlText } from "./parts";

export function AnchorsTab({ base }: { base: string }) {
  const [all, setAll] = useState(false);
  const report = useApi<AnchorAuditReport>(`${base}/anchors${all ? "?all=1" : ""}`);
  return <AnchorsView report={report.data} loading={report.loading} error={report.error} onRetry={report.reload} all={all} onAll={setAll} />;
}

export function AnchorsView({
  report: r,
  loading,
  error,
  onRetry,
  all,
  onAll,
}: {
  report: AnchorAuditReport | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  all: boolean;
  onAll: (v: boolean) => void;
}) {
  const setAll = onAll;
  return (
    <Card
      title="Anchor text audit"
      description="Content links only. Over-used exact-match or identical anchors, generic or empty anchors, and anchors that never use the page's search terms."
      actions={
        <label className="flex items-center gap-1 text-xs text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show unflagged pages too
        </label>
      }
    >
      {loading && !r ? (
        <LoadingState label="Loading the anchor audit…" />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : !r ? null : r.state === "setup_required" ? (
        <StateBanner state="setup_required" message={r.labels.join(" ")} />
      ) : (
        <div className="space-y-3">
          {r.state === "demo" && <StateBanner state="demo" message="Demo data – fictional anchors." />}
          <MethodNotes notes={r.labels} title="Thresholds and method" />
          {r.rows.length === 0 ? (
            <EmptyState title={r.graphId ? (all ? "No anchored content links recorded yet." : "No anchor flags. Every audited page is within the thresholds.") : "No link graph yet."} />
          ) : (
            <>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {formatNumber(r.rows.length)} of {formatNumber(r.total)} pages shown.
              </p>
              <ul className="space-y-3">
                {r.rows.map((a) => {
                  const max = Math.max(1, ...a.top.map((t) => t.sources));
                  return (
                    <li key={a.url} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="break-words font-medium">{a.title ?? shortUrl(a.url)}</p>
                          <p className="break-all text-xs">
                            <UrlText url={a.url} />
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {a.flags.map((f) => (
                            <Badge key={f} tone="warning">
                              {ANCHOR_FLAG_LABEL[f]}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <p className="mt-1 text-xs text-zinc-700 dark:text-zinc-300">
                        {formatNumber(a.anchoredInlinks)} anchored links · {formatNumber(a.distinctAnchors)} distinct anchors
                        {a.keyword ? ` · keyword “${a.keyword}” (${a.keywordBasis ? KEYWORD_BASIS_LABEL[a.keywordBasis] : "basis unknown"}) · exact match ${pct(a.exactMatchShare)}` : ""}
                      </p>
                      {a.reasons.length > 0 && (
                        <ul className="mt-1 list-disc pl-5 text-xs text-zinc-700 dark:text-zinc-300">
                          {a.reasons.map((x, i) => (
                            <li key={i} className="break-words">
                              {x}
                            </li>
                          ))}
                        </ul>
                      )}
                      {a.top.length > 0 && (
                        <ul className="mt-2 space-y-1" aria-label="Most used anchors">
                          {a.top.slice(0, 8).map((t) => (
                            <li key={t.text} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-xs">
                              <div className="min-w-0">
                                <span className="break-words">“{t.text}”</span>
                                <div className="mt-0.5 h-1.5 rounded bg-zinc-100 dark:bg-zinc-800" aria-hidden="true">
                                  <div className="h-1.5 rounded bg-sky-500 dark:bg-sky-400" style={{ width: `${Math.round((t.sources / max) * 100)}%` }} />
                                </div>
                              </div>
                              <span className="tabular-nums text-zinc-600 dark:text-zinc-400">{t.sources}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
