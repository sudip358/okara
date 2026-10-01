-- Serves the decision cache lookup (seo/recommend/query-batch.ts): per key it seeks
-- project_id + question_id + candidate_key and reads created_at inside the cache window, instead of
-- scanning every decision row the project wrote in that window through idx_decisions_project.
CREATE INDEX IF NOT EXISTS idx_decisions_cache ON decision_records(project_id, question_id, candidate_key, created_at);

-- SQLite only prefers this index over idx_decisions_project (which also matches workspace_id and the
-- ORDER BY created_at) once table statistics exist. D1 does not refresh them by itself and recommends
-- PRAGMA optimize after creating an index (developers.cloudflare.com/d1/sql-api/sql-statements/).
PRAGMA optimize;
