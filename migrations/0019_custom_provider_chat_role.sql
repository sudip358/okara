-- Ask Okara's own chat model (owner request 2026-10-04: "add separate system to add model for agent chatbot"; build
-- kit [A36]). See docs/api.md "Custom providers" / "Ask Okara chat model", src/worker/chat/model.ts and
-- src/worker/platform/custom-providers.ts.
--
-- workspace_custom_providers.role gains 'chat': a custom OpenAI-compatible provider (base URL + key + model) used
-- ONLY by Ask Okara (function tools over /chat/completions). New column is_chat: 1 marks the workspace's selected
-- chat model (at most one per workspace, partial unique index, like is_writer). No selected chat row = Ask Okara
-- uses the workspace writer exactly as before (chat model source "writer", the default). A 'chat' row is never the
-- writer (is_writer stays 0) and a 'writer'/'geo' row is never the chat model (is_chat stays 0); enforced in code.
-- At most 3 'chat' rows per workspace (enforced in code).
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt the way 0008/0014/0018 rebuilt
-- provider_credentials: defer FK checks for this transaction, create the new table, copy every row, drop the old
-- one, rename, recreate the indexes. Columns, types, defaults, constraints and the FK are those of 0010 + 0011 (in
-- the same order: 0011's `role` was appended last); only the role CHECK list changes and is_chat is appended. No
-- other table references workspace_custom_providers (the 0012 change log has no FK to it on purpose). Every existing
-- row keeps its id, role, key envelope (AAD binds workspace and row id, both unchanged) and test results; is_chat = 0.
PRAGMA defer_foreign_keys = true;

CREATE TABLE workspace_custom_providers_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  host TEXT NOT NULL,
  model TEXT NOT NULL,
  key_enc TEXT NOT NULL,
  key_hint TEXT NOT NULL,             -- last 4 chars only
  is_writer INTEGER NOT NULL DEFAULT 0 CHECK (is_writer IN (0, 1)),
  last_tested_at TEXT,
  last_test_ok INTEGER,
  last_test_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'writer' CHECK (role IN ('writer', 'geo', 'chat')),
  is_chat INTEGER NOT NULL DEFAULT 0 CHECK (is_chat IN (0, 1))
);

INSERT INTO workspace_custom_providers_new
  (id, workspace_id, label, base_url, host, model, key_enc, key_hint, is_writer, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at, role, is_chat)
SELECT id, workspace_id, label, base_url, host, model, key_enc, key_hint, is_writer, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at, role, 0
  FROM workspace_custom_providers;

DROP TABLE workspace_custom_providers;

ALTER TABLE workspace_custom_providers_new RENAME TO workspace_custom_providers;

CREATE INDEX idx_custom_providers_workspace ON workspace_custom_providers(workspace_id, created_at);
CREATE UNIQUE INDEX idx_custom_providers_one_writer ON workspace_custom_providers(workspace_id) WHERE is_writer = 1;
CREATE INDEX idx_custom_providers_role ON workspace_custom_providers(workspace_id, role, created_at);
CREATE UNIQUE INDEX idx_custom_providers_one_chat ON workspace_custom_providers(workspace_id) WHERE is_chat = 1;
