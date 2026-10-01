-- Workspace-level custom OpenAI-compatible providers (owner-entered base URL + API key + model id), used as
-- the workspace's writer when selected (is_writer = 1). See docs/provider-contracts.md "Custom
-- OpenAI-compatible provider" and src/worker/platform/custom-providers.ts.
--  - base_url is the normalised https base (no credentials, no IP literal, public hostname, default port,
--    no query/fragment, no trailing slash); host is its lowercase hostname. Only the host of the provider a
--    workspace actually uses is admitted to that workspace's outbound API allowlist.
--  - key_enc is the AES-GCM envelope (src/worker/lib/crypto.ts) with AAD
--    "workspace_custom_providers:<workspace_id>:<id>"; key_hint is the last 4 characters only. Neither the
--    key nor key_enc is ever returned or exported.
--  - At most one writer per workspace (partial unique index); no row selected = the operator-configured
--    default writer. Deleting the selected row therefore reverts the workspace to the default writer.
--  - Rows go with their workspace (ON DELETE CASCADE). At most 5 rows per workspace (enforced in code).
CREATE TABLE workspace_custom_providers (
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
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_custom_providers_workspace ON workspace_custom_providers(workspace_id, created_at);
CREATE UNIQUE INDEX idx_custom_providers_one_writer ON workspace_custom_providers(workspace_id) WHERE is_writer = 1;
