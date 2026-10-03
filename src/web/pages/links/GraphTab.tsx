/**
 * Link graph tab: one row per URL of the full-site graph (latest snapshot of every crawled page), like the owner's
 * InternalLink_Overview sheet: URL | links in | links out | inbound sources with anchors (expand the row) | outbound
 * targets. Server-side filter, search, sort and paging; CSV export of every row.
 */
import { Fragment, useState } from "react";
import type { LinkGraphFilter, LinkGraphSort, LinkGraphUrlDetail, LinkGraphUrlPage, LinkGraphUrlRow } from "@shared/types";
import { formatDate, formatNumber } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, SelectField, TBody, TD, TH, THead, TR, Table, TextField, buttonClass, cx } from "@web/components/ui";
import {
  ANCHOR_FLAG_LABEL,
  DEFAULT_GRAPH_QUERY,
  GRAPH_FILTER_LABEL,
  GRAPH_SORT_LABEL,
  KIND_LABEL,
  chainText,
  graphQueryString,
  issueLabel,
  issueTone,
  nextSort,
  shortUrl,
  type GraphQuery,
} from "./lib";
import { UrlText } from "./parts";

export function GraphTab({ base, initialFilter }: { base: string; initialFilter?: LinkGraphFilter }) {
  const [q, setQ] = useState<GraphQuery>({ ...DEFAULT_GRAPH_QUERY, filter: initialFilter ?? "all" });
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const page = useApi<LinkGraphUrlPage>(`${base}/graph/urls?${graphQueryString(q)}`);
  const d = page.data;
  const header = (sort: LinkGraphSort, className?: string) => (
    <TH className={className} aria-sort={q.sort === sort ? (q.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 font-medium uppercase hover:underline" onClick={() => setQ((x) => nextSort(x, sort))}>
        {GRAPH_SORT_LABEL[sort]}
        {q.sort === sort ? <span aria-hidden="true">{q.dir === "asc" ? "▲" : "▼"}</span> : null}
      </button>
    </TH>
  );
  return (
    <Card
      title="Link graph"
      description="Every URL the graph knows: links in and out (distinct pages; content links in body text, the rest in navigation or templates), status from its latest snapshot, and its hub. Expand a row for the inbound sources with their anchors and the outbound targets."
      actions={
        <a href={`/api${base}/graph/export`} download className={buttonClass("secondary", "sm")}>
          Export CSV
        </a>
      }
    >
      <form
        className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setQ((x) => ({ ...x, q: search, offset: 0 }));
        }}
      >
        <SelectField id="graph-filter" label="Show" value={q.filter} onChange={(e) => setQ((x) => ({ ...x, filter: e.target.value as LinkGraphFilter, offset: 0 }))}>
          {(Object.keys(GRAPH_FILTER_LABEL) as LinkGraphFilter[]).map((f) => (
            <option key={f} value={f}>
              {GRAPH_FILTER_LABEL[f]}
            </option>
          ))}
        </SelectField>
        <TextField label="Search URL or title" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="chandelier" />
        <Button type="submit" size="sm">
          Search
        </Button>
      </form>
      <div className="mt-3">
        {page.loading && !d ? (
          <LoadingState label="Loading the link graph…" />
        ) : page.error ? (
          <ErrorState error={page.error} onRetry={page.reload} />
        ) : !d || !d.graphId ? (
          <EmptyState title="No link graph yet.">The graph is built after the next crawl, or press Rebuild graph.</EmptyState>
        ) : d.rows.length === 0 ? (
          <EmptyState title="No URLs match." />
        ) : (
          <>
            <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400" aria-live="polite">
              {formatNumber(d.offset + 1)}–{formatNumber(d.offset + d.rows.length)} of {formatNumber(d.total)} URLs
            </p>
            <Table caption="Per-URL internal link table">
              <THead>
                <TR>
                  <TH className="w-8">
                    <span className="sr-only">Expand</span>
                  </TH>
                  {header("url")}
                  {header("links_in", "text-right")}
                  {header("content_links_in", "text-right")}
                  {header("links_out", "text-right")}
                  <TH>Status</TH>
                  {header("fetched_at")}
                  <TH>Hub</TH>
                  {header("impressions", "text-right")}
                </TR>
              </THead>
              <TBody>
                {d.rows.map((row) => (
                  <Fragment key={row.key}>
                    <UrlRow row={row} open={open === row.key} onToggle={() => setOpen((o) => (o === row.key ? null : row.key))} />
                    {open === row.key && (
                      <tr>
                        <td colSpan={9} className="bg-zinc-50 px-2 py-3 dark:bg-zinc-950">
                          <UrlDetail base={base} url={row.url} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </TBody>
            </Table>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <Button size="sm" disabled={d.offset === 0} onClick={() => setQ((x) => ({ ...x, offset: Math.max(0, x.offset - x.limit) }))}>
                Previous
              </Button>
              <label className="flex items-center gap-1 text-xs text-zinc-700 dark:text-zinc-300">
                Rows per page
                <select className="rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950" value={q.limit} onChange={(e) => setQ((x) => ({ ...x, limit: Number(e.target.value), offset: 0 }))}>
                  {[25, 50, 100, 200].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <Button size="sm" disabled={d.offset + d.rows.length >= d.total} onClick={() => setQ((x) => ({ ...x, offset: x.offset + x.limit }))}>
                Next
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

export function UrlRow({ row, open, onToggle }: { row: LinkGraphUrlRow; open: boolean; onToggle: () => void }) {
  return (
    <TR className={cx(open && "bg-zinc-50 dark:bg-zinc-950")}>
      <TD>
        <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${shortUrl(row.url)}`} onClick={onToggle} className="rounded px-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800">
          {open ? "▾" : "▸"}
        </button>
      </TD>
      <TD className="min-w-56 max-w-md">
        <p className="break-words font-medium">{row.title ?? shortUrl(row.url)}</p>
        <p className="break-all text-xs">
          <UrlText url={row.url} />
        </p>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {row.orphan && <Badge tone="warning">Orphan</Badge>}
          {row.isHub && <Badge tone="info">Hub</Badge>}
          {!row.inSitemap && <Badge tone="neutral">Not in sitemap</Badge>}
          {row.noindex && <Badge tone="neutral">noindex</Badge>}
          {row.canonicalUrl && <Badge tone="neutral" title={row.canonicalUrl}>Canonical elsewhere</Badge>}
          {row.anchorFlags.map((f) => (
            <Badge key={f} tone="warning">
              {ANCHOR_FLAG_LABEL[f as keyof typeof ANCHOR_FLAG_LABEL] ?? f}
            </Badge>
          ))}
        </div>
      </TD>
      <TD className="text-right tabular-nums">{formatNumber(row.linksIn)}</TD>
      <TD className="text-right tabular-nums">{formatNumber(row.contentLinksIn)}</TD>
      <TD className="text-right tabular-nums">{formatNumber(row.linksOut)}</TD>
      <TD className="whitespace-nowrap">
        <Badge tone={row.crawled ? issueTone(row.issue) : "neutral"}>{row.crawled ? issueLabel(row.issue, row.statusCode) : "Not crawled"}</Badge>
      </TD>
      <TD className="whitespace-nowrap text-xs">
        {row.fetchedAt ? formatDate(row.fetchedAt) : "—"}
        {row.stale && (
          <Badge tone="warning" className="ml-1">
            Stale
          </Badge>
        )}
      </TD>
      <TD className="max-w-40 break-all text-xs">{row.hubUrl ? shortUrl(row.hubUrl) : "—"}</TD>
      <TD className="text-right tabular-nums">{row.gsc ? formatNumber(row.gsc.impressions) : "—"}</TD>
    </TR>
  );
}

function UrlDetail({ base, url }: { base: string; url: string }) {
  const detail = useApi<LinkGraphUrlDetail>(`${base}/graph/url?url=${encodeURIComponent(url)}`);
  if (detail.loading && !detail.data) return <LoadingState label="Loading links…" />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  const d = detail.data;
  if (!d) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">
          Inbound sources ({formatNumber(d.row.linksIn)}
          {d.inboundShown < d.row.linksIn ? `, ${formatNumber(d.inboundShown)} shown` : ""})
        </h3>
        {d.inbound.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No page in the graph links here.</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {d.inbound.map((i, n) => (
              <li key={`${i.url}|${n}`} className="break-words">
                <UrlText url={i.url} /> {i.anchor ? <span className="font-medium">“{i.anchor}”</span> : <span className="text-zinc-500">(no anchor recorded)</span>}{" "}
                <Badge tone={i.kind === "navigation" ? "neutral" : "info"}>{KIND_LABEL[i.kind]}</Badge>
                {i.via && <Badge tone="neutral">via {i.via}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 space-y-3">
        {d.redirectChain.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Redirect chain</h3>
            <p className="break-all text-sm">{chainText(d.redirectChain)}</p>
          </div>
        )}
        <div>
          <h3 className="text-sm font-semibold">Outbound content links ({formatNumber(d.outbound.length)})</h3>
          {d.outbound.length === 0 ? (
            <p className="text-sm text-zinc-600 dark:text-zinc-400">No content or breadcrumb links recorded on this page.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {d.outbound.map((o) => (
                <li key={o.url} className="break-words">
                  <UrlText url={o.url} /> {o.issue && <Badge tone={issueTone(o.issue)}>{issueLabel(o.issue, o.statusCode)}</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>
        {d.anchors && (
          <div>
            <h3 className="text-sm font-semibold">Anchors pointing here</h3>
            <ul className="mt-1 space-y-0.5 text-sm">
              {d.anchors.top.map((a) => (
                <li key={a.text}>
                  “{a.text}” <span className="text-zinc-500">× {a.sources}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
