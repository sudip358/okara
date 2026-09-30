/**
 * Demo seed route. Exists only when DEMO_MODE === 'true' AND ENVIRONMENT !== 'production'; otherwise 404,
 * indistinguishable from an unknown route. The seeded project is is_demo=1 and every screen labels it.
 */
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { demoModeEnabled } from "../env";
import { unauthorized } from "../lib/errors";
import { seedDemoProject } from "../demo/seed";

export const demoRoutes = new Hono<AppEnv>();

demoRoutes.post("/demo/seed", async (c) => {
  if (!demoModeEnabled(c.env) || c.env.ENVIRONMENT === "production") {
    return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
  }
  const user = c.get("user");
  if (!user) throw unauthorized();
  const row = await seedDemoProject(c.env, c.get("db"), user.id, c.get("now"));
  return c.json({ data: { projectId: row.id } }, 201);
});
