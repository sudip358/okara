/**
 * Cloudflare Workflow wrapper (the only file importing cloudflare:workers). All logic lives in
 * runs/orchestrate.ts so it is testable in Node. Each named step is a durable `step.do` whose result
 * is a compact record (ids and short strings only); full step summaries are persisted in D1.
 * executeStep catches step errors itself, so Workflow retries only cover infrastructure failures.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import type { Env } from "../env";
import { executeStep, finalizeRun, prepareRun, type StepName, type StepRecord } from "./orchestrate";

export interface AgentRunParams {
  runId: string;
}

type CompactRecord = { step: string; status: string; reason: string | null; message: string };

const RETRIES: WorkflowStepConfig["retries"] = { limit: 2, delay: "10 seconds", backoff: "exponential" };

const STEP_TIMEOUT: Record<string, WorkflowStepConfig["timeout"]> = {
  validate: "1 minute",
  crawl: "10 minutes",
  gsc_sync: "10 minutes",
  recommend: "10 minutes",
  batch: "15 minutes",
  proposals: "10 minutes",
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
