ALTER TABLE threads ADD COLUMN operator_id TEXT NOT NULL DEFAULT 'tangbao-vme50-flash';

CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  awake INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  suffix TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  operator_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_applications_status ON applications (status, created_at);
