/**
 * Hono API app. All routes live under /api. Route modules are owned per area (see TASKS.md) and
 * receive a typed context with `db`, `user`, and `session`. Tenancy: use platform/access.ts helpers.
 */
import { Hono } from "hono";
import type { Env } from "./env";
import { Db } from "./lib/db";
import { HttpError } from "./lib/errors";
import type { SessionUser } from "./platform/access";
import type { SessionRecord } from "./platform/session";
import { loadSession, securityHeaders, csrfProtection } from "./platform/security";

import { authRoutes } from "./routes/auth";
import { credentialRoutes } from "./routes/credentials";
import { projectRoutes } from "./routes/projects";
import { integrationRoutes } from "./routes/integrations";
import { seoRoutes } from "./routes/seo";
import { geoRoutes } from "./routes/geo";
import { geoBoardRoutes } from "./routes/geo-board";
import { checklistRoutes } from "./routes/checklists";
import { robotsRoutes } from "./routes/robots";
import { coverageRoutes } from "./routes/coverage";
import { redirectRoutes } from "./routes/redirects";
import { draftCheckRoutes } from "./routes/draft-check";
import { linkRoutes } from "./routes/links";
import { recommendationRoutes } from "./routes/recommendations";
import { runRoutes } from "./routes/runs";
import { demoRoutes } from "./routes/demo";

export interface AppVariables {
  db: Db;
  now: Date;
  user: SessionUser | null;
  session: SessionRecord | null;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };

export function createApp() {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", new Date());
    c.set("user", null);
    c.set("session", null);
    await next();
  });
  app.use("*", securityHeaders());
  app.use("*", loadSession());
  app.use("*", csrfProtection());

  app.get("/health", (c) => c.json({ data: { ok: true } }));

  app.route("/", authRoutes);
  app.route("/", credentialRoutes);
  app.route("/", projectRoutes);
  app.route("/", integrationRoutes);
  app.route("/", seoRoutes);
  app.route("/", geoRoutes);
  app.route("/", geoBoardRoutes);
  app.route("/", checklistRoutes);
  app.route("/", robotsRoutes);
  app.route("/", coverageRoutes);
  app.route("/", redirectRoutes);
  app.route("/", draftCheckRoutes);
  app.route("/", linkRoutes);
  app.route("/", recommendationRoutes);
  app.route("/", runRoutes);
  app.route("/", demoRoutes);

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    }
    // Never leak internals or secrets.
    console.error("unhandled", err instanceof Error ? err.message : "unknown");
    return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
  });

  return app;
}

/** Re-exported for existing imports; new code should import from platform/require-user. */
export { requireUser } from "./platform/require-user";
