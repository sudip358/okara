-- Serves the decision cache lookup (seo/recommend/query-batch.ts): per key it seeks
-- project_id + question_id + candidate_key and reads the newest created_at inside the cache window,
-- instead of scanning every decision row the project wrote in that window through idx_decisions_project.
CREATE INDEX IF NOT EXISTS idx_decisions_cache ON decision_records(project_id, question_id, candidate_key, created_at);
