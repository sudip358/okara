-- [A25] Internal link suggester.
--   * page_snapshots.link_context_json: compact plain-text sentences from the page's main content
--     (nav/header/footer/aside, scripts, headings, and form controls excluded), at most 40 sentences of
--     at most 240 characters, 6..60 words each. Snapshots taken before this migration hold '[]' and fall
--     back to the stored excerpt; the crawler re-extracts them when their content hash is reused.
--   * link_runs: one row per user-triggered suggester run over the latest crawl.
--   * link_suggestions: every candidate pair considered in a run (suggested, review, or rejected).
--     user_status (open | accepted | dismissed | implemented) is carried over to the next run for the same
--     suggestion_key = source page | target page | lower-cased anchor; a dismissed source/target pair also
--     stays dismissed when the anchor changes. Okara never edits pages: these are suggestions only.

ALTER TABLE page_snapshots ADD COLUMN link_context_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE link_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  crawl_run_id TEXT REFERENCES crawl_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  is_demo INTEGER NOT NULL DEFAULT 0,
  pages_analysed INTEGER NOT NULL DEFAULT 0,
  pages_eligible INTEGER NOT NULL DEFAULT 0,
  provider TEXT,                      -- 'typesafe' when Jev answered; NULL for deterministic-only runs
  model TEXT,                         -- resolved model returned by the provider
  method_version TEXT NOT NULL,       -- candidate/sentence/anchor formula version (src/worker/links/*)
  summary_json TEXT NOT NULL DEFAULT '{}', -- orphan pages, generic anchors, completeness, counts, Jev call stats
  notes_json TEXT NOT NULL DEFAULT '[]',   -- labels shown with the report
  created_by TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_link_runs_project ON link_runs(workspace_id, project_id, created_at);

CREATE TABLE link_suggestions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  link_run_id TEXT NOT NULL REFERENCES link_runs(id) ON DELETE CASCADE,
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_title TEXT,
  target_url TEXT NOT NULL,
  target_title TEXT,
  target_inlinks INTEGER NOT NULL DEFAULT 0,
  target_orphan INTEGER NOT NULL DEFAULT 0,
  suggestion_key TEXT NOT NULL,       -- source_page_id|target_page_id|lower(anchor)
  sentence_index INTEGER,             -- index into the source snapshot's link context sentences
  sentence_text TEXT,                 -- plain text, untrusted crawled content
  anchor_text TEXT,
  role TEXT CHECK (role IN ('explains_concept', 'deeper_detail', 'broader_guide', 'next_step', 'product_service', 'comparison')),
  method TEXT NOT NULL CHECK (method IN ('jev', 'deterministic')),
  tier TEXT CHECK (tier IN ('act', 'flag', 'drop', 'n/a')),
  should_exist REAL,                  -- Jev Noul (yes probability); never a confidence
  sentence_confidence REAL,           -- Jev Choice confidence; NULL when withheld (drop) or not asked
  anchor_confidence REAL,
  role_confidence REAL,
  provider TEXT,
  model TEXT,
  question_version TEXT,
  policy_version TEXT,
  decision_record_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('suggested', 'review', 'rejected')),
  score REAL NOT NULL,                -- deterministic candidate score (documented formula), not a Jev value
  reasons_json TEXT NOT NULL DEFAULT '[]',
  user_status TEXT NOT NULL DEFAULT 'open' CHECK (user_status IN ('open', 'accepted', 'dismissed', 'implemented')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_link_sugg_run ON link_suggestions(workspace_id, project_id, link_run_id, status, score);
CREATE INDEX idx_link_sugg_key ON link_suggestions(project_id, suggestion_key);
CREATE INDEX idx_link_sugg_pair ON link_suggestions(project_id, source_page_id, target_page_id);
