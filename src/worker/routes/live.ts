/**
 * Live view feeds (docs/api.md "Live view"). Read-only, run-scoped views over stored rows:
 *   GET /projects/:pid/live/seo?runId=&after=&limit=   LiveSeoBoardResponse
 *   GET /projects/:pid/live/geo?runId=&after=&limit=   LiveGeoBoardResponse
 * Access resolves through requireProject (membership); the run must belong to that project and workspace,
 * otherwise 404 (never 403). 400 when runId is missing, the cursor is malformed (or from another feed), the
 * limit is invalid, or the run's agent is not the route's agent (details.reason "agent_mismatch").
 * No provider call, no Jev, no budget.
 */
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { badRequest, notFound } from "../lib/errors";
import { requireProject } from "../platform/access";
import { requireUser } from "../platform/require-user";
import { parseLiveLimit } from "../live/cursor";
import { buildLiveSeo, decodeLiveSeoCursor } from "../live/seo-board";
import { buildLiveGeo, decodeLiveGeoCursor } from "../live/geo-board";

export const liveRoutes = new Hono<AppEnv>();

function requireRunId(raw: string | undefined): string {
  const runId = (raw ?? "").trim();
  if (!runId) throw badRequest("runId is required.", { field: "runId" });
  if (runId.length > 100) throw badRequest("runId is invalid.", { field: "runId" });
  return runId;
}

liveRoutes.get("/projects/:pid/live/seo", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const runId = requireRunId(c.req.query("runId"));
  const after = decodeLiveSeoCursor(c.req.query("after"));
  const limit = parseLiveLimit(c.req.query("limit"));
  const data = await buildLiveSeo(db, project, runId, { after, limit, now: c.get("now") });
  if (!data) throw notFound("Run");
  return c.json({ data });
});

liveRoutes.get("/projects/:pid/live/geo", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const runId = requireRunId(c.req.query("runId"));
  const after = decodeLiveGeoCursor(c.req.query("after"));
  const limit = parseLiveLimit(c.req.query("limit"));
  const data = await buildLiveGeo(db, project, runId, { after, limit, now: c.get("now") });
  if (!data) throw notFound("Run");
  return c.json({ data });
});
