CREATE TABLE presence_log (
  at INTEGER NOT NULL,
  awake INTEGER NOT NULL
);

CREATE INDEX idx_presence_log_at ON presence_log (at);
