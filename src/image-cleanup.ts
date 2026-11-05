type ImageCleanupEnv = {
  DB: D1Database;
  IMAGES: KVNamespace;
};

const CLEANUP_BATCH_SIZE = 20;
const RETRY_DELAY = 60_000;
const MAX_RETRY_DELAY = 60 * RETRY_DELAY;

// Only explicit SQL rejections prove rollback. Transport/time-out failures do
// not, even when a subsequent read cannot find the message yet.
export function isDefiniteDatabaseRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? error.name : "";
  const code = "code" in error ? error.code : "";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  if ((name === "LibsqlError" || name === "LibsqlBatchError") && typeof code === "string") {
    return /^SQLITE_(?:CONSTRAINT(?:_|$)|ERROR$)/.test(code);
  }
  return (name === "D1_ERROR" || message.startsWith("D1_ERROR:")) &&
    /(?:^|:\s*)SQLITE_(?:CONSTRAINT(?:_[A-Z_]+)?|ERROR)\b/.test(message);
}

export async function cleanupUncommittedImages(
  env: ImageCleanupEnv,
  threadId: string,
  images: readonly { id: string; key: string }[],
): Promise<void> {
  if (!images.length) return;
  const now = Date.now();
  try {
    // Call only before message submission or after an explicit DB rollback.
    // The primary-key check additionally protects any already-linked image.
    await env.DB.batch(images.map(image => env.DB.prepare(
      `INSERT INTO image_cleanup_jobs (image_key, thread_id, attempts, next_attempt_at, created_at)
       SELECT ?, ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM message_images WHERE id = ?)
       ON CONFLICT(image_key) DO NOTHING`,
    ).bind(image.key, threadId, now, now, image.id)));
    await processImageCleanup(env, threadId);
  } catch {
    // Preserve the original sending error. A successfully persisted job can
    // still be retried by Cron; a failed registration is not durable recovery.
    console.log(JSON.stringify({ event: "image_upload_cleanup_deferred" }));
  }
}

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
