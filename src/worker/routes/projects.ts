/**
 * Projects, context documents, verification, limits, export, delete (platform-projects module).
 * Every handler resolves access with requireWorkspaceMember()/requireProject(); IDs from the browser
 * are lookup keys only.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { unauthorized } from "../lib/errors";
import { utcDay } from "../lib/time";
import type { SessionUser } from "../platform/access";
import { requireProject, requireWorkspaceMember } from "../platform/access";
import { exportProject } from "../platform/export";
import { deleteGscToken } from "../platform/gsc-oauth";
import { clientKey, rateLimit } from "../platform/rate-limit";
import {
  contextKindSchema,
  contextPutSchema,
  createProject,
  deleteProjectData,
  getLimits,
  limitsPutSchema,
  listLatestContext,
  listProjects,
  outbound,
  parseBody,
  projectInputSchema,
  projectPatchSchema,
  putContextDoc,
  putLimits,
  toProject,
  updateProject,
} from "../platform/projects";
import { ensureVerificationToken, runVerificationCheck, verificationStatus } from "../platform/verification";

export const projectRoutes = new Hono<AppEnv>();

const userOf = (c: { get(key: "user"): SessionUser | null }): SessionUser => {
  const u = c.get("user");
  if (!u) throw unauthorized();
  return u;
};

// ------------------------------------------------------------------ CRUD

projectRoutes.get("/workspaces/:wid/projects", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const wid = c.req.param("wid");
  await requireWorkspaceMember(db, user.id, wid);
  return c.json({ data: await listProjects(db, wid) });
});

projectRoutes.post("/workspaces/:wid/projects", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const wid = c.req.param("wid");
  await requireWorkspaceMember(db, user.id, wid);
  const input = await parseBody(c, projectInputSchema);
  const row = await createProject(db, wid, user.id, input, c.get("now"));
  return c.json({ data: toProject(row) }, 201);
});

projectRoutes.get("/projects/:pid", async (c) => {
  const user = userOf(c);
  const row = await requireProject(c.get("db"), user.id, c.req.param("pid"));
  return c.json({ data: toProject(row) });
});

projectRoutes.patch("/projects/:pid", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid"));
  const patch = await parseBody(c, projectPatchSchema);
  const updated = await updateProject(db, row, patch, c.get("now"));
  return c.json({ data: toProject(updated) });
});

projectRoutes.delete("/projects/:pid", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid"));
  // H5: only the locally stored GSC token is deleted. Google's /revoke would end the grant for every
  // project connected with that Google account, so it is never called; users revoke at
  // myaccount.google.com. gscRevoked stays in the response (always false) for API compatibility.
  await deleteGscToken(db, row.workspace_id, row.id);
  await deleteProjectData(db, row.workspace_id, row.id);
  return c.json({ data: { ok: true, gscRevoked: false } });
});

projectRoutes.get("/projects/:pid/export", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid"));
  const now = c.get("now");
  const body = await exportProject(db, row.workspace_id, row.id, now);
  c.header("Content-Disposition", `attachment; filename="okara-project-${row.id}-${utcDay(now)}.json"`);
  c.header("Cache-Control", "no-store");
  return c.json({ data: body });
});

// ------------------------------------------------------------------ context documents

projectRoutes.get("/projects/:pid/context", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await listLatestContext(db, row.workspace_id, row.id) });
});

projectRoutes.put("/projects/:pid/context/:kind", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid"));
  const kind = contextKindSchema.safeParse(c.req.param("kind"));
  if (!kind.success) return c.json({ error: { code: "bad_request", message: "Unknown context document kind." } }, 400);
  const body = await parseBody(c, contextPutSchema);
  return c.json({ data: await putContextDoc(db, row, kind.data, body, user.id, c.get("now")) });
});

// ------------------------------------------------------------------ verification

projectRoutes.get("/projects/:pid/verification", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const row = await ensureVerificationToken(db, await requireProject(db, user.id, c.req.param("pid")));
  return c.json({ data: verificationStatus(row) });
});

const verificationCheckSchema = z.object({ method: z.enum(["dns", "file", "gsc"]) }).strict();

/** Each check sends outbound GETs / DoH lookups at the project's host: bounded per user and project. */
export const VERIFICATION_CHECK_RATE_LIMIT = { limit: 10, windowSeconds: 60 } as const;

projectRoutes.post(
  "/projects/:pid/verification/check",
  // Authenticate before the limiter so unauthenticated requests write no rate_limits rows.
  async (c, next) => {
    userOf(c);
    await next();
  },
  rateLimit({ key: (c) => `verify_check:${c.req.param("pid") ?? ""}:${clientKey(c)}`, ...VERIFICATION_CHECK_RATE_LIMIT }),
  async (c) => {
    const user = userOf(c);
    const db = c.get("db");
    const row = await requireProject(db, user.id, c.req.param("pid"));
    const { method } = await parseBody(c, verificationCheckSchema);
    const { status, check } = await runVerificationCheck(c.env, db, row, method, outbound.fetch, c.get("now"));
    // `check` is additive to VerificationStatus: it explains why a check did not verify.
    return c.json({ data: { ...status, check: { method, ok: check.ok, detail: check.detail } } });
  },
);

// ------------------------------------------------------------------ limits

projectRoutes.get("/projects/:pid/limits", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await getLimits(db, row.workspace_id, row.id, c.get("now")) });
});

projectRoutes.put("/projects/:pid/limits", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid"));
  const patch = await parseBody(c, limitsPutSchema);
  return c.json({ data: await putLimits(db, row.workspace_id, row.id, patch, c.get("now")) });
});
