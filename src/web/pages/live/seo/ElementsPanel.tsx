/**
 * 04 Every SEO element, judged one by one (Rankie panel 01, docs/live-view-design.md section 4). Each row is
 * a STORED judgment (Jev decision or audit rule finding of this run); the verdict was computed by code from
 * the stored tier and raw answer. "Now" is the page snapshot value, "proposed" the drafted snippet (arrow
 * only once drafted). Measured GSC clicks and approximate position, never projected. "Reading…" appears only
 * on replay rows whose stored time has not been reached, or as at most 3 unlabelled skeletons while the
 * recommend step is genuinely running. Rows are in time order: resolved rows, newest at the bottom, then the
 * pending ones under them; the panel follows the newest row unless the viewer scrolled it.
 */
import { useId, useRef, useState } from "react";
import { Link } from "react-router";
import type { LiveSeoElement, LiveSeoVerdict } from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx } from "@web/components/ui";
import type { ElementDisplayRow } from "../engine";
import { Shimmer, staggerStyle, useFollowRow, useSeenPending } from "../motion";
import { ACCENT, JevChip, LTD, LTH, Panel, PanelEmpty, THEAD, VerdictChip } from "../parts";
import { LIVE_TEXT, clicksText, clipText, fmtInt, jevChipText, jevTooltip, positionText, windowShort } from "../text";

type Filter = "all" | LiveSeoVerdict;

/** "Now → proposed" in one line; a row with a follow-up action shows "Next: …" after the value (single-line rows). */
function NowProposed({ now, proposed, next = null }: { now: string | null; proposed: string | null; next?: string | null }) {
  if (next && !proposed) {
    return (
      <span className="block truncate" title={`${now ?? "—"} · ${next}`}>
        <span className="text-zinc-600 dark:text-zinc-400">{now ? clipText(now, 80) : "—"}</span>
        <span className="pl-1.5 text-[11px] font-medium text-sky-800 dark:text-sky-300">{next}</span>
      </span>
    );
  }
  if (proposed) {
    return (
      <span className="block truncate" title={`${now ?? "—"} → ${proposed}`}>
        {now && <s className="text-zinc-400 dark:text-zinc-500">{clipText(now, 80)}</s>}
        <span aria-hidden="true" className="px-1 text-zinc-500">
          →
        </span>
        <span className="sr-only"> proposed: </span>
        <span className="font-semibold text-zinc-950 dark:text-zinc-50">{clipText(proposed, 160)}</span>
      </span>
    );
  }
  return (
    <span className="block truncate text-zinc-600 dark:text-zinc-400" title={now ?? undefined}>
      {now ? clipText(now, 160) : "—"}
    </span>
  );
}

export function ElementsPanel({
  rows,
  change,
  judged,
  skeletons,
  fresh,
  reduced,
  projectId,
  runId,
  notReplayed,
  jevMissing,
  pendingLabel = "Reading…",
}: {
  /** Replay pending rows: "Reading…" (shimmer) while the step runs, else "Up next" (static). */
  pendingLabel?: "Reading…" | "Up next";
  rows: ElementDisplayRow[];
  change: number;
  judged: number;
  /** Live only: unlabelled pending rows while seo.recommend runs (0–3). */
  skeletons: number;
  fresh: ReadonlySet<string>;
  reduced: boolean;
  projectId: string;
  runId: string;
  /** Replay end: server totals differ from replayed rows (caps). */
  notReplayed: number;
  /** No Jev rows at all in a finished run: rule findings only. */
  jevMissing: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [element, setElement] = useState<LiveSeoElement | "">("");
  const selectId = useId();
  const elements = Array.from(new Set(rows.map((r) => r.row.element))).sort();
  const shown = rows.filter((r) => (r.pending || filter === "all" || r.row.verdict === filter) && (!element || r.row.element === element));
  const win = rows.find((r) => r.row.gsc && !r.pending)?.row.gsc?.window ?? null;
  const lowerBound = rows.some((r) => !r.pending && r.row.gsc?.basis === "query_page_rows");
  // Follow the first pending row (replay), else the newest row.
  const followId = shown.find((r) => r.pending)?.row.id ?? shown[shown.length - 1]?.row.id ?? "";
  const followRef = useRef<HTMLTableRowElement>(null);
  useFollowRow(followRef, `${shown.length}|${followId}`);
  const seenPending = useSeenPending(rows.filter((r) => r.pending).map((r) => r.row.id));
  return (
    <Panel
      num="04"
      title="Every SEO element, judged one by one"
      accent="sky"
      reduced={reduced}
      testId="elements"
      counter={{ value: change, suffix: "to change", sub: `of ${fmtInt(judged)} judged in this run${notReplayed > 0 ? ` (${fmtInt(notReplayed)} rows not replayed)` : ""}` }}
      subtitle={jevMissing ? `${LIVE_TEXT.elementsSubtitle} ${LIVE_TEXT.noJevAnswers}` : LIVE_TEXT.elementsSubtitle}
      captions={win ? [`Search Console ${windowShort(win)} · ≈ = page aggregate${lowerBound ? " · ≥ = lower bound" : ""}`] : undefined}
      toolbar={
        <>
        <div role="group" aria-label="Filter by verdict" className="flex gap-1">
          {(["all", "change", "keep", "review"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={cx(
                "rounded px-2 py-0.5 text-[11px] font-medium capitalize focus-visible:outline-2 focus-visible:outline-sky-600",
                filter === f ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300",
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <label htmlFor={selectId} className="sr-only">
          Element
        </label>
        <select
          id={selectId}
          value={element}
          onChange={(e) => setElement(e.target.value as LiveSeoElement | "")}
          className="rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[11px] text-zinc-800 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
        >
          <option value="">All elements</option>
          {elements.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        </>
      }
    >
      {rows.length === 0 && skeletons === 0 ? (
        <PanelEmpty>No element judged in this run yet.</PanelEmpty>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">Stored element judgments in time order; the newest is at the bottom</caption>
          <thead className={THEAD}>
            <tr>
              <LTH className="w-[44%] @lg:w-[22%] @xl:w-[19%]">Page</LTH>
              <LTH className="w-[24%] @lg:w-[11%] @xl:w-[10%]">Element</LTH>
              <LTH className="hidden @lg:table-cell @lg:w-[31%] @xl:w-[23%]">Now → proposed</LTH>
              <LTH tight className="hidden text-right @xl:table-cell @xl:w-[7%]" title="Average position from Search Console (≈ for page aggregates)">
                Pos.
              </LTH>
              <LTH
                tight
                className="hidden text-right @xl:table-cell @xl:w-[8%]"
                title={`${win ? `Clicks (GSC, ${windowShort(win)}); measured, not projected` : "Clicks (GSC); measured"} · ${LIVE_TEXT.lowerBound}`}
              >
                Clicks
              </LTH>
              <LTH className="hidden @lg:table-cell @lg:w-[19%] @xl:w-[19%]">Jev</LTH>
              <LTH className="w-[32%] @lg:w-[17%] @xl:w-[14%]">Verdict</LTH>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: skeletons }, (_, i) => (
              <tr key={`sk${i}`} className="border-b border-zinc-100 dark:border-zinc-800">
                <td colSpan={7} className="py-1.5">
                  <Shimmer label={LIVE_TEXT.waitingJudgment} className="w-full" />
                </td>
              </tr>
            ))}
            {shown.map(({ row, next, pending }) => {
              const target = row.pagePath ?? row.targetLabel;
              const jev = jevChipText(row.jev, row.rule);
              const tier = row.jev?.tier ?? null;
              const href = row.recommendationId ? projectPath(projectId, `recommendations/${encodeURIComponent(row.recommendationId)}`) : projectPath(projectId, `runs/${encodeURIComponent(runId)}`);
              const isFresh = !pending && fresh.has(row.id);
              return (
                <tr
                  key={row.id}
                  ref={row.id === followId ? followRef : undefined}
                  data-pending={pending ? "true" : undefined}
                  className={cx(
                    "border-b border-zinc-100 dark:border-zinc-800",
                    !pending && ACCENT.sky.row,
                    isFresh && (seenPending.has(row.id) ? "lv-resolve" : "lv-row-in"),
                    pending && "text-zinc-500 dark:text-zinc-400",
                  )}
                  style={isFresh ? staggerStyle(fresh, row.id) : undefined}
                >
                  <LTD
                    className={cx(
                      "font-mono text-zinc-900 dark:text-zinc-100",
                      // The "change" bar is an inset shadow, not a border: collapsed borders are painted by the
                      // table and would show before the row has faded in.
                      !pending && row.verdict === "change" && "shadow-[inset_2px_0_0_var(--color-rose-600)] dark:shadow-[inset_2px_0_0_var(--color-rose-400)]",
                    )}
                    title={target}
                  >
                    {pending ? (
                      <span className="block truncate pl-1.5">{target}</span>
                    ) : (
                      <Link to={href} className="block truncate pl-1.5 text-inherit no-underline hover:underline" title={row.recommendationId ? `Open the recommendation for ${target}` : `Open the run's decision log (${target})`}>
                        {target}
                      </Link>
                    )}
                    {!pending && (
                      <span className="block truncate pl-1.5 font-sans text-[11px] text-zinc-600 @lg:hidden dark:text-zinc-400">
                        {row.proposed ? `→ ${clipText(row.proposed, 80)}` : clipText(row.now, 80) || jev}
                      </span>
                    )}
                    {next && !pending && <span className="block truncate pl-1.5 font-sans text-[11px] text-sky-800 @lg:hidden dark:text-sky-300">{next}</span>}
                  </LTD>
                  <LTD className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{row.element}</LTD>
                  <LTD className={cx("hidden @lg:table-cell", pending && "lv-blur")}>
                    <span aria-hidden={pending || undefined}>{pending ? clipText(row.now, 60) || "…" : <NowProposed now={row.now} proposed={row.proposed} next={next} />}</span>
                  </LTD>
                  <LTD tight className={cx("hidden text-right font-mono text-[11px] tabular-nums text-zinc-700 @xl:table-cell dark:text-zinc-300", pending && "lv-blur")}>
                    <span aria-hidden={pending || undefined}>{positionText(row.gsc)}</span>
                  </LTD>
                  <LTD tight className={cx("hidden text-right font-mono text-[11px] tabular-nums text-zinc-700 @xl:table-cell dark:text-zinc-300", pending && "lv-blur")}>
                    <span aria-hidden={pending || undefined}>{clicksText(row.gsc)}</span>
                  </LTD>
                  <LTD className={cx("hidden @lg:table-cell", pending && "lv-blur")}>
                    {pending ? <span aria-hidden="true" className="font-mono text-[11px]">Jev ···</span> : <JevChip text={jev} tier={row.rule ? "act" : tier} title={jevTooltip(row)} />}
                  </LTD>
                  <LTD className="overflow-visible">
                    <VerdictChip verdict={row.verdict} pending={pending} pendingLabel={pendingLabel} pendingStatic={pendingLabel === "Up next"} />
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
