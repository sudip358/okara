/**
 * One GEO engine column (Ryze engine column, docs/live-view-design.md section 5). Header: letter badge, the
 * real lane label (short name on top, the rest of the label below), the model and grounding stored with this
 * run's answers (the board's latest configuration only when the run has no answer, labelled so), and the lane
 * state ("Asking" only while asking); gauge and stats from this run's stored answers. Sections:
 *   A answers strip (cards slide in only when a stored answer arrives; queued card = a real queued pair),
 *   B our best page for a prompt the engine answered without us (measured attributes, no score),
 *   C an approved page the engine cited (observed reasons, never causal; adapt, never copy),
 *   D the manual rewrite plan (checklist ticks only when a stored status changes).
 * C and D are current project state (labelled "Current state, not replayed" during a replay). An answer
 * without an outcome shimmers "Analysing…" only while the run is active; afterwards it is "Not analysed".
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
  SourceType,
} from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx } from "@web/components/ui";
import { CUSTOM_ENGINE_NOTE, CUSTOM_NO_SOURCES_NOTE, CUSTOM_SOURCES_NOTE, PLAN_ITEM_STATUS, VERDICT, costDisplay, engineName, isCustomEngine, planItemLabel, planProgress, type ApprovalCandidate } from "@web/pages/geo/board/lib";
import { ApproveCandidate, CheckRadar, CheckTable } from "@web/pages/geo/board/CompetitorPanel";
import { SENTIMENT_LABEL, sourceTypeLabel } from "@web/pages/geo/lib";
import { customLaneMeasured, laneRatio } from "../engine";
import { AnimatedNumber, Crossfade, PulseDot, Shimmer, staggerStyle } from "../motion";
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

/**
 * Section heading on one line (so the A strips of side-by-side columns stay aligned, as in the reference);
 * the full heading stays in the DOM and in the tooltip.
 */
function SectionTitle({ letter, count, children, right, id, title }: { letter: "A" | "B" | "C" | "D"; count: number; children: ReactNode; right?: ReactNode; id?: string; title?: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 @sm:flex-nowrap">
      <h3 id={id} className="flex min-w-0 flex-1 basis-full items-baseline gap-1.5 text-sm font-semibold text-zinc-900 @sm:basis-auto dark:text-zinc-100" title={title}>
        <span aria-hidden="true" className={cx("inline-flex h-5 w-5 shrink-0 items-center justify-center self-center rounded font-mono text-[11px]", SECTION_CHIP[letter])}>
          {letter}
        </span>
        <span className="sr-only">{letter} </span>
        <span className="min-w-0 @sm:truncate">
          <span className="font-mono text-sky-800 tabular-nums dark:text-sky-300">{fmtInt(count)}</span> {children}
        </span>
      </h3>
      {right && <span className="shrink-0 text-[11px] text-zinc-600 @sm:max-w-[45%] @sm:truncate @sm:text-right dark:text-zinc-400">{right}</span>}
    </div>
  );
}

/** "Cited instead" only for answers that left us out; "Also cited" next to our own citation; else nothing. */
function otherCitation(a: LiveGeoAnswerRow): { label: "Cited instead" | "Also cited"; host: string; sourceType: SourceType } | null {
  if (!a.citedInstead) return null;
  if (a.outcome === "missing" || a.outcome === "named") return { label: "Cited instead", host: a.citedInstead.host, sourceType: a.citedInstead.sourceType };
  if (a.outcome === "cited") return { label: "Also cited", host: a.citedInstead.host, sourceType: a.citedInstead.sourceType };
  return null;
}

/** Accessible name for an answer card, e.g. "Gemini, Missing: 'best washable sofa', 377 ms, cited instead reviews.example". */
export function answerCardName(a: LiveGeoAnswerRow, runActive = false): string {
  const parts = [`${engineName(a.provider)}, ${a.outcome ? OUTCOME[a.outcome].label : runActive ? "Analysing" : "Not analysed"}: '${clipText(a.promptText, 120)}'`];
  if (a.latencyMs !== null) parts.push(`${fmtInt(a.latencyMs)} ms`);
  const other = otherCitation(a);
  if (other) parts.push(`${other.label.toLowerCase()} ${other.host}`);
  return parts.join(", ");
}

export function AnswerCard({
  a,
  fresh,
  onOpen,
  runActive = false,
  style,
}: {
  a: LiveGeoAnswerRow;
  fresh: boolean;
  onOpen?: (id: string, title: string) => void;
  /** The run is live: an answer without an outcome is still being analysed. */
  runActive?: boolean;
  style?: { animationDelay: string };
}) {
  const o = a.outcome ? OUTCOME[a.outcome] : null;
  const other = otherCitation(a);
  return (
    <li className={cx("w-52 shrink-0 snap-start", fresh && "lv-card-in")} style={fresh ? style : undefined}>
      <button
        type="button"
        aria-label={answerCardName(a)}
        onClick={() => onOpen?.(a.observationId, a.promptText)}
        className={cx(
          // flex column: a button would otherwise centre shorter cards vertically (tops must line up in the strip).
          "flex h-full w-full min-w-0 flex-col justify-start rounded-lg border border-l-4 border-zinc-200 bg-white p-2 text-left hover:border-zinc-400 focus-visible:outline-2 focus-visible:outline-sky-600 dark:border-zinc-800 dark:bg-zinc-900",
          o ? o.rail : runActive ? "border-l-sky-400" : "border-l-zinc-300 dark:border-l-zinc-600",
        )}
      >
        <span className="flex items-center justify-between gap-1.5">
          <span className="font-mono text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400">{a.latencyMs !== null ? `${fmtInt(a.latencyMs)} ms` : ""}</span>
          {o ? (
            <ToneChip tone={o.tone}>{o.label}</ToneChip>
          ) : runActive ? (
            <Shimmer label="Analysing…" />
          ) : (
            <ToneChip tone="none" title="The run ended without storing this answer's analysis; its outcome is not counted">
              Not analysed
            </ToneChip>
          )}
        </span>
        <span className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm leading-snug font-semibold text-zinc-900 dark:text-zinc-100">{clipText(a.promptText, 160)}</span>
        {a.outcome !== "failed" && (
          <span className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-[11px]">
            <span className="text-zinc-500 dark:text-zinc-400">Position</span>
            <span className="text-zinc-500 dark:text-zinc-400">Sentiment</span>
            <span
              className={cx("font-mono font-semibold tabular-nums", a.position !== null && a.position > 0 ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-500")}
              title={a.position !== null && a.position > 0 ? "Our place in the answer's list" : "The answer did not list us in a ranked list"}
            >
              {a.position !== null && a.position > 0 ? (
                <>
                  #{a.position}
                  <span className="sr-only"> in list</span>
                </>
              ) : (
                "—"
              )}
            </span>
            <span className="min-w-0 truncate font-semibold text-zinc-900 dark:text-zinc-100" title={a.sentiment ? `Method: ${a.sentiment.method}` : "No sentiment stored"}>
              {a.sentiment ? (
                <>
                  {SENTIMENT_LABEL[a.sentiment.value] ?? a.sentiment.value} <span className="font-normal text-zinc-500 dark:text-zinc-400">({clipText(a.sentiment.method, 24)})</span>
                </>
              ) : (
                <span className="font-normal text-zinc-400 dark:text-zinc-500">—</span>
              )}
            </span>
          </span>
        )}
        {!a.grounded && a.outcome !== "failed" && <span className="mt-0.5 block text-[11px] text-zinc-600 dark:text-zinc-400">Not grounded</span>}
        {other && (
          <span className="mt-0.5 block truncate text-[11px] text-zinc-600 dark:text-zinc-400">
            {other.label}: {other.host} via {sourceTypeLabel(other.sourceType).toLowerCase()}
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

function Strip({
  cards,
  queued,
  pending,
  fresh,
  reduced,
  onOpen,
  laneName,
  runActive,
}: {
  cards: LiveGeoAnswerRow[];
  queued: ActivityQueuedItem | null;
  pending: LiveGeoAnswerRow | null;
  fresh: ReadonlySet<string>;
  reduced: boolean;
  onOpen?: (id: string, title: string) => void;
  laneName: string;
  runActive: boolean;
}) {
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
        <AnswerCard key={a.id} a={a} fresh={fresh.has(a.id)} onOpen={onOpen} runActive={runActive} style={staggerStyle(fresh, a.id)} />
      ))}
      {queued && <QueuedCard text={queued.promptText} label="Queued" />}
      {!queued && pending && <QueuedCard text={pending.promptText} label="Asking… (replay)" />}
      {cards.length === 0 && !queued && !pending && <li className="py-3 text-xs text-zinc-600 dark:text-zinc-400">No stored answer from {laneName} in this run yet.</li>}
    </ul>
  );
}

/** A URL that wraps after "/" and "-" (like the reference's big URL) instead of mid-word. Plain text only. */
function BreakableUrl({ text }: { text: string }) {
  const parts = text.split(/(?<=[/-])/);
  return (
    <>
      {parts.map((t, i) => (
        <span key={i}>
          {t}
          {i < parts.length - 1 && <wbr />}
        </span>
      ))}
    </>
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
  /** Answers with an analysis or awaiting one (cited + named + missing + pending): failed calls are not answers. */
  answered: number;
  /** Model and grounding mode stored with this lane's answers in this run (newest); null when it has none. */
  runModel: { model: string | null; groundingMode: string | null } | null;
  /** The run is live and active (an answer without an outcome is genuinely being analysed). */
  runActive: boolean;
  /** D shows a page-level plan (no engine) because this engine has none. */
  planFallback?: boolean;
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

/** One header stat; `short` is the visible label in the one-row layout (the full label stays the accessible one). */
function Stat({ label, short, value, sub, tone, className }: { label: string; short?: string; value: ReactNode; sub?: string; tone?: "green" | "red"; className?: string }) {
  return (
    <div className={cx("min-w-0 border-t-2 pt-1", tone === "green" ? "border-emerald-500" : tone === "red" ? "border-rose-500" : "border-zinc-200 dark:border-zinc-800", className)}>
      <dt className="truncate text-[11px] text-zinc-600 dark:text-zinc-400" title={label}>
        {short ? (
          <>
            <span aria-hidden="true">{short}</span>
            <span className="sr-only">{label}</span>
          </>
        ) : (
          label
        )}
      </dt>
      <dd
        className={cx(
          "truncate font-mono text-2xl leading-tight font-semibold tabular-nums",
          tone === "green" ? "text-emerald-700 dark:text-emerald-400" : tone === "red" ? "text-rose-600 dark:text-rose-400" : "text-zinc-900 dark:text-zinc-100",
        )}
      >
        {value}
      </dd>
      {sub && <dd className="truncate text-[11px] text-zinc-500 dark:text-zinc-400" title={sub}>{sub}</dd>}
    </div>
  );
}

export function LaneColumn(p: LaneColumnProps) {
  const custom = isCustomEngine(p.provider);
  // A custom lane is measured like any engine once this run has answers with provider-reported sources.
  const measured = customLaneMeasured(p.totals, custom);
  const mentionOnly = custom && !measured;
  const name = engineName(p.provider);
  const label = p.board?.label ?? p.lane.label;
  // The real lane label, split for the header: "Gemini API" on top, "Google Search grounding (API-sampled)" below.
  const [head, ...tail] = label.split(" · ");
  // This run's model (stored with its answers); the board's latest configuration only when the run has none.
  const model = p.runModel ? (p.runModel.model ?? "model not recorded") : p.board?.model ? `${p.board.model} (latest configuration)` : "model not reported";
  const grounding = p.runModel ? (p.runModel.groundingMode ?? "grounding not recorded") : (p.board?.groundingMode ?? "grounding not reported");
  const notReplayed = p.replaying ? "Current state, not replayed" : null;
  const cost = costDisplay(p.totals.cost);
  const ratio = laneRatio(p.totals, custom);
  const sk = p.skipped.row;
  const sf = p.skipFactors && p.skipFactors !== "error" ? p.skipFactors : null;
  const fresh = sf?.factors.find((f) => f.key === "freshness");
  const dId = `lane-${p.provider.replace(/[^a-z0-9]/gi, "-")}-plan`;
  return (
    <section aria-label={`${name} lane`} className="@container flex min-w-0 flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm xl:row-span-6 xl:grid xl:grid-rows-subgrid xl:content-start dark:border-zinc-800 dark:bg-zinc-900">
      <header className="-mx-3 -mt-3 flex min-w-0 flex-wrap items-start justify-between gap-2 rounded-t-xl bg-linear-to-r from-zinc-100 via-zinc-50 to-transparent px-3 pt-3 pb-2 dark:from-zinc-800/70 dark:via-zinc-900">
        <div className="flex min-w-[min(100%,11rem)] flex-1 items-start gap-2">
          <EngineBadge provider={p.provider} label={label} size="md" />
          <div className="min-w-0">
            <h3 className="truncate text-lg leading-tight font-semibold text-zinc-950 dark:text-zinc-50" title={label}>
              {head}
            </h3>
            {/* Inline text (not a flex row), so the live dot stays next to the words when the line wraps. */}
            <p className="min-w-0 text-[11px] text-zinc-600 dark:text-zinc-400">
              {p.laneState === "asking" && <PulseDot className="mr-1 align-middle" />}
              {tail.length > 0 && <span>{tail.join(" · ")} · </span>}
              <span className="font-mono break-words" title={p.runModel ? "Model stored with this run's answers" : "No answer in this run: the board's latest configuration"}>
                {model}
              </span>
              <span> · {grounding} · </span>
              <span className={p.laneState === "asking" ? "font-semibold text-emerald-700 dark:text-emerald-400" : undefined}>{LANE_STATE[p.laneState]}</span>
            </p>
            {custom && (
              <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300">
                {CUSTOM_ENGINE_NOTE} ·{" "}
                {measured
                  ? `${CUSTOM_SOURCES_NOTE} in ${fmtInt(p.totals.grounded)} of ${fmtInt(p.totals.cited + p.totals.named + p.totals.missing)} answers`
                  : CUSTOM_NO_SOURCES_NOTE}
              </p>
            )}
            {p.board?.stateDetail && <p className="text-[11px] text-amber-800 dark:text-amber-300">{clipText(p.board.stateDetail, 120)}</p>}
          </div>
        </div>
        <LaneGauge ratio={ratio} caption={mentionOnly ? "Mention rate (no sources returned)" : custom ? "Citation rate, this run (answers with sources)" : "Citation rate, this run"} reduced={p.reduced} />
      </header>
      <dl className="grid grid-cols-3 gap-x-3 gap-y-2 @xl:grid-cols-7 @xl:gap-x-2">
        <Stat
          label="Answered"
          value={<AnimatedNumber value={p.answered} reduced={p.reduced} />}
          sub={`${p.lane.planned !== null ? `of ${fmtInt(p.lane.planned)} planned` : "plan unknown"}${p.totals.failed ? ` · ${fmtInt(p.totals.failed)} failed` : ""}${p.lane.lastLatencyMs !== null && !p.replaying ? ` · last ${fmtInt(p.lane.lastLatencyMs)} ms` : ""}`}
        />
        <Stat label="Citing us" tone="green" value={<AnimatedNumber value={p.totals.cited} reduced={p.reduced} />} />
        <Stat label="Naming us, not citing" short="Named only" value={<AnimatedNumber value={p.totals.named} reduced={p.reduced} />} />
        <Stat label="Skipping us" tone="red" value={<AnimatedNumber value={p.totals.missing} reduced={p.reduced} />} />
        <Stat
          label="Cited instead"
          className="@xl:col-span-2"
          value={
            <span className="block truncate pt-1 font-sans text-base leading-tight font-semibold" title={p.totals.citedInstead?.host}>
              {p.totals.citedInstead?.host ?? "—"}
            </span>
          }
          sub={p.totals.citedInstead ? `in ${fmtInt(p.totals.citedInstead.answers)} answers` : "No other source yet"}
        />
        <Stat label="Cost so far" value={<span className="text-base">{cost.value}</span>} sub={cost.basis} />
      </dl>

      <div className="min-w-0 space-y-1.5">
        <SectionTitle
          letter="A"
          count={p.answered}
          right={p.replaying ? "Replay" : "Live from stored answers"}
          title={`${fmtInt(p.answered)} approved prompts answered by ${name} in this run${p.lane.planned !== null ? ` · of ${fmtInt(p.lane.planned)} planned` : ""}`}
        >
          approved prompts answered by {name} in this run{p.lane.planned !== null ? ` · of ${fmtInt(p.lane.planned)} planned` : ""}
        </SectionTitle>
        <Strip cards={p.strip} queued={p.queued} pending={p.pending} fresh={p.fresh} reduced={p.reduced} onOpen={p.onOpen} laneName={name} runActive={p.runActive} />
      </div>

      {mentionOnly ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          This custom engine returned no sources in this run, so our pages, cited pages and rewrite plans are not shown for it (mention rate only).
        </p>
      ) : (
        <>
          <div className="min-w-0 space-y-1.5">
            <SectionTitle letter="B" count={p.skipped.total} right={`${fmtInt(p.skipped.withPage)} with a matching page`} title={`${fmtInt(p.skipped.total)} prompts ${name} answered without us`}>
              prompts {name} answered without us
            </SectionTitle>
            {!sk ? (
              <p className="text-xs text-zinc-600 dark:text-zinc-400">No answer of this run left us out yet.</p>
            ) : (
              <Crossfade k={sk.id} className="rounded-lg border border-zinc-200 p-2.5 text-xs dark:border-zinc-800">
                {/* Two columns when the column is wide (reference B card): the page and the prompt on the left,
                    its measured attributes on the right. No score, no likelihood: statuses as measured. */}
                <div className={cx("grid min-w-0 gap-x-4 gap-y-1.5", sk.matchedPage && sf && "@xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]")}>
                  <div className="min-w-0">
                    {sk.matchedPage ? (
                      <>
                        <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                          Our best page · {sk.matchedPage.method === "engine_search_query" ? "matched by engine search query" : "matched by title/H1 overlap"} (overlap {sk.matchedPage.score.toFixed(2)})
                        </p>
                        <p className="font-mono text-sm leading-snug font-semibold break-words text-zinc-950 @xl:text-[15px] dark:text-zinc-50">
                          <BreakableUrl text={`${urlHost(sk.matchedPage.url)}${urlPath(sk.matchedPage.url)}`} />
                        </p>
                      </>
                    ) : (
                      <p className="font-medium text-zinc-900 dark:text-zinc-100">No page of ours matches “{clipText(sk.promptText, 120)}”</p>
                    )}
                    <p className="mt-1 text-zinc-700 dark:text-zinc-300">
                      For “{clipText(sk.promptText, 120)}” {name} {sk.citedInstead ? <>cited <span className="font-semibold break-all">{sk.citedInstead.host}</span> via {sourceTypeLabel(sk.citedInstead.sourceType).toLowerCase()}</> : "cited no other source"}
                    </p>
                    {sk.matchedPage && sf && (
                      <p className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                        Page: {sf.page.wordCount !== null ? `${fmtInt(sf.page.wordCount)} words` : "word count unknown"}
                        {fresh ? ` · ${clipText(fresh.measured, 60)}` : ""}
                      </p>
                    )}
                    {sk.matchedPage ? (
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                        <a href={`#${dId}`} className="inline-flex items-center rounded bg-rose-50 px-1.5 py-0.5 font-medium text-rose-700 no-underline hover:underline dark:bg-rose-950 dark:text-rose-300">
                          <span aria-hidden="true" className="pr-1">
                            →
                          </span>
                          See rewrite plan
                        </a>
                        <Link to={projectPath(p.projectId, "draft-check")}>Draft check this page</Link>
                      </p>
                    ) : (
                      <p className="mt-1.5 text-[11px]">
                        <Link to={projectPath(p.projectId, "recommendations")} className="inline-flex items-center rounded bg-rose-50 px-1.5 py-0.5 font-medium text-rose-700 no-underline hover:underline dark:bg-rose-950 dark:text-rose-300">
                          <span aria-hidden="true" className="pr-1">
                            →
                          </span>
                          Consider a new page
                        </Link>
                      </p>
                    )}
                  </div>
                  {sk.matchedPage && (
                    <div className="min-w-0">
                      {sf ? (
                        <ul className="space-y-1" aria-label="Measured page attributes">
                          {sf.factors.map((f) => (
                            <FactorBar key={f.key} label={f.label} status={f.status} measured={f.measured} heuristic={f.method === "heuristic"} />
                          ))}
                        </ul>
                      ) : p.skipFactors === "error" ? (
                        <p className="text-[11px] text-zinc-600 dark:text-zinc-400">Page attributes could not be loaded.</p>
                      ) : sk.matchedPage.pageId ? (
                        <Shimmer label="Loading measured attributes…" />
                      ) : (
                        <p className="text-[11px] text-zinc-600 dark:text-zinc-400">The matched page is not in the latest crawl.</p>
                      )}
                    </div>
                  )}
                </div>
                <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">{sf?.page.snapshotAt ? `Measured from the crawl of ${shortDate(sf.page.snapshotAt)} · observable differences, not causes.` : LIVE_TEXT.skipCaption}</p>
              </Crossfade>
            )}
          </div>

          <div className="min-w-0 space-y-1.5">
            <SectionTitle letter="C" count={p.assessments.length} right={notReplayed} title={`${fmtInt(p.assessments.length)} approved pages cited by ${name}`}>
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
            <SectionTitle letter="D" count={p.plans.length} id={dId} right={notReplayed} title={`${fmtInt(p.plans.length)} rewrite plans for pages ${name} skips`}>
              rewrite plans for pages {name} skips
            </SectionTitle>
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{LIVE_TEXT.manualPlan}</p>
            {p.plan ? (
              <>
                {p.planFallback && <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">Rewrite plan for this page (not engine-specific)</p>}
                <PlanCard plan={p.plan} projectId={p.projectId} reduced={p.reduced} />
              </>
            ) : (
              <p className="text-xs text-zinc-600 dark:text-zinc-400">No rewrite plan for this engine yet.</p>
            )}
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
