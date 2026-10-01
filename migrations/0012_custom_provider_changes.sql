-- Audit log of custom provider configuration changes (PATCH /workspaces/:wid/custom-providers/:id), so the
-- owner can see when a base URL (host), model, label or key changed and who changed it. Added 2026-10-01
-- (owner request: "the custom base URL keeps on changing", e.g. *.trycloudflare.com / *.ngrok-free.app /
-- *.loca.lt tunnels). See docs/api.md "Custom providers" and src/worker/routes/custom-providers.ts.
--  - fields: comma-separated subset of label,base_url,model,api_key (what the PATCH changed).
--  - old_/new_base_url and old_/new_host: set only when the base URL changed (configuration, not secrets).
--  - key_kept_for_new_host: 1 when the host changed and the owner confirmed sending the saved key to the new
--    host (keepKeyForNewHost: true) instead of entering a new key. No key material is ever stored here.
--  - changed_by: the owner's user id (SET NULL when the user is deleted).
--  - Rows go with their workspace (ON DELETE CASCADE). provider_id has no foreign key on purpose (so the
--    provider table can be rebuilt by a later migration without touching this log): DELETE of a provider
--    removes its rows explicitly in the same batch. Reads return the newest few per provider only.
CREATE TABLE workspace_custom_provider_changes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  changed_at TEXT NOT NULL,
  fields TEXT NOT NULL,
  old_base_url TEXT,
  new_base_url TEXT,
  old_host TEXT,
  new_host TEXT,
  key_kept_for_new_host INTEGER NOT NULL DEFAULT 0 CHECK (key_kept_for_new_host IN (0, 1))
);

CREATE INDEX idx_custom_provider_changes ON workspace_custom_provider_changes(workspace_id, provider_id, changed_at);
