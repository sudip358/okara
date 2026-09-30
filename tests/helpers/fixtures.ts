/** Seed helpers: users, workspaces, memberships, projects, sessions. */
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { createSession } from "@worker/platform/session";
import type { Env } from "@worker/env";

export const FIXED_NOW = new Date("2026-09-30T12:00:00.000Z");

export async function seedUser(env: Env, opts: { email?: string; workspaceName?: string } = {}) {
  const db = new Db(env.DB);
  const userId = newId("usr");
  const workspaceId = newId("ws");
  const now = FIXED_NOW.toISOString();
  await db.insert("users", { id: userId, google_sub: `sub-${userId}`, email: opts.email ?? `${userId}@example.com`, name: "Test User", created_at: now });
  await db.insert("workspaces", { id: workspaceId, name: opts.workspaceName ?? "Test workspace", created_at: now });
  await db.insert("memberships", { workspace_id: workspaceId, user_id: userId, role: "owner", created_at: now });
  const session = await createSession(db, userId, new Date());
  return { db, userId, workspaceId, sessionToken: session.token, csrfToken: session.csrfToken, sessionId: session.id };
}

export async function seedProject(env: Env, workspaceId: string, overrides: Record<string, unknown> = {}) {
  const db = new Db(env.DB);
  const id = newId("prj");
  const now = FIXED_NOW.toISOString();
  await db.insert("projects", {
    id,
    workspace_id: workspaceId,
    name: "Residence Example",
    site_url: "https://shop.example.com",
    site_type: "ecommerce",
    brand_name: "Residence Example",
    brand_aliases_json: JSON.stringify(["ResEx"]),
    competitors_json: JSON.stringify([{ name: "Brass Co", domains: ["brassco.example"], aliases: [] }]),
    product_description: "Solid brass cabinet hardware and lighting.",
    audience: "Homeowners and interior designers",
    locale: "en-US",
    language: "en",
    voice: "",
    verified_host: "shop.example.com",
    verification_method: "gsc",
    verified_at: now,
    gsc_property: "sc-domain:example.com",
    schedule_enabled: 1,
    is_demo: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
  await db.insert("project_limits", { project_id: id, workspace_id: workspaceId, updated_at: now });
  return id;
}

/** Request helper headers for an authenticated, CSRF-valid request. Cookie name: dev variant in tests. */
export function authHeaders(sessionToken: string, csrfToken: string, origin = "http://localhost:5173"): Record<string, string> {
  return {
    Cookie: `okara_session=${sessionToken}`,
    "X-CSRF-Token": csrfToken,
    Origin: origin,
    "Content-Type": "application/json",
  };
}
