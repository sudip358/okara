-- Ask Okara (in-app chat agent). docs/api.md "Ask Okara (chat)"; docs/build-kit.md amendment 2026-10-02.
-- Sessions are private to the user who created them, scoped to one project. Retention: the newest
-- CHAT_SESSIONS_KEPT sessions per (project, user) are kept (src/worker/chat/store.ts prunes on create).
-- Every query filters by workspace_id (tenancy); rows cascade with the project.

CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  -- idle | running (a turn holds the lease until busy_until) | awaiting_confirmation (an action waits)
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'awaiting_confirmation')),
  busy_until TEXT,
  -- Paused tool round (provider-native transcript of the current turn), only while awaiting_confirmation.
  pending_json TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_chat_sessions_owner ON chat_sessions(workspace_id, project_id, user_id, updated_at);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'running', 'awaiting_confirmation', 'stopped', 'error')),
  steps_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  model_provider TEXT,
  model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX idx_chat_messages_session ON chat_messages(workspace_id, session_id, seq);

-- State-changing tool calls the model proposed. They run only through the confirm endpoint (user POST + CSRF),
-- once: pending -> executing (conditional UPDATE) -> executed | failed; or pending -> cancelled | expired.
CREATE TABLE chat_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'executed', 'failed', 'cancelled', 'expired')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_chat_actions_session ON chat_actions(workspace_id, session_id, status);
