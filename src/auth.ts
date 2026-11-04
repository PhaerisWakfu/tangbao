import { scrypt, timingSafeEqual } from "node:crypto";
import {
  MailError, authNow, b64url, clearChallengePayload, createMailChallenge, emailCodeHash,
  fromB64url, randomToken, sha256, type MailEnv, type MailPurpose,
} from "./email";

export { authNow, randomToken, sha256, encryptPayload, decryptPayload, processMailOutbox } from "./email";
export type AuthEnv = MailEnv;
export type Account = { id: string; email: string; verified: boolean; status: string; roles: string[]; operatorId: string | null };
export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const DAY = 86_400_000;
const SESSION_SECONDS = 400 * 24 * 60 * 60;
const RENEW_BEFORE = 365 * DAY;
const KDF = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
let kdfTail: Promise<unknown> = Promise.resolve();

function passwordInput(password: unknown): string {
  if (typeof password !== "string" || [...password].length < 1 || [...password].length > 128) {
    throw new AuthError(400, "PASSWORD_LENGTH", "请输入密码，最多128个字符，空格也会保留。");
  }
  return password;
}

export function validateNewPassword(password: unknown): string {
  if (typeof password !== "string" || [...password].length < 6 || [...password].length > 20) {
    throw new AuthError(400, "PASSWORD_LENGTH", "密码须为6至20个字符，空格也会保留。");
  }
  const categories = Number(/[A-Za-z]/.test(password)) + Number(/[0-9]/.test(password)) + Number(/[\p{P}\p{S}]/u.test(password));
  if (categories < 2) throw new AuthError(400, "PASSWORD_COMPLEXITY", "密码须包含数字、英文字母、特殊符号中的至少两类。");
  return password;
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  // Serialize per isolate so concurrent native scrypt calls cannot multiply the memory budget.
  const job = kdfTail.then(() => new Promise<Uint8Array>((resolve, reject) => {
    scrypt(password, salt, 32, KDF, (error, key) => error ? reject(error) : resolve(new Uint8Array(key)));
  }));
  kdfTail = job.catch(() => undefined);
  return job;
}

/** Native workerd scrypt. Creation routes validate the new policy; this KDF also supports legacy hashes. */
export async function hashPassword(password: string): Promise<string> {
  passwordInput(password);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const key = await derive(password, salt);
  return `scrypt$v1$32768$8$3$${b64url(salt)}$${b64url(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 7 || parts.slice(0, 5).join("$") !== "scrypt$v1$32768$8$3") return false;
  try {
    const salt = fromB64url(parts[5]);
    const expected = fromB64url(parts[6]);
    if (salt.length !== 32 || expected.length !== 32) return false;
    return timingSafeEqual(await derive(password, salt), expected);
  } catch { return false; }
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new AuthError(400, "EMAIL_INVALID", "请填写有效的邮箱地址。");
  const email = value.trim().toLowerCase();
  const parts = email.split("@");
  if (email.length > 254 || parts.length !== 2 || parts[0].length > 64 || !parts[0] ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(parts[0]) || parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..") ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(parts[1])) {
    throw new AuthError(400, "EMAIL_INVALID", "请填写有效的邮箱地址。");
  }
  // Keep dots and +tags: provider-specific aliasing must not merge different accounts.
  return email;
}

export function readCookie(request: Request, name: string): string {
  const cookies = request.headers.get("cookie") || "";
  for (const cookie of cookies.split(";")) {
    const split = cookie.indexOf("=");
    if (split > 0 && cookie.slice(0, split).trim() === name) return cookie.slice(split + 1).trim();
  }
  return "";
}

function cookie(request: Request, name: string, value: string, maxAge: number): string {
  return `${name}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

function reply(data: unknown, headers?: Headers): Response {
  const result = headers || new Headers();
  result.set("content-type", "application/json; charset=utf-8");
  result.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { headers: result });
}

function localHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function assertOrigin(request: Request, env: AuthEnv): void {
  const url = new URL(request.url);
  let expected: string;
  if (env.APP_ORIGIN) {
    try {
      const configured = new URL(env.APP_ORIGIN);
      if (configured.origin !== env.APP_ORIGIN.replace(/\/$/, "") || (configured.protocol !== "https:" && !localHost(configured.hostname))) throw new Error("Invalid app origin");
      expected = configured.origin;
    } catch { throw new AuthError(503, "AUTH_NOT_CONFIGURED", "账号服务尚未配置，请稍后重试。"); }
  } else if (localHost(url.hostname)) expected = url.origin;
  else throw new AuthError(503, "AUTH_NOT_CONFIGURED", "账号服务尚未配置，请稍后重试。");
  let origin = request.headers.get("origin");
  if (!origin || origin === "null") {
    try {
      const referer = request.headers.get("referer");
      origin = referer ? new URL(referer).origin : null;
    } catch {
      origin = null;
    }
  }
  if (origin !== expected) throw new AuthError(403, "ORIGIN_REJECTED", "请求来源不正确，请在本站重新操作。");
}

type AccountRow = { id: string; email: string; password_hash: string; verified_at: number; status: string; session_version: number };
async function accountById(env: AuthEnv, id: string): Promise<Account | null> {
  const row = await env.DB.prepare("SELECT id, email, verified_at, status FROM accounts WHERE id = ?").bind(id)
    .first<{ id: string; email: string; verified_at: number; status: string }>();
  if (!row) return null;
  const [roles, operator] = await Promise.all([
    env.DB.prepare("SELECT role FROM account_roles WHERE account_id = ? ORDER BY role").bind(id).all<{ role: string }>(),
    env.DB.prepare("SELECT id FROM operators WHERE owner_account_id = ?").bind(id).first<{ id: string }>(),
  ]);
  return { id: row.id, email: row.email, verified: row.verified_at > 0, status: row.status, roles: roles.results.map(item => item.role), operatorId: operator?.id || null };
}

export async function getAccount(request: Request, env: AuthEnv): Promise<Account | null> {
  const token = readCookie(request, "tb_account");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await env.DB.prepare(`SELECT a.id FROM account_sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.revoked_at = 0 AND s.expires_at > ?
      AND s.session_version = a.session_version AND a.status = 'active'`).bind(await sha256(token), authNow(env)).first<{ id: string }>();
  return row ? accountById(env, row.id) : null;
}

export async function requireAccount(request: Request, env: AuthEnv, verified = true): Promise<Account> {
  const account = await getAccount(request, env);
  if (!account) throw new AuthError(401, "AUTH_REQUIRED", "请先使用邮箱和密码登录。");
  if (verified && !account.verified) throw new AuthError(403, "EMAIL_UNVERIFIED", "请先验证邮箱，再继续操作。");
  return account;
}

/** Atomic UPSERT, including the reset-at boundary; do not replace with read-then-write. */
export async function consumeAuthRate(env: AuthEnv, id: string, limit: number, windowMs: number, amount = 1): Promise<void> {
  const now = authNow(env);
  const result = await env.DB.prepare(`INSERT INTO auth_rate_buckets (id, hits, reset_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      hits = CASE WHEN reset_at <= ? THEN excluded.hits ELSE hits + excluded.hits END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    WHERE reset_at <= ? OR hits + excluded.hits <= ?`).bind(id, amount, now + windowMs, now, now, now, limit).run();
  if (result.meta.changes !== 1) throw new AuthError(429, "AUTH_RATE_LIMITED", "操作较频繁，请稍后再试。");
}

async function requestRate(request: Request, env: AuthEnv, action: string, limit: number): Promise<void> {
  const ip = await sha256(request.headers.get("CF-Connecting-IP") || "local");
  await consumeAuthRate(env, `${action}:ip:${ip}`, limit, 3_600_000);
}
async function kdfRate(env: AuthEnv, email: string, amount = 1): Promise<void> {
  await consumeAuthRate(env, `kdf:email:${await sha256(email)}`, 20, 3_600_000, amount);
  await consumeAuthRate(env, "kdf:global", 60, 60_000, amount);
}

async function payload(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) throw new AuthError(415, "JSON_REQUIRED", "请求格式不正确，请重试。");
  const tooLarge = () => new AuthError(413, "REQUEST_TOO_LARGE", "提交内容过长，请检查后重试。");
  if (Number(request.headers.get("content-length") || "0") > 8192) throw tooLarge();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw tooLarge(); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    const result: unknown = JSON.parse(text || "{}");
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("shape");
    return result as Record<string, unknown>;
  } catch { throw new AuthError(400, "JSON_INVALID", "请求格式不正确，请重试。"); }
}

async function session(request: Request, env: AuthEnv, row: AccountRow): Promise<Headers> {
  const token = randomToken();
  const now = authNow(env);
  const inserted = await env.DB.prepare(`INSERT INTO account_sessions (token_hash, account_id, session_version, expires_at, created_at)
    SELECT ?, id, session_version, ?, ? FROM accounts WHERE id = ? AND status = 'active' AND session_version = ? AND password_hash = ?`)
    .bind(await sha256(token), now + SESSION_SECONDS * 1000, now, row.id, row.session_version, row.password_hash).run();
  if (inserted.meta.changes !== 1) throw new AuthError(409, "AUTH_CHANGED", "账号状态已变化，请重新登录。");
  const headers = new Headers();
  headers.append("set-cookie", cookie(request, "tb_account", token, SESSION_SECONDS));
  return headers;
}

async function register(request: Request, env: AuthEnv): Promise<Response> {
  await requestRate(request, env, "register", 15);
  const body = await payload(request);
  const email = normalizeEmail(body.email);
  const password = validateNewPassword(body.password);
  await kdfRate(env, email);
  const passwordHash = await hashPassword(password);
  const id = randomToken(18);
  const now = authNow(env);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, email, passwordHash, now, now),
      env.DB.prepare("INSERT INTO account_roles (account_id, role) VALUES (?, 'user')").bind(id),
    ]);
  } catch (error) {
    if (await env.DB.prepare("SELECT 1 AS found FROM accounts WHERE email = ?").bind(email).first()) {
      throw new AuthError(409, "ACCOUNT_UNAVAILABLE", "暂时无法完成注册，请尝试登录或找回密码。");
    }
    throw error;
  }
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<AccountRow>();
  if (!row) throw new Error("Account insert failed");
  const headers = await session(request, env, row);
  let mail: { challengeId: string | null; mailStatus: string; message?: string };
  try { mail = await createMailChallenge(env, { id, email }, "verify"); }
  catch (error) {
    if (!(error instanceof MailError)) throw error;
    mail = { challengeId: null, mailStatus: error.code === "MAIL_DISABLED" ? "disabled" : "unavailable", message: error.message };
  }
  return reply({ account: await accountById(env, id), ...mail }, headers);
}

async function login(request: Request, env: AuthEnv): Promise<Response> {
  await requestRate(request, env, "login", 40);
  const body = await payload(request);
  const email = normalizeEmail(body.email);
  const password = passwordInput(body.password);
  await kdfRate(env, email);
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE email = ?").bind(email).first<AccountRow>();
  // Nonexistent accounts pay the same KDF cost without storing a reusable dummy password.
  const stored = row?.password_hash || `scrypt$v1$32768$8$3$${b64url(new Uint8Array(32))}$${b64url(new Uint8Array(32))}`;
  const matches = await verifyPassword(password, stored);
  if (!row || !matches || row.status !== "active") throw new AuthError(401, "LOGIN_FAILED", "邮箱或密码不正确，或账号暂不可用。");
  return reply({ account: await accountById(env, row.id) }, await session(request, env, row));
}

function clearCookies(request: Request): Headers {
  const headers = new Headers();
  for (const name of ["tb_account", "tb_desk", "tb_guest"]) headers.append("set-cookie", cookie(request, name, "", 0));
  // Clear-Site-Data "cookies" reaches sibling subdomains. Delete only this host's cookies explicitly.
  if (new URL(request.url).protocol === "https:") headers.set("clear-site-data", '"cache", "storage"');
  return headers;
}

async function logout(request: Request, env: AuthEnv): Promise<Response> {
  const token = readCookie(request, "tb_account");
  if (token) await env.DB.prepare("UPDATE account_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at = 0").bind(authNow(env), await sha256(token)).run();
  return reply({ ok: true }, clearCookies(request));
}

type Challenge = { id: string; account_id: string; email: string; purpose: MailPurpose; code_hmac: string; expires_at: number; failed_attempts: number; consumed_at: number; revoked_at: number };
const VALID_CHALLENGE = "id = ? AND purpose = ? AND code_hmac = ? AND expires_at > ? AND failed_attempts < 5 AND consumed_at = 0 AND revoked_at = 0";

async function checkChallenge(env: AuthEnv, body: Record<string, unknown>, purpose: MailPurpose, accountId?: string): Promise<{ row: Challenge; digest: string }> {
  const id = typeof body.challengeId === "string" ? body.challengeId : "";
  const code = typeof body.code === "string" ? body.code.trim().slice(0, 64) : "";
  const row = await env.DB.prepare("SELECT * FROM email_challenges WHERE id = ? AND purpose = ?").bind(id, purpose).first<Challenge>();
  const now = authNow(env);
  if (!row || (accountId && row.account_id !== accountId) || row.revoked_at || row.consumed_at || row.expires_at <= now || row.failed_attempts >= 5) {
    throw new AuthError(400, "CODE_INVALID", "验证码无效、已使用或已过期，请重新获取。");
  }
  const digest = await emailCodeHash(env, row.id, row.email, purpose, code);
  if (!timingSafeEqual(fromB64url(digest), fromB64url(row.code_hmac))) {
    await env.DB.prepare("UPDATE email_challenges SET failed_attempts = failed_attempts + 1 WHERE id = ? AND failed_attempts < 5 AND expires_at > ? AND consumed_at = 0 AND revoked_at = 0")
      .bind(id, now).run();
    throw new AuthError(400, "CODE_INVALID", "验证码不正确或已失效，请检查后重试。");
  }
  return { row, digest };
}

async function verifyEmail(request: Request, env: AuthEnv): Promise<Response> {
  const account = await requireAccount(request, env, false);
  await requestRate(request, env, "verify", 60);
  const { row, digest } = await checkChallenge(env, await payload(request), "verify", account.id);
  const now = authNow(env);
  const params = [row.id, "verify", digest, now];
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE accounts SET verified_at = ?, updated_at = ? WHERE id = ? AND status = 'active'
      AND EXISTS (SELECT 1 FROM email_challenges WHERE account_id = accounts.id AND ${VALID_CHALLENGE})`).bind(now, now, account.id, ...params),
    env.DB.prepare(`UPDATE email_challenges SET consumed_at = ? WHERE ${VALID_CHALLENGE} AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = account_id AND a.status = 'active' AND a.verified_at > 0)`).bind(now, ...params),
  ]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) throw new AuthError(409, "CODE_INVALID", "验证码已使用或账号状态已变化，请重试。");
  await clearChallengePayload(env, row.id);
  return reply({ account: await accountById(env, account.id) });
}

async function resend(request: Request, env: AuthEnv): Promise<Response> {
  const account = await requireAccount(request, env, false);
  await requestRate(request, env, "resend", 20);
  if (account.verified) return reply({ account, challengeId: null, mailStatus: "verified" });
  return reply(await createMailChallenge(env, account, "verify"));
}

async function forgotPassword(request: Request, env: AuthEnv): Promise<Response> {
  await requestRate(request, env, "forgot", 20);
  const email = normalizeEmail((await payload(request)).email);
  const row = await env.DB.prepare("SELECT id, email FROM accounts WHERE email = ? AND status = 'active'").bind(email).first<{ id: string; email: string }>();
  let challengeId = randomToken(24);
  // Missing accounts take the same crypto/batch path. Its SQL account guard creates no task or budget reservation.
  try { challengeId = (await createMailChallenge(env, row || { id: randomToken(18), email }, "reset")).challengeId; }
  catch (error) { if (!(error instanceof MailError)) throw error; }
  // Same fields and wording for missing, disabled, throttled and existing accounts.
  return reply({ ok: true, challengeId, message: "如果该邮箱可用于找回，我们会发送验证码。请检查收件箱或稍后重试。" });
}

async function resetPassword(request: Request, env: AuthEnv): Promise<Response> {
  await requestRate(request, env, "reset", 40);
  const body = await payload(request);
  const password = validateNewPassword(body.password);
  const { row, digest } = await checkChallenge(env, body, "reset");
  await kdfRate(env, row.email);
  const passwordHash = await hashPassword(password);
  const now = authNow(env);
  const params = [row.id, "reset", digest, now];
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE accounts SET password_hash = ?, session_version = session_version + 1, updated_at = ?
      WHERE id = ? AND status = 'active' AND EXISTS (SELECT 1 FROM email_challenges WHERE account_id = accounts.id AND ${VALID_CHALLENGE})`)
      .bind(passwordHash, now, row.account_id, ...params),
    env.DB.prepare(`UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at = 0
      AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = account_id AND a.password_hash = ?)`)
      .bind(now, row.account_id, passwordHash),
    env.DB.prepare(`UPDATE email_challenges SET consumed_at = ? WHERE ${VALID_CHALLENGE}
      AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = account_id AND a.password_hash = ?)`)
      .bind(now, ...params, passwordHash),
  ]);
  if (results[0].meta.changes !== 1 || results[2].meta.changes !== 1) throw new AuthError(409, "CODE_INVALID", "验证码已使用或账号状态已变化，请重新获取。");
  await clearChallengePayload(env, row.id);
  return reply({ ok: true }, clearCookies(request));
}

async function changePassword(request: Request, env: AuthEnv): Promise<Response> {
  const account = await requireAccount(request, env, false);
  await requestRate(request, env, "change-password", 20);
  const body = await payload(request);
  const current = passwordInput(body.currentPassword);
  const next = validateNewPassword(body.password);
  await kdfRate(env, account.email, 2);
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ? AND status = 'active'").bind(account.id).first<AccountRow>();
  if (!row || !await verifyPassword(current, row.password_hash)) throw new AuthError(401, "PASSWORD_INCORRECT", "当前密码不正确，请检查后重试。");
  const hash = await hashPassword(next);
  const now = authNow(env);
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET password_hash = ?, session_version = session_version + 1, updated_at = ? WHERE id = ? AND password_hash = ? AND session_version = ? AND status = 'active'")
      .bind(hash, now, row.id, row.password_hash, row.session_version),
    env.DB.prepare("UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at = 0 AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = account_id AND a.password_hash = ?)").bind(now, row.id, hash),
    env.DB.prepare("UPDATE email_challenges SET revoked_at = ? WHERE account_id = ? AND consumed_at = 0 AND revoked_at = 0 AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = account_id AND a.password_hash = ?)").bind(now, row.id, hash),
    env.DB.prepare("UPDATE mail_deliveries SET payload_ciphertext = NULL, status = 'cancelled' WHERE challenge_id IN (SELECT id FROM email_challenges WHERE account_id = ? AND revoked_at = ?) AND EXISTS (SELECT 1 FROM accounts a WHERE a.id = ? AND a.password_hash = ?)").bind(row.id, now, row.id, hash),
  ]);
  if (results[0].meta.changes !== 1) throw new AuthError(409, "AUTH_CHANGED", "账号状态已变化，请重新登录。");
  return reply({ ok: true }, clearCookies(request));
}

/** The caller must require the explicit admin role before invoking this helper. */
export async function disableAccount(env: AuthEnv, id: string): Promise<boolean> {
  const now = authNow(env);
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET status = 'disabled', session_version = session_version + 1, updated_at = ? WHERE id = ? AND status = 'active'").bind(now, id),
    env.DB.prepare("UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at = 0").bind(now, id),
    env.DB.prepare("UPDATE email_challenges SET revoked_at = ? WHERE account_id = ? AND consumed_at = 0 AND revoked_at = 0").bind(now, id),
    env.DB.prepare("UPDATE mail_deliveries SET payload_ciphertext = NULL, status = 'cancelled' WHERE challenge_id IN (SELECT id FROM email_challenges WHERE account_id = ? AND revoked_at > 0)").bind(id),
  ]);
  return results[0].meta.changes > 0;
}

async function me(request: Request, env: AuthEnv): Promise<Response> {
  const account = await getAccount(request, env);
  const headers = new Headers();
  if (account) {
    const token = readCookie(request, "tb_account");
    const now = authNow(env);
    const renewed = await env.DB.prepare(`UPDATE account_sessions SET expires_at = ? WHERE token_hash = ? AND account_id = ? AND revoked_at = 0 AND expires_at > ? AND expires_at < ?
      AND session_version = (SELECT session_version FROM accounts WHERE id = ? AND status = 'active')`)
      .bind(now + SESSION_SECONDS * 1000, await sha256(token), account.id, now, now + RENEW_BEFORE, account.id).run();
    if (renewed.meta.changes === 1) headers.append("set-cookie", cookie(request, "tb_account", token, SESSION_SECONDS));
  }
  return reply({ account }, headers);
}

/** Unknown paths return null for the owning Worker router. */
export async function authRoute(request: Request, env: AuthEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const handlers: Record<string, (request: Request, env: AuthEnv) => Promise<Response>> = {
    "/api/auth/register": register,
    "/api/auth/login": login,
    "/api/auth/logout": logout,
    "/api/auth/email/verify": verifyEmail,
    "/api/auth/email/resend": resend,
    "/api/auth/password/forgot": forgotPassword,
    "/api/auth/password/reset": resetPassword,
    "/api/auth/password/change": changePassword,
  };
  if (path !== "/api/auth/me" && !handlers[path]) return null;
  try {
    if (path === "/api/auth/me" && request.method === "GET") return await me(request, env);
    if (!handlers[path] || request.method !== "POST") return new Response(JSON.stringify({ code: "METHOD_NOT_ALLOWED", error: "请求方式不正确。" }), { status: 405, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    assertOrigin(request, env);
    return await handlers[path](request, env);
  } catch (error) {
    if (!(error instanceof AuthError) && !(error instanceof MailError)) throw error;
    return new Response(JSON.stringify({ code: error.code, error: error.message }), { status: error.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
}
