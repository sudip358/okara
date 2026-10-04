/**
 * GEO routes (geo-analysis module). docs/api.md geo rows. Every handler: requireUser + requireProject
 * (or observation -> project membership), zod-validated bodies, workspace-scoped queries.
 *
 * Pinned response shapes (UI contract):
 *   GET  /projects/:pid/geo/prompts            -> GeoPromptSet | null
 *   PUT  /projects/:pid/geo/prompts            -> GeoPromptSet (new version); brand-blind 400 details
 *                                                 { violations: [{ index, text, matched: string[] }] }
 *   POST /projects/:pid/geo/prompts/generate   -> { suggestions: [{ text, stage, rationale }], dropped, writer }
 *   GET  /projects/:pid/geo/prompts/from-gsc   -> GscQuestionsResponse (?includeBrand=1) [A37]; read-only, no provider call
 *   POST /projects/:pid/geo/prompts/from-gsc   -> GscQuestionsAddResult { set, added, skipped } [A37]; unapproved prompts
 *   GET  /projects/:pid/geo/results            -> GeoResults
 *   GET  /geo/observations/:id                 -> GeoObservationDetail
 *   GET  /projects/:pid/geo/displacements      -> DisplacementSummary[]   (?measurement=api|manual_import)
 *   GET  /projects/:pid/geo/search-queries     -> SearchQuerySummary[]
 *   POST /projects/:pid/geo/import             -> 201 { observationId }
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { requireUser } from "../platform/require-user";
import { badRequest, BudgetExceededError, HttpError, setupRequired } from "../lib/errors";
import { requireProject } from "../platform/access";
import { buildWriterForWorkspace, writerStatusForWorkspace } from "../runs/runtime";
import { writerConfigStatus } from "../providers/writer";
import { contentPillars, generatePromptSuggestions, getActivePromptSet, MAX_PROMPT_LENGTH, MAX_PROMPTS_PER_SET, savePromptSet } from "../geo/prompts";
import { buildDisplacementSummary, buildGeoResults, buildObservationDetail, buildSearchQuerySummary } from "../geo/results";
import { importManualObservation, manualImportSchema } from "../geo/manual-import";
import { addGscQuestionPrompts, buildGscQuestions, GSC_QUESTION_MAX_ADD } from "../geo/gsc-questions";

export const geoRoutes = new Hono<AppEnv>();

const promptPutSchema = z.object({
  prompts: z
    .array(
      z.object({
        text: z.string().trim().min(3).max(MAX_PROMPT_LENGTH),
        promptType: z.enum(["discovery", "reputation"]),
        stage: z.string().trim().max(80).nullish().transform((v) => v || null),
        approved: z.boolean(),
      }),
    )
    .max(MAX_PROMPTS_PER_SET),
});

async function body<T extends z.ZodType>(c: { req: { json(): Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw badRequest("Invalid request body.", { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  return parsed.data;
}

geoRoutes.get("/projects/:pid/geo/prompts", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await getActivePromptSet(db, project.workspace_id, project.id) });
});

geoRoutes.put("/projects/:pid/geo/prompts", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const input = await body(c, promptPutSchema);
  return c.json({ data: await savePromptSet(db, project, input.prompts, c.get("now")) });
});

const fromGscSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(MAX_PROMPT_LENGTH)).min(1).max(GSC_QUESTION_MAX_ADD),
  setId: z.string().max(80).nullish(),
  includeBrand: z.boolean().optional(),
});

/** [A37] Question-style queries from the stored Search Console sync (deterministic, free). Any project member. */
geoRoutes.get("/projects/:pid/geo/prompts/from-gsc", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const ib = c.req.query("includeBrand");
  if (ib !== undefined && ib !== "0" && ib !== "1" && ib !== "true" && ib !== "false") throw badRequest("includeBrand must be 0 or 1.");
  return c.json({ data: await buildGscQuestions(db, project, { includeBrand: ib === "1" || ib === "true" }) });
});

/** [A37] Add selected question queries as UNAPPROVED prompts (same permissions and checks as PUT /geo/prompts). */
geoRoutes.post("/projects/:pid/geo/prompts/from-gsc", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const input = await body(c, fromGscSchema);
  return c.json({ data: await addGscQuestionPrompts(db, project, { queries: input.queries, setId: input.setId, includeBrand: input.includeBrand }, c.get("now")) }, 201);
});

geoRoutes.post("/projects/:pid/geo/prompts/generate", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const status = writerConfigStatus(c.env);
  const workspaceWriter = await writerStatusForWorkspace(c.env, db, project.workspace_id);
  const custom = workspaceWriter.source === "custom" ? workspaceWriter.custom : null;
  const writer = custom || status.configured ? await buildWriterForWorkspace(c.env, db, project.workspace_id, { projectId: project.id }) : null;
  if (!writer) {
    throw setupRequired(
      custom
        ? `The custom writer (${custom.host}) cannot be used; re-enter its base URL and API key on the integrations page.`
        : status.configured
          ? "Add a writing-provider API key to generate prompt suggestions."
          : `Writing provider not configured (missing: ${status.missing.join(", ")}).`,
    );
  }
  try {
    const result = await generatePromptSuggestions(writer, project, await contentPillars(db, project.workspace_id, project.id));
    return c.json({
      data: {
        suggestions: result.suggestions.map((s) => ({ text: s.text, stage: s.stage, rationale: s.rationale })),
        dropped: result.dropped,
        writer: result.writer,
      },
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof BudgetExceededError) throw new HttpError(429, "budget_exceeded", "Daily usage limit reached for this project; try again tomorrow.");
    throw new HttpError(502, "writer_failed", "The writing provider did not return suggestions. Nothing was saved.");
  }
});

geoRoutes.get("/projects/:pid/geo/results", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await buildGeoResults(c.env, db, project) });
});

geoRoutes.get("/geo/observations/:id", async (c) => {
  const user = requireUser(c);
  return c.json({ data: await buildObservationDetail(c.get("db"), user.id, c.req.param("id")) });
});

geoRoutes.get("/projects/:pid/geo/displacements", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const m = c.req.query("measurement");
  if (m !== undefined && m !== "api" && m !== "manual_import") throw badRequest("measurement must be 'api' or 'manual_import'.");
  return c.json({ data: await buildDisplacementSummary(db, project, m ?? "api") });
});

geoRoutes.get("/projects/:pid/geo/search-queries", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await buildSearchQuerySummary(db, project) });
});

geoRoutes.post("/projects/:pid/geo/import", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const input = await body(c, manualImportSchema);
  const invalid = input.citations
    .map((x) => (typeof x === "string" ? x : x.url))
    .filter((u) => {
      try {
        const p = new URL(u.trim());
        return !(p.protocol === "https:" || p.protocol === "http:") || !!p.username || !!p.password;
      } catch {
        return true;
      }
    });
  if (invalid.length > 0) throw badRequest("Citations must be http(s) URLs without credentials.", { invalid: invalid.slice(0, 10) });
  const result = await importManualObservation(c.env, db, project, user.id, input, c.get("now"));
  return c.json({ data: { observationId: result.observationId } }, 201);
});
