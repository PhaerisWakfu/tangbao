export type MailEnv = {
  DB: D1Database;
  MAIL_MODE?: string;
  MAIL_FROM?: string;
  APP_ORIGIN?: string;
  EMAIL_CODE_PEPPER?: string;
  MAIL_PAYLOAD_KEY?: string;
  MAIL_DAILY_LIMIT?: string;
  MAIL_PROVIDERS?: string;
  CLOUDFLARE_DAILY_LIMIT?: string;
  BREVO_DAILY_LIMIT?: string;
  BREVO_API_KEY?: string;
  BREVO_FROM?: string;
  AUTH_TEST_NOW?: string;
  MAIL_TEST_FAILURE?: string;
  EMAIL?: { send(message: { to: string; from: string | { email: string; name?: string }; subject: string; text: string; headers?: Record<string, string> }): Promise<{ messageId: string }> };
};

export class MailError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const encoder = new TextEncoder();
const CODE_TTL = 10 * 60_000;
const MAIL_BLOCK_PREFIX = "mail_blocked_until:";
const MAIL_BREAKER_MS = 5 * 60_000;
const MAIL_WARN_AT = 180;
type MailProvider = "cloudflare" | "brevo";
export type MailPurpose = "verify" | "reset";
type Payload = { email: string; code: string; purpose: MailPurpose };

function localTest(env: MailEnv): boolean {
  if (env.MAIL_MODE !== "test" || !env.APP_ORIGIN) return false;
  try {
    const host = new URL(env.APP_ORIGIN).hostname;
    return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch { return false; }
}

export function authNow(env: MailEnv): number {
  if (localTest(env) && env.AUTH_TEST_NOW) {
    const value = Number(env.AUTH_TEST_NOW);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return Date.now();
}

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return b64url(data);
}

export function b64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
}

export async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function secret(value: string | undefined): string {
  if (!value || value.length < 32) throw new MailError(503, "MAIL_NOT_CONFIGURED", "邮箱服务尚未配置，请稍后再试。");
  return value;
}

export async function emailCodeHash(env: MailEnv, id: string, email: string, purpose: MailPurpose, code: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret(env.EMAIL_CODE_PEPPER)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify([id, email, purpose, code])))));
}

export async function encryptPayload(env: MailEnv, plaintext: string, context: string): Promise<string> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`tangbao-payload-v1:${secret(env.MAIL_PAYLOAD_KEY)}`));
  const key = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(context) }, key, encoder.encode(plaintext));
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(data))}`;
}

export async function decryptPayload(env: MailEnv, ciphertext: string, context: string): Promise<string> {
  const [version, iv, body] = ciphertext.split(".");
  if (version !== "v1" || !iv || !body) throw new Error("Invalid encrypted payload");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`tangbao-payload-v1:${secret(env.MAIL_PAYLOAD_KEY)}`));
  const key = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["decrypt"]);
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv), additionalData: encoder.encode(context) }, key, fromB64url(body));
  return new TextDecoder().decode(data);
}

function dailyLimit(env: MailEnv): number {
  const value = env.MAIL_DAILY_LIMIT === undefined ? 460 : Number(env.MAIL_DAILY_LIMIT);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new MailError(503, "MAIL_NOT_CONFIGURED", "邮箱服务尚未配置，请稍后再试。");
  return value;
}

function providerLimit(env: MailEnv, provider: MailProvider): number {
  const raw = provider === "brevo" ? env.BREVO_DAILY_LIMIT : env.CLOUDFLARE_DAILY_LIMIT;
  const value = raw === undefined ? (provider === "brevo" ? 280 : 190) : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new MailError(503, "MAIL_NOT_CONFIGURED", "邮箱服务尚未配置，请稍后再试。");
  return value;
}

function mailProviders(env: MailEnv): MailProvider[] {
  if (env.MAIL_MODE === "test") return ["cloudflare"];
  const configured = (env.MAIL_PROVIDERS || "cloudflare")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is MailProvider => item === "cloudflare" || item === "brevo");
  const available = configured.filter((provider) => provider === "cloudflare" || Boolean(env.BREVO_API_KEY));
  return available.length ? [...new Set(available)] : ["cloudflare"];
}

function breakerKey(provider: MailProvider): string {
  return `${MAIL_BLOCK_PREFIX}${provider}`;
}

/** All guards, revocation and budget reservations run in one D1/Turso write batch. */
export async function createMailChallenge(env: MailEnv, account: { id: string; email: string }, purpose: MailPurpose): Promise<{ challengeId: string; mailStatus: string }> {
  if (env.MAIL_MODE !== "test" && env.MAIL_MODE !== "cloudflare") throw new MailError(503, "MAIL_DISABLED", "暂时无法发送验证邮件，请稍后重试。");
  if (env.MAIL_MODE === "test" && !localTest(env)) throw new MailError(503, "MAIL_NOT_CONFIGURED", "邮箱服务尚未配置，请稍后再试。");
  if (env.MAIL_MODE === "cloudflare" && !env.EMAIL) throw new MailError(503, "MAIL_NOT_CONFIGURED", "邮箱服务尚未配置，请稍后再试。");
  const now = authNow(env);
  const day = new Date(now).toISOString().slice(0, 10);
  const id = randomToken(24);
  // Rejection sampling avoids modulo bias for the six-digit challenge.
  const numbers = new Uint32Array(1);
  do { crypto.getRandomValues(numbers); } while (numbers[0] >= 4_294_000_000);
  const code = String(numbers[0] % 1_000_000).padStart(6, "0");
  const hash = await emailCodeHash(env, id, account.email, purpose, code);
  const ciphertext = await encryptPayload(env, JSON.stringify({ email: account.email, code, purpose }), `mail:${id}`);
  const exists = "EXISTS (SELECT 1 FROM email_challenges WHERE id = ?)";
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO email_challenges (id, account_id, email, purpose, code_hmac, expires_at, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND email = ? AND status = 'active' ${purpose === "verify" ? "AND verified_at = 0" : ""})
        AND NOT EXISTS (SELECT 1 FROM email_challenge_limits WHERE subject = ? AND next_send_at > ?)
        AND (SELECT COUNT(*) FROM email_challenges WHERE email = ? AND created_at > ?) < 5
        AND COALESCE((SELECT used FROM mail_budgets WHERE period = ?), 0) < ?`)
      .bind(id, account.id, account.email, purpose, hash, now + CODE_TTL, now, account.id, account.email, account.email, now, account.email, now - 3_600_000, day, dailyLimit(env)),
    env.DB.prepare(`UPDATE email_challenges SET revoked_at = ? WHERE account_id = ? AND purpose = ? AND id != ? AND revoked_at = 0 AND consumed_at = 0 AND ${exists}`)
      .bind(now, account.id, purpose, id, id),
    env.DB.prepare(`UPDATE mail_deliveries SET status = 'cancelled', payload_ciphertext = NULL, updated_at = ? WHERE challenge_id IN (SELECT id FROM email_challenges WHERE account_id = ? AND purpose = ? AND revoked_at = ?) AND ${exists}`)
      .bind(now, account.id, purpose, now, id),
    env.DB.prepare(`INSERT INTO email_challenge_limits (subject, next_send_at) SELECT ?, ? WHERE ${exists}
      ON CONFLICT(subject) DO UPDATE SET next_send_at = excluded.next_send_at`).bind(account.email, now + 60_000, id),
    env.DB.prepare(`INSERT INTO mail_budgets (period, used) SELECT ?, 1 WHERE ${exists}
      ON CONFLICT(period) DO UPDATE SET used = mail_budgets.used + 1`).bind(day, id),
    env.DB.prepare(`INSERT INTO mail_deliveries (id, challenge_id, payload_ciphertext, status, created_at, updated_at, expires_at)
      SELECT ?, ?, ?, 'queued', ?, ?, ? WHERE ${exists}`).bind(id, id, ciphertext, now, now, now + CODE_TTL, id),
  ]);
  if (results[0].meta.changes !== 1) {
    const budget = await env.DB.prepare("SELECT used FROM mail_budgets WHERE period = ?").bind(day).first<{ used: number }>();
    if ((budget?.used || 0) >= dailyLimit(env)) throw new MailError(429, "MAIL_BUDGET_EXHAUSTED", "今日邮件发送额度已满，请稍后再试。");
    throw new MailError(429, "EMAIL_COOLDOWN", "邮件发送较频繁，请稍后再试。");
  }
  try {
    const budget = await env.DB.prepare("SELECT used FROM mail_budgets WHERE period = ?").bind(day).first<{ used: number }>();
    if ((budget?.used || 0) >= MAIL_WARN_AT) {
      const warningKey = `mail_budget_warned:${day}`;
      const warned = await env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)").bind(warningKey, String(budget?.used || 0)).run();
      if (warned.meta.changes === 1) {
        console.log(JSON.stringify({ event: "mail_budget_warning", period: day, used: budget?.used || 0, limit: dailyLimit(env) }));
      }
    }
  } catch {}
  return { challengeId: id, mailStatus: "queued" };
}

type Delivery = { id: string; challenge_id: string; payload_ciphertext: string; attempts: number; expires_at: number };

function parseSender(from: string): string | { email: string; name?: string } {
  const named = from.match(/^([^<>\r\n]+)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (named) return { name: named[1].trim(), email: named[2] };
  if (/^[^<>\s]+@[^<>\s]+$/.test(from)) return from;
  throw new MailError(503, "MAIL_NOT_CONFIGURED", "邮箱服务尚未配置，请稍后再试。");
}

function sender(env: MailEnv): string | { email: string; name?: string } {
  return parseSender(env.MAIL_FROM || "noreply@mail.phaeris.cn");
}

function brevoSender(env: MailEnv): string | { email: string; name?: string } {
  return parseSender(env.BREVO_FROM || "糖包 <noreply@send.phaeris.cn>");
}

function mailText(payload: Payload): { subject: string; text: string } {
  const purpose = payload.purpose === "verify" ? "验证邮箱" : "重置密码";
  return {
    subject: `糖包 · ${purpose}`,
    text: `你正在糖包${purpose}。\n\n验证码：${payload.code}\n\n验证码在10分钟内有效，只能使用一次。请勿将验证码转发给他人。\n如果不是你本人操作，可忽略本邮件。\n\n糖包是由人回复的对话站。`,
  };
}

export function mailSenderDomain(env: MailEnv): string {
  const from = sender(env);
  const address = typeof from === "string" ? from : from.email;
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new MailError(503, "MAIL_NOT_CONFIGURED", "邮箱服务尚未配置。");
  return domain;
}

async function reserveProviderBudget(env: MailEnv, provider: MailProvider, day: string): Promise<boolean> {
  const limit = providerLimit(env, provider);
  const result = await env.DB.prepare(`INSERT INTO mail_provider_budgets(provider, period, used)
    VALUES(?, ?, 1)
    ON CONFLICT(provider, period) DO UPDATE SET used = used + 1 WHERE used < ?`)
    .bind(provider, day, limit).run();
  return result.meta.changes === 1;
}

async function releaseProviderBudget(env: MailEnv, provider: MailProvider, day: string): Promise<void> {
  await env.DB.prepare("UPDATE mail_provider_budgets SET used = CASE WHEN used > 0 THEN used - 1 ELSE 0 END WHERE provider = ? AND period = ?")
    .bind(provider, day).run();
}

async function openProviderBreaker(env: MailEnv, provider: MailProvider, now: number): Promise<void> {
  const until = now + MAIL_BREAKER_MS;
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(breakerKey(provider), String(until)).run();
  console.log(JSON.stringify({ event: "mail_provider_breaker", provider, until }));
}

async function providerBlocked(env: MailEnv, provider: MailProvider, now: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT CAST(value AS INTEGER) AS until FROM settings WHERE key = ?")
    .bind(breakerKey(provider)).first<{ until: number }>();
  return (row?.until || 0) > now;
}

function providerError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

async function sendWithProvider(env: MailEnv, provider: MailProvider, payload: Payload, challengeId: string): Promise<string | null> {
  if (env.MAIL_MODE === "test") {
    if (localTest(env) && env.MAIL_TEST_FAILURE) {
      throw providerError(env.MAIL_TEST_FAILURE === "rate_limit"
        ? "E_RATE_LIMIT_EXCEEDED"
        : env.MAIL_TEST_FAILURE === "permanent" ? "E_SENDER_NOT_VERIFIED" : "NETWORK_UNKNOWN", "Injected mail failure");
    }
    return null;
  }
  const { subject, text } = mailText(payload);
  if (provider === "cloudflare") {
    if (!env.EMAIL) throw new MailError(503, "MAIL_NOT_CONFIGURED", "邮箱服务尚未配置。");
    const response = await env.EMAIL.send({
      to: payload.email,
      from: sender(env),
      subject,
      text,
      headers: { "X-Tangbao-Challenge": challengeId },
    });
    return response.messageId;
  }
  if (!env.BREVO_API_KEY) throw new MailError(503, "MAIL_NOT_CONFIGURED", "Brevo 尚未配置。");
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      sender: brevoSender(env),
      to: [{ email: payload.email }],
      subject,
      textContent: text,
      headers: { "X-Tangbao-Challenge": challengeId },
    }),
  });
  const raw = await response.text();
  let data: { messageId?: string; code?: string; message?: string } = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) {
    const message = data.message || raw || `Brevo ${response.status}`;
    if (response.status === 429 && !/daily|quota|limit/i.test(message)) throw providerError("E_RATE_LIMIT_EXCEEDED", message);
    if (/daily|quota|limit/i.test(message)) throw providerError("E_DAILY_LIMIT_EXCEEDED", message);
    if (response.status >= 500) throw providerError("NETWORK_UNKNOWN", message);
    throw providerError("E_VALIDATION_ERROR", message);
  }
  return data.messageId || `brevo:${challengeId}`;
}

/** A provider timeout may already have sent mail: unknown tasks are never auto-retried. */
export async function processMailOutbox(env: MailEnv): Promise<void> {
  const now = authNow(env);
  const day = new Date(now).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare("UPDATE mail_deliveries SET status = 'expired', payload_ciphertext = NULL, updated_at = ? WHERE expires_at <= ? AND payload_ciphertext IS NOT NULL").bind(now, now),
    env.DB.prepare("UPDATE mail_deliveries SET status = 'unknown', payload_ciphertext = NULL, last_error = 'INTERRUPTED', updated_at = ? WHERE status = 'sending' AND updated_at < ?").bind(now, now - 120_000),
  ]);
  if (env.MAIL_MODE !== "cloudflare" && !localTest(env)) return;
  const pending = await env.DB.prepare(`SELECT id, challenge_id, payload_ciphertext, attempts, expires_at FROM mail_deliveries
    WHERE status IN ('queued', 'retry') AND next_attempt_at <= ? AND expires_at > ? AND attempts < 3
      AND EXISTS (SELECT 1 FROM email_challenges c WHERE c.id = challenge_id AND c.consumed_at = 0 AND c.revoked_at = 0)
    ORDER BY created_at LIMIT 10`).bind(now, now).all<Delivery>();
  const providers = mailProviders(env);
  for (const item of pending.results) {
    const claimed = await env.DB.prepare(`UPDATE mail_deliveries SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('queued', 'retry') AND next_attempt_at <= ?
      AND EXISTS (SELECT 1 FROM email_challenges c WHERE c.id = challenge_id AND c.consumed_at = 0 AND c.revoked_at = 0)`)
      .bind(now, item.id, now).run();
    if (claimed.meta.changes !== 1) continue;
    let payload: Payload;
    try {
      payload = JSON.parse(await decryptPayload(env, item.payload_ciphertext, `mail:${item.challenge_id}`)) as Payload;
    } catch {
      await env.DB.prepare("UPDATE mail_deliveries SET status = 'failed', payload_ciphertext = NULL, last_error = 'PAYLOAD_INVALID', updated_at = ? WHERE id = ? AND status = 'sending'")
        .bind(authNow(env), item.id).run();
      continue;
    }
    let sent = false;
    let handled = false;
    for (const provider of providers) {
      if (await providerBlocked(env, provider, now)) continue;
      if (!(await reserveProviderBudget(env, provider, day))) continue;
      try {
        const providerId = await sendWithProvider(env, provider, payload, item.challenge_id);
        await env.DB.prepare(`UPDATE mail_deliveries SET status = CASE
            WHEN EXISTS (SELECT 1 FROM mail_events WHERE provider_id = ? AND type = 'complained') THEN 'complained'
            WHEN EXISTS (SELECT 1 FROM mail_events WHERE provider_id = ? AND type = 'bounced') THEN 'bounced'
            WHEN EXISTS (SELECT 1 FROM mail_events WHERE provider_id = ? AND type = 'failed') THEN 'failed'
            WHEN EXISTS (SELECT 1 FROM mail_events WHERE provider_id = ? AND type = 'delivered') THEN 'delivered'
            ELSE ? END,
          provider_id = ?, mail_provider = ?, payload_ciphertext = CASE WHEN ? = 'test' THEN payload_ciphertext ELSE NULL END, updated_at = ?, last_error = NULL
          WHERE id = ? AND status = 'sending'`)
          .bind(providerId, providerId, providerId, providerId, env.MAIL_MODE === "test" ? "test" : "accepted", providerId, provider, env.MAIL_MODE, authNow(env), item.id).run();
        sent = true;
        break;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "NETWORK_UNKNOWN";
        if (code === "E_DAILY_LIMIT_EXCEEDED") {
          await openProviderBreaker(env, provider, now);
          await releaseProviderBudget(env, provider, day);
          continue;
        }
        const rateLimited = code === "E_RATE_LIMIT_EXCEEDED" || code === "RATE_LIMIT_EXCEEDED" || code === "RATE_LIMITED" || code === "429";
        const permanent = ["E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS", "E_TOO_MANY_ATTACHMENTS", "E_SENDER_NOT_VERIFIED", "E_RECIPIENT_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED", "E_ACCOUNT_SUSPENDED", "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_CONTENT_TOO_LARGE", "E_DELIVERY_FAILED", "E_DAILY_LIMIT_EXCEEDED", "E_HEADER_NOT_ALLOWED", "E_HEADER_USE_API_FIELD", "E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG", "E_HEADER_NAME_INVALID", "E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY", "MAIL_NOT_CONFIGURED"].includes(code);
        const retry = rateLimited && item.attempts + 1 < 3;
        const status = retry ? "retry" : rateLimited || permanent ? "failed" : "unknown";
        await env.DB.prepare("UPDATE mail_deliveries SET status = ?, next_attempt_at = ?, last_error = ?, mail_provider = ?, payload_ciphertext = CASE WHEN ? = 'retry' THEN payload_ciphertext ELSE NULL END, updated_at = ? WHERE id = ? AND status = 'sending'")
          .bind(status, now + 60_000 * 2 ** item.attempts, code.slice(0, 64), provider, status, authNow(env), item.id).run();
        handled = true;
        break;
      }
    }
    if (!sent && !handled) {
      const retry = item.attempts + 1 < 3 && now + MAIL_BREAKER_MS < item.expires_at;
      const status = retry ? "retry" : "failed";
      await env.DB.prepare("UPDATE mail_deliveries SET status = ?, next_attempt_at = ?, last_error = 'ALL_PROVIDERS_BUSY', payload_ciphertext = CASE WHEN ? = 'retry' THEN payload_ciphertext ELSE NULL END, updated_at = ? WHERE id = ? AND status = 'sending'")
        .bind(status, now + MAIL_BREAKER_MS, status, authNow(env), item.id).run();
    }
  }
}

export async function clearChallengePayload(env: MailEnv, challengeId: string): Promise<void> {
  await env.DB.prepare("UPDATE mail_deliveries SET payload_ciphertext = NULL WHERE challenge_id = ?").bind(challengeId).run();
}

export type TestMail = { challengeId: string; email: string; purpose: MailPurpose; code: string; status: string; expiresAt: number; attempts: number; lastError: string | null };
export async function readTestMail(env: MailEnv, challengeId?: string): Promise<TestMail[]> {
  if (!localTest(env)) throw new Error("Synthetic mail reader is restricted to local test mode");
  const rows = await env.DB.prepare(`SELECT challenge_id, payload_ciphertext, status, expires_at, attempts, last_error FROM mail_deliveries
    WHERE payload_ciphertext IS NOT NULL ${challengeId ? "AND challenge_id = ?" : ""} ORDER BY created_at DESC LIMIT 20`)
    .bind(...(challengeId ? [challengeId] : [])).all<{ challenge_id: string; payload_ciphertext: string; status: string; expires_at: number; attempts: number; last_error: string | null }>();
  const result: TestMail[] = [];
  for (const row of rows.results) {
    const payload = JSON.parse(await decryptPayload(env, row.payload_ciphertext, `mail:${row.challenge_id}`)) as Payload;
    result.push({ challengeId: row.challenge_id, ...payload, status: row.status, expiresAt: row.expires_at, attempts: row.attempts, lastError: row.last_error });
  }
  return result;
}

/** Invoke only from the platform's trusted Queue consumer, never from a public webhook. */
export type MailEventType = "delivered" | "bounced" | "complained" | "failed";
export async function processMailEvent(env: MailEnv, event: { id: string; messageId: string; type: MailEventType; timestamp: number }): Promise<void> {
  if (!event.id || !event.messageId || !["delivered", "bounced", "complained", "failed"].includes(event.type) || !Number.isSafeInteger(event.timestamp) || event.timestamp <= 0) return;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO mail_events (id, provider_id, type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").bind(event.id, event.messageId, event.type, event.timestamp),
    env.DB.prepare(`UPDATE mail_deliveries SET status = ?, updated_at = ? WHERE provider_id = ?
      AND (status NOT IN ('complained', 'bounced', 'failed')
        OR (status = 'bounced' AND ? = 'complained')
        OR (status = 'failed' AND ? IN ('bounced', 'complained')))
      AND EXISTS (SELECT 1 FROM mail_events WHERE id = ? AND provider_id = ? AND type = ?)`)
      .bind(event.type, authNow(env), event.messageId, event.type, event.type, event.id, event.messageId, event.type),
  ]);
}
