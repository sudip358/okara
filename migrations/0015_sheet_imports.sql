-- Import from Google Sheets / CSV, with optional live sync of sheet-linked imports (owner requests 2026-10-02:
-- "Build an import feature" for the master campaign sheet; "we keep on updating the competitor list").
-- See docs/api.md "Import (Google Sheets / CSV)", docs/provider-contracts.md "Google Sheets API",
-- src/worker/imports/*.
--
-- SQLite cannot alter CHECK constraints, so three tables are rebuilt the D1-safe way used by 0008/0014:
-- defer FK checks for this transaction, create the new table, copy every row, drop the old one, rename.
-- No other table references any of them (evidence.ref_id points at context_documents by value, not by FK).
PRAGMA defer_foreign_keys = true;

-- 1. oauth_states.purpose gains 'sheets' (the separate "Connect Google Sheets" consent). Same columns as 0001.
CREATE TABLE oauth_states_new (
  state TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'gsc', 'sheets')),
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  session_id TEXT,
  user_id TEXT,
  workspace_id TEXT,
  project_id TEXT,
  return_to TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
INSERT INTO oauth_states_new (state, purpose, nonce, code_verifier, session_id, user_id, workspace_id, project_id, return_to, created_at, expires_at)
SELECT state, purpose, nonce, code_verifier, session_id, user_id, workspace_id, project_id, return_to, created_at, expires_at FROM oauth_states;
DROP TABLE oauth_states;
ALTER TABLE oauth_states_new RENAME TO oauth_states;

-- 2. oauth_connections.provider gains 'google_sheets': a separate token row per project holding only the
--    spreadsheets.readonly scope (never merged with the Search Console token). Same columns as 0001.
CREATE TABLE oauth_connections_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google_gsc', 'google_sheets')),
  scopes TEXT NOT NULL,
  refresh_token_enc TEXT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, provider)
);
INSERT INTO oauth_connections_new (id, workspace_id, project_id, user_id, provider, scopes, refresh_token_enc, status, last_error, created_at, updated_at)
SELECT id, workspace_id, project_id, user_id, provider, scopes, refresh_token_enc, status, last_error, created_at, updated_at FROM oauth_connections;
DROP TABLE oauth_connections;
ALTER TABLE oauth_connections_new RENAME TO oauth_connections;

-- 3. context_documents gains kind 'imported' ("Imported research": compact, size-capped plain-text tables from a
--    sheet tab or CSV, labelled with source, tab and import date). Several imported documents can exist per
--    project, so documents are now identified by (kind, doc_key): doc_key is '' for the five built-in kinds
--    (unchanged behaviour) and e.g. 'sheet:<spreadsheetId>:<sheetId>' or 'csv:<name>' for imported ones.
--    title: display name for imported documents (NULL for built-in kinds). import_id: the import that wrote this
--    version (NULL for user edits); undo deletes only the version its import created.
CREATE TABLE context_documents_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('product', 'positioning', 'competitors', 'voice', 'pillars', 'imported')),
  doc_key TEXT NOT NULL DEFAULT '',
  title TEXT,
  import_id TEXT,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, kind, doc_key, version)
);
INSERT INTO context_documents_new (id, workspace_id, project_id, kind, doc_key, title, import_id, version, content, facts_json, created_by, created_at)
SELECT id, workspace_id, project_id, kind, '', NULL, NULL, version, content, facts_json, created_by, created_at FROM context_documents;
DROP TABLE context_documents;
ALTER TABLE context_documents_new RENAME TO context_documents;
CREATE INDEX idx_ctx_project ON context_documents(workspace_id, project_id, kind, doc_key);

-- 4. Prompt sets can carry a label (e.g. "Imported from sheet 2026-10-02"). NULL for sets saved on the GEO page.
ALTER TABLE geo_prompt_sets ADD COLUMN label TEXT;

-- 5. One row per import (manual or sync). counts_json: {added, updated, unchanged, skipped, removed, notAdded};
--    changes_json: human-readable change lines ("+ lumens.com", "- 1800lighting.com") capped; mapping_json /
--    options_json: what was applied (column names only, no cell data). status 'undone' after undo.
CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('csv', 'sheets')),
  source_name TEXT NOT NULL,          -- file name or spreadsheet title (plain text, capped)
  spreadsheet_id TEXT,
  tab TEXT,
  sheet_tab_id INTEGER,               -- Sheets sheetId (gid) of the tab
  destination TEXT NOT NULL CHECK (destination IN ('geo_prompts', 'competitors', 'implemented_links', 'context_doc', 'reference')),
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'sync')),
  sync_id TEXT,
  mapping_json TEXT NOT NULL DEFAULT '{}',
  options_json TEXT NOT NULL DEFAULT '{}',
  counts_json TEXT NOT NULL DEFAULT '{}',
  changes_json TEXT NOT NULL DEFAULT '[]',
  rows_read INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('completed', 'undone')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  undone_at TEXT,
  undone_by TEXT
);
CREATE INDEX idx_imports_project ON imports(workspace_id, project_id, created_at);
CREATE INDEX idx_imports_sync ON imports(sync_id, created_at);

-- 6. What the sheet says, per destination, keyed by a normalized key (prompt text, domain, source|target|anchor,
--    or document key), so a re-import or sync is idempotent and removals can be detected. data_json holds the
--    imported reference values ("from your sheet, not measured by Okara"), capped. status per destination:
--      geo_prompts:        in_set | set_full | archived
--      competitors:        tracked | not_tracked_limit | removed_from_sheet
--      implemented_links:  placed | removed_from_sheet
--      context_doc:        current
--    first_import_id created the record (undo deletes records it created); removed_at is set when a sync no
--    longer finds the key in the sheet (history is never deleted silently).
CREATE TABLE import_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  record_key TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  source_key TEXT NOT NULL,           -- 'sheet:<spreadsheetId>:<sheetId>' or 'csv:<name>' (which sheet tab owns it)
  first_import_id TEXT NOT NULL,
  last_import_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (project_id, destination, record_key)
);
CREATE INDEX idx_import_records_dest ON import_records(workspace_id, project_id, destination, status);
CREATE INDEX idx_import_records_first ON import_records(first_import_id);

-- 7. Per-import changes (provenance for undo): action added | updated | removed, with the previous state of the
--    record (prev_json) so undo can restore it.
CREATE TABLE import_changes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  record_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added', 'updated', 'removed')),
  prev_json TEXT,
  ref_id TEXT,                        -- e.g. the context_documents version id written
  created_at TEXT NOT NULL
);
CREATE INDEX idx_import_changes_import ON import_changes(import_id);

-- 8. Sheet-linked imports kept in sync by the cron (every 15 min tick; due when next_run_at <= now). frequency_hours
--    is 6, 12 or 24 (never more often than every 6 h). last_error_code: token_expired | not_connected | tab_missing |
--    header_changed | forbidden | not_found | api_error | apply_error. A failing sync stays enabled and is shown on
--    the Import page and the Overview "needs attention" feed until it succeeds or is stopped.
CREATE TABLE import_syncs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spreadsheet_id TEXT NOT NULL,
  spreadsheet_title TEXT NOT NULL,
  tab TEXT NOT NULL,
  sheet_tab_id INTEGER,
  destination TEXT NOT NULL CHECK (destination IN ('geo_prompts', 'competitors', 'implemented_links')),
  mapping_json TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  frequency_hours INTEGER NOT NULL DEFAULT 24 CHECK (frequency_hours IN (6, 12, 24)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at TEXT NOT NULL,
  running_until TEXT,
  last_run_at TEXT,
  last_status TEXT NOT NULL DEFAULT 'never' CHECK (last_status IN ('never', 'ok', 'error')),
  last_error_code TEXT,
  last_error TEXT,
  last_warning TEXT,
  last_import_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, spreadsheet_id, tab, destination)
);
CREATE INDEX idx_import_syncs_due ON import_syncs(enabled, next_run_at);
CREATE INDEX idx_import_syncs_project ON import_syncs(workspace_id, project_id);
