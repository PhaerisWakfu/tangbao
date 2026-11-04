-- Read-only, compatible with the 0020 source and the upgraded schema.
-- Save output privately: image keys/IDs refer to user data.
-- Includes older messages.image_key values missing from message_images.
SELECT 'message_images' AS source, i.id AS image_id, i.message_id,
       m.thread_id, i.image_key, i.image_type, i.position
FROM message_images i LEFT JOIN messages m ON m.id=i.message_id
UNION ALL
SELECT 'messages.legacy', NULL, m.id, m.thread_id, m.image_key, m.image_type, 0
FROM messages m
WHERE m.image_key IS NOT NULL AND m.image_key<>''
  AND NOT EXISTS (
    SELECT 1 FROM message_images i WHERE i.message_id=m.id AND i.image_key=m.image_key
  );
