/**
 * SEO overview + GSC CSV import (seo-analysis module).
 *   GET  /projects/:pid/seo/overview    -> SeoOverview
 *   POST /projects/:pid/seo/import-csv  -> body {csv, window:'current'|'previous', start, end}; labelled csv_import
 *                                          201 {data:{syncId, rows, window}}; 400 with the expected headers on bad input
 * CSRF/origin checks for the POST are enforced by the app-wide middleware.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { requireUser } from "../platform/require-user";
import { badRequest, HttpError } from "../lib/errors";
import { requireProject } from "../platform/access";
import { CSV_MAX_BYTES, importGscCsv } from "../seo/gsc/csv";
import { buildSeoOverview } from "../seo/gsc/overview";

export const seoOverviewRoutes = new Hono<AppEnv>();

seoOverviewRoutes.get("/projects/:pid/seo/overview", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const overview = await buildSeoOverview(db, project);
  return c.json({ data: overview });
});

const importBody = z.object({
  csv: z.string().min(1).max(CSV_MAX_BYTES),
  window: z.enum(["current", "previous"]),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** JSON envelope allowance on top of the 2 MB CSV (escaping can grow it). */
const MAX_BODY_BYTES = CSV_MAX_BYTES * 2 + 4096;

seoOverviewRoutes.post("/projects/:pid/seo/import-csv", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Upload is larger than 2 MB.");
  let raw: unknown;
  try {
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Upload is larger than 2 MB.");
    raw = JSON.parse(text);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest("Body must be JSON.");
  }
  const parsed = importBody.safeParse(raw);
  if (!parsed.success) throw badRequest("Invalid import request.", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const result = await importGscCsv(
    db,
    { workspaceId: project.workspace_id, projectId: project.id, userId: user.id, property: project.gsc_property, now: c.get("now") },
    parsed.data,
  );
  return c.json({ data: { syncId: result.syncId, rows: result.rows, window: result.window } }, 201);
});
