/**
 * SEO project containers (docs/live-view-design.md section 17): 10 striking-distance queries, 11 pages gaining
 * and losing clicks, 12 technical issues from the latest crawl, 13 competitor keyword gap (DataForSEO). Each
 * `…Panel` renders one stored aggregate (tested with fixtures); each `…Container` fetches it (data.ts).
 * Measured Search Console values with their window; DataForSEO numbers are labelled third-party estimates;
 * no projection, no score. Queries, URLs, keywords and rule details are plain text.
 */
import { Fragment, useState } from "react";
import { Link } from "react-router";
import type { CompetitorDataPanel, CompetitorDomainDetail } from "@shared/competitor-data";
import type { LiveMoversInsight, LivePageMover, LiveStrikingInsight, LiveTechnicalInsight, Severity } from "@shared/types";
import { cx } from "@web/components/ui";
import { projectPath } from "@web/lib/project-context";
import { ESTIMATE_NOTE, FETCH_STATUS_LABEL, GAP_NOTE, estimate, isActive, locationLabel } from "@web/pages/geo/competitor-data-lib";
import { Shimmer } from "../motion";
import { ACCENT, LTD, LTH, Panel, PanelEmpty, THEAD, ToneChip, type ToneName } from "../parts";
import { SectionButton } from "../RunActions";
import { competitorRefreshAction } from "../run-actions";
import { DEMO_LABEL, fmtInt, shortDate, urlPath, windowShort } from "../text";
import { LoadState, Notes, SetupNote, ShowingNote, captionsFor, type Loadable } from "./common";
import { useCompetitorDetail, useCompetitorPanel, useInsight, useLiveMore } from "./data";
import { signed, sourceCaption } from "./format";

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1).replace(/\.0$/, "")}%`);

// ------------------------------------------------------------------ 10 striking-distance queries
export function StrikingPanel({ state, reduced, projectId, runId, replaying }: { state: Loadable<LiveStrikingInsight>; reduced: boolean; projectId: string; runId: string | null; replaying: boolean }) {
  const d = state.data;
  const t = d?.thresholds;
  const captions = captionsFor([d?.sync ? `${sourceCaption("Search Console sync", d.sync.syncedAt, d.sync.runId, runId)} · ${windowShort(d.sync.current)} vs ${windowShort(d.sync.previous)}` : null], replaying, d?.labels ?? []);
  return (
    <Panel
      num="10"
      title="Striking-distance queries"
      accent="sky"
      reduced={reduced}
      testId="striking"
      counter={d && d.state !== "setup_required" ? { value: d.total, suffix: "in reach", sub: `query+page rows at positions ${t!.minPosition}–${t!.maxPosition}` } : null}
      subtitle={`Search Console query+page rows of the current window at an average position of ${t?.minPosition ?? 8}–${t?.maxPosition ?? 20} (inclusive), by impressions. Measured, not projected.`}
      captions={captions}
    >
      {!d ? (
        <LoadState state={state} what="striking-distance queries" />
      ) : d.state === "setup_required" ? (
        <SetupNote message={d.message} projectId={projectId} to="integrations" linkLabel="Connect Search Console in Integrations" />
      ) : d.rows.length === 0 ? (
        <>
          <PanelEmpty>
            No query+page row at positions {t!.minPosition}–{t!.maxPosition} with impressions in the latest sync.
          </PanelEmpty>
          <Notes labels={d.labels} />
        </>
      ) : (
        <>
          <table className="w-full table-fixed border-collapse text-xs">
            <caption className="sr-only">Queries at average positions {t!.minPosition} to {t!.maxPosition}, with the previous window where stored</caption>
            <thead className={THEAD}>
              <tr>
                <LTH className="w-[52%] @lg:w-[44%]">Query · page</LTH>
                <LTH className="w-[24%] text-right @lg:w-[14%]" title="Impressions, current window (previous window under it)">
                  Impr.
                </LTH>
                <LTH className="hidden text-right @lg:table-cell @lg:w-[14%]" title="Clicks, current window (previous window under it)">
                  Clicks
                </LTH>
                <LTH className="hidden text-right @lg:table-cell @lg:w-[12%]" title="Clicks / impressions of the row">
                  CTR
                </LTH>
                <LTH className="w-[24%] text-right @lg:w-[16%]" title="Search Console average position, current window (previous window under it)">
                  Pos.
                </LTH>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.rows.map((r) => (
                <tr key={`${r.query}\u0000${r.page}`} className={ACCENT.sky.row}>
                  <LTD title={`${r.query} · ${r.page}`}>
                    <span className="block truncate text-zinc-900 dark:text-zinc-100">{r.query}</span>
                    <span className="block truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{urlPath(r.page)}</span>
                  </LTD>
                  <LTD className="text-right font-mono tabular-nums">
                    <span className="block text-zinc-900 dark:text-zinc-100">{fmtInt(r.impressions)}</span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{r.previous ? `prev ${fmtInt(r.previous.impressions)}` : "new"}</span>
                  </LTD>
                  <LTD className="hidden text-right font-mono tabular-nums @lg:table-cell">
                    <span className="block text-zinc-900 dark:text-zinc-100">{fmtInt(r.clicks)}</span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{r.previous ? `${signed(r.clicks - r.previous.clicks)} vs prev` : "—"}</span>
                  </LTD>
                  <LTD className="hidden text-right font-mono tabular-nums text-zinc-700 @lg:table-cell dark:text-zinc-300">{pct(r.ctr)}</LTD>
                  <LTD className="text-right font-mono tabular-nums">
                    <span className="block text-zinc-900 dark:text-zinc-100">{r.position.toFixed(1)}</span>
                    <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{r.previous ? `prev ${r.previous.position.toFixed(1)}` : "—"}</span>
                  </LTD>
                </tr>
              ))}
            </tbody>
          </table>
          <ShowingNote shown={d.rows.length} total={d.total} what="rows (most impressions first)" />
          <Notes labels={d.labels} />
        </>
      )}
    </Panel>
  );
}

export function StrikingContainer({ projectId, reduced }: { projectId: string; reduced: boolean }) {
  const v = useLiveMore();
  const state = useInsight<LiveStrikingInsight>(projectId, "striking");
  return <StrikingPanel state={state} reduced={reduced} projectId={projectId} runId={v.runId} replaying={v.replaying} />;
}

// ------------------------------------------------------------------ 11 pages gaining and losing clicks
function MoverList({ title, list, tone, basis }: { title: string; list: LivePageMover[]; tone: "keep" | "change"; basis: LiveMoversInsight["basis"] }) {
  // One page row per page and window is Search Console's own position; sums over query+page rows are weighted (≈).
  const approx = basis === "page_rows" ? "" : "≈ ";
  return (
    <div className="min-w-0">
      <h3 className="pb-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{title}</h3>
      {list.length === 0 ? (
        <p className="py-2 text-xs text-zinc-600 dark:text-zinc-400">None.</p>
      ) : (
        <ol className="space-y-1">
          {list.map((m) => (
            <li key={m.page} className={cx("min-w-0 rounded-md border border-l-4 border-zinc-200 px-2 py-1 dark:border-zinc-800", tone === "keep" ? "border-l-emerald-600 dark:border-l-emerald-400" : "border-l-rose-600 dark:border-l-rose-400")}>
              <span className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-xs text-zinc-900 dark:text-zinc-100" title={m.page}>
                  {urlPath(m.page)}
                </span>
                <span className={cx("shrink-0 font-mono text-xs font-semibold tabular-nums", tone === "keep" ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-300")}>
                  {signed(m.clickDelta)} clicks
                </span>
              </span>
              <span className="block truncate font-mono text-[11px] text-zinc-600 tabular-nums dark:text-zinc-400">
                {fmtInt(m.current.clicks)} vs {fmtInt(m.previous.clicks)} clicks
              </span>
              <span className="block truncate font-mono text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400">
                {fmtInt(m.current.impressions)} impr. · pos {m.current.position === null ? "—" : `${approx}${m.current.position.toFixed(1)}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function MoversPanel({ state, reduced, projectId, runId, replaying }: { state: Loadable<LiveMoversInsight>; reduced: boolean; projectId: string; runId: string | null; replaying: boolean }) {
  const d = state.data;
  const captions = captionsFor([d?.sync ? `${sourceCaption("Search Console sync", d.sync.syncedAt, d.sync.runId, runId)} · ${windowShort(d.sync.current)} vs ${windowShort(d.sync.previous)}` : null], replaying, d?.labels ?? []);
  return (
    <Panel
      num="11"
      title="Pages gaining and losing clicks"
      accent="sky"
      reduced={reduced}
      testId="movers"
      counter={d && d.state !== "setup_required" ? { value: d.counts.both, suffix: "pages compared", sub: `${fmtInt(d.counts.newPages)} new · ${fmtInt(d.counts.lostPages)} lost` } : null}
      subtitle="Click difference per page between the two stored windows, for pages present in both. A measured difference, not a trend."
      captions={captions}
    >
      {!d ? (
        <LoadState state={state} what="page click changes" />
      ) : d.state === "setup_required" ? (
        <SetupNote message={d.message} projectId={projectId} to="integrations" linkLabel="Connect Search Console in Integrations" />
      ) : d.counts.both + d.counts.newPages + d.counts.lostPages === 0 ? (
        <PanelEmpty>No page rows in the latest sync.</PanelEmpty>
      ) : (
        <>
          <div className="grid min-w-0 grid-cols-1 gap-3 @xl:grid-cols-2">
            <MoverList title={`Gaining clicks (top ${d.top})`} list={d.gainers} tone="keep" basis={d.basis} />
            <MoverList title={`Losing clicks (top ${d.top})`} list={d.losers} tone="change" basis={d.basis} />
          </div>
          <p className="pt-2 text-[11px] text-zinc-600 dark:text-zinc-400">
            {fmtInt(d.counts.newPages)} page{d.counts.newPages === 1 ? "" : "s"} only in the current window · {fmtInt(d.counts.lostPages)} only in the previous window ·{" "}
            {fmtInt(d.counts.unchanged)} with no click difference.
          </p>
          <Notes labels={d.labels} />
        </>
      )}
    </Panel>
  );
}

export function MoversContainer({ projectId, reduced }: { projectId: string; reduced: boolean }) {
  const v = useLiveMore();
  const state = useInsight<LiveMoversInsight>(projectId, "movers");
  return <MoversPanel state={state} reduced={reduced} projectId={projectId} runId={v.runId} replaying={v.replaying} />;
}

// ------------------------------------------------------------------ 12 technical issues
const SEVERITY: Record<Severity, { label: string; tone: ToneName }> = {
  critical: { label: "Critical", tone: "change" },
  major: { label: "Major", tone: "change" },
  moderate: { label: "Moderate", tone: "review" },
  minor: { label: "Minor", tone: "info" },
  advisory: { label: "Advisory", tone: "none" },
};
const SEVERITY_ORDER: Severity[] = ["critical", "major", "moderate", "minor", "advisory"];

export function TechnicalPanel({ state, reduced, projectId, runId, replaying }: { state: Loadable<LiveTechnicalInsight>; reduced: boolean; projectId: string; runId: string | null; replaying: boolean }) {
  const d = state.data;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const captions = captionsFor(
    [
      d?.crawl
        ? `${sourceCaption("crawl", d.crawl.finishedAt ?? d.crawl.startedAt, d.crawl.runId, runId)} · ${fmtInt(d.crawl.pagesCrawled)} pages read${d.crawl.pagesSkipped ? `, ${fmtInt(d.crawl.pagesSkipped)} skipped` : ""}${d.crawl.status === "partial" ? " · partial crawl" : ""}`
        : null,
    ],
    replaying,
    d?.labels ?? [],
  );
  return (
    <Panel
      num="12"
      title="Technical issues from the latest crawl"
      accent="rose"
      reduced={reduced}
      testId="technical"
      counter={d?.crawl ? { value: d.total, suffix: "findings", sub: `on ${fmtInt(d.crawl.pagesCrawled)} pages read` } : null}
      subtitle="Deterministic rule findings of the latest completed crawl, grouped by severity and rule; fact = measured, heuristic = check it."
      captions={captions}
    >
      {!d ? (
        <LoadState state={state} what="technical findings" />
      ) : d.state === "setup_required" ? (
        <SetupNote message={d.message} projectId={projectId} to="settings" linkLabel="Verify the site in Settings" />
      ) : (
        <div className="space-y-2">
          {d.newer && (
            <p className="rounded-md border border-sky-200 bg-sky-50/60 px-2 py-1 text-[11px] text-zinc-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-zinc-300">
              A newer crawl {d.newer.status === "running" ? "is running" : "failed"} (started {shortDate(d.newer.startedAt)}); its findings are not shown.
            </p>
          )}
          {!d.crawl ? (
            <PanelEmpty>No completed crawl yet.</PanelEmpty>
          ) : d.groups.length === 0 ? (
            <PanelEmpty>No rule findings in the latest crawl.</PanelEmpty>
          ) : (
            <>
              <p className="flex flex-wrap gap-1.5" aria-label="Findings by severity">
                {SEVERITY_ORDER.filter((s) => d.bySeverity[s] > 0).map((s) => (
                  <ToneChip key={s} tone={SEVERITY[s].tone}>
                    {SEVERITY[s].label} {fmtInt(d.bySeverity[s])}
                  </ToneChip>
                ))}
              </p>
              <table className="w-full table-fixed border-collapse text-xs">
                <caption className="sr-only">Rule findings of the latest crawl by severity and rule</caption>
                <thead className={THEAD}>
                  <tr>
                    <LTH className="w-[26%] @lg:w-[18%]">Severity</LTH>
                    <LTH className="w-[50%] @lg:w-[56%]">Rule</LTH>
                    <LTH className="w-[24%] text-right @lg:w-[26%]">Findings</LTH>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {d.groups.map((g) => {
                    const k = `${g.severity}|${g.ruleId}`;
                    const isOpen = open.has(k);
                    const exId = `ex-${g.severity}-${g.ruleId}`.replace(/[^A-Za-z0-9_-]/g, "_");
                    return (
                      <Fragment key={k}>
                        <tr className={ACCENT.rose.row}>
                          <LTD className="overflow-visible">
                            <ToneChip tone={SEVERITY[g.severity].tone}>{SEVERITY[g.severity].label}</ToneChip>
                          </LTD>
                          <LTD title={`${g.ruleName} (${g.ruleId}) · ${g.class}`}>
                            <span className="block truncate text-zinc-900 dark:text-zinc-100">{g.ruleName}</span>
                            <span className="block truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                              {g.ruleId} · {g.class}
                            </span>
                          </LTD>
                          <LTD className="text-right">
                            <span className="block font-mono tabular-nums text-zinc-900 dark:text-zinc-100">{fmtInt(g.count)}</span>
                            {g.examples.length > 0 && (
                              <button
                                type="button"
                                aria-expanded={isOpen}
                                aria-controls={exId}
                                onClick={() => toggle(k)}
                                className="text-[11px] text-sky-800 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-sky-300"
                              >
                                {isOpen ? "Hide" : "Examples"}
                              </button>
                            )}
                          </LTD>
                        </tr>
                        {isOpen && (
                          <tr id={exId}>
                            <td colSpan={3} className="pb-2">
                              <ul className="space-y-0.5 pl-2 text-[11px] text-zinc-700 dark:text-zinc-300">
                                {g.examples.map((e, i) => (
                                  <li key={i} className="min-w-0">
                                    <span className="block truncate font-mono" title={e.url ?? e.template ?? undefined}>
                                      {e.url ? urlPath(e.url) : e.template ? `Template: ${e.template}` : "Site"}
                                    </span>
                                    <span className="block text-zinc-500 dark:text-zinc-400">{e.detail}</span>
                                  </li>
                                ))}
                                {g.count > g.examples.length && <li className="text-zinc-500 dark:text-zinc-400">… and {fmtInt(g.count - g.examples.length)} more on the SEO audit page.</li>}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-[11px]">
                <Link to={projectPath(projectId, "seo")}>Open the SEO audit</Link>
              </p>
            </>
          )}
          <Notes labels={d.labels} />
        </div>
      )}
    </Panel>
  );
}

export function TechnicalContainer({ projectId, reduced }: { projectId: string; reduced: boolean }) {
  const v = useLiveMore();
  const state = useInsight<LiveTechnicalInsight>(projectId, "technical");
  return <TechnicalPanel state={state} reduced={reduced} projectId={projectId} runId={v.runId} replaying={v.replaying} />;
}

// ------------------------------------------------------------------ 13 competitor keyword gap (DataForSEO)
const GAP_ROWS = 10;

export function CompetitorGapPanel({
  panel,
  domain,
  onDomain,
  detail,
  reduced,
  projectId,
  demo,
  replaying,
  onCheckAgain,
}: {
  panel: Loadable<CompetitorDataPanel>;
  domain: string | null;
  onDomain: (d: string) => void;
  detail: { data: CompetitorDomainDetail | null; error: unknown } | null;
  reduced: boolean;
  projectId: string;
  demo: boolean;
  replaying: boolean;
  onCheckAgain?: () => void;
}) {
  const p = panel.data;
  const summary = p?.domains.find((d) => d.domain === domain) ?? null;
  const snap = summary?.snapshot ?? null;
  const gapMeta = snap?.endpoints.find((e) => e.endpoint === "domain_intersection") ?? null;
  const rows = (detail?.data?.keywordGap ?? []).slice().sort((a, b) => (b.searchVolume ?? -1) - (a.searchVolume ?? -1)).slice(0, GAP_ROWS);
  const newest = p?.domains.map((d) => d.snapshot?.fetchedAt).filter((x): x is string => !!x).sort().pop() ?? null;
  const action = competitorRefreshAction({ projectId, demo }, p);
  const captions = captionsFor(
    [
      demo ? DEMO_LABEL : null,
      newest ? `From your latest DataForSEO refresh (${shortDate(newest)}), not part of this run${p?.state === "disabled" && p.message ? ` · ${p.message}` : ""}` : p?.state === "disabled" ? p.message : null,
    ],
    replaying,
  );
  const active = p?.domains.some((d) => isActive(d.latestFetch)) ?? false;
  return (
    <Panel
      num="13"
      title="Competitor keyword gap (DataForSEO)"
      accent="amber"
      reduced={reduced}
      testId="competitor-gap"
      action={action ? <SectionButton action={action} /> : null}
      subtitle="Keywords a tracked competitor ranks for where DataForSEO found no ranking for your domain: third-party estimates, not Search Console data."
      captions={captions}
    >
      {!p ? (
        <LoadState state={panel} what="competitor data" />
      ) : p.state === "setup_required" ? (
        <SetupNote message={p.message} projectId={projectId} to="integrations" linkLabel="Add DataForSEO credentials in Integrations" />
      ) : p.domains.length === 0 ? (
        <PanelEmpty>
          No competitor domain is tracked. <Link to={projectPath(projectId, "settings")}>Add competitors in Settings</Link>.
        </PanelEmpty>
      ) : (
        <div className="min-w-0 space-y-2">
          <div role="tablist" aria-label="Competitor domains" className="lv-strip relative flex gap-1 overflow-x-auto pb-1" tabIndex={0}>
            {p.domains.map((d) => (
              <button
                key={d.domain}
                type="button"
                role="tab"
                aria-selected={d.domain === domain}
                onClick={() => onDomain(d.domain)}
                className={cx(
                  "shrink-0 rounded-md px-2 py-0.5 font-mono text-[11px] focus-visible:outline-2 focus-visible:outline-sky-600",
                  d.domain === domain ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
                )}
              >
                {d.domain}
              </button>
            ))}
          </div>
          {summary && (
            <div role="tabpanel" aria-label={summary.domain} className="min-w-0 space-y-1.5">
              {summary.latestFetch && summary.latestFetch.status !== "completed" && (
                <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                  Latest refresh: {FETCH_STATUS_LABEL[summary.latestFetch.status]} ({shortDate(summary.latestFetch.createdAt)})
                  {summary.latestFetch.error ? ` · ${summary.latestFetch.error}` : ""}
                  {active && onCheckAgain && (
                    <>
                      {" "}
                      <button type="button" onClick={onCheckAgain} className="text-sky-800 underline focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-sky-300">
                        Check again
                      </button>
                    </>
                  )}
                </p>
              )}
              {!snap ? (
                <PanelEmpty>No DataForSEO data stored for {summary.domain} yet.</PanelEmpty>
              ) : (
                <>
                  <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                    DataForSEO estimate, fetched {shortDate(snap.fetchedAt)} · {locationLabel(snap.location)} · cost {snap.costUsd === null ? "unknown" : `$${snap.costUsd.toFixed(4)}`}
                    {gapMeta?.totalCount !== null && gapMeta?.totalCount !== undefined ? ` · ${fmtInt(gapMeta.totalCount)} gap keywords in DataForSEO's results` : ""}
                  </p>
                  {gapMeta?.status === "error" ? (
                    <p className="text-xs text-rose-700 dark:text-rose-300">The keyword gap request failed: {gapMeta.error ?? "unknown error"}.</p>
                  ) : detail?.error ? (
                    <LoadState state={{ data: null, error: detail.error, loading: false }} what="the keyword gap" />
                  ) : !detail?.data ? (
                    <Shimmer label="Loading the keyword gap…" />
                  ) : rows.length === 0 ? (
                    <PanelEmpty>No gap keywords in the stored refresh.</PanelEmpty>
                  ) : (
                    <table className="w-full table-fixed border-collapse text-xs">
                      <caption className="sr-only">Keywords {summary.domain} ranks for where your domain does not (DataForSEO estimate)</caption>
                      <thead className={THEAD}>
                        <tr>
                          <LTH className="w-[46%] @lg:w-[34%]">Keyword</LTH>
                          <LTH className="w-[28%] text-right @lg:w-[14%]" title="Monthly search volume (DataForSEO estimate)">
                            Volume
                          </LTH>
                          <LTH className="w-[26%] text-right @lg:w-[18%]" title="Their position (DataForSEO estimate)">
                            Their pos.
                          </LTH>
                          <LTH className="hidden @lg:table-cell @lg:w-[34%]">Their page</LTH>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                        {rows.map((g) => (
                          <tr key={g.keyword} className={ACCENT.amber.row}>
                            <LTD className="text-zinc-900 dark:text-zinc-100" title={g.keyword}>
                              {g.keyword}
                            </LTD>
                            <LTD className="text-right font-mono tabular-nums">{estimate(g.searchVolume)}</LTD>
                            <LTD className="text-right font-mono tabular-nums">{estimate(g.competitorPosition)}</LTD>
                            <LTD className="hidden font-mono text-[11px] text-zinc-600 @lg:table-cell dark:text-zinc-400" title={g.competitorUrl ?? undefined}>
                              {g.competitorUrl ? urlPath(g.competitorUrl) : "—"}
                            </LTD>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {detail?.data && <ShowingNote shown={rows.length} total={detail.data.keywordGap.length} what="stored gap keywords (highest volume first)" />}
                </>
              )}
            </div>
          )}
          <ul className="space-y-0.5 pt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            <li>{GAP_NOTE}</li>
            <li>{ESTIMATE_NOTE}</li>
          </ul>
        </div>
      )}
    </Panel>
  );
}

export function CompetitorGapContainer({ projectId, reduced }: { projectId: string; reduced: boolean }) {
  const v = useLiveMore();
  const [picked, setPicked] = useState<string | null>(null);
  const [nudge, setNudge] = useState(0);
  const reload = v.reloads.gap + nudge;
  const panel = useCompetitorPanel(projectId, reload);
  const domains = panel.data?.domains ?? [];
  // The viewer's pick, else the first domain with stored data, else the first domain.
  const domain = (picked && domains.some((d) => d.domain === picked) ? picked : null) ?? domains.find((d) => d.snapshot)?.domain ?? domains[0]?.domain ?? null;
  const hasData = !!domains.find((d) => d.domain === domain)?.snapshot;
  const detail = useCompetitorDetail(projectId, hasData ? domain : null, reload);
  return (
    <CompetitorGapPanel
      panel={panel}
      domain={domain}
      onDomain={setPicked}
      detail={detail}
      reduced={reduced}
      projectId={projectId}
      demo={v.demo}
      replaying={v.replaying}
      onCheckAgain={() => setNudge((n) => n + 1)}
    />
  );
}
