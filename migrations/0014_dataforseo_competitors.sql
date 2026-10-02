-- DataForSEO competitor data (owner request 2026-10-02: "If I add a competitor it should pull data from the
-- DataForSEO API"). See docs/provider-contracts.md "DataForSEO Labs", docs/api.md "Competitor data
-- (DataForSEO)", src/worker/competitors/dataforseo.ts.
--
-- 1. provider_credentials.provider gains 'dataforseo' (API login + API password stored together as the
--    AES-GCM-encrypted "login:password" Basic credential; key_hint = last 4 characters of the password).
--    SQLite cannot alter a CHECK constraint, so the table is rebuilt exactly like 0008 did: defer FK checks
--    for this transaction, create the new table, copy every row, drop the old one, rename. Columns,
--    constraints and FKs are those of 0001/0008; only the CHECK list changes. No other table references
--    provider_credentials and it has no secondary index (the UNIQUE autoindex is recreated with the table).
PRAGMA defer_foreign_keys = true;

CREATE TABLE provider_credentials_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('typesafe', 'gemini', 'perplexity', 'writer', 'openai_geo', 'anthropic_geo', 'dataforseo')),
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

-- 2. Per-project DataForSEO settings: the Labs location/language used for every competitor request
--    (resolved from the project locale via the free locations_and_languages endpoint, or chosen by the owner
--    when the locale cannot be mapped), and whether adding a competitor domain pulls data automatically.
--    resolved_for_locale: the "locale|language" an automatic choice was made for (re-resolved when it changes).
CREATE TABLE competitor_data_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  location_code INTEGER,
  location_name TEXT,
  language_code TEXT,
  language_name TEXT,
  location_source TEXT CHECK (location_source IN ('auto', 'user')),
  resolved_for_locale TEXT,
  auto_fetch INTEGER NOT NULL DEFAULT 1 CHECK (auto_fetch IN (0, 1)),
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- 3. One row per refresh of one competitor domain (queue + log). At most one queued/running refresh per
--    (project, domain) (partial unique index). Daily caps are counted from created_at (UTC day).
--    cost_usd = sum of the costs DataForSEO returned (NULL when any call's cost is unknown; never 0 for unknown).
CREATE TABLE competitor_fetches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('competitor_added', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'setup_required')),
  requested_by TEXT,
  location_code INTEGER,
  language_code TEXT,
  cost_usd REAL,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE UNIQUE INDEX idx_competitor_fetches_active ON competitor_fetches(project_id, domain) WHERE status IN ('queued', 'running');
CREATE INDEX idx_competitor_fetches_domain ON competitor_fetches(workspace_id, project_id, domain, created_at);
CREATE INDEX idx_competitor_fetches_status ON competitor_fetches(status, created_at);

-- 4. Parsed, bounded results per endpoint per refresh (third-party estimates; untrusted text stored as data).
--    data_json holds only the normalized fields the UI shows (<= 100 keywords / 100 gap rows / 20 pages, text
--    clipped), never the raw response. Retention: the newest few refreshes per (project, domain) are kept
--    (src/worker/competitors/dataforseo.ts KEEP_SNAPSHOTS_PER_DOMAIN); older rows are deleted after each refresh.
CREATE TABLE competitor_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fetch_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  endpoint TEXT NOT NULL CHECK (endpoint IN ('ranked_keywords', 'domain_intersection', 'relevant_pages')),
  location_code INTEGER NOT NULL,
  language_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  cost_usd REAL,
  total_count INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX idx_competitor_snapshots_domain ON competitor_snapshots(workspace_id, project_id, domain, fetched_at);
CREATE INDEX idx_competitor_snapshots_fetch ON competitor_snapshots(fetch_id);
