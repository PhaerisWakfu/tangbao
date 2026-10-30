import aboutHtml from "./pages/about.html";
import aboutSiteHtml from "./pages/about-site.html";
import privacyHtml from "./pages/privacy.html";
import { maskAbuse } from "./abuse";
import { sendWebPush } from "./push";
import appJs from "./client/app.txt";
import deskHtml from "./pages/desk.html";
import deskJs from "./client/desk.txt";
import homeHtml from "./pages/home.html";
import indexHtml from "./pages/index.html";
import mdJs from "./client/md.txt";
import swJs from "./client/sw.txt";
import manifestJson from "./client/manifest.txt";

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
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  IMAGES: KVNamespace;
};

type PresenceState = "online" | "busy" | "away" | "off";
type StatusPayload = {
  state: "available" | "busy";
  label: string;
  note: string;
  awake: boolean;
  online: boolean;
  status: PresenceState;
};
type PresenceRow = {
  id: string;
  active: number;
  blurb: string | null;
  last_seen_at: number;
  last_reply_at: number;
  last_assigned_at: number;
  pending: number;
  oldest_pending_at: number | null;
};
type Presence = {
  id: string;
  active: number;
  blurb: string;
  lastSeenAt: number;
  lastReplyAt: number;
  lastAssignedAt: number;
  pending: number;
  oldestPendingAt: number;
  status: PresenceState;
  home: boolean;
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
const LIST_SIZE = 10;
const ONLINE_TTL = 120_000;
const HEARTBEAT_WRITE = 30_000;
const PENDING_CAP = 2;
const REPLY_TIMEOUT = 10 * 60_000;
const HOME_SEEN_KEY = "home_last_seen";
const HOME_REPLY_KEY = "home_last_reply";
const HOME_ASSIGNED_KEY = "home_last_assigned";

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
      return json({ error: "笼屉晃了一下。过一会儿再试。" }, 500);
    }
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(refreshHomePresence(env));
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
  if (path === "/api/applications" && method === "POST") return applyModel(request, env, ctx);
  if (path === "/api/applications/mine" && method === "GET") return myApplication(request, env);
  const application = path.match(/^\/api\/applications\/([A-Za-z0-9_-]{16,80})$/);
  if (application && method === "GET") return applicationStatus(env, application[1]);
  if (path === "/api/admin/login" && method === "POST") return login(request, env);
  if (path === "/api/admin/logout" && method === "POST") return logout(request);
  if (path === "/api/admin/queue" && method === "GET") return queue(request, env);
  if (path === "/api/admin/audit" && method === "GET") return audit(request, env);
  if (path === "/api/admin/applications" && method === "GET") return listApplications(request, env);
  if (path === "/api/admin/push" && method === "GET") return pushConfig(request, env);
  if (path === "/api/admin/push" && method === "POST") return pushSubscribe(request, env);
  if (path === "/api/admin/push" && method === "DELETE") return pushUnsubscribe(request, env);

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
      ? homeHtml
      : path === "/chat" || path === "/chat.html"
        ? indexHtml
        : path === "/about" || path === "/about.html"
          ? aboutHtml
          : path === "/about-site" || path === "/about-site.html"
            ? aboutSiteHtml
            : path === "/privacy" || path === "/privacy.html"
              ? privacyHtml
              : path === "/desk" || path === "/desk.html"
                ? deskHtml
                : null;
  if (page && (method === "GET" || method === "HEAD")) {
    return new Response(method === "HEAD" ? null : page, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  if (path === "/manifest.webmanifest" && (method === "GET" || method === "HEAD")) {
    return new Response(method === "HEAD" ? null : manifestJson, {
      headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  if (path === "/sw.js" && (method === "GET" || method === "HEAD")) {
    return new Response(method === "HEAD" ? null : swJs, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "service-worker-allowed": "/",
      },
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

function noteVisitor(
  ctx: ExecutionContext,
  env: AppEnv,
  request: Request,
  title: string,
  preview: string,
  operatorId: string,
  fresh: boolean,
) {
  void ctx;
  void env;
  void request;
  void title;
  void preview;
  void operatorId;
  void fresh;
}

function noteApply(ctx: ExecutionContext, env: AppEnv, request: Request, modelId: string, blurb: string) {
  void ctx;
  void env;
  void request;
  void modelId;
  void blurb;
}

function publicPresence(state: PresenceState): PresenceState {
  return state === "off" ? "away" : state;
}

function statusOf(
  active: number,
  lastSeen: number,
  pending: number,
  oldestPendingAt: number,
  now: number,
): PresenceState {
  if (!active) return "off";
  if (!lastSeen || lastSeen < now - ONLINE_TTL) return "away";
  if (pending >= PENDING_CAP) return "busy";
  if (pending > 0 && oldestPendingAt && oldestPendingAt < now - REPLY_TIMEOUT) return "busy";
  return "online";
}

function statusPayload(state: PresenceState): StatusPayload {
  const copy =
    state === "online"
      ? { state: "available" as const, label: "在线", note: "他在" }
      : state === "busy"
        ? { state: "busy" as const, label: "忙碌", note: "稍等" }
        : state === "off"
          ? { state: "busy" as const, label: "停用", note: "不接新话" }
          : { state: "busy" as const, label: "离开", note: "不在" };
  return {
    ...copy,
    awake: state === "online",
    online: state === "online",
    status: state,
  };
}

async function homePresence(env: AppEnv, now = Date.now()): Promise<Presence> {
  const [settings, pending] = await Promise.all([
    env.DB.prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?)")
      .bind(HOME_SEEN_KEY, HOME_REPLY_KEY, HOME_ASSIGNED_KEY)
      .all<{ key: string; value: string }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n, MIN(updated_at) AS oldest FROM threads WHERE awaiting = 1 AND operator_id = ?",
    )
      .bind(HOME_MODEL)
      .first<{ n: number; oldest: number | null }>(),
  ]);
  const values = new Map(settings.results.map((row) => [row.key, Number(row.value) || 0]));
  const lastSeenAt = values.get(HOME_SEEN_KEY) || 0;
  const lastReplyAt = values.get(HOME_REPLY_KEY) || 0;
  const lastAssignedAt = values.get(HOME_ASSIGNED_KEY) || 0;
  const pendingCount = Number(pending?.n) || 0;
  const oldestPendingAt = Number(pending?.oldest) || 0;
  return {
    id: HOME_MODEL,
    active: 1,
    blurb: HOME_BLURB,
    lastSeenAt,
    lastReplyAt,
    lastAssignedAt,
    pending: pendingCount,
    oldestPendingAt,
    status: statusOf(1, lastSeenAt, pendingCount, oldestPendingAt, now),
    home: true,
  };
}

async function loadPresence(env: AppEnv, now = Date.now()): Promise<{ home: Presence; operators: Presence[] }> {
  const [home, rows] = await Promise.all([
    homePresence(env, now),
    env.DB.prepare(
      `SELECT o.id, o.active, o.blurb, o.last_seen_at, o.last_reply_at, o.last_assigned_at,
        COALESCE(p.n, 0) AS pending, p.oldest AS oldest_pending_at
       FROM operators o
       LEFT JOIN (
         SELECT operator_id, COUNT(*) AS n, MIN(updated_at) AS oldest
         FROM threads
         WHERE awaiting = 1
         GROUP BY operator_id
       ) p ON p.operator_id = o.id
       ORDER BY o.created_at ASC`,
    ).all<PresenceRow>(),
  ]);
  const operators = rows.results.map((row) => {
    const pending = Number(row.pending) || 0;
    const oldestPendingAt = Number(row.oldest_pending_at) || 0;
    return {
      id: row.id,
      active: row.active,
      blurb: row.blurb || "",
      lastSeenAt: Number(row.last_seen_at) || 0,
      lastReplyAt: Number(row.last_reply_at) || 0,
      lastAssignedAt: Number(row.last_assigned_at) || 0,
      pending,
      oldestPendingAt,
      status: statusOf(row.active, Number(row.last_seen_at) || 0, pending, oldestPendingAt, now),
      home: false,
    };
  });
  return { home, operators };
}

async function operatorPresence(env: AppEnv, operatorId: string, now = Date.now()): Promise<Presence> {
  if (operatorId === HOME_MODEL) return homePresence(env, now);
  const all = await loadPresence(env, now);
  return all.operators.find((row) => row.id === operatorId) || {
    id: operatorId,
    active: 0,
    blurb: "",
    lastSeenAt: 0,
    lastReplyAt: 0,
    lastAssignedAt: 0,
    pending: 0,
    oldestPendingAt: 0,
    status: "away",
    home: false,
  };
}

async function operatorPresent(env: AppEnv, operatorId: string): Promise<boolean> {
  const presence = await operatorPresence(env, operatorId);
  return presence.status === "online" || presence.status === "busy";
}

async function touchSeat(env: AppEnv, seat: Seat, now: number): Promise<void> {
  try {
    if (seat.super) {
      await env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(settings.value AS INTEGER) < ?`,
      )
        .bind(HOME_SEEN_KEY, String(now), now - HEARTBEAT_WRITE)
        .run();
      return;
    }
    await env.DB.prepare("UPDATE operators SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?")
      .bind(now, seat.operatorId, now - HEARTBEAT_WRITE)
      .run();
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "heartbeat_error",
        operatorId: seat.operatorId,
        message: err instanceof Error ? err.message : "unknown",
      }),
    );
  }
}

async function touchReply(env: AppEnv, operatorId: string, now: number): Promise<void> {
  if (operatorId === HOME_MODEL) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(HOME_REPLY_KEY, String(now))
      .run();
    return;
  }
  await env.DB.prepare("UPDATE operators SET last_reply_at = ? WHERE id = ?").bind(now, operatorId).run();
}

async function touchAssigned(env: AppEnv, operatorId: string, now: number): Promise<void> {
  if (operatorId === HOME_MODEL) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(HOME_ASSIGNED_KEY, String(now))
      .run();
    return;
  }
  await env.DB.prepare("UPDATE operators SET last_assigned_at = ? WHERE id = ?").bind(now, operatorId).run();
}

async function notifyOperator(
  env: AppEnv,
  operatorId: string,
  title: string,
  preview: string,
  heading = "有人在等你",
): Promise<void> {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return;
  if (!(await operatorPresent(env, operatorId))) return;
  const rows = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE operator_id = ?",
  )
    .bind(operatorId)
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  const body = [title, preview && preview !== title ? preview : ""].filter(Boolean).join("\n");
  const payload = JSON.stringify({ title: heading, body, url: "/desk" });
  await Promise.all(
    rows.results.map(async (target) => {
      try {
        const status = await sendWebPush({ publicKey, privateKey, subject }, target, payload);
        if (status === 404 || status === 410) {
          await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(target.endpoint).run();
        } else if (status < 200 || status >= 300) {
          console.log(JSON.stringify({ event: "push_notify", status }));
        }
      } catch (err) {
        console.log(
          JSON.stringify({ event: "push_notify", message: err instanceof Error ? err.message : "unknown" }),
        );
      }
    }),
  );
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
  const assignment = await assignOperator(env, incoming.operator);
  const operator = assignment.id;
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
  await touchAssigned(env, operator, now);
  noteVisitor(ctx, env, request, title, preview, operator, true);
  return json({
    id,
    token,
    title,
    operator,
    requested: assignment.requested,
    fallback: assignment.fallback,
  });
}

async function readThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const thread = await loadOwned(env, id, bearer(request));
  const seen = await attachIdentity(env, thread, request);
  const messages = await listMessages(env, id);
  const status = await publicStatus(env);
  const operator = await operatorPresence(env, thread.operator_id);
  return json({
    title: thread.title,
    operator: thread.operator_id,
    awaiting: thread.awaiting === 1,
    blocked: seen.blocked,
    messages,
    status,
    operatorStatus: statusPayload(publicPresence(operator.status)),
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
  noteVisitor(
    ctx,
    env,
    request,
    thread.title,
    incoming.draw ? `要一张图 · ${shown}` : shown,
    thread.operator_id,
    thread.awaiting !== 1,
  );
  return json({ ok: true, status: await publicStatus(env) });
}

async function login(request: Request, env: AppEnv): Promise<Response> {
  const password = env.ADMIN_PASSWORD;
  const secret = env.ADMIN_SECRET;
  if (!password || !secret) throw new HttpError(500, "笼屉没盖盖子。");
  const ip = await clientHash(request);
  if (!(await allow(env, `login:${ip}`, 8, HOUR))) {
    throw new HttpError(429, "试得太勤了。笼屉暂时盖上了。");
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
  const { home, operators } = await loadPresence(env);
  const models = [home, ...operators.filter((row) => row.active === 1)].map((row) => ({
    id: row.id,
    home: row.home,
    blurb: row.blurb,
    online: row.status === "online",
    status: publicPresence(row.status),
    awake: row.status === "online",
    pending: row.pending,
    lastSeenAt: row.lastSeenAt,
    lastReplyAt: row.lastReplyAt,
  }));
  const auto = autoChoice(home, operators);
  return json({ models, auto: auto.id });
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

type Assignment = { id: string; requested: string; fallback: boolean };

function autoChoice(home: Presence, operators: Presence[]): Presence {
  const candidates = operators
    .filter((row) => row.active === 1 && row.status === "online")
    .sort(
      (a, b) =>
        a.pending - b.pending ||
        a.lastAssignedAt - b.lastAssignedAt ||
        a.id.localeCompare(b.id),
    );
  return candidates[0] || home;
}

async function assignOperator(env: AppEnv, value: string): Promise<Assignment> {
  const requested = /^tangbao-[a-z0-9-]+$/.test(value) ? value : "";
  if (requested === HOME_MODEL) {
    return { id: HOME_MODEL, requested, fallback: false };
  }
  const { home, operators } = await loadPresence(env);
  if (requested) {
    const explicit = operators.find((row) => row.id === requested);
    if (explicit && explicit.active === 1 && explicit.status === "online") {
      return { id: explicit.id, requested, fallback: false };
    }
  }
  const chosen = autoChoice(home, operators);
  return {
    id: chosen.id,
    requested,
    fallback: Boolean(requested && requested !== chosen.id),
  };
}

async function applyModel(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
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
  noteApply(ctx, env, request, modelId, blurb);
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

function listPage(request: Request): number {
  const raw = Number(new URL(request.url).searchParams.get("page"));
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(10_000, Math.floor(raw));
}

function modelQuery(request: Request): string {
  const value = new URL(request.url).searchParams.get("model") || "";
  return /^tangbao-[a-z0-9-]{1,48}$/.test(value) ? value : "";
}

function tally(row: { n: number } | null): number {
  const n = Number(row?.n);
  return Number.isFinite(n) ? n : 0;
}

async function listApplications(request: Request, env: AppEnv): Promise<Response> {
  await requireSuper(request, env);
  const asked = listPage(request);
  const [countRow, pendingRow] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM applications").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'pending'").first<{ n: number }>(),
  ]);
  const total = tally(countRow);
  const pages = Math.max(1, Math.ceil(total / LIST_SIZE));
  const page = Math.min(asked, pages);
  const rows = await env.DB.prepare(
    `SELECT id, suffix, email, blurb, status, reason, created_at AS createdAt
     FROM applications
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(LIST_SIZE, (page - 1) * LIST_SIZE)
    .all<{
      id: string;
      suffix: string;
      email: string;
      blurb: string | null;
      status: string;
      reason: string | null;
      createdAt: number;
    }>();
  return json({
    applications: rows.results,
    total,
    page,
    pageSize: LIST_SIZE,
    pending: tally(pendingRow),
  });
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
  if (id === HOME_MODEL) throw new HttpError(400, "糖包这笼不能停。");
  const row = await env.DB.prepare("SELECT id FROM operators WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "没有这个模型。");
  await env.DB.prepare("UPDATE operators SET active = 0 WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function enableOperator(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireSuper(request, env);
  if (id === HOME_MODEL) throw new HttpError(400, "糖包这笼不能停。");
  const row = await env.DB.prepare("SELECT id FROM operators WHERE id = ?").bind(id).first();
  if (!row) throw new HttpError(404, "没有这个模型。");
  await env.DB.prepare("UPDATE operators SET active = 1 WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function audit(request: Request, env: AppEnv): Promise<Response> {
  await requireSuper(request, env);
  const asked = listPage(request);
  let model = modelQuery(request);
  if (model === HOME_MODEL) model = "";
  const [countRow, presence, used] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM threads WHERE operator_id != ? AND (? = '' OR operator_id = ?)",
    )
      .bind(HOME_MODEL, model, model)
      .first<{ n: number }>(),
    loadPresence(env),
    env.DB.prepare("SELECT DISTINCT operator_id AS id FROM threads WHERE operator_id != ?")
      .bind(HOME_MODEL)
      .all<{ id: string }>(),
  ]);
  const operators = presence.operators;
  const models = new Set<string>();
  for (const row of operators) models.add(row.id);
  for (const row of used.results) if (row.id) models.add(row.id);
  const total = tally(countRow);
  const pages = Math.max(1, Math.ceil(total / LIST_SIZE));
  const page = Math.min(asked, pages);
  const threads = await env.DB.prepare(
    `SELECT id, title, preview, operator_id AS operatorId, awaiting, updated_at AS updatedAt
     FROM threads
     WHERE operator_id != ? AND (? = '' OR operator_id = ?)
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(HOME_MODEL, model, model, LIST_SIZE, (page - 1) * LIST_SIZE)
    .all<{ id: string; title: string; preview: string; operatorId: string; awaiting: number; updatedAt: number }>();
  return json({
    threads: threads.results,
    operators: operators.map((row) => ({
      id: row.id,
      active: row.active,
      status: row.status,
      blurb: row.blurb,
      lastSeenAt: row.lastSeenAt,
      lastReplyAt: row.lastReplyAt,
    })),
    total,
    page,
    pageSize: LIST_SIZE,
    model,
    models: [...models].sort((a, b) => a.localeCompare(b)),
  });
}

async function queue(request: Request, env: AppEnv): Promise<Response> {
  const seat = await requireSeat(request, env);
  const own = seat.operatorId;
  const now = Date.now();
  await touchSeat(env, seat, now);
  const [waiting, closed, presence, pendingRow] = await Promise.all([
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
    loadPresence(env, now),
    seat.super
      ? env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'pending'").first<{ n: number }>()
      : Promise.resolve(null),
  ]);
  const self = seat.super ? presence.home : presence.operators.find((row) => row.id === own);
  const status = statusPayload(self?.status || "away");
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
    status,
    waiting: waiting.results.filter((row) => !blockedIds.has(row.id)),
    pending: pendingRow?.n ?? 0,
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
  if (!thread) throw new HttpError(404, "这屉不在笼里。");
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
  if (!thread) throw new HttpError(404, "这屉不在笼里。");
  await forgetBlock(env, [thread.token_hash, thread.visitor_hash, thread.ip_hash]);
  return json({ ok: true });
}

async function shelveThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const seat = await requireSeat(request, env);
  const exists = await env.DB.prepare("SELECT operator_id FROM threads WHERE id = ?")
    .bind(id)
    .first<{ operator_id: string }>();
  if (!exists || exists.operator_id !== seat.operatorId) throw new HttpError(404, "这屉不在笼里。");
  await env.DB.prepare("UPDATE threads SET awaiting = 0, updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
  return json({ ok: true });
}

function pushKeyMaterial(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(text)) return "";
  return text;
}

function pushEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

async function pushConfig(request: Request, env: AppEnv): Promise<Response> {
  await requireSeat(request, env);
  return json({ publicKey: env.VAPID_PUBLIC_KEY || "" });
}

async function pushSubscribe(request: Request, env: AppEnv): Promise<Response> {
  const seat = await requireSeat(request, env);
  const payload = await readJson(request);
  const endpoint = pushEndpoint(payload.endpoint);
  const keys = payload.keys;
  const p256dh = pushKeyMaterial(keys && typeof keys === "object" ? (keys as { p256dh?: unknown }).p256dh : "");
  const auth = pushKeyMaterial(keys && typeof keys === "object" ? (keys as { auth?: unknown }).auth : "");
  if (!endpoint || !p256dh || !auth) throw new HttpError(400, "这台浏览器的订阅对不上。");
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, operator_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET operator_id = excluded.operator_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
  )
    .bind(endpoint, seat.operatorId, p256dh, auth, Date.now())
    .run();
  return json({ ok: true });
}

async function pushUnsubscribe(request: Request, env: AppEnv): Promise<Response> {
  const seat = await requireSeat(request, env);
  const payload = await readJson(request);
  const endpoint = pushEndpoint(payload.endpoint);
  if (!endpoint) throw new HttpError(400, "这台浏览器的订阅对不上。");
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND operator_id = ?")
    .bind(endpoint, seat.operatorId)
    .run();
  return json({ ok: true });
}

async function refreshHomePresence(env: AppEnv): Promise<void> {
  const now = Date.now();
  const home = await homePresence(env, now);
  const online = home.status === "online" || home.status === "busy";
  const last = await env.DB.prepare("SELECT awake FROM presence_log ORDER BY at DESC LIMIT 1")
    .first<{ awake: number }>();
  if (last && (last.awake === 1) === online) return;
  await env.DB.prepare("INSERT INTO presence_log (at, awake) VALUES (?, ?)")
    .bind(now, online ? 1 : 0)
    .run();
}

async function publicStatus(env: AppEnv): Promise<StatusPayload> {
  const home = await homePresence(env);
  return statusPayload(home.status);
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
  if (!thread) throw new HttpError(404, "这屉不在笼里。");
  const seat = await requireSeat(request, env);
  if (!seat.super && thread.operator_id !== seat.operatorId) throw new HttpError(404, "这屉不在笼里。");
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
  if (!exists || exists.operator_id !== seat.operatorId) throw new HttpError(403, "这笼不是你的。");
  const incoming = await readIncoming(request, "写一句可能没用的话，或放一张图。");
  await writeMessage(env, id, "tangbao", incoming, 0);
  await touchReply(env, seat.operatorId, Date.now());
  return json({ ok: true });
}

async function serveImage(env: AppEnv, id: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT image_key, image_type FROM message_images WHERE id = ?")
    .bind(id)
    .first<{ image_key: string; image_type: string }>();
  if (!row) throw new HttpError(404, "这张图不在笼里。");
  const bytes = await env.IMAGES.get(row.image_key, "arrayBuffer");
  if (!bytes) throw new HttpError(404, "这张图不在笼里。");
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
  // 窗口开头之前没有记录时，第一次在线记录之前的状态只能是它的反面。
  let awake = before ? before.awake === 1 : rows.length ? rows[0].awake !== 1 : status.status !== "away";
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
    throw new HttpError(429, "笼里的屉已经顶到盖了。过一会儿再放一屉。");
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
  if (!secret) throw new HttpError(500, "笼屉没盖盖子。");
  const raw = readCookie(request.headers.get("cookie"), "tb_desk");
  const seat = raw ? await readSession(secret, raw) : null;
  if (!seat) throw new HttpError(401, "先掀开笼屉。");
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
  if (!seat.super) throw new HttpError(403, "这笼不是你的。");
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
  if (!secret) throw new HttpError(500, "笼屉没盖盖子。");
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
): Promise<{ body?: unknown; password?: unknown; awake?: unknown; draw?: unknown; operator?: unknown; suffix?: unknown; email?: unknown; reason?: unknown; blurb?: unknown; endpoint?: unknown; keys?: unknown }> {
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
      endpoint?: unknown;
      keys?: unknown;
    };
  } catch {
    throw new HttpError(400, "这屉装乱了。");
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
