/**
 * Live Backlinks containers (docs/live-view-design.md section 19): 01 Backlink live check, 02 Dofollow / nofollow
 * check, 03 Current status, 04 New status (changes). Each is a numbered Panel with its own run button (section 16
 * conventions). Pure props (the page loads and polls), so every state renders server-side in tests. Every count is a
 * server count or a count of listed rows; URLs, anchors and rel values are React text only.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { BacklinkEventsResponse, BacklinkFeed, BacklinkFeedItem, BacklinkListResponse, BacklinkRow, BacklinkSummary } from "@shared/backlinks";
import { cx } from "@web/components/ui";
import { projectPath } from "@web/lib/project-context";
import {
  BUCKET_LABEL,
  BUCKET_TONE,
  REL_GROUP_LABEL,
  TONE_CLASS,
  TRIGGER_LABEL,
  anchorCounts,
  bucketCounts,
  jobActive,
  nOfM,
  progressText,
  relGroups,
  relLabel,
  shortDay,
  targetText,
  urlParts,
  type RelGroup,
} from "@web/pages/backlinks/lib";
import { StatusChip } from "@web/pages/backlinks/parts";
import { PulseDot, staggerStyle } from "../motion";
import { LTD, LTH, Panel, PanelEmpty, THEAD } from "../parts";
import { SectionButton } from "../RunActions";
import type { SectionAction } from "../run-actions";
import { LoadState, Notes, ShowingNote, type Loadable } from "../more/common";

interface Base {
  projectId: string;
  reduced: boolean;
  demo: boolean;
}

const PANEL = "h-[420px] xl:col-span-6";

function Empty({ projectId, demo }: { projectId: string; demo: boolean }) {
  return (
    <div className="space-y-2 py-6 text-center text-xs text-zinc-700 dark:text-zinc-300" data-testid="backlinks-empty">
      <p className="text-sm font-medium">No backlinks monitored yet</p>
      <p className="mx-auto max-w-md">
        {demo
          ? "The demo project has no built links: backlink checks fetch real pages, which demo projects never do."
          : "Import your built links sheet (the Built Links tab maps automatically: Live URL, Anchor 1 / Target, Anchor 2 / Target 2) on the Import page, destination “Backlinks to monitor”."}
      </p>
      {!demo && <Link to={projectPath(projectId, "import")}>Open Import</Link>}
    </div>
  );
}

function HostPath({ url }: { url: string }) {
  const p = urlParts(url);
  return (
    <span className="block min-w-0" title={url}>
      <span className="block truncate text-xs text-zinc-900 dark:text-zinc-100">{p.host}</span>
      <span className="block truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-400">{p.path}</span>
    </span>
  );
}

function Pill({ tone, children, title }: { tone: keyof typeof TONE_CLASS; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap ring-1 ring-inset", TONE_CLASS[tone])}>
      {children}
    </span>
  );
}

const summaryReady = (s: Loadable<BacklinkSummary>) => !!s.data && (s.data.totals.active > 0 || s.data.totals.inactive > 0);

// ------------------------------------------------------------------ 01 Backlink live check
export function LiveCheckPanel({
  projectId,
  reduced,
  demo,
  feed,
  summary,
  action,
  fresh,
}: Base & { feed: Loadable<BacklinkFeed>; summary: Loadable<BacklinkSummary>; action: SectionAction; fresh?: ReadonlySet<string> }) {
  const job = feed.data?.job ?? summary.data?.job ?? null;
  const running = jobActive(job);
  const items = feed.data?.items ?? [];
  const total = job ? Math.max(job.total, job.done) : 0;
  return (
    <Panel
      num="01"
      title="Backlink live check"
      accent="sky"
      testId="backlinks-live"
      reduced={reduced}
      className={PANEL}
      subtitle="Each live article being fetched now: the page, then the link to your site (robots.txt is not consulted for your own placed links)."
      captions={[
        job ? `${running ? "Running" : job.status === "failed" ? "Stopped" : "Last"} ${TRIGGER_LABEL[job.trigger]} · started ${shortDay(job.startedAt ?? job.createdAt)}` : "No check has run yet",
        running ? "Updates every 2 s while the check runs" : "Idle: not polling",
      ]}
      action={<SectionButton action={action} />}
      counter={job ? { value: job.done, suffix: "checked", sub: `of ${total.toLocaleString("en-US")}${running ? " in this check" : ""}` } : null}
    >
      {!summary.data && !feed.data ? (
        <LoadState state={summary.error ? summary : feed} what="the backlink check" />
      ) : !summaryReady(summary) && !job ? (
        <Empty projectId={projectId} demo={demo} />
      ) : (
        <div className="space-y-2">
          {job && (
            <div className="space-y-1" data-testid="backlinks-progress">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-700 dark:text-zinc-300">
                {running && <PulseDot tone="sky" />}
                <span className="font-medium">{progressText(job)}</span>
                <span>{job.robotsBlocked.toLocaleString("en-US")} robots-blocked</span>
                <span>{job.failed.toLocaleString("en-US")} failed / page errors</span>
                <span>{job.changes.toLocaleString("en-US")} changes</span>
                <span>{job.fetches.toLocaleString("en-US")} requests in {job.batches.toLocaleString("en-US")} batches</span>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"
                role="progressbar"
                aria-label="Backlinks checked"
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={job.done}
              >
                <div className={cx("h-full bg-sky-600 dark:bg-sky-400", !reduced && "transition-[width] duration-500")} style={{ width: `${total ? Math.min(100, (job.done / total) * 100) : 0}%` }} />
              </div>
              {job.note && <p className="text-[11px] text-amber-800 dark:text-amber-300">{job.note}</p>}
            </div>
          )}
          {items.length === 0 ? (
            <PanelEmpty>{running ? "Waiting for the first pages of this check…" : "No pages checked in the latest check."}</PanelEmpty>
          ) : (
            <table className="w-full table-fixed text-xs" data-testid="backlinks-feed">
              <thead className={THEAD}>
                <tr>
                  <LTH className="w-[42%]">Live article</LTH>
                  <LTH className="w-[24%]">Result</LTH>
                  <LTH className="hidden @lg:table-cell">Anchor</LTH>
                  <LTH tight className="w-12 text-right">
                    At
                  </LTH>
                </tr>
              </thead>
              <tbody>
                {items.map((i: BacklinkFeedItem) => (
                  <tr key={i.checkId} className={cx("border-b border-zinc-100 dark:border-zinc-800", fresh?.has(i.checkId) && "lv-row-in")} style={reduced || !fresh ? undefined : staggerStyle(fresh, i.checkId)}>
                    <LTD>
                      <HostPath url={i.liveUrl} />
                    </LTD>
                    <LTD title={i.statusReason ?? undefined}>
                      <StatusChip status={i.status} httpStatus={i.httpStatus} />
                      {i.robots === "disallowed" && <span className="sr-only"> robots.txt disallows</span>}
                    </LTD>
                    <LTD className="hidden @lg:table-cell" title={i.anchorFound ?? undefined}>
                      {i.anchorFound ?? "—"}
                    </LTD>
                    <LTD tight className="text-right font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                      {new Date(i.checkedAt).toISOString().slice(11, 16)}
                    </LTD>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ 02 Dofollow / nofollow check
const GROUP_ORDER: RelGroup[] = ["dofollow", "nofollow", "sponsored", "ugc", "page_nofollow"];

export function RelCheckPanel({ projectId, reduced, demo, summary, rows, action }: Base & { summary: Loadable<BacklinkSummary>; rows: Loadable<BacklinkListResponse>; action: SectionAction }) {
  const s = summary.data;
  const list = rows.data?.rows ?? [];
  const groups = relGroups(list);
  const anchors = anchorCounts(list);
  const found = s ? s.byStatus.dofollow + s.byStatus.nofollow + s.byStatus.sponsored + s.byStatus.ugc : 0;
  return (
    <Panel
      num="02"
      title="Dofollow / nofollow check"
      accent="emerald"
      testId="backlinks-rel"
      reduced={reduced}
      className={PANEL}
      subtitle="Links found to your site, by rel: dofollow, nofollow, sponsored, ugc, or a page-level nofollow (meta robots / X-Robots-Tag)."
      captions={[s?.lastCheckAt ? `From your latest checks (last ${shortDay(s.lastCheckAt)})` : "No check stored yet"]}
      action={<SectionButton action={action} />}
      counter={s && s.dofollow.m > 0 ? { value: s.dofollow.n, suffix: "dofollow", sub: `of ${s.dofollow.m.toLocaleString("en-US")} pages read` } : null}
    >
      {!s ? (
        <LoadState state={summary} what="link checks" />
      ) : !summaryReady(summary) ? (
        <Empty projectId={projectId} demo={demo} />
      ) : found === 0 ? (
        <PanelEmpty>No link to your site found in a checked page yet{s.totals.unchecked ? ` (${s.totals.unchecked.toLocaleString("en-US")} not checked yet)` : ""}.</PanelEmpty>
      ) : (
        <div className="space-y-2">
          <ul className="flex flex-wrap gap-1.5" aria-label="Links by rel">
            <li>
              <Pill tone="good">dofollow {s.byStatus.dofollow.toLocaleString("en-US")}</Pill>
            </li>
            <li>
              <Pill tone="warn">nofollow {s.byStatus.nofollow.toLocaleString("en-US")}</Pill>
            </li>
            <li>
              <Pill tone="warn">sponsored {s.byStatus.sponsored.toLocaleString("en-US")}</Pill>
            </li>
            <li>
              <Pill tone="warn">ugc {s.byStatus.ugc.toLocaleString("en-US")}</Pill>
            </li>
            <li>
              <Pill tone="neutral" title="Page-level nofollow among the rows listed below (meta robots or X-Robots-Tag nofollow on the article).">
                page-level nofollow {groups.page_nofollow.length.toLocaleString("en-US")} listed
              </Pill>
            </li>
          </ul>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
            Anchor vs expected (listed rows): {anchors.matches.toLocaleString("en-US")} match · {anchors.differs.toLocaleString("en-US")} differ · {anchors.noExpected.toLocaleString("en-US")} no expected anchor · {s.anchorMismatch.toLocaleString("en-US")} differ in all
          </p>
          {!rows.data ? (
            <LoadState state={rows} what="backlinks" />
          ) : (
            GROUP_ORDER.filter((g) => groups[g].length > 0).map((g) => (
              <section key={g} aria-label={REL_GROUP_LABEL[g]}>
                <h3 className="pt-1 text-[11px] font-semibold tracking-wide text-zinc-600 uppercase dark:text-zinc-400">
                  {REL_GROUP_LABEL[g]} · {groups[g].length.toLocaleString("en-US")}
                </h3>
                <table className="w-full table-fixed text-xs">
                  <tbody>
                    {groups[g].slice(0, 12).map((r: BacklinkRow) => (
                      <tr key={r.id} className="border-b border-zinc-100 dark:border-zinc-800">
                        <LTD className="w-[45%]">
                          <HostPath url={r.liveUrl} />
                        </LTD>
                        <LTD title={r.anchorFound ?? undefined}>
                          “{r.anchorFound ?? ""}”
                          {r.anchorMatch === false && <span className="ml-1 text-amber-800 dark:text-amber-300">≠ “{r.anchorExpected}”</span>}
                        </LTD>
                        <LTD tight className="hidden w-24 font-mono text-[10px] @lg:table-cell" title={r.relText ?? undefined}>
                          {r.relText ?? relLabel(r.linkRel)}
                        </LTD>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ShowingNote shown={Math.min(12, groups[g].length)} total={groups[g].length} what="listed rows" />
              </section>
            ))
          )}
          {rows.data && rows.data.total > rows.data.rows.length && <ShowingNote shown={rows.data.rows.length} total={rows.data.total} what="backlinks loaded for the lists (counts above cover all)" />}
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ 03 Current status
export function CurrentStatusPanel({ projectId, reduced, demo, summary, rows, action }: Base & { summary: Loadable<BacklinkSummary>; rows: Loadable<BacklinkListResponse>; action: SectionAction }) {
  const s = summary.data;
  const list = rows.data?.rows ?? [];
  return (
    <Panel
      num="03"
      title="Current status"
      accent="amber"
      testId="backlinks-status"
      reduced={reduced}
      className={PANEL}
      subtitle="Every backlink's latest status: live, missing, page errors, redirects, robots, failures and broken targets."
      captions={[s?.lastCheckAt ? `Latest check ${shortDay(s.lastCheckAt)}` : "No check stored yet", s?.nextCheckAt ? `Next weekly check ${shortDay(s.nextCheckAt)}` : null].filter((x): x is string => !!x)}
      action={<SectionButton action={action} />}
      counter={s ? { value: s.totals.active, suffix: "monitored", sub: s.totals.inactive ? `${s.totals.inactive.toLocaleString("en-US")} inactive (removed from sheet)` : undefined } : null}
    >
      {!s ? (
        <LoadState state={summary} what="backlink statuses" />
      ) : !summaryReady(summary) ? (
        <Empty projectId={projectId} demo={demo} />
      ) : (
        <div className="space-y-2">
          <ul className="grid grid-cols-2 gap-1.5 @lg:grid-cols-3" aria-label="Backlinks by status">
            {bucketCounts(s).map((b) => (
              <li key={b.bucket} className={cx("flex min-w-0 items-baseline justify-between gap-2 rounded px-2 py-1 ring-1 ring-inset", TONE_CLASS[BUCKET_TONE[b.bucket]])}>
                <span className="truncate text-[11px]">{BUCKET_LABEL[b.bucket]}</span>
                <span className="font-mono text-xs font-semibold tabular-nums">{b.n.toLocaleString("en-US")}</span>
              </li>
            ))}
          </ul>
          {!rows.data ? (
            <LoadState state={rows} what="backlinks" />
          ) : (
            <table className="w-full table-fixed text-xs" data-testid="backlinks-status-table">
              <thead className={THEAD}>
                <tr>
                  <LTH className="w-[40%]">Live article</LTH>
                  <LTH className="w-[30%]">Status</LTH>
                  <LTH className="hidden @lg:table-cell">Target</LTH>
                  <LTH tight className="w-12 text-right">
                    Checked
                  </LTH>
                </tr>
              </thead>
              <tbody>
                {list.slice(0, 50).map((r) => {
                  const t = targetText(r);
                  return (
                    <tr key={r.id} className="border-b border-zinc-100 dark:border-zinc-800">
                      <LTD>
                        <HostPath url={r.liveUrl} />
                      </LTD>
                      <LTD title={r.statusReason ?? undefined}>
                        <StatusChip status={r.status} httpStatus={r.httpStatus} />
                        {t.broken && <span className="ml-1 text-[10px] text-rose-700 dark:text-rose-300">target {t.text}</span>}
                      </LTD>
                      <LTD className="hidden @lg:table-cell">
                        <HostPath url={r.targetUrl} />
                      </LTD>
                      <LTD tight className="text-right font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                        {shortDay(r.lastCheckedAt)}
                      </LTD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {rows.data && <ShowingNote shown={Math.min(50, list.length)} total={rows.data.total} what="backlinks (sorted by status)" />}
          <Notes labels={s.labels} />
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ 04 New status (changes)
export function ChangesPanel({ projectId, reduced, demo, summary, events, action }: Base & { summary: Loadable<BacklinkSummary>; events: Loadable<BacklinkEventsResponse>; action: SectionAction }) {
  const s = summary.data;
  const ev = events.data;
  return (
    <Panel
      num="04"
      title="New status (changes)"
      accent="rose"
      testId="backlinks-changes"
      reduced={reduced}
      className={PANEL}
      subtitle="What changed between a backlink's previous check and its latest one, last 30 days: was dofollow → now nofollow, link removed, page 404, redirected, recovered."
      captions={[ev ? `Changes since ${shortDay(ev.since)} (30 days)` : "Last 30 days", s ? `${s.changes.negative7.toLocaleString("en-US")} losses in the last 7 days` : null].filter((x): x is string => !!x)}
      action={<SectionButton action={action} />}
      counter={ev ? { value: ev.total, suffix: "changes", sub: s ? `${s.changes.negative30.toLocaleString("en-US")} losses` : undefined } : null}
    >
      {!ev ? (
        <LoadState state={events} what="changes" />
      ) : s && !summaryReady(summary) ? (
        <Empty projectId={projectId} demo={demo} />
      ) : ev.events.length === 0 ? (
        <PanelEmpty>No changes in the last 30 days. The first check of a backlink is its baseline; changes appear from the second check on.</PanelEmpty>
      ) : (
        <>
          <ul className="space-y-1" data-testid="backlinks-events">
            {ev.events.map((e) => (
              <li key={e.id} className={cx("min-w-0 rounded border px-2 py-1", e.negative ? "border-rose-200 dark:border-rose-900/60" : "border-zinc-200 dark:border-zinc-800")} data-event={e.kind}>
                <p className={cx("text-xs font-medium break-words", e.negative ? "text-rose-700 dark:text-rose-300" : "text-zinc-800 dark:text-zinc-200")}>
                  <span aria-hidden="true">{e.negative ? "▼ " : "● "}</span>
                  {e.from && e.to && e.kind === "rel_changed" ? `was ${e.from} → now ${e.to}` : e.message}
                </p>
                <p className="flex min-w-0 flex-wrap gap-x-2 text-[11px] text-zinc-600 dark:text-zinc-400">
                  <span className="min-w-0 truncate" title={e.liveUrl}>
                    {e.liveUrl ? `${urlParts(e.liveUrl).host}${urlParts(e.liveUrl).path}` : ""}
                  </span>
                  <span className="shrink-0 font-mono">{shortDay(e.detectedAt)}</span>
                </p>
              </li>
            ))}
          </ul>
          <ShowingNote shown={ev.events.length} total={ev.total} what="changes" />
          <p className="pt-1 text-[11px]">
            <Link to={`${projectPath(projectId, "backlinks")}?changed=30`}>Open Backlinks ›</Link>
          </p>
        </>
      )}
    </Panel>
  );
}

export { nOfM };
