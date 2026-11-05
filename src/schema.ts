export class SchemaNotReadyError extends Error {
  readonly code = "SCHEMA_NOT_READY";
  constructor() { super("数据库尚未完成升级或暂时不可用，请稍后重试。"); }
}

const checks = new WeakMap<D1Database, { promise: Promise<void>; expiresAt: number }>();
const SUCCESS_TTL = 60_000;
const FAILURE_TTL = 1_000;

// Zero-row probes resolve the required table/column names without scanning user
// data. Schema changes are applied only by the ordered migration files.
const CORE_SCHEMA = `SELECT t.reported_at, t.report_reason, t.last_role, t.account_id,
  m.draw, i.image_key, a.session_version, s.revoked_at, o.operator_uid,
  j.image_key, audit.event, mail.payload_ciphertext
  FROM threads t
  LEFT JOIN messages m INDEXED BY idx_messages_thread_order ON 0
  LEFT JOIN message_images i ON 0
  LEFT JOIN accounts a ON 0
  LEFT JOIN account_sessions s ON 0
  LEFT JOIN operators o ON 0
  LEFT JOIN image_cleanup_jobs j ON 0
  LEFT JOIN account_admin_audit audit ON 0
  LEFT JOIN mail_deliveries mail ON 0
  WHERE 0`;

export function assertSchemaReady(database: D1Database): Promise<void> {
  const existing = checks.get(database);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;
  const entry = { promise: Promise.resolve(), expiresAt: Infinity };
  entry.promise = (async () => {
    try {
      const version = await database.prepare(
        `SELECT version.value FROM settings version
         LEFT JOIN (${CORE_SCHEMA}) required ON 0
         WHERE version.key = ?`,
      ).bind("app_schema_version").first<{ value: string }>();
      if (version?.value !== "25") throw new SchemaNotReadyError();
      entry.expiresAt = Date.now() + SUCCESS_TTL;
    } catch {
      entry.expiresAt = Date.now() + FAILURE_TTL;
      console.log(JSON.stringify({ event: "schema_not_ready" }));
      throw new SchemaNotReadyError();
    }
  })();
  checks.set(database, entry);
  return entry.promise;
}
