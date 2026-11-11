-- Preserve adjudicated amounts; new reports carry the selected policy label.
ALTER TABLE reports ADD COLUMN type_code TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE reports ADD COLUMN type_label TEXT NOT NULL DEFAULT '未分类';

INSERT INTO report_policy_versions(id,policy,previous_id,created_at,reason)
  SELECT 'reports-types-v1',json_remove(json_set(policy,'$.reportTypes',json('[{"code":"sexual","label":"色情低俗"},{"code":"politics","label":"涉政内容"},{"code":"harassment","label":"辱骂骚扰"},{"code":"provocation","label":"引战挑衅"},{"code":"hate","label":"仇恨歧视"},{"code":"violence","label":"暴力威胁"},{"code":"spam_scam","label":"广告诈骗"},{"code":"privacy","label":"泄露隐私"},{"code":"other","label":"其他"}]')),'$.reasonMinLength','$.reasonMaxLength'),
    id,CAST(strftime('%s','now') AS INTEGER)*1000,'增加举报类型，举报原因改为选填'
  FROM report_current_policy;
UPDATE report_policy_active SET version_id='reports-types-v1',revision=revision+1 WHERE singleton=1;

DROP TRIGGER reports_validate_insert;
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
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM report_current_policy p,json_each(p.policy,'$.reportTypes') t
      WHERE json_extract(t.value,'$.code')=NEW.type_code AND json_extract(t.value,'$.label')=NEW.type_label)
    THEN RAISE(ABORT,'REPORT_TYPE_INVALID') END;
END;

DROP TRIGGER reports_immutable;
CREATE TRIGGER reports_immutable BEFORE UPDATE ON reports
WHEN NEW.id IS NOT OLD.id OR NEW.reporter_id IS NOT OLD.reporter_id OR NEW.target_id IS NOT OLD.target_id
  OR NEW.thread_id IS NOT OLD.thread_id OR NEW.message_id IS NOT OLD.message_id OR NEW.reporter_role IS NOT OLD.reporter_role
  OR NEW.model_uid IS NOT OLD.model_uid OR NEW.target_label IS NOT OLD.target_label OR NEW.thread_title IS NOT OLD.thread_title OR NEW.snapshot IS NOT OLD.snapshot
  OR NEW.reason IS NOT OLD.reason OR NEW.request_key IS NOT OLD.request_key OR NEW.fingerprint IS NOT OLD.fingerprint
  OR NEW.created_at IS NOT OLD.created_at OR NEW.creation_policy_id IS NOT OLD.creation_policy_id
  OR NEW.type_code IS NOT OLD.type_code OR NEW.type_label IS NOT OLD.type_label
  OR OLD.status<>'pending'
BEGIN SELECT RAISE(ABORT,'REPORT_IMMUTABLE'); END;

UPDATE settings SET value='31' WHERE key='app_schema_version';
