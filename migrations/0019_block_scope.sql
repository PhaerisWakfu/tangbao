ALTER TABLE blocks RENAME TO blocks_old;

CREATE TABLE blocks (
  id TEXT NOT NULL,
  operator_id TEXT NOT NULL DEFAULT '*',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, operator_id)
);

-- Put each existing identity under the model whose conversation was closest
-- to the moment it was blocked. Home blocks become global.
INSERT OR IGNORE INTO blocks (id, operator_id, created_at)
SELECT
  b.id,
  COALESCE(
    (
      SELECT CASE
        WHEN t.operator_id = 'tangbao-vme50-flash' THEN '*'
        ELSE t.operator_id
      END
      FROM threads t
      WHERE t.token_hash = b.id OR t.visitor_hash = b.id OR t.ip_hash = b.id
      ORDER BY ABS(t.updated_at - b.created_at) ASC, t.updated_at DESC
      LIMIT 1
    ),
    '__drop__'
  ),
  b.created_at
FROM blocks_old b;

-- Orphaned rows cannot be attributed to a model. Do not keep them as a
-- site-wide block, because that would keep blocking unrelated visitors.
DELETE FROM blocks WHERE operator_id = '__drop__';

DROP TABLE blocks_old;

CREATE INDEX IF NOT EXISTS idx_blocks_scope
ON blocks (operator_id, id);
