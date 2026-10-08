-- Ask Okara speed [A40] (docs/build-kit.md amendment 2026-10-08; docs/api.md "Ask Okara (chat)").
--
-- 1) What Okara learned about a chat model endpoint, per (workspace, provider host, model), so a new turn starts in
--    the right mode instead of re-probing every turn:
--      text_tools_until: the endpoint ignored native tool calling (it answered with neither text nor a tool call), so
--                        rounds start in text-tools mode (tool catalog in the system prompt) until this time (24 h).
--      no_stream_until:  the endpoint rejected `stream: true` (HTTP 400) and answered without it, so rounds are sent
--                        without streaming until this time (24 h).
--    Only non-secret facts; no key, URL path or response text is stored. Every query filters by workspace_id.
CREATE TABLE chat_model_prefs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  model TEXT NOT NULL,
  text_tools_until TEXT,
  no_stream_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, host, model)
);

-- 2) A streamed response without a usage chunk is metered with Okara's token estimate; this marks those rows
--    (0 = provider-reported counts, 1 = estimate).
ALTER TABLE provider_calls ADD COLUMN tokens_are_estimate INTEGER NOT NULL DEFAULT 0;
