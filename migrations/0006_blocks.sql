ALTER TABLE threads ADD COLUMN visitor_hash TEXT;
ALTER TABLE threads ADD COLUMN ip_hash TEXT;

CREATE TABLE blocks (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
