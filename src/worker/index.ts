/** Worker entry: API (fetch), cron dispatcher (scheduled), and the agent-run Workflow class. */
import type { Env } from "./env";
import { createApp } from "./app";
import { dispatchDueRuns } from "./runs/scheduler";

export { AgentRunWorkflow } from "./runs/workflow";

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dispatchDueRuns(env, new Date()));
  },
} satisfies ExportedHandler<Env>;
