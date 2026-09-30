/**
 * [A21] Readiness checklists (checklists module).
 *   GET /projects/:pid/checklists/:kind                    -> Checklist (kind seo | geo)
 *   PUT /projects/:pid/checklists/:kind/:itemId            -> ChecklistItem  body {checked, note?}  (manual items only)
 *   GET /projects/:pid/pages/:pageId/checklist             -> Checklist (kind page)
 *   PUT /projects/:pid/pages/:pageId/checklist/:itemId     -> ChecklistItem  body {checked, note?}  (manual items only)
 * Tenancy: requireProject() resolves the project through the user's membership; every query in the
 * checklist service filters by that project's workspace_id and project_id.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { requireUser } from "../platform/require-user";
import { requireProject } from "../platform/access";
import { parseBody } from "../platform/projects";
import { badRequest } from "../lib/errors";
import { getPageChecklist, getProjectChecklist, putPageManual, putProjectManual, type ProjectChecklistKind } from "../checklists/service";

export const checklistRoutes = new Hono<AppEnv>();

const kindSchema = z.enum(["seo", "geo"]);
const itemIdSchema = z.string().min(3).max(120).regex(/^[a-z_]+(\.[a-z0-9_]+)+$/);
export const manualBodySchema = z
  .object({
    checked: z.boolean(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();

function parseKind(raw: string): ProjectChecklistKind {
  const k = kindSchema.safeParse(raw);
  if (!k.success) throw badRequest("Checklist kind must be 'seo' or 'geo'.");
  return k.data;
}

function parseItemId(raw: string): string {
  const r = itemIdSchema.safeParse(raw);
  if (!r.success) throw badRequest("Invalid checklist item id.");
  return r.data;
}

checklistRoutes.get("/projects/:pid/checklists/:kind", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const kind = parseKind(c.req.param("kind"));
  const data = await getProjectChecklist(c.env, db, project, kind, c.get("now"));
  return c.json({ data });
});

checklistRoutes.put("/projects/:pid/checklists/:kind/:itemId", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const kind = parseKind(c.req.param("kind"));
  const itemId = parseItemId(c.req.param("itemId"));
  const body = await parseBody(c, manualBodySchema);
  const data = await putProjectManual(c.env, db, project, kind, itemId, body, user.id, c.get("now"));
  return c.json({ data });
});

checklistRoutes.get("/projects/:pid/pages/:pageId/checklist", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const data = await getPageChecklist(c.env, db, project, c.req.param("pageId"), c.get("now"));
  return c.json({ data });
});

checklistRoutes.put("/projects/:pid/pages/:pageId/checklist/:itemId", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const itemId = parseItemId(c.req.param("itemId"));
  const body = await parseBody(c, manualBodySchema);
  const data = await putPageManual(c.env, db, project, c.req.param("pageId"), itemId, body, user.id, c.get("now"));
  return c.json({ data });
});
