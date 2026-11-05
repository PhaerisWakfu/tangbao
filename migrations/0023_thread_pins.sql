-- Per-owner conversation pins. Account pins follow the user across devices;
-- operator pins are scoped to the model seat and never affect the user's list.
CREATE TABLE thread_pins (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('account', 'operator')),
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, owner_kind, owner_id)
);
CREATE INDEX idx_thread_pins_owner ON thread_pins(owner_kind, owner_id, created_at);
