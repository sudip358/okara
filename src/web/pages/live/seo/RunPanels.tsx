/**
 * SEO stage panels fed by this run's own stored rows: 01 Pages being read (page_read items), 02 Search
 * Console sync (the run's gsc_syncs row + GET /seo/overview), 03 Queries classified by Jev (LiveSeoQueryRow).
 * Plain text only; measured values with their window; no volume, difficulty or projection.
 */
import { useRef, useState } from "react";
import { Link } from "react-router";
import type { ActivityItem, BuyerQueryRow, LiveGscSync, LiveSeoQueryRow, RunActivity, SeoOverview } from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx, ErrorState, StateBanner } from "@web/components/ui";
import { LineChart } from "@web/components/LineChart";
import { DemandCurveChart } from "@web/components/DemandCurveChart";
import type { QueryGroup, SegmentStatus } from "../engine";
import { Shimmer, staggerStyle, useFollowRow, useSeenPending } from "../motion";
import { ACCENT, JevChip, LTD, LTH, Panel, PanelEmpty, PendingChip, THEAD, ToneChip, type ToneName } from "../parts";
import { LIVE_TEXT, bandLabel, clipText, fmtInt, jevChipText, lowerBoundPrefix, positionText, shortDate, urlHost, urlPath, windowShort } from "../text";

// ------------------------------------------------------------------ 01 Pages being read
export function PagesPanel({
  reads,
  pagesRead,
  pagesPlanned,
  nowReading,
  crawl,
  crawlMessage,
  skipped,
  finished,
  fresh,
  reduced,
  projectId,
  verified,
}: {
  /** Newest first, at most 8. */
  reads: ActivityItem[];
  pagesRead: number;
  pagesPlanned: number | null;
  nowReading: RunActivity["nowReading"];
  crawl: SegmentStatus;
  crawlMessage: string | null;
  skipped: Array<{ reason: string; count: number }>;
  /** The run (or the replay) is over: "did not crawl" is then final. */
  finished: boolean;
  fresh: ReadonlySet<string>;
  reduced: boolean;
  projectId: string;
  verified: boolean;
}) {
  const running = crawl === "running";
  const frac = pagesPlanned && pagesPlanned > 0 ? Math.min(1, pagesRead / pagesPlanned) : null;
  const skippedTotal = skipped.reduce((s, r) => s + r.count, 0);
  return (
    <Panel
      num="01"
      title="Pages being read"
      accent="sky"
      reduced={reduced}
      testId="pages"
      counter={{ value: pagesRead, suffix: pagesPlanned !== null ? `/ ${fmtInt(pagesPlanned)} pages` : "pages read", sub: pagesPlanned !== null ? `of the ${fmtInt(pagesPlanned)}\u2011page limit` : undefined }}
      subtitle="The crawler reads verified pages through the SSRF guard; each card is a stored page snapshot."
    >
      {crawl === "skipped" || (crawl === "failed" && reads.length === 0) ? (
        <div className="space-y-2 py-3 text-xs text-zinc-700 dark:text-zinc-300">
          <p>{clipText(crawlMessage, 200) || "The crawl step did not run."}</p>
          {!verified && <Link to={projectPath(projectId, "settings")}>Verify the site in Settings</Link>}
        </div>
      ) : reads.length === 0 && crawl === "not_started" ? (
        <PanelEmpty>{finished ? "This run did not crawl." : "Waiting for the crawl step to start."}</PanelEmpty>
      ) : (
        <div className="space-y-2.5">
          {nowReading && (
            <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2 dark:border-sky-900 dark:bg-sky-950/40">
              <p className="text-[11px] text-zinc-600 dark:text-zinc-400">Now reading · {urlHost(nowReading.url)}</p>
              <p key={nowReading.url} className="lv-rise truncate font-mono text-base font-semibold text-zinc-950 dark:text-zinc-50" title={nowReading.url}>
                {urlPath(nowReading.url)}
              </p>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Latest stored read; may trail the crawler by up to 10 pages.</p>
            </div>
          )}
          {frac !== null && (
            <div
              role="progressbar"
              aria-label="Pages read"
              aria-valuemin={0}
              aria-valuemax={pagesPlanned ?? undefined}
              aria-valuenow={pagesRead}
              aria-valuetext={`${fmtInt(pagesRead)} of ${fmtInt(pagesPlanned)} pages read`}
              className={cx("h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800", running && "lv-stripes lv-stripes-run")}
            >
              <div className="lv-bar h-full rounded-full bg-sky-600 dark:bg-sky-400" style={{ width: `${Math.round(frac * 100)}%` }} />
            </div>
          )}
          <ol className="space-y-1.5" aria-label="Latest pages read">
            {reads.map((it) => (
              <li
                key={it.id}
                className={cx(
                  "flex min-w-0 items-center justify-between gap-2 rounded-md border border-l-4 border-zinc-200 bg-white px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900",
                  it.status === "error" ? "border-l-rose-500" : it.status === "warn" ? "border-l-amber-500" : "border-l-zinc-300 dark:border-l-zinc-600",
                  fresh.has(it.id) && "lv-row-in",
                )}
              >
                <span className="min-w-0 truncate font-mono text-xs text-zinc-900 dark:text-zinc-100" title={it.url ?? undefined}>
                  {urlPath(it.url)}
                </span>
                <span className={cx("shrink-0 font-mono text-[11px] tabular-nums", it.status === "error" ? "text-rose-700 dark:text-rose-300" : it.status === "warn" ? "text-amber-800 dark:text-amber-300" : "text-zinc-500 dark:text-zinc-400")}>
                  {clipText(it.detail, 60)}
                </span>
              </li>
            ))}
          </ol>
          {skippedTotal > 0 && (
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
              {fmtInt(skippedTotal)} skipped: {skipped.map((s) => `${fmtInt(s.count)} ${clipText(s.reason, 40)}`).join(", ")}
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ 02 Search Console sync
const SOURCE_LABEL: Record<string, string> = { api: "Search Console API", csv_import: "CSV import", demo: "Demo" };

function Delta({ cur, prev, digits = 0, lowerIsBetter = false }: { cur: number | null; prev: number | null; digits?: number; lowerIsBetter?: boolean }) {
  if (cur === null || prev === null) return null;
  const d = cur - prev;
  if (Math.abs(d) < 10 ** -digits / 2) return <span className="text-zinc-500 dark:text-zinc-400"> (no change)</span>;
  const good = lowerIsBetter ? d < 0 : d > 0;
  return (
    <span className={good ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-300"}>
      {" "}
      ({d > 0 ? "+" : "−"}
      {digits ? Math.abs(d).toFixed(digits) : fmtInt(Math.abs(d))} vs previous)
    </span>
  );
}

export function GscPanel({
  overview,
  overviewError,
  sync,
  step,
  stepMessage,
  reduced,
  projectId,
  replaying,
}: {
  overview: SeoOverview | null;
  overviewError: unknown;
  sync: LiveGscSync | null;
  step: SegmentStatus;
  stepMessage: string | null;
  reduced: boolean;
  projectId: string;
  replaying: boolean;
}) {
  const [tab, setTab] = useState<"daily" | "curve">("daily");
  const cur = overview?.totals.current ?? null;
  const prev = overview?.totals.previous ?? null;
  const notConnected = overview?.state === "setup_required";
  // Replay: this run's sync row is shown only once the seo.gsc_sync step has ended at the playhead.
  const stepEnded = step === "completed" || step === "partial" || step === "failed" || step === "skipped";
  const runSync = replaying && !stepEnded ? null : sync;
  // The charts come from the latest usable sync; say so when that is not this run's (or this run has none yet).
  const earlier =
    overview?.syncedAt && (runSync ? runSync.syncedAt !== overview.syncedAt : !replaying) ? `From an earlier sync (${shortDate(overview.syncedAt)})` : null;
  // Two chips at most (this run's sync; the chart window and its freshness), so the chart keeps its room.
  const join = (xs: Array<string | null | undefined>) => xs.filter((x): x is string => !!x).join(" · ") || null;
  const captions = [
    join([
      runSync ? SOURCE_LABEL[runSync.source] ?? runSync.source : !replaying && overview?.source ? SOURCE_LABEL[overview.source] ?? overview.source : null,
      runSync ? `Sync ${runSync.status.replace(/_/g, " ")}` : step === "running" ? "Sync running" : null,
      runSync ? `Rows ${fmtInt(runSync.rowsFetched)} of ${fmtInt(runSync.rowCap)}` : null,
      runSync?.truncated ? "Truncated at cap" : null,
    ]),
    join([
      overview?.current ? `${windowShort(overview.current)}${overview.previous ? ` vs ${windowShort(overview.previous)}` : ""}` : null,
      earlier,
      replaying ? "Charts: current stored state" : null,
    ]),
  ].filter((x): x is string => !!x);
  return (
    <Panel
      num="02"
      title="Search Console"
      accent="sky"
      reduced={reduced}
      testId="gsc"
      captions={captions}
      counter={cur && !notConnected ? { value: cur.clicks, suffix: "clicks", sub: overview?.current ? `measured, ${windowShort(overview.current)}` : undefined } : null}
      subtitle="Measured clicks and impressions from your property; the demand curve ranks your own queries by impressions."
    >
      {notConnected ? (
        <div className="space-y-2 py-3 text-center text-xs text-zinc-700 dark:text-zinc-300">
          <p className="text-sm font-medium">Search Console not connected</p>
          <Link to={projectPath(projectId, "integrations")}>Connect it in Integrations</Link>
        </div>
      ) : (
        <div className="space-y-2">
          {runSync?.status === "failed" && <StateBanner state="failed" title="Sync failed" message={clipText(runSync.error, 200) || undefined} />}
          {step === "skipped" && !runSync && <p className="text-xs text-zinc-700 dark:text-zinc-300">{clipText(stepMessage, 200) || "The Search Console step was skipped."}</p>}
          {overviewError !== null && overviewError !== undefined && !overview ? (
            <ErrorState error={overviewError} title="Could not load Search Console data" />
          ) : !overview ? (
            <Shimmer label="Loading stored Search Console data…" />
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] leading-tight tabular-nums @sm:grid-cols-4">
                <div className="min-w-0">
                  <dt className="font-sans text-zinc-500 dark:text-zinc-400">Clicks</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">
                    {fmtInt(cur?.clicks)}
                    <Delta cur={cur?.clicks ?? null} prev={prev?.clicks ?? null} />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="font-sans text-zinc-500 dark:text-zinc-400">Impressions</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">
                    {fmtInt(cur?.impressions)}
                    <Delta cur={cur?.impressions ?? null} prev={prev?.impressions ?? null} />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="font-sans text-zinc-500 dark:text-zinc-400">CTR</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">{cur?.ctr.value !== null && cur?.ctr.value !== undefined ? `${(cur.ctr.value * 100).toFixed(1)}%` : "—"}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="font-sans text-zinc-500 dark:text-zinc-400">Avg position</dt>
                  <dd className="text-zinc-900 dark:text-zinc-100">
                    {cur?.position !== null && cur?.position !== undefined ? cur.position.toFixed(1) : "—"}
                    <Delta cur={cur?.position ?? null} prev={prev?.position ?? null} digits={1} lowerIsBetter />
                  </dd>
                </div>
              </dl>
              <div role="tablist" aria-label="Search Console chart" className="flex gap-1">
                {(
                  [
                    ["daily", "Clicks per day"],
                    ["curve", "Demand curve"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={tab === k}
                    onClick={() => setTab(k)}
                    className={cx(
                      "rounded px-2 py-0.5 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-sky-600",
                      tab === k ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div role="tabpanel" className="min-w-0">
                {tab === "daily" ? (
                  <LineChart title="Clicks per day" unit="clicks" points={overview.daily.map((d) => ({ date: d.date, value: d.clicks }))} annotations={overview.annotations} />
                ) : overview.demandCurve ? (
                  <DemandCurveChart curve={overview.demandCurve} />
                ) : (
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">No query data for a demand curve in this window.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ 03 Queries classified by Jev
/** One Jev cell: the stored answer as a chip, then its Jev line (Noul: tier + raw value; Choice: tier + real confidence). */
function JevCell({ row, kind }: { row: LiveSeoQueryRow | null; kind: "band" | "choice" }) {
  if (!row) return <span className="text-zinc-400 dark:text-zinc-500">—</span>;
  const tip = [row.jev.questionId, row.jev.provider, row.jev.model].filter(Boolean).join(" · ");
  if (kind === "choice") {
    const tier = row.jev.tier && row.jev.tier !== "n/a" ? row.jev.tier : "no tier";
    const conf = row.jev.confidence !== null && Number.isFinite(row.jev.confidence) ? ` · conf ${row.jev.confidence.toFixed(2)}` : "";
    return (
      <span className="flex min-w-0 flex-col items-start gap-0.5">
        <ToneChip tone={row.jev.choice ? (row.jev.tier === "act" ? "info" : "review") : "none"} title={row.jev.choice ?? undefined}>
          {row.jev.choice ? row.jev.choice.replace(/_/g, " ") : "No answer"}
        </ToneChip>
        <JevChip text={tier === "drop" ? "Jev drop · withheld" : `Jev ${tier}${conf}`} tier={row.jev.tier} title={`${jevChipText(row.jev)} — ${tip}`} />
      </span>
    );
  }
  const label: { label: string; tone: ToneName } = row.jev.tier === "drop" ? { label: "Dropped (not relevant)", tone: "none" } : bandLabel(row.band);
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <ToneChip tone={label.tone}>{label.label}</ToneChip>
      <JevChip text={jevChipText(row.jev)} tier={row.jev.tier} title={tip} />
    </span>
  );
}

export function QueriesPanel({
  groups,
  relevant,
  distinct,
  buyer,
  fresh,
  reduced,
  finished,
  pendingLabel = "Reading…",
}: {
  /** Replay pending rows: "Reading…" (shimmer) while the step runs, else "Up next" (static). */
  pendingLabel?: "Reading…" | "Up next";
  groups: QueryGroup[];
  relevant: number;
  distinct: number;
  buyer: BuyerQueryRow[] | null;
  fresh: ReadonlySet<string>;
  reduced: boolean;
  finished: boolean;
}) {
  const buyerBy = new Map((buyer ?? []).map((b) => [b.query.trim().toLowerCase(), b]));
  const win = groups.find((g) => g.gsc)?.gsc?.window ?? null;
  // Follow the first pending group (replay), else the newest one.
  const followKey = groups.find((g) => g.pending)?.queryKey ?? groups[groups.length - 1]?.queryKey ?? "";
  const followRef = useRef<HTMLTableRowElement>(null);
  useFollowRow(followRef, `${groups.length}|${followKey}`);
  const seenPending = useSeenPending(groups.filter((g) => g.pending).map((g) => g.queryKey));
  return (
    <Panel
      num="03"
      title="Queries classified by Jev"
      accent="sky"
      reduced={reduced}
      testId="queries"
      counter={{ value: relevant, suffix: "relevant", sub: `of ${fmtInt(distinct)} queries classified` }}
      subtitle="Search Console queries, one narrow Jev question each. No search volume or difficulty: there is no source for them."
    >
      {groups.length === 0 ? (
        <PanelEmpty>{finished ? "No query was classified in this run. Query classification needs Jev and Search Console data." : "Waiting for stored query answers."}</PanelEmpty>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">Queries classified by Jev in this run, in time order; the newest is at the bottom</caption>
          <thead className={THEAD}>
            <tr>
              <LTH className="w-[36%]" title={`${win ? `Clicks · impressions · position: Search Console, ${windowShort(win)} (measured)` : "Search Console (measured)"} · ${LIVE_TEXT.lowerBound}`}>
                Query
                <span className="block text-[10px]">{win ? `clicks · impr. · pos., GSC ${windowShort(win)}` : "clicks · impr. · pos."}</span>
              </LTH>
              <LTH className="w-[25%]">Relevant?</LTH>
              <LTH className="w-[29%]">Intent</LTH>
              <LTH className="w-[10%]">Buyer?</LTH>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {groups.map((g) => {
              const b = buyerBy.get(g.query.trim().toLowerCase());
              const freshId = [g.relevance, g.intent, g.buyer, g.buyerReady].find((r) => r && fresh.has(r.id))?.id ?? null;
              return (
                <tr
                  key={g.queryKey}
                  ref={g.queryKey === followKey ? followRef : undefined}
                  data-pending={g.pending ? "true" : undefined}
                  className={cx(!g.pending && ACCENT.sky.row, freshId && (seenPending.has(g.queryKey) ? "lv-resolve" : "lv-row-in"), g.pending && "text-zinc-500 dark:text-zinc-400")}
                  style={freshId ? staggerStyle(fresh, freshId) : undefined}
                >
                  <LTD className="text-zinc-900 dark:text-zinc-100" title={g.query}>
                    <span className="block truncate">{g.query}</span>
                    <span aria-hidden={g.pending || undefined} className={cx("block truncate font-mono text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400", g.pending && "lv-blur")}>
                      {g.gsc ? `${lowerBoundPrefix(g.gsc)}${fmtInt(g.gsc.clicks)} · ${lowerBoundPrefix(g.gsc)}${fmtInt(g.gsc.impressions)} · ${positionText(g.gsc)}` : "no GSC row"}
                    </span>
                  </LTD>
                  <LTD className="overflow-visible">{g.pending ? pendingLabel === "Up next" ? <PendingChip label={pendingLabel} /> : <Shimmer label={pendingLabel} /> : <JevCell row={g.relevance} kind="band" />}</LTD>
                  <LTD className="overflow-visible">{g.pending ? null : <JevCell row={g.intent} kind="choice" />}</LTD>
                  <LTD>
                    {g.pending ? null : b ? (
                      <ToneChip tone="info" title={`Cached buyer label (${b.intentTier})`}>
                        {b.intent === "transactional" ? "Buyer" : "Researching"}
                      </ToneChip>
                    ) : g.buyer ? (
                      <ToneChip tone={g.buyer.band === "yes" ? "info" : "none"}>{g.buyer.band === "yes" ? "Buyer" : g.buyer.band === "no" ? "No" : "Unsure"}</ToneChip>
                    ) : (
                      <span className="text-zinc-400 dark:text-zinc-500">—</span>
                    )}
                  </LTD>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
