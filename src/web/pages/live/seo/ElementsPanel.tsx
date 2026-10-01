/**
 * 04 Every SEO element, judged one by one (Rankie panel 01, docs/live-view-design.md section 4). Each row is
 * a STORED judgment (Jev decision or audit rule finding of this run); the verdict was computed by code from
 * the stored tier and raw answer. "Now" is the page snapshot value, "proposed" the drafted snippet (arrow
 * only once drafted). Measured GSC clicks and approximate position, never projected. "Reading…" appears only
 * on replay rows whose stored time has not been reached, or as at most 3 unlabelled skeletons while the
 * recommend step is genuinely running.
 */
import { useId, useState } from "react";
import { Link } from "react-router";
import type { LiveSeoElement, LiveSeoVerdict } from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx } from "@web/components/ui";
import type { ElementDisplayRow } from "../engine";
import { Shimmer } from "../motion";
import { JevChip, LTD, LTH, Panel, PanelEmpty, VerdictChip } from "../parts";
import { LIVE_TEXT, clicksText, clipText, fmtInt, jevChipText, jevTooltip, positionText, windowShort } from "../text";

type Filter = "all" | LiveSeoVerdict;

function NowProposed({ now, proposed }: { now: string | null; proposed: string | null }) {
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
}: {
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
  return (
    <Panel
      num="04"
      title="Every SEO element, judged one by one"
      accent="sky"
      reduced={reduced}
      testId="elements"
      counter={{ value: change, suffix: "to change", sub: `of ${fmtInt(judged)} judged in this run${notReplayed > 0 ? ` (${fmtInt(notReplayed)} rows not replayed)` : ""}` }}
      subtitle={jevMissing ? `${LIVE_TEXT.elementsSubtitle} Jev not configured: rule findings only.` : LIVE_TEXT.elementsSubtitle}
    >
      <div className="sticky top-0 z-10 -mx-4 mb-1 flex flex-wrap items-center gap-1.5 bg-white/95 px-4 py-1.5 dark:bg-zinc-900/95">
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
      </div>
      {rows.length === 0 && skeletons === 0 ? (
        <PanelEmpty>No element judged in this run yet.</PanelEmpty>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">Stored element judgments, newest first</caption>
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <LTH className="w-[44%] sm:w-[26%] md:w-[22%]">Page</LTH>
              <LTH className="w-[24%] sm:w-[12%] md:w-[11%]">Element</LTH>
              <LTH className="hidden sm:table-cell sm:w-[32%] md:w-[24%]">Now → proposed</LTH>
              <LTH className="hidden text-right md:table-cell md:w-[9%]" title="Average position from Search Console (≈ for page aggregates)">
                Pos.
                <span className="block text-[10px]">GSC ≈</span>
              </LTH>
              <LTH className="hidden text-right md:table-cell md:w-[8%]" title={win ? `Clicks (GSC, ${windowShort(win)}); measured, not projected` : "Clicks (GSC); measured"}>
                Clicks
                <span className="block text-[10px]">{win ? `GSC ${windowShort(win)}` : "GSC"}</span>
              </LTH>
              <LTH className="hidden sm:table-cell sm:w-[18%] md:w-[16%]">Jev</LTH>
              <LTH className="w-[32%] sm:w-[12%] md:w-[10%]">Verdict</LTH>
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
              return (
                <tr
                  key={row.id}
                  data-pending={pending ? "true" : undefined}
                  className={cx(
                    "border-b border-zinc-100 dark:border-zinc-800",
                    !pending && fresh.has(row.id) && "lv-row-in",
                    pending && "text-zinc-500 dark:text-zinc-400",
                  )}
                >
                  <LTD
                    className={cx(
                      "border-l-2 font-mono text-zinc-900 dark:text-zinc-100",
                      !pending && row.verdict === "change" ? "border-l-rose-600 dark:border-l-rose-400" : "border-l-transparent",
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
                      <span className="block truncate pl-1.5 font-sans text-[11px] text-zinc-600 sm:hidden dark:text-zinc-400">
                        {row.proposed ? `→ ${clipText(row.proposed, 80)}` : clipText(row.now, 80) || jev}
                      </span>
                    )}
                    {next && !pending && <span className="block truncate pl-1.5 font-sans text-[11px] text-sky-800 dark:text-sky-300">{next}</span>}
                  </LTD>
                  <LTD className="font-mono text-zinc-600 dark:text-zinc-400">{row.element}</LTD>
                  <LTD className={cx("hidden sm:table-cell", pending && "lv-blur")}>
                    <span aria-hidden={pending || undefined}>{pending ? clipText(row.now, 60) || "…" : <NowProposed now={row.now} proposed={row.proposed} />}</span>
                  </LTD>
                  <LTD className={cx("hidden text-right font-mono tabular-nums text-zinc-700 md:table-cell dark:text-zinc-300", pending && "lv-blur")}>
                    <span aria-hidden={pending || undefined}>{positionText(row.gsc)}</span>
                  </LTD>
                  <LTD className={cx("hidden text-right font-mono tabular-nums text-zinc-700 md:table-cell dark:text-zinc-300", pending && "lv-blur")}>
                    <span aria-hidden={pending || undefined}>{clicksText(row.gsc)}</span>
                  </LTD>
                  <LTD className={cx("hidden sm:table-cell", pending && "lv-blur")}>
                    {pending ? <span aria-hidden="true" className="font-mono text-[11px]">Jev ···</span> : <JevChip text={jev} tier={row.rule ? "act" : tier} title={jevTooltip(row)} />}
                  </LTD>
                  <LTD className="overflow-visible">
                    <VerdictChip verdict={row.verdict} pending={pending} />
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
