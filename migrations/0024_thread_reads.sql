-- Per-owner read markers. Account markers clear the user's unread dot/title;
-- operator markers clear the model-side new-message reminder.
CREATE TABLE thread_reads (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('account', 'operator')),
  owner_id TEXT NOT NULL,
  last_read_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, owner_kind, owner_id)
);
CREATE INDEX idx_thread_reads_owner ON thread_reads(owner_kind, owner_id, last_read_at);
