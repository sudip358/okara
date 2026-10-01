/**
 * Project-level panels reused by both modes (existing endpoints, not time-indexed):
 * 05 Competitor pages worth adapting (GET /geo/competitor-pages; only pages a user approved),
 * 06 Do our pages answer what people ask AI? (GET /geo/answer-coverage),
 * 07 How our pages show up in AI answers (GET /geo/citation-evidence + skip factors).
 * No ranks without a source, no "cited %" share, no chance / after percentages: counts of stored rows and
 * measured statuses only. We adapt competitor structure, never copy text.
 */
import { Link } from "react-router";
import type { AnswerCoverageRow, CitationEvidenceRow, CompetitorCheckKey, CompetitorPageAssessment, FactorStatus, LiveGeoAnswerRow, PageSkipFactors, SkipFactorKey } from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx, ErrorState } from "@web/components/ui";
import { ASSESSMENT_STATE, VERDICT, checkStatus } from "@web/pages/geo/board/lib";
import { sourceTypeLabel } from "@web/pages/geo/lib";
import { Shimmer } from "./motion";
import { BlockBar, EngineBadge, LTD, LTH, MiniBar, Panel, PanelEmpty, StatusDot, ToneChip, type Accent, type ToneName } from "./parts";
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
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <LTH className="w-[30%] sm:w-[24%] md:w-[18%]">Site</LTH>
              <LTH className="hidden sm:table-cell sm:w-[34%] md:w-[20%]">Page</LTH>
              {COMP_CHECKS.map((c) => (
                <LTH key={c.key} className="hidden md:table-cell md:w-[7%]">
                  {c.label}
                </LTH>
              ))}
              <LTH className="w-[40%] sm:w-[24%] md:w-[15%]">Cited in</LTH>
              <LTH className="w-[30%] sm:w-[18%] md:w-[12%]">Verdict</LTH>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {list.map((a) => {
              const st = ASSESSMENT_STATE[a.state];
              const byKey = new Map(a.checks.map((c) => [c.key, c]));
              const providers = Array.from(new Set(a.citedIn.map((c) => c.provider)));
              return (
                <tr key={a.id}>
                  <LTD className="font-semibold text-zinc-900 dark:text-zinc-100" title={a.host}>
                    <span className="block truncate">{a.host}</span>
                    <span className="block truncate text-[11px] font-normal text-zinc-500 dark:text-zinc-400">{sourceTypeLabel(a.sourceType)}</span>
                  </LTD>
                  <LTD className="hidden font-mono text-zinc-700 sm:table-cell dark:text-zinc-300" title={a.url}>
                    <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="block truncate text-inherit">
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
                      <LTD key={ck.key} className="hidden md:table-cell">
                        {st.pending ? <span className="lv-shimmer inline-block h-2 w-8 rounded" aria-hidden="true" /> : <BlockBar status={status} label={ck.label} title={tip} />}
                      </LTD>
                    );
                  })}
                  <LTD className="whitespace-normal">
                    <span className="block font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                      {fmtInt(a.citedIn.length)} stored answer{a.citedIn.length === 1 ? "" : "s"}
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-0.5">
                      {providers.map((p) => (
                        <EngineBadge key={p} provider={p} />
                      ))}
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
  const pct = c.total > 0 ? `${Math.round((c.noPage / c.total) * 100)}% of approved prompts` : undefined;
  return (
    <Panel
      num={num}
      title="Do our pages answer what people ask AI?"
      accent={accent}
      reduced={reduced}
      testId="coverage"
      counter={state.data ? { value: c.noPage, suffix: `of ${fmtInt(c.total)} approved prompts have no matching page`, sub: pct } : null}
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
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <LTH className="w-[42%] sm:w-[32%] md:w-[26%]">Approved prompt</LTH>
              <LTH className="hidden md:table-cell md:w-[8%]" title="Engines that answered this prompt (no question-volume source exists)">
                Engines
              </LTH>
              <LTH className="hidden sm:table-cell sm:w-[20%] md:w-[18%]">Our best page</LTH>
              <LTH className="hidden md:table-cell md:w-[12%]">Match</LTH>
              <LTH className="w-[30%] sm:w-[18%] md:w-[14%]">AI cites</LTH>
              <LTH className="w-[28%] sm:w-[16%] md:w-[12%]">Verdict</LTH>
              <LTH className="hidden sm:table-cell sm:w-[14%] md:w-[10%]">Next step</LTH>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((r) => {
              const v = GAP_VERDICT[r.gap];
              const answer = answersByPrompt?.get(r.promptId);
              const asking = askingPrompts?.has(r.promptId) ?? false;
              const pagePath = r.matchedPage ? urlPath(r.matchedPage.url) : null;
              return (
                <tr key={r.promptId} className="lv-move">
                  <LTD className="text-zinc-900 dark:text-zinc-100" title={r.text}>
                    <span className="block truncate">{r.text}</span>
                  </LTD>
                  <LTD className="hidden font-mono tabular-nums text-zinc-700 md:table-cell dark:text-zinc-300">{fmtInt(r.providersRun)}</LTD>
                  <LTD className="hidden font-mono text-zinc-700 sm:table-cell dark:text-zinc-300" title={r.matchedPage?.url}>
                    {pagePath ?? "—"}
                  </LTD>
                  <LTD className="hidden md:table-cell" title={r.basis}>
                    {r.matchedPage ? (
                      <span className="flex min-w-0 items-center gap-1">
                        <MiniBar value={r.matchedPage.score} label={`overlap ${r.matchedPage.score.toFixed(2)}`} className="w-8 shrink-0" />
                        <span className="truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                          overlap {r.matchedPage.score.toFixed(2)} · {METHOD_TAG[r.matchedPage.method]}
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </LTD>
                  <LTD>
                    <AiCites row={r} answer={answer} asking={asking} ownHost={ownHost} />
                  </LTD>
                  <LTD className="overflow-visible">{asking && !answer ? <Shimmer label="Asking…" /> : <ToneChip tone={v.tone}>{v.label}</ToneChip>}</LTD>
                  <LTD className="hidden text-zinc-700 sm:table-cell dark:text-zinc-300">
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
  { key: "sources_cited", label: "Sources", long: "Sources cited" },
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

export function AiAnswersPanel({
  evidence,
  coverage,
  skipFor,
  reduced,
  captions,
  num = "07",
}: {
  evidence: Loadable<{ rows: CitationEvidenceRow[] }>;
  coverage: AnswerCoverageRow[] | null;
  skipFor: (pageId: string) => PageSkipFactors | "error" | undefined;
  reduced: boolean;
  captions: string[];
  num?: string;
}) {
  const rows = evidence.data ? evidencePages(evidence.data.rows, coverage ?? []) : [];
  const c = coverage ? coverageCounts(coverage) : null;
  return (
    <Panel
      num={num}
      title="How our pages show up in AI answers"
      accent="rose"
      reduced={reduced}
      testId="ai-answers"
      counter={c ? { value: c.citeUs, suffix: `of ${fmtInt(c.answered)} answered prompts cite our site`, sub: "stored answers, latest per prompt" } : null}
      subtitle="Stored citations of your pages and five measured page attributes. No likelihood of any kind is shown."
      captions={captions}
    >
      {!evidence.data ? (
        <LoadState state={evidence} what="citation evidence" />
      ) : rows.length === 0 ? (
        <PanelEmpty>No page of yours appears in stored AI answers yet.</PanelEmpty>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">Your pages in stored AI answers, with measured attributes</caption>
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <LTH className="w-[40%] sm:w-[34%] md:w-[24%]">Page</LTH>
              <LTH className="w-[28%] sm:w-[22%] md:w-[16%]">Cited in</LTH>
              {FACTOR_COLUMNS.map((f) => (
                <LTH key={f.key} className="hidden text-center md:table-cell md:w-[6%]" title={f.long}>
                  {f.label}
                </LTH>
              ))}
              <LTH className="hidden sm:table-cell sm:w-[22%] md:w-[16%]">Cited alongside</LTH>
              <LTH className="w-[32%] sm:w-[22%] md:w-[14%]">Next step</LTH>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((r) => {
              const sf = r.pageId ? skipFor(r.pageId) : undefined;
              const factors = sf && sf !== "error" ? new Map(sf.factors.map((f) => [f.key, f])) : null;
              const firstMissing = factors ? FACTOR_COLUMNS.find((f) => factors.get(f.key)?.status === "missing") : undefined;
              const next = r.nextStep ?? (firstMissing ? `First missing: ${firstMissing.long}` : "—");
              return (
                <tr key={r.url}>
                  <LTD className="font-mono text-zinc-900 dark:text-zinc-100" title={r.url}>
                    {urlPath(r.url)}
                  </LTD>
                  <LTD className="whitespace-normal">
                    <span className="block font-mono text-[11px] text-zinc-800 dark:text-zinc-200">
                      Cited in {fmtInt(r.citedCount)} answer{r.citedCount === 1 ? "" : "s"}
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-0.5">
                      {r.providers.map((p) => (
                        <EngineBadge key={p} provider={p} />
                      ))}
                      {r.lastCitedAt && <span className="text-[11px] text-zinc-500 dark:text-zinc-400">last {shortDate(r.lastCitedAt)}</span>}
                    </span>
                  </LTD>
                  {FACTOR_COLUMNS.map((fc) => {
                    const f = factors?.get(fc.key);
                    return (
                      <LTD key={fc.key} className="hidden text-center md:table-cell">
                        {f ? (
                          <StatusDot status={f.status} label={fc.long} title={`${fc.long}: ${f.status} · ${clipText(f.measured, 80)} · ${f.method === "heuristic" ? "Heuristic" : "Measured"}`} />
                        ) : r.pageId && sf === undefined ? (
                          <span className="lv-shimmer inline-block h-2.5 w-2.5 rounded-full" aria-hidden="true" />
                        ) : (
                          <span className="text-zinc-400 dark:text-zinc-500">—</span>
                        )}
                      </LTD>
                    );
                  })}
                  <LTD className="hidden text-zinc-700 sm:table-cell dark:text-zinc-300" title={r.citedAlongside.map((h) => h.host).join(", ")}>
                    {r.citedAlongside.length ? r.citedAlongside.slice(0, 3).map((h) => h.host).join(", ") : "—"}
                  </LTD>
                  <LTD className={cx("text-zinc-700 dark:text-zinc-300")} title={r.reason ?? undefined}>
                    {next}
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
