-- Okara two-agent SEO/GEO SaaS: initial schema (Cloudflare D1 / SQLite).
-- Conventions:
--   * ids are TEXT (prefixed random ids from src/worker/lib/ids.ts)
--   * timestamps are TEXT ISO-8601 UTC
--   * JSON columns are TEXT holding JSON, suffixed _json
--   * every tenant table carries workspace_id and every query filters by it

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                -- SHA-256 hex of the session token; the raw token only lives in the cookie
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  rotated_from TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Transient OAuth state for login and GSC connection (state, nonce, PKCE verifier, binding).
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'gsc')),
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  session_id TEXT,                    -- gsc: bound to initiating session
  user_id TEXT,
  workspace_id TEXT,
  project_id TEXT,
  return_to TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

-- ---------------------------------------------------------------- projects & context
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  site_url TEXT NOT NULL,             -- canonical origin, https only
  site_type TEXT NOT NULL CHECK (site_type IN ('ecommerce', 'saas', 'publisher', 'local', 'other')),
  brand_name TEXT NOT NULL,
  brand_aliases_json TEXT NOT NULL DEFAULT '[]',
  competitors_json TEXT NOT NULL DEFAULT '[]', -- [{name, domains[], aliases[]}] max 5
  product_description TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'en-US',
  language TEXT NOT NULL DEFAULT 'en',
  voice TEXT NOT NULL DEFAULT '',
  verified_host TEXT,                 -- set only after ownership verification
  verification_method TEXT CHECK (verification_method IN ('gsc', 'dns', 'file')),
  verification_token TEXT,
  verified_at TEXT,
  gsc_property TEXT,                  -- 'https://example.com/' or 'sc-domain:example.com'
  schedule_enabled INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_ws ON projects(workspace_id);

-- Versioned shared context documents (context_versions in the kit).
CREATE TABLE context_documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('product', 'positioning', 'competitors', 'voice', 'pillars')),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]', -- [{id, text, confirmed:boolean, source}]
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, kind, version)
);
CREATE INDEX idx_ctx_project ON context_documents(workspace_id, project_id, kind);

-- ---------------------------------------------------------------- integrations & credentials
CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google_gsc')),
  scopes TEXT NOT NULL,
  refresh_token_enc TEXT,             -- versioned AES-GCM envelope (src/worker/lib/crypto.ts)
  status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, provider)
);

-- Bring-your-own provider keys, encrypted, workspace-scoped. Never returned to the browser.
CREATE TABLE provider_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('typesafe', 'gemini', 'perplexity', 'writer')),
  key_enc TEXT NOT NULL,
  key_hint TEXT NOT NULL,             -- last 4 chars only
  last_tested_at TEXT,
  last_test_ok INTEGER,
  last_test_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, provider)
);

-- ---------------------------------------------------------------- runs
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent TEXT NOT NULL CHECK (agent IN ('seo', 'geo')),
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'demo')),
  idempotency_key TEXT NOT NULL UNIQUE, -- project:agent:interval for schedules
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'partial', 'completed', 'failed', 'rate_limited', 'cancelled', 'setup_required')),
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  workflow_instance_id TEXT,
  policy_version TEXT,
  error TEXT,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_runs_project ON agent_runs(workspace_id, project_id, created_at);

CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'skipped', 'failed', 'partial', 'info')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_run ON run_events(run_id, created_at);
CREATE INDEX idx_events_project ON run_events(workspace_id, project_id, created_at);

CREATE TABLE run_locks (
  project_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  run_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (project_id, agent)
);

-- ---------------------------------------------------------------- crawl
CREATE TABLE crawl_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  pages_limit INTEGER NOT NULL,
  pages_crawled INTEGER NOT NULL DEFAULT 0,
  pages_skipped INTEGER NOT NULL DEFAULT 0,
  robots_json TEXT,                   -- robots/AI crawler access summary
  notes_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_crawl_project ON crawl_runs(workspace_id, project_id, started_at);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  page_type TEXT NOT NULL CHECK (page_type IN ('home', 'collection', 'product', 'article', 'landing', 'other')),
  page_type_method TEXT NOT NULL,     -- url_pattern | jsonld | sitemap | user
  first_seen_at TEXT NOT NULL,
  last_crawled_at TEXT,
  UNIQUE (project_id, url)
);

CREATE TABLE page_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  crawl_run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  status_code INTEGER,
  final_url TEXT,
  content_hash TEXT,
  skipped_reason TEXT,                -- robots_disallowed | non_html | too_large | timeout | js_rendered | redirect_offsite | error
  title TEXT,
  meta_description TEXT,
  h1_json TEXT NOT NULL DEFAULT '[]',
  headings_json TEXT NOT NULL DEFAULT '[]',
  canonical TEXT,
  robots_meta TEXT,
  jsonld_types_json TEXT NOT NULL DEFAULT '[]',
  jsonld_issues_json TEXT NOT NULL DEFAULT '[]',
  internal_links_json TEXT NOT NULL DEFAULT '[]',
  word_count INTEGER,
  main_text_excerpt TEXT,             -- compact evidence, capped
  first_paragraph TEXT,
  author TEXT,
  last_updated TEXT,
  outbound_citations INTEGER,
  table_count INTEGER,
  fetched_at TEXT NOT NULL
);
CREATE INDEX idx_snap_page ON page_snapshots(page_id, fetched_at);
CREATE INDEX idx_snap_crawl ON page_snapshots(crawl_run_id);

-- Deterministic rule findings (rule registry output).
CREATE TABLE audit_findings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  crawl_run_id TEXT NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'major', 'moderate', 'minor', 'advisory')),
  url TEXT,
  template TEXT,
  detail TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_findings_crawl ON audit_findings(crawl_run_id);

-- ---------------------------------------------------------------- GSC
CREATE TABLE gsc_syncs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('api', 'csv_import', 'demo')),
  property TEXT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  prev_window_start TEXT NOT NULL,
  prev_window_end TEXT NOT NULL,
  data_state TEXT NOT NULL DEFAULT 'final',
  rows_fetched INTEGER NOT NULL DEFAULT 0,
  row_cap INTEGER NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  totals_json TEXT NOT NULL DEFAULT '{}', -- property totals per window from a separate aggregate request
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed', 'no_data')),
  error TEXT,
  synced_at TEXT NOT NULL
);
CREATE INDEX idx_gsc_syncs_project ON gsc_syncs(workspace_id, project_id, synced_at);

CREATE TABLE gsc_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sync_id TEXT NOT NULL REFERENCES gsc_syncs(id) ON DELETE CASCADE,
  window TEXT NOT NULL CHECK (window IN ('current', 'previous')),
  query TEXT,
  page TEXT,
  device TEXT,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  ctr REAL NOT NULL,
  position REAL NOT NULL
);
CREATE INDEX idx_gsc_metrics_sync ON gsc_metrics(sync_id, window);
CREATE INDEX idx_gsc_metrics_page ON gsc_metrics(project_id, page);

CREATE TABLE gsc_daily (
  sync_id TEXT NOT NULL REFERENCES gsc_syncs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  date TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  PRIMARY KEY (sync_id, date)
);

-- ---------------------------------------------------------------- evidence, decisions, recommendations
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('gsc', 'crawl', 'context_doc', 'geo_observation', 'manual_import', 'rule')),
  ref_id TEXT,                        -- id of the underlying row (snapshot, sync, observation, doc version)
  window TEXT,                        -- e.g. '2026-08-30..2026-09-26'
  text TEXT NOT NULL,                 -- human-readable, capped
  data_json TEXT NOT NULL DEFAULT '{}',
  tainted INTEGER NOT NULL DEFAULT 0, -- [A14] untrusted-text preflight
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_evidence_project ON evidence(workspace_id, project_id);

CREATE TABLE decision_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  agent TEXT NOT NULL CHECK (agent IN ('seo', 'geo')),
  candidate_key TEXT NOT NULL,
  question_id TEXT,
  question_version TEXT,
  policy_version TEXT,
  provider TEXT,                      -- 'typesafe' or the true fallback provider name
  model TEXT,
  state_hash TEXT,
  answer_json TEXT,                   -- raw answer, kept for re-scoring
  tier TEXT CHECK (tier IN ('act', 'flag', 'drop', 'n/a')),
  outcome TEXT NOT NULL CHECK (outcome IN ('selected', 'rejected')),
  reason_code TEXT,                   -- low_fit | duplicate | insufficient_evidence | budget | dismissed_recently | out_of_scope | decision_unavailable
  created_at TEXT NOT NULL
);
CREATE INDEX idx_decisions_run ON decision_records(run_id);
CREATE INDEX idx_decisions_project ON decision_records(workspace_id, project_id, created_at);

CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  agent TEXT NOT NULL CHECK (agent IN ('seo', 'geo')),
  scope TEXT NOT NULL CHECK (scope IN ('page', 'template', 'site')),
  target_json TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  trigger TEXT NOT NULL,
  issue TEXT NOT NULL,
  action TEXT NOT NULL,
  suggested_snippet TEXT,
  rationale TEXT NOT NULL,
  effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high')),
  uncertainty TEXT NOT NULL CHECK (uncertainty IN ('low', 'medium', 'high')),
  limitations TEXT NOT NULL,
  verified INTEGER NOT NULL,
  priority REAL NOT NULL,
  priority_version TEXT NOT NULL,
  decision_label TEXT,                -- e.g. 'act' / 'flag'
  decision_score_json TEXT,           -- real provider field names only
  evidence_ids_json TEXT NOT NULL,
  evidence_bullets_json TEXT NOT NULL DEFAULT '[]',
  confirm_placeholders_json TEXT NOT NULL DEFAULT '[]',
  dedup_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'dismissed', 'implemented')),
  stage TEXT NOT NULL DEFAULT 'awaiting_approval', -- collected | judged | drafted | awaiting_approval | marked_implemented
  writer_provider TEXT,
  writer_model TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_recs_project ON recommendations(workspace_id, project_id, agent, status, created_at);
CREATE INDEX idx_recs_dedup ON recommendations(project_id, dedup_key);

CREATE TABLE recommendation_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  recommendation_id TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  user_id TEXT,
  event TEXT NOT NULL,                -- created | edited | approved | dismissed | implemented | reopened
  note TEXT,
  created_at TEXT NOT NULL
);

-- [A18] "Disagree" feedback on Jev judgments feeding the labelled evaluation set.
CREATE TABLE judgment_feedback (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision_record_id TEXT NOT NULL REFERENCES decision_records(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  human_answer TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- GEO
CREATE TABLE geo_prompt_sets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE geo_prompts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt_set_id TEXT NOT NULL REFERENCES geo_prompt_sets(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  prompt_type TEXT NOT NULL CHECK (prompt_type IN ('discovery', 'reputation')),
  stage TEXT,
  locale TEXT NOT NULL,
  language TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL
);
CREATE INDEX idx_geo_prompts_set ON geo_prompts(prompt_set_id);

CREATE TABLE geo_observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  prompt_id TEXT REFERENCES geo_prompts(id) ON DELETE SET NULL,
  prompt_set_id TEXT,
  prompt_text TEXT NOT NULL,
  prompt_type TEXT NOT NULL,
  cohort_key TEXT NOT NULL,           -- hash(prompt_set_version, provider, model, grounding config)
  provider TEXT NOT NULL,             -- gemini | perplexity | manual
  model TEXT NOT NULL,
  grounding_mode TEXT NOT NULL,       -- e.g. google_search | sonar_web | none
  measurement_type TEXT NOT NULL CHECK (measurement_type IN ('api', 'manual_import')),
  imported_surface TEXT,              -- manual imports only, e.g. 'ChatGPT app (manual)'
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'incomplete')),
  grounded INTEGER NOT NULL DEFAULT 0,
  raw_answer TEXT,                    -- size-capped
  request_id TEXT,
  usage_json TEXT NOT NULL DEFAULT '{}',
  cost_usd REAL,
  cost_is_estimate INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_geo_obs_project ON geo_observations(workspace_id, project_id, created_at);
CREATE INDEX idx_geo_obs_cohort ON geo_observations(project_id, cohort_key);

CREATE TABLE geo_brand_observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES geo_observations(id) ON DELETE CASCADE,
  brand_key TEXT NOT NULL,            -- 'self' or competitor name
  is_self INTEGER NOT NULL,
  mentioned INTEGER NOT NULL,
  cited INTEGER NOT NULL,
  recommendation_status TEXT NOT NULL CHECK (recommendation_status IN ('recommended', 'listed_neutral', 'mentioned_negatively', 'not_mentioned', 'unknown')),
  list_rank INTEGER,                  -- only for a real ordered list
  sentiment TEXT NOT NULL CHECK (sentiment IN ('positive', 'neutral', 'negative', 'mixed', 'unknown', 'not_applicable')),
  spans_json TEXT NOT NULL DEFAULT '[]',
  method TEXT NOT NULL                -- deterministic | jev | deterministic+jev
);
CREATE INDEX idx_geo_brand_obs ON geo_brand_observations(observation_id);

CREATE TABLE geo_citations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES geo_observations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  title TEXT,
  position INTEGER,
  brand_key TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('brand_page', 'listicle_roundup', 'review_site', 'forum_ugc', 'publisher', 'marketplace', 'other')),
  source_type_method TEXT NOT NULL    -- rule | jev | unknown
);
CREATE INDEX idx_geo_citations_obs ON geo_citations(observation_id);

CREATE TABLE geo_search_queries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES geo_observations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  query TEXT NOT NULL,
  normalized TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_geo_sq_project ON geo_search_queries(project_id, normalized);

CREATE TABLE geo_displacements (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES geo_observations(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  url TEXT,
  source_type TEXT NOT NULL,
  span TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_geo_disp_project ON geo_displacements(project_id, entity);

-- ---------------------------------------------------------------- usage, costs, limits
CREATE TABLE provider_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'timeout', 'unknown')),
  request_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  search_requests INTEGER,
  cost_usd REAL,                      -- NULL when unknown; never shown as $0 actual
  cost_is_estimate INTEGER NOT NULL DEFAULT 1,
  rate_version TEXT,
  latency_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_calls_project ON provider_calls(workspace_id, project_id, created_at);

-- Atomic counters: reserve with a single conditional UPDATE (used + amount <= limit).
CREATE TABLE usage_counters (
  scope_key TEXT NOT NULL,            -- 'project:<id>' | 'global'
  day TEXT NOT NULL,                  -- YYYY-MM-DD UTC
  resource TEXT NOT NULL,             -- usd_micros | provider_calls | crawl_pages | gsc_rows | geo_prompts | jev_calls | writer_tokens
  used INTEGER NOT NULL DEFAULT 0,
  limit_value INTEGER NOT NULL,
  PRIMARY KEY (scope_key, day, resource)
);

CREATE TABLE usage_reservations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  project_id TEXT,
  run_id TEXT,
  scope_key TEXT NOT NULL,
  day TEXT NOT NULL,
  resource TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'unknown')),
  settled_amount INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_resv_run ON usage_reservations(run_id);

CREATE TABLE project_limits (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  crawl_pages INTEGER NOT NULL DEFAULT 20,
  gsc_rows INTEGER NOT NULL DEFAULT 5000,
  geo_prompts_per_run INTEGER NOT NULL DEFAULT 5,
  provider_calls_per_day INTEGER NOT NULL DEFAULT 60,
  usd_micros_per_day INTEGER NOT NULL DEFAULT 500000,   -- $0.50/day default
  updated_at TEXT NOT NULL
);

-- Rate limiting for API endpoints (fixed window).
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
