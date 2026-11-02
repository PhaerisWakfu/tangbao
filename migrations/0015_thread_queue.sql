ALTER TABLE threads ADD COLUMN queued INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_threads_home_queue
  ON threads (operator_id, awaiting, queued, updated_at);
