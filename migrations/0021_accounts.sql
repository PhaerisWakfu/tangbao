-- Accounts are independent of the public, mutable model name.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  verified_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE account_roles (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'operator', 'admin')),
  PRIMARY KEY (account_id, role)
);

CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  session_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_account_sessions_account ON account_sessions(account_id, revoked_at, expires_at);

ALTER TABLE operators ADD COLUMN operator_uid TEXT;
UPDATE operators SET operator_uid = lower(hex(randomblob(16))) WHERE operator_uid IS NULL;
CREATE UNIQUE INDEX idx_operators_uid ON operators(operator_uid);
CREATE TRIGGER operators_assign_uid AFTER INSERT ON operators
WHEN NEW.operator_uid IS NULL
BEGIN
  UPDATE operators SET operator_uid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
ALTER TABLE operators ADD COLUMN owner_account_id TEXT REFERENCES accounts(id);
CREATE UNIQUE INDEX idx_operators_owner ON operators(owner_account_id) WHERE owner_account_id IS NOT NULL;
ALTER TABLE operators ADD COLUMN legacy_claimed_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE applications ADD COLUMN account_id TEXT REFERENCES accounts(id);
CREATE UNIQUE INDEX idx_applications_account_open ON applications(account_id)
WHERE account_id IS NOT NULL AND status IN ('pending', 'approved');

CREATE TABLE guest_identities (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_count INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  created_at INTEGER NOT NULL
);
ALTER TABLE threads ADD COLUMN account_id TEXT REFERENCES accounts(id);
ALTER TABLE threads ADD COLUMN guest_identity_id TEXT REFERENCES guest_identities(id);
CREATE INDEX idx_threads_account_updated ON threads(account_id, updated_at);
CREATE INDEX idx_threads_guest ON threads(guest_identity_id);

CREATE TABLE thread_creations (
  subject TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (subject, request_key)
);

CREATE TABLE legacy_claims (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  operator_uid TEXT NOT NULL,
  proof_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_legacy_claims_account ON legacy_claims(account_id, expires_at);

CREATE TABLE auth_rate_buckets (
  id TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE TABLE email_challenges (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  code_hmac TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  consumed_at INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_email_challenges_account ON email_challenges(account_id, purpose, created_at);
CREATE TABLE email_challenge_limits (
  subject TEXT PRIMARY KEY,
  next_send_at INTEGER NOT NULL
);

-- Reservation counts are charged when the durable task is created, before EMAIL.send.
-- A single configured daily budget is used; there is no monthly budget.
CREATE TABLE mail_budgets (
  period TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mail_deliveries (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES email_challenges(id),
  payload_ciphertext TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'retry', 'accepted', 'test', 'unknown', 'failed', 'expired', 'cancelled', 'delivered', 'bounced', 'complained')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_mail_deliveries_pending ON mail_deliveries(status, next_attempt_at);
CREATE INDEX idx_mail_deliveries_provider ON mail_deliveries(provider_id);
CREATE TABLE mail_events (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
