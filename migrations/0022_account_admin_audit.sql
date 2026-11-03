-- Administrative identity changes remain auditable even when applied by a
-- deployment owner directly through D1. There is no public role-grant API.
CREATE TABLE account_admin_audit (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  event TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  details TEXT NOT NULL
);
CREATE INDEX idx_account_admin_audit_account ON account_admin_audit(account_id, created_at);

CREATE TRIGGER audit_account_admin_grant AFTER INSERT ON account_roles
WHEN NEW.role = 'admin'
BEGIN
  UPDATE accounts SET session_version=session_version+1,
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE id=NEW.account_id;
  UPDATE account_sessions SET revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000
    WHERE account_id=NEW.account_id AND revoked_at=0;
  INSERT INTO account_admin_audit(id,account_id,event,created_at,details)
  VALUES(lower(hex(randomblob(16))),NEW.account_id,'admin_granted',
    CAST(strftime('%s','now') AS INTEGER)*1000,'controlled-deployment');
END;

CREATE TRIGGER audit_account_admin_revoke AFTER DELETE ON account_roles
WHEN OLD.role = 'admin'
BEGIN
  UPDATE accounts SET session_version=session_version+1,
    updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE id=OLD.account_id;
  UPDATE account_sessions SET revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000
    WHERE account_id=OLD.account_id AND revoked_at=0;
  INSERT INTO account_admin_audit(id,account_id,event,created_at,details)
  VALUES(lower(hex(randomblob(16))),OLD.account_id,'admin_revoked',
    CAST(strftime('%s','now') AS INTEGER)*1000,'controlled-deployment');
END;

CREATE TRIGGER audit_account_status AFTER UPDATE OF status ON accounts
WHEN NEW.status != OLD.status
BEGIN
  INSERT INTO account_admin_audit(id,account_id,event,created_at,details)
  VALUES(lower(hex(randomblob(16))),NEW.id,'status_changed',
    CAST(strftime('%s','now') AS INTEGER)*1000,OLD.status || ' -> ' || NEW.status);
END;
