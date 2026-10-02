/** Worker entry: API (fetch), cron dispatcher (scheduled), and the agent-run Workflow class. */
import type { Env } from "./env";
import { createApp } from "./app";
import { dispatchDueRuns, sweepOrphans } from "./runs/scheduler";
import { processQueuedCompetitorFetches } from "./competitors/dataforseo";
import { processDueImportSyncs } from "./imports/sync";

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
    // DataForSEO competitor refreshes left queued (or stuck running) by a request's waitUntil.
    ctx.waitUntil(
      processQueuedCompetitorFetches(env, now).catch((e) => {
        console.error("competitor data queue failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
      }),
    );
    // Sheet-linked imports kept in sync (Import page "Keep in sync"): due tabs are re-read with the stored token.
    ctx.waitUntil(
      processDueImportSyncs(env, now).catch((e) => {
        console.error("import sync tick failed", e instanceof Error ? e.message.slice(0, 200) : "unknown");
      }),
    );
  },
} satisfies ExportedHandler<Env>;
