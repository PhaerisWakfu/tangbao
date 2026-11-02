ALTER TABLE threads ADD COLUMN auto_home INTEGER NOT NULL DEFAULT 0;

UPDATE threads
SET auto_home = 1
WHERE operator_id = 'tangbao-vme50-flash'
  AND awaiting = 1
  AND NOT EXISTS (
    SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.role = 'tangbao'
  );

CREATE INDEX IF NOT EXISTS idx_threads_home_backlog
  ON threads (operator_id, awaiting, auto_home, updated_at);
