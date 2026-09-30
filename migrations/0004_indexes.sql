-- Indexes on foreign-key columns that had none. A project delete cascades (ON DELETE CASCADE /
-- SET NULL) through these columns; without an index SQLite scans the whole child table for every
-- deleted parent row (e.g. every deleted page scans all tenants' link_suggestions twice), which can
-- exceed D1's per-query time limit and bills the rows read. Some also serve read paths
-- (recommendation_events by recommendation, checklist_manual by page).

CREATE INDEX IF NOT EXISTS idx_link_sugg_source ON link_suggestions(source_page_id);
CREATE INDEX IF NOT EXISTS idx_link_sugg_target ON link_suggestions(target_page_id);
CREATE INDEX IF NOT EXISTS idx_link_sugg_link_run ON link_suggestions(link_run_id);
CREATE INDEX IF NOT EXISTS idx_link_runs_crawl ON link_runs(crawl_run_id);

CREATE INDEX IF NOT EXISTS idx_crawl_run ON crawl_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_gsc_syncs_run ON gsc_syncs(run_id);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);
CREATE INDEX IF NOT EXISTS idx_recs_run ON recommendations(run_id);
CREATE INDEX IF NOT EXISTS idx_geo_obs_run ON geo_observations(run_id);
CREATE INDEX IF NOT EXISTS idx_geo_obs_prompt ON geo_observations(prompt_id);

CREATE INDEX IF NOT EXISTS idx_rec_events_rec ON recommendation_events(recommendation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_judgment_feedback_decision ON judgment_feedback(decision_record_id);
CREATE INDEX IF NOT EXISTS idx_checklist_manual_page ON checklist_manual(page_id);
