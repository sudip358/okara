-- Widen provider_credentials.provider to the two GEO engine lanes (src/worker/geo/engines.ts
-- GEO_ENGINE_IDS): 'openai_geo' (OpenAI Responses API + web_search) and 'anthropic_geo' (Claude
-- Messages API + web_search). SQLite cannot alter a CHECK constraint, so the table is rebuilt the
-- D1-safe way: defer FK checks for this transaction, create the new table, copy every row, drop the old
-- one, rename. Columns, constraints and FKs are exactly those of 0001_init.sql; only the CHECK list
-- changes. No other table references provider_credentials, and 0001 declared no secondary index on it
-- (the UNIQUE (workspace_id, provider) autoindex is recreated with the table).
PRAGMA defer_foreign_keys = true;

CREATE TABLE provider_credentials_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('typesafe', 'gemini', 'perplexity', 'writer', 'openai_geo', 'anthropic_geo')),
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
