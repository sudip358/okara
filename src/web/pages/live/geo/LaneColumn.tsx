/**
 * One GEO engine column (Ryze engine column, docs/live-view-design.md section 5). Header: letter badge, the
 * real lane label, exact model id, grounding and lane state ("Asking" only while asking); gauge and stats
 * from this run's stored answers. Sections:
 *   A answers strip (cards slide in only when a stored answer arrives; queued card = a real queued pair),
 *   B our best page for a prompt the engine answered without us (measured attributes, no score),
 *   C an approved page the engine cited (observed reasons, never causal; adapt, never copy),
 *   D the manual rewrite plan (checklist ticks only when a stored status changes).
 * No prompts/sec, share %, x/10, traffic, conversion or revenue.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import type {
  ActivityLane,
  ActivityQueuedItem,
  CompetitorPageAssessment,
  EngineLaneSummary,
  FactorStatus,
  LiveGeoAnswerRow,
  LiveGeoLaneTotals,
  PageSkipFactors,
  RewritePlan,
} from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx } from "@web/components/ui";
import { CUSTOM_ENGINE_NOTE, PLAN_ITEM_STATUS, VERDICT, costDisplay, engineName, isCustomEngine, planItemLabel, planProgress, type ApprovalCandidate } from "@web/pages/geo/board/lib";
import { ApproveCandidate, CheckRadar, CheckTable } from "@web/pages/geo/board/CompetitorPanel";
import { SENTIMENT_LABEL, sourceTypeLabel } from "@web/pages/geo/lib";
import { laneRatio } from "../engine";
import { AnimatedNumber, Crossfade, PulseDot, Shimmer } from "../motion";
import { EngineBadge, LaneGauge, ToneChip, type ToneName } from "../parts";
import { LIVE_TEXT, clipText, fmtInt, shortDate, urlHost, urlPath, windowShort } from "../text";

const OUTCOME: Record<NonNullable<LiveGeoAnswerRow["outcome"]>, { label: string; tone: ToneName; rail: string }> = {
  cited: { label: "Cited", tone: "keep", rail: "border-l-emerald-500" },
  named: { label: "Named", tone: "review", rail: "border-l-amber-500" },
  missing: { label: "Missing", tone: "change", rail: "border-l-rose-500" },
  failed: { label: "Failed", tone: "change", rail: "border-l-rose-300 dark:border-l-rose-800" },
};

const LANE_STATE: Record<ActivityLane["state"], string> = { asking: "Asking", queued: "Queued", done: "Done", idle: "Idle" };

const SECTION_CHIP: Record<"A" | "B" | "C" | "D", string> = {
  A: "bg-sky-700 text-white dark:bg-sky-400 dark:text-zinc-950",
  B: "bg-amber-700 text-white dark:bg-amber-400 dark:text-zinc-950",
  C: "bg-emerald-700 text-white dark:bg-emerald-400 dark:text-zinc-950",
  D: "bg-rose-600 text-white dark:bg-rose-400 dark:text-zinc-950",
};

function SectionTitle({ letter, count, children, right, id }: { letter: "A" | "B" | "C" | "D"; count: number; children: ReactNode; right?: ReactNode; id?: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
      <h3 id={id} className="flex min-w-0 items-baseline gap-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        <span aria-hidden="true" className={cx("inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[11px]", SECTION_CHIP[letter])}>
          {letter}
        </span>
        <span className="sr-only">{letter} </span>
        <span className="min-w-0">
          <span className="font-mono text-sky-800 tabular-nums dark:text-sky-300">{fmtInt(count)}</span> {children}
        </span>
      </h3>
      {right && <span className="text-[11px] text-zinc-600 dark:text-zinc-400">{right}</span>}
    </div>
  );
}

/** Accessible name for an answer card, e.g. "Gemini, Missing: 'best washable sofa', 377 ms, cited instead reviews.example". */
export function answerCardName(a: LiveGeoAnswerRow): string {
  const parts = [`${engineName(a.provider)}, ${a.outcome ? OUTCOME[a.outcome].label : "Analysing"}: '${clipText(a.promptText, 120)}'`];
  if (a.latencyMs !== null) parts.push(`${fmtInt(a.latencyMs)} ms`);
  if (a.citedInstead) parts.push(`cited instead ${a.citedInstead.host}`);
  return parts.join(", ");
}

export function AnswerCard({ a, fresh, onOpen }: { a: LiveGeoAnswerRow; fresh: boolean; onOpen?: (id: string, title: string) => void }) {
  const o = a.outcome ? OUTCOME[a.outcome] : null;
  return (
    <li className={cx("w-52 shrink-0 snap-start", fresh && "lv-card-in")}>
      <button
        type="button"
        aria-label={answerCardName(a)}
        onClick={() => onOpen?.(a.observationId, a.promptText)}
        className={cx(
          "block h-full w-full min-w-0 rounded-lg border border-l-4 border-zinc-200 bg-white p-2 text-left hover:border-zinc-400 focus-visible:outline-2 focus-visible:outline-sky-600 dark:border-zinc-800 dark:bg-zinc-900",
          o ? o.rail : "border-l-sky-400",
        )}
      >
        <span className="flex items-center justify-between gap-1.5">
          <span className="font-mono text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400">{a.latencyMs !== null ? `${fmtInt(a.latencyMs)} ms` : ""}</span>
          {o ? <ToneChip tone={o.tone}>{o.label}</ToneChip> : <Shimmer label="Analysing…" />}
        </span>
        <span className="mt-1 line-clamp-2 text-sm leading-snug font-semibold text-zinc-900 dark:text-zinc-100">{clipText(a.promptText, 160)}</span>
        <span className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-zinc-600 dark:text-zinc-400">
          {a.position !== null && a.position > 0 && <span className="font-mono">#{a.position} in list</span>}
          {a.sentiment && (
            <span title={`Method: ${a.sentiment.method}`}>
              {SENTIMENT_LABEL[a.sentiment.value] ?? a.sentiment.value} <span className="text-zinc-500">({clipText(a.sentiment.method, 24)})</span>
            </span>
          )}
          {!a.grounded && a.outcome !== "failed" && <span>Not grounded</span>}
        </span>
        {a.citedInstead && (
          <span className="mt-0.5 block truncate text-[11px] text-zinc-600 dark:text-zinc-400">
            Cited instead: {a.citedInstead.host} via {sourceTypeLabel(a.citedInstead.sourceType).toLowerCase()}
          </span>
        )}
      </button>
    </li>
  );
}

function QueuedCard({ text, label }: { text: string; label: string }) {
  return (
    <li className="w-52 shrink-0 snap-start opacity-50" aria-label={`Queued: '${clipText(text, 120)}'`}>
      <div className="h-full rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-950">
        <p className="flex items-center justify-between gap-1 text-[11px] text-zinc-600 dark:text-zinc-400">
          <span>{label}</span>
        </p>
        <p className="mt-1 line-clamp-2 text-sm leading-snug font-semibold text-zinc-700 dark:text-zinc-300">{clipText(text, 160)}</p>
        <span aria-hidden="true" className="lv-shimmer mt-1.5 block h-2.5 w-3/4 rounded" />
      </div>
    </li>
  );
}

function Strip({ cards, queued, pending, fresh, reduced, onOpen, laneName }: { cards: LiveGeoAnswerRow[]; queued: ActivityQueuedItem | null; pending: LiveGeoAnswerRow | null; fresh: ReadonlySet<string>; reduced: boolean; onOpen?: (id: string, title: string) => void; laneName: string }) {
  const ref = useRef<HTMLUListElement>(null);
  const userAt = useRef(0);
  const lastId = cards[cards.length - 1]?.id ?? "";
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced || !lastId || Date.now() - userAt.current < 10_000) return;
    el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [lastId, reduced]);
  const mark = () => {
    userAt.current = Date.now();
  };
  const ordered = reduced ? cards.slice().reverse() : cards;
  return (
    <ul
      ref={ref}
      role="list"
      tabIndex={0}
      aria-label={`Answers from ${laneName}, scrollable`}
      onWheel={mark}
      onPointerDown={mark}
      onKeyDown={mark}
      onTouchStart={mark}
      className="lv-strip flex min-w-0 snap-x gap-2 overflow-x-auto pb-1 focus-visible:outline-2 focus-visible:outline-sky-600"
    >
      {ordered.map((a) => (
        <AnswerCard key={a.id} a={a} fresh={fresh.has(a.id)} onOpen={onOpen} />
      ))}
      {queued && <QueuedCard text={queued.promptText} label="Queued" />}
      {!queued && pending && <QueuedCard text={pending.promptText} label="Asking… (replay)" />}
      {cards.length === 0 && !queued && !pending && <li className="py-3 text-xs text-zinc-600 dark:text-zinc-400">No stored answer from {laneName} in this run yet.</li>}
    </ul>
  );
}

const BAR: Record<FactorStatus, string> = { present: "w-full bg-emerald-600 dark:bg-emerald-400", partial: "w-1/2 bg-amber-500 dark:bg-amber-400", missing: "w-0", unknown: "w-full lv-hatch" };

function FactorBar({ label, status, measured, heuristic }: { label: string; status: FactorStatus; measured: string; heuristic: boolean }) {
  return (
    <li className="grid min-w-0 grid-cols-[6.5rem_3rem_1fr] items-center gap-2 text-[11px]">
      <span className="truncate text-zinc-700 dark:text-zinc-300">{label}</span>
      <span role="img" aria-label={`${label}: ${status}`} className={cx("block h-1.5 overflow-hidden rounded-full", status === "missing" ? "border border-rose-400" : "bg-zinc-200 dark:bg-zinc-700")}>
        <span className={cx("block h-full rounded-full", BAR[status])} />
      </span>
      <span className="truncate text-zinc-600 dark:text-zinc-400" title={`${measured}${heuristic ? " · Heuristic" : " · Measured"}`}>
        {clipText(measured, 80)}
      </span>
    </li>
  );
}

export interface LaneColumnProps {
  provider: string;
  lane: ActivityLane;
  board: EngineLaneSummary | undefined;
  laneState: ActivityLane["state"];
  totals: LiveGeoLaneTotals;
  answered: number;
  strip: LiveGeoAnswerRow[];
  queued: ActivityQueuedItem | null;
  pending: LiveGeoAnswerRow | null;
  skipped: { row: LiveGeoAnswerRow | null; total: number; withPage: number };
  skipFactors: PageSkipFactors | "error" | undefined;
  assessments: CompetitorPageAssessment[];
  assessment: CompetitorPageAssessment | null;
  approval: ApprovalCandidate | null;
  plans: RewritePlan[];
  plan: RewritePlan | null;
  replaying: boolean;
  fresh: ReadonlySet<string>;
  reduced: boolean;
  projectId: string;
  demo: boolean;
  onOpen?: (id: string, title: string) => void;
  onApproved?: () => void;
}

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: "green" | "red" }) {
  return (
    <div className={cx("min-w-0 border-t-2 pt-1", tone === "green" ? "border-emerald-500" : tone === "red" ? "border-rose-500" : "border-zinc-200 dark:border-zinc-800")}>
      <dt className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className={cx("truncate font-mono text-xl font-semibold tabular-nums", tone === "green" ? "text-emerald-700 dark:text-emerald-400" : tone === "red" ? "text-rose-600 dark:text-rose-400" : "text-zinc-900 dark:text-zinc-100")}>{value}</dd>
      {sub && <dd className="truncate text-[11px] text-zinc-500 dark:text-zinc-400" title={sub}>{sub}</dd>}
    </div>
  );
}

export function LaneColumn(p: LaneColumnProps) {
  const custom = isCustomEngine(p.provider);
  const name = engineName(p.provider);
  const label = p.board?.label ?? p.lane.label;
  const cost = costDisplay(p.totals.cost);
  const ratio = laneRatio(p.totals, custom);
  const sk = p.skipped.row;
  const sf = p.skipFactors && p.skipFactors !== "error" ? p.skipFactors : null;
  const fresh = sf?.factors.find((f) => f.key === "freshness");
  const dId = `lane-${p.provider.replace(/[^a-z0-9]/gi, "-")}-plan`;
  return (
    <section aria-label={`${name} lane`} className="flex min-w-0 flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <EngineBadge provider={p.provider} label={label} size="md" />
          <div className="min-w-0">
            <h3 className="truncate text-base font-bold text-zinc-950 dark:text-zinc-50" title={label}>
              {label}
            </h3>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-[11px] text-zinc-600 dark:text-zinc-400">
              {p.laneState === "asking" && <PulseDot />}
              <span className="break-all font-mono">{p.board?.model ?? "model not reported"}</span>
              <span>·</span>
              <span>{p.board?.groundingMode ?? (custom ? "no web search" : "grounding not reported")}</span>
              <span>·</span>
              <span className={p.laneState === "asking" ? "font-semibold text-emerald-700 dark:text-emerald-400" : undefined}>{LANE_STATE[p.laneState]}</span>
            </p>
            {custom && <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300">{CUSTOM_ENGINE_NOTE}</p>}
            {p.board?.stateDetail && <p className="text-[11px] text-amber-800 dark:text-amber-300">{clipText(p.board.stateDetail, 120)}</p>}
          </div>
        </div>
        <LaneGauge ratio={ratio} caption={custom ? "Mention rate (no web search)" : "Citation rate, this run"} reduced={p.reduced} />
      </header>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-6">
        <Stat label="Answered" value={<AnimatedNumber value={p.answered} reduced={p.reduced} />} sub={`${p.lane.planned !== null ? `of ${fmtInt(p.lane.planned)} planned` : "plan unknown"}${p.lane.lastLatencyMs !== null && !p.replaying ? ` · last ${fmtInt(p.lane.lastLatencyMs)} ms` : ""}`} />
        <Stat label="Citing us" tone="green" value={<AnimatedNumber value={p.totals.cited} reduced={p.reduced} />} />
        <Stat label="Naming us, not citing" value={<AnimatedNumber value={p.totals.named} reduced={p.reduced} />} />
        <Stat label="Skipping us" tone="red" value={<AnimatedNumber value={p.totals.missing} reduced={p.reduced} />} sub={p.totals.failed ? `${fmtInt(p.totals.failed)} failed` : undefined} />
        <Stat label="Cited instead" value={<span className="font-sans text-sm">{p.totals.citedInstead?.host ?? "—"}</span>} sub={p.totals.citedInstead ? `in ${fmtInt(p.totals.citedInstead.answers)} answers` : "No other source yet"} />
        <Stat label="Cost so far" value={<span className="text-base">{cost.value}</span>} sub={cost.basis} />
      </dl>

      <div className="min-w-0 space-y-1.5">
        <SectionTitle letter="A" count={p.answered} right={p.replaying ? "Replay" : "Live from stored answers"}>
          approved prompts answered by {name} in this run{p.lane.planned !== null ? ` · of ${fmtInt(p.lane.planned)} planned` : ""}
        </SectionTitle>
        <Strip cards={p.strip} queued={p.queued} pending={p.pending} fresh={p.fresh} reduced={p.reduced} onOpen={p.onOpen} laneName={name} />
      </div>

      {custom ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          No web search is requested for this engine, so our pages, cited pages and rewrite plans are not shown for it (mention rate only).
        </p>
      ) : (
        <>
          <div className="min-w-0 space-y-1.5">
            <SectionTitle letter="B" count={p.skipped.total} right={`${fmtInt(p.skipped.withPage)} with a matching page`}>
              prompts {name} answered without us
            </SectionTitle>
            {!sk ? (
              <p className="text-xs text-zinc-600 dark:text-zinc-400">No answer of this run left us out yet.</p>
            ) : (
              <Crossfade k={sk.id} className="rounded-lg border border-zinc-200 p-2.5 text-xs dark:border-zinc-800">
                {sk.matchedPage ? (
                  <>
                    <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                      Our best page · {sk.matchedPage.method === "engine_search_query" ? "matched by engine search query" : "matched by title/H1 overlap"} (overlap {sk.matchedPage.score.toFixed(2)})
                    </p>
                    <p className="font-mono text-sm font-semibold break-all text-zinc-950 dark:text-zinc-50">
                      {urlHost(sk.matchedPage.url)}
                      {urlPath(sk.matchedPage.url)}
                    </p>
                  </>
                ) : (
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">No page of ours matches “{clipText(sk.promptText, 120)}”</p>
                )}
                <p className="mt-1 text-zinc-700 dark:text-zinc-300">
                  For “{clipText(sk.promptText, 120)}” {name} {sk.citedInstead ? <>cited <span className="font-semibold break-all">{sk.citedInstead.host}</span> via {sourceTypeLabel(sk.citedInstead.sourceType).toLowerCase()}</> : "cited no other source"}
                </p>
                {sk.matchedPage && (
                  <>
                    {sf && (
                      <p className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                        Page: {sf.page.wordCount !== null ? `${fmtInt(sf.page.wordCount)} words` : "word count unknown"}
                        {fresh ? ` · ${clipText(fresh.measured, 60)}` : ""}
                      </p>
                    )}
                    {sf ? (
                      <ul className="mt-1.5 space-y-1" aria-label="Measured page attributes">
                        {sf.factors.map((f) => (
                          <FactorBar key={f.key} label={f.label} status={f.status} measured={f.measured} heuristic={f.method === "heuristic"} />
                        ))}
                      </ul>
                    ) : p.skipFactors === "error" ? (
                      <p className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">Page attributes could not be loaded.</p>
                    ) : sk.matchedPage.pageId ? (
                      <Shimmer label="Loading measured attributes…" className="mt-1" />
                    ) : (
                      <p className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">The matched page is not in the latest crawl.</p>
                    )}
                    <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px]">
                      <a href={`#${dId}`}>See rewrite plan</a>
                      <Link to={projectPath(p.projectId, "draft-check")}>Draft check this page</Link>
                    </p>
                  </>
                )}
                {!sk.matchedPage && (
                  <p className="mt-1 text-[11px]">
                    <Link to={projectPath(p.projectId, "recommendations")}>Consider a new page</Link>
                  </p>
                )}
                <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{sf?.page.snapshotAt ? `Measured from the crawl of ${shortDate(sf.page.snapshotAt)} · observable differences, not causes.` : LIVE_TEXT.skipCaption}</p>
              </Crossfade>
            )}
          </div>

          <div className="min-w-0 space-y-1.5">
            <SectionTitle letter="C" count={p.assessments.length}>
              approved pages cited by {name}
            </SectionTitle>
            {p.assessment ? (
              <Crossfade k={p.assessment.id} className="rounded-lg border border-zinc-200 p-2.5 text-xs dark:border-zinc-800">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="font-semibold break-all text-zinc-900 dark:text-zinc-100">{p.assessment.host}</span>
                  <ToneChip tone="none">{sourceTypeLabel(p.assessment.sourceType)}</ToneChip>
                  {p.assessment.verdict && <ToneChip tone={p.assessment.verdict === "adapt" ? "keep" : p.assessment.verdict === "review" ? "review" : "none"} title={VERDICT[p.assessment.verdict].note}>{VERDICT[p.assessment.verdict].label}</ToneChip>}
                  {(p.assessment.state === "queued" || p.assessment.state === "fetching") && <Shimmer label="Assessing…" />}
                </div>
                <p className="truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400" title={p.assessment.url}>
                  {urlPath(p.assessment.url)}
                </p>
                <div className="mt-1 flex min-w-0 flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">What their page has (observed)</p>
                    {p.assessment.reasons.length ? (
                      <ul className="list-disc space-y-0.5 pl-4 text-zinc-800 dark:text-zinc-200">
                        {p.assessment.reasons.slice(0, 4).map((r, i) => (
                          <li key={i} className="break-words">
                            {clipText(r, 120)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-zinc-600 dark:text-zinc-400">{p.assessment.stateDetail ? clipText(p.assessment.stateDetail, 120) : "No observation stored yet."}</p>
                    )}
                  </div>
                  {p.assessment.checks.length > 0 && <CheckRadar checks={p.assessment.checks} />}
                </div>
                {p.assessment.checks.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-zinc-700 dark:text-zinc-300">Details</summary>
                    <CheckTable checks={p.assessment.checks} />
                  </details>
                )}
              </Crossfade>
            ) : p.approval ? (
              p.demo ? (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">Not available in the demo.</p>
              ) : (
                <ul className="min-w-0">
                  <ApproveCandidate projectId={p.projectId} c={p.approval} onApproved={() => p.onApproved?.()} />
                </ul>
              )
            ) : (
              <p className="text-xs text-zinc-600 dark:text-zinc-400">No page cited by {name} has been approved for reading.</p>
            )}
          </div>

          <div className="min-w-0 space-y-1.5">
            <SectionTitle letter="D" count={p.plans.length} id={dId} right={LIVE_TEXT.manualPlan}>
              rewrite plans for pages {name} skips
            </SectionTitle>
            {p.plan ? <PlanCard plan={p.plan} projectId={p.projectId} reduced={p.reduced} /> : <p className="text-xs text-zinc-600 dark:text-zinc-400">No rewrite plan for this engine yet.</p>}
          </div>
        </>
      )}
    </section>
  );
}

/** Rewrite plan card; an item that changed to done since the previous fetch ticks with a brief highlight. */
export function PlanCard({ plan, projectId, reduced }: { plan: RewritePlan; projectId: string; reduced: boolean }) {
  const prev = useRef<Map<string, string> | null>(null);
  const before = prev.current;
  const ticked = new Set<string>();
  if (before) for (const it of plan.items) if (it.status === "done" && before.get(it.key) !== undefined && before.get(it.key) !== "done") ticked.add(it.key);
  useEffect(() => {
    prev.current = new Map(plan.items.map((i) => [i.key, i.status]));
  });
  return (
    <div className="rounded-lg border border-zinc-200 p-2.5 text-xs dark:border-zinc-800">
      <p className="truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400" title={plan.url}>
        {urlHost(plan.url)}
        {urlPath(plan.url)}
      </p>
      <p className="font-semibold break-words text-zinc-900 dark:text-zinc-100">{clipText(plan.question, 160)}</p>
      <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{planProgress(plan.items)}</p>
      <ul className="mt-1 space-y-0.5" aria-label="Rewrite checklist">
        {plan.items.map((it, i) => {
          const st = PLAN_ITEM_STATUS[it.status];
          const tick = ticked.has(it.key) && !reduced;
          return (
            <li key={it.key} className={cx("flex min-w-0 items-start gap-1.5 rounded px-0.5", tick && "lv-row-in")} style={tick ? { animationDelay: `${i * 120}ms` } : undefined}>
              {it.status === "done" ? (
                <svg aria-hidden="true" viewBox="0 0 14 14" className={cx("mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm bg-sky-700 dark:bg-sky-400", tick && "lv-tick")}>
                  <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" strokeWidth={2} className="stroke-white dark:stroke-zinc-950" />
                </svg>
              ) : (
                <span aria-hidden="true" className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border border-zinc-300 text-[9px] text-zinc-500 dark:border-zinc-600">
                  {it.status === "todo" ? "" : st.glyph}
                </span>
              )}
              <span className="min-w-0">
                <span className="sr-only">{st.label}: </span>
                <span className={it.status === "done" ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-600 dark:text-zinc-400"}>{planItemLabel(it)}</span>
                {it.evidence && <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">{clipText(it.evidence, 100)}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <dl className="mt-1.5 grid grid-cols-2 gap-2 text-[11px]">
        <div className="min-w-0">
          <dt className="text-zinc-600 dark:text-zinc-400">Search Console{plan.gsc ? ` (${windowShort(plan.gsc.window)})` : ""}</dt>
          <dd className="font-mono text-zinc-900 dark:text-zinc-100">{plan.gsc ? `Clicks ${fmtInt(plan.gsc.clicks)} · Impressions ${fmtInt(plan.gsc.impressions)}` : "not connected"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-zinc-600 dark:text-zinc-400">AI citations</dt>
          <dd className="font-mono text-zinc-900 dark:text-zinc-100">{plan.aiCitations ? `Cited in ${fmtInt(plan.aiCitations.count)} stored answer${plan.aiCitations.count === 1 ? "" : "s"}` : "No GEO data"}</dd>
        </div>
      </dl>
      {plan.recommendationId && (
        <p className="mt-1 text-[11px]">
          <Link to={projectPath(projectId, `recommendations/${encodeURIComponent(plan.recommendationId)}`)}>Open recommendation</Link>
        </p>
      )}
    </div>
  );
}
