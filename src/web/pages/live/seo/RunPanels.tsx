/**
 * SEO stage panels fed by this run's own stored rows: 01 Pages being read (page_read items), 02 Search
 * Console sync (the run's gsc_syncs row + GET /seo/overview), 03 Queries classified by Jev (LiveSeoQueryRow).
 * Plain text only; measured values with their window; no volume, difficulty or projection.
 */
import { useState } from "react";
import { Link } from "react-router";
import type { ActivityItem, BuyerQueryRow, LiveGscSync, LiveSeoQueryRow, RunActivity, SeoOverview } from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx, ErrorState, StateBanner } from "@web/components/ui";
import { LineChart } from "@web/components/LineChart";
import { DemandCurveChart } from "@web/components/DemandCurveChart";
import type { QueryGroup, SegmentStatus } from "../engine";
import { Crossfade, Shimmer } from "../motion";
import { JevChip, LTD, LTH, Panel, PanelEmpty, ToneChip, type ToneName } from "../parts";
import { bandLabel, clipText, fmtInt, jevChipText, positionText, shortDate, urlHost, urlPath, windowShort } from "../text";

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
      counter={{ value: pagesRead, suffix: pagesPlanned !== null ? `/ ${fmtInt(pagesPlanned)} pages` : "pages read", sub: pagesPlanned !== null ? `of the ${fmtInt(pagesPlanned)}-page limit` : undefined }}
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
            <Crossfade k={nowReading.url} className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2 dark:border-sky-900 dark:bg-sky-950/40">
              <p className="text-[11px] text-zinc-600 dark:text-zinc-400">Now reading · {urlHost(nowReading.url)}</p>
              <p className="lv-rise truncate font-mono text-base font-semibold text-zinc-950 dark:text-zinc-50" title={nowReading.url}>
                {urlPath(nowReading.url)}
              </p>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Latest stored read; may trail the crawler by up to 10 pages.</p>
            </Crossfade>
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
  const earlier = overview?.syncedAt && sync?.syncedAt && overview.syncedAt !== sync.syncedAt ? `From an earlier sync (${shortDate(overview.syncedAt)})` : null;
  const captions = [
    sync ? SOURCE_LABEL[sync.source] ?? sync.source : overview?.source ? SOURCE_LABEL[overview.source] ?? overview.source : null,
    sync ? `Sync ${sync.status.replace(/_/g, " ")}` : step === "running" ? "Sync running" : null,
    sync ? `Rows ${fmtInt(sync.rowsFetched)} of ${fmtInt(sync.rowCap)}` : null,
    sync?.truncated ? "Truncated at cap" : null,
    overview?.current ? `${windowShort(overview.current)}${overview.previous ? ` vs ${windowShort(overview.previous)}` : ""}` : null,
    earlier,
    replaying ? "Charts: current stored state" : null,
  ].filter((x): x is string => !!x);
  return (
    <Panel
      num="02"
      title="Search Console sync"
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
          {sync?.status === "failed" && <StateBanner state="failed" title="Sync failed" message={clipText(sync.error, 200) || undefined} />}
          {step === "skipped" && !sync && <p className="text-xs text-zinc-700 dark:text-zinc-300">{clipText(stepMessage, 200) || "The Search Console step was skipped."}</p>}
          {overviewError !== null && overviewError !== undefined && !overview ? (
            <ErrorState error={overviewError} title="Could not load Search Console data" />
          ) : !overview ? (
            <Shimmer label="Loading stored Search Console data…" />
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums sm:grid-cols-4">
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
function JevCell({ row, kind }: { row: LiveSeoQueryRow | null; kind: "band" | "choice" | "buyer" }) {
  if (!row) return <span className="text-zinc-400 dark:text-zinc-500">—</span>;
  const chip = jevChipText(row.jev);
  let label: { label: string; tone: ToneName };
  if (kind === "choice") label = row.jev.choice ? { label: row.jev.choice.replace(/_/g, " "), tone: row.jev.tier === "act" ? "info" : "review" } : { label: "No answer", tone: "none" };
  else if (kind === "band" && row.jev.tier === "drop") label = { label: "Dropped (not relevant)", tone: "none" };
  else label = bandLabel(row.band);
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <ToneChip tone={label.tone}>{label.label}</ToneChip>
      <JevChip text={chip} tier={row.jev.tier} title={[row.jev.questionId, row.jev.provider, row.jev.model].filter(Boolean).join(" · ")} />
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
}: {
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
          <caption className="sr-only">Queries classified by Jev in this run</caption>
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <LTH className="w-[40%] sm:w-[32%]">Query</LTH>
              <LTH className="hidden w-[20%] sm:table-cell" title={win ? `Search Console, ${windowShort(win)}` : "Search Console"}>
                Clicks · Impr. · Pos.
              </LTH>
              <LTH className="w-[36%] sm:w-[22%]">Relevant?</LTH>
              <LTH className="hidden w-[14%] sm:table-cell">Intent</LTH>
              <LTH className="w-[24%] sm:w-[12%]">Buyer?</LTH>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {groups.map((g) => {
              const b = buyerBy.get(g.query.trim().toLowerCase());
              const isFresh = [g.relevance, g.intent, g.buyer, g.buyerReady].some((r) => r && fresh.has(r.id));
              return (
                <tr key={g.queryKey} className={cx(isFresh && "lv-row-in", g.pending && "opacity-70")}>
                  <LTD className="text-zinc-900 dark:text-zinc-100" title={g.query}>
                    <span className="block truncate">{g.query}</span>
                  </LTD>
                  <LTD className={cx("hidden font-mono tabular-nums text-zinc-700 sm:table-cell dark:text-zinc-300", g.pending && "lv-blur")}>
                    <span aria-hidden={g.pending || undefined}>{g.gsc ? `${fmtInt(g.gsc.clicks)} · ${fmtInt(g.gsc.impressions)} · ${positionText(g.gsc)}` : "—"}</span>
                  </LTD>
                  <LTD className="overflow-visible whitespace-normal">{g.pending ? <Shimmer label="Reading…" /> : <JevCell row={g.relevance} kind="band" />}</LTD>
                  <LTD className="hidden overflow-visible whitespace-normal sm:table-cell">{g.pending ? null : <JevCell row={g.intent} kind="choice" />}</LTD>
                  <LTD className="whitespace-normal">
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
