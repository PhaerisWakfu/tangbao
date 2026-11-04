import { AuthError, getAccount, requireAccount, type AuthEnv } from "./auth";

type BusinessEnv = AuthEnv & { ADMIN_SECRET?: string };
const DAY = 86_400_000;
const encoder = new TextEncoder();

export function randomToken(bytes = 24): string {
  return encode(crypto.getRandomValues(new Uint8Array(bytes)));
}
function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
}
export async function digest(value: string | ArrayBuffer): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value);
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function same(a: string, b: string): boolean {
  const left = encoder.encode(a), right = encoder.encode(b);
  return left.length === right.length && crypto.subtle.timingSafeEqual(left, right);
}
export function cookieValue(request: Request, name: string): string {
  return (request.headers.get("cookie") || "").split(";").map(p => p.trim()).find(p => p.startsWith(name + "="))?.slice(name.length + 1) || "";
}
function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) } });
}
export async function consumeRate(env: { DB: D1Database }, id: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare(`INSERT INTO rate_buckets (id,hits,reset_at) VALUES (?,1,?)
    ON CONFLICT(id) DO UPDATE SET
      hits=CASE WHEN reset_at<=? THEN 1 ELSE hits+1 END,
      reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END
    WHERE reset_at<=? OR hits<? RETURNING hits`).bind(id, now + windowMs, now, now, now, limit).first();
  return Boolean(row);
}
export type Guest = { id: string; created_count: number };
export async function getGuest(request: Request, env: { DB: D1Database }): Promise<Guest | null> {
  const token = cookieValue(request, "tb_guest");
  if (!/^[A-Za-z0-9_-]{32,80}$/.test(token)) return null;
  return env.DB.prepare("SELECT id,created_count FROM guest_identities WHERE token_hash=?").bind(await digest(token)).first<Guest>();
}
export async function withGuestCookie(request: Request, env: BusinessEnv, response: Response): Promise<Response> {
  if (await getGuest(request, env)) return response;
  const token = randomToken(32);
  await env.DB.prepare("INSERT INTO guest_identities(id,token_hash,created_count,created_at) VALUES(?,?,0,?)")
    .bind(randomToken(), await digest(token), Date.now()).run();
  const headers = new Headers(response.headers);
  headers.append("set-cookie", `tb_guest=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=34560000${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`);
  return new Response(response.body, { status: response.status, headers });
}

async function replayKey(env: BusinessEnv): Promise<CryptoKey> {
  if (!env.ADMIN_SECRET) throw new AuthError(503, "AUTH_UNAVAILABLE", "账号服务暂未配置完成。");
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode("thread-replay/v1:" + env.ADMIN_SECRET)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptReplay(env: BusinessEnv, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode("thread-replay/v1") }, await replayKey(env), encoder.encode(JSON.stringify(payload)));
  return encode(iv) + "." + encode(new Uint8Array(encrypted));
}
export async function decryptReplay(env: BusinessEnv, value: string): Promise<unknown> {
  const [iv, data] = value.split(".");
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv), additionalData: encoder.encode("thread-replay/v1") }, await replayKey(env), decode(data))));
}

export async function legacySeat(request: Request, env: BusinessEnv): Promise<{ super: boolean; operatorId: string } | null> {
  const raw = cookieValue(request, "tb_desk");
  if (!raw || !env.ADMIN_SECRET) return null;
  const pieces = raw.split(".");
  if (pieces.length !== 4) return null;
  const [kind, operatorId, expires, signature] = pieces;
  if (!["s", "o"].includes(kind) || !/^\d+$/.test(expires) || Number(expires) <= Date.now()) return null;
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.ADMIN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${kind}.${operatorId}.${expires}`))));
  if (!same(signature, expected)) return null;
  if (kind === "s") return { super: true, operatorId };
  const row = await env.DB.prepare("SELECT id FROM operators WHERE id=? AND owner_account_id IS NULL AND legacy_claimed_at=0").bind(operatorId).first();
  return row ? { super: false, operatorId } : null;
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 12_000) throw new AuthError(413, "BODY_TOO_LARGE", "填写的内容太长了。");
  try {
    const value = JSON.parse(text || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error();
    return value;
  } catch { throw new AuthError(400, "INVALID_REQUEST", "填写的内容无法识别。"); }
}

export async function accountBusinessRoute(request: Request, env: BusinessEnv): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (path === "/api/account/legacy-seat" && request.method === "GET") {
    const seat = await legacySeat(request, env);
    return json({ operatorId: seat?.operatorId || null, admin: seat?.super || false, migrationRequired: Boolean(seat) });
  }
  if (path === "/api/account/threads" && request.method === "GET") {
    const account = await requireAccount(request, env);
    const page = Math.max(1, Math.min(10000, Number(url.searchParams.get("page")) || 1));
    const rows = await env.DB.prepare(`SELECT id,title,preview,updated_at AS updatedAt,operator_id AS operatorId,awaiting
      FROM threads WHERE account_id=? ORDER BY updated_at DESC,id DESC LIMIT 101 OFFSET ?`).bind(account.id, (page - 1) * 100).all();
    return json({ threads: rows.results.slice(0, 100), page, hasMore: rows.results.length > 100 });
  }
  if (path === "/api/account/threads/claim" && request.method === "POST") {
    const account = await requireAccount(request, env);
    const body = await bodyOf(request);
    const id = typeof body.threadId === "string" ? body.threadId : "";
    const token = typeof body.token === "string" ? body.token : "";
    const thread = await env.DB.prepare("SELECT account_id,token_hash,visitor_hash,ip_hash FROM threads WHERE id=?").bind(id).first<{ account_id: string | null; token_hash: string; visitor_hash: string | null; ip_hash: string | null }>();
    if (thread?.account_id === account.id) return json({ ok: true });
    if (!thread || thread.account_id || !token || !same(await digest(token), thread.token_hash)) throw new AuthError(403, "HISTORY_PROOF_REQUIRED", "无法确认这段匿名对话属于你，请在原浏览器中关联。");
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE threads SET account_id=?,token_hash=? WHERE id=? AND account_id IS NULL AND token_hash=? AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND verified_at>0 AND status='active')")
        .bind(account.id, await digest(randomToken(32)), id, thread.token_hash, account.id),
      env.DB.prepare(`INSERT OR IGNORE INTO blocks(id,operator_id,created_at)
        SELECT ?,operator_id,created_at FROM blocks
        WHERE id IN (?,?)
        AND EXISTS(SELECT 1 FROM threads WHERE id=? AND account_id=?)`)
        .bind(`account:${account.id}`, thread.token_hash, thread.visitor_hash, id, account.id),
      env.DB.prepare("UPDATE thread_creations SET token_ciphertext=NULL WHERE thread_id=? AND EXISTS(SELECT 1 FROM threads WHERE id=? AND account_id=?)").bind(id, id, account.id),
    ]);
    if (result[0].meta.changes !== 1) throw new AuthError(409, "HISTORY_CONFLICT", "这段对话的归属刚刚发生变化，请刷新后重试。");
    return json({ ok: true });
  }
  if (path === "/api/account/legacy-claims" && request.method === "POST") {
    const account = await requireAccount(request, env);
    if (!(await consumeRate(env, "legacy-claim:" + account.id, 8, 3_600_000))) throw new AuthError(429, "RATE_LIMITED", "口令试得太勤了，请稍后再试。");
    const body = await bodyOf(request);
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 6 || password.length > 256) throw new AuthError(400, "LEGACY_PROOF_INVALID", "请输入原来的后台口令。");
    const rows = await env.DB.prepare("SELECT id,operator_uid,active,owner_account_id FROM operators WHERE password_hash=? LIMIT 2")
      .bind(await digest(password)).all<{ id: string; operator_uid: string; active: number; owner_account_id: string | null }>();
    if (rows.results.length !== 1) throw new AuthError(403, "LEGACY_PROOF_INVALID", "无法核验这个口令，请检查或联系管理员。");
    const operator = rows.results[0];
    if (!operator.active) throw new AuthError(409, "MODEL_DISABLED", "这个模型已停用，请联系管理员核查。绑定不会自动恢复。");
    if (operator.owner_account_id) throw new AuthError(409, "MODEL_ALREADY_OWNED", "这个模型已有绑定账号，请联系管理员核查。");
    if (await env.DB.prepare("SELECT id FROM operators WHERE owner_account_id=?").bind(account.id).first()) throw new AuthError(409, "MODEL_LIMIT", "当前账号已经有一个模型，不能再绑定第二个。");
    if (await env.DB.prepare("SELECT id FROM applications WHERE account_id=? AND status IN ('pending','approved')").bind(account.id).first()) throw new AuthError(409, "APPLICATION_EXISTS", "当前账号已有申请，请先处理申请后再绑定。");
    const claimId = randomToken(32), now = Date.now(), expiresAt = now + 10 * 60_000;
    await env.DB.prepare("INSERT INTO legacy_claims(id,account_id,operator_uid,proof_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)")
      .bind(claimId, account.id, operator.operator_uid, await digest(claimId), expiresAt, now).run();
    return json({ claimId, operatorId: operator.id, expiresAt });
  }
  if (path === "/api/account/legacy-claims/seat" && request.method === "POST") {
    const account = await requireAccount(request, env);
    if (!(await consumeRate(env, "legacy-seat-claim:" + account.id, 8, 3_600_000))) throw new AuthError(429, "RATE_LIMITED", "操作太频繁，请稍后再试。");
    const seat = await legacySeat(request, env);
    if (!seat || seat.super) throw new AuthError(403, "LEGACY_SESSION_REQUIRED", "没有检测到可迁移的旧后台登录，请使用原口令或联系管理员。");
    const operator = await env.DB.prepare("SELECT id,operator_uid FROM operators WHERE id=? AND owner_account_id IS NULL AND legacy_claimed_at=0 AND active=1")
      .bind(seat.operatorId).first<{ id: string; operator_uid: string }>();
    if (!operator) throw new AuthError(409, "MODEL_ALREADY_OWNED", "这个模型已被绑定或不可用，请联系管理员核查。");
    if (await env.DB.prepare("SELECT id FROM operators WHERE owner_account_id=?").bind(account.id).first()) throw new AuthError(409, "MODEL_LIMIT", "当前账号已经有一个模型。");
    if (await env.DB.prepare("SELECT id FROM applications WHERE account_id=? AND status IN ('pending','approved')").bind(account.id).first()) throw new AuthError(409, "APPLICATION_EXISTS", "当前账号已有申请，请先处理申请后再绑定。");
    const claimId = randomToken(32), now = Date.now();
    try {
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE operators SET owner_account_id=?,legacy_claimed_at=?,password_hash=?
          WHERE id=? AND operator_uid=? AND owner_account_id IS NULL AND legacy_claimed_at=0 AND active=1
          AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND verified_at>0 AND status='active')
          AND NOT EXISTS(SELECT 1 FROM operators WHERE owner_account_id=?)
          AND NOT EXISTS(SELECT 1 FROM applications WHERE account_id=? AND status IN ('pending','approved'))`)
          .bind(account.id, now, await digest(randomToken(32)), operator.id, operator.operator_uid, account.id, account.id, account.id),
        env.DB.prepare("INSERT OR IGNORE INTO account_roles(account_id,role) SELECT ?,'operator' WHERE EXISTS(SELECT 1 FROM operators WHERE id=? AND owner_account_id=?)")
          .bind(account.id, operator.id, account.id),
        env.DB.prepare("INSERT INTO legacy_claims(id,account_id,operator_uid,proof_hash,expires_at,created_at,consumed_at) VALUES(?,?,?,?,?,?,?)")
          .bind(claimId, account.id, operator.operator_uid, await digest(claimId), now, now, now),
      ]);
      if (results[0].meta.changes !== 1) throw new AuthError(409, "CLAIM_CONFLICT", "模型或账号归属已发生变化，请刷新后重试。");
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(409, "CLAIM_CONFLICT", "模型或账号归属已发生变化，请刷新后重试。");
    }
    return json({ ok: true, operatorId: operator.id });
  }
  const confirm = path.match(/^\/api\/account\/legacy-claims\/([A-Za-z0-9_-]{32,80})\/confirm$/);
  if (confirm && request.method === "POST") {
    const account = await requireAccount(request, env);
    const id = confirm[1], now = Date.now();
    const claim = await env.DB.prepare("SELECT operator_uid FROM legacy_claims WHERE id=? AND account_id=? AND proof_hash=? AND consumed_at=0 AND expires_at>?")
      .bind(id, account.id, await digest(id), now).first<{ operator_uid: string }>();
    if (!claim) throw new AuthError(409, "CLAIM_EXPIRED", "绑定凭证已失效，请重新核验旧口令。");
    let results: D1Result[];
    try {
      results = await env.DB.batch([
        env.DB.prepare(`UPDATE operators SET owner_account_id=?,legacy_claimed_at=?,password_hash=?
          WHERE operator_uid=? AND owner_account_id IS NULL AND active=1
          AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND verified_at>0 AND status='active')
          AND NOT EXISTS(SELECT 1 FROM operators WHERE owner_account_id=?)
          AND NOT EXISTS(SELECT 1 FROM applications WHERE account_id=? AND status IN ('pending','approved'))
          AND EXISTS(SELECT 1 FROM legacy_claims WHERE id=? AND account_id=? AND consumed_at=0 AND expires_at>?)`)
          .bind(account.id, now, await digest(randomToken(32)), claim.operator_uid, account.id, account.id, account.id, id, account.id, now),
        env.DB.prepare("UPDATE legacy_claims SET consumed_at=? WHERE id=? AND changes()=1").bind(now, id),
        env.DB.prepare(`INSERT OR IGNORE INTO account_roles(account_id,role) SELECT ?,'operator'
          WHERE EXISTS(SELECT 1 FROM operators WHERE operator_uid=? AND owner_account_id=?)`).bind(account.id, claim.operator_uid, account.id),
      ]);
    } catch { throw new AuthError(409, "CLAIM_CONFLICT", "模型或账号归属已发生变化，请刷新后重试。"); }
    if (results[0].meta.changes !== 1) throw new AuthError(409, "CLAIM_CONFLICT", "模型已被认领，或当前账号已有模型/申请。");
    const operator = await env.DB.prepare("SELECT id FROM operators WHERE operator_uid=? AND owner_account_id=?").bind(claim.operator_uid, account.id).first<{ id: string }>();
    return json({ operatorId: operator!.id }, 200, { "set-cookie": `tb_desk=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}` });
  }
  return null;
}

export async function imageSignature(env: BusinessEnv, imageId: string, tokenHash: string, expires: number): Promise<string> {
  if (!env.ADMIN_SECRET) throw new AuthError(503, "AUTH_UNAVAILABLE", "图片服务暂未配置完成。");
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.ADMIN_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`image/v1:${imageId}:${tokenHash}:${expires}`))));
}
