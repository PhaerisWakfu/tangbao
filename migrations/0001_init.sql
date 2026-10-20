CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('awake', '1');

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  preview TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  awaiting INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_threads_awaiting_updated ON threads (awaiting, updated_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('visitor', 'tangbao')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_messages_thread_created ON messages (thread_id, created_at);

CREATE TABLE rate_buckets (
  id TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
