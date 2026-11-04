type ImageCleanupEnv = {
  DB: D1Database;
  IMAGES: KVNamespace;
};

const CLEANUP_BATCH_SIZE = 20;
const RETRY_DELAY = 60_000;
const MAX_RETRY_DELAY = 60 * RETRY_DELAY;

// KV deletion is idempotent: if acknowledgement fails after deletion, retrying
// the durable job is safe. Concurrent drains can also delete the same key.
export async function processImageCleanup(env: ImageCleanupEnv, threadId?: string): Promise<void> {
  const now = Date.now();
  const query = env.DB.prepare(
    `SELECT image_key, attempts FROM image_cleanup_jobs
     WHERE next_attempt_at <= ?${threadId ? " AND thread_id = ?" : ""}
     ORDER BY next_attempt_at, created_at LIMIT ?`,
  );
  const jobs = await (threadId
    ? query.bind(now, threadId, CLEANUP_BATCH_SIZE)
    : query.bind(now, CLEANUP_BATCH_SIZE)
  ).all<{ image_key: string; attempts: number }>();

  for (const job of jobs.results) {
    try {
      await env.IMAGES.delete(job.image_key);
      await env.DB.prepare("DELETE FROM image_cleanup_jobs WHERE image_key = ?").bind(job.image_key).run();
    } catch {
      const delay = Math.min(MAX_RETRY_DELAY, RETRY_DELAY * 2 ** Math.min(job.attempts, 6));
      await env.DB.prepare(
        "UPDATE image_cleanup_jobs SET attempts = attempts + 1, next_attempt_at = ? WHERE image_key = ?",
      ).bind(Date.now() + delay, job.image_key).run();
      console.log(JSON.stringify({ event: "image_cleanup_retry", attempt: job.attempts + 1 }));
    }
  }
}
