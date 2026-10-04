/**
 * Project export: every project-scoped table as JSON, filtered by workspace_id AND project_id.
 * Secrets are never exported: no oauth_connections.refresh_token_enc, no provider_credentials, no OAuth
 * states, no project verification token, no custom provider key (key_enc) or key hint. `_json` columns are
 * decoded for readability. The workspace's custom providers (base URL, model, writer selection) are
 * included as workspace-level integration metadata, selected column by column, as is the workspace's model
 * selection for the built-in providers (workspace_provider_models: provider and model id only) and the
 * custom provider change log (workspace_custom_provider_changes: hosts, fields, user id; no key material).
 */
import type { Db, Row } from "../lib/db";
import { iso } from "../lib/time";
import { isMissingChatColumnError, isMissingRoleColumnError, isMissingTableError } from "./custom-providers";

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
  "checklist_manual",
  "link_runs",
  "link_suggestions",
  "competitor_pages",
  // DataForSEO competitor data (migration 0014): settings, refresh log, parsed third-party estimates.
  "competitor_data_settings",
  "competitor_fetches",
  "competitor_snapshots",
  // Import (Google Sheets / CSV), migration 0015: history, sheet reference records, provenance, sync settings.
  "imports",
  "import_records",
  "import_changes",
  "import_syncs",
  // Internal links workbench, migration 0017: rolling-crawl inventory and cursor, the stored link graph, cluster
  // overrides, and link verifications.
  "crawl_inventory",
  "crawl_inventory_state",
  "link_graphs",
  "link_graph_urls",
  "link_cluster_overrides",
  "link_verifications",
  // Backlink monitor, migration 0020: monitored backlinks (sheet values + latest check), check jobs, checks, changes.
  // backlink_job_cache is transient (robots verdicts / pacing of a running job) and is not exported.
  "backlinks",
  "backlink_jobs",
  "backlink_checks",
  "backlink_events",
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
  // Workspace-level custom providers: configuration only; key_enc and key_hint are never selected.
  // role (0011) says whether a row is a writer or a custom GEO engine.
  // is_chat (0019, [A36]) marks Ask Okara's selected chat model (role 'chat').
  const customCols = (withRole: boolean, withChat: boolean) =>
    `SELECT id, ${withRole ? "role" : "'writer' AS role"}, label, base_url, host, model, is_writer, ${withChat ? "is_chat" : "0 AS is_chat"}, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at
       FROM workspace_custom_providers WHERE workspace_id = ? ORDER BY created_at, id`;
  try {
    try {
      tables.workspace_custom_providers = await db.all(customCols(true, true), workspaceId);
    } catch (e) {
      if (isMissingChatColumnError(e)) {
        try {
          tables.workspace_custom_providers = await db.all(customCols(true, false), workspaceId);
        } catch (e2) {
          if (!isMissingRoleColumnError(e2)) throw e2;
          tables.workspace_custom_providers = await db.all(customCols(false, false), workspaceId);
        }
      } else {
        if (!isMissingRoleColumnError(e)) throw e;
        tables.workspace_custom_providers = await db.all(customCols(false, false), workspaceId);
      }
    }
  } catch (e) {
    if (!isMissingTableError(e)) throw e;
    tables.workspace_custom_providers = [];
  }
  // Custom provider change log (0012): when a base URL / model / label / key changed, by which user id, and
  // whether a saved key was kept for a new host. Configuration only; it never holds key material.
  try {
    tables.workspace_custom_provider_changes = await db.all(
      `SELECT provider_id, changed_at, changed_by, fields, old_base_url, new_base_url, old_host, new_host, key_kept_for_new_host
         FROM workspace_custom_provider_changes WHERE workspace_id = ? ORDER BY changed_at, id`,
      workspaceId,
    );
  } catch (e) {
    if (!isMissingTableError(e)) throw e;
    tables.workspace_custom_provider_changes = [];
  }
  // Workspace model selection (0011): provider and model id only.
  try {
    tables.workspace_provider_models = await db.all(
      "SELECT provider, model, updated_at FROM workspace_provider_models WHERE workspace_id = ? ORDER BY provider",
      workspaceId,
    );
  } catch (e) {
    if (!isMissingTableError(e)) throw e;
    tables.workspace_provider_models = [];
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: iso(now),
    notes: [
      "Secrets are excluded: OAuth refresh tokens, provider API keys (including custom provider keys), and verification tokens are never exported.",
      "Raw answers and page evidence are untrusted third-party text.",
    ],
    project: project ? decode(project) : null,
    tables,
  };
}
