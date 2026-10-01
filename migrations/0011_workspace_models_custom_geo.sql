-- Per-workspace model selection for the built-in providers, and custom OpenAI-compatible GEO engine lanes.
-- See docs/provider-contracts.md "Workspace model selection" and "Custom GEO engine lane",
-- src/worker/platform/provider-models.ts and src/worker/geo/custom-lanes.ts.
--
-- workspace_provider_models: the model id the workspace owner picked for a built-in provider (typesafe,
-- gemini, perplexity, openai_geo, anthropic_geo; never the writer, which has its own custom provider flow).
-- Resolution at run time: this row > the operator env var (GEMINI_MODEL, ...) > none (setup_required
-- "choose a model"); TypeSafe keeps its documented `jev-latest` alias as the last step. model is an
-- untrusted provider-defined id (validated per provider before it is stored; rendered as plain text).
-- Rows go with their workspace (ON DELETE CASCADE).
CREATE TABLE workspace_provider_models (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('typesafe', 'gemini', 'perplexity', 'openai_geo', 'anthropic_geo')),
  model TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider)
);

-- workspace_custom_providers.role: 'writer' (every existing row; the writer flow of 0010 is unchanged and
-- only ever lists, counts or selects writer rows) or 'geo' (a custom GEO engine lane: the approved prompt is
-- sent to {base_url}/chat/completions without tools; answers are stored ungrounded and count toward mention
-- rate only). A 'geo' row is never the writer (is_writer stays 0). At most 2 'geo' rows per workspace and
-- 5 'writer' rows (enforced in code).
ALTER TABLE workspace_custom_providers ADD COLUMN role TEXT NOT NULL DEFAULT 'writer' CHECK (role IN ('writer', 'geo'));

CREATE INDEX idx_custom_providers_role ON workspace_custom_providers(workspace_id, role, created_at);
