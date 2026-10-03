-- Maton.ai API gateway as a transport for Google Sheets and Search Console (owner request 2026-10-03: "configure
-- maton.ai tool to put key via api"). See docs/provider-contracts.md "Maton.ai API gateway", docs/api.md
-- "Maton.ai", src/worker/platform/maton.ts (the only module that calls Maton; strict egress policy).
--
-- 1. provider_credentials.provider gains 'maton' (the workspace's Maton API key, AES-GCM encrypted; key_hint = last
--    4 characters). SQLite cannot alter a CHECK constraint, so the table is rebuilt exactly like 0008/0014 did: defer
--    FK checks for this transaction, create the new table, copy every row, drop the old one, rename. Columns,
--    constraints and FKs are those of 0014; only the CHECK list changes. No other table references
--    provider_credentials and it has no secondary index (the UNIQUE autoindex is recreated with the table).
PRAGMA defer_foreign_keys = true;

CREATE TABLE provider_credentials_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('typesafe', 'gemini', 'perplexity', 'writer', 'openai_geo', 'anthropic_geo', 'dataforseo', 'maton')),
  key_enc TEXT NOT NULL,
  key_hint TEXT NOT NULL,             -- last 4 chars only
  last_tested_at TEXT,
  last_test_ok INTEGER,
  last_test_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, provider)
);

INSERT INTO provider_credentials_new
  (id, workspace_id, provider, key_enc, key_hint, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at)
SELECT id, workspace_id, provider, key_enc, key_hint, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at
  FROM provider_credentials;

DROP TABLE provider_credentials;

ALTER TABLE provider_credentials_new RENAME TO provider_credentials;

-- 2. The workspace's ACTIVE Maton connections for the apps Okara knows about, as listed by the last key test
--    (GET https://ctrl.maton.ai/connections?status=ACTIVE). Only documented fields are kept: connection_id, app,
--    status, creation_time. The connection's `url` (it carries a connect session token) and `metadata` are never
--    stored. selected = 1 marks the connection the owner picked for that app (sent as the Maton-Connection header);
--    no selected row = Maton's default (oldest active) connection. Rows are replaced on every test; a selection
--    survives as long as its connection is still listed. Deleted with the key.
CREATE TABLE maton_connections (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app TEXT NOT NULL CHECK (app IN ('google-sheets', 'google-search-console', 'google-analytics-data')),
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL,
  creation_time TEXT,
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  listed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, app, connection_id)
);

-- 3. Project setting "Search Console source": NULL or 'direct' = the project's own Google OAuth connection (default,
--    unchanged); 'maton' = read Search Console through the workspace's Maton google-search-console connection. The
--    direct connection always wins when it is connected. gsc_property stays the selected property for both.
ALTER TABLE projects ADD COLUMN gsc_source TEXT;

-- 4. Which transport read the sheet: 'direct' (the project's Google Sheets OAuth token) or 'maton'. NULL for CSV
--    imports and rows written before this migration.
ALTER TABLE imports ADD COLUMN transport TEXT;
ALTER TABLE import_syncs ADD COLUMN last_transport TEXT;
