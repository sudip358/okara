/**
 * Run activity window (docs/api.md "Run activity"). Read-only views over a run's stored rows:
 *   GET /projects/:pid/runs/:runId/activity?after=<cursor>&limit=<n>   RunActivity
 *   GET /projects/:pid/activity/current                                 { runs: [{id, agent, status}] }
 * Access resolves through requireProject (membership); the run must belong to that project and
 * workspace, otherwise 404. No provider call, no Jev, no budget.
 */
import { Hono } from "hono";
import type { CurrentActivityResponse, GeoEngineProviderId } from "@shared/types";
import type { AppEnv } from "../app";
import { notFound } from "../lib/errors";
import { requireProject } from "../platform/access";
import { requireUser } from "../platform/require-user";
import { buildRunActivity, currentActivityRuns, decodeCursor, parseLimit } from "../runs/activity";
import { capabilityPresence } from "../runs/runtime";
import { GEO_ENGINE_IDS } from "../geo/engines";

export const activityRoutes = new Hono<AppEnv>();

activityRoutes.get("/projects/:pid/runs/:runId/activity", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const after = decodeCursor(c.req.query("after"));
  const limit = parseLimit(c.req.query("limit"));
  const runId = c.req.param("runId");

  // Configured engines (presence only) shape the lanes of an active GEO run; demo projects use fixtures only.
  let configuredEngines: GeoEngineProviderId[] = [];
  if (project.is_demo !== 1) {
    const run = await db.first<{ agent: string; status: string }>(
      "SELECT agent, status FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND id = ?",
      project.workspace_id,
      project.id,
      runId,
    );
    if (!run) throw notFound("Run");
    if (run.agent === "geo" && (run.status === "pending" || run.status === "running")) {
      const presence = await capabilityPresence(c.env, db, project.workspace_id);
      configuredEngines = GEO_ENGINE_IDS.filter((p) => presence[p]);
    }
  }

  const activity = await buildRunActivity(db, project, runId, { after, limit, now: c.get("now"), configuredEngines });
  if (!activity) throw notFound("Run");
  return c.json({ data: activity });
});

activityRoutes.get("/projects/:pid/activity/current", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const body: CurrentActivityResponse = { runs: await currentActivityRuns(db, project.workspace_id, project.id) };
  return c.json({ data: body });
});
