UPDATE threads
SET awaiting = 0
WHERE awaiting = 1
  AND EXISTS (
    SELECT 1
    FROM blocks b
    WHERE b.id IN (threads.token_hash, threads.visitor_hash, threads.ip_hash)
      AND (b.operator_id = threads.operator_id OR b.operator_id = '*')
  );
