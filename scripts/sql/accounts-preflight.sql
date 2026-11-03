-- Read-only. Run against the confirmed source DB before export/migration.
-- Expected source baseline for this release: 0001 through 0020, in order.
SELECT name FROM d1_migrations ORDER BY name;

SELECT 'threads' AS entity, COUNT(*) AS records FROM threads;
SELECT 'messages' AS entity, COUNT(*) AS records FROM messages;
SELECT 'message_images' AS entity, COUNT(*) AS records FROM message_images;
SELECT 'operators' AS entity, COUNT(*) AS records FROM operators;
SELECT 'applications' AS entity, COUNT(*) AS records FROM applications;
SELECT 'blocks' AS entity, COUNT(*) AS records FROM blocks;
SELECT 'push_subscriptions' AS entity, COUNT(*) AS records FROM push_subscriptions;

-- Investigate nonzero results; do not delete historical rows to hide them.
SELECT COUNT(*) AS messages_without_thread
FROM messages m LEFT JOIN threads t ON t.id=m.thread_id WHERE t.id IS NULL;
SELECT COUNT(*) AS image_records_without_message
FROM message_images i LEFT JOIN messages m ON m.id=i.message_id WHERE m.id IS NULL;
SELECT COUNT(*) AS shared_legacy_password_groups
FROM (SELECT 1 FROM operators GROUP BY password_hash HAVING COUNT(*)>1);

-- These are references only. KV bytes must be checked separately.
SELECT COUNT(*) AS current_image_references, COUNT(DISTINCT image_key) AS current_image_keys
FROM message_images;
SELECT COUNT(*) AS legacy_image_references
FROM messages WHERE image_key IS NOT NULL AND image_key<>'';
