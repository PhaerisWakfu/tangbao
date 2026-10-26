import aboutHtml from "./pages/about.html";
import { maskAbuse } from "./abuse";
import { inOffHours, nextOffAt } from "./hours";
import appJs from "./client/app.txt";
import deskHtml from "./pages/desk.html";
import deskJs from "./client/desk.txt";
import indexHtml from "./pages/index.html";
import mdJs from "./client/md.txt";

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
  FEISHU_WEBHOOK?: string;
  IMAGES: KVNamespace;
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
const IMAGE_LIMIT = 2_000_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES = 6;
const HOME_MODEL = "tangbao-vme50-flash";
const HOME_BLURB = "糖包本人。什么都聊一点。";

const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
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
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(applySchedule(env));
  },
} satisfies ExportedHandler<AppEnv>;

async function route(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/status" && method === "GET") return json(await publicStatus(env));
  if (path === "/api/models" && method === "GET") return listModels(env);
  if (path === "/api/presence" && method === "GET") return json(await presenceHistory(env));
  if (path === "/api/threads" && method === "POST") return createThread(request, env, ctx);
  if (path === "/api/applications" && method === "POST") return applyModel(request, env);
  if (path === "/api/applications/mine" && method === "GET") return myApplication(request, env);
  const application = path.match(/^\/api\/applications\/([A-Za-z0-9_-]{16,80})$/);
  if (application && method === "GET") return applicationStatus(env, application[1]);
  if (path === "/api/admin/login" && method === "POST") return login(request, env);
  if (path === "/api/admin/logout" && method === "POST") return logout(request);
  if (path === "/api/admin/queue" && method === "GET") return queue(request, env);
  if (path === "/api/admin/audit" && method === "GET") return audit(request, env);
  if (path === "/api/admin/applications" && method === "GET") return listApplications(request, env);
  if (path === "/api/admin/status" && method === "POST") return setStatus(request, env);

  const decision = path.match(/^\/api\/admin\/applications\/([A-Za-z0-9_-]{16,80})\/(approve|reject)$/);
  if (decision && method === "POST") {
    return decision[2] === "approve"
      ? approveApplication(request, env, decision[1])
      : rejectApplication(request, env, decision[1]);
  }
  const operatorRoute = path.match(/^\/api\/admin\/operators\/(tangbao-[a-z0-9-]+)\/(disable|enable)$/);
  if (operatorRoute && method === "POST") {
    return operatorRoute[2] === "disable"
      ? disableOperator(request, env, operatorRoute[1])
      : enableOperator(request, env, operatorRoute[1]);
  }

  const image = path.match(/^\/api\/images\/([A-Za-z0-9_-]{16,80})$/);
  if (image && method === "GET") return serveImage(env, image[1]);

  const adminThread = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{16,80})$/);
  if (adminThread) {
    if (method === "GET") return adminRead(request, env, adminThread[1]);
    if (method === "POST") return adminReply(request, env, adminThread[1]);
  }

  const shelve = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{16,80})\/shelve$/);
  if (shelve && method === "POST") return shelveThread(request, env, shelve[1]);
  const block = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{16,80})\/block$/);
  if (block && method === "POST") return blockThread(request, env, block[1]);
  const unblock = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{16,80})\/unblock$/);
  if (unblock && method === "POST") return unblockThread(request, env, unblock[1]);

  const visitor = path.match(/^\/api\/threads\/([A-Za-z0-9_-]{16,80})(\/messages)?$/);
  if (visitor) {
    const id = visitor[1];
    if (!visitor[2] && method === "GET") return readThread(request, env, id);
    if (!visitor[2] && method === "DELETE") return deleteThread(request, env, id);
    if (visitor[2] && method === "POST") return visitorMessage(request, env, id, ctx);
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
    path === "/assets/app.js" ? appJs : path === "/assets/desk.js" ? deskJs : path === "/assets/md.js" ? mdJs : null;
  if (script && (method === "GET" || method === "HEAD")) {
    return new Response(method === "HEAD" ? null : script, {
      headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  return env.ASSETS.fetch(request);
}

const DESK_URL = "https://tangbao.phaeris.cn/desk";

function noteVisitor(
  ctx: ExecutionContext,
  env: AppEnv,
  request: Request,
  title: string,
  preview: string,
  operatorId: string,
) {
  const host = new URL(request.url).hostname;
  if (host === "localhost" || host === "127.0.0.1") return;
  if (operatorId !== HOME_MODEL) return;
  ctx.waitUntil(notifyFeishu(env, title, preview));
}

async function notifyFeishu(env: AppEnv, title: string, preview: string): Promise<void> {
  const hook = env.FEISHU_WEBHOOK;
  if (!hook) return;
  await applySchedule(env);
  const awake = await env.DB.prepare("SELECT value FROM settings WHERE key = 'awake'").first<{ value: string }>();
  if (awake?.value === "0") return;
  const lines = ["桌上有新纸条", title];
  if (preview && preview !== title) lines.push(preview);
  lines.push(DESK_URL);
  try {
    const response = await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ msg_type: "text", content: { text: lines.join("\n") } }),
    });
    const payload = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (!response.ok || (payload && payload.code !== 0)) {
      console.log(JSON.stringify({ event: "feishu_notify", status: response.status, code: payload?.code, msg: payload?.msg }));
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "feishu_notify",
        message: err instanceof Error ? err.message : "unknown",
      }),
    );
  }
}

const BLOCKED = "这边不再收新的话了。";

async function createThread(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const visitor = await visitorHash(request);
  const ip = await clientHash(request);
  if (await isBlocked(env, [visitor, ip])) throw new HttpError(403, BLOCKED);
  if (!(await allow(env, `thread:${ip}`, 8, HOUR))) {
    throw new HttpError(429, "新对话先歇一会儿。他一次看不了这么多开头。");
  }
  const incoming = await readIncoming(request, "先写一句，或放一张图。");
  const operator = await resolveOperator(env, incoming.operator);
  await assertQueue(env, false);

  const id = randomId(16);
  const token = randomId(32);
  const now = Date.now();
  const shown = caption(incoming.body, incoming.images.length);
  const title = titleFrom(shown);
  const preview = previewFrom(incoming.draw ? `要一张图 · ${shown}` : shown);
  const messageId = randomId(16);
  const stored = await storeImages(env, incoming.images);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO threads (id, token_hash, title, preview, created_at, updated_at, awaiting, visitor_hash, ip_hash, operator_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
    ).bind(id, await sha256(token), title, preview, now, now, visitor || null, ip, operator),
    env.DB.prepare(
      "INSERT INTO messages (id, thread_id, role, body, draw, created_at) VALUES (?, ?, 'visitor', ?, ?, ?)",
    ).bind(messageId, id, incoming.body, incoming.draw ? 1 : 0, now),
    ...imageInserts(env, messageId, stored),
  ]);
  noteVisitor(ctx, env, request, title, preview, operator);
  return json({ id, token, title, operator });
}

async function readThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const thread = await loadOwned(env, id, bearer(request));
  const seen = await attachIdentity(env, thread, request);
  const messages = await listMessages(env, id);
  const status = await publicStatus(env);
  return json({
    title: thread.title,
    operator: thread.operator_id,
    awaiting: thread.awaiting === 1,
    blocked: seen.blocked,
    messages,
    status,
  });
}

async function deleteThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  await loadOwned(env, id, bearer(request));
  const images = await env.DB.prepare(
    "SELECT image_key FROM message_images WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)",
  )
    .bind(id)
    .all<{ image_key: string }>();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE thread_id = ?").bind(id),
    env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(id),
  ]);
  await Promise.all(images.results.map((row) => env.IMAGES.delete(row.image_key)));
  return json({ ok: true });
}

async function visitorMessage(request: Request, env: AppEnv, id: string, ctx: ExecutionContext): Promise<Response> {
  const token = bearer(request);
  const thread = await loadOwned(env, id, token);
  const seen = await attachIdentity(env, thread, request);
  if (seen.blocked) throw new HttpError(403, BLOCKED);
  if (!(await allow(env, `msg:${thread.token_hash}`, 30, HOUR))) {
    throw new HttpError(429, "今天的字已经够多了。让他的手指歇一会儿。");
  }
  const incoming = await readIncoming(request, "先写一句，或放一张图。");
  if (thread.operator_id !== HOME_MODEL) {
    const row = await env.DB.prepare("SELECT active FROM operators WHERE id = ?")
      .bind(thread.operator_id)
      .first<{ active: number }>();
    if (!row || row.active !== 1) throw new HttpError(400, "这个模型不在。");
  }
  await assertQueue(env, thread.awaiting === 1);
  await writeMessage(env, id, "visitor", incoming, 1);
  const shown = caption(incoming.body, incoming.images.length);
  noteVisitor(ctx, env, request, thread.title, incoming.draw ? `要一张图 · ${shown}` : shown, thread.operator_id);
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
  if (await passwordsMatch(given, password)) {
    return issueSession(request, env, { super: true, operatorId: HOME_MODEL });
  }
  const hash = await sha256(given);
  const operator = await env.DB.prepare("SELECT id, active FROM operators WHERE password_hash = ?")
    .bind(hash)
    .first<{ id: string; active: number }>();
  if (!operator || operator.active !== 1) throw new HttpError(401, "这句口令不对。");
  return issueSession(request, env, { super: false, operatorId: operator.id });
}

function logout(request: Request): Response {
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
}

async function listModels(env: AppEnv): Promise<Response> {
  const [status, operators] = await Promise.all([
    publicStatus(env),
    env.DB.prepare("SELECT id, awake, blurb FROM operators WHERE active = 1 ORDER BY created_at ASC").all<{
      id: string;
      awake: number;
      blurb: string | null;
    }>(),
  ]);
  return json({
    models: [
      { id: HOME_MODEL, awake: status.awake, home: true, blurb: HOME_BLURB },
      ...operators.results.map((row) => ({ id: row.id, awake: row.awake === 1, home: false, blurb: row.blurb || "" })),
    ],
  });
}

function modelSuffix(value: unknown): string {
  const suffix = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suffix) || suffix.length > 40) return "";
  return suffix;
}

function emailOf(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 120 || email.length < 6) return "";
  const ok = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;
  return ok.test(email) ? email : "";
}

function blurbOf(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = maskAbuse(sanitize(value)).replace(/\s+/g, " ").trim();
  if (!text) return "";
  if ([...text].length > 12) throw new HttpError(400, "模型说明太长了。十二个字以内。");
  return text;
}

function reasonOf(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = sanitize(value);
  if (!text) return "";
  if ([...text].length > 200) throw new HttpError(400, "理由太长了。");
  return text;
}

async function resolveOperator(env: AppEnv, requested: string): Promise<string> {
  const id = requested || HOME_MODEL;
  if (id === HOME_MODEL) return HOME_MODEL;
  if (!id.startsWith("tangbao-")) throw new HttpError(400, "这个模型不在。");
  const row = await env.DB.prepare("SELECT active FROM operators WHERE id = ?")
    .bind(id)
    .first<{ active: number }>();
  if (!row || row.active !== 1) throw new HttpError(400, "这个模型不在。");
  return id;
}

async function applyModel(request: Request, env: AppEnv): Promise<Response> {
  const ip = await clientHash(request);
  if (!(await allow(env, `apply:${ip}`, 5, HOUR))) throw new HttpError(429, "申请先歇一会儿。");
  const payload = await readJson(request);
  const suffix = modelSuffix(payload.suffix);
  const email = emailOf(payload.email);
  const blurb = blurbOf(payload.blurb);
  if (!suffix) throw new HttpError(400, "型号后面要写成小写字母、数字和短横线。");
  if (!email) throw new HttpError(400, "邮箱要写成能写信的地址。");
  if (!blurb) throw new HttpError(400, "写一句你擅长什么。");
  const visitor = await visitorHash(request);
  if (!visitor) throw new HttpError(400, "这个浏览器还认不出你。刷新后再申请。");
  const existing = await env.DB.prepare(
    "SELECT id, status, pass_note, reason FROM applications WHERE visitor_hash = ? AND status IN ('pending', 'approved') ORDER BY created_at DESC LIMIT 1",
  )
    .bind(visitor)
    .first<{ id: string; status: string; pass_note: string | null; reason: string | null }>();
  if (existing) return json(applicationView(existing));
  const modelId = `tangbao-${suffix}`;
  if (modelId === HOME_MODEL) throw new HttpError(400, "这个型号已经有人坐着。");
  const modelTaken = await env.DB.prepare(
    `SELECT id FROM operators WHERE id = ?
     UNION SELECT id FROM applications WHERE suffix = ? AND status IN ('pending', 'approved')`,
  )
    .bind(modelId, suffix)
    .first();
  if (modelTaken) throw new HttpError(400, "这个型号已经有人申请或在用。");
  const id = randomId(16);
  await env.DB.prepare(
    "INSERT INTO applications (id, suffix, email, blurb, status, visitor_hash, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
  )
    .bind(id, suffix, email, blurb, visitor, Date.now())
    .run();
  return json({ id, status: "pending" });
}

function applicationView(row: { id?: string; status: string; pass_note: string | null; reason?: string | null }): {
  id?: string;
  status: string;
  password?: string;
  reason?: string;
} {
  return {
    id: row.id,
    status: row.status,
    password: row.status === "approved" ? row.pass_note || undefined : undefined,
    reason: row.status === "rejected" ? row.reason || undefined : undefined,
  };
}

async function myApplication(request: Request, env: AppEnv): Promise<Response> {
  const visitor = await visitorHash(request);
  const row = visitor
    ? await env.DB.prepare(
        "SELECT id, status, pass_note, reason FROM applications WHERE visitor_hash = ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(visitor)
        .first<{ id: string; status: string; pass_note: string | null; reason: string | null }>()
    : null;
  if (!row) throw new HttpError(404, "没有这份申请。");
  return json(applicationView(row));
}

async function applicationStatus(env: AppEnv, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT status, pass_note, reason FROM applications WHERE id = ?")
    .bind(id)
    .first<{ status: string; pass_note: string | null; reason: string | null }>();
  if (!row) throw new HttpError(404, "没有这份申请。");
  return json(applicationView(row));
}

async function listApplications(request: Request, env: AppEnv): Promise<Response> {
  await requireSuper(request, env);
  const rows = await env.DB.prepare(
    "SELECT id, suffix, email, blurb, status, reason, created_at AS createdAt FROM applications ORDER BY created_at DESC LIMIT 50",
  ).all<{ id: string; suffix: string; email: string; blurb: string | null; status: string; reason: string | null; createdAt: number }>();
  return json({ applications: rows.results });
}

async function approveApplication(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireSuper(request, env);
  const row = await env.DB.prepare("SELECT suffix, blurb, status FROM applications WHERE id = ?")
    .bind(id)
    .first<{ suffix: string; blurb: string | null; status: string }>();
  if (!row) throw new HttpError(404, "没有这份申请。");
  if (row.status !== "pending") throw new HttpError(400, "这份申请已经处理过。");
  const modelId = `tangbao-${row.suffix}`;
  const password = randomId(9);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO operators (id, password_hash, active, awake, blurb, created_at) VALUES (?, ?, 1, 0, ?, ?)",
    ).bind(modelId, await sha256(password), row.blurb || "", now),
    env.DB.prepare("UPDATE applications SET status = 'approved', operator_id = ?, pass_note = ? WHERE id = ?").bind(
      modelId,
      password,
      id,
    ),
  ]);
  return json({ ok: true, modelId, password });
}

async function rejectApplication(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireSuper(request, env);
  const row = await env.DB.prepare("SELECT status FROM applications WHERE id = ?").bind(id).first<{ status: string }>();
  if (!row) throw new HttpError(404, "没有这份申请。");
  if (row.status !== "pending") throw new HttpError(400, "这份申请已经处理过。");
  const payload = await readJson(request);
  const reason = reasonOf(payload.reason);
  if (!reason) throw new HttpError(400, "先写一句没过的理由。");
  await env.DB.prepare("UPDATE applications SET status = 'rejected', reason = ? WHERE id = ?").bind(reason, id).run();
  return json({ ok: true });
}

async function disableOperator(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireSuper(request, env);
  if (id === HOME_MODEL) throw new HttpError(400, "糖包这张桌子不能停。");
  const row = await env.DB.prepare("SELECT id FROM operators WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "没有这个模型。");
  await env.DB.prepare("UPDATE operators SET active = 0, awake = 0 WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function enableOperator(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireSuper(request, env);
  if (id === HOME_MODEL) throw new HttpError(400, "糖包这张桌子不能停。");
  const row = await env.DB.prepare("SELECT id FROM operators WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "没有这个模型。");
  await env.DB.prepare("UPDATE operators SET active = 1 WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function audit(request: Request, env: AppEnv): Promise<Response> {
  await requireSuper(request, env);
  const rows = await env.DB.prepare(
    "SELECT id, title, preview, operator_id AS operatorId, awaiting, updated_at AS updatedAt FROM threads ORDER BY updated_at DESC LIMIT 50",
  ).all<{ id: string; title: string; preview: string; operatorId: string; awaiting: number; updatedAt: number }>();
  const operators = await env.DB.prepare(
    "SELECT id, active, awake, blurb FROM operators ORDER BY created_at DESC LIMIT 50",
  ).all<{ id: string; active: number; awake: number; blurb: string | null }>();
  return json({ threads: rows.results, operators: operators.results });
}

async function queue(request: Request, env: AppEnv): Promise<Response> {
  const seat = await requireSeat(request, env);
  const own = seat.operatorId;
  const [waiting, closed, status, lamp] = await Promise.all([
    env.DB.prepare(
      "SELECT id, title, preview, updated_at AS updatedAt FROM threads WHERE awaiting = 1 AND operator_id = ? ORDER BY updated_at ASC LIMIT 100",
    )
      .bind(own)
      .all<{ id: string; title: string; preview: string; updatedAt: number }>(),
    env.DB.prepare(
      `SELECT id, title, preview, updated_at AS updatedAt,
        (SELECT role FROM messages WHERE thread_id = threads.id ORDER BY created_at DESC LIMIT 1) AS lastRole
       FROM threads WHERE awaiting = 0 AND operator_id = ? ORDER BY updated_at DESC LIMIT 40`,
    )
      .bind(own)
      .all<{ id: string; title: string; preview: string; updatedAt: number; lastRole: string }>(),
    publicStatus(env),
    seat.super
      ? Promise.resolve(null)
      : env.DB.prepare("SELECT awake FROM operators WHERE id = ?").bind(own).first<{ awake: number }>(),
  ]);
  const blocked = await env.DB.prepare(
    `SELECT id, title, preview, updated_at AS updatedAt FROM threads
     WHERE operator_id = ? AND (
       token_hash IN (SELECT id FROM blocks)
       OR visitor_hash IN (SELECT id FROM blocks)
       OR ip_hash IN (SELECT id FROM blocks)
     )
     ORDER BY updated_at DESC LIMIT 20`,
  )
    .bind(own)
    .all<{ id: string; title: string; preview: string; updatedAt: number }>();
  const blockedIds = new Set(blocked.results.map((row) => row.id));
  const rows = closed.results;
  return json({
    super: seat.super,
    operatorId: seat.operatorId,
    awake: seat.super ? status.awake : lamp?.awake === 1,
    waiting: waiting.results.filter((row) => !blockedIds.has(row.id)),
    recent: rows.filter((row) => row.lastRole !== "visitor" && !blockedIds.has(row.id)).slice(0, 20),
    shelved: rows.filter((row) => row.lastRole === "visitor" && !blockedIds.has(row.id)).slice(0, 20),
    blocked: blocked.results,
  });
}

async function blockThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireSuper(request, env);
  const thread = await env.DB.prepare(
    "SELECT id, token_hash, visitor_hash, ip_hash FROM threads WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; token_hash: string; visitor_hash: string | null; ip_hash: string | null }>();
  if (!thread) throw new HttpError(404, "这张纸条不在桌上。");
  await rememberBlock(env, [thread.token_hash, thread.visitor_hash, thread.ip_hash]);
  await env.DB.prepare("UPDATE threads SET awaiting = 0, updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
  return json({ ok: true });
}

async function unblockThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireSuper(request, env);
  const thread = await env.DB.prepare(
    "SELECT id, token_hash, visitor_hash, ip_hash FROM threads WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; token_hash: string; visitor_hash: string | null; ip_hash: string | null }>();
  if (!thread) throw new HttpError(404, "这张纸条不在桌上。");
  await forgetBlock(env, [thread.token_hash, thread.visitor_hash, thread.ip_hash]);
  return json({ ok: true });
}

async function shelveThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const seat = await requireSeat(request, env);
  const exists = await env.DB.prepare("SELECT operator_id FROM threads WHERE id = ?")
    .bind(id)
    .first<{ operator_id: string }>();
  if (!exists || exists.operator_id !== seat.operatorId) throw new HttpError(404, "这张纸条不在桌上。");
  await env.DB.prepare("UPDATE threads SET awaiting = 0, updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
  return json({ ok: true });
}

async function setStatus(request: Request, env: AppEnv): Promise<Response> {
  const seat = await requireSeat(request, env);
  const payload = await readJson(request);
  if (typeof payload.awake !== "boolean") throw new HttpError(400, "灯的状态没写清。");
  if (!seat.super) {
    await env.DB.prepare("UPDATE operators SET awake = ? WHERE id = ?").bind(payload.awake ? 1 : 0, seat.operatorId).run();
    return json({ awake: payload.awake });
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE settings SET value = ? WHERE key = 'awake'").bind(payload.awake ? "1" : "0"),
    env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('awake_hold', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).bind(payload.awake ? String(nextOffAt(now)) : "0"),
    env.DB.prepare("INSERT INTO presence_log (at, awake) VALUES (?, ?)").bind(now, payload.awake ? 1 : 0),
  ]);
  return json(await publicStatus(env));
}

async function applySchedule(env: AppEnv): Promise<void> {
  const now = Date.now();
  const holdRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'awake_hold'").first<{ value: string }>();
  const hold = Number(holdRow?.value || "0");
  if (hold && now < hold) return;
  if (hold) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('awake_hold', '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
    ).run();
  }
  if (!inOffHours(now)) return;
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'awake'").first<{ value: string }>();
  if (row?.value === "0") return;
  await env.DB.batch([
    env.DB.prepare("UPDATE settings SET value = '0' WHERE key = 'awake'"),
    env.DB.prepare("INSERT INTO presence_log (at, awake) VALUES (?, 0)").bind(now),
  ]);
}

async function publicStatus(env: AppEnv): Promise<StatusPayload> {
  await applySchedule(env);
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'awake'").first<{ value: string }>();
  const awake = row?.value !== "0";
  if (awake) return { state: "available", label: "可用", note: "他醒着", awake: true };
  return { state: "busy", label: "繁忙", note: "他睡了", awake: false };
}

async function adminRead(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireAdmin(request, env);
  const thread = await env.DB.prepare(
    "SELECT id, title, awaiting, operator_id, token_hash, visitor_hash, ip_hash, updated_at AS updatedAt FROM threads WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      title: string;
      awaiting: number;
      operator_id: string;
      token_hash: string;
      visitor_hash: string | null;
      ip_hash: string | null;
      updatedAt: number;
    }>();
  if (!thread) throw new HttpError(404, "这张纸条不在桌上。");
  const seat = await requireSeat(request, env);
  if (!seat.super && thread.operator_id !== seat.operatorId) throw new HttpError(404, "这张纸条不在桌上。");
  const messages = await listMessages(env, id);
  const blocked = await isBlocked(env, [thread.token_hash, thread.visitor_hash, thread.ip_hash]);
  return json({
    thread: {
      id: thread.id,
      title: thread.title,
      awaiting: thread.awaiting,
      operatorId: thread.operator_id,
      updatedAt: thread.updatedAt,
      blocked,
    },
    messages,
  });
}

async function adminReply(request: Request, env: AppEnv, id: string): Promise<Response> {
  const seat = await requireSeat(request, env);
  const exists = await env.DB.prepare("SELECT operator_id FROM threads WHERE id = ?")
    .bind(id)
    .first<{ operator_id: string }>();
  if (!exists || exists.operator_id !== seat.operatorId) throw new HttpError(403, "这张桌子不是你的。");
  const incoming = await readIncoming(request, "写一句可能没用的话，或放一张图。");
  await writeMessage(env, id, "tangbao", incoming, 0);
  return json({ ok: true });
}

async function serveImage(env: AppEnv, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT image_key, image_type FROM message_images WHERE id = ?")
    .bind(id)
    .first<{ image_key: string; image_type: string }>();
  if (!row) throw new HttpError(404, "这张图不在桌上。");
  const bytes = await env.IMAGES.get(row.image_key, "arrayBuffer");
  if (!bytes) throw new HttpError(404, "这张图不在桌上。");
  return new Response(bytes, {
    headers: {
      "content-type": row.image_type || "application/octet-stream",
      "cache-control": "private, max-age=86400",
    },
  });
}

async function listMessages(env: AppEnv, threadId: string) {
  const messages = await env.DB.prepare(
    "SELECT id, role, body, draw, created_at AS createdAt FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
  )
    .bind(threadId)
    .all<{ id: string; role: string; body: string; draw: number; createdAt: number }>();
  const ids = messages.results.map((message) => message.id);
  const grouped = new Map<string, { id: string; type: string }[]>();
  if (ids.length) {
    const marks = ids.map(() => "?").join(", ");
    const images = await env.DB.prepare(
      `SELECT id, message_id AS messageId, image_type AS imageType FROM message_images WHERE message_id IN (${marks}) ORDER BY position ASC`,
    )
      .bind(...ids)
      .all<{ id: string; messageId: string; imageType: string }>();
    for (const image of images.results) {
      const list = grouped.get(image.messageId) ?? [];
      list.push({ id: image.id, type: image.imageType });
      grouped.set(image.messageId, list);
    }
  }
  return messages.results.map((message) => ({ ...message, images: grouped.get(message.id) ?? [] }));
}

async function writeMessage(
  env: AppEnv,
  threadId: string,
  role: "visitor" | "tangbao",
  incoming: Incoming,
  awaiting: number,
): Promise<void> {
  const messageId = randomId(16);
  const now = Date.now();
  const stored = await storeImages(env, incoming.images);
  const draw = role === "visitor" && incoming.draw ? 1 : 0;
  const shown = caption(incoming.body, stored.length);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO messages (id, thread_id, role, body, draw, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      messageId,
      threadId,
      role,
      incoming.body,
      draw,
      now,
    ),
    ...imageInserts(env, messageId, stored),
    env.DB.prepare("UPDATE threads SET preview = ?, updated_at = ?, awaiting = ? WHERE id = ?").bind(
      previewFrom(draw ? `要一张图 · ${shown}` : shown),
      now,
      awaiting,
      threadId,
    ),
  ]);
}

async function storeImages(env: AppEnv, images: Incoming["images"]) {
  const stored: { id: string; key: string; type: string }[] = [];
  for (const image of images) {
    const id = randomId(16);
    const key = `img/${id}`;
    await env.IMAGES.put(key, image.bytes);
    stored.push({ id, key, type: image.type });
  }
  return stored;
}

function imageInserts(env: AppEnv, messageId: string, stored: { id: string; key: string; type: string }[]) {
  return stored.map((image, position) =>
    env.DB.prepare(
      "INSERT INTO message_images (id, message_id, image_key, image_type, position) VALUES (?, ?, ?, ?, ?)",
    ).bind(image.id, messageId, image.key, image.type, position),
  );
}

function caption(body: string, count: number): string {
  if (body) return body;
  if (count <= 1) return "一张图片";
  return `${count} 张图片`;
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
    "SELECT id, token_hash, title, awaiting, visitor_hash, ip_hash, operator_id FROM threads WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      token_hash: string;
      title: string;
      awaiting: number;
      visitor_hash: string | null;
      ip_hash: string | null;
      operator_id: string;
    }>();
  const hash = await sha256(token);
  if (!thread || !safeEqual(hash, thread.token_hash)) {
    throw new HttpError(401, "这把钥匙对不上这段对话。");
  }
  return thread;
}

function presentIds(...ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

async function isBlocked(env: AppEnv, ids: Array<string | null | undefined>): Promise<boolean> {
  const fresh = presentIds(...ids);
  if (!fresh.length) return false;
  const marks = fresh.map(() => "?").join(", ");
  const row = await env.DB.prepare(`SELECT id FROM blocks WHERE id IN (${marks}) LIMIT 1`)
    .bind(...fresh)
    .first();
  return Boolean(row);
}

async function rememberBlock(env: AppEnv, ids: Array<string | null | undefined>): Promise<void> {
  const fresh = presentIds(...ids);
  if (!fresh.length) return;
  const now = Date.now();
  await env.DB.batch(
    fresh.map((id) =>
      env.DB.prepare("INSERT INTO blocks (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING").bind(id, now),
    ),
  );
}

async function forgetBlock(env: AppEnv, ids: Array<string | null | undefined>): Promise<void> {
  const fresh = presentIds(...ids);
  if (!fresh.length) return;
  const marks = fresh.map(() => "?").join(", ");
  await env.DB.prepare(`DELETE FROM blocks WHERE id IN (${marks})`).bind(...fresh).run();
}

async function visitorHash(request: Request): Promise<string> {
  const raw = request.headers.get("x-visitor") || "";
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(raw)) return "";
  return sha256(raw);
}

async function attachIdentity(
  env: AppEnv,
  thread: { id: string; token_hash: string; visitor_hash: string | null; ip_hash: string | null },
  request: Request,
): Promise<{ blocked: boolean }> {
  const visitor = await visitorHash(request);
  const ip = await clientHash(request);
  const blocked = await isBlocked(env, [thread.token_hash, thread.visitor_hash, thread.ip_hash, visitor, ip]);
  if (blocked) await rememberBlock(env, [thread.token_hash, thread.visitor_hash, thread.ip_hash, visitor, ip]);
  if ((visitor && !thread.visitor_hash) || (ip && !thread.ip_hash)) {
    await env.DB.prepare(
      "UPDATE threads SET visitor_hash = COALESCE(visitor_hash, ?), ip_hash = COALESCE(ip_hash, ?) WHERE id = ?",
    )
      .bind(visitor || null, ip || null, thread.id)
      .run();
  }
  return { blocked };
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

type Seat = { super: boolean; operatorId: string };

async function requireSeat(request: Request, env: AppEnv): Promise<Seat> {
  const secret = env.ADMIN_SECRET;
  if (!secret) throw new HttpError(500, "桌子还没配钥匙。");
  const raw = readCookie(request.headers.get("cookie"), "tb_desk");
  const seat = raw ? await readSession(secret, raw) : null;
  if (!seat) throw new HttpError(401, "先在桌子这边坐下。");
  if (!seat.super) {
    const row = await env.DB.prepare("SELECT active FROM operators WHERE id = ?")
      .bind(seat.operatorId)
      .first<{ active: number }>();
    if (!row || row.active !== 1) throw new HttpError(401, "这个模型停了。");
  }
  return seat;
}

async function requireSuper(request: Request, env: AppEnv): Promise<Seat> {
  const seat = await requireSeat(request, env);
  if (!seat.super) throw new HttpError(403, "这张桌子不是你的。");
  return seat;
}

async function readSession(secret: string, cookie: string): Promise<Seat | null> {
  const sigAt = cookie.lastIndexOf(".");
  if (sigAt <= 0) return null;
  const sig = cookie.slice(sigAt + 1);
  const rest = cookie.slice(0, sigAt);
  const expAt = rest.lastIndexOf(".");
  if (expAt <= 0) return null;
  const exp = rest.slice(expAt + 1);
  const head = rest.slice(0, expAt);
  const kindAt = head.indexOf(".");
  if (kindAt <= 0) return null;
  const kind = head.slice(0, kindAt);
  const operatorId = head.slice(kindAt + 1);
  if ((kind !== "s" && kind !== "o") || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const expected = await sign(secret, `${kind}.${operatorId}.${exp}`);
  if (!safeEqual(sig, expected)) return null;
  return { super: kind === "s", operatorId };
}

async function issueSession(request: Request, env: AppEnv, seat: Seat): Promise<Response> {
  const secret = env.ADMIN_SECRET;
  if (!secret) throw new HttpError(500, "桌子还没配钥匙。");
  const exp = String(Date.now() + WEEK_SECONDS * 1000);
  const kind = seat.super ? "s" : "o";
  const payload = `${kind}.${seat.operatorId}.${exp}`;
  const cookie = `${payload}.${await sign(secret, payload)}`;
  return json({ ok: true, super: seat.super, operatorId: seat.operatorId }, 200, {
    "set-cookie": sessionCookie(cookie, request, WEEK_SECONDS),
  });
}

async function requireAdmin(request: Request, env: AppEnv): Promise<void> {
  await requireSeat(request, env);
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

async function readJson(
  request: Request,
): Promise<{ body?: unknown; password?: unknown; awake?: unknown; draw?: unknown; operator?: unknown; suffix?: unknown; email?: unknown; reason?: unknown; blurb?: unknown }> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > REQUEST_LIMIT) throw new HttpError(413, "这句太长了。糖包一次看不了这么多。");
  const text = await request.text();
  if (text.length > REQUEST_LIMIT) throw new HttpError(413, "这句太长了。糖包一次看不了这么多。");
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    return parsed as {
      body?: unknown;
      password?: unknown;
      awake?: unknown;
      draw?: unknown;
      operator?: unknown;
      suffix?: unknown;
      email?: unknown;
      reason?: unknown;
      blurb?: unknown;
    };
  } catch {
    throw new HttpError(400, "这张纸条写乱了。");
  }
}

type Incoming = {
  body: string;
  images: { bytes: ArrayBuffer; type: string }[];
  draw: boolean;
  operator: string;
};

function wantsDraw(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function readOperator(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function readIncoming(request: Request, empty: string): Promise<Incoming> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const declared = Number(request.headers.get("content-length") || "0");
    if (declared > MAX_IMAGES * IMAGE_LIMIT + 100_000) throw new HttpError(413, "这些图太大了。先收一收再发。");
    const form = await request.formData();
    const raw = form.get("body");
    const text = maskAbuse(typeof raw === "string" ? sanitize(raw) : "");
    if ([...text].length > BODY_LIMIT) throw new HttpError(400, "这句太长了。糖包一次看不了这么多。");
    const files = [...form.getAll("images"), ...form.getAll("image")].filter(
      (file): file is File => file instanceof File && file.size > 0,
    );
    if (files.length > MAX_IMAGES) throw new HttpError(400, `一次最多 ${MAX_IMAGES} 张。`);
    const images: Incoming["images"] = [];
    for (const file of files) {
      if (file.size > IMAGE_LIMIT) throw new HttpError(413, "有一张图太大了。先收一收再发。");
      if (!IMAGE_TYPES.has(file.type)) throw new HttpError(400, "有一张图糖包打不开。换 jpg、png、webp 或 gif。");
      images.push({ bytes: await file.arrayBuffer(), type: file.type });
    }
    const draw = wantsDraw(form.get("draw"));
    if (draw && !text) throw new HttpError(400, "先写要画什么。");
    if (!text && !images.length) throw new HttpError(400, empty);
    return { body: text, images, draw, operator: readOperator(form.get("operator")) };
  }
  const payload = await readJson(request);
  const draw = wantsDraw(payload.draw);
  return {
    body: cleanBody(payload.body, draw ? "先写要画什么。" : empty),
    images: [],
    draw,
    operator: readOperator(payload.operator),
  };
}

function cleanBody(input: unknown, empty = "先写一句再发送。"): string {
  if (typeof input !== "string") throw new HttpError(400, empty);
  const text = maskAbuse(sanitize(input));
  if (!text) throw new HttpError(400, empty);
  if ([...text].length > BODY_LIMIT) throw new HttpError(400, "这句太长了。糖包一次看不了这么多。");
  return text;
}

function sanitize(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
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
