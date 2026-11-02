ALTER TABLE threads ADD COLUMN reported_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN report_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_threads_reported
  ON threads (reported_at);
