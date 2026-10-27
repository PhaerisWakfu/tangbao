CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_push_operator ON push_subscriptions (operator_id);
