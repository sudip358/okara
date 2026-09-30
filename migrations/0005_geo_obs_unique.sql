-- One API sample per prompt x provider per run. A Workflow retry of geo.batch skips pairs already
-- observed for the run (geo/batch.ts); this index also refuses a second observation when two attempts
-- of the step overlap. Partial: manual imports have run_id NULL, and prompt_id becomes NULL when a
-- prompt is deleted (ON DELETE SET NULL), so neither is constrained.
--
-- Before the index can be created, any existing duplicates (left by retried steps before this fix) are
-- removed, keeping the first-stored sample; their citations, search queries and analysis rows go with
-- them through ON DELETE CASCADE. On a database without duplicates this deletes nothing.
DELETE FROM geo_observations
 WHERE measurement_type = 'api' AND run_id IS NOT NULL AND prompt_id IS NOT NULL
   AND rowid NOT IN (
     SELECT MIN(rowid) FROM geo_observations
      WHERE measurement_type = 'api' AND run_id IS NOT NULL AND prompt_id IS NOT NULL
      GROUP BY run_id, prompt_id, provider
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_geo_obs_run_prompt_provider
  ON geo_observations(run_id, prompt_id, provider)
  WHERE measurement_type = 'api' AND run_id IS NOT NULL AND prompt_id IS NOT NULL;

-- Serves the cron sweep that releases reservations stranded in 'reserved' by a killed step attempt
-- (runs/scheduler.ts sweepStaleReservations): only 'reserved' rows are indexed, so it stays small.
CREATE INDEX IF NOT EXISTS idx_resv_stale ON usage_reservations(created_at) WHERE status = 'reserved';
