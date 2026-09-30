/** Crawled pages with page type + classification method and a user correction control. */
import { useState } from "react";
import { Link } from "react-router";
import type { PageRow, PageType } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { formatDateTime, formatNumber } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { Badge, Card, EmptyState, TBody, TD, TH, THead, TR, Table, inputClass } from "@web/components/ui";
import { PAGE_TYPES, PAGE_TYPE_LABEL } from "../lib";

export function PagesTable({ projectId, pages, onChanged }: { projectId: string; pages: PageRow[]; onChanged: (p: PageRow) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; msg: string } | null>(null);

  const correct = async (row: PageRow, pageType: PageType) => {
    setBusy(row.id);
    setError(null);
    try {
      const updated = await api<PageRow | null>(`/projects/${encodeURIComponent(projectId)}/pages/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        body: { pageType },
      });
      onChanged(updated && typeof updated === "object" && "id" in updated ? updated : { ...row, pageType, pageTypeMethod: "user" });
    } catch (e) {
      setError({ id: row.id, msg: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Crawled pages" description="Page type is inferred from URL patterns, JSON-LD types, and sitemap membership. Correct it if it is wrong.">
      {pages.length === 0 ? (
        <EmptyState title="No pages crawled yet." />
      ) : (
        <Table caption="Crawled pages">
          <THead>
            <TR>
              <TH>URL</TH>
              <TH>Status</TH>
              <TH>Title</TH>
              <TH>Words</TH>
              <TH>Page type</TH>
              <TH>Method</TH>
              <TH>Crawled</TH>
              <TH>
                <span className="sr-only">On-page checklist</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {pages.map((p) => (
              <TR key={p.id}>
                <TD className="min-w-48 max-w-xs break-all text-xs">{p.url}</TD>
                <TD className="whitespace-nowrap text-xs">
                  {p.skippedReason ? (
                    <Badge tone="warning" title={p.skippedReason}>
                      Skipped
                    </Badge>
                  ) : p.statusCode === null ? (
                    "—"
                  ) : (
                    <Badge tone={p.statusCode >= 400 ? "danger" : p.statusCode >= 300 ? "warning" : "neutral"}>{p.statusCode}</Badge>
                  )}
                  {p.skippedReason && <p className="mt-0.5 text-zinc-500 dark:text-zinc-400">{p.skippedReason}</p>}
                </TD>
                <TD className="min-w-40 max-w-xs break-words text-xs">{p.title ?? <span className="text-zinc-500">No title</span>}</TD>
                <TD className="whitespace-nowrap text-xs tabular-nums">{formatNumber(p.wordCount)}</TD>
                <TD>
                  <label className="sr-only" htmlFor={`pt-${p.id}`}>
                    Page type for {p.url}
                  </label>
                  <select
                    id={`pt-${p.id}`}
                    value={p.pageType}
                    disabled={busy === p.id}
                    onChange={(e) => void correct(p, e.target.value as PageType)}
                    className={`${inputClass} min-w-36 py-1 text-xs`}
                  >
                    {PAGE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {PAGE_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                  {error?.id === p.id && (
                    <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
                      {error.msg}
                    </p>
                  )}
                </TD>
                <TD className="whitespace-nowrap text-xs text-zinc-600 dark:text-zinc-400">{p.pageTypeMethod}</TD>
                <TD className="whitespace-nowrap text-xs text-zinc-600 dark:text-zinc-400">{formatDateTime(p.lastCrawledAt)}</TD>
                <TD className="whitespace-nowrap text-xs">
                  <Link to={projectPath(projectId, `pages/${encodeURIComponent(p.id)}/checklist`)} className="text-sky-800 underline dark:text-sky-300" aria-label={`On-page checklist for ${p.url}`}>
                    Checklist
                  </Link>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
