-- Backlink monitor: browser fallback (owner request 2026-10-05: "use Cloudflare's own browser service (Browser Run) in the
-- backlink monitor"). See docs/build-kit.md [A38] (2026-10-05 update), docs/api.md "Backlinks",
-- src/worker/backlinks/browser.ts.
--
-- A plain check that ends as missing, page_error 403/429/503 (bot wall) or fetch_failed (not an SSRF refusal) queues
-- the backlink for ONE re-check in Cloudflare's headless browser (Browser Run binding BROWSER). The browser result
-- supersedes the plain one for the status; both stay in the check history (method). Events are computed once, on the
-- final result, against the previous final check (browser_base_check_id).

-- 1. Which way a check was made. Existing rows are plain fetches.
ALTER TABLE backlink_checks ADD COLUMN method TEXT NOT NULL DEFAULT 'plain' CHECK (method IN ('plain', 'browser'));

-- 2. Browser re-check state per backlink (NULL = none needed / done).
--    browser_state: pending (waiting for the browser step; also while the daily browser budget is used up) |
--    unavailable (no BROWSER binding, browser re-checks disabled, or Browser Run refused repeatedly; plain result kept) |
--    failed (the browser could not load the page; plain result kept).
--    check_method: method of the check the denormalized status comes from.
ALTER TABLE backlinks ADD COLUMN check_method TEXT;
ALTER TABLE backlinks ADD COLUMN browser_state TEXT CHECK (browser_state IS NULL OR browser_state IN ('pending', 'unavailable', 'failed'));
ALTER TABLE backlinks ADD COLUMN browser_reason TEXT;
ALTER TABLE backlinks ADD COLUMN browser_queued_at TEXT;
ALTER TABLE backlinks ADD COLUMN browser_base_check_id TEXT;
ALTER TABLE backlinks ADD COLUMN browser_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_backlinks_browser ON backlinks(browser_state, browser_queued_at);

-- 3. Browser time used per UTC day for the whole Cloudflare account this deployment runs on (operator-level, not tenant
--    data: Browser Run's free allowance is per account). ms_used = wall time from launch to close (the binding does not
--    report X-Browser-Ms-Used; that header is documented for Quick Actions responses), with a pre-charged reservation
--    so an invocation cut off mid-render still counts. exhausted = 1 once Browser Run itself answered "time limit
--    exceeded" for the day.
CREATE TABLE browser_usage (
  day TEXT PRIMARY KEY,
  ms_used INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0 CHECK (exhausted IN (0, 1)),
  updated_at TEXT NOT NULL
);

-- 4. Single global lease: at most ONE Okara browser session at a time (Workers Free allows 3 concurrent browsers), and
--    at least 20 s between two launches (Workers Free: 1 new browser instance every 20 seconds).
CREATE TABLE browser_lease (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  lease_until TEXT,
  last_launch_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
