-- Partial ("section") agent runs (owner request 2026-10-03: "In the Live tab add a separate button for each
-- section to run that section, and one common button to run all"). See docs/api.md "Runs" and
-- docs/build-kit.md amendment 2026-10-03, src/shared/run-scope.ts, src/worker/runs/scope.ts.
--
-- scope_json: NULL = every step of the agent (scheduled runs, plain manual runs). Otherwise
-- {"steps":["crawl"],"engines":null} - the work steps this manual run executes (validate and summary always
-- run) and, for the GEO batch, the engine lanes it asks. Plain ADD COLUMN: no CHECK change, no rebuild.
ALTER TABLE agent_runs ADD COLUMN scope_json TEXT;
