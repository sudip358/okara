/**
 * Live view section actions (docs/live-view-design.md section 12): which panel gets which "Run" button, its
 * label, its confirm text and why it is disabled. Pure (no React, no I/O) so the mapping is unit-tested.
 *
 * Kinds:
 * - run:  a manual agent run, all steps or a partial run (POST /projects/:pid/runs {agent, steps?, engines?}).
 *         "Run both" is one action with two runs.
 * - call: an existing standalone tool endpoint (buyer-query classification, internal-link analysis).
 * - link: navigation to the flow that needs the user's per-item approval (competitor pages); never auto-fetches.
 * A panel with no runnable action has no entry (no fake buttons).
 */
import type { AgentKind } from "@shared/types";
import { MANUAL_RUNS_PER_DAY, STEP_LABEL, type SectionStep } from "@shared/run-scope";

export interface RunSpec {
  agent: AgentKind;
  /** null = every step. */
  steps: SectionStep[] | null;
  engines?: string[];
}

interface ActionBase {
  key: string;
  /** Visible label after the ▶ icon, e.g. "Run crawl". */
  label: string;
  /** Why the action cannot start now (tooltip + aria-describedby); null = enabled. */
  disabled: string | null;
  /** Short label while disabled because the agent is running. */
  busyLabel?: string;
}

export interface ConfirmText {
  title: string;
  /** What it will call and what it uses (plain sentences). */
  lines: string[];
}

export type SectionAction =
  | (ActionBase & { kind: "run"; runs: RunSpec[]; confirm: ConfirmText })
  | (ActionBase & { kind: "call"; path: string; reload: "buyer" | "links"; confirm: ConfirmText })
  | (ActionBase & { kind: "link"; to: string });

export interface EngineInfo {
  provider: string;
  name: string;
  /** Lane is configured (board state ready). */
  ready: boolean;
  /** Why it is not ready (board stateDetail). */
  detail: string | null;
}

export interface ActionEnv {
  projectId: string;
  demo: boolean;
  verifiedHost: string | null;
  gscProperty: string | null;
  /** Agents with a pending/running run right now. */
  running: { seo: boolean; geo: boolean };
  /** Manual runs created today (UTC), from the run list; null = not known yet. */
  manualToday: number | null;
  /** GEO engine lanes from the engine board; null = not loaded (no engine-based block then). */
  engines: EngineInfo[] | null;
  /** Prompts one GEO batch asks (planned prompts of the shown GEO run); null = unknown. */
  promptCount: number | null;
  /** Standalone tools' current state (setup_required + its first label as the reason). */
  buyer?: { state: string; labels: string[] } | null;
  links?: { state: string; labels: string[] } | null;
  /** Project path builder (projectPath). */
  path: (sub: string) => string;
}

export const DEMO_REASON = "Demo project: runs are disabled (fixture data).";
export const QUOTA_REASON = `Manual run limit reached (${MANUAL_RUNS_PER_DAY} per project per UTC day). Scheduled runs continue daily.`;
const AGENT_NAME: Record<AgentKind, string> = { seo: "SEO", geo: "GEO" };

/** Shared blocks of agent-run actions: demo, an agent already running, the daily manual-run cap. */
export function runBlock(env: ActionEnv, agents: AgentKind[]): string | null {
  if (env.demo) return DEMO_REASON;
  const busy = agents.filter((a) => env.running[a]);
  if (busy.length) return `Running… a ${busy.map((a) => AGENT_NAME[a]).join(" and ")} run is in progress; one run per agent at a time.`;
  if (env.manualToday !== null && env.manualToday + agents.length > MANUAL_RUNS_PER_DAY) {
    return agents.length > 1 && env.manualToday < MANUAL_RUNS_PER_DAY
      ? `Needs ${agents.length} manual runs; ${MANUAL_RUNS_PER_DAY - env.manualToday} left today (${MANUAL_RUNS_PER_DAY} per project per UTC day).`
      : QUOTA_REASON;
  }
  return null;
}

function quotaLine(env: ActionEnv, n = 1): string {
  const left = env.manualToday === null ? null : Math.max(0, MANUAL_RUNS_PER_DAY - env.manualToday);
  const each = n === 1 ? "1 manual run" : `${n} manual runs`;
  return left === null
    ? `Uses ${each} of the ${MANUAL_RUNS_PER_DAY} per project per UTC day (a partial run counts as one).`
    : `Uses ${each} of the ${MANUAL_RUNS_PER_DAY} per project per UTC day (${left} left today; a partial run counts as one).`;
}

function enginesBlock(env: ActionEnv, only?: string): string | null {
  if (!env.engines) return null;
  if (only) {
    const e = env.engines.find((x) => x.provider === only);
    if (e && !e.ready) return e.detail ? `${e.name} is not set up: ${e.detail}` : `${e.name} is not set up; configure it on the Integrations page.`;
    return null;
  }
  return env.engines.some((e) => e.ready) ? null : "No AI engine is set up; add an engine key and model on the Integrations page.";
}

function readyEngineNames(env: ActionEnv, only?: string): string {
  if (only) return env.engines?.find((e) => e.provider === only)?.name ?? only;
  const ready = env.engines?.filter((e) => e.ready).map((e) => e.name) ?? [];
  return ready.length ? ready.join(", ") : "every configured engine";
}

function batchConfirm(env: ActionEnv, only?: string): ConfirmText {
  const names = readyEngineNames(env, only);
  const n = only ? 1 : (env.engines?.filter((e) => e.ready).length ?? 0);
  const prompts = env.promptCount !== null ? `${env.promptCount} prompt${env.promptCount === 1 ? "" : "s"}` : "your approved prompts (up to the per-run cap)";
  return {
    title: only ? `Ask ${names} now?` : "Ask the AI engines now?",
    lines: [
      `Partial GEO run: ask ${prompts} × ${names}${!only && n > 1 ? ` (${n} engines)` : ""}, then analyse each stored answer.`,
      "Calls the engine APIs and uses your daily GEO budget (provider calls and priced spend caps).",
      quotaLine(env),
    ],
  };
}

const first = (s: { state: string; labels: string[] } | null | undefined) => (s && s.state === "setup_required" ? (s.labels[0] ?? "Setup required.") : null);

function run(env: ActionEnv, key: string, label: string, spec: RunSpec, confirm: ConfirmText, setup: string | null): SectionAction {
  const block = runBlock(env, [spec.agent]);
  return { kind: "run", key, label, runs: [spec], confirm, disabled: block ?? setup, busyLabel: env.running[spec.agent] && !env.demo ? "Running…" : undefined };
}

function stepConfirm(env: ActionEnv, agent: AgentKind, step: SectionStep, what: string, uses: string): ConfirmText {
  return {
    title: `Run ${STEP_LABEL[step]} now?`,
    lines: [`Partial ${AGENT_NAME[agent]} run: ${STEP_LABEL[step]} only. ${what}`, uses, quotaLine(env)],
  };
}

/** SEO mode panels (testIds of the panels): 01 pages … 09 recs. */
export function seoPanelActions(env: ActionEnv): Record<string, SectionAction> {
  const recommendConfirm = stepConfirm(
    env,
    "seo",
    "recommend",
    "Judges candidates from the latest stored crawl and Search Console sync (no new crawl or sync) and drafts the selected ones.",
    "Calls Jev (TypeSafe) and the writer; uses the project's daily Jev, writer and spend caps.",
  );
  const geoBatch = run(env, "geo-batch", "Ask AI engines", { agent: "geo", steps: ["batch"] }, batchConfirm(env), enginesBlock(env));
  return {
    pages: run(
      env,
      "crawl",
      "Run crawl",
      { agent: "seo", steps: ["crawl"] },
      stepConfirm(env, "seo", "crawl", `Reads pages of ${env.verifiedHost ?? "your verified site"} through the crawler's safety checks.`, "Counts toward the project's crawl page limit."),
      env.verifiedHost ? null : "Verify site ownership first: the crawler only reads verified hosts.",
    ),
    gsc: run(
      env,
      "gsc_sync",
      "Run Search Console sync",
      { agent: "seo", steps: ["gsc_sync"] },
      stepConfirm(env, "seo", "gsc_sync", `Reads Search Console data for ${env.gscProperty ?? "the selected property"}.`, "Counts toward the project's Search Console row limit."),
      env.gscProperty ? null : "Connect Search Console and choose a property first.",
    ),
    queries: {
      kind: "call",
      key: "classify",
      label: "Classify queries",
      path: `/projects/${encodeURIComponent(env.projectId)}/seo/buyer-queries`,
      reload: "buyer",
      disabled: env.demo ? DEMO_REASON : first(env.buyer),
      confirm: {
        title: "Classify queries with Jev now?",
        lines: [
          "Asks Jev to classify Search Console queries that have no stored answer yet (stored answers are reused).",
          "Calls Jev (TypeSafe); uses the project's Jev budget and the buyer-query daily limit. Not an agent run: no manual run is used.",
        ],
      },
    },
    elements: run(env, "recommend-judge", "Run judging", { agent: "seo", steps: ["recommend"] }, recommendConfirm, null),
    competitors: { kind: "link", key: "competitors", label: "Review pages to approve", to: env.path("geo/board"), disabled: null },
    coverage: { ...geoBatch, key: "geo-batch-coverage" },
    "ai-answers": { ...geoBatch, key: "geo-batch-answers" },
    links: {
      kind: "call",
      key: "links",
      label: "Run link analysis",
      path: `/projects/${encodeURIComponent(env.projectId)}/seo/internal-links/run`,
      reload: "links",
      disabled: env.demo ? DEMO_REASON : first(env.links),
      confirm: {
        title: "Analyse internal links now?",
        lines: [
          "Re-analyses internal links from the latest stored crawl; Jev judges the suggestions when it is configured.",
          "May call Jev (TypeSafe) and uses its budget. Limited to 3 per hour per project. Not an agent run: no manual run is used.",
        ],
      },
    },
    recs: run(env, "recommend-draft", "Run drafting", { agent: "seo", steps: ["recommend"] }, recommendConfirm, null),
  };
}

/**
 * GEO mode: one action per engine column (`lane:<provider>`), 01 heatmap and 04 coverage ask every engine,
 * 05 recs drafts proposals. 02 (one stored answer) and 03 (cited instead) are views of stored answers: no button.
 */
export function geoPanelActions(env: ActionEnv, lanes: string[]): Record<string, SectionAction> {
  const all = run(env, "geo-batch", "Ask all engines", { agent: "geo", steps: ["batch"] }, batchConfirm(env), enginesBlock(env));
  const out: Record<string, SectionAction> = {
    heatmap: { ...all, key: "geo-batch-heatmap" },
    coverage: { ...all, key: "geo-batch-coverage" },
    recs: run(
      env,
      "proposals",
      "Run proposals",
      { agent: "geo", steps: ["proposals"] },
      stepConfirm(env, "geo", "proposals", "Builds proposals from the latest stored AI answers (no engine is asked).", "Calls Jev (TypeSafe) and the writer; uses the project's daily Jev, writer and spend caps."),
      null,
    ),
  };
  for (const provider of lanes) {
    const name = readyEngineNames(env, provider);
    out[`lane:${provider}`] = run(env, `lane:${provider}`, `Ask ${name}`, { agent: "geo", steps: ["batch"], engines: [provider] }, batchConfirm(env, provider), enginesBlock(env, provider));
  }
  return out;
}

/** Header "Run all" menu items. */
export function runAllActions(env: ActionEnv): SectionAction[] {
  const full = (agent: AgentKind): ConfirmText => ({
    title: `Run the ${AGENT_NAME[agent]} agent now?`,
    lines: [
      agent === "seo"
        ? "Every SEO step: crawl, Search Console sync, judge + draft."
        : `Every GEO step: ask ${env.promptCount !== null ? `${env.promptCount} prompts` : "your approved prompts"} × ${readyEngineNames(env)}, then proposals.`,
      agent === "seo" ? "Calls Jev (TypeSafe) and the writer; uses the project's daily caps." : "Calls the engine APIs, Jev and the writer; uses your daily GEO budget.",
      quotaLine(env),
    ],
  });
  const both: ConfirmText = {
    title: "Run both agents now?",
    lines: ["Starts a full SEO run and a full GEO run.", "Calls the engine APIs, Jev and the writer; uses the project's daily caps.", quotaLine(env, 2)],
  };
  return [
    { kind: "run", key: "all-seo", label: "Run SEO agent (all steps)", runs: [{ agent: "seo", steps: null }], confirm: full("seo"), disabled: runBlock(env, ["seo"]) },
    { kind: "run", key: "all-geo", label: "Run GEO agent (all steps)", runs: [{ agent: "geo", steps: null }], confirm: full("geo"), disabled: runBlock(env, ["geo"]) },
    { kind: "run", key: "all-both", label: "Run both", runs: [{ agent: "seo", steps: null }, { agent: "geo", steps: null }], confirm: both, disabled: runBlock(env, ["seo", "geo"]) },
  ];
}

/** Manual runs created on the current UTC day (the server's quota window). */
export function manualRunsToday(runs: Array<{ trigger: string; createdAt: string }> | null, now: Date = new Date()): number | null {
  if (!runs) return null;
  const day = now.toISOString().slice(0, 10);
  return runs.filter((r) => r.trigger === "manual" && r.createdAt.slice(0, 10) === day).length;
}
