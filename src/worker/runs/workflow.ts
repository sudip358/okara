/**
 * Cloudflare Workflow wrapper (the only file importing cloudflare:workers). All logic lives in
 * runs/orchestrate.ts so it is testable in Node. Each named step is a durable `step.do` whose result
 * is a compact record (ids and short strings only); full step summaries are persisted in D1.
 * executeStep catches step errors itself, so Workflow retries only cover infrastructure failures
 * (timeout, eviction, a D1 error before the work). A retried step whose record is already saved
 * returns that record without redoing the work (executeStep), and geo.batch skips prompt x provider
 * pairs already observed for the run, so a retry never repeats paid calls that finished.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import type { Env } from "../env";
import { executeStep, finalizeRun, prepareRun, type StepName, type StepRecord } from "./orchestrate";

export interface AgentRunParams {
  runId: string;
}

type CompactRecord = { step: string; status: string; reason: string | null; message: string };

const RETRIES: WorkflowStepConfig["retries"] = { limit: 2, delay: "10 seconds", backoff: "exponential" };

/**
 * Per-attempt timeouts, each above the step's own bounded worst case (a timed-out attempt is retried
 * from the top, so a timeout below the bound turns a slow provider into repeated full re-runs).
 * Cloudflare's rules-of-workflows asks for step timeouts of 30 minutes or less, and every value stays
 * below LOCK_TTL_SECONDS (60 min; executeStep renews the run lock at the start of every attempt).
 * - recommend: 6 writer drafts x 3 attempts x WRITER_TIMEOUT_MS (90 s) alone is ~27 min, so
 *   generate.ts starts no new Jev judgment or draft after RECOMMEND_DRAFT_DEADLINE_MS (22 min); the
 *   last draft then ends within ~27 min.
 * - proposals: one batched Jev call (3 x 12 s) plus at most DAILY_CAP (2) writer drafts x 3 x 90 s ~ 10 min.
 */
const STEP_TIMEOUT: Record<string, WorkflowStepConfig["timeout"]> = {
  validate: "1 minute",
  crawl: "10 minutes",
  gsc_sync: "10 minutes",
  recommend: "30 minutes",
  batch: "15 minutes",
  proposals: "20 minutes",
};

const config = (step: string): WorkflowStepConfig => ({ retries: RETRIES, timeout: STEP_TIMEOUT[step.split(".")[1] ?? ""] ?? "5 minutes" });

export class AgentRunWorkflow extends WorkflowEntrypoint<Env, AgentRunParams> {
  override async run(event: WorkflowEvent<AgentRunParams>, step: WorkflowStep): Promise<void> {
    const runId = event.payload.runId;
    const prepared = await step.do("prepare", config("prepare"), async () => {
      const p = await prepareRun(this.env, runId);
      return { proceed: p.proceed, steps: p.steps as string[] };
    });
    if (!prepared.proceed) return;

    const records: CompactRecord[] = [];
    try {
      for (const name of prepared.steps) {
        if (name.endsWith(".summary")) continue;
        if (records.some((r) => r.reason === "cancelled")) {
          records.push({ step: name, status: "skipped", reason: "cancelled", message: "Run cancelled; step not started." });
          continue;
        }
        if (records.some((r) => r.step.endsWith(".validate") && r.status === "failed")) {
          records.push({ step: name, status: "skipped", reason: "error", message: "Skipped: project validation failed." });
          continue;
        }
        const rec = await step.do(name, config(name), async () => {
          const r = await executeStep(this.env, runId, name as StepName);
          return { step: r.step as string, status: r.status as string, reason: r.reason, message: r.message };
        });
        records.push(rec);
      }
    } catch (e) {
      records.push({ step: "workflow", status: "failed", reason: "error", message: e instanceof Error ? e.message.slice(0, 300) : "Workflow step failed." });
    }

    await step.do("finalize", config("finalize"), async () => {
      const full = records
        .filter((r) => r.step !== "workflow")
        .map((r) => ({ ...r, summary: null }) as unknown as StepRecord);
      const failedInfra = records.find((r) => r.step === "workflow");
      if (failedInfra) {
        // The step that could not complete after retries counts as failed (partial completion kept).
        const pending = prepared.steps.find((s) => !s.endsWith(".summary") && !full.some((r) => r.step === s));
        if (pending) full.push({ step: pending as StepName, status: "failed", reason: "error", message: failedInfra.message, summary: null });
      }
      return await finalizeRun(this.env, runId, full);
    });
  }
}
