/**
 * Project export: every project-scoped table as JSON, filtered by workspace_id AND project_id.
 * Secrets are never exported: no oauth_connections.refresh_token_enc, no provider_credentials, no OAuth
 * states, no project verification token. `_json` columns are decoded for readability.
 */
import type { Db, Row } from "../lib/db";
import { iso } from "../lib/time";

export const EXPORT_FORMAT = "okara-project-export";
export const EXPORT_VERSION = 1;

/** Tables exported with `SELECT *` (all carry workspace_id and project_id). Order is parent-first. */
export const EXPORT_TABLES = [
  "project_limits",
  "context_documents",
  "crawl_runs",
  "pages",
  "page_snapshots",
  "audit_findings",
  "gsc_syncs",
  "gsc_metrics",
  "gsc_daily",
  "agent_runs",
  "run_events",
  "evidence",
  "decision_records",
  "recommendations",
  "recommendation_events",
  "judgment_feedback",
  "geo_prompt_sets",
  "geo_prompts",
  "geo_observations",
  "geo_brand_observations",
  "geo_citations",
  "geo_search_queries",
  "geo_displacements",
  "provider_calls",
  "usage_reservations",
] as const;

/** Column names that must never appear in an export, whichever table they are in. */
export const SECRET_COLUMNS = new Set(["refresh_token_enc", "key_enc", "code_verifier", "verification_token", "csrf_token"]);

function decode(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (SECRET_COLUMNS.has(k)) continue;
    if (k.endsWith("_json") && typeof v === "string") {
      try {
        out[k.slice(0, -5)] = JSON.parse(v);
        continue;
      } catch {
        /* keep raw */
      }
    }
    out[k] = v;
  }
  return out;
}

export async function exportProject(db: Db, workspaceId: string, projectId: string, now: Date) {
  const project = await db.first("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", workspaceId, projectId);
  const tables: Record<string, Row[]> = {};
  for (const t of EXPORT_TABLES) {
    const rows = await db.all(`SELECT * FROM ${t} WHERE workspace_id = ? AND project_id = ?`, workspaceId, projectId);
    tables[t] = rows.map(decode);
  }
  // Integration metadata only; the encrypted token column is not selected.
  const integrations = await db.all(
    `SELECT id, provider, scopes, status, last_error, created_at, updated_at
       FROM oauth_connections WHERE workspace_id = ? AND project_id = ?`,
    workspaceId,
    projectId,
  );
  tables.oauth_connections = integrations;
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: iso(now),
    notes: [
      "Secrets are excluded: OAuth refresh tokens, provider API keys, and verification tokens are never exported.",
      "Raw answers and page evidence are untrusted third-party text.",
    ],
    project: project ? decode(project) : null,
    tables,
  };
}
