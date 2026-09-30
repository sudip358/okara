/**
 * [A22] Coverage views (coverage module). docs/api.md coverage rows:
 *   GET /projects/:pid/seo/page-audit         -> CoverageResponse<PageAuditRow>
 *   GET /projects/:pid/seo/content-evidence   -> CoverageResponse<ContentEvidenceRow>
 *   GET /projects/:pid/geo/answer-coverage    -> CoverageResponse<AnswerCoverageRow>
 *   GET /projects/:pid/geo/citation-evidence  -> CoverageResponse<CitationEvidenceRow>
 * Read-only views over stored data. Every handler: requireUser + requireProject (404 across tenants);
 * every query filters by the project's workspace_id and project_id. States: 'demo' for demo projects,
 * 'setup_required' when the needed data is absent (no completed crawl / no approved prompts / no
 * API-sampled answers), otherwise 'ready'.
 */
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { requireUser } from "../platform/require-user";
import { requireProject } from "../platform/access";
import { buildPageAudit } from "../coverage/page-audit";
import { buildContentEvidence } from "../coverage/content-evidence";
import { buildAnswerCoverage } from "../coverage/answer-coverage";
import { buildCitationEvidence } from "../coverage/citation-evidence";

export const coverageRoutes = new Hono<AppEnv>();

coverageRoutes.get("/projects/:pid/seo/page-audit", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await buildPageAudit(db, project, c.get("now")) });
});

coverageRoutes.get("/projects/:pid/seo/content-evidence", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await buildContentEvidence(db, project, c.get("now")) });
});

coverageRoutes.get("/projects/:pid/geo/answer-coverage", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await buildAnswerCoverage(db, project, c.get("now")) });
});

coverageRoutes.get("/projects/:pid/geo/citation-evidence", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await buildCitationEvidence(db, project, c.get("now")) });
});
