CREATE INDEX IF NOT EXISTS idx_operators_active_seen
ON operators (active, last_seen_at);
