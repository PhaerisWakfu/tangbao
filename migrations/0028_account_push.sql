CREATE TABLE push_subscriptions_new (
  endpoint TEXT PRIMARY KEY,
  operator_id TEXT,
  account_id TEXT,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO push_subscriptions_new (endpoint, operator_id, account_id, p256dh, auth, created_at)
SELECT endpoint, operator_id, NULL, p256dh, auth, created_at FROM push_subscriptions;

DROP TABLE push_subscriptions;
ALTER TABLE push_subscriptions_new RENAME TO push_subscriptions;

CREATE INDEX idx_push_operator ON push_subscriptions (operator_id);
CREATE INDEX idx_push_account ON push_subscriptions (account_id);
