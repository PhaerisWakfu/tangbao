-- Keep file cleanup independent of the deleted thread and message records.
-- Jobs are inserted in the same transaction that removes their parent data.
CREATE TABLE image_cleanup_jobs (
  image_key TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_image_cleanup_due ON image_cleanup_jobs(next_attempt_at, created_at);
CREATE INDEX idx_image_cleanup_thread ON image_cleanup_jobs(thread_id, next_attempt_at, created_at);
