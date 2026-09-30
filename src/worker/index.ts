/** Worker entry: API (fetch), cron dispatcher (scheduled), and the agent-run Workflow class. */
import type { Env } from "./env";
import { createApp } from "./app";
import { dispatchDueRuns, sweepOrphans } from "./runs/scheduler";

export { AgentRunWorkflow } from "./runs/workflow";

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = new Date();
    ctx.waitUntil(
      (async () => {
        // Cleanup first (frees stranded budget before new runs reserve), but never blocks dispatch.
        try {
          await sweepOrphans(env, now);
        } catch (e) {
          console.error("orphan sweep failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
        }
        await dispatchDueRuns(env, now);
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
