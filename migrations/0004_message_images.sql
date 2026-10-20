CREATE TABLE message_images (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  image_key TEXT NOT NULL,
  image_type TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE INDEX idx_message_images_message ON message_images (message_id, position);

INSERT INTO message_images (id, message_id, image_key, image_type, position)
SELECT id, id, image_key, image_type, 0
FROM messages
WHERE image_key IS NOT NULL;
