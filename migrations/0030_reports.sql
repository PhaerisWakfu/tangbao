-- Reports keep their own minimal evidence and stable actors after a chat is deleted.
ALTER TABLE messages ADD COLUMN author_account_id TEXT REFERENCES accounts(id);
CREATE INDEX idx_message_images_key ON message_images(image_key);
CREATE TRIGGER messages_author_immutable BEFORE UPDATE OF author_account_id ON messages
WHEN NEW.author_account_id IS NOT OLD.author_account_id
BEGIN SELECT RAISE(ABORT,'MESSAGE_AUTHOR_IMMUTABLE'); END;

CREATE TABLE report_policy_versions (
  id TEXT PRIMARY KEY,
  policy TEXT NOT NULL CHECK(json_valid(policy)),
  previous_id TEXT,
  created_by TEXT REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);
INSERT INTO report_policy_versions(id,policy,created_at,reason) VALUES(
  'reports-v1',
  '{"initialScore":100,"minimumScore":0,"minimumReportScore":60,"successLimit":1,"pendingPerPair":1,"pendingTargets":3,"failureWindowSeconds":604800,"upheldPenalty":5,"failureBands":[{"through":2,"points":1},{"through":4,"points":2},{"through":5,"points":3},{"through":6,"points":4},{"through":null,"points":5}],"reasonMinLength":2,"reasonMaxLength":500,"reviewReasonMaxLength":500,"submissionsPerThread":3,"rateWindowSeconds":3600,"pageSize":10,"maxPageSize":50}',
  0,'已确认的举报规则初始版本'
);
CREATE TABLE report_policy_active (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version_id TEXT NOT NULL REFERENCES report_policy_versions(id),
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT INTO report_policy_active(singleton,version_id) VALUES(1,'reports-v1');
CREATE VIEW report_current_policy AS
  SELECT v.id,v.policy,a.revision FROM report_policy_active a JOIN report_policy_versions v ON v.id=a.version_id WHERE a.singleton=1;
CREATE TRIGGER report_policy_no_update BEFORE UPDATE ON report_policy_versions
BEGIN SELECT RAISE(ABORT,'REPORT_POLICY_IMMUTABLE'); END;
CREATE TRIGGER report_policy_no_delete BEFORE DELETE ON report_policy_versions
BEGIN SELECT RAISE(ABORT,'REPORT_POLICY_IMMUTABLE'); END;

CREATE TABLE account_reputations (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  initial_score INTEGER NOT NULL,
  score INTEGER NOT NULL CHECK(score>=0 AND score<=initial_score),
  deducted INTEGER NOT NULL DEFAULT 0 CHECK(deducted>=0),
  event_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  report_revision INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO account_reputations(account_id,initial_score,score)
  SELECT id,100,100 FROM accounts;
CREATE TRIGGER accounts_initialize_reputation AFTER INSERT ON accounts
BEGIN
  INSERT INTO account_reputations(account_id,initial_score,score)
    SELECT NEW.id,json_extract(policy,'$.initialScore'),json_extract(policy,'$.initialScore') FROM report_current_policy;
END;

CREATE TABLE report_pairs (
  reporter_id TEXT NOT NULL REFERENCES accounts(id),
  target_id TEXT NOT NULL REFERENCES accounts(id),
  success_limit INTEGER NOT NULL CHECK(success_limit>0),
  success_count INTEGER NOT NULL DEFAULT 0,
  locked_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(reporter_id,target_id),
  CHECK(reporter_id<>target_id)
);
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES accounts(id),
  target_id TEXT NOT NULL REFERENCES accounts(id),
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reporter_role TEXT NOT NULL CHECK(reporter_role IN ('visitor','operator')),
  target_label TEXT NOT NULL,
  model_uid TEXT NOT NULL,
  thread_title TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  reason TEXT NOT NULL,
  request_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  creation_policy_id TEXT NOT NULL REFERENCES report_policy_versions(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','upheld','rejected')),
  reviewer_id TEXT REFERENCES accounts(id),
  review_reason TEXT,
  decided_at INTEGER,
  decision_policy_id TEXT REFERENCES report_policy_versions(id),
  affected_id TEXT REFERENCES accounts(id),
  nominal_penalty INTEGER,
  score_before INTEGER,
  score_after INTEGER,
  score_revision INTEGER,
  CHECK(reporter_id<>target_id),
  UNIQUE(reporter_id,request_key),
  CHECK((status='pending' AND reviewer_id IS NULL AND decided_at IS NULL AND affected_id IS NULL)
    OR (status<>'pending' AND reviewer_id IS NOT NULL AND review_reason IS NOT NULL AND decided_at IS NOT NULL
      AND decision_policy_id IS NOT NULL AND affected_id IS NOT NULL AND nominal_penalty IS NOT NULL
      AND score_before IS NOT NULL AND score_after IS NOT NULL AND score_revision IS NOT NULL))
);
CREATE INDEX idx_reports_reporter_page ON reports(reporter_id,created_at DESC,id DESC);
CREATE INDEX idx_reports_target_page ON reports(target_id,created_at DESC,id DESC) WHERE status='upheld';
CREATE INDEX idx_reports_pending_pair ON reports(reporter_id,target_id) WHERE status='pending';
CREATE INDEX idx_reports_failure_window ON reports(reporter_id,decided_at) WHERE status='rejected';
CREATE INDEX idx_reports_review_queue ON reports(status,created_at DESC,id DESC);
CREATE INDEX idx_reports_model_queue ON reports(status,model_uid,created_at DESC,id DESC);
CREATE INDEX idx_reports_thread ON reports(thread_id,created_at DESC,id DESC);
CREATE TABLE report_images (
  report_id TEXT NOT NULL REFERENCES reports(id),
  image_id TEXT NOT NULL,
  image_key TEXT NOT NULL,
  image_type TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY(report_id,image_id)
);
CREATE INDEX idx_report_images_key ON report_images(image_key);

CREATE TRIGGER reports_validate_insert BEFORE INSERT ON reports
BEGIN
  SELECT CASE WHEN NEW.status<>'pending' THEN RAISE(ABORT,'REPORT_INITIAL_STATE') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM report_current_policy WHERE id=NEW.creation_policy_id)
    THEN RAISE(ABORT,'REPORT_POLICY_CHANGED') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.reporter_id AND status='active' AND verified_at>0)
    OR NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.target_id AND verified_at>0)
    THEN RAISE(ABORT,'REPORT_ACCOUNT_REQUIRED') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM messages m JOIN threads t ON t.id=m.thread_id
    WHERE m.id=NEW.message_id AND t.id=NEW.thread_id AND m.author_account_id=NEW.target_id
      AND ((NEW.reporter_role='visitor' AND m.role='tangbao' AND t.account_id=NEW.reporter_id)
        OR (NEW.reporter_role='operator' AND m.role='visitor' AND EXISTS(SELECT 1 FROM account_roles WHERE account_id=NEW.reporter_id AND role IN ('operator','admin')) AND EXISTS(
          SELECT 1 FROM operators o WHERE o.id=t.operator_id AND o.active=1 AND o.owner_account_id=NEW.reporter_id
          UNION ALL SELECT 1 FROM settings s JOIN account_roles r ON r.account_id=s.value AND r.role='admin' WHERE s.key='home_owner_account_id' AND s.value=NEW.reporter_id AND t.operator_id='tangbao-vme50-flash'))))
    THEN RAISE(ABORT,'REPORT_MESSAGE_FORBIDDEN') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM account_reputations WHERE account_id=NEW.reporter_id)
    OR (SELECT score FROM account_reputations WHERE account_id=NEW.reporter_id)
      <(SELECT json_extract(policy,'$.minimumReportScore') FROM report_current_policy)
    THEN RAISE(ABORT,'REPORT_REPUTATION_LOW') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM report_pairs WHERE reporter_id=NEW.reporter_id AND target_id=NEW.target_id
      AND (locked_at>0 OR success_count>=success_limit))
    THEN RAISE(ABORT,'REPORT_PAIR_LOCKED') END;
  SELECT CASE WHEN (SELECT count(*) FROM reports WHERE reporter_id=NEW.reporter_id AND target_id=NEW.target_id AND status='pending')
      >=MIN((SELECT json_extract(policy,'$.pendingPerPair') FROM report_current_policy),
        COALESCE((SELECT success_limit-success_count FROM report_pairs WHERE reporter_id=NEW.reporter_id AND target_id=NEW.target_id),
          (SELECT json_extract(policy,'$.successLimit') FROM report_current_policy)))
    THEN RAISE(ABORT,'REPORT_PAIR_PENDING') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM reports WHERE reporter_id=NEW.reporter_id AND target_id=NEW.target_id AND status='pending')
    AND (SELECT count(DISTINCT target_id) FROM reports WHERE reporter_id=NEW.reporter_id AND status='pending')
      >=(SELECT json_extract(policy,'$.pendingTargets') FROM report_current_policy)
    THEN RAISE(ABORT,'REPORT_PENDING_LIMIT') END;
  SELECT CASE WHEN length(NEW.reason)<(SELECT json_extract(policy,'$.reasonMinLength') FROM report_current_policy)
    OR length(NEW.reason)>(SELECT json_extract(policy,'$.reasonMaxLength') FROM report_current_policy)
    THEN RAISE(ABORT,'REPORT_REASON_INVALID') END;
END;
CREATE TRIGGER reports_pin_evidence AFTER INSERT ON reports
BEGIN
  UPDATE account_reputations SET report_revision=report_revision+1 WHERE account_id=NEW.reporter_id;
  INSERT OR IGNORE INTO report_pairs(reporter_id,target_id,success_limit)
    SELECT NEW.reporter_id,NEW.target_id,json_extract(policy,'$.successLimit') FROM report_current_policy;
  INSERT INTO report_images(report_id,image_id,image_key,image_type,position)
    SELECT NEW.id,id,image_key,image_type,position FROM message_images WHERE message_id=NEW.message_id;
END;

CREATE TRIGGER reports_immutable BEFORE UPDATE ON reports
WHEN NEW.id IS NOT OLD.id OR NEW.reporter_id IS NOT OLD.reporter_id OR NEW.target_id IS NOT OLD.target_id
  OR NEW.thread_id IS NOT OLD.thread_id OR NEW.message_id IS NOT OLD.message_id OR NEW.reporter_role IS NOT OLD.reporter_role
  OR NEW.model_uid IS NOT OLD.model_uid OR NEW.target_label IS NOT OLD.target_label OR NEW.thread_title IS NOT OLD.thread_title OR NEW.snapshot IS NOT OLD.snapshot
  OR NEW.reason IS NOT OLD.reason OR NEW.request_key IS NOT OLD.request_key OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.created_at IS NOT OLD.created_at OR NEW.creation_policy_id IS NOT OLD.creation_policy_id
  OR OLD.status<>'pending'
BEGIN SELECT RAISE(ABORT,'REPORT_IMMUTABLE'); END;
CREATE TRIGGER reports_no_delete BEFORE DELETE ON reports
BEGIN SELECT RAISE(ABORT,'REPORT_IMMUTABLE'); END;

CREATE TRIGGER reports_validate_decision BEFORE UPDATE ON reports
BEGIN
  SELECT CASE WHEN OLD.status<>'pending' THEN RAISE(ABORT,'REPORT_IMMUTABLE') END;
  SELECT CASE WHEN NEW.status NOT IN ('upheld','rejected') THEN RAISE(ABORT,'REPORT_DECISION_INVALID') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM accounts a JOIN account_roles r ON r.account_id=a.id
      WHERE a.id=NEW.reviewer_id AND a.status='active' AND a.verified_at>0 AND r.role='admin')
    THEN RAISE(ABORT,'REPORT_ADMIN_REQUIRED') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM report_current_policy WHERE id=NEW.decision_policy_id)
    THEN RAISE(ABORT,'REPORT_IMPACT_CHANGED') END;
  SELECT CASE WHEN NEW.affected_id<>CASE WHEN NEW.status='upheld' THEN OLD.target_id ELSE OLD.reporter_id END
    OR NOT EXISTS(SELECT 1 FROM account_reputations WHERE account_id=NEW.affected_id
      AND revision=NEW.score_revision AND score=NEW.score_before)
    THEN RAISE(ABORT,'REPORT_IMPACT_CHANGED') END;
  SELECT CASE WHEN NEW.status='upheld' AND EXISTS(SELECT 1 FROM report_pairs
      WHERE reporter_id=OLD.reporter_id AND target_id=OLD.target_id AND (locked_at>0 OR success_count>=success_limit))
    THEN RAISE(ABORT,'REPORT_PAIR_LOCKED') END;
  SELECT CASE WHEN NEW.nominal_penalty<>CASE WHEN NEW.status='upheld'
      THEN (SELECT json_extract(policy,'$.upheldPenalty') FROM report_current_policy)
      ELSE (SELECT json_extract(b.value,'$.points') FROM report_current_policy p,json_each(p.policy,'$.failureBands') b
        WHERE json_extract(b.value,'$.through') IS NULL OR json_extract(b.value,'$.through')>=(
          SELECT count(*)+1 FROM reports WHERE reporter_id=OLD.reporter_id AND status='rejected'
            AND decided_at>NEW.decided_at-json_extract(p.policy,'$.failureWindowSeconds')*1000 AND decided_at<=NEW.decided_at)
        ORDER BY CAST(b.key AS INTEGER) LIMIT 1) END
    THEN RAISE(ABORT,'REPORT_IMPACT_CHANGED') END;
  SELECT CASE WHEN NEW.score_after<>MAX(
      MIN(NEW.score_before,(SELECT json_extract(policy,'$.minimumScore') FROM report_current_policy)),
      NEW.score_before-NEW.nominal_penalty)
    THEN RAISE(ABORT,'REPORT_IMPACT_CHANGED') END;
  SELECT CASE WHEN length(trim(NEW.review_reason))<1 OR length(NEW.review_reason)>(SELECT json_extract(policy,'$.reviewReasonMaxLength') FROM report_current_policy)
    THEN RAISE(ABORT,'REPORT_REVIEW_REASON_INVALID') END;
END;
CREATE TRIGGER reports_apply_decision AFTER UPDATE OF status ON reports
BEGIN
  UPDATE account_reputations SET report_revision=report_revision+1 WHERE account_id IN (NEW.reporter_id,NEW.target_id);
  UPDATE account_reputations SET score=NEW.score_after,deducted=deducted+NEW.score_before-NEW.score_after,
    event_count=event_count+1,revision=revision+1,updated_at=NEW.decided_at WHERE account_id=NEW.affected_id;
  UPDATE report_pairs SET success_count=success_count+1,
    locked_at=CASE WHEN success_count+1>=success_limit THEN NEW.decided_at ELSE locked_at END
    WHERE reporter_id=NEW.reporter_id AND target_id=NEW.target_id AND NEW.status='upheld';
END;

UPDATE settings SET value='30' WHERE key='app_schema_version';
