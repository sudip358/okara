/**
 * [A37] Live GEO 12 "Question queries from Search Console": the top question-style queries of the project's stored
 * Search Console sync that are not in the prompt set yet (GET /projects/:pid/geo/prompts/from-gsc: read-only, no
 * provider call), next to GEO 10 "AI questions from your sheet". No run button: adding happens on the GEO prompts
 * page ("↗ Review on GEO prompts"). Refetched on mount and when the shown run's seo.gsc_sync step ends.
 * Queries and landing pages are Search Console text: plain text only.
 */
import { Link } from "react-router";
import type { GscQuestionsResponse } from "@shared/gsc-questions";
import { useApi } from "@web/lib/hooks";
import { projectPath } from "@web/lib/project-context";
import { landingPath, positionText } from "@web/pages/geo/gsc-questions-lib";
import { LTH, Panel, PanelEmpty, THEAD } from "../parts";
import { fmtInt, shortDate } from "../text";
import { LoadState, Notes, SetupNote, captionsFor, type Loadable } from "./common";
import { useLiveMore } from "./data";

/** Rows shown in the container (the GEO prompts page lists up to the server cap). */
export const LIVE_GSC_QUESTION_ROWS = 8;

export const gscQuestionsPath = (pid: string) => `/projects/${encodeURIComponent(pid)}/geo/prompts/from-gsc`;

export function GscQuestionsLivePanel({ state, reduced, projectId, replaying }: { state: Loadable<GscQuestionsResponse>; reduced: boolean; projectId: string; replaying: boolean }) {
  const d = state.data;
  const rows = d ? d.candidates.slice(0, LIVE_GSC_QUESTION_ROWS) : [];
  const review = (
    <Link to={`${projectPath(projectId, "geo/prompts")}#from-search-console`} className="text-[11px]">
      ↗ Review on GEO prompts
    </Link>
  );
  return (
    <Panel
      num="12"
      title="Question queries from Search Console"
      accent="sky"
      reduced={reduced}
      testId="gsc-questions"
      counter={d && (d.state === "ready" || d.state === "demo") ? { value: d.counts.eligible, suffix: "new question queries", sub: "not in your prompt set yet" } : null}
      subtitle="Question-style queries people typed into Google for your site (how, what, best, vs, …), ranked by impressions. Add them as GEO prompts, as typed, on the GEO prompts page."
      captions={captionsFor([d?.sync ? `From your latest Search Console sync (${shortDate(d.sync.syncedAt)}), not part of this run` : null], replaying, d?.labels ?? [])}
    >
      {!d ? (
        <LoadState state={state} what="Search Console questions" />
      ) : d.state === "setup_required" ? (
        <SetupNote message={d.message} projectId={projectId} to="integrations" linkLabel="Connect Search Console in Integrations" />
      ) : d.state === "disabled" ? (
        <PanelEmpty>{d.message}</PanelEmpty>
      ) : rows.length === 0 ? (
        <>
          <PanelEmpty>No new question queries in the stored sync.</PanelEmpty>
          <p className="text-center">{review}</p>
        </>
      ) : (
        <>
          <table className="w-full table-fixed border-collapse text-xs">
            <caption className="sr-only">Top question queries from Search Console not yet in the prompt set, by impressions</caption>
            <thead className={THEAD}>
              <tr>
                <LTH className="w-[58%]">Question (as searched)</LTH>
                <LTH className="text-right">Impr.</LTH>
                <LTH className="text-right">Pos.</LTH>
                <LTH className="hidden @md:table-cell">Page</LTH>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((c) => (
                <tr key={c.key} data-testid="gsc-question-live-row">
                  <th scope="row" className="truncate py-1 pr-2 text-left font-normal text-zinc-800 dark:text-zinc-200" title={c.text}>
                    {c.text}
                  </th>
                  <td className="py-1 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">{fmtInt(c.evidence.impressions)}</td>
                  <td className="py-1 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300">{positionText(c.evidence.position)}</td>
                  <td className="hidden truncate py-1 pl-2 text-zinc-600 @md:table-cell dark:text-zinc-400" title={c.evidence.landingPage ?? undefined}>
                    {landingPath(c.evidence.landingPage)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.counts.eligible > rows.length && (
            <p className="pt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              Showing {fmtInt(rows.length)} of {fmtInt(d.counts.eligible)}.
            </p>
          )}
          <p className="pt-1">{review}</p>
          <Notes labels={d.labels.slice(0, 1)} />
        </>
      )}
    </Panel>
  );
}

export function GscQuestionsContainer({ projectId, reduced }: { projectId: string; reduced: boolean }) {
  const v = useLiveMore();
  const state = useApi<GscQuestionsResponse>(projectId ? gscQuestionsPath(projectId) : null, [v.keys.gsc]);
  return <GscQuestionsLivePanel state={state} reduced={reduced} projectId={projectId} replaying={v.replaying} />;
}
