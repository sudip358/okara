-- Serves the cron sweep of reservations stranded in 'reserved' (runs/scheduler.ts sweepOrphans): its
-- counter UPDATE probes stale rows per usage_counters key (scope_key, day, resource). Partial on
-- 'reserved', so it stays small; idx_resv_stale (0005) still serves the created_at cutoff scan.
CREATE INDEX IF NOT EXISTS idx_resv_reserved_key ON usage_reservations(scope_key, day, resource) WHERE status = 'reserved';
