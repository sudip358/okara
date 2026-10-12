-- [A41] Internal links "Live" panel (2026-10-12): an append-only progress log for the link agent's work.
--   * link_live_runs: one row per tracked run: an analysis run (POST .../internal-links/run, ref_id = link_runs.id)
--     or a manual graph rebuild (POST .../graph/rebuild, ref_id = link_graphs.id). Graph builds after a crawl and the
--     demo seed are not tracked. status running -> completed | partial | failed; a 'running' row whose updated_at is
--     older than 10 minutes is reported as "interrupted" on read. totals_json holds the running totals written with
--     each stored batch of events. ref_id is not a foreign key: link_runs / link_graphs prune their own rows.
--   * link_live_events: (run, seq) ordered events: stage, status and a bounded detail_json (counts, at most 20
--     source -> target items with plain-text paths and anchors, a short code-written note; at most 4,000 chars).
--     At most 400 events per run (the final 'run' event is always stored; others beyond the cap are counted in
--     events_dropped).
-- Retention: the latest 5 tracked runs per project (older runs and their events are deleted when a new one starts).
-- Every read and write filters workspace_id and project_id.

CREATE TABLE link_live_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('analysis', 'graph')),
  ref_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  is_demo INTEGER NOT NULL DEFAULT 0,
  totals_json TEXT NOT NULL DEFAULT '{}',
  events_stored INTEGER NOT NULL DEFAULT 0,
  events_dropped INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_link_live_runs_project ON link_live_runs(workspace_id, project_id, started_at);

CREATE TABLE link_live_events (
  live_run_id TEXT NOT NULL REFERENCES link_live_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (live_run_id, seq)
);
CREATE INDEX idx_link_live_events_project ON link_live_events(workspace_id, project_id, live_run_id, seq);
