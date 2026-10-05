/**
 * Backlinks (SEO nav, docs/api.md "Backlinks", docs/build-kit.md [A38]): the built links from the owner's master sheet,
 * each checked on the live article for the link to our page and its rel (dofollow / nofollow / sponsored / ugc).
 * Summary tiles, filters, table, CSV export, a detail drawer (check history, redirect chain, changes) with a per-row
 * Recheck, and "Run backlink check" (the section 16 confirm dialog). Every sheet and page string is plain text.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { BACKLINK_STATUSES, MAX_RECHECK_IDS, browserSummaryText, type BacklinkDetail, type BacklinkJobView, type BacklinkFeed, type BacklinkFilterStatus, type BacklinkListResponse, type BacklinkRow, type BacklinkSummary } from "@shared/backlinks";
import { api, errorMessage } from "@web/lib/api";
import { useApi } from "@web/lib/hooks";
import { formatDateTime, formatRelative } from "@web/lib/format";
import { projectPath, useProject } from "@web/lib/project-context";
import { Button, Card, Drawer, EmptyState, ErrorState, LoadingState, MetricTile, PageHeader, SelectField, TextField, buttonClass, cx } from "@web/components/ui";
import { RunActionsProvider, SectionButton } from "@web/pages/live/RunActions";
import { runCheckAction } from "@web/pages/live/backlinks/actions";
import { setBacklinkJob } from "@web/pages/live/backlinks/job-store";
import { DEFAULT_FILTERS, FILTER_LABELS, backlinksBase, browserNote, browserPollInterval, csvHref, jobActive, listQuery, nOfM, progressText, relLabel, rowCheckState, shortDay, targetText, type ListFilters, type RowCheckState } from "./lib";
import { BacklinkHistory, BrowserBadge, ChangeBadge, StatusChip, UrlCell } from "./parts";

const FILTER_STATUSES: BacklinkFilterStatus[] = [...BACKLINK_STATUSES, "unchecked", "target_broken"];

export function filtersFromParams(p: URLSearchParams): ListFilters {
  const status = p.get("status") ?? "";
  const changed = p.get("changed") ?? "";
  return {
    ...DEFAULT_FILTERS,
    status: (FILTER_STATUSES as string[]).includes(status) ? (status as BacklinkFilterStatus) : "",
    vendor: (p.get("vendor") ?? "").slice(0, 120),
    type: (p.get("type") ?? "").slice(0, 80),
    changed: changed === "7" || changed === "30" ? changed : "",
    q: (p.get("q") ?? "").slice(0, 100),
  };
}

export function SummaryTiles({ s }: { s: BacklinkSummary }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="backlink-tiles">
      <MetricTile label="Monitored" value={s.totals.active.toLocaleString("en-US")} sublabel={s.totals.inactive ? `${s.totals.inactive.toLocaleString("en-US")} inactive (removed from sheet)` : "from your sheet"} />
      <MetricTile label="Dofollow" value={nOfM(s.dofollow.n, s.dofollow.m)} sublabel="of pages read (link found or missing)" />
      <MetricTile label="Nofollow / sponsored / ugc" value={(s.byStatus.nofollow + s.byStatus.sponsored + s.byStatus.ugc).toLocaleString("en-US")} />
      <MetricTile label="Missing or broken" value={(s.byStatus.missing + s.byStatus.page_error).toLocaleString("en-US")} sublabel={`${s.byStatus.redirected.toLocaleString("en-US")} redirected · ${s.targetBroken.toLocaleString("en-US")} targets broken`} />
      <MetricTile label="Changes" value={`${s.changes.last7.toLocaleString("en-US")} / ${s.changes.last30.toLocaleString("en-US")}`} sublabel={`last 7 / 30 days · ${s.changes.negative7.toLocaleString("en-US")} losses this week`} />
      <MetricTile
        label="Checks"
        value={jobActive(s.job) ? progressText(s.job) : s.lastCheckAt ? shortDay(s.lastCheckAt) : "Never"}
        sublabel={`${s.nextCheckAt ? `next weekly ${shortDay(s.nextCheckAt)}` : "no weekly check"} · ${s.totals.unchecked.toLocaleString("en-US")} not checked yet`}
      />
      <p className="col-span-full text-xs text-zinc-600 dark:text-zinc-400" data-testid="browser-summary">
        {browserSummaryText(s.browser)}
      </p>
    </div>
  );
}

export function RowCheckCell({ r, state, job, disabledReason, onCheck }: { r: BacklinkRow; state: RowCheckState; job: BacklinkJobView | null | undefined; disabledReason: string | null; onCheck: (r: BacklinkRow) => void }) {
  if (state === "pending") {
    return (
      <Button size="sm" variant="secondary" loading disabled aria-live="polite">
        Checking…
      </Button>
    );
  }
  if (state === "browser") {
    return (
      <Button size="sm" variant="secondary" loading disabled aria-live="polite" title="The plain fetch is stored; this link is re-checked in Cloudflare's headless browser next (within the daily browser budget).">
        Checking in browser…
      </Button>
    );
  }
  if (state === "queued") {
    return (
      <Button size="sm" variant="ghost" disabled title="Waiting for the running check to reach this link" aria-live="polite">
        Queued{job ? ` · ${job.done}/${job.total}` : ""}
      </Button>
    );
  }
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <ChangeBadge text={r.lastChangeText} negative={r.lastChangeNegative} at={r.lastChangeAt} />
      <Button
        size="sm"
        variant={r.lastCheckedAt ? "ghost" : "secondary"}
        disabled={!!disabledReason || !r.active}
        title={disabledReason ?? (!r.active ? "Inactive (removed from sheet)" : undefined)}
        onClick={() => onCheck(r)}
        aria-label={`${r.lastCheckedAt ? "Recheck" : "Check"} ${r.liveUrl}`}
      >
        {r.lastCheckedAt ? "↻ Recheck" : "▶ Check"}
      </Button>
    </div>
  );
}

function BacklinkTable({ rows, onOpen, pending, job, disabledReason, onCheck }: { rows: BacklinkRow[]; onOpen: (r: BacklinkRow) => void; pending: Record<string, string>; job: BacklinkJobView | null | undefined; disabledReason: string | null; onCheck: (r: BacklinkRow) => void }) {
  return (
    <div className="min-w-0 overflow-x-hidden">
      <table className="w-full table-fixed text-sm" data-testid="backlink-table">
        <caption className="sr-only">Monitored backlinks</caption>
        <thead className="text-left text-xs text-zinc-600 dark:text-zinc-400">
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            <th scope="col" className="w-[30%] py-2 pr-2 font-medium sm:w-[22%]">
              Live article
            </th>
            <th scope="col" className="hidden py-2 pr-2 font-medium md:table-cell md:w-[18%]">
              Target
            </th>
            <th scope="col" className="hidden py-2 pr-2 font-medium lg:table-cell">
              Expected anchor
            </th>
            <th scope="col" className="hidden py-2 pr-2 font-medium sm:table-cell">
              Found anchor
            </th>
            <th scope="col" className="hidden py-2 pr-2 font-medium xl:table-cell xl:w-[9%]">
              rel
            </th>
            <th scope="col" className="w-[34%] py-2 pr-2 font-medium sm:w-[16%]">
              Status
            </th>
            <th scope="col" className="hidden py-2 pr-2 font-medium sm:table-cell sm:w-[9%]">
              Checked
            </th>
            <th scope="col" className="w-[24%] py-2 font-medium sm:w-[14%]">
              Change
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const t = targetText(r);
            return (
              <tr key={r.id} className={cx("border-b border-zinc-100 align-top dark:border-zinc-800", !r.active && "opacity-60")}>
                <td className="min-w-0 py-1.5 pr-2">
                  <button type="button" className="block w-full min-w-0 rounded text-left focus-visible:outline-2 focus-visible:outline-sky-600" onClick={() => onOpen(r)} aria-label={`Details for ${r.liveUrl}`}>
                    <UrlCell url={r.liveUrl} />
                  </button>
                  {!r.active && <span className="text-[11px] text-zinc-500">inactive (removed from sheet)</span>}
                </td>
                <td className="hidden min-w-0 py-1.5 pr-2 md:table-cell">
                  <UrlCell url={r.targetUrl} />
                  {t.broken && <span className="text-[11px] text-rose-700 dark:text-rose-300">target {t.text}</span>}
                </td>
                <td className="hidden min-w-0 truncate py-1.5 pr-2 text-xs lg:table-cell" title={r.anchorExpected ?? undefined}>
                  {r.anchorExpected ?? "—"}
                </td>
                <td className="hidden min-w-0 truncate py-1.5 pr-2 text-xs sm:table-cell" title={r.anchorFound ?? undefined}>
                  {r.anchorFound ?? "—"}
                  {r.anchorMatch === false && <span className="block text-[11px] text-amber-800 dark:text-amber-300">differs from expected</span>}
                </td>
                <td className="hidden min-w-0 truncate py-1.5 pr-2 font-mono text-[11px] xl:table-cell" title={r.relText ?? undefined}>
                  {r.relText ?? relLabel(r.linkRel)}
                </td>
                <td className="min-w-0 py-1.5 pr-2" title={r.statusReason ?? undefined}>
                  <StatusChip status={r.status} httpStatus={r.httpStatus} />
                  {r.checkMethod === "browser" && <BrowserBadge className="mt-0.5" />}
                  {browserNote(r) && <span className="block text-[11px] text-zinc-500 dark:text-zinc-400" title={r.browserReason ?? undefined}>{browserNote(r)}</span>}
                  {r.pageNoindex && <span className="block text-[11px] text-amber-800 dark:text-amber-300">page noindex</span>}
                </td>
                <td className="hidden py-1.5 pr-2 text-xs text-zinc-600 sm:table-cell dark:text-zinc-400" title={r.lastCheckedAt ? formatDateTime(r.lastCheckedAt) : undefined}>
                  {r.lastCheckedAt ? formatRelative(r.lastCheckedAt) : "never"}
                </td>
                <td className="min-w-0 py-1.5">
                  <RowCheckCell r={r} state={rowCheckState(r, pending[r.id], job)} job={job} disabledReason={disabledReason} onCheck={onCheck} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function BacklinksPage() {
  const { project, projectId } = useProject();
  const base = backlinksBase(projectId);
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<ListFilters>(() => filtersFromParams(params));
  const [reloadKey, setReloadKey] = useState(0);
  const summary = useApi<BacklinkSummary>(`${base}/summary`, [reloadKey]);
  const list = useApi<BacklinkListResponse>(`${base}${listQuery(filters)}`, [reloadKey]);
  const [open, setOpen] = useState<BacklinkRow | null>(null);
  const detail = useApi<BacklinkDetail>(open ? `${base}/${encodeURIComponent(open.id)}` : null, [reloadKey]);
  const [recheck, setRecheck] = useState<{ busy: boolean; message: string | null; error: unknown }>({ busy: false, message: null, error: null });

  const update = (patch: Partial<ListFilters>) => {
    const next = { ...filters, ...patch, offset: patch.offset ?? 0 };
    setFilters(next);
    const p = new URLSearchParams();
    for (const k of ["status", "vendor", "type", "changed", "q"] as const) if (next[k]) p.set(k, String(next[k]));
    setParams(p, { replace: true });
  };

  // While a check runs, refresh progress and rows every 5 s (the Live Backlinks view polls faster and drives batches).
  const running = jobActive(summary.data?.job);
  useEffect(() => {
    setBacklinkJob(projectId, summary.data?.job ?? null);
    if (!running) return;
    const t = setTimeout(() => {
      void api<BacklinkFeed>(`${base}/check/advance`, { method: "POST", body: {} })
        .catch(() => null)
        .finally(() => setReloadKey((k) => k + 1));
    }, 5_000);
    return () => clearTimeout(t);
  }, [running, summary.data, base, projectId]);

  const onReload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Row checks from the Change column: clicks within 600 ms go out as one recheck request (max MAX_RECHECK_IDS ids).
  const [pending, setPending] = useState<Record<string, string>>({});
  const [rowCheckError, setRowCheckError] = useState<unknown>(null);
  const queueRef = useRef<string[]>([]);
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushQueue = useCallback(async () => {
    flushRef.current = null;
    const ids = queueRef.current.splice(0, MAX_RECHECK_IDS);
    if (!ids.length) return;
    try {
      await api(`${base}/check`, { method: "POST", body: { ids } });
      setRowCheckError(null);
    } catch (e) {
      setRowCheckError(e);
      setPending((p) => {
        const next = { ...p };
        for (const id of ids) delete next[id];
        return next;
      });
    }
    if (queueRef.current.length) flushRef.current = setTimeout(() => void flushQueue(), 600);
    onReload();
  }, [base, onReload]);
  const onRowCheck = useCallback(
    (r: BacklinkRow) => {
      setPending((p) => ({ ...p, [r.id]: new Date().toISOString() }));
      if (!queueRef.current.includes(r.id)) queueRef.current.push(r.id);
      if (!flushRef.current) flushRef.current = setTimeout(() => void flushQueue(), 600);
    },
    [flushQueue],
  );
  // Drop pending marks once the row shows a check newer than the click.
  useEffect(() => {
    const rows = list.data?.rows;
    if (!rows) return;
    setPending((p) => {
      let changed = false;
      const next = { ...p };
      for (const r of rows) {
        const since = next[r.id];
        if (since && r.lastCheckedAt && r.lastCheckedAt > since) {
          delete next[r.id];
          changed = true;
        }
      }
      return changed ? next : p;
    });
  }, [list.data]);
  // While a row check is pending, drive batches and refresh every 3 s (the job-wide poll above runs every 5 s).
  const anyPending = Object.keys(pending).length > 0;
  useEffect(() => {
    if (!anyPending) return;
    const t = setTimeout(() => {
      void api<BacklinkFeed>(`${base}/check/advance`, { method: "POST", body: {} })
        .catch(() => null)
        .finally(onReload);
    }, 3_000);
    return () => clearTimeout(t);
  }, [anyPending, reloadKey, base, onReload]);
  // Browser re-checks waiting (and the day's browser budget left): drive the browser step and refresh, slowly.
  const browserPoll = running || anyPending ? null : browserPollInterval(summary.data);
  useEffect(() => {
    if (!browserPoll) return;
    const t = setTimeout(() => {
      void api<BacklinkFeed>(`${base}/check/advance`, { method: "POST", body: {} })
        .catch(() => null)
        .finally(onReload);
    }, browserPoll);
    return () => clearTimeout(t);
  }, [browserPoll, reloadKey, base, onReload]);
  const runAction = runCheckAction({ projectId, demo: project.isDemo, summary: summary.data, recheckIds: [] });

  const doRecheck = async (r: BacklinkRow) => {
    setRecheck({ busy: true, message: null, error: null });
    try {
      await api(`${base}/check`, { method: "POST", body: { ids: [r.id] } });
      setRecheck({ busy: false, message: "Recheck started; the result appears here in a few seconds.", error: null });
      setTimeout(onReload, 3_000);
    } catch (e) {
      setRecheck({ busy: false, message: null, error: e });
    }
  };

  const s = summary.data;
  const vendors = list.data?.vendors ?? [];
  const types = list.data?.types ?? [];
  const pageRows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const empty = s && s.totals.active + s.totals.inactive === 0;
  const pager = useMemo(() => ({ from: total ? filters.offset + 1 : 0, to: Math.min(filters.offset + filters.limit, total) }), [filters, total]);

  return (
    <RunActionsProvider projectId={projectId} onStarted={onReload} onReload={onReload}>
      <div className="min-w-0 space-y-4" data-testid="backlinks-page">
        <PageHeader
          title="Backlinks"
          description="Built links from your master sheet, checked on the live article: is the link to your page there, and is it dofollow, nofollow, sponsored or ugc?"
          actions={
            <>
              <Link className={buttonClass("ghost", "sm")} to={projectPath(projectId, "live/backlinks")}>
                Live Backlinks
              </Link>
              <a className={buttonClass("secondary", "sm")} href={csvHref(projectId, filters)} download>
                Export CSV
              </a>
              <SectionButton action={runAction} />
            </>
          }
        />
        {summary.error ? (
          <ErrorState error={summary.error} onRetry={onReload} />
        ) : !s ? (
          <LoadingState label="Loading backlinks…" />
        ) : empty ? (
          <EmptyState title="No backlinks monitored yet" action={<Link className={buttonClass("primary")} to={projectPath(projectId, "import")}>Import your built links</Link>}>
            Import your master sheet's built-links tab (or a CSV of it) with the destination “Backlinks to monitor”. The Built Links tab maps automatically: Live URL, Anchor 1 / Target, Anchor 2 /
            Target 2, plus vendor, type, date, DA, traffic and price as your own labels. Keep it in sync and new rows are monitored automatically.
            {s.labels.some((l) => /migration/.test(l)) && <span className="mt-2 block text-amber-800 dark:text-amber-300">{s.labels.find((l) => /migration/.test(l))}</span>}
          </EmptyState>
        ) : (
          <>
            <SummaryTiles s={s} />
            {s.labels.length > 0 && (
              <ul className="space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                {s.labels.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
            <Card
              title="Monitored backlinks"
              description={list.data ? `${pager.from.toLocaleString("en-US")}–${pager.to.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}` : undefined}
              bodyClassName="p-3 space-y-3"
            >
              <form className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
                <SelectField label="Status" value={filters.status} onChange={(e) => update({ status: e.target.value as ListFilters["status"] })}>
                  <option value="">All</option>
                  {FILTER_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {FILTER_LABELS[st]}
                    </option>
                  ))}
                </SelectField>
                <SelectField label="Vendor" value={filters.vendor} onChange={(e) => update({ vendor: e.target.value })}>
                  <option value="">All</option>
                  {vendors.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </SelectField>
                <SelectField label="Type" value={filters.type} onChange={(e) => update({ type: e.target.value })}>
                  <option value="">All</option>
                  {types.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </SelectField>
                <SelectField label="Changed" value={filters.changed} onChange={(e) => update({ changed: e.target.value as ListFilters["changed"] })}>
                  <option value="">Any time</option>
                  <option value="7">Last 7 days</option>
                  <option value="30">Last 30 days</option>
                </SelectField>
                <TextField label="Search" value={filters.q} maxLength={100} onChange={(e) => update({ q: e.target.value })} placeholder="URL or anchor" />
              </form>
              {list.error ? (
                <ErrorState error={list.error} onRetry={onReload} />
              ) : !list.data ? (
                <LoadingState label="Loading rows…" />
              ) : pageRows.length === 0 ? (
                <p className="py-6 text-center text-sm text-zinc-600 dark:text-zinc-400">No backlinks match these filters.</p>
              ) : (
                <>
                  <BacklinkTable
                    rows={pageRows}
                    onOpen={(r) => setOpen(r)}
                    pending={pending}
                    job={summary.data?.job}
                    disabledReason={project.isDemo ? "Demo project: checks are disabled." : null}
                    onCheck={onRowCheck}
                  />
                  {rowCheckError !== null && (
                    <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
                      Could not start the check: {errorMessage(rowCheckError)}
                    </p>
                  )}
                </>
              )}
              {total > filters.limit && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <Button size="sm" disabled={filters.offset === 0} onClick={() => update({ offset: Math.max(0, filters.offset - filters.limit) })}>
                    Previous
                  </Button>
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">
                    {pager.from.toLocaleString("en-US")}–{pager.to.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
                  </span>
                  <Button size="sm" disabled={filters.offset + filters.limit >= total} onClick={() => update({ offset: filters.offset + filters.limit })}>
                    Next
                  </Button>
                </div>
              )}
              {list.data && list.data.labels.map((l) => <p key={l} className="text-xs text-zinc-500 dark:text-zinc-400">{l}</p>)}
            </Card>
          </>
        )}
        <Drawer
          open={open !== null}
          onClose={() => {
            setOpen(null);
            setRecheck({ busy: false, message: null, error: null });
          }}
          title={open ? `Backlink: ${open.liveHost}` : "Backlink"}
          footer={
            open ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 text-xs" role="status" aria-live="polite">
                  {recheck.message && <span className="text-zinc-700 dark:text-zinc-300">{recheck.message}</span>}
                  {recheck.error !== null && <span className="text-red-700 dark:text-red-400">{errorMessage(recheck.error)}</span>}
                </div>
                <Button size="sm" onClick={() => void doRecheck(open)} loading={recheck.busy} disabled={project.isDemo || !open.active} title={project.isDemo ? "Demo project: checks are disabled." : undefined}>
                  Recheck
                </Button>
              </div>
            ) : undefined
          }
        >
          {detail.error ? <ErrorState error={detail.error} /> : !detail.data ? <LoadingState label="Loading history…" /> : <BacklinkHistory detail={detail.data} />}
        </Drawer>
      </div>
    </RunActionsProvider>
  );
}
