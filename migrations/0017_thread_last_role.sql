ALTER TABLE threads ADD COLUMN last_role TEXT NOT NULL DEFAULT '';

UPDATE threads
SET last_role = COALESCE((
  SELECT role FROM messages m
  WHERE m.thread_id = threads.id
  ORDER BY m.created_at DESC
  LIMIT 1
), '')
WHERE last_role = '';
