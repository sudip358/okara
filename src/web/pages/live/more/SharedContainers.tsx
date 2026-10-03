/**
 * Project containers shown in both modes (docs/live-view-design.md section 17): the sheet syncs (SEO 14 "Master
 * sheet sync": every synced tab; GEO 10 "AI questions from your sheet": the GEO-prompt tabs and the prompt set
 * they feed) with a per-row "Sync now", and today's budget and quotas (SEO 15 / GEO 11), which has no run
 * button. Sheet names, tabs and errors are the user's text, shown as plain text.
 */
import { Link } from "react-router";
import type { LiveBudgetInsight, LiveBudgetLine, LiveSheetSyncRow, LiveSheetsInsight } from "@shared/types";
import { cx } from "@web/components/ui";
import { projectPath } from "@web/lib/project-context";
import { ACCENT, Panel, PanelEmpty, ToneChip } from "../parts";
import { SectionButton } from "../RunActions";
import { sheetSyncAction } from "../run-actions";
import { fmtInt, shortDate } from "../text";
import { LoadState, Notes, captionsFor, type Loadable } from "./common";
import { useInsight, useLiveMore } from "./data";
import { DESTINATION_LABEL, nOfM, projectCaption, recentText, syncState, usdMicros } from "./format";

const when = (iso: string | null) => {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${shortDate(iso)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// ------------------------------------------------------------------ SEO 14 / GEO 10 sheet syncs
function SyncRow({ s, d, projectId, demo, geo }: { s: LiveSheetSyncRow; d: LiveSheetsInsight; projectId: string; demo: boolean; geo: boolean }) {
  const st = syncState(s);
  const action = sheetSyncAction({ projectId, demo }, s, { canManage: d.canManage, sheets: d.sheets, perHour: d.syncNowPerHour });
  return (
    <li className={cx("min-w-0 rounded-md border border-zinc-200 px-2.5 py-1.5 dark:border-zinc-800", ACCENT.zinc.row)}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <div className="min-w-0 flex-1 basis-40">
          <p className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100" title={`${s.tab} · ${s.spreadsheetTitle}`}>
            {s.tab}
          </p>
          <p className="truncate text-[11px] text-zinc-600 dark:text-zinc-400" title={s.spreadsheetTitle}>
            {s.spreadsheetTitle} → {DESTINATION_LABEL[s.destination]}
          </p>
        </div>
        <SectionButton action={action} />
      </div>
      <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-700 dark:text-zinc-300">
        <ToneChip tone={st.tone}>{st.label}</ToneChip>
        <span>Last run {when(s.lastRunAt)}</span>
        <span>{s.enabled ? `Next ${when(s.nextRunAt)} · every ${s.frequencyHours} h` : "Not scheduled (paused)"}</span>
      </p>
      <p className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-400">{recentText(s.recent)}</p>
      {geo && s.prompts && (
        <p className="mt-0.5 text-[11px] text-zinc-700 dark:text-zinc-300">
          {fmtInt(s.prompts.inSet)} question{s.prompts.inSet === 1 ? "" : "s"} in the active set ({fmtInt(s.prompts.approved)} approved)
          {s.prompts.setFull ? ` · ${fmtInt(s.prompts.setFull)} not added (set full)` : ""}
          {s.prompts.archived ? ` · ${fmtInt(s.prompts.archived)} archived` : ""} · last asked {s.prompts.lastAskedAt ? shortDate(s.prompts.lastAskedAt) : "not yet"}
        </p>
      )}
      {s.lastError && <p className="mt-0.5 line-clamp-2 text-[11px] text-rose-700 dark:text-rose-300">{s.lastError}</p>}
      {s.lastWarning && <p className="mt-0.5 line-clamp-2 text-[11px] text-amber-800 dark:text-amber-300">{s.lastWarning}</p>}
    </li>
  );
}

export function SheetsPanel({ state, mode, reduced, projectId, demo, replaying }: { state: Loadable<LiveSheetsInsight>; mode: "seo" | "geo"; reduced: boolean; projectId: string; demo: boolean; replaying: boolean }) {
  const d = state.data;
  const geo = mode === "geo";
  const syncs = d ? (geo ? d.syncs.filter((s) => s.destination === "geo_prompts") : d.syncs) : [];
  const errors = syncs.filter((s) => s.lastStatus === "error").length;
  const latest = syncs.map((s) => s.lastRunAt).filter((x): x is string => !!x).sort().pop() ?? null;
  const approvedFromSheet = syncs.reduce((a, s) => a + (s.prompts?.approved ?? 0), 0);
  const captions = captionsFor(
    [
      latest ? projectCaption("latest sheet syncs", latest) : null,
      d && d.sheets !== "ready" && d.sheets !== "demo" ? (d.sheets === "error" ? "Google Sheets authorization expired" : "Google Sheets is not connected") : null,
      geo && d?.activePromptSet ? `Feeds prompt set v${d.activePromptSet.version}${d.activePromptSet.label ? ` · ${d.activePromptSet.label}` : ""}` : null,
    ],
    replaying,
    d?.labels ?? [],
  );
  return (
    <Panel
      num={geo ? "10" : "14"}
      title={geo ? "AI questions from your sheet" : "Master sheet sync"}
      accent="zinc"
      reduced={reduced}
      testId={geo ? "sheet-prompts" : "sheets"}
      counter={
        d && syncs.length > 0
          ? geo
            ? { value: approvedFromSheet, suffix: "approved questions", sub: `from ${fmtInt(syncs.length)} synced tab${syncs.length === 1 ? "" : "s"}` }
            : { value: syncs.length, suffix: "synced tabs", sub: errors ? `${fmtInt(errors)} with an error` : "no errors" }
          : null
      }
      subtitle={
        geo
          ? "Sheet tabs kept in sync into your GEO prompts: what they put in the active prompt set and when those questions were last asked."
          : "Sheet tabs kept in sync with Okara (competitors, AI questions, placed links): last run, status and the changes applied."
      }
      captions={captions}
    >
      {!d ? (
        <LoadState state={state} what="sheet syncs" />
      ) : d.state === "setup_required" ? (
        <PanelEmpty>{d.message}</PanelEmpty>
      ) : syncs.length === 0 ? (
        <PanelEmpty>
          {geo ? "No sheet tab feeds your GEO prompts." : "No sheet tab is kept in sync."}{" "}
          <Link to={projectPath(projectId, "import")}>Import a tab and keep it in sync on the Import page</Link>.
        </PanelEmpty>
      ) : (
        <>
          <ul className="space-y-1.5" aria-label="Synced sheet tabs">
            {syncs.map((s) => (
              <SyncRow key={s.id} s={s} d={d} projectId={projectId} demo={demo} geo={geo} />
            ))}
          </ul>
          {geo && d.activePromptSet && (
            <p className="pt-2 text-[11px] text-zinc-600 dark:text-zinc-400">
              Active prompt set v{d.activePromptSet.version}: {nOfM(d.activePromptSet.approved, d.activePromptSet.prompts)} prompts approved.
            </p>
          )}
          <p className="pt-1 text-[11px]">
            <Link to={projectPath(projectId, "import")}>Open the Import page</Link>
          </p>
          <Notes labels={d.labels} />
        </>
      )}
    </Panel>
  );
}

export function SheetsContainer({ projectId, reduced, mode }: { projectId: string; reduced: boolean; mode: "seo" | "geo" }) {
  const v = useLiveMore();
  return <SheetsPanel state={useInsight<LiveSheetsInsight>(projectId, "sheets")} mode={mode} reduced={reduced} projectId={projectId} demo={v.demo} replaying={v.replaying} />;
}

// ------------------------------------------------------------------ SEO 15 / GEO 11 budget and quotas today
const lineText = (l: LiveBudgetLine) => (l.resource === "usd_micros" ? `${usdMicros(l.used)} of ${usdMicros(l.limit)}` : nOfM(l.used, l.limit));

function Meter({ l, scope }: { l: LiveBudgetLine; scope: string }) {
  const frac = l.limit > 0 ? Math.min(1, l.used / l.limit) : 0;
  const text = lineText(l);
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-zinc-800 dark:text-zinc-200">{l.label}</span>
        <span className="shrink-0 font-mono text-zinc-700 tabular-nums dark:text-zinc-300">{text}</span>
      </div>
      <div
        role="meter"
        aria-label={`${scope} ${l.label}`}
        aria-valuemin={0}
        aria-valuemax={l.limit}
        aria-valuenow={Math.min(l.used, l.limit)}
        aria-valuetext={`${text}${l.counted ? "" : " (nothing reserved today)"}`}
        className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
      >
        <div className={cx("lv-bar h-full rounded-full", frac >= 1 ? "bg-rose-600 dark:bg-rose-400" : frac >= 0.8 ? "bg-amber-500 dark:bg-amber-400" : "bg-zinc-700 dark:bg-zinc-300")} style={{ width: `${Math.round(frac * 100)}%` }} />
      </div>
    </li>
  );
}

const KEY_WORD: Record<string, string> = { workspace_key: "your key", operator_key: "operator key" };

export function BudgetPanel({ state, mode, reduced, replaying }: { state: Loadable<LiveBudgetInsight>; mode: "seo" | "geo"; reduced: boolean; replaying: boolean }) {
  const d = state.data;
  const spend = d?.project.find((l) => l.resource === "usd_micros") ?? null;
  return (
    <Panel
      num={mode === "geo" ? "11" : "15"}
      title="Budget and quotas today"
      accent="zinc"
      reduced={reduced}
      testId="budget"
      counter={d && spend ? { value: spend.used, format: (n) => usdMicros(n), suffix: `of ${usdMicros(spend.limit)}`, sub: `priced spend, ${d.day} (UTC)` } : null}
      subtitle="Today's counters (UTC day) of this project's daily caps, the manual-run quota, and which key each provider uses. No run button: nothing here starts work."
      captions={captionsFor([d ? projectCaption(`usage counters today, ${d.day} UTC`) : null], replaying, d?.labels ?? [])}
    >
      {!d ? (
        <LoadState state={state} what="today's budget" />
      ) : (
        <div className="min-w-0 space-y-3">
          <p className="text-xs text-zinc-800 dark:text-zinc-200">
            Manual runs: <span className="font-mono tabular-nums">{nOfM(d.manualRuns.used, d.manualRuns.limit)}</span> used today (a partial run counts as one; scheduled runs are not counted).
          </p>
          <div className="min-w-0">
            <h3 className="pb-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">This project, today</h3>
            <ul className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1.5 @lg:grid-cols-2">
              {d.project.map((l) => (
                <Meter key={l.resource} l={l} scope="Project" />
              ))}
            </ul>
          </div>
          {d.global.length > 0 && (
            <div className="min-w-0">
              <h3 className="pb-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Operator's global allowance (shared by every project on the operator's keys)</h3>
              <ul className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1.5 @lg:grid-cols-2">
                {d.global.map((l) => (
                  <Meter key={l.resource} l={l} scope="Operator allowance" />
                ))}
              </ul>
            </div>
          )}
          <div className="min-w-0">
            <h3 className="pb-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Keys</h3>
            <ul className="flex min-w-0 flex-wrap gap-1.5 text-[11px]">
              {d.keys.map((k) => (
                <li key={k.provider} className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {k.label}: {k.source ? KEY_WORD[k.source] : "not set up"}
                </li>
              ))}
            </ul>
          </div>
          <ul className="space-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400" aria-label="How these are counted">
            {d.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <Notes labels={d.labels} />
        </div>
      )}
    </Panel>
  );
}

export function BudgetContainer({ projectId, reduced, mode }: { projectId: string; reduced: boolean; mode: "seo" | "geo" }) {
  const v = useLiveMore();
  return <BudgetPanel state={useInsight<LiveBudgetInsight>(projectId, "budget")} mode={mode} reduced={reduced} replaying={v.replaying} />;
}
