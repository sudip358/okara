/**
 * Tenancy enforcement. Every project/workspace-scoped route resolves access through these helpers.
 * IDs from the browser are only lookup keys; membership is always checked server-side.
 */
import type { Db } from "../lib/db";
import { forbidden, notFound } from "../lib/errors";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  site_url: string;
  site_type: string;
  brand_name: string;
  brand_aliases_json: string;
  competitors_json: string;
  product_description: string;
  audience: string;
  locale: string;
  language: string;
  voice: string;
  verified_host: string | null;
  verification_method: string | null;
  verification_token: string | null;
  verified_at: string | null;
  gsc_property: string | null;
  schedule_enabled: number;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export async function requireWorkspaceMember(db: Db, userId: string, workspaceId: string): Promise<{ role: "owner" | "member" }> {
  const m = await db.first<{ role: "owner" | "member" }>(
    "SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?",
    workspaceId,
    userId,
  );
  // 404 rather than 403 so workspace existence is not disclosed.
  if (!m) throw notFound("Workspace");
  return m;
}

export async function requireWorkspaceOwner(db: Db, userId: string, workspaceId: string): Promise<void> {
  const { role } = await requireWorkspaceMember(db, userId, workspaceId);
  if (role !== "owner") throw forbidden("Only the workspace owner can do this.");
}

/** Load a project only if the user is a member of its workspace. */
export async function requireProject(db: Db, userId: string, projectId: string): Promise<ProjectRow> {
  const row = await db.first<ProjectRow>(
    `SELECT p.* FROM projects p
       JOIN memberships m ON m.workspace_id = p.workspace_id AND m.user_id = ?
      WHERE p.id = ?`,
    userId,
    projectId,
  );
  if (!row) throw notFound("Project");
  return row;
}
