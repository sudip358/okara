/**
 * Agent-run orchestration (pure TypeScript, no Workers-only imports, so it runs under Vitest).
 *
 * Steps per agent (names are stored on run_events, prefixed by agent for the [SEO]/[GEO] run log):
 *   SEO: seo.validate -> seo.crawl -> seo.gsc_sync -> seo.recommend -> seo.summary
 *   GEO: geo.validate -> geo.batch -> geo.proposals -> geo.summary
 *
 * Semantics
 * - Each step logs started + completed/partial/failed/skipped. A failing step does not erase earlier
 *   results and does not stop later steps (partial completion); only a failed validate is fatal.
 * - Missing credentials/configuration (summary status 'setup_required' or SetupRequiredError) make a
 *   step 'skipped' with the reason. If every work step is skipped for setup, the run is setup_required.
 * - Cancellation (agent_runs.cancel_requested) is checked before every step; remaining steps are
 *   skipped and the run ends 'cancelled'. Steps may also poll ctx.isCancelled() internally.
 * - The run lock is released in `finally`, including on failure.
 *
 * The Workflow (runs/workflow.ts) calls prepareRun / executeStep / finalizeRun as separate durable
 * steps; executeRun composes the same functions inline for tests, dev, and missing bindings.
 */
import type { AgentKind, RunStatus } from "@shared/types";
import type { Env } from "../env";
import { Db, parseJson } from "../lib/db";
import { BudgetExceededError, SetupRequiredError } from "../lib/errors";
import { iso, systemClock, type Clock } from "../lib/time";
import { POLICY_VERSION } from "./policy";
import type { RunContext } from "./context";
import { acquireRunLock, releaseRunLock, renewRunLock } from "./locks";
import { buildRunContext, createRunLogger, loadRun, type RunRow } from "./runtime";
import { redact } from "./calls";
import { runCrawl, syncGsc, generateSeoRecommendations } from "../seo/entry";
import { runGeoBatch, generateGeoProposals } from "../geo/entry";

export type StepName =
  | "seo.validate"
  | "seo.crawl"
  | "seo.gsc_sync"
  | "seo.recommend"
  | "seo.summary"
  | "geo.validate"
  | "geo.batch"
  | "geo.proposals"
  | "geo.summary";

export const AGENT_STEPS: Record<AgentKind, StepName[]> = {
  seo: ["seo.validate", "seo.crawl", "seo.gsc_sync", "seo.recommend", "seo.summary"],
  geo: ["geo.validate", "geo.batch", "geo.proposals", "geo.summary"],
};

export type StepStatus = "completed" | "partial" | "failed" | "skipped";
export type StepReason = "setup_required" | "cancelled" | "budget" | "error" | "no_data" | null;

export interface StepRecord {
  step: StepName;
  status: StepStatus;
  reason: StepReason;
  message: string;
  summary: unknown;
}

type StepFn = (ctx: RunContext) => Promise<unknown>;

export interface StepFns {
  runCrawl: StepFn;
  syncGsc: StepFn;
  generateSeoRecommendations: StepFn;
  runGeoBatch: StepFn;
  generateGeoProposals: StepFn;
}

export interface OrchestrateDeps {
  buildContext?: (env: Env, runId: string) => Promise<RunContext>;
  steps?: Partial<StepFns>;
  clock?: Clock;
}

const DEFAULT_STEPS: StepFns = {
  runCrawl,
  syncGsc,
  generateSeoRecommendations,
  runGeoBatch,
  generateGeoProposals,
};

const STEP_FN: Partial<Record<StepName, keyof StepFns>> = {
  "seo.crawl": "runCrawl",
  "seo.gsc_sync": "syncGsc",
  "seo.recommend": "generateSeoRecommendations",
  "geo.batch": "runGeoBatch",
  "geo.proposals": "generateGeoProposals",
};

const TERMINAL: ReadonlySet<string> = new Set(["completed", "partial", "failed", "cancelled", "setup_required", "rate_limited"]);

export const isWorkStep = (s: StepName) => !s.endsWith(".validate") && !s.endsWith(".summary");

// ------------------------------------------------------------------ pure mapping
/** Map a step function's summary to a step status. */
export function mapStepSummary(result: unknown): { status: StepStatus; reason: StepReason; message: string } {
  const r = (result ?? {}) as { status?: unknown; note?: unknown };
  const note = typeof r.note === "string" ? r.note : "";
  switch (r.status) {
    case "setup_required":
      return { status: "skipped", reason: "setup_required", message: note || "Setup required." };
    case "failed":
      return { status: "failed", reason: "error", message: note || "Step failed." };
    case "partial":
      return { status: "partial", reason: null, message: note || "Step partially completed." };
    case "no_data":
      return { status: "completed", reason: "no_data", message: note || "No data available." };
    default:
      return { status: "completed", reason: null, message: note || "Completed." };
  }
}

export function mapStepError(e: unknown): { status: StepStatus; reason: StepReason; message: string } {
  if (e instanceof SetupRequiredError) return { status: "skipped", reason: "setup_required", message: e.message };
  if (e instanceof BudgetExceededError) return { status: "failed", reason: "budget", message: `Budget limit reached (${e.resource}): ${e.message}` };
  const msg = e instanceof Error ? redact(e.message) : "Unknown error.";
  return { status: "failed", reason: "error", message: msg.slice(0, 500) };
}

export function computeFinalStatus(records: StepRecord[], cancelled: boolean): RunStatus {
  if (cancelled) return "cancelled";
  if (records.some((r) => r.step.endsWith(".validate") && r.status === "failed")) return "failed";
  const work = records.filter((r) => isWorkStep(r.step));
  if (work.length === 0) return "failed";
  if (work.every((r) => r.status === "skipped" && r.reason === "setup_required")) return "setup_required";
  const done = work.filter((r) => r.status === "completed");
  const bad = work.filter((r) => r.status === "failed" || r.status === "partial");
  if (bad.length === 0) return "completed";
  if (done.length === 0 && bad.every((r) => r.reason === "budget")) return "rate_limited";
  if (done.length > 0 || bad.some((r) => r.status === "partial")) return "partial";
  return "failed";
}

// ------------------------------------------------------------------ persistence helpers
interface RunSummaryJson {
  steps?: Record<string, Omit<StepRecord, "step">>;
  [k: string]: unknown;
}

async function saveStepRecord(db: Db, runId: string, rec: StepRecord): Promise<void> {
  const row = await db.first<{ summary_json: string }>("SELECT summary_json FROM agent_runs WHERE id = ?", runId);
  const summary = parseJson<RunSummaryJson>(row?.summary_json, {});
  summary.steps = { ...(summary.steps ?? {}), [rec.step]: { status: rec.status, reason: rec.reason, message: rec.message, summary: rec.summary } };
  await db.run("UPDATE agent_runs SET summary_json = ? WHERE id = ?", JSON.stringify(summary), runId);
}

async function cancelRequested(db: Db, runId: string): Promise<boolean> {
  const row = await db.first<{ cancel_requested: number }>("SELECT cancel_requested FROM agent_runs WHERE id = ?", runId);
  return (row?.cancel_requested ?? 0) === 1;
}

function logger(db: Db, run: RunRow, clock: Clock) {
  return createRunLogger(db, { id: run.id, workspaceId: run.workspace_id, projectId: run.project_id }, clock);
}

// ------------------------------------------------------------------ phases
export interface PreparedRun {
  proceed: boolean;
  agent: AgentKind;
  steps: StepName[];
  reason: string | null;
}

export async function prepareRun(env: Env, runId: string, deps: OrchestrateDeps = {}): Promise<PreparedRun> {
  const db = new Db(env.DB);
  const clock = deps.clock ?? systemClock;
  const run = await loadRun(db, runId);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const steps = AGENT_STEPS[run.agent];
  if (TERMINAL.has(run.status)) return { proceed: false, agent: run.agent, steps, reason: `Run already ${run.status}.` };
  const log = logger(db, run, clock);
  if (run.cancel_requested === 1) {
    await finalizeRun(env, runId, [], deps, true);
    return { proceed: false, agent: run.agent, steps, reason: "Cancelled before start." };
  }
  const locked = await acquireRunLock(db, run.project_id, run.agent, run.id, clock());
  if (!locked) {
    const now = iso(clock());
    await db.run(
      "UPDATE agent_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('pending', 'running')",
      "Another run for this project and agent is active.",
      now,
      run.id,
    );
    await log.event(`${run.agent}.run`, "failed", "Another run for this project and agent is active; this run did not start.");
    return { proceed: false, agent: run.agent, steps, reason: "Locked by another run." };
  }
  await db.run(
    "UPDATE agent_runs SET status = 'running', started_at = COALESCE(started_at, ?), policy_version = COALESCE(policy_version, ?) WHERE id = ?",
    iso(clock()),
    POLICY_VERSION,
    run.id,
  );
  await log.event(`${run.agent}.run`, "started", `${run.agent.toUpperCase()} run started (${run.trigger}).`);
  return { proceed: true, agent: run.agent, steps, reason: null };
}

async function runValidate(db: Db, run: RunRow): Promise<{ status: StepStatus; reason: StepReason; message: string; summary: unknown }> {
  const project = await db.first<{ id: string; verified_host: string | null; gsc_property: string | null; is_demo: number }>(
    "SELECT id, verified_host, gsc_property, is_demo FROM projects WHERE id = ? AND workspace_id = ?",
    run.project_id,
    run.workspace_id,
  );
  if (!project) return { status: "failed", reason: "error", message: "Project not found or no longer accessible.", summary: null };
  const notes: string[] = [];
  if (run.agent === "seo") {
    notes.push(project.verified_host ? `Verified host: ${project.verified_host}.` : "Site ownership not verified: crawling will be skipped.");
    notes.push(project.gsc_property ? `Search Console property: ${project.gsc_property}.` : "No Search Console property selected.");
  }
  return { status: "completed", reason: null, message: `Project validated. ${notes.join(" ")}`.trim(), summary: { verifiedHost: project.verified_host, gscProperty: project.gsc_property } };
}

export async function executeStep(env: Env, runId: string, step: StepName, deps: OrchestrateDeps = {}): Promise<StepRecord> {
  const db = new Db(env.DB);
  const clock = deps.clock ?? systemClock;
  const run = await loadRun(db, runId);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const log = logger(db, run, clock);

  if (await cancelRequested(db, runId)) {
    const rec: StepRecord = { step, status: "skipped", reason: "cancelled", message: "Run cancelled; step not started.", summary: null };
    await log.event(step, "skipped", rec.message);
    await saveStepRecord(db, runId, rec);
    return rec;
  }
  await renewRunLock(db, run.project_id, run.agent, run.id, clock());
  await log.event(step, "started", `Step ${step} started.`);

  let rec: StepRecord;
  if (step.endsWith(".validate")) {
    rec = { step, ...(await runValidate(db, run)) };
  } else {
    const fnName = STEP_FN[step];
    if (!fnName) throw new Error(`Unknown step ${step}.`);
    const fn = deps.steps?.[fnName] ?? DEFAULT_STEPS[fnName];
    try {
      const ctx = await (deps.buildContext ?? ((e, id) => buildRunContext(e, id, { clock })))(env, runId);
      const summary = await fn(ctx);
      rec = { step, ...mapStepSummary(summary), summary: summary ?? null };
    } catch (e) {
      rec = { step, ...mapStepError(e), summary: null };
    }
  }
  const eventStatus = rec.status === "skipped" ? "skipped" : rec.status;
  const prefix = rec.reason === "setup_required" ? "Skipped (setup required): " : "";
  await log.event(step, eventStatus, `${prefix}${rec.message}`);
  await saveStepRecord(db, runId, rec);
  return rec;
}

export async function finalizeRun(env: Env, runId: string, records: StepRecord[], deps: OrchestrateDeps = {}, forceCancelled = false): Promise<RunStatus> {
  const db = new Db(env.DB);
  const clock = deps.clock ?? systemClock;
  const run = await loadRun(db, runId);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const log = logger(db, run, clock);
  try {
    const cancelled = forceCancelled || records.some((r) => r.reason === "cancelled") || (await cancelRequested(db, runId));
    const status = computeFinalStatus(records, cancelled);
    const summary = parseJson<RunSummaryJson>(run.summary_json, {});
    const counts = { completed: 0, partial: 0, failed: 0, skipped: 0 };
    for (const r of records) counts[r.status]++;
    summary.final = { status, counts };
    const firstFailure = records.find((r) => r.status === "failed");
    const error = status === "failed" || status === "partial" || status === "rate_limited" ? firstFailure?.message ?? null : null;
    await db.run(
      "UPDATE agent_runs SET status = ?, error = ?, summary_json = ?, finished_at = ? WHERE id = ?",
      status,
      error,
      JSON.stringify(summary),
      iso(clock()),
      runId,
    );
    const summaryStep = `${run.agent}.summary`;
    const evStatus = status === "completed" ? "completed" : status === "partial" ? "partial" : status === "cancelled" || status === "setup_required" ? "skipped" : "failed";
    await log.event(
      summaryStep,
      evStatus,
      `Run ${status}: ${counts.completed} completed, ${counts.partial} partial, ${counts.failed} failed, ${counts.skipped} skipped.`,
    );
    return status;
  } finally {
    await releaseRunLock(db, run.project_id, run.agent, run.id);
  }
}

/** Run every step inline (tests, dev, and when the Workflow binding is missing). */
export async function executeRun(env: Env, runId: string, deps: OrchestrateDeps = {}): Promise<RunStatus | null> {
  const db = new Db(env.DB);
  let prepared: PreparedRun;
  try {
    prepared = await prepareRun(env, runId, deps);
  } catch (e) {
    const run = await loadRun(db, runId);
    if (run) await releaseRunLock(db, run.project_id, run.agent, run.id);
    throw e;
  }
  if (!prepared.proceed) return null;
  const records: StepRecord[] = [];
  let current: StepName | null = null;
  try {
    for (const step of prepared.steps) {
      current = step;
      if (step.endsWith(".summary")) continue;
      const cancelledAlready = records.some((r) => r.reason === "cancelled");
      const fatal = records.some((r) => r.step.endsWith(".validate") && r.status === "failed");
      if (cancelledAlready || fatal) {
        const rec: StepRecord = {
          step,
          status: "skipped",
          reason: cancelledAlready ? "cancelled" : "error",
          message: cancelledAlready ? "Run cancelled; step not started." : "Skipped: project validation failed.",
          summary: null,
        };
        records.push(rec);
        await logger(db, (await loadRun(db, runId))!, deps.clock ?? systemClock).event(step, "skipped", rec.message);
        continue;
      }
      records.push(await executeStep(env, runId, step, deps));
    }
  } catch (e) {
    // Infrastructure failure between steps: keep what completed, record the failure, finalize below.
    const mapped = mapStepError(e);
    if (current && !records.some((r) => r.step === current)) records.push({ step: current, ...mapped, status: "failed", summary: null });
    const run = await loadRun(db, runId);
    if (run) await logger(db, run, deps.clock ?? systemClock).event(current ?? `${run.agent}.run`, "failed", mapped.message);
  }
  // finalizeRun releases the lock in its own finally.
  return finalizeRun(env, runId, records, deps);
}
