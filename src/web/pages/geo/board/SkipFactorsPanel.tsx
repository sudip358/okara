/**
 * B · Our pages: why an engine skips them (design §4). Observable attributes measured from the latest crawl,
 * one row per factor with its measured text. No bars with invented percentages, no aggregate score, and
 * nothing is created automatically.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router";
import type { AnswerCoverageRow, EngineLaneSummary, PageRow, SkipFactor } from "@shared/types";
import { formatDate, formatNumber } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import { Badge, ErrorState, LoadingState, cx, inputClass } from "@web/components/ui";
import { ExternalUrl } from "@web/components/ExternalUrl";
import { useSkipFactors } from "./data";
import { FACTOR_STATUS, LABELS, engineName, methodLabel, skipCandidates, type SkipCandidate } from "./lib";

export interface SkipInputs {
  coverage: AnswerCoverageRow[] | null;
  pages: PageRow[] | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
}

export function FactorRow({ f }: { f: SkipFactor }) {
  const st = FACTOR_STATUS[f.status];
  return (
    <li className="min-w-0 border-t border-zinc-100 py-1.5 first:border-t-0 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">{f.label}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-[11px] text-zinc-600 dark:text-zinc-400">{f.method === "heuristic" ? LABELS.heuristic : methodLabel("measured")}</span>
      </div>
      <p className="break-words text-xs text-zinc-700 dark:text-zinc-300">{f.measured}</p>
      {f.citedPage && (
        <p className="mt-0.5 break-words text-[11px] text-zinc-600 dark:text-zinc-400">
          Cited page: {FACTOR_STATUS[f.citedPage.status].label.toLowerCase()} · {f.citedPage.measured}
        </p>
      )}
    </li>
  );
}

function SkipFactorsDetail({ projectId, engine, candidate }: { projectId: string; engine: string; candidate: SkipCandidate & { pageId: string } }) {
  const { data, error, loading, reload } = useSkipFactors(projectId, { pageId: candidate.pageId, promptId: candidate.promptId }, engine);
  if (loading && !data) return <LoadingState label="Loading page attributes…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;
  const name = engineName(engine);
  return (
    <div className="min-w-0 space-y-2">
      <div className="min-w-0 space-y-0.5 text-xs">
        <p className="text-zinc-600 dark:text-zinc-400">
          Reading {data.page.snapshotAt ? `crawl of ${formatDate(data.page.snapshotAt)}` : "no crawl yet"}
        </p>
        <ExternalUrl url={data.page.url} className="font-medium" />
        {data.promptText && (
          <p className="break-words text-zinc-700 dark:text-zinc-300">
            For “{data.promptText}”{" "}
            {data.citedInsteadHost ? (
              <>
                {name} cites <span className="break-all font-medium">{data.citedInsteadHost}</span>
              </>
            ) : (
              <>{name} cites no single other source</>
            )}
          </p>
        )}
        <p className="text-zinc-600 dark:text-zinc-400">{data.page.wordCount !== null ? `${formatNumber(data.page.wordCount)} words` : "Word count unknown"}</p>
      </div>
      <ul className="min-w-0">
        {data.factors.map((f) => (
          <FactorRow key={f.key} f={f} />
        ))}
      </ul>
      <p className="text-[11px] text-zinc-600 dark:text-zinc-400">Basis: {data.basis}</p>
      {data.labels.length > 0 && <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{data.labels.join(" · ")}</p>}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <Link to={projectPath(projectId, "draft-check")}>Draft check this page</Link>
      </div>
    </div>
  );
}

/** Body: candidate picker + factor list. Requests its inputs on mount (lazy). */
export function SkipFactorsBody({ projectId, lane, inputs, onNeed }: { projectId: string; lane: EngineLaneSummary; inputs: SkipInputs; onNeed: () => void }) {
  useEffect(() => {
    onNeed();
  }, [onNeed]);
  const selectId = useId();
  const candidates = useMemo(
    () => (inputs.coverage && inputs.pages ? skipCandidates(lane.feed, inputs.coverage, inputs.pages) : null),
    [lane.feed, inputs.coverage, inputs.pages],
  );
  const [selected, setSelected] = useState<string | null>(null);

  if (inputs.error) return <ErrorState error={inputs.error} onRetry={inputs.reload} />;
  if (!candidates) return <LoadingState label="Matching prompts to your pages…" />;
  if (candidates.length === 0) return <p className="text-xs text-zinc-600 dark:text-zinc-400">No prompt in the latest cohort skipped you on {engineName(lane.provider)}.</p>;

  const current = candidates.find((c) => c.promptId === selected) ?? candidates.find((c) => c.pageId !== null) ?? candidates[0]!;
  return (
    <div className="min-w-0 space-y-3">
      <div className="min-w-0">
        <label htmlFor={selectId} className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
          Prompt where {engineName(lane.provider)} skips you
        </label>
        <select id={selectId} className={cx(inputClass, "mt-0.5 text-xs")} value={current.promptId} onChange={(e) => setSelected(e.target.value)}>
          {candidates.map((c) => (
            <option key={c.promptId} value={c.promptId}>
              {c.promptText.length > 90 ? `${c.promptText.slice(0, 89)}…` : c.promptText}
              {c.pageId ? "" : " (no matching page)"}
            </option>
          ))}
        </select>
      </div>
      {current.pageId ? (
        <SkipFactorsDetail key={`${current.promptId}:${current.pageId}`} projectId={projectId} engine={lane.provider} candidate={{ ...current, pageId: current.pageId }} />
      ) : (
        <div className="space-y-1 text-xs text-zinc-700 dark:text-zinc-300">
          <p>
            {current.pageUrl ? (
              <>
                Matched page <span className="break-all">{current.pageUrl}</span> is not in the latest crawl.
              </>
            ) : (
              "No matching page on your site for this prompt."
            )}
          </p>
          <Link to={projectPath(projectId, "recommendations")}>See page recommendations</Link>
        </div>
      )}
      <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{LABELS.skipCaveat}</p>
    </div>
  );
}

export function skipSectionTitle(lane: EngineLaneSummary): string {
  const missing = lane.feed.filter((f) => f.status === "missing").length;
  return `${formatNumber(missing)} prompt${missing === 1 ? "" : "s"} where ${engineName(lane.provider)} skips you: your pages, measured`;
}
