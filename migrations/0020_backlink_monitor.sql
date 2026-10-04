-- Backlink monitor (owner request 2026-10-04: "Add backlink monitor ... check the live link and the backlink in the
-- article for our site to see if it is dofollow or nofollow. Use the master sheet tab as the source"). See
-- docs/build-kit.md [A38], docs/api.md "Backlinks", src/worker/backlinks/**.
--
-- 1. imports.destination and import_syncs.destination gain 'backlinks'. SQLite cannot alter a CHECK constraint, so
--    both tables are rebuilt the D1-safe way used by 0008/0014/0018 (defer FK checks for this transaction, create the
--    new table, copy every row, drop the old one, rename). Columns, constraints and indexes are those of 0015 + 0018;
--    only the CHECK lists change.
--    import_changes references imports(id) ON DELETE CASCADE, and DROP TABLE runs an implicit DELETE that would fire
--    that cascade, so import_changes is copied aside first, dropped, and recreated (same columns, FK and index) after
--    imports is renamed back. No other table references imports or import_syncs.
PRAGMA defer_foreign_keys = true;

CREATE TABLE import_changes_keep AS SELECT * FROM import_changes;
DROP TABLE import_changes;

CREATE TABLE imports_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('csv', 'sheets')),
  source_name TEXT NOT NULL,
  spreadsheet_id TEXT,
  tab TEXT,
  sheet_tab_id INTEGER,
  destination TEXT NOT NULL CHECK (destination IN ('geo_prompts', 'competitors', 'implemented_links', 'context_doc', 'reference', 'backlinks')),
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
  undone_by TEXT,
  transport TEXT
);
INSERT INTO imports_new
  (id, workspace_id, project_id, source, source_name, spreadsheet_id, tab, sheet_tab_id, destination, trigger, sync_id, mapping_json,
   options_json, counts_json, changes_json, rows_read, status, created_by, created_at, undone_at, undone_by, transport)
SELECT id, workspace_id, project_id, source, source_name, spreadsheet_id, tab, sheet_tab_id, destination, trigger, sync_id, mapping_json,
       options_json, counts_json, changes_json, rows_read, status, created_by, created_at, undone_at, undone_by, transport
  FROM imports;
DROP TABLE imports;
ALTER TABLE imports_new RENAME TO imports;
CREATE INDEX idx_imports_project ON imports(workspace_id, project_id, created_at);
CREATE INDEX idx_imports_sync ON imports(sync_id, created_at);

CREATE TABLE import_changes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  record_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added', 'updated', 'removed')),
  prev_json TEXT,
  ref_id TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO import_changes (id, workspace_id, project_id, import_id, destination, record_key, action, prev_json, ref_id, created_at)
SELECT id, workspace_id, project_id, import_id, destination, record_key, action, prev_json, ref_id, created_at FROM import_changes_keep;
DROP TABLE import_changes_keep;
CREATE INDEX idx_import_changes_import ON import_changes(import_id);

CREATE TABLE import_syncs_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  spreadsheet_id TEXT NOT NULL,
  spreadsheet_title TEXT NOT NULL,
  tab TEXT NOT NULL,
  sheet_tab_id INTEGER,
  destination TEXT NOT NULL CHECK (destination IN ('geo_prompts', 'competitors', 'implemented_links', 'backlinks')),
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
  last_transport TEXT,
  UNIQUE (project_id, spreadsheet_id, tab, destination)
);
INSERT INTO import_syncs_new
  (id, workspace_id, project_id, spreadsheet_id, spreadsheet_title, tab, sheet_tab_id, destination, mapping_json, options_json, frequency_hours,
   enabled, next_run_at, running_until, last_run_at, last_status, last_error_code, last_error, last_warning, last_import_id, created_by,
   created_at, updated_at, last_transport)
SELECT id, workspace_id, project_id, spreadsheet_id, spreadsheet_title, tab, sheet_tab_id, destination, mapping_json, options_json, frequency_hours,
       enabled, next_run_at, running_until, last_run_at, last_status, last_error_code, last_error, last_warning, last_import_id, created_by,
       created_at, updated_at, last_transport
  FROM import_syncs;
DROP TABLE import_syncs;
ALTER TABLE import_syncs_new RENAME TO import_syncs;
CREATE INDEX idx_import_syncs_due ON import_syncs(enabled, next_run_at);
CREATE INDEX idx_import_syncs_project ON import_syncs(workspace_id, project_id);

-- 2. One row per (live article URL, target URL) pair from the owner's sheet/CSV (a sheet row with Anchor 2 / Target 2
--    gives two rows). pair_key = normalized live URL key + ">" + normalized target key (shared/import.ts linkUrlKey).
--    Sheet values (vendor, type, date, DA, traffic, price) are the owner's own data, "from your sheet". active = 0 when
--    a sync no longer finds the pair in the sheet (never deleted by a sync; undo of the import that created a row
--    deletes it). The latest check summary is denormalized here so the list/summary never scans backlink_checks.
--    status: dofollow | nofollow | sponsored | ugc | missing | page_error | redirected | robots_blocked | fetch_failed
--    (NULL = never checked). link_rel: the rel class of the matching link on the final page (also for redirected).
CREATE TABLE backlinks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pair_key TEXT NOT NULL,
  live_url TEXT NOT NULL,
  live_url_key TEXT NOT NULL,
  live_host TEXT NOT NULL,
  target_url TEXT NOT NULL,
  target_url_key TEXT NOT NULL,
  anchor_expected TEXT,
  vendor TEXT,
  link_type TEXT,
  placed_date TEXT,
  da REAL,
  traffic REAL,
  price_text TEXT,
  source_import_id TEXT,
  source_key TEXT,
  source_row INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  removed_at TEXT,
  status TEXT,
  status_reason TEXT,
  link_rel TEXT,
  http_status INTEGER,
  final_url TEXT,
  anchor_found TEXT,
  anchor_match INTEGER,
  rel_text TEXT,
  page_noindex INTEGER,
  target_status INTEGER,
  target_error TEXT,
  last_checked_at TEXT,
  last_check_id TEXT,
  last_job_id TEXT,
  last_change_at TEXT,
  last_change_text TEXT,
  last_change_negative INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, pair_key)
);
CREATE INDEX idx_backlinks_project ON backlinks(workspace_id, project_id, active, status);
CREATE INDEX idx_backlinks_job ON backlinks(workspace_id, project_id, last_job_id);
CREATE INDEX idx_backlinks_source ON backlinks(workspace_id, project_id, source_key);

-- 3. Check runs ("jobs"): a manual "Run backlink check" (scope all, 3 per project per UTC day), a recheck of chosen rows
--    (scope ids, 30 rows per project per hour) or the weekly scheduled check (cron). One queued/running job per
--    (project, scope). Work happens in bounded batches (<= 20 external fetches per invocation: robots.txt, redirect hops
--    and our own target checks included) under a lease (lease_until) so two invocations never process one job.
--    fetches/robots_blocked/failed count what the job did (crawl fetches are not provider calls and are not metered in
--    provider_calls, like the crawl).
CREATE TABLE backlink_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'recheck', 'scheduled')),
  scope TEXT NOT NULL CHECK (scope IN ('all', 'ids')),
  ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  robots_blocked INTEGER NOT NULL DEFAULT 0,
  changes INTEGER NOT NULL DEFAULT 0,
  fetches INTEGER NOT NULL DEFAULT 0,
  batches INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_backlink_jobs_project ON backlink_jobs(workspace_id, project_id, created_at);
CREATE INDEX idx_backlink_jobs_status ON backlink_jobs(status, updated_at);
CREATE UNIQUE INDEX idx_backlink_jobs_active ON backlink_jobs(project_id, scope) WHERE status IN ('queued', 'running');

-- 4. Per-job cache: robots.txt verdicts per origin (the selected group for our crawler token, capped), our target URL
--    checks (deduplicated per job) and per-host pacing (last request time; at most 1 request per second per host).
--    Deleted when the job finishes.
CREATE TABLE backlink_job_cache (
  job_id TEXT NOT NULL REFERENCES backlink_jobs(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, cache_key)
);

-- 5. Every check of a backlink (append-only; the latest 10 per backlink are kept). Page text is never stored: only
--    status, final URL, redirect chain, robots/meta verdicts, the matching links' rel tokens and anchor text (capped).
CREATE TABLE backlink_checks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backlink_id TEXT NOT NULL REFERENCES backlinks(id) ON DELETE CASCADE,
  job_id TEXT,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  link_rel TEXT,
  http_status INTEGER,
  final_url TEXT,
  redirect_chain_json TEXT NOT NULL DEFAULT '[]',
  robots TEXT,
  meta_robots TEXT,
  x_robots_tag TEXT,
  page_noindex INTEGER NOT NULL DEFAULT 0,
  page_nofollow INTEGER NOT NULL DEFAULT 0,
  canonical_url TEXT,
  link_match TEXT,
  links_json TEXT NOT NULL DEFAULT '[]',
  rel_text TEXT,
  anchor_found TEXT,
  anchor_match INTEGER,
  target_status INTEGER,
  target_final_url TEXT,
  target_error TEXT,
  error_code TEXT,
  fetches INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_backlink_checks_backlink ON backlink_checks(workspace_id, backlink_id, checked_at);
CREATE INDEX idx_backlink_checks_job ON backlink_checks(workspace_id, project_id, job_id, checked_at);

-- 6. Changes between a check and the previous one (code-computed, never by a model): kind, from/to and a plain message
--    ("dofollow → nofollow", "link removed", "page now 404", "redirected to <url>", "noindex added", "anchor changed",
--    "target now 404", "recovered"). negative = 1 for losses (shown on the Overview attention feed).
CREATE TABLE backlink_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backlink_id TEXT NOT NULL REFERENCES backlinks(id) ON DELETE CASCADE,
  check_id TEXT,
  job_id TEXT,
  kind TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  message TEXT NOT NULL,
  negative INTEGER NOT NULL DEFAULT 0 CHECK (negative IN (0, 1)),
  detected_at TEXT NOT NULL
);
CREATE INDEX idx_backlink_events_project ON backlink_events(workspace_id, project_id, detected_at);
CREATE INDEX idx_backlink_events_backlink ON backlink_events(workspace_id, backlink_id, detected_at);
