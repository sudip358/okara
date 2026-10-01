/**
 * GEO extra panels (docs/live-view-design.md section 5): 01 Prompt × engine (Hall-style heatmap of this run's
 * stored outcomes), 02 Inside the latest answer (Ira-style citation chips; raw answer as plain text with
 * brand spans as <mark>), 03 Cited instead, this run (first non-own citation per answer).
 */
import type { GeoObservationDetail, LiveGeoAnswerRow } from "@shared/types";
import { cx, ErrorState } from "@web/components/ui";
import { segmentText, sourceTypeLabel } from "@web/pages/geo/lib";
import { engineName } from "@web/pages/geo/board/lib";
import type { CitedInsteadBar, HeatCell } from "../engine";
import { Crossfade, Shimmer } from "../motion";
import { EngineBadge, Panel, PanelEmpty } from "../parts";
import { clipText, fmtInt, replayDate } from "../text";

const CELL: Record<string, { letter: string; word: string; cls: string }> = {
  cited: { letter: "C", word: "Cited", cls: "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-zinc-950" },
  named: { letter: "N", word: "Named", cls: "bg-amber-400 text-zinc-950 dark:bg-amber-400" },
  missing: { letter: "M", word: "Missing", cls: "bg-rose-600 text-white dark:bg-rose-500 dark:text-zinc-950" },
  failed: { letter: "F", word: "Failed", cls: "bg-zinc-500 text-white dark:bg-zinc-500" },
};

export function HeatmapPanel({
  prompts,
  lanes,
  cell,
  reduced,
  fresh,
  onOpen,
  captions,
}: {
  prompts: Array<{ promptId: string; text: string }>;
  lanes: Array<{ provider: string; label: string }>;
  cell: (promptId: string, provider: string) => HeatCell;
  reduced: boolean;
  fresh: ReadonlySet<string>;
  onOpen?: (id: string, title: string) => void;
  captions: string[];
}) {
  const shown = prompts.slice(0, 40);
  let answered = 0;
  for (const p of shown) for (const l of lanes) if (cell(p.promptId, l.provider).kind === "answer") answered++;
  return (
    <Panel
      num="01"
      title="Prompt × engine"
      accent="sky"
      reduced={reduced}
      testId="heatmap"
      counter={{ value: answered, suffix: `of ${fmtInt(shown.length * lanes.length)} pairs answered`, sub: "this run, stored outcomes" }}
      subtitle="Outcome of this run's answer for each approved prompt and engine: C cited, N named, M missing, F failed."
      captions={captions}
    >
      {shown.length === 0 || lanes.length === 0 ? (
        <PanelEmpty>No planned prompts for this run.</PanelEmpty>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">Outcome per approved prompt and engine, this run</caption>
          <thead>
            <tr>
              <th scope="col" className="w-[55%] pb-1 text-left font-mono text-[11px] font-normal text-zinc-500 dark:text-zinc-400">
                Approved prompt
              </th>
              {lanes.map((l) => (
                <th key={l.provider} scope="col" className="pb-1 text-center">
                  <EngineBadge provider={l.provider} label={l.label} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.promptId}>
                <th scope="row" className="truncate py-0.5 pr-2 text-left font-normal text-zinc-800 dark:text-zinc-200" title={p.text}>
                  {clipText(p.text, 120)}
                </th>
                {lanes.map((l) => {
                  const c = cell(p.promptId, l.provider);
                  const name = engineName(l.provider);
                  let body;
                  if (c.kind === "answer") {
                    const m = CELL[c.outcome]!;
                    body = (
                      <button
                        type="button"
                        aria-label={`${name}, ${m.word}: '${clipText(p.text, 80)}'`}
                        onClick={() => onOpen?.(c.answer.observationId, c.answer.promptText)}
                        className={cx("block h-5 w-full rounded-sm font-mono text-[10px] font-bold focus-visible:outline-2 focus-visible:outline-sky-600", m.cls, fresh.has(c.answer.id) && "lv-fade")}
                      >
                        {m.letter}
                      </button>
                    );
                  } else if (c.kind === "analysing") {
                    body = <span className="lv-shimmer block h-5 w-full rounded-sm" title={`${name}: analysing`} aria-label={`${name}: analysing`} role="img" />;
                  } else if (c.kind === "pending") {
                    body = <span className="lv-shimmer block h-5 w-full rounded-sm opacity-60" title={`${name}: asking`} aria-label={`${name}: asking`} role="img" />;
                  } else if (c.kind === "not_run") {
                    body = <span className="lv-hatch block h-5 w-full rounded-sm" title={`${name}: not run`} aria-label={`${name}: not run`} role="img" />;
                  } else {
                    body = <span className="block h-5 w-full rounded-sm bg-zinc-100 dark:bg-zinc-800" aria-label={`${name}: no answer yet`} role="img" />;
                  }
                  return (
                    <td key={l.provider} className="px-0.5 py-0.5 text-center">
                      {body}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function LatestAnswerPanel({
  answer,
  detail,
  error,
  reduced,
  ownHost,
}: {
  answer: LiveGeoAnswerRow | null;
  detail: GeoObservationDetail | null;
  error: unknown;
  reduced: boolean;
  ownHost: string;
}) {
  const self = detail?.brands.find((b) => b.isSelf) ?? null;
  const text = detail?.rawAnswer ? detail.rawAnswer.slice(0, 1200) : "";
  const segs = detail ? segmentText(text, detail.brands.map((b) => ({ brandKey: b.brandKey, isSelf: b.isSelf, spans: b.spans }))) : [];
  const cites = detail ? detail.citations.slice().sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9)) : [];
  return (
    <Panel num="02" title="Inside the latest answer" accent="sky" reduced={reduced} testId="latest-answer" subtitle="API-sampled answer, as stored. Brand mentions are highlighted; nothing is rewritten." captions={["API-sampled answer"]}>
      {!answer ? (
        <PanelEmpty>No stored answer yet.</PanelEmpty>
      ) : error && !detail ? (
        <ErrorState error={error} title="Could not load the stored answer" />
      ) : !detail ? (
        <Shimmer label="Loading the stored answer…" />
      ) : (
        <Crossfade k={detail.id} className="space-y-2 text-xs">
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
            <EngineBadge provider={detail.provider} />
            <span className="break-all font-mono">{detail.model}</span>
            <span>· stored {replayDate(detail.createdAt)}</span>
          </p>
          <p className="font-semibold text-zinc-900 dark:text-zinc-100">“{clipText(detail.promptText, 200)}”</p>
          <p className="max-h-40 overflow-y-auto rounded bg-zinc-50 p-2 leading-relaxed whitespace-pre-wrap text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
            {text
              ? segs.map((s, i) =>
                  s.brandKey ? (
                    <mark key={i} className={s.isSelf ? "rounded bg-emerald-200 px-0.5 text-zinc-950 dark:bg-emerald-500/40 dark:text-zinc-50" : "rounded bg-zinc-200 px-0.5 text-zinc-950 dark:bg-zinc-700 dark:text-zinc-50"}>
                      {s.text}
                    </mark>
                  ) : (
                    <span key={i}>{s.text}</span>
                  ),
                )
              : "No answer text stored."}
            {detail.rawAnswer && detail.rawAnswer.length > 1200 ? "…" : ""}
          </p>
          <div>
            <p className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">Citations ({fmtInt(cites.length)})</p>
            <ul className="mt-0.5 flex flex-wrap gap-1">
              {cites.map((c, i) => {
                const own = (self && c.brandKey === self.brandKey) || (ownHost && c.host === ownHost);
                return (
                  <li
                    key={`${c.url}-${i}`}
                    title={c.url}
                    className={cx(
                      "inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]",
                      own ? "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200" : "border-zinc-200 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300",
                    )}
                  >
                    {c.position !== null && <span className="font-mono text-zinc-500">{c.position}</span>}
                    <span className="truncate">{c.host}</span>
                    <span className="text-zinc-500 dark:text-zinc-400">{sourceTypeLabel(c.sourceType)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
            Engine searches: {detail.searchQueries === null ? "Not exposed by this provider" : detail.searchQueries.length ? detail.searchQueries.slice(0, 5).map((q) => `“${clipText(q, 60)}”`).join(", ") : "none"}
          </p>
        </Crossfade>
      )}
    </Panel>
  );
}

export function CitedInsteadPanel({ bars, reduced }: { bars: CitedInsteadBar[]; reduced: boolean }) {
  const max = bars[0]?.count ?? 0;
  return (
    <Panel
      num="03"
      title="Cited instead, this run"
      accent="amber"
      reduced={reduced}
      testId="cited-instead"
      counter={bars[0] ? { value: bars[0].count, suffix: "answers", sub: `top host: ${bars[0].host}` } : null}
      subtitle="First non-own citation per answer, this run."
    >
      {bars.length === 0 ? (
        <PanelEmpty>No answer of this run cited another site instead yet.</PanelEmpty>
      ) : (
        <ol className="space-y-1.5">
          {bars.map((b) => (
            <li key={b.host} className="min-w-0 text-xs">
              <p className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium text-zinc-900 dark:text-zinc-100" title={b.host}>
                  {b.host} <span className="font-normal text-zinc-500 dark:text-zinc-400">{sourceTypeLabel(b.sourceType)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {b.providers.map((p) => (
                    <EngineBadge key={p} provider={p} />
                  ))}
                  <span className="font-mono tabular-nums">{fmtInt(b.count)}</span>
                </span>
              </p>
              <span aria-hidden="true" className="mt-0.5 block h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <span className="lv-bar block h-full rounded-full bg-amber-600 dark:bg-amber-400" style={{ width: `${max ? Math.round((b.count / max) * 100) : 0}%` }} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
