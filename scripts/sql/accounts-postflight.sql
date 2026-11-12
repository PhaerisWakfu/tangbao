-- Read-only. Run only AFTER all migrations in the selected release have completed.
SELECT name FROM d1_migrations ORDER BY name;

SELECT 'threads' AS entity, COUNT(*) AS records FROM threads;
SELECT 'messages' AS entity, COUNT(*) AS records FROM messages;
SELECT 'message_images' AS entity, COUNT(*) AS records FROM message_images;
SELECT 'operators' AS entity, COUNT(*) AS records FROM operators;
SELECT 'applications' AS entity, COUNT(*) AS records FROM applications;
SELECT 'blocks' AS entity, COUNT(*) AS records FROM blocks;
SELECT 'push_subscriptions' AS entity, COUNT(*) AS records FROM push_subscriptions;

-- The next four counts must be zero.
SELECT COUNT(*) AS invalid_model_uids FROM operators
WHERE operator_uid IS NULL OR length(operator_uid)<>32;
SELECT COUNT(*) AS duplicate_uid_groups
FROM (SELECT 1 FROM operators GROUP BY operator_uid HAVING COUNT(*)>1);
SELECT COUNT(*) AS owners_without_account
FROM operators o LEFT JOIN accounts a ON a.id=o.owner_account_id
WHERE o.owner_account_id IS NOT NULL AND a.id IS NULL;
SELECT COUNT(*) AS owners_without_operator_role FROM operators o
WHERE o.owner_account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM account_roles r WHERE r.account_id=o.owner_account_id AND r.role='operator'
);
PRAGMA foreign_key_check;

-- After 0027, count only; never include retained credential values in reports.
SELECT COUNT(*) AS legacy_credential_copies FROM applications WHERE pass_note IS NOT NULL;

-- Zero administrators is normal just after migration. Before public opening,
-- at least one verified active administrator must have been bootstrapped.
SELECT COUNT(*) AS verified_active_administrators
FROM accounts a JOIN account_roles r ON r.account_id=a.id AND r.role='admin'
WHERE a.verified_at>0 AND a.status='active';
SELECT COUNT(*) AS unclaimed_legacy_models FROM operators WHERE owner_account_id IS NULL;
SELECT status, COUNT(*) AS tasks FROM mail_deliveries GROUP BY status;
