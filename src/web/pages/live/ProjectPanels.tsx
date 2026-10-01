/**
 * Project-level panels reused by both modes (existing endpoints, not time-indexed):
 * 05 Competitor pages worth adapting (GET /geo/competitor-pages; only pages a user approved),
 * 06 Do our pages answer what people ask AI? (GET /geo/answer-coverage),
 * 07 How our pages show up in AI answers (GET /geo/citation-evidence + skip factors).
 * No ranks without a source, no "cited %" share, no chance / after percentages: counts of stored rows and
 * measured statuses only. We adapt competitor structure, never copy text.
 */
import { Fragment } from "react";
import { Link } from "react-router";
import type { AnswerCoverageRow, CitationEvidenceRow, CompetitorCheckKey, CompetitorPageAssessment, FactorStatus, LiveGeoAnswerRow, PageSkipFactors, SkipFactorKey } from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx, ErrorState } from "@web/components/ui";
import { ASSESSMENT_STATE, VERDICT, checkStatus } from "@web/pages/geo/board/lib";
import { sourceTypeLabel } from "@web/pages/geo/lib";
import { Shimmer } from "./motion";
import { ACCENT, BlockBar, EngineBadge, LTD, LTH, MiniBar, Panel, PanelEmpty, THEAD, ToneChip, type Accent, type ToneName } from "./parts";
import { LIVE_TEXT, clipText, fmtInt, shortDate, urlHost, urlPath } from "./text";

interface Loadable<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

function LoadState({ state, what }: { state: Loadable<unknown>; what: string }) {
  if (state.error) return <ErrorState error={state.error} title={`Could not load ${what}`} />;
  return <Shimmer label={`Loading ${what}…`} />;
}

/** "41%" for a whole-number percentage computed from stored rows (n of m is always printed next to it). */
const fmtPct = (n: number) => `${Math.round(n)}%`;

// ------------------------------------------------------------------ 05 Competitor pages worth adapting
const COMP_CHECKS: Array<{ key: CompetitorCheckKey; label: string }> = [
  { key: "answer_first", label: "Answer" },
  { key: "depth", label: "Depth" },
  { key: "proof", label: "Proof" },
  { key: "schema", label: "Schema" },
  { key: "freshness", label: "Fresh" },
];

const VERDICT_TONE: Record<"adapt" | "skip" | "review", ToneName> = { adapt: "keep", skip: "none", review: "review" };

export function CompetitorsPanel({
  state,
  reduced,
  projectId,
  captions,
  num = "05",
}: {
  state: Loadable<CompetitorPageAssessment[]>;
  reduced: boolean;
  projectId: string;
  captions: string[];
  num?: string;
}) {
  const list = state.data ?? [];
  const adapt = list.filter((a) => a.verdict === "adapt").length;
  return (
    <Panel
      num={num}
      title="Competitor pages worth adapting"
      accent="amber"
      reduced={reduced}
      testId="competitors"
      counter={state.data ? { value: adapt, suffix: "to adapt", sub: `of ${fmtInt(list.length)} approved pages` } : null}
      subtitle={LIVE_TEXT.competitorsSubtitle}
      captions={captions}
    >
      {!state.data ? (
        <LoadState state={state} what="approved competitor pages" />
      ) : list.length === 0 ? (
        <PanelEmpty>
          No approved competitor pages yet. <Link to={projectPath(projectId, "geo/board")}>Approve cited pages on the AI engines board</Link>.
        </PanelEmpty>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">Approved competitor pages and their measured checks</caption>
          <thead className={THEAD}>
            <tr>
              <LTH className="w-[40%] @xl:w-[27%]">Site · page</LTH>
              {COMP_CHECKS.map((c) => (
                <LTH key={c.key} tight className="hidden text-center @xl:table-cell @xl:w-[7.5%]">
                  {c.label}
                </LTH>
              ))}
              <LTH className="w-[32%] @xl:w-[22.5%]">Cited in</LTH>
              <LTH className="w-[28%] @xl:w-[13%]">Verdict</LTH>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => {
              const st = ASSESSMENT_STATE[a.state];
              const byKey = new Map(a.checks.map((c) => [c.key, c]));
              const providers = Array.from(new Set(a.citedIn.map((c) => c.provider)));
              // Few approved pages: each row also shows what their page has (observed reasons, plain text).
              const reasons = list.length <= 4 && !st.pending ? a.reasons.slice(0, 3) : [];
              return (
                <Fragment key={a.id}>
                <tr className={cx("border-t border-zinc-100 first:border-t-0 dark:border-zinc-800", !st.pending && ACCENT.amber.row)}>
                  <LTD className="text-zinc-900 dark:text-zinc-100" title={`${a.host} · ${sourceTypeLabel(a.sourceType)}`}>
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate font-semibold">{a.host}</span>
                      <span className="hidden shrink-0 text-[11px] text-zinc-500 @lg:inline dark:text-zinc-400">{sourceTypeLabel(a.sourceType)}</span>
                    </span>
                    <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" title={a.url} className="block truncate font-mono text-[11px] text-zinc-600 no-underline hover:underline dark:text-zinc-400">
                      {urlPath(a.url)}
                    </a>
                  </LTD>
                  {COMP_CHECKS.map((ck) => {
                    const c = byKey.get(ck.key);
                    const status: FactorStatus = c ? checkStatus(c) : "unknown";
                    const tip = c
                      ? c.method === "jev"
                        ? `${ck.label}: ${status}${c.noul !== null ? ` · Noul ${c.noul.toFixed(2)}${c.tier ? ` · ${c.tier}` : ""}` : " · not run"}`
                        : `${ck.label}: ${status}${c.detail ? ` · ${clipText(c.detail, 80)}` : ""} · measured`
                      : `${ck.label}: not checked`;
                    return (
                      <LTD key={ck.key} tight className="hidden text-center @xl:table-cell">
                        {st.pending ? <span className="lv-shimmer inline-block h-2 w-8 rounded" aria-hidden="true" /> : <BlockBar status={status} label={ck.label} title={tip} />}
                      </LTD>
                    );
                  })}
                  <LTD>
                    <span className="flex min-w-0 items-center gap-1">
                      {providers.map((p) => (
                        <EngineBadge key={p} provider={p} />
                      ))}
                      <span className="min-w-0 truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                        {fmtInt(a.citedIn.length)} stored answer{a.citedIn.length === 1 ? "" : "s"}
                      </span>
                    </span>
                  </LTD>
                  <LTD className="overflow-visible">
                    {st.pending ? (
                      <Shimmer label="Assessing…" />
                    ) : a.verdict ? (
                      <ToneChip tone={VERDICT_TONE[a.verdict]} title={VERDICT[a.verdict].note}>
                        {VERDICT[a.verdict].label}
                      </ToneChip>
                    ) : (
                      <ToneChip tone={st.tone === "danger" ? "change" : "none"} title={a.stateDetail ?? undefined}>
                        {st.label}
                      </ToneChip>
                    )}
                  </LTD>
                </tr>
                {reasons.length > 0 && (
                  <tr className={ACCENT.amber.row}>
                    <td colSpan={8} className="pt-0 pb-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                      <span className="line-clamp-2">
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">What their page has (observed): </span>
                        {reasons.map((r) => clipText(r, 90)).join(" · ")}
                      </span>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ 06 Do our pages answer what people ask AI?
const GAP_ORDER: Record<AnswerCoverageRow["gap"], number> = { create_page: 0, improve: 1, check: 2, covered: 3 };
const GAP_VERDICT: Record<AnswerCoverageRow["gap"], { label: string; tone: ToneName; next: string }> = {
  create_page: { label: "No page", tone: "change", next: "Consider a new page" },
  improve: { label: "Page not cited", tone: "review", next: "Improve the page" },
  check: { label: "Check", tone: "none", next: "Check this yourself" },
  covered: { label: "Cited", tone: "keep", next: "—" },
};
const METHOD_TAG: Record<NonNullable<AnswerCoverageRow["matchedPage"]>["method"], string> = {
  engine_search_query: "engine search query",
  title_heading_overlap: "title/H1 overlap",
};

export function coverageCounts(rows: readonly AnswerCoverageRow[]): { noPage: number; total: number; citeUs: number; answered: number } {
  let noPage = 0;
  let citeUs = 0;
  let answered = 0;
  for (const r of rows) {
    if (r.matchedPage === null) noPage++;
    if (r.aiSource !== "not_run") answered++;
    if (r.aiSource === "your_site") citeUs++;
  }
  return { noPage, total: rows.length, citeUs, answered };
}

/** AI cites cell: a newer stored answer of THIS run for the prompt wins over the coverage snapshot. */
function AiCites({ row, answer, asking, ownHost }: { row: AnswerCoverageRow; answer: LiveGeoAnswerRow | undefined; asking: boolean; ownHost: string }) {
  if (asking && !answer) return <Shimmer label="Asking…" />;
  if (answer && answer.outcome !== null && answer.outcome !== "failed") {
    if (answer.outcome === "cited") return <span className="font-medium text-emerald-700 dark:text-emerald-400">{urlHost(answer.ownCitedUrl) || ownHost}</span>;
    if (answer.citedInstead)
      return (
        <span className="block truncate" title={`${answer.citedInstead.host} · ${sourceTypeLabel(answer.citedInstead.sourceType)} (this run)`}>
          {answer.citedInstead.host} <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{sourceTypeLabel(answer.citedInstead.sourceType)}</span>
        </span>
      );
    return <span className="text-zinc-600 dark:text-zinc-400">No sources</span>;
  }
  if (row.aiSource === "your_site") return <span className="font-medium text-emerald-700 dark:text-emerald-400">{ownHost}</span>;
  if (row.aiSource === "other_site" && row.topOtherSource)
    return (
      <span className="block truncate" title={`${row.topOtherSource.host} · ${sourceTypeLabel(row.topOtherSource.sourceType)}`}>
        {row.topOtherSource.host} <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{sourceTypeLabel(row.topOtherSource.sourceType)}</span>
      </span>
    );
  if (row.aiSource === "none") return <span className="text-zinc-600 dark:text-zinc-400">No sources</span>;
  return <span className="text-zinc-500 dark:text-zinc-400">Not asked</span>;
}

export function CoveragePanel({
  state,
  reduced,
  projectId,
  ownHost,
  captions,
  num = "06",
  accent = "emerald",
  askingPrompts,
  answersByPrompt,
  planPages,
}: {
  state: Loadable<{ rows: AnswerCoverageRow[] }>;
  reduced: boolean;
  projectId: string;
  ownHost: string;
  captions: string[];
  num?: string;
  accent?: Accent;
  /** GEO live: prompt ids with queued pairs in the active run ("Asking…"). */
  askingPrompts?: ReadonlySet<string>;
  /** GEO: the latest revealed answer of this run per prompt id. */
  answersByPrompt?: ReadonlyMap<string, LiveGeoAnswerRow>;
  /** Page URLs (urlPath) that have a rewrite plan ("Improve the page" links to it). */
  planPages?: ReadonlySet<string>;
}) {
  const rows = (state.data?.rows ?? []).slice().sort((a, b) => GAP_ORDER[a.gap] - GAP_ORDER[b.gap] || (a.text < b.text ? -1 : 1));
  const c = coverageCounts(rows);
  // Big number as in the reference ("41% of questions we have no page for"): computed by code, n of m below.
  const pctOf = (n: number, d: number) => Math.round((n / d) * 100);
  return (
    <Panel
      num={num}
      title="Do our pages answer what people ask AI?"
      accent={accent}
      reduced={reduced}
      testId="coverage"
      counter={
        state.data
          ? c.total > 0
            ? { value: pctOf(c.noPage, c.total), format: fmtPct, suffix: "no page", sub: `${fmtInt(c.noPage)} of ${fmtInt(c.total)} approved prompts` }
            : { value: 0, suffix: "approved prompts", sub: "Approve prompts to match them to your pages" }
          : null
      }
      subtitle="Your approved prompts matched to your best page (measured overlap) and to who the engines cited."
      captions={captions}
    >
      {!state.data ? (
        <LoadState state={state} what="answer coverage" />
      ) : rows.length === 0 ? (
        <PanelEmpty>
          No approved prompts yet. <Link to={projectPath(projectId, "geo/prompts")}>Approve prompts</Link>.
        </PanelEmpty>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">Approved prompts, matched page and who the engines cited</caption>
          <thead className={THEAD}>
            <tr>
              <LTH className="w-[42%] @lg:w-[32%] @xl:w-[25%] @3xl:w-[25%]">Approved prompt</LTH>
              <LTH tight className="hidden text-center @3xl:table-cell @3xl:w-[5%]" title="Engines asked: engines that answered this prompt (no question-volume source exists)">
                Eng.
              </LTH>
              <LTH className="hidden @lg:table-cell @lg:w-[20%] @xl:w-[14%] @3xl:w-[14%]">Our best page</LTH>
              <LTH className="hidden @xl:table-cell @xl:w-[11%]">Match</LTH>
              <LTH className="w-[30%] @lg:w-[18%] @xl:w-[16%] @3xl:w-[15%]">AI cites</LTH>
              <LTH className="w-[28%] @lg:w-[16%] @xl:w-[18%] @3xl:w-[15%]">Verdict</LTH>
              <LTH className="hidden @lg:table-cell @lg:w-[14%] @xl:w-[16%] @3xl:w-[15%]">Next step</LTH>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((r) => {
              const v = GAP_VERDICT[r.gap];
              const answer = answersByPrompt?.get(r.promptId);
              const asking = askingPrompts?.has(r.promptId) ?? false;
              const pagePath = r.matchedPage ? urlPath(r.matchedPage.url) : null;
              return (
                <tr key={r.promptId} className={cx("lv-move", !(asking && !answer) && ACCENT[accent].row)}>
                  <LTD className="text-zinc-900 dark:text-zinc-100" title={r.text}>
                    <span className="block truncate">{r.text}</span>
                  </LTD>
                  <LTD tight className="hidden text-center font-mono tabular-nums text-zinc-700 @3xl:table-cell dark:text-zinc-300">{fmtInt(r.providersRun)}</LTD>
                  <LTD className="hidden font-mono text-[11px] text-zinc-700 @lg:table-cell dark:text-zinc-300" title={r.matchedPage?.url}>
                    {pagePath ?? "—"}
                  </LTD>
                  <LTD className="hidden @xl:table-cell" title={r.matchedPage ? `overlap ${r.matchedPage.score.toFixed(2)} · ${METHOD_TAG[r.matchedPage.method]} · ${r.basis}` : r.basis}>
                    {r.matchedPage ? (
                      <span className="flex min-w-0 items-center gap-1">
                        <MiniBar value={r.matchedPage.score} label={`overlap ${r.matchedPage.score.toFixed(2)} · ${METHOD_TAG[r.matchedPage.method]}`} className="w-8 shrink-0" />
                        <span className="font-mono text-[11px] text-zinc-700 tabular-nums dark:text-zinc-300">{r.matchedPage.score.toFixed(2)}</span>
                        <span className="sr-only"> overlap, {METHOD_TAG[r.matchedPage.method]}</span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </LTD>
                  <LTD>
                    <AiCites row={r} answer={answer} asking={asking} ownHost={ownHost} />
                  </LTD>
                  <LTD className="overflow-visible">
                    {asking && !answer ? (
                      <Shimmer label="Asking…" />
                    ) : (
                      <ToneChip tone={v.tone} className="max-w-none">
                        {v.label}
                      </ToneChip>
                    )}
                  </LTD>
                  <LTD className="hidden text-[11px] leading-tight whitespace-normal text-zinc-700 @lg:table-cell dark:text-zinc-300">
                    {r.gap === "improve" && pagePath && planPages?.has(pagePath) ? (
                      <Link to={projectPath(projectId, "geo/board")}>{v.next}</Link>
                    ) : r.gap === "create_page" ? (
                      <Link to={projectPath(projectId, "recommendations")}>{v.next}</Link>
                    ) : (
                      v.next
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

// ------------------------------------------------------------------ 07 How our pages show up in AI answers
export const FACTOR_COLUMNS: Array<{ key: SkipFactorKey; label: string; long: string }> = [
  { key: "answer_first", label: "Answer", long: "Answer first" },
  { key: "entity_facts", label: "Facts", long: "Entity facts" },
  { key: "sources_cited", label: "Source", long: "Sources cited" },
  { key: "faq_schema", label: "Schema", long: "FAQ schema" },
  { key: "freshness", label: "Fresh", long: "Freshness" },
];

const NEXT_STEP: Record<CitationEvidenceRow["nextStep"], string | null> = {
  compare: "Compare with the pages cited alongside",
  add_proof: "Add proof (sources, data)",
  none: null,
};

export interface EvidencePageRow {
  url: string;
  pageId: string | null;
  citedCount: number;
  providers: string[];
  lastCitedAt: string | null;
  citedAlongside: Array<{ host: string }>;
  nextStep: string | null;
  reason: string | null;
}

/** Evidence pages first, then matched-but-not-cited coverage pages as "Cited in 0" (deduped by URL). */
export function evidencePages(evidence: readonly CitationEvidenceRow[], coverage: readonly AnswerCoverageRow[]): EvidencePageRow[] {
  const out: EvidencePageRow[] = evidence.map((e) => ({
    url: e.url,
    pageId: e.pageId,
    citedCount: e.citedCount,
    providers: e.providers,
    lastCitedAt: e.lastCitedAt,
    citedAlongside: e.citedAlongside,
    nextStep: NEXT_STEP[e.nextStep],
    reason: e.reason || null,
  }));
  const seen = new Set(out.map((r) => urlPath(r.url)));
  for (const c of coverage) {
    if (c.gap !== "improve" || !c.matchedPage) continue;
    const k = urlPath(c.matchedPage.url);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ url: c.matchedPage.url, pageId: null, citedCount: 0, providers: [], lastCitedAt: null, citedAlongside: c.topOtherSource ? [{ host: c.topOtherSource.host }] : [], nextStep: null, reason: null });
  }
  return out;
}

/**
 * Skip factors of one page: the result, "error", undefined while genuinely being fetched, or "not_loaded"
 * for a page whose factors are never requested (only the first few pages are).
 */
export type SkipLookup = PageSkipFactors | "error" | "not_loaded" | undefined;

export function AiAnswersPanel({
  evidence,
  coverage,
  skipFor,
  factorPages,
  reduced,
  captions,
  num = "07",
}: {
  evidence: Loadable<{ rows: CitationEvidenceRow[] }>;
  coverage: AnswerCoverageRow[] | null;
  skipFor: (pageId: string) => SkipLookup;
  /** How many pages get factors (for the caption when more rows are listed). */
  factorPages?: number;
  reduced: boolean;
  captions: string[];
  num?: string;
}) {
  const rows = evidence.data ? evidencePages(evidence.data.rows, coverage ?? []) : [];
  const c = coverage ? coverageCounts(coverage) : null;
  const notLoaded = rows.some((r) => r.pageId && skipFor(r.pageId) === "not_loaded");
  const notLoadedNote = `Factors are loaded for the first ${fmtInt(factorPages ?? 8)} pages only`;
  return (
    <Panel
      num={num}
      title="How our pages show up in AI answers"
      accent="rose"
      reduced={reduced}
      testId="ai-answers"
      counter={
        c
          ? c.answered > 0
            ? { value: Math.round((c.citeUs / c.answered) * 100), format: fmtPct, suffix: "cite us", sub: `${fmtInt(c.citeUs)} of ${fmtInt(c.answered)} answered prompts` }
            : { value: 0, suffix: "answered prompts", sub: "No stored answer yet" }
          : null
      }
      subtitle="Stored citations of your pages (latest stored answer per prompt) and five measured page attributes. No likelihood of any kind is shown."
      captions={notLoaded ? [...captions, `${notLoadedNote}.`] : captions}
    >
      {!evidence.data ? (
        <LoadState state={evidence} what="citation evidence" />
      ) : rows.length === 0 ? (
        <PanelEmpty>No page of yours appears in stored AI answers yet.</PanelEmpty>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">Your pages in stored AI answers, with measured attributes</caption>
          <thead className={THEAD}>
            <tr>
              <LTH className="w-[40%] @lg:w-[34%] @xl:w-[21%]">Page</LTH>
              <LTH className="w-[28%] @lg:w-[22%] @xl:w-[14%]">Cited in</LTH>
              {FACTOR_COLUMNS.map((f) => (
                <LTH key={f.key} tight className="hidden text-center @xl:table-cell @xl:w-[7.5%]" title={f.long}>
                  {f.label}
                </LTH>
              ))}
              <LTH tight className="hidden @lg:table-cell @lg:w-[22%] @xl:w-[11.5%]" title="Cited alongside: other hosts in the same stored answers">
                Alongside
              </LTH>
              <LTH className="w-[32%] @lg:w-[22%] @xl:w-[16%]">Next step</LTH>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((r) => {
              const sf = r.pageId ? skipFor(r.pageId) : undefined;
              const factors = sf && sf !== "error" && sf !== "not_loaded" ? new Map(sf.factors.map((f) => [f.key, f])) : null;
              const firstMissing = factors ? FACTOR_COLUMNS.find((f) => factors.get(f.key)?.status === "missing") : undefined;
              const next = r.nextStep ?? (firstMissing ? `First missing: ${firstMissing.long}` : "—");
              return (
                <tr key={r.url} className={r.citedCount > 0 ? ACCENT.rose.row : undefined}>
                  <LTD className="font-mono text-zinc-900 dark:text-zinc-100" title={r.url}>
                    {urlPath(r.url)}
                  </LTD>
                  <LTD title={`Cited in ${fmtInt(r.citedCount)} stored answer${r.citedCount === 1 ? "" : "s"}${r.lastCitedAt ? `, last ${shortDate(r.lastCitedAt)}` : ""}`}>
                    <span className="flex min-w-0 items-center gap-1 whitespace-nowrap">
                      <span className="font-mono text-[11px] text-zinc-800 tabular-nums dark:text-zinc-200">
                        <span className="sr-only">Cited in {fmtInt(r.citedCount)} answer{r.citedCount === 1 ? "" : "s"}</span>
                        <span aria-hidden="true">Cited {fmtInt(r.citedCount)}×</span>
                      </span>
                      {r.providers.map((p) => (
                        <EngineBadge key={p} provider={p} />
                      ))}
                    </span>
                  </LTD>
                  {FACTOR_COLUMNS.map((fc) => {
                    const f = factors?.get(fc.key);
                    return (
                      <LTD key={fc.key} tight className="hidden text-center @xl:table-cell">
                        {f ? (
                          <BlockBar status={f.status} label={fc.long} accent="rose" title={`${fc.long}: ${f.status} · ${clipText(f.measured, 80)} · ${f.method === "heuristic" ? "Heuristic" : "Measured"}`} />
                        ) : r.pageId && sf === undefined ? (
                          // Genuinely pending: this page's factors are being fetched.
                          <span className="lv-shimmer inline-block h-2 w-7 rounded" aria-hidden="true" />
                        ) : sf === "not_loaded" ? (
                          <span className="text-zinc-400 dark:text-zinc-500" title={notLoadedNote}>
                            —
                          </span>
                        ) : (
                          <span className="text-zinc-400 dark:text-zinc-500">—</span>
                        )}
                      </LTD>
                    );
                  })}
                  <LTD className="hidden text-[11px] text-zinc-700 @lg:table-cell dark:text-zinc-300" title={r.citedAlongside.map((h) => h.host).join(", ")}>
                    {r.citedAlongside.length ? r.citedAlongside.slice(0, 3).map((h) => h.host).join(", ") : "—"}
                  </LTD>
                  <LTD className="text-[11px] leading-tight whitespace-normal text-zinc-700 dark:text-zinc-300" title={r.reason ?? undefined}>
                    <span className="line-clamp-2">{next}</span>
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
