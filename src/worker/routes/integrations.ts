/**
 * Integrations status and Google Search Console connection (platform-projects module).
 * The GSC callback is a top-level GET navigation from Google; it is bound to the initiating session.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { IntegrationsStatus } from "@shared/types";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { HttpError, badRequest, unauthorized } from "../lib/errors";
import { iso } from "../lib/time";
import type { ProjectRow, SessionUser } from "../platform/access";
import { requireProject } from "../platform/access";
import { createGscProvider, GscApiError } from "../platform/gsc-client";
import { disconnectGsc, gscOAuthConfigured, handleGscCallback, integrationsPath, loadGscConnection, startGscConnect } from "../platform/gsc-oauth";
import { outbound, parseBody, siteHost } from "../platform/projects";
import { gscEntryVerifiesHost, markVerified, verificationStatus } from "../platform/verification";
import { listProviderStatuses } from "./credentials";

export const integrationRoutes = new Hono<AppEnv>();

const userOf = (c: { get(key: "user"): SessionUser | null }): SessionUser => {
  const u = c.get("user");
  if (!u) throw unauthorized();
  return u;
};

async function gscStatus(env: Env, db: Db, p: ProjectRow): Promise<IntegrationsStatus["gsc"]> {
  if (p.is_demo === 1) return { state: "demo", property: p.gsc_property, connectedAt: null, lastError: null };
  const conn = await loadGscConnection(db, p.workspace_id, p.id);
  if (!conn || conn.status === "revoked") {
    return { state: gscOAuthConfigured(env) ? "setup_required" : "disabled", property: p.gsc_property, connectedAt: null, lastError: null };
  }
  return {
    state: conn.status === "connected" ? "ready" : "error",
    property: p.gsc_property,
    connectedAt: conn.created_at,
    lastError: conn.last_error,
  };
}

integrationRoutes.get("/projects/:pid/integrations", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const p = await requireProject(db, user.id, c.req.param("pid"));
  const data: IntegrationsStatus = { gsc: await gscStatus(c.env, db, p), providers: await listProviderStatuses(c.env, db, p.workspace_id) };
  return c.json({ data });
});

// ------------------------------------------------------------------ GSC OAuth

integrationRoutes.get("/projects/:pid/gsc/connect", async (c) => {
  const user = userOf(c);
  const session = c.get("session");
  if (!session) throw unauthorized();
  const db = c.get("db");
  const p = await requireProject(db, user.id, c.req.param("pid"));
  if (p.is_demo === 1) return c.redirect(`${integrationsPath(p.id)}?gscError=demo_project`, 302);
  if (!gscOAuthConfigured(c.env)) return c.redirect(`${integrationsPath(p.id)}?gscError=setup_required`, 302);
  const url = await startGscConnect(c.env, db, { user, sessionId: session.id, workspaceId: p.workspace_id, projectId: p.id, now: c.get("now") });
  c.header("Cache-Control", "no-store");
  return c.redirect(url, 302);
});

integrationRoutes.get("/gsc/callback", async (c) => {
  const result = await handleGscCallback(c.env, c.get("db"), {
    query: new URL(c.req.url).searchParams,
    user: c.get("user"),
    sessionId: c.get("session")?.id ?? null,
    now: c.get("now"),
    fetchImpl: outbound.fetch,
  });
  c.header("Cache-Control", "no-store");
  return c.redirect(result.redirectTo, 302);
});

integrationRoutes.get("/projects/:pid/gsc/properties", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const p = await requireProject(db, user.id, c.req.param("pid"));
  const gsc = await createGscProvider(c.env, db, { id: p.id, workspaceId: p.workspace_id }, outbound.fetch);
  if (!gsc) throw new HttpError(412, "setup_required", "Connect Google Search Console first.");
  try {
    return c.json({ data: await gsc.listProperties() });
  } catch (e) {
    throw gscHttpError(e);
  }
});

function gscHttpError(e: unknown): HttpError {
  if (e instanceof GscApiError) {
    if (e.code === "invalid_grant") return new HttpError(412, "setup_required", e.message);
    if (e.status === 429) return new HttpError(429, "rate_limited", "Search Console quota exceeded. Try again later.");
    return new HttpError(502, "gsc_error", e.message);
  }
  return new HttpError(502, "gsc_error", "Search Console request failed.");
}

const propertySchema = z
  .object({
    property: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((v) => v.startsWith("sc-domain:") || v.startsWith("https://") || v.startsWith("http://"), "Property must be a URL-prefix or sc-domain: property."),
  })
  .strict();

integrationRoutes.put("/projects/:pid/gsc/property", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const p = await requireProject(db, user.id, c.req.param("pid"));
  const { property } = await parseBody(c, propertySchema);
  const gsc = await createGscProvider(c.env, db, { id: p.id, workspaceId: p.workspace_id }, outbound.fetch);
  if (!gsc) throw new HttpError(412, "setup_required", "Connect Google Search Console first.");
  let props: Array<{ siteUrl: string; permissionLevel: string }>;
  try {
    props = await gsc.listProperties();
  } catch (e) {
    throw gscHttpError(e);
  }
  // Only a property the connected account can actually see may be selected.
  const entry = props.find((e) => e.siteUrl === property);
  if (!entry) throw badRequest("That property is not available to the connected Google account.");
  const now = c.get("now");
  await db.run("UPDATE projects SET gsc_property = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", property, iso(now), p.workspace_id, p.id);
  const check = gscEntryVerifiesHost(entry, siteHost(p.site_url));
  const updated = (await db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", p.workspace_id, p.id))!;
  if (check.ok) await markVerified(db, updated, "gsc", now);
  const fresh = (await db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", p.workspace_id, p.id))!;
  return c.json({ data: { property, verification: { ...verificationStatus(fresh), check: { method: "gsc", ok: check.ok, detail: check.detail } } } });
});

integrationRoutes.delete("/projects/:pid/gsc", async (c) => {
  const user = userOf(c);
  const db = c.get("db");
  const p = await requireProject(db, user.id, c.req.param("pid"));
  const { revoked } = await disconnectGsc(c.env, db, p.workspace_id, p.id, outbound.fetch, c.get("now"));
  return c.json({ data: { ok: true, revoked } });
});
