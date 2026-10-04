/**
 * Live Backlinks run buttons (docs/live-view-design.md section 19), pure so the labels, disabled reasons and confirm
 * text are unit-tested. Both are "call" actions of the section 16 RunActions dialog:
 *   - "Run backlink check": POST /backlinks/check {} (every active backlink; 3 per project per UTC day);
 *   - "Recheck failed/changed": POST /backlinks/check {ids} (failing rows first, then rows changed in the last 7 days;
 *     at most MAX_RECHECK_IDS; RECHECK_ROWS_PER_HOUR rows per project per hour).
 * Free actions: no paid provider is called; the confirm text says what is fetched and under which limits.
 */
import { FETCHES_PER_INVOCATION, HOST_INTERVAL_MS, MAX_RECHECK_IDS, RECHECK_ROWS_PER_HOUR, type BacklinkSummary } from "@shared/backlinks";
import type { SectionAction } from "../run-actions";
import { backlinksBase, jobActive, nOfM, progressText } from "@web/pages/backlinks/lib";

export interface BacklinkActionEnv {
  projectId: string;
  demo: boolean;
  summary: BacklinkSummary | null;
  /** Ids "Recheck failed/changed" would send (from the loaded rows). */
  recheckIds: string[];
}

export const RUN_KEY = "backlinks:run";
export const RECHECK_KEY = "backlinks:recheck";

export function runCheckAction(env: BacklinkActionEnv): SectionAction {
  const s = env.summary;
  const active = s?.totals.active ?? 0;
  const left = s ? Math.max(0, s.limits.manualPerDay - s.limits.manualUsedToday) : 0;
  let disabled: string | null = null;
  if (env.demo) disabled = "Demo project: backlink checks are disabled.";
  else if (!s) disabled = "Loading…";
  else if (active === 0) disabled = "No backlinks yet: import your built links (Import page, destination “Backlinks to monitor”).";
  else if (jobActive(s.job) && s.job!.scope === "all") disabled = `A backlink check is running (${progressText(s.job)}).`;
  else if (left === 0) disabled = `${s.limits.manualPerDay} manual checks per project per UTC day are used. The weekly check still runs.`;
  return {
    kind: "call",
    key: RUN_KEY,
    label: "Run backlink check",
    busyLabel: s && jobActive(s.job) && s.job!.scope === "all" ? "Checking…" : undefined,
    disabled,
    path: `${backlinksBase(env.projectId)}/check`,
    body: {},
    reload: "backlinks",
    doneText: "check started",
    confirm: {
      title: "Run backlink check",
      lines: [
        `Fetches each of your ${active.toLocaleString("en-US")} monitored live articles and looks for the link to your page (dofollow, nofollow, sponsored, ugc), and checks each target page on your site.`,
        `Public pages only; robots.txt is respected (a blocked page is not fetched); at most 1 request per ${HOST_INTERVAL_MS / 1000} s per host and ${FETCHES_PER_INVOCATION} requests per batch.`,
        "Free: no paid provider is called. Batches run while this page is open; otherwise the 15-minute background tick continues the check.",
        s ? `Uses 1 of the ${s.limits.manualPerDay} manual checks per project per UTC day (${left} left today).` : "",
      ].filter(Boolean),
    },
  };
}

export function recheckAction(env: BacklinkActionEnv): SectionAction {
  const s = env.summary;
  const ids = env.recheckIds.slice(0, MAX_RECHECK_IDS);
  let disabled: string | null = null;
  if (env.demo) disabled = "Demo project: backlink checks are disabled.";
  else if (!s) disabled = "Loading…";
  else if (ids.length === 0) disabled = "No failed or recently changed backlinks to recheck.";
  else if (jobActive(s.job) && s.job!.scope === "ids") disabled = `A recheck is running (${progressText(s.job)}).`;
  return {
    kind: "call",
    key: RECHECK_KEY,
    label: "Recheck failed/changed",
    disabled,
    path: `${backlinksBase(env.projectId)}/check`,
    body: { ids },
    reload: "backlinks",
    doneText: "recheck started",
    confirm: {
      title: "Recheck failed and changed backlinks",
      lines: [
        `Checks ${nOfM(ids.length, env.recheckIds.length)} failing or recently changed backlinks again (failing pages first; at most ${MAX_RECHECK_IDS} per recheck).`,
        `Rechecks are limited to ${RECHECK_ROWS_PER_HOUR} backlinks per project per hour. Free: no paid provider is called; robots.txt is respected.`,
      ],
    },
  };
}
