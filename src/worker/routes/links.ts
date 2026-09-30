/**
 * Internal link suggester [A25]. OWNED BY: internal-links module.
 *   POST  /projects/:pid/seo/internal-links/run          -> LinkSuggestionReport (user-triggered run on the latest crawl)
 *   GET   /projects/:pid/seo/internal-links              -> latest LinkSuggestionReport
 *   PATCH /projects/:pid/seo/internal-links/:id          body {userStatus} -> LinkSuggestion
 *   GET   /projects/:pid/seo/internal-links/export?format=csv|json -> download of the latest suggestions
 *
 * - Tenancy: requireUser + requireProject (404 for non-members); every query filters by workspace_id.
 * - Run: setup_required (unverified host or no crawl) returns the report without using the rate limit;
 *   otherwise LINK_RUN_RATE_LIMIT per project, then the run. Jev is used when TypeSafe is configured
 *   for the workspace (calls recorded in provider_calls and reserved against the project's daily
 *   provider_calls/jev_calls budget); demo projects never call Jev.
 * - Okara never edits pages: everything returned is a suggestion for the user to apply.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { badRequest } from "../lib/errors";
import { requireProject } from "../platform/access";
import { hitRateLimit } from "../platform/rate-limit";
import { requireUser } from "../platform/require-user";
import type { DecisionProvider } from "../providers/types";
import { buildDecisionsForWorkspace } from "../redirects/decisions";
import { emptyReport, exportLinks, getLinkReport, linkSetup, updateLinkUserStatus, USER_STATUSES } from "../links/report";
import { runLinkSuggestions } from "../links/run";

export const linkRoutes = new Hono<AppEnv>();

export const LINK_RUN_RATE_LIMIT = { limit: 3, windowSeconds: 60 * 60 } as const;

type DecisionsFactory = (env: Env, db: Db, workspaceId: string, projectId: string) => Promise<DecisionProvider | null>;
const defaultFactory: DecisionsFactory = (env, db, workspaceId, projectId) => buildDecisionsForWorkspace(env, db, workspaceId, projectId);
let decisionsFactory: DecisionsFactory = defaultFactory;

/** Test hook: inject the DecisionProvider factory. Pass null to restore the real one. */
export function setLinkDecisionsFactory(f: DecisionsFactory | null): void {
  decisionsFactory = f ?? defaultFactory;
}

const patchSchema = z.object({ userStatus: z.enum(["open", "accepted", "dismissed", "implemented"]) }).strict();

linkRoutes.post("/projects/:pid/seo/internal-links/run", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const now = c.get("now");

  const setup = await linkSetup(db, project);
  if (setup.state === "setup_required") {
    return c.json({ data: emptyReport("setup_required", now, [setup.message ?? "Setup required."], project.is_demo === 1) });
  }

  const rl = await hitRateLimit(db, `internal_links_run:${project.id}`, LINK_RUN_RATE_LIMIT.limit, LINK_RUN_RATE_LIMIT.windowSeconds, now);
  if (!rl.allowed) {
    return c.json(
      { error: { code: "rate_limited", message: `Internal-link runs are limited to ${LINK_RUN_RATE_LIMIT.limit} per hour per project. Try again later.` } },
      429,
      { "Retry-After": String(rl.retryAfterSeconds) },
    );
  }

  const decisions = project.is_demo === 1 ? null : await decisionsFactory(c.env, db, project.workspace_id, project.id);
  const data = await runLinkSuggestions(c.env, db, project, now, { decisions, userId: user.id });
  return c.json({ data });
});

linkRoutes.get("/projects/:pid/seo/internal-links", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await getLinkReport(db, project) });
});

linkRoutes.get("/projects/:pid/seo/internal-links/export", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const format = c.req.query("format") ?? "csv";
  if (format !== "csv" && format !== "json") throw badRequest("format must be csv or json.");
  const out = await exportLinks(db, project, format, c.get("now"));
  return c.body(out.body, 200, {
    "Content-Type": out.contentType,
    "Content-Disposition": `attachment; filename="${out.filename}"`,
    "Cache-Control": "no-store",
  });
});

linkRoutes.patch("/projects/:pid/seo/internal-links/:id", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) throw badRequest(`userStatus must be one of: ${USER_STATUSES.join(", ")}.`);
  const data = await updateLinkUserStatus(db, project, c.req.param("id"), parsed.data.userStatus, c.get("now"));
  return c.json({ data });
});
