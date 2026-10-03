/**
 * GEO project containers (docs/live-view-design.md section 17): 06 what the AI engines searched for, 07 brands
 * in AI answers, 08 most-cited domains, 09 prompt history. API-sampled stored answers of the last 30 days (09:
 * each engine's last runs). Counts are "n of m answers" with both numbers; no share or rate beyond that; the
 * Search Console marker is an exact match only. Queries, prompts, hosts and brand names are plain text.
 */
import type { LiveBrandCounts, LiveBrandsInsight, LiveCitedDomainRow, LiveCitedDomainsInsight, LiveEngineQueriesInsight, LivePromptHistoryInsight } from "@shared/types";
import { cx } from "@web/components/ui";
import { engineName } from "@web/pages/geo/board/lib";
import { sourceTypeLabel } from "@web/pages/geo/lib";
import { ACCENT, EngineBadge, LTD, LTH, Panel, PanelEmpty, THEAD, ToneChip } from "../parts";
import { clipText, fmtInt, shortDate, windowShort } from "../text";
import { LoadState, Notes, SetupNote, ShowingNote, captionsFor, type Loadable } from "./common";
import { useInsight, useLiveMore } from "./data";
import { HISTORY_CELL, gscMatchText, historyLabel, instantRange, nOfM } from "./format";

const windowCaption = (w: { from: string; to: string; days: number }) => `From your stored answers, ${instantRange(w.from, w.to)} (${w.days} days), not only this run`;

function Engines({ list }: { list: readonly string[] }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-0.5">
      {list.map((e) => (
        <EngineBadge key={e} provider={e} />
      ))}
    </span>
  );
}

// ------------------------------------------------------------------ 06 what the AI engines searched for
export function EngineQueriesPanel({ state, reduced, replaying }: { state: Loadable<LiveEngineQueriesInsight>; reduced: boolean; replaying: boolean }) {
  const d = state.data;
  const captions = captionsFor(
    [d ? windowCaption(d.window) : null, d ? (d.gscSync ? `Search Console: exact matches, sync of ${shortDate(d.gscSync.syncedAt)} (${windowShort(d.gscSync.window)})` : "No Search Console sync: matches not checked") : null],
    replaying,
    d?.labels ?? [],
  );
  return (
    <Panel
      num="06"
      title="What the AI engines searched for"
      accent="sky"
      reduced={reduced}
      testId="engine-queries"
      counter={d ? { value: d.total, suffix: "searches", sub: `distinct, last ${d.window.days} days` } : null}
      subtitle="The web searches engines ran while answering your approved prompts (only engines that expose them). An exact match in your Search Console sync is marked; nothing is inferred."
      captions={captions}
    >
      {!d ? (
        <LoadState state={state} what="engine searches" />
      ) : d.rows.length === 0 ? (
        <>
          <PanelEmpty>No engine searches stored in the last {d.window.days} days.</PanelEmpty>
          <Notes labels={d.labels} />
        </>
      ) : (
        <>
          <table className="w-full table-fixed border-collapse text-xs">
            <caption className="sr-only">Engine searches, the engines and answers that ran them, and an exact Search Console match</caption>
            <thead className={THEAD}>
              <tr>
                <LTH className="w-[44%] @lg:w-[30%]">Search</LTH>
                <LTH className="hidden @lg:table-cell @lg:w-[10%]">Engines</LTH>
                <LTH className="w-[16%] text-right @lg:w-[11%]" title="Distinct stored answers whose engine ran this search">
                  Answers
                </LTH>
                <LTH className="hidden @lg:table-cell @lg:w-[14%]">Last seen</LTH>
                <LTH className="w-[40%] @lg:w-[35%]" title="Exact normalized match in the latest Search Console sync (current window), summed over your pages">
                  In your Search Console
                </LTH>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.rows.map((r) => (
                <tr key={r.query} className={r.gsc ? ACCENT.sky.row : undefined}>
                  <LTD className="text-zinc-900 dark:text-zinc-100" title={r.query}>
                    {r.query}
                  </LTD>
                  <LTD className="hidden @lg:table-cell">
                    <Engines list={r.engines} />
                  </LTD>
                  <LTD className="text-right font-mono tabular-nums">{fmtInt(r.answers)}</LTD>
                  <LTD className="hidden font-mono text-[11px] text-zinc-600 @lg:table-cell dark:text-zinc-400">{shortDate(r.lastSeen)}</LTD>
                  <LTD className="font-mono text-[11px]" title={r.gsc ? `Exact match · clicks ${r.gsc.clicks} · window ${r.gsc.window.start}–${r.gsc.window.end}` : "No exact match in the latest sync"}>
                    {r.gsc ? <span className="text-sky-800 dark:text-sky-300">{gscMatchText(r.gsc)}</span> : <span className="text-zinc-500 dark:text-zinc-400">—</span>}
                  </LTD>
                </tr>
              ))}
            </tbody>
          </table>
          <ShowingNote shown={d.rows.length} total={d.total} what="searches (most answers first)" />
          <Notes labels={d.labels} />
        </>
      )}
    </Panel>
  );
}

export function EngineQueriesContainer({ projectId, reduced }: { projectId: string; reduced: boolean }) {
  const v = useLiveMore();
  return <EngineQueriesPanel state={useInsight<LiveEngineQueriesInsight>(projectId, "engine_queries")} reduced={reduced} replaying={v.replaying} />;
}

// ------------------------------------------------------------------ 07 brands in AI answers
const COUNT_COLS: Array<{ key: keyof Omit<LiveBrandCounts, "answers">; label: string; long: string }> = [
  { key: "mentioned", label: "Named", long: "Mentioned in the answer" },
  { key: "cited", label: "Cited", long: "A citation of the brand's site" },
  { key: "recommended", label: "Recomm.", long: "Recommended (stored recommendation status)" },
  { key: "negative", label: "Negative", long: "Mentioned negatively (stored recommendation status)" },
];

export function BrandsPanel({ state, reduced, replaying }: { state: Loadable<LiveBrandsInsight>; reduced: boolean; replaying: boolean }) {
  const d = state.data;
  const self = d?.brands.find((b) => b.isSelf) ?? null;
  return (
    <Panel
      num="07"
      title="Brands in AI answers"
      accent="emerald"
      reduced={reduced}
      testId="brands"
      counter={self ? { value: self.total.mentioned, suffix: `of ${fmtInt(self.total.answers)} answers name you`, sub: "discovery prompts, last 30 days" } : null}
      subtitle="You and each tracked competitor across analysed answers: named, cited, recommended, mentioned negatively, as n of m answers per engine."
      captions={captionsFor([d ? windowCaption(d.window) : null], replaying, d?.labels ?? [])}
    >
      {!d ? (
        <LoadState state={state} what="brand mentions" />
      ) : d.brands.length === 0 ? (
        <>
          <PanelEmpty>No analysed answers to discovery prompts in the last {d.window.days} days.</PanelEmpty>
          <Notes labels={d.labels} />
        </>
      ) : (
        <>
          <table className="w-full table-fixed border-collapse text-xs">
            <caption className="sr-only">Brands in stored answers per engine, n of m analysed answers</caption>
            <thead className={THEAD}>
              <tr>
                <LTH className="w-[24%] @lg:w-[28%]">Engine</LTH>
                {COUNT_COLS.map((c) => (
                  <LTH key={c.key} tight className="w-[19%] text-right @lg:w-[18%]" title={c.long}>
                    {c.label}
                  </LTH>
                ))}
              </tr>
            </thead>
            {d.brands.map((b) => (
              <tbody key={b.brandKey} className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <tr className={b.isSelf ? ACCENT.emerald.row : "bg-zinc-50 dark:bg-zinc-800/40"}>
                  <th scope="rowgroup" colSpan={5} className="truncate py-1 text-left text-xs font-semibold text-zinc-900 dark:text-zinc-100" title={b.name}>
                    {b.isSelf ? `You · ${b.name}` : b.name}
                  </th>
                </tr>
                {[...b.engines.map((e) => ({ key: e.provider, label: null as string | null, provider: e.provider as string | null, c: e as LiveBrandCounts })), ...(b.engines.length > 1 ? [{ key: "total", label: "All engines", provider: null, c: b.total }] : [])].map((row) => (
                  <tr key={row.key}>
                    <LTD>
                      {row.provider ? (
                        <span className="flex min-w-0 items-center gap-1">
                          <EngineBadge provider={row.provider} />
                          <span className="hidden truncate text-[11px] text-zinc-600 @lg:inline dark:text-zinc-400">{engineName(row.provider)}</span>
                        </span>
                      ) : (
                        <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">{row.label}</span>
                      )}
                    </LTD>
                    {COUNT_COLS.map((c) => (
                      <LTD key={c.key} tight className="text-right font-mono text-[11px] tabular-nums" title={`${c.long}: ${nOfM(row.c[c.key], row.c.answers)} answers`}>
                        {nOfM(row.c[c.key], row.c.answers)}
                      </LTD>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          <Notes labels={d.labels} />
        </>
      )}
    </Panel>
  );
}

export function BrandsContainer({ projectId, reduced }: { projectId: string; reduced: boolean }) {
  const v = useLiveMore();
  return <BrandsPanel state={useInsight<LiveBrandsInsight>(projectId, "brands")} reduced={reduced} replaying={v.replaying} />;
}

// ------------------------------------------------------------------ 08 most-cited domains
function DomainRow({ r, of }: { r: LiveCitedDomainRow; of: number }) {
  return (
    <tr className={r.brand?.isSelf ? ACCENT.emerald.row : undefined}>
      <LTD className="text-right font-mono text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">{r.rank}</LTD>
      <LTD title={r.brand ? `${r.host} · ${r.brand.isSelf ? "your site" : `tracked competitor: ${r.brand.key}`}` : r.host}>
        <span className={cx("block truncate font-mono", r.brand?.isSelf ? "font-semibold text-emerald-800 dark:text-emerald-300" : "text-zinc-900 dark:text-zinc-100")}>{r.host}</span>
        {r.brand && (
          <ToneChip tone={r.brand.isSelf ? "keep" : "review"} className="mt-0.5">
            {r.brand.isSelf ? "Your site" : `Competitor: ${clipText(r.brand.key, 40)}`}
          </ToneChip>
        )}
      </LTD>
      <LTD className="text-right font-mono text-[11px] tabular-nums" title={`Cited in ${nOfM(r.answers, of)} answers with citations (${fmtInt(r.citations)} citations)`}>
        {nOfM(r.answers, of)}
      </LTD>
      <LTD className="hidden @lg:table-cell">
        <Engines list={r.engines} />
      </LTD>
      <LTD className="hidden text-[11px] text-zinc-600 @xl:table-cell dark:text-zinc-400" title={r.sourceTypes.map(sourceTypeLabel).join(", ")}>
        {r.sourceTypes[0] ? sourceTypeLabel(r.sourceTypes[0]) : "—"}
      </LTD>
    </tr>
  );
}

export function CitedDomainsPanel({ state, reduced, replaying }: { state: Loadable<LiveCitedDomainsInsight>; reduced: boolean; replaying: boolean }) {
  const d = state.data;
  return (
    <Panel
      num="08"
      title="Most-cited domains, last 30 days"
      accent="amber"
      reduced={reduced}
      testId="cited-domains"
      counter={d ? { value: d.totalHosts, suffix: "domains cited", sub: `in ${fmtInt(d.answersWithCitations)} answers with citations` } : null}
      subtitle="Hosts the engines cited in stored answers, by answers citing them. Your site is highlighted; tracked competitors are tagged."
      captions={captionsFor([d ? windowCaption(d.window) : null], replaying, d?.labels ?? [])}
    >
      {!d ? (
        <LoadState state={state} what="cited domains" />
      ) : d.rows.length === 0 ? (
        <>
          <PanelEmpty>No citations in stored answers of the last {d.window.days} days.</PanelEmpty>
          <Notes labels={d.labels} />
        </>
      ) : (
        <>
          <table className="w-full table-fixed border-collapse text-xs">
            <caption className="sr-only">Cited domains by answers citing them</caption>
            <thead className={THEAD}>
              <tr>
                <LTH className="w-[10%] text-right @lg:w-[7%]">#</LTH>
                <LTH className="w-[56%] @lg:w-[45%] @xl:w-[38%]">Domain</LTH>
                <LTH className="w-[34%] text-right @lg:w-[20%] @xl:w-[18%]" title="Answers citing the domain, of the answers with citations">
                  Answers
                </LTH>
                <LTH className="hidden @lg:table-cell @lg:w-[28%] @xl:w-[19%]">Engines</LTH>
                <LTH className="hidden @xl:table-cell @xl:w-[18%]">Source type</LTH>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.rows.map((r) => (
                <DomainRow key={r.host} r={r} of={d.answersWithCitations} />
              ))}
              {d.own && (
                <>
                  <tr aria-hidden="true">
                    <td colSpan={5} className="py-0.5 text-center text-[11px] text-zinc-400">
                      …
                    </td>
                  </tr>
                  <DomainRow r={d.own} of={d.answersWithCitations} />
                </>
              )}
            </tbody>
          </table>
          <ShowingNote shown={d.rows.length} total={d.totalHosts} what="domains" />
          {d.unresolved > 0 && (
            <p className="pt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {fmtInt(d.unresolved)} citation{d.unresolved === 1 ? " was a provider redirect link" : "s were provider redirect links"} without a domain title (not counted as a domain).
            </p>
          )}
          <Notes labels={d.labels} />
        </>
      )}
    </Panel>
  );
}

export function CitedDomainsContainer({ projectId, reduced }: { projectId: string; reduced: boolean }) {
  const v = useLiveMore();
  return <CitedDomainsPanel state={useInsight<LiveCitedDomainsInsight>(projectId, "cited_domains")} reduced={reduced} replaying={v.replaying} />;
}

// ------------------------------------------------------------------ 09 prompt history
export function PromptHistoryPanel({ state, reduced, projectId, replaying }: { state: Loadable<LivePromptHistoryInsight>; reduced: boolean; projectId: string; replaying: boolean }) {
  const d = state.data;
  const lastAt = d?.engines.flatMap((e) => e.runs.map((r) => r.at)).sort().pop() ?? null;
  return (
    <Panel
      num="09"
      title="Prompt history"
      accent="sky"
      reduced={reduced}
      testId="prompt-history"
      counter={d && d.rows.length > 0 ? { value: d.rows.length, suffix: "approved prompts", sub: `each engine's last ${d.maxRuns} runs` } : null}
      subtitle="The stored outcome of each approved prompt in each engine's last runs, oldest to newest: C cited · N named, site not cited · M absent · F no answer (failed) · ? not analysed · – nothing stored."
      captions={captionsFor(
        [lastAt ? `From your stored runs (latest ${shortDate(lastAt)}), not only this run${d?.promptSet ? ` · prompt set v${d.promptSet.version}${d.promptSet.label ? `, ${d.promptSet.label}` : ""}` : ""}` : null],
        replaying,
        d?.labels ?? [],
      )}
    >
      {!d ? (
        <LoadState state={state} what="prompt history" />
      ) : d.state === "setup_required" ? (
        <SetupNote message={d.message} projectId={projectId} to="geo/prompts" linkLabel="Approve prompts" />
      ) : d.rows.length === 0 ? (
        <PanelEmpty>{d.message ?? "No approved prompts."}</PanelEmpty>
      ) : d.engines.length === 0 ? (
        <>
          <PanelEmpty>No stored answers yet: ask the AI engines to start the history.</PanelEmpty>
          <Notes labels={d.labels} />
        </>
      ) : (
        <>
          <table className="w-full table-fixed border-collapse text-xs">
            <caption className="sr-only">Outcome per approved prompt in each engine's last runs, oldest first</caption>
            <thead className={THEAD}>
              <tr>
                <LTH className="w-[40%]">Approved prompt</LTH>
                {d.engines.map((e) => (
                  <th key={e.provider} scope="col" className="px-0.5 pb-1 text-center" title={`${engineName(e.provider)}: ${e.runs.length} run${e.runs.length === 1 ? "" : "s"}, oldest first`}>
                    <EngineBadge provider={e.provider} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {d.rows.map((r) => (
                <tr key={r.promptId}>
                  <th scope="row" className="truncate py-1 pr-2 text-left font-normal text-zinc-800 dark:text-zinc-200" title={r.text}>
                    {r.text}
                  </th>
                  {d.engines.map((e) => {
                    const cells = r.cells[e.provider] ?? [];
                    return (
                      <td key={e.provider} className="px-0.5 py-1">
                        <span role="img" aria-label={`${historyLabel(engineName(e.provider), cells, e.runs)}. Prompt: ${clipText(r.text, 80)}`} className="flex min-w-0 justify-center gap-px">
                          {cells.map((c, i) => (
                            <span
                              key={i}
                              aria-hidden="true"
                              title={`${shortDate(e.runs[i]?.at)}: ${HISTORY_CELL[c].word}`}
                              className={cx("inline-flex h-4 max-w-4 min-w-0 flex-1 basis-0 items-center justify-center rounded-[2px] font-mono text-[9px] leading-none font-bold", HISTORY_CELL[c].cls)}
                            >
                              {HISTORY_CELL[c].letter}
                            </span>
                          ))}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="flex flex-wrap gap-x-3 gap-y-1 pt-2 text-[11px] text-zinc-600 dark:text-zinc-400" aria-hidden="true">
            {(["cited", "named", "missing", "failed", "not_analysed", "none"] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <span className={cx("inline-flex h-3.5 w-3.5 items-center justify-center rounded-[2px] font-mono text-[9px] font-bold", HISTORY_CELL[k].cls)}>{HISTORY_CELL[k].letter}</span>
                {HISTORY_CELL[k].word}
              </span>
            ))}
          </p>
          <Notes labels={d.labels} />
        </>
      )}
    </Panel>
  );
}

export function PromptHistoryContainer({ projectId, reduced }: { projectId: string; reduced: boolean }) {
  const v = useLiveMore();
  return <PromptHistoryPanel state={useInsight<LivePromptHistoryInsight>(projectId, "prompt_history")} reduced={reduced} projectId={projectId} replaying={v.replaying} />;
}
