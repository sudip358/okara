-- Competitor auto-fetch backlog ([A39], owner request 2026-10-04 "add competitors data from sheet": up to 60 tracked
-- competitors, the list keeps growing). Adding many competitor domains at once must not spend silently and must not
-- drop domains either: the domains that do not fit today's per-project refresh cap
-- (src/worker/competitors/dataforseo.ts FETCHES_PER_PROJECT_PER_DAY) wait here, in the order they were added (sheet
-- order for imports), and the 15-minute cron moves them into competitor_fetches as the next UTC days' caps allow.
-- Rows are removed when queued, when the domain is no longer a tracked competitor, or when auto-fetch is off /
-- DataForSEO credentials are missing at drain time (no call is ever made for them). Tenant-scoped like the other
-- competitor tables; cascades on project delete.
CREATE TABLE competitor_fetch_backlog (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  position INTEGER NOT NULL,
  requested_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, domain)
);
CREATE INDEX idx_competitor_fetch_backlog_project ON competitor_fetch_backlog(workspace_id, project_id, position);
CREATE INDEX idx_competitor_fetch_backlog_created ON competitor_fetch_backlog(created_at);
