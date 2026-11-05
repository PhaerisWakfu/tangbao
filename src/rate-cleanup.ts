// Rate windows are temporary counters, not audit records. Delete a bounded
// batch per cron; recheck expiry in the write so a renewed window survives.
export async function processRateCleanup(env: { DB: D1Database }, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM rate_buckets WHERE id IN (
      SELECT id FROM rate_buckets WHERE reset_at<=? ORDER BY reset_at LIMIT 500
    ) AND reset_at<=?`).bind(now, now),
    env.DB.prepare(`DELETE FROM auth_rate_buckets WHERE id IN (
      SELECT id FROM auth_rate_buckets WHERE reset_at<=? ORDER BY reset_at LIMIT 500
    ) AND reset_at<=?`).bind(now, now),
  ]);
}
