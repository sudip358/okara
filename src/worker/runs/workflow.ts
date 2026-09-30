/** Cloudflare Workflow wrapper. OWNED BY: runtime module. Keep logic in runs/orchestrate.ts (testable). */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";

export interface AgentRunParams {
  runId: string;
}

export class AgentRunWorkflow extends WorkflowEntrypoint<Env, AgentRunParams> {
  override async run(_event: WorkflowEvent<AgentRunParams>, _step: WorkflowStep): Promise<void> {}
}
