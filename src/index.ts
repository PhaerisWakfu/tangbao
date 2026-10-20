import aboutHtml from "./pages/about.html";
import appJs from "./client/app.txt";
import deskHtml from "./pages/desk.html";
import deskJs from "./client/desk.txt";
import indexHtml from "./pages/index.html";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AppEnv = Env & {
  ADMIN_PASSWORD?: string;
  ADMIN_SECRET?: string;
};

type StatusPayload = {
  state: "available" | "busy";
  label: string;
  note: string;
  awake: boolean;
};

const HOUR = 60 * 60 * 1000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const QUEUE_CAP = 400;
const BODY_LIMIT = 2000;
const REQUEST_LIMIT = 20_000;

const encoder = new TextEncoder();

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.log(
        JSON.stringify({
          event: "worker_error",
          message: err instanceof Error ? err.message : "unknown",
        }),
      );
      return json({ error: "桌子这边晃了一下。过一会儿再试。" }, 500);
    }
  },
} satisfies ExportedHandler<AppEnv>;

async function route(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/status" && method === "GET") return json(await publicStatus(env));
  if (path === "/api/presence" && method === "GET") return json(await presenceHistory(env));
  if (path === "/api/threads" && method === "POST") return createThread(request, env);
  if (path === "/api/admin/login" && method === "POST") return login(request, env);
  if (path === "/api/admin/logout" && method === "POST") return logout(request);
  if (path === "/api/admin/queue" && method === "GET") return queue(request, env);
  if (path === "/api/admin/status" && method === "POST") return setStatus(request, env);

  const adminThread = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{16,80})$/);
  if (adminThread) {
    if (method === "GET") return adminRead(request, env, adminThread[1]);
    if (method === "POST") return adminReply(request, env, adminThread[1]);
  }

  const visitor = path.match(/^\/api\/threads\/([A-Za-z0-9_-]{16,80})(\/messages)?$/);
  if (visitor) {
    const id = visitor[1];
    if (!visitor[2] && method === "GET") return readThread(request, env, id);
    if (!visitor[2] && method === "DELETE") return deleteThread(request, env, id);
    if (visitor[2] && method === "POST") return visitorMessage(request, env, id);
  }

  if (path.startsWith("/api/")) return json({ error: "没有这一格。" }, 404);

  const page =
    path === "/" || path === "/index.html"
      ? indexHtml
      : path === "/about" || path === "/about.html"
        ? aboutHtml
        : path === "/desk" || path === "/desk.html"
          ? deskHtml
          : null;
  if (page && (method === "GET" || method === "HEAD")) {
    return new Response(method === "HEAD" ? null : page, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  const script =
    path === "/assets/app.js" ? appJs : path === "/assets/desk.js" ? deskJs : null;
  if (script && (method === "GET" || method === "HEAD")) {
    return new Response(method === "HEAD" ? null : script, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  return env.ASSETS.fetch(request);
}

async function createThread(request: Request, env: AppEnv): Promise<Response> {
  const ip = await clientHash(request);
  if (!(await allow(env, `thread:${ip}`, 8, HOUR))) {
    throw new HttpError(429, "新对话先歇一会儿。他一次看不了这么多开头。");
  }
  const payload = await readJson(request);
  const body = cleanBody(payload.body);
  await assertQueue(env, false);

  const id = randomId(16);
  const token = randomId(32);
  const now = Date.now();
  const title = titleFrom(body);
  const preview = previewFrom(body);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO threads (id, token_hash, title, preview, created_at, updated_at, awaiting) VALUES (?, ?, ?, ?, ?, ?, 1)",
    ).bind(id, await sha256(token), title, preview, now, now),
    env.DB.prepare(
      "INSERT INTO messages (id, thread_id, role, body, created_at) VALUES (?, ?, 'visitor', ?, ?)",
    ).bind(randomId(16), id, body, now),
  ]);
  return json({ id, token, title });
}

async function readThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const thread = await loadOwned(env, id, bearer(request));
  const messages = await env.DB.prepare(
    "SELECT id, role, body, created_at AS createdAt FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
  )
    .bind(id)
    .all<{ id: string; role: string; body: string; createdAt: number }>();
  const status = await publicStatus(env);
  return json({ title: thread.title, messages: messages.results, status });
}

async function deleteThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  await loadOwned(env, id, bearer(request));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE thread_id = ?").bind(id),
    env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

async function visitorMessage(request: Request, env: AppEnv, id: string): Promise<Response> {
  const token = bearer(request);
  const thread = await loadOwned(env, id, token);
  if (!(await allow(env, `msg:${thread.token_hash}`, 30, HOUR))) {
    throw new HttpError(429, "今天的字已经够多了。让他的手指歇一会儿。");
  }
  const payload = await readJson(request);
  const body = cleanBody(payload.body);
  await assertQueue(env, thread.awaiting === 1);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO messages (id, thread_id, role, body, created_at) VALUES (?, ?, 'visitor', ?, ?)",
    ).bind(randomId(16), id, body, now),
    env.DB.prepare("UPDATE threads SET preview = ?, updated_at = ?, awaiting = 1 WHERE id = ?").bind(
      previewFrom(body),
      now,
      id,
    ),
  ]);
  return json({ ok: true, status: await publicStatus(env) });
}

async function login(request: Request, env: AppEnv): Promise<Response> {
  const password = env.ADMIN_PASSWORD;
  const secret = env.ADMIN_SECRET;
  if (!password || !secret) throw new HttpError(500, "桌子还没配钥匙。");
  const ip = await clientHash(request);
  if (!(await allow(env, `login:${ip}`, 8, HOUR))) {
    throw new HttpError(429, "试得太勤了。桌子暂时锁上。");
  }
  const payload = await readJson(request);
  const given = typeof payload.password === "string" ? payload.password : "";
  if (!(await passwordsMatch(given, password))) throw new HttpError(401, "这句口令不对。");
  const exp = String(Date.now() + WEEK_SECONDS * 1000);
  const cookie = `${exp}.${await sign(secret, exp)}`;
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(cookie, request, WEEK_SECONDS) });
}

function logout(request: Request): Response {
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
}

async function queue(request: Request, env: AppEnv): Promise<Response> {
  await requireAdmin(request, env);
  const [waiting, recent, status] = await Promise.all([
    env.DB.prepare(
      "SELECT id, title, preview, updated_at AS updatedAt FROM threads WHERE awaiting = 1 ORDER BY updated_at ASC LIMIT 100",
    ).all<{ id: string; title: string; preview: string; updatedAt: number }>(),
    env.DB.prepare(
      "SELECT id, title, preview, updated_at AS updatedAt FROM threads WHERE awaiting = 0 ORDER BY updated_at DESC LIMIT 20",
    ).all<{ id: string; title: string; preview: string; updatedAt: number }>(),
    publicStatus(env),
  ]);
  return json({ awake: status.awake, waiting: waiting.results, recent: recent.results });
}

async function setStatus(request: Request, env: AppEnv): Promise<Response> {
  await requireAdmin(request, env);
  const payload = await readJson(request);
  if (typeof payload.awake !== "boolean") throw new HttpError(400, "灯的状态没写清。");
  await env.DB.batch([
    env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'awake'").bind(payload.awake ? "1" : "0"),
    env.DB.prepare("INSERT INTO presence_log (at, awake) VALUES (?, ?)").bind(Date.now(), payload.awake ? 1 : 0),
  ]);
  return json(await publicStatus(env));
}

async function adminRead(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireAdmin(request, env);
  const thread = await env.DB.prepare(
    "SELECT id, title, awaiting, updated_at AS updatedAt FROM threads WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; title: string; awaiting: number; updatedAt: number }>();
  if (!thread) throw new HttpError(404, "这张纸条不在桌上。");
  const messages = await env.DB.prepare(
    "SELECT id, role, body, created_at AS createdAt FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
  )
    .bind(id)
    .all<{ id: string; role: string; body: string; createdAt: number }>();
  return json({ thread, messages: messages.results });
}

async function adminReply(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireAdmin(request, env);
  const exists = await env.DB.prepare("SELECT id FROM threads WHERE id = ?").bind(id).first();
  if (!exists) throw new HttpError(404, "这张纸条不在桌上。");
  const payload = await readJson(request);
  const body = cleanBody(payload.body, "写一句可能没用的话，但得有字。");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO messages (id, thread_id, role, body, created_at) VALUES (?, ?, 'tangbao', ?, ?)",
    ).bind(randomId(16), id, body, now),
    env.DB.prepare("UPDATE threads SET preview = ?, updated_at = ?, awaiting = 0 WHERE id = ?").bind(
      previewFrom(body),
      now,
      id,
    ),
  ]);
  return json({ ok: true });
}

async function publicStatus(env: AppEnv): Promise<StatusPayload> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'awake'").first<{ value: string }>();
  const awake = row?.value !== "0";
  if (awake) return { state: "available", label: "可用", note: "他醒着", awake: true };
  return { state: "busy", label: "繁忙", note: "他睡了", awake: false };
}

async function presenceHistory(env: AppEnv) {
  const now = Date.now();
  const start = now - 24 * HOUR;
  const [before, changes, status] = await Promise.all([
    env.DB.prepare("SELECT awake FROM presence_log WHERE at < ? ORDER BY at DESC LIMIT 1")
      .bind(start)
      .first<{ awake: number }>(),
    env.DB.prepare("SELECT at, awake FROM presence_log WHERE at >= ? ORDER BY at ASC LIMIT 500")
      .bind(start)
      .all<{ at: number; awake: number }>(),
    publicStatus(env),
  ]);
  const rows = changes.results;
  // 窗口开头之前没有记录时，第一次按灯之前的状态只能是它的反面。
  let awake = before ? before.awake === 1 : rows.length ? rows[0].awake !== 1 : status.awake;
  const hours = new Array<number>(24).fill(0);
  let cursor = start;
  const spend = (until: number, on: boolean) => {
    while (cursor < until) {
      const index = Math.min(23, Math.floor((cursor - start) / HOUR));
      const edge = Math.min(until, start + (index + 1) * HOUR);
      if (on) hours[index] += edge - cursor;
      cursor = edge;
    }
  };
  for (const row of rows) {
    spend(row.at, awake);
    awake = row.awake === 1;
  }
  spend(now, awake);
  const total = hours.reduce((sum, ms) => sum + ms, 0);
  return {
    hours: hours.map((ms) => Math.round((ms / HOUR) * 100) / 100),
    ratio: Math.round((total / (24 * HOUR)) * 1000) / 1000,
    logged: Boolean(before || rows.length),
  };
}

async function loadOwned(env: AppEnv, id: string, token: string) {
  if (!token) throw new HttpError(401, "这把钥匙对不上这段对话。");
  const thread = await env.DB.prepare(
    "SELECT id, token_hash, title, awaiting FROM threads WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; token_hash: string; title: string; awaiting: number }>();
  const hash = await sha256(token);
  if (!thread || !safeEqual(hash, thread.token_hash)) {
    throw new HttpError(401, "这把钥匙对不上这段对话。");
  }
  return thread;
}

async function assertQueue(env: AppEnv, alreadyWaiting: boolean): Promise<void> {
  if (alreadyWaiting) return;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM threads WHERE awaiting = 1").first<{ n: number }>();
  if (Number(row?.n ?? 0) >= QUEUE_CAP) {
    throw new HttpError(429, "桌上的纸条已经叠到灯了。过一会儿再放一张。");
  }
}

async function allow(env: AppEnv, bucket: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT hits, reset_at FROM rate_buckets WHERE id = ?")
    .bind(bucket)
    .first<{ hits: number; reset_at: number }>();
  if (!row || row.reset_at <= now) {
    await env.DB.prepare(
      "INSERT INTO rate_buckets (id, hits, reset_at) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET hits = 1, reset_at = excluded.reset_at",
    )
      .bind(bucket, now + windowMs)
      .run();
    return true;
  }
  if (row.hits >= limit) return false;
  await env.DB.prepare("UPDATE rate_buckets SET hits = hits + 1 WHERE id = ?").bind(bucket).run();
  return true;
}

async function requireAdmin(request: Request, env: AppEnv): Promise<void> {
  const secret = env.ADMIN_SECRET;
  if (!secret) throw new HttpError(500, "桌子还没配钥匙。");
  const raw = readCookie(request.headers.get("cookie"), "tb_desk");
  if (!raw || !(await validSession(secret, raw))) throw new HttpError(401, "先在桌子这边坐下。");
}

async function validSession(secret: string, cookie: string): Promise<boolean> {
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return false;
  const exp = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expected = await sign(secret, exp);
  return safeEqual(sig, expected);
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return b64url(new Uint8Array(sig));
}

function sessionCookie(value: string, request: Request, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `tb_desk=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+([A-Za-z0-9_-]+)$/);
  return match ? match[1] : "";
}

async function readJson(request: Request): Promise<{ body?: unknown; password?: unknown; awake?: unknown }> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > REQUEST_LIMIT) throw new HttpError(413, "这句太长了。糖包一次看不了这么多。");
  const text = await request.text();
  if (text.length > REQUEST_LIMIT) throw new HttpError(413, "这句太长了。糖包一次看不了这么多。");
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as { body?: unknown; password?: unknown; awake?: unknown };
  } catch {
    throw new HttpError(400, "这张纸条写乱了。");
  }
}

function cleanBody(input: unknown, empty = "先写一句再发送。"): string {
  if (typeof input !== "string") throw new HttpError(400, empty);
  const text = input.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (!text) throw new HttpError(400, empty);
  if ([...text].length > BODY_LIMIT) throw new HttpError(400, "这句太长了。糖包一次看不了这么多。");
  return text;
}

function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, " ");
  const chars = [...one];
  return chars.length > 22 ? `${chars.slice(0, 22).join("")}…` : one;
}

function previewFrom(text: string): string {
  const one = text.replace(/\s+/g, " ");
  const chars = [...one];
  return chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : one;
}

async function clientHash(request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  return sha256(ip);
}

async function passwordsMatch(input: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  return safeEqual(a, b);
}

function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;
  return crypto.subtle.timingSafeEqual(left, right);
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomId(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { status, headers });
}
