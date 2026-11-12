-- A single-column SQLite index includes rowid as its final key. Seek by the
-- retained message rowid within one thread, without scanning/sorting its history.
CREATE INDEX idx_messages_thread_order ON messages(thread_id);
INSERT INTO settings (key, value) VALUES ('app_schema_version', '25')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
