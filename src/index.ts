import aboutHtml from "./pages/about.html";
import aboutSiteHtml from "./pages/about-site.html";
import privacyHtml from "./pages/privacy.html";
import { maskAbuse } from "./abuse";
import { sendWebPush } from "./push";
import appJs from "./client/app.txt";
import deskHtml from "./pages/desk.html";
import deskJs from "./client/desk.txt";
import { createClient, type Client } from "@libsql/client/web";
import homeHtml from "./pages/home.html";
import indexHtml from "./pages/index.html";
import mdJs from "./client/md.txt";
import swJs from "./client/sw.txt";
import manifestJson from "./client/manifest.txt";
import accountJs from "./client/account.txt";
import { AuthError, authRoute, getAccount, requireAccount, assertOrigin, disableAccount, processMailOutbox, type AuthEnv } from "./auth";
import { accountBusinessRoute, getGuest, withGuestCookie, consumeRate, encryptReplay, decryptReplay, imageSignature, legacySeat } from "./account-business";
import { consumeMailEvents } from "./mail-events";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AppEnv = Env & AuthEnv & {
  ADMIN_PASSWORD?: string;
  ADMIN_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  MAINTENANCE?: string;
  MAIL_EVENTS_QUEUE?: string;
  MAIL_EVENTS_ACCOUNT_ID?: string;
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
const DAY = 24 * HOUR;

function localHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MODEL_RECENT_MS = 30 * DAY;
const MODEL_PAGE_SIZE = 30;
const AUDIT_MODEL_PAGE_SIZE = 20;
const MODEL_SEARCH_MAX = 40;
const QUEUE_CAP = 400;
const BODY_LIMIT = 2000;
const REQUEST_LIMIT = 20_000;
const IMAGE_LIMIT = 2_000_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES = 6;
const HOME_MODEL = "tangbao-vme50-flash";
const POOL_MODEL = "tangbao-pool";
const HOME_BLURB = "糖包本人。什么都聊一点。";
const LIST_SIZE = 10;
const ONLINE_TTL = 120_000;
const HEARTBEAT_WRITE = 30_000;
const PENDING_CAP = 2;
const REPLY_TIMEOUT = 10 * 60_000;
const HOME_SEEN_KEY = "home_last_seen";
const HOME_REPLY_KEY = "home_last_reply";
const HOME_ASSIGNED_KEY = "home_last_assigned";
const AUTO_APPROVE_KEY = "auto_approve";

const encoder = new TextEncoder();

const PUBLIC_CACHE_TTL: Record<string, number> = {
  "/api/status": 300,
  "/api/models": 300,
  "/api/presence": 600,
};

function d1Meta(result: { rowsAffected?: number; lastInsertRowid?: bigint | number }) {
  const changes = Number(result.rowsAffected) || 0;
  return {
    changes,
    last_row_id: Number(result.lastInsertRowid) || 0,
    duration: 0,
    rows_read: 0,
    rows_written: changes,
  };
}

class TursoStatement {
  constructor(
    private readonly client: Client,
    readonly sql: string,
    readonly args: unknown[] = [],
  ) {}

  bind(...args: unknown[]): TursoStatement {
    return new TursoStatement(this.client, this.sql, args);
  }

  async first<T>(column?: string): Promise<T | null> {
    const result = await this.client.execute({ sql: this.sql, args: this.args as never });
    if (!result.rows.length) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return (column ? row[column] : row) as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: ReturnType<typeof d1Meta> }> {
    const result = await this.client.execute({ sql: this.sql, args: this.args as never });
    return {
      results: result.rows as T[],
      success: true,
      meta: d1Meta(result),
    };
  }

  async run(): Promise<{ success: true; meta: ReturnType<typeof d1Meta> }> {
    const result = await this.client.execute({ sql: this.sql, args: this.args as never });
    return { success: true, meta: d1Meta(result) };
  }
}

class TursoDatabase {
  constructor(private readonly client: Client) {}

  prepare(sql: string): TursoStatement {
    return new TursoStatement(this.client, sql);
  }

  async batch(statements: TursoStatement[]) {
    if (!statements.length) return [];
    const results = await this.client.batch(
      statements.map((statement) => ({ sql: statement.sql, args: statement.args as never })),
      "write",
    );
    return results.map((result) => ({ success: true, meta: d1Meta(result) }));
  }
}

let reportsSchemaReady = false;
const SCHEMA_KEY = "schema_v";
const SCHEMA_VERSION = "2";

async function ensureReportSchema(env: AppEnv): Promise<void> {
  if (reportsSchemaReady) return;
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
      .bind(SCHEMA_KEY)
      .first<{ value: string }>();
    if (row?.value === SCHEMA_VERSION) {
      reportsSchemaReady = true;
      return;
    }
  } catch {}
  try {
    await env.DB.prepare("ALTER TABLE threads ADD COLUMN reported_at INTEGER NOT NULL DEFAULT 0").run();
  } catch {}
  try {
    await env.DB.prepare("ALTER TABLE threads ADD COLUMN report_reason TEXT").run();
  } catch {}
  try {
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_threads_reported ON threads (reported_at)").run();
  } catch {}
  try {
    await env.DB.prepare("ALTER TABLE threads ADD COLUMN last_role TEXT NOT NULL DEFAULT ''").run();
  } catch {}
  try {
    await env.DB.prepare(
      `UPDATE threads
       SET last_role = COALESCE((
         SELECT role FROM messages m WHERE m.thread_id = threads.id ORDER BY m.created_at DESC LIMIT 1
       ), '')
       WHERE last_role = ''`,
    ).run();
  } catch {}
  try {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(SCHEMA_KEY, SCHEMA_VERSION)
      .run();
  } catch {}
  reportsSchemaReady = true;
}

let tursoCache: { url: string; token: string; client: Client } | null = null;

function useTurso(env: AppEnv): AppEnv {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) return env;
  if (!tursoCache || tursoCache.url !== env.TURSO_DATABASE_URL || tursoCache.token !== env.TURSO_AUTH_TOKEN) {
    tursoCache = {
      url: env.TURSO_DATABASE_URL,
      token: env.TURSO_AUTH_TOKEN,
      client: createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN }),
    };
  }
  return {
    ...env,
    DB: new TursoDatabase(tursoCache.client) as unknown as D1Database,
  };
}

const RECOVERY_KEYS = ["tangbao.v1", "tangbao.visitor", "tangbao.model", "tangbao.presence"] as const;

const RECOVERY_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.00 9.60Q13.83 4.58 18.17 4.13A1.20 1.20 0 0 1 19.87 5.83Q14.24 6.48 12.00 9.60ZM13.54 10.16Q18.17 7.50 21.79 9.94A1.20 1.20 0 0 1 21.99 12.33Q17.27 9.21 13.54 10.16ZM14.36 11.58Q19.62 12.52 20.82 16.71A1.20 1.20 0 0 1 19.45 18.68Q17.83 13.25 14.36 11.58ZM14.08 13.20Q17.51 17.30 15.73 21.28A1.20 1.20 0 0 1 13.41 21.90Q15.66 16.70 14.08 13.20ZM12.82 14.26Q12.82 19.60 8.89 21.50A1.20 1.20 0 0 1 6.72 20.49Q11.78 17.96 12.82 14.26ZM11.18 14.26Q7.74 18.34 3.51 17.28A1.20 1.20 0 0 1 2.50 15.11Q8.00 16.42 11.18 14.26ZM9.92 13.20Q4.66 14.12 2.10 10.59A1.20 1.20 0 0 1 2.72 8.27Q6.10 12.82 9.92 13.20ZM9.64 11.58Q5.01 8.91 5.32 4.55A1.20 1.20 0 0 1 7.29 3.18Q6.95 8.83 9.64 11.58ZM10.46 10.16Q8.64 5.14 11.67 2.01A1.20 1.20 0 0 1 14.06 2.21Q10.17 6.33 10.46 10.16Z"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/></svg>`;

function recoveryShell(title: string, content: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f7f2e8"><title>${title} · 糖包</title>
<style>
:root{--paper:#f7f2e8;--panel:#fffdf8;--ink:#2a241e;--ink2:#5f5448;--faint:#8d7f6e;--accent:#a45a3a;--line:#ddd2c1;--line2:#cbbda9;--serif:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif}
@media (prefers-color-scheme:dark){:root{--paper:#1c1916;--panel:#26211c;--ink:#f1e9dd;--ink2:#cabba8;--faint:#8f8172;--accent:#d58a5f;--line:#3d342b;--line2:#4c4035}}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 0,color-mix(in srgb,var(--panel) 88%,var(--accent)) 0,var(--paper) 55%);color:var(--ink);font:14px/1.75 system-ui,"Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.card{position:relative;width:min(30rem,100%);overflow:hidden;padding:34px 32px 28px;border:1px solid var(--line);border-radius:22px;background:var(--panel);box-shadow:0 28px 80px -58px #2a241e;text-align:center}
.card::before{position:absolute;top:0;left:30px;width:44px;height:3px;border-radius:0 0 3px 3px;background:var(--accent);content:""}
.brand{display:inline-flex;align-items:center;gap:8px;color:var(--accent);font-family:var(--serif);font-size:14px;font-weight:600;letter-spacing:.12em}
.brand svg{display:block;width:26px;height:26px}
.kicker{margin:22px 0 6px;color:var(--accent);font-family:var(--serif);font-size:10px;font-weight:600;letter-spacing:.16em}
h1{margin:0;font-family:var(--serif);font-size:25px;font-weight:600;line-height:1.35;letter-spacing:.02em}
.lead{max-width:22rem;margin:13px auto 0;color:var(--ink2);font-size:13px;line-height:1.8;text-wrap:pretty}
.trail{display:flex;justify-content:center;gap:6px;margin:22px 0 0;padding:0;list-style:none;flex-wrap:wrap}
.trail li{padding:4px 8px;border:1px solid var(--line);border-radius:999px;color:var(--faint);font-size:10.5px;line-height:1.4}
.trail li.is-active{border-color:color-mix(in srgb,var(--accent) 28%,var(--line));background:color-mix(in srgb,var(--accent) 6%,var(--panel));color:var(--accent)}
.done-icon{display:grid;place-items:center;width:48px;height:48px;margin:18px auto 0;border:1px solid color-mix(in srgb,var(--accent) 28%,var(--line));border-radius:50%;background:color-mix(in srgb,var(--accent) 6%,var(--panel));color:var(--accent);font-family:var(--serif);font-size:23px}
.fallback{display:block;width:100%;margin-top:22px;padding-top:13px;border-top:1px dashed var(--line2);color:var(--faint);font-size:11.5px;text-decoration:none}
.fallback:hover{color:var(--accent)}
@media (max-width:640px){body{padding:16px}.card{padding:28px 20px 24px;border-radius:18px}.card::before{left:20px}h1{font-size:22px}.lead{font-size:12.5px}}
</style></head>
<body><main class="card"><div class="brand">${RECOVERY_MARK}<span>糖包</span></div>${content}</main></body></html>`;
}

function recoveryPage(origin: string, stage: "workers" | "done"): string {
  const action = JSON.stringify(`${origin}/__recover`);
  const chat = JSON.stringify(`${origin}/chat?recovered=0`);
  const next = stage === "workers"
    ? JSON.stringify("https://tangbao.sbuiwqvb110.workers.dev/__recover?stage=done")
    : chat;
  return recoveryShell("找回旧对话", `
<p class="kicker">账号与旧对话</p>
<h1>正在找回旧对话</h1>
<p class="lead">正在读取这台浏览器里的匿名记录，找到后会迁回正式站点。</p>
<ul class="trail"><li class="is-active">当前页面</li><li>HTTP</li><li>workers.dev</li></ul>
<a class="fallback" href="${chat}">迟迟没有跳转？回到聊天</a>
<script>
(() => {
  const data = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("tangbao.")) data[key] = localStorage.getItem(key) || "";
    }
  } catch {}
  if (!data["tangbao.v1"]) { location.replace(${next}); return; }
  const form = document.createElement("form");
  form.method = "post";
  form.action = ${action};
  form.style.display = "none";
  const input = document.createElement("textarea");
  input.name = "payload";
  input.value = JSON.stringify(data);
  form.append(input);
  document.body.append(form);
  window.setTimeout(() => form.submit(), 120);
})();
</script>`);
}

function recoveryDonePage(payload: Record<string, string>): string {
  const data = JSON.stringify(JSON.stringify(payload)).replace(/</g, "\\u003c");
  return recoveryShell("旧对话已找回", `
<p class="kicker">找到了</p>
<div class="done-icon" aria-hidden="true">✓</div>
<h1>旧对话已经找回</h1>
<p class="lead">正在把记录放回聊天列表，稍等片刻。</p>
<a class="fallback" href="/chat?recovered=1">如果没有自动跳转，点这里回到聊天</a>
<script>
(() => {
  const data = JSON.parse(${data});
  let current = {};
  try { current = JSON.parse(localStorage.getItem("tangbao.v1") || "{}") || {}; } catch {}
  let incoming = null;
  try { incoming = data["tangbao.v1"] ? JSON.parse(data["tangbao.v1"]) : null; } catch {}
  if (incoming && typeof incoming === "object") {
    const threads = new Map();
    for (const thread of [...(Array.isArray(current.threads) ? current.threads : []), ...(Array.isArray(incoming.threads) ? incoming.threads : [])]) {
      if (thread && typeof thread.id === "string") threads.set(thread.id, thread);
    }
    const merged = { ...current, ...incoming, threads: [...threads.values()], activeId: current.activeId ?? incoming.activeId ?? null };
    localStorage.setItem("tangbao.v1", JSON.stringify(merged));
  }
  for (const key of ["tangbao.visitor", "tangbao.model", "tangbao.presence"]) {
    if (typeof data[key] === "string") localStorage.setItem(key, data[key]);
  }
  window.setTimeout(() => location.replace("/chat?recovered=1"), 560);
})();
</script>`);
}

async function recoverSession(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const origin = env.APP_ORIGIN?.replace(/\/$/, "");
  if (!origin) return new Response("恢复入口暂不可用。", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  if (request.method === "GET") {
    const stage = url.searchParams.get("stage") === "workers" ? "workers" : "done";
    return new Response(recoveryPage(origin, stage), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
  if (request.method !== "POST" || url.protocol !== "https:") return new Response("不支持的恢复请求。", { status: 405 });
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const host = new URL(referer).hostname;
      if (!(host === "phaeris.cn" || host.endsWith(".phaeris.cn") || host.endsWith(".workers.dev"))) return new Response("来源不正确。", { status: 403 });
    } catch { return new Response("来源不正确。", { status: 403 }); }
  }
  if (Number(request.headers.get("content-length") || "0") > 1_500_000) return new Response("记录过大，无法自动迁移。", { status: 413 });
  let form: FormData;
  try { form = await request.formData(); } catch { return new Response("记录格式不正确。", { status: 400 }); }
  const raw = String(form.get("payload") || "");
  if (!raw || raw.length > 1_500_000) return new Response("没有找到可迁移的记录。", { status: 400 });
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    parsed = value as Record<string, unknown>;
  } catch { return new Response("记录格式不正确。", { status: 400 }); }
  const clean: Record<string, string> = {};
  for (const key of RECOVERY_KEYS) {
    const value = parsed[key];
    if (typeof value === "string" && value.length <= 1_500_000) clean[key] = value;
  }
  if (!Object.keys(clean).length) return new Response("没有找到可迁移的记录。", { status: 400 });
  return new Response(recoveryDonePage(clean), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/__recover") return recoverSession(request, env, requestUrl);
    const appOrigin = env.APP_ORIGIN?.replace(/\/$/, "");
    if (appOrigin && !localHost(requestUrl.hostname)) {
      try {
        const canonical = new URL(appOrigin);
        if (requestUrl.protocol !== "https:" || requestUrl.host !== canonical.host) {
          return Response.redirect(`${canonical.origin}${requestUrl.pathname}${requestUrl.search}`, 308);
        }
      } catch {}
    }
    if (env.MAINTENANCE === "1") {
      const api = new URL(request.url).pathname.startsWith("/api/");
      const message = "站点正在维护，请稍后再试。";
      return new Response(
        request.method === "HEAD" ? null : api ? JSON.stringify({ error: message, code: "MAINTENANCE" }) : message,
        {
          status: 503,
          headers: {
            "content-type": api ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": "60",
          },
        },
      );
    }
    try {
      const scoped = useTurso(env);
      await ensureReportSchema(scoped);
      const url = new URL(request.url);
      const pagedModels =
        url.pathname === "/api/models" && (url.searchParams.has("q") || url.searchParams.has("page"));
      const ttl = request.method === "GET" ? (pagedModels ? 30 : PUBLIC_CACHE_TTL[url.pathname]) : 0;
      if (ttl) {
        const cacheKey = new Request(url.toString(), { method: "GET" });
        let hit: Response | undefined;
        try {
          hit = await caches.default.match(cacheKey);
        } catch {}
        if (hit) return hit;
        const response = await route(request, scoped, ctx);
        if (response.ok) {
          const headers = new Headers(response.headers);
          headers.set("cache-control", `public, max-age=${ttl}, s-maxage=${ttl}`);
          const cached = new Response(response.body, { status: response.status, headers });
          try {
            ctx.waitUntil(caches.default.put(cacheKey, cached.clone()));
          } catch {}
          return cached;
        }
        return response;
      }
      return await route(request, scoped, ctx);
    } catch (err) {
      if (err instanceof AuthError) return json({ error: err.message, code: err.code }, err.status);
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
    if (env.MAINTENANCE === "1") return;
    ctx.waitUntil(refreshHomePresence(useTurso(env)));
    ctx.waitUntil(processMailOutbox(useTurso(env)));
  },
  async queue(batch, env): Promise<void> {
    if (env.MAINTENANCE === "1") {
      batch.retryAll({ delaySeconds: 60 });
      return;
    }
    await consumeMailEvents(batch, useTurso(env));
  },
} satisfies ExportedHandler<AppEnv>;

async function route(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(method)) assertOrigin(request, env);
  const authenticated = await authRoute(request, env);
  if (authenticated) {
    if (method === "POST" && /\/api\/auth\/(register|email\/resend|email\/change|password\/forgot)$/.test(path)) ctx.waitUntil(processMailOutbox(env));
    return path === "/api/auth/me" ? withGuestCookie(request, env, authenticated) : authenticated;
  }
  const accountResponse = await accountBusinessRoute(request, env);
  if (accountResponse) return accountResponse;
  const accountDisable = path.match(/^\/api\/admin\/accounts\/([A-Za-z0-9_-]{16,80})\/disable$/);
  if (accountDisable && method === "POST") {
    await requireSuper(request, env);
    const account = await requireAccount(request, env);
    if (account.id === accountDisable[1]) throw new AuthError(409, "SELF_DISABLE", "请由另一位管理员处理当前账号停用。");
    await disableAccount(env, accountDisable[1]);
    return json({ ok: true });
  }

  if (path === "/api/status" && method === "GET") return json(await siteStatus(env));
  if (path === "/api/models" && method === "GET") return listModels(env, url);
  if (path === "/api/presence" && method === "GET") return json(await presenceHistory(env));
  if (path === "/api/threads" && method === "POST") return createThread(request, env, ctx);
  if (path === "/api/applications" && method === "POST") return applyModel(request, env, ctx);
  if (path === "/api/applications/mine" && method === "GET") return myApplication(request, env);
  const application = path.match(/^\/api\/applications\/([A-Za-z0-9_-]{16,80})$/);
  if (application && method === "GET") return applicationStatus(request, env, application[1]);
  if (path === "/api/admin/login" && method === "POST") return login(request, env);
  if (path === "/api/admin/logout" && method === "POST") return (await authRoute(new Request(new URL("/api/auth/logout", request.url), request), env))!;
  if (path === "/api/admin/queue" && method === "GET") return queue(request, env);
  if (path === "/api/admin/profile" && method === "GET") return readProfile(request, env);
  if (path === "/api/admin/profile" && method === "POST") return saveProfile(request, env);
  if (path === "/api/admin/audit" && method === "GET") return audit(request, env);
  if (path === "/api/admin/pool" && method === "GET") return pool(request, env);
  if (path === "/api/admin/applications" && method === "GET") return listApplications(request, env);
  if (path === "/api/admin/applications/auto-approve" && method === "POST") return setAutoApprove(request, env);
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
  if (image && method === "GET") return serveImage(request, env, image[1]);

  const adminPin = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{16,80})\/pin$/);
  if (adminPin && method === "POST") return pinThread(request, env, adminPin[1]);
  const adminRename = path.match(/^\/api\/admin\/threads\/([A-Za-z0-9_-]{16,80})\/rename$/);
  if (adminRename && method === "POST") return renameAdminThread(request, env, adminRename[1]);

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

  const report = path.match(/^\/api\/threads\/([A-Za-z0-9_-]{16,80})\/report$/);
  if (report && method === "POST") return reportThread(request, env, report[1]);

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
    const response = new Response(method === "HEAD" ? null : page, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
    return method === "GET" && ["/chat", "/chat.html"].includes(path) ? withGuestCookie(request, env, response) : response;
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
    path === "/assets/account.js" ? accountJs : path === "/assets/app.js" ? appJs : path === "/assets/desk.js" ? deskJs : path === "/assets/md.js" ? mdJs : null;
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
      `SELECT COUNT(*) AS n, MIN(updated_at) AS oldest FROM threads WHERE awaiting = 1 AND queued = 0 AND operator_id = ? AND ${unblockedThread("threads")}`,
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

async function loadPresence(env: AppEnv, now = Date.now(), activeOnly = false): Promise<{ home: Presence; operators: Presence[] }> {
  const [home, rows] = await Promise.all([
    homePresence(env, now),
    env.DB.prepare(
      `SELECT o.id, o.active, o.blurb, CASE WHEN ${OWNER_READY} THEN o.last_seen_at ELSE 0 END AS last_seen_at, o.last_reply_at, o.last_assigned_at,
        COALESCE(p.n, 0) AS pending, p.oldest AS oldest_pending_at
       FROM operators o
       LEFT JOIN (
         SELECT t.operator_id, COUNT(*) AS n, MIN(t.updated_at) AS oldest
         FROM threads t
         JOIN operators o2 ON o2.id = t.operator_id
         WHERE t.awaiting = 1 AND t.queued = 0
           AND ${unblockedThread("t")}
           ${activeOnly ? "AND o2.active = 1" : ""}
         GROUP BY t.operator_id
       ) p ON p.operator_id = o.id
       ${activeOnly ? "WHERE o.active = 1 AND " + OWNER_READY : ""}
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

function presenceFromRow(row: PresenceRow, now: number): Presence {
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
}

async function operatorPresence(env: AppEnv, operatorId: string, now = Date.now(), seat?: Seat): Promise<Presence> {
  if (operatorId === HOME_MODEL) return homePresence(env, now);
  const ownership = seat ? seatOwnership(seat, "o.id") : { sql: "1=1", values: [] };
  const row = await env.DB.prepare(
    `SELECT o.id, o.active, o.blurb, CASE WHEN ${OWNER_READY} THEN o.last_seen_at ELSE 0 END AS last_seen_at, o.last_reply_at, o.last_assigned_at,
       (SELECT COUNT(*) FROM threads t
        WHERE t.operator_id = o.id AND t.awaiting = 1 AND t.queued = 0
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE ${threadBlockMatch("t", "o.id")}
          )) AS pending,
       (SELECT MIN(t.updated_at) FROM threads t
        WHERE t.operator_id = o.id AND t.awaiting = 1 AND t.queued = 0
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE ${threadBlockMatch("t", "o.id")}
          )) AS oldest_pending_at
     FROM operators o
     WHERE o.id = ? AND ${ownership.sql}`,
  )
    .bind(operatorId, ...ownership.values)
    .first<PresenceRow>();
  if (!row) {
    return {
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
  return presenceFromRow(row, now);
}

async function operatorPresent(env: AppEnv, operatorId: string): Promise<boolean> {
  const presence = await operatorPresence(env, operatorId);
  return presence.status === "online" || presence.status === "busy";
}

async function touchSeat(env: AppEnv, seat: Seat, now: number): Promise<void> {
  try {
    if (seat.super && seat.operatorId === HOME_MODEL) {
      await env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(settings.value AS INTEGER) < ?`,
      )
        .bind(HOME_SEEN_KEY, String(now), now - HEARTBEAT_WRITE)
        .run();
      return;
    }
    if (seat.super && !seat.operatorId) return;
    if (seat.super) {
      await env.DB.prepare("UPDATE operators SET last_seen_at = ? WHERE id = ? AND owner_account_id = ? AND last_seen_at < ?")
        .bind(now, seat.operatorId, seat.accountId, now - HEARTBEAT_WRITE)
        .run();
      return;
    }
    await env.DB.prepare("UPDATE operators SET last_seen_at = ? WHERE operator_uid = ? AND owner_account_id = ? AND last_seen_at < ?")
      .bind(now, seat.operatorUid, seat.accountId, now - HEARTBEAT_WRITE)
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

async function touchReply(env: AppEnv, seat: Seat, now: number): Promise<void> {
  if (seat.super) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(HOME_REPLY_KEY, String(now))
      .run();
    return;
  }
  await env.DB.prepare("UPDATE operators SET last_reply_at = ? WHERE operator_uid = ? AND owner_account_id = ?")
    .bind(now, seat.operatorUid, seat.accountId).run();
}

async function touchAssigned(env: AppEnv, operatorId: string, now: number, seat?: Seat): Promise<void> {
  if (operatorId === HOME_MODEL) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(HOME_ASSIGNED_KEY, String(now))
      .run();
    return;
  }
  if (seat && !seat.super) {
    await env.DB.prepare("UPDATE operators SET last_assigned_at = ? WHERE operator_uid = ? AND owner_account_id = ?").bind(now, seat.operatorUid, seat.accountId).run();
  } else await env.DB.prepare("UPDATE operators SET last_assigned_at = ? WHERE id = ?").bind(now, operatorId).run();
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
const OWNER_READY = "EXISTS(SELECT 1 FROM accounts owner WHERE owner.id=o.owner_account_id AND owner.status='active' AND owner.verified_at>0)";

async function createThread(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const account = await getAccount(request, env);
  if (account && !account.verified) throw new AuthError(403, "EMAIL_UNVERIFIED", "请先验证邮箱，再开启新对话。");
  const guest = account ? null : await getGuest(request, env);
  if (!account && !guest) return withGuestCookie(request, env, json({ code: "GUEST_IDENTITY_REQUIRED", error: "浏览器身份已准备好，请重新发送。" }, 409));
  const requestKey = request.headers.get("idempotency-key") || "";
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(requestKey)) throw new AuthError(400, "IDEMPOTENCY_REQUIRED", "请刷新页面后再发送。");
  const incoming = await readIncoming(request, "先写一句，或放一张图。");
  const imageHashes = await Promise.all(incoming.images.map(async image => ({ type: image.type, hash: await sha256Bytes(image.bytes) })));
  const fingerprint = await sha256(JSON.stringify({ body: incoming.body, draw: incoming.draw, operator: incoming.operator, images: imageHashes }));
  const subject = account ? `a:${account.id}` : `g:${guest!.id}`;
  const replay = async (): Promise<Response | null> => {
    const existing = await env.DB.prepare("SELECT fingerprint,thread_id,token_ciphertext FROM thread_creations WHERE subject=? AND request_key=?")
      .bind(subject, requestKey).first<{ fingerprint: string; thread_id: string; token_ciphertext: string | null }>();
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint) throw new AuthError(409, "IDEMPOTENCY_CONFLICT", "这次发送标识已用于另一条内容，请重新发送。");
    const thread = await env.DB.prepare("SELECT account_id FROM threads WHERE id=?").bind(existing.thread_id).first<{ account_id: string | null }>();
    if (!thread) throw new AuthError(410, "THREAD_DELETED", "这段对话已删除，不能通过重试重新创建。");
    if (!existing.token_ciphertext || (thread.account_id && thread.account_id !== account?.id)) throw new AuthError(401, "AUTH_REQUIRED", "这段对话已关联账号，请登录后查看。");
    return json(await decryptReplay(env, existing.token_ciphertext));
  };
  const previous = await replay();
  if (previous) return previous;
  const visitor = await visitorHash(request), ip = await clientHash(request);
  if (guest && visitor) {
    // Legacy history can only consume quota, never prove ownership or restore it.
    await env.DB.prepare("UPDATE guest_identities SET created_count=1 WHERE id=? AND created_count=0 AND EXISTS(SELECT 1 FROM threads WHERE visitor_hash=?)").bind(guest.id, visitor).run();
  }
  if (guest && !(await env.DB.prepare("SELECT id FROM guest_identities WHERE id=? AND created_count=0").bind(guest.id).first())) {
    const previous = await replay(); if (previous) return previous;
    throw new AuthError(401, "AUTH_REQUIRED", "第一段可以继续聊。开启新对话前，请注册并验证邮箱。");
  }
  const identities = [visitor, accountBlockKey(account?.id)];
  if (await isBlocked(env, identities, undefined, [ip])) throw new HttpError(403, BLOCKED);
  if (!(await allow(env, `thread:${ip}`, 8, HOUR))) throw new HttpError(429, "新对话先歇一会儿。他一次看不了这么多开头。");
  const assignment = await assignOperator(env, incoming.operator, identities, [ip]);
  if (assignment.id !== POOL_MODEL && await isBlocked(env, identities, assignment.id, [ip])) throw new HttpError(403, "这个模型暂时不接你的话。");
  await assertQueue(env, false);
  const id = randomId(16), token = randomId(32), now = Date.now(), messageId = randomId(16);
  const operator = assignment.id, queued = assignment.queued ? 1 : 0;
  const autoHome = queued || (operator === HOME_MODEL && assignment.requested !== HOME_MODEL) ? 1 : 0;
  const shown = caption(incoming.body, incoming.images.length), title = titleFrom(shown);
  const preview = previewFrom(incoming.draw ? `要一张图 · ${shown}` : shown);
  const payload = { id, token, title, operator, requested: assignment.requested, fallback: assignment.fallback, queued: Boolean(queued) };
  const encrypted = await encryptReplay(env, payload);
  const stored: { id: string; key: string; type: string }[] = [];
  const cleanup = () => Promise.all(stored.map(image => env.IMAGES.delete(image.key)));
  let written = false;
  let batchStarted = false;
  try {
    for (const image of incoming.images) {
      const imageId = randomId(16), key = `img/${imageId}`;
      await env.IMAGES.put(key, image.bytes);
      stored.push({ id: imageId, key, type: image.type });
    }
    const condition = account
      ? "EXISTS(SELECT 1 FROM accounts WHERE id=? AND verified_at>0 AND status='active')"
      : "EXISTS(SELECT 1 FROM guest_identities WHERE id=? AND created_count=0)";
    const statements = [
      env.DB.prepare(`INSERT INTO thread_creations(subject,request_key,fingerprint,thread_id,token_ciphertext,created_at)
        SELECT ?,?,?,?,?,? WHERE ${condition} ON CONFLICT(subject,request_key) DO NOTHING`)
        .bind(subject, requestKey, fingerprint, id, encrypted, now, account?.id || guest!.id),
      env.DB.prepare(`INSERT INTO threads(id,token_hash,title,preview,created_at,updated_at,awaiting,visitor_hash,ip_hash,operator_id,auto_home,queued,last_role,account_id,guest_identity_id)
        SELECT ?,?,?,?,?,?,1,?,?,?,?,?,'visitor',?,? WHERE changes()=1`)
        .bind(id, await sha256(token), title, preview, now, now, visitor || null, ip, operator, autoHome, queued, account?.id || null, guest?.id || null),
      env.DB.prepare("INSERT INTO messages(id,thread_id,role,body,draw,created_at) SELECT ?,?,'visitor',?,?,? WHERE EXISTS(SELECT 1 FROM threads WHERE id=?)")
        .bind(messageId, id, incoming.body, incoming.draw ? 1 : 0, now, id),
      ...stored.map((image, position) => env.DB.prepare(`INSERT INTO message_images(id,message_id,image_key,image_type,position)
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM threads WHERE id=?)`).bind(image.id, messageId, image.key, image.type, position, id)),
    ];
    if (guest) statements.push(env.DB.prepare("UPDATE guest_identities SET created_count=created_count+1 WHERE id=? AND EXISTS(SELECT 1 FROM threads WHERE id=?)").bind(guest.id, id));
    batchStarted = true;
    const results = await env.DB.batch(statements);
    written = results[1].meta.changes === 1;
    if (!written) {
      await cleanup();
      const previous = await replay();
      if (previous) return previous;
      throw new AuthError(401, "AUTH_REQUIRED", "第一段可以继续聊。开启新对话前，请注册并验证邮箱。");
    }
  } catch (error) {
    if (!written && batchStarted) {
      try {
        // A lost provider response does not prove rollback. Never delete linked KV data.
        written = Boolean(await env.DB.prepare("SELECT id FROM threads WHERE id=?").bind(id).first());
      } catch {
        throw new AuthError(503, "CREATION_UNKNOWN", "发送结果暂时无法确认，请保留内容，使用同一次发送重试。");
      }
    }
    if (!written) { await cleanup(); throw error; }
  }
  await touchAssigned(env, operator, now);
  noteVisitor(ctx, env, request, title, preview, operator, true);
  return json(payload);
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function readThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const thread = await loadOwned(env, id, bearer(request), request);
  const seen = await attachIdentity(env, thread, request, thread.operator_id);
  const [messages, operator] = await Promise.all([
    listMessages(env, id),
    operatorPresence(env, thread.operator_id),
  ]);
  const status = statusPayload(publicPresence(operator.status));
  return json({
    title: thread.title,
    operator: thread.operator_id,
    awaiting: thread.awaiting === 1,
    queued: thread.queued === 1,
    reported: thread.reported_at > 0,
    blocked: seen.blocked,
    messages,
    status,
    operatorStatus: status,
  });
}

async function deleteThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  await loadOwned(env, id, bearer(request), request);
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

function reportReasonOf(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "写一下举报原因。");
  const text = sanitize(value);
  if ([...text].length < 2) throw new HttpError(400, "写一下举报原因。");
  if ([...text].length > 500) throw new HttpError(400, "举报原因太长了。");
  return text;
}

async function reportThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const thread = await loadOwned(env, id, bearer(request), request);
  const seen = await attachIdentity(env, thread, request, thread.operator_id);
  if (seen.blocked) throw new HttpError(403, BLOCKED);
  if (thread.queued === 1 || thread.operator_id === POOL_MODEL) {
    throw new HttpError(400, "这条还没有模型接手。");
  }
  if (!(await allow(env, `report:${thread.token_hash}`, 3, HOUR))) {
    throw new HttpError(429, "举报先歇一会儿。");
  }
  const payload = await readJson(request);
  const reason = reportReasonOf(payload.reason);
  const result = await env.DB.prepare(
    "UPDATE threads SET reported_at = ?, report_reason = ? WHERE id = ? AND reported_at = 0",
  )
    .bind(Date.now(), reason, id)
    .run();
  if (result.meta.changes !== 1) return json({ ok: true, already: true });
  return json({ ok: true });
}

async function visitorMessage(request: Request, env: AppEnv, id: string, ctx: ExecutionContext): Promise<Response> {
  const token = bearer(request);
  const thread = await loadOwned(env, id, token, request);
  const seen = await attachIdentity(env, thread, request, thread.operator_id);
  if (seen.blocked) throw new HttpError(403, BLOCKED);
  if (!(await allow(env, `msg:${thread.token_hash}`, 30, HOUR))) {
    throw new HttpError(429, "今天的字已经够多了。让他的手指歇一会儿。");
  }
  const incoming = await readIncoming(request, "先写一句，或放一张图。");
  if (thread.operator_id !== HOME_MODEL && thread.queued !== 1) {
    const row = await env.DB.prepare(`SELECT o.active,${OWNER_READY} AS owner_ready FROM operators o WHERE id = ?`)
      .bind(thread.operator_id)
      .first<{ active: number; owner_ready: number }>();
    if (!row || row.active !== 1 || !row.owner_ready) throw new HttpError(400, "这个模型不在。");
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
    const proof = await issueSession(request, env, { super: true, operatorId: HOME_MODEL });
    return json({ code: "LEGACY_MIGRATION_REQUIRED", error: "管理员需由部署者绑定已验证账号后登录。", operatorId: HOME_MODEL }, 403, proof.headers);
  }
  const hash = await sha256(given);
  const operator = await env.DB.prepare("SELECT id, active FROM operators WHERE password_hash = ? AND owner_account_id IS NULL AND legacy_claimed_at=0")
    .bind(hash)
    .first<{ id: string; active: number }>();
  if (!operator || operator.active !== 1) throw new HttpError(401, "这句口令不对。");
  const proof = await issueSession(request, env, { super: false, operatorId: operator.id });
  return json({ code: "LEGACY_MIGRATION_REQUIRED", error: "请注册并验证账号，然后绑定原模型。", operatorId: operator.id }, 403, proof.headers);
}

function logout(request: Request): Response {
  return json({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
}

async function readProfile(request: Request, env: AppEnv): Promise<Response> {
  const seat = await requireSeat(request, env);
  if (seat.super && !seat.operatorId) return json({ super: true, operatorId: null, id: null, needsModel: true });
  if (seat.super && seat.operatorId === HOME_MODEL) return json({ super: true, operatorId: HOME_MODEL, id: HOME_MODEL });
  const row = await env.DB.prepare("SELECT id, blurb FROM operators WHERE operator_uid = ? AND owner_account_id = ?")
    .bind(seat.operatorUid, seat.accountId)
    .first<{ id: string; blurb: string | null }>();
  if (!row) throw new HttpError(404, "这个型号不在了。");
  return json({
    id: row.id,
    suffix: row.id.startsWith("tangbao-") ? row.id.slice("tangbao-".length) : row.id,
    blurb: row.blurb || "",
  });
}

async function saveProfile(request: Request, env: AppEnv): Promise<Response> {
  const seat = await requireSeat(request, env);
  if (seat.super && !seat.operatorId) throw new HttpError(409, "请先绑定模型，再修改模型资料。");
  if (seat.super && seat.operatorId === HOME_MODEL) throw new HttpError(403, "糖包本人不用改型号。");
  const payload = await readJson(request);
  const suffix = modelSuffix(payload.suffix);
  if (!suffix) throw new HttpError(400, "型号后面要写成小写字母、数字和短横线。");
  if (suffix === "vme50-flash" || suffix === "pool") throw new HttpError(400, "这个型号留给自己用。");
  const blurb = blurbOf(payload.blurb);
  const oldId = seat.operatorId;
  const newId = `tangbao-${suffix}`;
  if (newId === oldId) {
    const result = await env.DB.prepare("UPDATE operators SET blurb = ? WHERE id = ? AND operator_uid = ? AND owner_account_id = ? AND active = 1 AND EXISTS(SELECT 1 FROM accounts WHERE id = ? AND status = 'active' AND verified_at > 0)")
      .bind(blurb, oldId, seat.operatorUid, seat.accountId, seat.accountId).run();
    if (!result.meta.changes) throw new AuthError(409, "MODEL_CHANGED", "模型资料刚刚发生变化，请刷新后重试。");
    return json({ ok: true, id: oldId, suffix, blurb });
  }
  const conflict = await env.DB.prepare(
    `SELECT 1 AS hit FROM operators WHERE id = ?
     UNION ALL
     SELECT 1 FROM applications WHERE suffix = ? AND status IN ('pending', 'approved')
     LIMIT 1`,
  )
    .bind(newId, suffix)
    .first<{ hit: number }>();
  if (conflict) throw new HttpError(409, "这个型号已经有人了。");
  // The model stays at oldId until the final statement. Every reference migration
  // independently verifies the immutable identity inside the same write transaction.
  const guard = seatOwnership(seat, "?", [oldId]);
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(`UPDATE threads SET operator_id = ? WHERE operator_id = ? AND ${guard.sql}`).bind(newId, oldId, ...guard.values),
      env.DB.prepare(`UPDATE applications SET operator_id = ?, suffix = ? WHERE operator_id = ? AND ${guard.sql}`).bind(newId, suffix, oldId, ...guard.values),
      env.DB.prepare(`UPDATE push_subscriptions SET operator_id = ? WHERE operator_id = ? AND ${guard.sql}`).bind(newId, oldId, ...guard.values),
      env.DB.prepare(`INSERT OR IGNORE INTO blocks(id,operator_id,created_at) SELECT id,?,created_at FROM blocks WHERE operator_id=? AND ${guard.sql}`).bind(newId, oldId, ...guard.values),
      env.DB.prepare(`DELETE FROM blocks WHERE operator_id=? AND ${guard.sql}`).bind(oldId, ...guard.values),
      env.DB.prepare(`UPDATE operators SET id = ?, blurb = ? WHERE id = ? AND ${guard.sql}`)
        .bind(newId, blurb, oldId, ...guard.values),
    ]);
  } catch { throw new AuthError(409, "MODEL_CHANGED", "型号或归属刚刚发生变化，请刷新后重试。"); }
  if (!results[results.length - 1].meta.changes) throw new AuthError(409, "MODEL_CHANGED", "型号或归属刚刚发生变化，请刷新后重试。");
  return json({ ok: true, id: newId, suffix, blurb });
}

function modelJson(row: Presence) {
  return {
    id: row.id,
    home: row.home,
    blurb: row.blurb,
    online: row.status === "online",
    status: publicPresence(row.status),
    awake: row.status === "online",
    pending: row.pending,
    lastSeenAt: row.lastSeenAt,
    lastReplyAt: row.lastReplyAt,
  };
}

async function listModels(env: AppEnv, url: URL): Promise<Response> {
  const now = Date.now();
  const q = (url.searchParams.get("q") || "").trim().slice(0, MODEL_SEARCH_MAX);
  const pageValue = Number(url.searchParams.get("page") || "1");
  const page = Number.isFinite(pageValue) ? Math.max(1, Math.min(1000, Math.floor(pageValue))) : 1;
  const browse = Boolean(q) || url.searchParams.has("page");
  const auto = await autoModelId(env, now);

  if (!browse) {
    const home = await homePresence(env, now);
    const rows = await env.DB.prepare(
      `SELECT o.id, o.active, o.blurb, CASE WHEN ${OWNER_READY} THEN o.last_seen_at ELSE 0 END AS last_seen_at, o.last_reply_at, o.last_assigned_at,
        COALESCE(p.n, 0) AS pending, p.oldest AS oldest_pending_at
       FROM operators o
       LEFT JOIN (
         SELECT operator_id, COUNT(*) AS n, MIN(updated_at) AS oldest
         FROM threads t
         WHERE t.awaiting = 1 AND t.queued = 0 AND ${unblockedThread("t")}
         GROUP BY operator_id
       ) p ON p.operator_id = o.id
       WHERE o.active = 1 AND ${OWNER_READY}
         AND o.last_seen_at >= ?
         AND COALESCE(p.n, 0) < ?
         AND NOT (COALESCE(p.n, 0) > 0 AND p.oldest < ?)
       ORDER BY COALESCE(p.n, 0), o.last_assigned_at, o.id`,
    )
      .bind(now - ONLINE_TTL, PENDING_CAP, now - REPLY_TIMEOUT)
      .all<PresenceRow>();
    const operators = rows.results.map((row) => presenceFromRow(row, now));
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM operators o WHERE active = 1 AND ${OWNER_READY} AND last_seen_at >= ?`,
    )
      .bind(now - MODEL_RECENT_MS)
      .first<{ n: number }>();
    const total = Number(totalRow?.n) || 0;
    return json({
      models: [home, ...operators].map(modelJson),
      auto,
      hidden: Math.max(0, total - operators.length),
      total,
      page: 1,
      pageSize: 0,
      hasMore: false,
    });
  }

  const where = ["o.active = 1", OWNER_READY, "o.last_seen_at >= ?"];
  const bindings: unknown[] = [now - MODEL_RECENT_MS];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(o.id LIKE ? ESCAPE '\\' OR o.blurb LIKE ? ESCAPE '\\')");
    bindings.push(like, like);
  }
  const rows = await env.DB.prepare(
    `SELECT o.id, o.active, o.blurb, CASE WHEN ${OWNER_READY} THEN o.last_seen_at ELSE 0 END AS last_seen_at, o.last_reply_at, o.last_assigned_at,
      COALESCE(p.n, 0) AS pending, p.oldest AS oldest_pending_at
     FROM operators o
     LEFT JOIN (
       SELECT operator_id, COUNT(*) AS n, MIN(updated_at) AS oldest
       FROM threads t
       WHERE t.awaiting = 1 AND t.queued = 0 AND ${unblockedThread("t")}
       GROUP BY operator_id
     ) p ON p.operator_id = o.id
     WHERE ${where.join(" AND ")}
     ORDER BY o.last_seen_at DESC, o.id ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(...bindings, MODEL_PAGE_SIZE, (page - 1) * MODEL_PAGE_SIZE)
    .all<PresenceRow>();
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM operators o WHERE ${where.join(" AND ")}`,
  )
    .bind(...bindings)
    .first<{ n: number }>();
  const total = Number(totalRow?.n) || 0;
  return json({
    models: rows.results.map((row) => modelJson(presenceFromRow(row, now))),
    auto,
    hidden: 0,
    total,
    page,
    pageSize: MODEL_PAGE_SIZE,
    hasMore: page * MODEL_PAGE_SIZE < total,
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

type Assignment = { id: string; requested: string; fallback: boolean; queued: boolean };

async function autoModelId(env: AppEnv, now = Date.now(), identities: Array<string | null> = [], ipIdentities: Array<string | null> = []): Promise<string> {
  const ids = presentIds(...identities);
  const globalIds = presentIds(...ids, ...ipIdentities);
  const matches: string[] = [];
  if (ids.length) matches.push(`(b.operator_id=o.id AND b.id IN (${ids.map(() => "?").join(",")}))`);
  if (globalIds.length) matches.push(`(b.operator_id='*' AND b.id IN (${globalIds.map(() => "?").join(",")}))`);
  const blockFilter = matches.length ? `AND NOT EXISTS (SELECT 1 FROM blocks b WHERE ${matches.join(" OR ")})` : "";
  const row = await env.DB.prepare(
    `SELECT o.id
     FROM operators o
     LEFT JOIN (
       SELECT operator_id, COUNT(*) AS n, MIN(updated_at) AS oldest
       FROM threads t
       WHERE t.awaiting = 1 AND t.queued = 0 AND ${unblockedThread("t")}
       GROUP BY operator_id
     ) p ON p.operator_id = o.id
     WHERE o.active = 1 AND ${OWNER_READY}
       AND o.last_seen_at >= ?
       AND COALESCE(p.n, 0) < ?
       AND NOT (COALESCE(p.n, 0) > 0 AND p.oldest < ?)
       ${blockFilter}
     ORDER BY COALESCE(p.n, 0), o.last_assigned_at, o.id
     LIMIT 1`,
  )
    .bind(now - ONLINE_TTL, PENDING_CAP, now - REPLY_TIMEOUT, ...ids, ...globalIds)
    .first<{ id: string }>();
  return row?.id || HOME_MODEL;
}

async function assignOperator(env: AppEnv, value: string, identities: Array<string | null>, ipIdentities: Array<string | null>): Promise<Assignment> {
  const requested = /^tangbao-[a-z0-9-]+$/.test(value) ? value : "";
  if (requested === HOME_MODEL) {
    return { id: HOME_MODEL, requested, fallback: false, queued: false };
  }
  if (requested) {
    const explicit = await env.DB.prepare(`SELECT o.id FROM operators o WHERE o.id = ? AND o.active = 1 AND ${OWNER_READY}`)
      .bind(requested)
      .first<{ id: string }>();
    if (explicit) {
      return { id: explicit.id, requested, fallback: false, queued: false };
    }
  }
  const chosen = await autoModelId(env, Date.now(), identities, ipIdentities);
  if (chosen === HOME_MODEL) {
    return {
      id: POOL_MODEL,
      requested,
      fallback: Boolean(requested),
      queued: true,
    };
  }
  return {
    id: chosen,
    requested,
    fallback: Boolean(requested && requested !== chosen),
    queued: false,
  };
}

async function applyModel(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const account = await requireAccount(request, env);
  const ip = await clientHash(request);
  if (!(await allow(env, `apply:${ip}`, 5, HOUR))) throw new HttpError(429, "申请先歇一会儿。");
  if (await env.DB.prepare("SELECT id FROM operators WHERE owner_account_id=?").bind(account.id).first()) throw new AuthError(409, "MODEL_LIMIT", "当前账号已经有一个模型。");
  const payload = await readJson(request), suffix = modelSuffix(payload.suffix), blurb = blurbOf(payload.blurb);
  if (!suffix || suffix === "pool" || suffix === "vme50-flash") throw new HttpError(400, "型号后面要写成小写字母、数字和短横线，且不能使用站点保留型号。");
  if (!blurb) throw new HttpError(400, "写一句你擅长什么。");
  const existing = await env.DB.prepare("SELECT id,status,reason FROM applications WHERE account_id=? AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1")
    .bind(account.id).first<{ id: string; status: string; reason: string | null }>();
  if (existing) return json(applicationView(existing));
  const modelId = `tangbao-${suffix}`;
  const id = randomId(16), now = Date.now();
  try {
    const result = await env.DB.prepare(`INSERT INTO applications(id,suffix,email,blurb,status,visitor_hash,created_at,account_id)
      SELECT ?,?,?,?,'pending',?,?,? WHERE NOT EXISTS(SELECT 1 FROM operators WHERE owner_account_id=? OR id=?)
      AND NOT EXISTS(SELECT 1 FROM applications WHERE suffix=? AND status IN ('pending','approved'))
      AND EXISTS(SELECT 1 FROM accounts WHERE id=? AND verified_at>0 AND status='active')`)
      .bind(id, suffix, account.email, blurb, await visitorHash(request) || null, now, account.id, account.id, modelId, suffix, account.id).run();
    if (result.meta.changes !== 1) throw new AuthError(409, "APPLICATION_CONFLICT", "账号已有模型，或这个型号已经有人申请或在用。");
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(409, "APPLICATION_CONFLICT", "申请状态刚刚发生变化，请刷新后查看。");
  }
  if (await autoApproveEnabled(env)) {
    const approved = await approveModelApplication(env, id);
    noteApply(ctx, env, request, modelId, blurb);
    return json({ id, status: "approved", modelId: approved.modelId });
  }
  noteApply(ctx, env, request, modelId, blurb);
  return json({ id, status: "pending" });
}

function applicationView(row: { id?: string; status: string; reason?: string | null; operator_id?: string | null }) {
  return { id: row.id, status: row.status, reason: row.status === "rejected" ? row.reason || undefined : undefined, modelId: row.status === "approved" ? row.operator_id || undefined : undefined };
}

async function myApplication(request: Request, env: AppEnv): Promise<Response> {
  const account = await requireAccount(request, env);
  const row = await env.DB.prepare("SELECT id,status,reason,operator_id FROM applications WHERE account_id=? ORDER BY created_at DESC LIMIT 1")
    .bind(account.id).first<{ id: string; status: string; reason: string | null; operator_id: string | null }>();
  if (!row) throw new HttpError(404, "没有这份申请。");
  return json(applicationView(row));
}

async function applicationStatus(request: Request, env: AppEnv, id: string): Promise<Response> {
  const account = await requireAccount(request, env);
  const row = await env.DB.prepare("SELECT id,status,reason,operator_id,account_id FROM applications WHERE id=?")
    .bind(id).first<{ id: string; status: string; reason: string | null; operator_id: string | null; account_id: string | null }>();
  if (!row || (row.account_id !== account.id && !account.roles.includes("admin"))) throw new HttpError(404, "没有这份申请。");
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

async function autoApproveEnabled(env: AppEnv): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(AUTO_APPROVE_KEY)
    .first<{ value: string }>();
  return row?.value === "1";
}

async function setAutoApprove(request: Request, env: AppEnv): Promise<Response> {
  await requireSuper(request, env);
  const payload = await readJson(request);
  const enabled = (payload as { enabled?: unknown }).enabled === true;
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(AUTO_APPROVE_KEY, enabled ? "1" : "0")
    .run();
  return json({ enabled });
}

async function listApplications(request: Request, env: AppEnv): Promise<Response> {
  await requireSuper(request, env);
  const asked = listPage(request);
  const [countRow, pendingRow, autoApprove] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM applications").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'pending'").first<{ n: number }>(),
    autoApproveEnabled(env),
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
    autoApprove,
  });
}

async function approveModelApplication(env: AppEnv, id: string): Promise<{ modelId: string }> {
  const row = await env.DB.prepare("SELECT suffix,status,account_id FROM applications WHERE id=?").bind(id).first<{ suffix: string; status: string; account_id: string | null }>();
  if (!row) throw new HttpError(404, "没有这份申请。");
  if (!row.account_id) throw new AuthError(409, "LEGACY_APPLICATION_REVIEW", "旧申请尚未关联已验证账号，需要人工核验后重新提交。");
  if (row.status !== "pending") throw new AuthError(409, "APPLICATION_PROCESSED", "这份申请已经处理过。");
  const modelId = `tangbao-${row.suffix}`, now = Date.now();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO operators(id,password_hash,active,awake,blurb,created_at,owner_account_id,legacy_claimed_at,operator_uid)
        SELECT ?,?,1,0,a.blurb,?,a.account_id,?,? FROM applications a JOIN accounts c ON c.id=a.account_id
        WHERE a.id=? AND a.status='pending' AND c.verified_at>0 AND c.status='active'
        AND NOT EXISTS(SELECT 1 FROM operators WHERE owner_account_id=a.account_id)`)
        .bind(modelId, await sha256(randomId(32)), now, now, randomId(24), id),
      env.DB.prepare("UPDATE applications SET status='approved',operator_id=?,pass_note=NULL WHERE id=? AND status='pending' AND changes()=1").bind(modelId, id),
      env.DB.prepare(`INSERT OR IGNORE INTO account_roles(account_id,role) SELECT ?,'operator' WHERE EXISTS(SELECT 1 FROM operators WHERE id=? AND owner_account_id=?)`).bind(row.account_id, modelId, row.account_id),
    ]);
    if (results[0].meta.changes !== 1) throw new AuthError(409, "MODEL_LIMIT", "该账号已有模型、已停用或尚未验证，无法审批。");
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(409, "APPLICATION_CONFLICT", "型号或账号归属已发生变化，请刷新后核查。");
  }
  return { modelId };
}

async function approveApplication(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireSuper(request, env);
  return json({ ok: true, ...await approveModelApplication(env, id) });
}

async function rejectApplication(request: Request, env: AppEnv, id: string): Promise<Response> {
  await requireSuper(request, env);
  const row = await env.DB.prepare("SELECT status FROM applications WHERE id = ?").bind(id).first<{ status: string }>();
  if (!row) throw new HttpError(404, "没有这份申请。");
  if (row.status !== "pending") throw new HttpError(400, "这份申请已经处理过。");
  const payload = await readJson(request);
  const reason = reasonOf(payload.reason);
  if (!reason) throw new HttpError(400, "先写一句没过的理由。");
  const result = await env.DB.prepare("UPDATE applications SET status = 'rejected', reason = ? WHERE id = ? AND status = 'pending'").bind(reason, id).run();
  if (result.meta.changes !== 1) throw new AuthError(409, "APPLICATION_PROCESSED", "这份申请已经处理过。");
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

function auditState(request: Request): string {
  const state = new URL(request.url).searchParams.get("state") || "";
  return state === "waiting" || state === "replied" || state === "reported" ? state : "";
}

async function audit(request: Request, env: AppEnv): Promise<Response> {
  await requireSuper(request, env);
  const url = new URL(request.url);
  const asked = listPage(request);
  const operatorPageAsked = Number(url.searchParams.get("mpage") || "1");
  const operatorPageRequested = Number.isFinite(operatorPageAsked)
    ? Math.max(1, Math.floor(operatorPageAsked))
    : 1;
  const operatorQuery = (url.searchParams.get("mq") || "").trim().slice(0, MODEL_SEARCH_MAX);
  const operatorWhere = operatorQuery
    ? "WHERE (o.id LIKE ? ESCAPE '\\' OR o.blurb LIKE ? ESCAPE '\\')"
    : "";
  const operatorBindings: unknown[] = operatorQuery
    ? [
        `%${operatorQuery.replace(/[\\%_]/g, "\\$&")}%`,
        `%${operatorQuery.replace(/[\\%_]/g, "\\$&")}%`,
      ]
    : [];
  let model = modelQuery(request);
  if (model === HOME_MODEL) model = "";
  const state = auditState(request);
  const stateWhere =
    state === "waiting"
      ? " AND awaiting = 1"
      : state === "replied"
        ? " AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.role = 'tangbao')"
        : state === "reported"
          ? " AND reported_at > 0"
          : "";
  const visible = "((operator_id != ? AND queued = 0) OR reported_at > 0)";
  const [countRow, operatorCountRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM threads WHERE ${visible} AND (? = '' OR operator_id = ?)${stateWhere}`,
    )
      .bind(HOME_MODEL, model, model)
      .first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM operators o ${operatorWhere}`)
      .bind(...operatorBindings)
      .first<{ n: number }>(),
  ]);
  const operatorTotal = tally(operatorCountRow);
  const operatorPages = Math.max(1, Math.ceil(operatorTotal / AUDIT_MODEL_PAGE_SIZE));
  const operatorPage = Math.min(operatorPageRequested, operatorPages);
  const operatorRows = await env.DB.prepare(
    `SELECT o.id, o.active, o.blurb, CASE WHEN ${OWNER_READY} THEN o.last_seen_at ELSE 0 END AS last_seen_at, o.last_reply_at, o.last_assigned_at,
      COALESCE(p.n, 0) AS pending, p.oldest AS oldest_pending_at
     FROM operators o
     LEFT JOIN (
       SELECT operator_id, COUNT(*) AS n, MIN(updated_at) AS oldest
       FROM threads t
       WHERE t.awaiting = 1 AND t.queued = 0 AND ${unblockedThread("t")}
       GROUP BY operator_id
     ) p ON p.operator_id = o.id
     ${operatorWhere}
     ORDER BY o.active DESC, o.last_seen_at DESC, o.id ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(...operatorBindings, AUDIT_MODEL_PAGE_SIZE, (operatorPage - 1) * AUDIT_MODEL_PAGE_SIZE)
    .all<PresenceRow>();
  const operators = operatorRows.results.map((row) => presenceFromRow(row, Date.now()));
  const statusRank: Record<PresenceState, number> = {
    online: 0,
    busy: 1,
    away: 2,
    off: 3,
  };
  const ordered = [...operators].sort(
    (a, b) => statusRank[a.status] - statusRank[b.status],
  );
  const models = new Set<string>();
  for (const row of operators) models.add(row.id);
  const total = tally(countRow);
  const pages = Math.max(1, Math.ceil(total / LIST_SIZE));
  const page = Math.min(asked, pages);
  const threads = await env.DB.prepare(
    `SELECT id, title, preview, operator_id AS operatorId, awaiting,
            updated_at AS updatedAt, reported_at AS reportedAt,
            report_reason AS reportReason,
            EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.role = 'tangbao') AS replied
     FROM threads
     WHERE ${visible} AND (? = '' OR operator_id = ?)${stateWhere}
     ORDER BY (reported_at > 0) DESC, updated_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(HOME_MODEL, model, model, LIST_SIZE, (page - 1) * LIST_SIZE)
    .all<{
      id: string;
      title: string;
      preview: string;
      operatorId: string;
      awaiting: number;
      updatedAt: number;
      reportedAt: number;
      reportReason: string | null;
      replied: number;
    }>();
  return json({
    threads: threads.results,
    operators: ordered.map((row) => ({
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
    state,
    models: [...models].sort((a, b) => a.localeCompare(b)),
    operatorPage,
    operatorPageSize: AUDIT_MODEL_PAGE_SIZE,
    operatorTotal,
    operatorPages,
    operatorHasMore: operatorPage < operatorPages,
  });
}

async function migrateHomeBacklog(env: AppEnv, operatorId: string, seat?: Seat): Promise<number> {
  if (operatorId === HOME_MODEL) return 0;
  const target = await operatorPresence(env, operatorId, Date.now(), seat);
  if (!target.active || target.status !== "online" || target.pending >= PENDING_CAP) return 0;

  let slots = PENDING_CAP - target.pending;
  const candidates = await env.DB.prepare(
    `SELECT t.id
     FROM threads t
     WHERE t.awaiting = 1 AND t.auto_home = 1
       AND (t.operator_id = ? OR t.queued = 1)
       AND NOT EXISTS (
         SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.role = 'tangbao'
       )
       AND NOT EXISTS (
         SELECT 1 FROM blocks b
         WHERE ${threadBlockMatch("t", "?")}
       )
     ORDER BY t.updated_at ASC
     LIMIT ?`,
  )
    .bind(HOME_MODEL, blockScope(operatorId), slots)
    .all<{ id: string }>();
  if (!candidates.results.length) return 0;

  const now = Date.now();
  const freshAfter = now - ONLINE_TTL;
  const ownership = seat ? seatOwnership(seat, "o.id") : { sql: "1=1", values: [] };
  let moved = 0;
  for (const row of candidates.results) {
    if (slots <= 0) break;
    const result = await env.DB.prepare(
      `UPDATE threads
       SET operator_id = ?, queued = 0
       WHERE id = ? AND awaiting = 1 AND auto_home = 1
         AND (operator_id = ? OR queued = 1)
         AND NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.role = 'tangbao'
         )
         AND NOT EXISTS (
           SELECT 1 FROM blocks b
           WHERE ${threadBlockMatch("threads", "?")}
         )
         AND EXISTS (
           SELECT 1 FROM operators o
           WHERE o.id = ? AND o.active = 1 AND ${OWNER_READY} AND o.last_seen_at >= ? AND ${ownership.sql}
         )
         AND (
           SELECT COUNT(*) FROM threads t
           WHERE t.operator_id = ? AND t.awaiting = 1 AND ${unblockedThread("t")}
         ) < ?`,
    )
      .bind(operatorId, row.id, HOME_MODEL, blockScope(operatorId), operatorId, freshAfter, ...ownership.values, operatorId, PENDING_CAP)
      .run();
    if (result.meta.changes !== 1) continue;
    moved += 1;
    slots -= 1;
    await touchAssigned(env, operatorId, now, seat);
  }
  return moved;
}

async function pool(request: Request, env: AppEnv): Promise<Response> {
  await requireSuper(request, env);
  const [countRow, rows] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM threads WHERE awaiting = 1 AND queued = 1 AND ${unblockedThread("threads")}`,
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT id, title, preview, updated_at AS updatedAt
       FROM threads
       WHERE awaiting = 1 AND queued = 1 AND ${unblockedThread("threads")}
       ORDER BY updated_at ASC
       LIMIT 100`,
    ).all<{ id: string; title: string; preview: string; updatedAt: number }>(),
  ]);
  return json({ count: tally(countRow), threads: rows.results });
}

async function queue(request: Request, env: AppEnv): Promise<Response> {
  const seat = await requireSeat(request, env);
  const own = seat.operatorId;
  const ownership = seatOwnership(seat, "threads.operator_id");
  const now = Date.now();
  await touchSeat(env, seat, now);
  if (!seat.super) await migrateHomeBacklog(env, own, seat);
  const [waiting, closed, presence, pendingRow] = await Promise.all([
    env.DB.prepare(
      `SELECT id, title, preview, updated_at AS updatedAt,
        EXISTS(SELECT 1 FROM thread_pins p WHERE p.thread_id=threads.id AND p.owner_kind='operator' AND p.owner_id=?) AS pinned
       FROM threads WHERE awaiting = 1 AND queued = 0 AND operator_id = ? AND ${ownership.sql} AND ${unblockedThread("threads")} ORDER BY pinned DESC,updated_at ASC LIMIT 100`,
    )
      .bind(own, own, ...ownership.values)
      .all<{ id: string; title: string; preview: string; updatedAt: number; pinned: number }>(),
    env.DB.prepare(
      `SELECT id, title, preview, updated_at AS updatedAt, last_role AS lastRole,
        EXISTS(SELECT 1 FROM thread_pins p WHERE p.thread_id=threads.id AND p.owner_kind='operator' AND p.owner_id=?) AS pinned
       FROM threads WHERE awaiting = 0 AND operator_id = ? AND ${ownership.sql} AND ${unblockedThread("threads")} ORDER BY pinned DESC,updated_at DESC LIMIT 40`,
    )
      .bind(own, own, ...ownership.values)
      .all<{ id: string; title: string; preview: string; updatedAt: number; lastRole: string; pinned: number }>(),
    seat.super && own === HOME_MODEL ? homePresence(env, now) : operatorPresence(env, own, now, seat),
    seat.super
      ? env.DB.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'pending'").first<{ n: number }>()
      : Promise.resolve(null),
  ]);
  const status = statusPayload(publicPresence(presence.status));
  const blocked = await env.DB.prepare(
    `SELECT id, title, preview, updated_at AS updatedAt FROM threads
     WHERE operator_id = ? AND EXISTS (SELECT 1 FROM blocks b WHERE ${threadBlockMatch("threads", "?")}) AND ${ownership.sql}
     ORDER BY updated_at DESC LIMIT 20`,
  )
    .bind(own, own, ...ownership.values)
    .all<{ id: string; title: string; preview: string; updatedAt: number }>();
  const blockedIds = new Set(blocked.results.map((row) => row.id));
  const rows = closed.results;
  await ensureSeatModel(env, seat);
  return json({
    super: seat.super,
    operatorId: seat.operatorId || null,
    needsModel: !seat.operatorId,
    status,
    waiting: waiting.results.filter((row) => !blockedIds.has(row.id)),
    pending: pendingRow?.n ?? 0,
    recent: rows.filter((row) => row.lastRole !== "visitor" && !blockedIds.has(row.id)).slice(0, 20),
    shelved: rows.filter((row) => row.lastRole === "visitor" && !blockedIds.has(row.id)).slice(0, 20),
    blocked: blocked.results,
  });
}

async function blockThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const seat = await requireSeat(request, env);
  const ownership = seatOwnership(seat, "threads.operator_id", [], true);
  const thread = await env.DB.prepare(
    `SELECT id, token_hash, visitor_hash, ip_hash, operator_id, account_id FROM threads WHERE id = ? AND ${ownership.sql}`,
  )
    .bind(id, ...ownership.values)
    .first<{
      id: string;
      token_hash: string;
      visitor_hash: string | null;
      ip_hash: string | null;
      account_id: string | null;
      operator_id: string;
    }>();
  if (!thread) {
    throw new HttpError(404, "这屉不在笼里。");
  }
  const scope = seat.super ? GLOBAL_BLOCK : blockScope(thread.operator_id);
  const ids = seat.super
    ? [accountBlockKey(thread.account_id), thread.token_hash, thread.visitor_hash, thread.ip_hash]
    : thread.account_id ? [accountBlockKey(thread.account_id)] : [thread.token_hash, thread.visitor_hash];
  await rememberBlock(env, ids, scope, seat);
  await closeBlockedThreads(env, thread, scope, seat);
  await ensureSeatModel(env, seat);
  return json({ ok: true });
}

async function unblockThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const seat = await requireSeat(request, env);
  const ownership = seatOwnership(seat, "threads.operator_id", [], true);
  const thread = await env.DB.prepare(
    `SELECT id, token_hash, visitor_hash, ip_hash, operator_id, account_id FROM threads WHERE id = ? AND ${ownership.sql}`,
  )
    .bind(id, ...ownership.values)
    .first<{
      id: string;
      token_hash: string;
      visitor_hash: string | null;
      ip_hash: string | null;
      account_id: string | null;
      operator_id: string;
    }>();
  if (!thread) {
    throw new HttpError(404, "这屉不在笼里。");
  }
  const scopes = seat.super ? [] : [blockScope(thread.operator_id)];
  const writeOwnership = seatOwnership(seat, "blocks.operator_id", [], true);
  if (thread.account_id) {
    const marks = scopes.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM blocks WHERE ${seat.super ? "" : `operator_id IN (${marks}) AND `}
      (id=? OR id IN(SELECT token_hash FROM threads WHERE account_id=?)
      OR id IN(SELECT visitor_hash FROM threads WHERE account_id=?)
      ${seat.super ? "OR (operator_id='*' AND id IN(SELECT ip_hash FROM threads WHERE account_id=?))" : ""}) AND ${writeOwnership.sql}`)
      .bind(...scopes, accountBlockKey(thread.account_id), thread.account_id, thread.account_id, ...(seat.super ? [thread.account_id] : []), ...writeOwnership.values).run();
  } else if (seat.super) {
    // Aggregate by visitor, never by shared IP. An IP is only a global-block identity.
    await env.DB.prepare(`DELETE FROM blocks WHERE id IN (?,?)
      OR id IN(SELECT token_hash FROM threads WHERE visitor_hash=?)
      OR (operator_id='*' AND (id=? OR id IN(SELECT ip_hash FROM threads WHERE visitor_hash=?)))`)
      .bind(thread.token_hash, thread.visitor_hash || null, thread.visitor_hash || null, thread.ip_hash, thread.visitor_hash || null).run();
  } else await forgetBlock(env, [thread.token_hash, thread.visitor_hash], scopes, seat);
  await ensureSeatModel(env, seat);
  return json({ ok: true });
}

async function shelveThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const seat = await requireSeat(request, env);
  const ownership = seatOwnership(seat, "threads.operator_id");
  const result = await env.DB.prepare(`UPDATE threads SET awaiting = 0, updated_at = ? WHERE id = ? AND ${ownership.sql}`)
    .bind(Date.now(), id, ...ownership.values).run();
  if (!result.meta.changes) throw new HttpError(404, "这屉不在笼里。");
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
  if (!seat.operatorId) throw new HttpError(409, "请先绑定模型，再开启后台通知。");
  const ownership = seat.super ? { sql: "1=1", values: [] } : seatOwnership(seat, "operators.id");
  const result = await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, operator_id, p256dh, auth, created_at)
     SELECT ?, ${seat.super ? "?" : "operators.id"}, ?, ?, ? ${seat.super ? "" : "FROM operators"} WHERE ${ownership.sql}
     ON CONFLICT(endpoint) DO UPDATE SET operator_id = excluded.operator_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
  )
    .bind(endpoint, ...(seat.super ? [seat.operatorId] : []), p256dh, auth, Date.now(), ...ownership.values)
    .run();
  if (!result.meta.changes) throw new AuthError(409, "MODEL_CHANGED", "模型状态已变化，请刷新后重新订阅。");
  return json({ ok: true });
}

async function pushUnsubscribe(request: Request, env: AppEnv): Promise<Response> {
  const seat = await requireSeat(request, env);
  const payload = await readJson(request);
  const endpoint = pushEndpoint(payload.endpoint);
  if (!endpoint) throw new HttpError(400, "这台浏览器的订阅对不上。");
  const ownership = seatOwnership(seat, "push_subscriptions.operator_id");
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND ${ownership.sql}`)
    .bind(endpoint, ...ownership.values)
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

async function siteStatus(env: AppEnv): Promise<StatusPayload> {
  const now = Date.now();
  const [home, row] = await Promise.all([
    homePresence(env, now),
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN o.active = 1 AND ${OWNER_READY}
           AND o.last_seen_at >= ?
           AND COALESCE(p.n, 0) < ?
           AND NOT (COALESCE(p.n, 0) > 0 AND p.oldest < ?)
           THEN 1 ELSE 0 END), 0) AS online,
         COALESCE(SUM(CASE WHEN o.active = 1 AND ${OWNER_READY}
           AND o.last_seen_at >= ?
           AND (COALESCE(p.n, 0) >= ? OR (COALESCE(p.n, 0) > 0 AND p.oldest < ?))
           THEN 1 ELSE 0 END), 0) AS busy
       FROM operators o
       LEFT JOIN (
         SELECT operator_id, COUNT(*) AS n, MIN(updated_at) AS oldest
         FROM threads t
         WHERE t.awaiting = 1 AND t.queued = 0 AND ${unblockedThread("t")}
         GROUP BY operator_id
       ) p ON p.operator_id = o.id`,
    )
      .bind(
        now - ONLINE_TTL,
        PENDING_CAP,
        now - REPLY_TIMEOUT,
        now - ONLINE_TTL,
        PENDING_CAP,
        now - REPLY_TIMEOUT,
      )
      .first<{ online: number | null; busy: number | null }>(),
  ]);
  const state: PresenceState =
    Number(row?.online) > 0 || home.status === "online"
      ? "online"
      : Number(row?.busy) > 0 || home.status === "busy"
        ? "busy"
        : "away";
  const payload = statusPayload(state);
  if (state === "online") payload.note = "有人在";
  return payload;
}

async function adminRead(request: Request, env: AppEnv, id: string): Promise<Response> {
  const seat = await requireSeat(request, env);
  const ownership = seatOwnership(seat, "threads.operator_id", [], true);
  const thread = await env.DB.prepare(
    `SELECT id, title, awaiting, operator_id, token_hash, visitor_hash, ip_hash, account_id, updated_at AS updatedAt,
       EXISTS(SELECT 1 FROM thread_pins p WHERE p.thread_id=threads.id AND p.owner_kind='operator' AND p.owner_id=?) AS pinned
     FROM threads WHERE id = ? AND ${ownership.sql}`,
  )
    .bind(seat.operatorId, id, ...ownership.values)
    .first<{
      id: string;
      title: string;
      awaiting: number;
      operator_id: string;
      token_hash: string;
      visitor_hash: string | null;
      ip_hash: string | null;
      account_id: string | null;
      updatedAt: number;
      pinned: number;
    }>();
  if (!thread) throw new HttpError(404, "这屉不在笼里。");
  const messages = await listMessages(env, id);
  const blocked = await isBlocked(env, [thread.token_hash, thread.visitor_hash, accountBlockKey(thread.account_id)], thread.operator_id, [thread.ip_hash]);
  return json({
    thread: {
      id: thread.id,
      title: thread.title,
      awaiting: thread.awaiting,
      operatorId: thread.operator_id,
      updatedAt: thread.updatedAt,
      blocked,
      pinned: Boolean(thread.pinned),
    },
    messages,
  });
}

async function pinThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const seat = await requireSeat(request, env);
  if (!seat.operatorId) throw new HttpError(409, "请先绑定模型，再固定对话。");
  const ownership = seatOwnership(seat, "threads.operator_id");
  const thread = await env.DB.prepare(`SELECT 1 AS found FROM threads WHERE id = ? AND ${ownership.sql}`)
    .bind(id, ...ownership.values).first();
  if (!thread) throw new HttpError(404, "这屉不在笼里。");
  const payload = await readJson(request);
  const pinned = payload.pinned !== false;
  if (pinned) {
    await env.DB.prepare(`INSERT INTO thread_pins(thread_id,owner_kind,owner_id,created_at) VALUES(?,'operator',?,?)
      ON CONFLICT(thread_id,owner_kind,owner_id) DO UPDATE SET created_at=excluded.created_at`)
      .bind(id, seat.operatorId, Date.now()).run();
  } else {
    await env.DB.prepare("DELETE FROM thread_pins WHERE thread_id=? AND owner_kind='operator' AND owner_id=?")
      .bind(id, seat.operatorId).run();
  }
  return json({ ok: true, pinned });
}

async function renameAdminThread(request: Request, env: AppEnv, id: string): Promise<Response> {
  const seat = await requireSeat(request, env);
  const ownership = seatOwnership(seat, "threads.operator_id");
  const thread = await env.DB.prepare(`SELECT 1 AS found FROM threads WHERE id = ? AND ${ownership.sql}`)
    .bind(id, ...ownership.values).first();
  if (!thread) throw new HttpError(404, "这屉不在笼里。");
  const payload = await readJson(request);
  const title = typeof payload.title === "string" ? payload.title.trim().replace(/\s+/g, " ") : "";
  if (!title || [...title].length > 80) throw new HttpError(400, "对话名称需要是1至80个字符。");
  await env.DB.prepare(`UPDATE threads SET title = ? WHERE id = ? AND ${ownership.sql}`)
    .bind(title, id, ...ownership.values).run();
  return json({ ok: true, title });
}

async function adminReply(request: Request, env: AppEnv, id: string): Promise<Response> {
  const seat = await requireSeat(request, env);
  const ownership = seatOwnership(seat, "threads.operator_id");
  const exists = await env.DB.prepare(`SELECT operator_id FROM threads WHERE id = ? AND ${ownership.sql}`)
    .bind(id, ...ownership.values)
    .first<{ operator_id: string }>();
  if (!exists) throw new HttpError(403, "这笼不是你的。");
  const incoming = await readIncoming(request, "写一句可能没用的话，或放一张图。");
  await writeMessage(env, id, "tangbao", incoming, 0);
  await touchReply(env, seat, Date.now());
  return json({ ok: true });
}

async function serveImage(request: Request, env: AppEnv, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT i.image_key,i.image_type,t.id AS thread_id,t.token_hash,t.account_id,t.operator_id
    FROM message_images i JOIN messages m ON m.id=i.message_id JOIN threads t ON t.id=m.thread_id WHERE i.id=?`)
    .bind(id).first<{ image_key: string; image_type: string; thread_id: string; token_hash: string; account_id: string | null; operator_id: string }>();
  if (!row) throw new HttpError(404, "这张图不在笼里。");
  let authorized = false;
  if (row.account_id) {
    const account = await getAccount(request, env);
    authorized = Boolean(account?.verified && account.id === row.account_id);
  } else {
    const url = new URL(request.url), expires = Number(url.searchParams.get("e")), signature = url.searchParams.get("s") || "";
    if (Number.isSafeInteger(expires) && expires > Date.now() && expires <= Date.now() + 5 * 60_000) authorized = safeEqual(signature, await imageSignature(env, id, row.token_hash, expires));
    const token = bearer(request);
    if (!authorized && token) authorized = safeEqual(await sha256(token), row.token_hash);
  }
  if (!authorized) {
    try {
      const seat = await requireSeat(request, env);
      const ownership = seatOwnership(seat, "threads.operator_id", [], true);
      authorized = Boolean(await env.DB.prepare(`SELECT id FROM threads WHERE id = ? AND ${ownership.sql}`).bind(row.thread_id, ...ownership.values).first());
    } catch { /* Unauthenticated image URLs do not reveal parent metadata. */ }
  }
  if (!authorized) throw new AuthError(401, "IMAGE_AUTH_REQUIRED", "请从有权访问的对话中重新打开图片。");
  const bytes = await env.IMAGES.get(row.image_key, "arrayBuffer");
  if (!bytes) throw new HttpError(404, "这张图不在笼里。");
  return new Response(bytes, { headers: { "content-type": row.image_type || "application/octet-stream", "cache-control": "private, no-store" } });
}

async function listMessages(env: AppEnv, threadId: string) {
  const messages = await env.DB.prepare(
    "SELECT id, role, body, draw, created_at AS createdAt FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
  )
    .bind(threadId)
    .all<{ id: string; role: string; body: string; draw: number; createdAt: number }>();
  const grouped = new Map<string, { id: string; type: string; url: string }[]>();
  const parent = await env.DB.prepare("SELECT token_hash,account_id FROM threads WHERE id=?").bind(threadId).first<{ token_hash: string; account_id: string | null }>();
  const images = await env.DB.prepare(
    `SELECT i.id, i.message_id AS messageId, i.image_type AS imageType
     FROM message_images i JOIN messages m ON m.id = i.message_id
     WHERE m.thread_id = ? ORDER BY i.position ASC`,
  )
    .bind(threadId)
    .all<{ id: string; messageId: string; imageType: string }>();
  for (const image of images.results) {
    const list = grouped.get(image.messageId) ?? [];
    const expires = Date.now() + 5 * 60_000;
    const url = parent && !parent.account_id ? `/api/images/${image.id}?e=${expires}&s=${await imageSignature(env, image.id, parent.token_hash, expires)}` : `/api/images/${image.id}`;
    list.push({ id: image.id, type: image.imageType, url });
    grouped.set(image.messageId, list);
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
    env.DB.prepare("UPDATE threads SET preview = ?, updated_at = ?, awaiting = ?, last_role = ? WHERE id = ?").bind(
      previewFrom(draw ? `要一张图 · ${shown}` : shown),
      now,
      awaiting,
      role,
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

async function loadOwned(env: AppEnv, id: string, token: string, request: Request) {
  const thread = await env.DB.prepare(
    "SELECT id, token_hash, title, awaiting, visitor_hash, ip_hash, operator_id, queued, reported_at, account_id FROM threads WHERE id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      token_hash: string;
      title: string;
      awaiting: number;
      visitor_hash: string | null;
      ip_hash: string | null;
      account_id: string | null;
      operator_id: string;
      queued: number;
      reported_at: number;
    }>();
  if (thread?.account_id) {
    const account = await requireAccount(request, env);
    if (account.id !== thread.account_id) throw new AuthError(403, "THREAD_FORBIDDEN", "这段对话属于另一个账号。");
    return thread;
  }
  const hash = await sha256(token);
  if (!token || !thread || !safeEqual(hash, thread.token_hash)) {
    throw new HttpError(401, "这把钥匙对不上这段对话。");
  }
  return thread;
}

function accountBlockKey(id?: string | null): string | null { return id ? `account:${id}` : null; }

function presentIds(...ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

const GLOBAL_BLOCK = "*";

function blockScope(operatorId: string): string {
  return operatorId === HOME_MODEL || operatorId === POOL_MODEL ? GLOBAL_BLOCK : operatorId;
}

// Model blocks use conversation/visitor/account identity. Only global blocks match IPs.
function threadBlockMatch(thread = "t", operator = `${thread}.operator_id`): string {
  const ids = `${thread}.token_hash,${thread}.visitor_hash,'account:'||${thread}.account_id`;
  return `((b.operator_id=${operator} AND b.id IN (${ids}))
    OR (b.operator_id='*' AND b.id IN (${ids},${thread}.ip_hash)))`;
}

function unblockedThread(thread = "t", operator = `${thread}.operator_id`): string {
  return `NOT EXISTS (SELECT 1 FROM blocks b WHERE ${threadBlockMatch(thread, operator)})`;
}

async function blockingScope(
  env: AppEnv,
  ids: Array<string | null | undefined>,
  operatorId?: string,
  ipIds: Array<string | null | undefined> = [],
): Promise<string | null> {
  const fresh = presentIds(...ids);
  const globalIds = presentIds(...fresh, ...ipIds);
  const scope = operatorId ? blockScope(operatorId) : "";
  const matches: string[] = [], values: unknown[] = [];
  if (scope && scope !== GLOBAL_BLOCK && fresh.length) {
    matches.push(`(operator_id=? AND id IN (${fresh.map(() => "?").join(",")}))`);
    values.push(scope, ...fresh);
  }
  if (globalIds.length) {
    matches.push(`(operator_id='*' AND id IN (${globalIds.map(() => "?").join(",")}))`);
    values.push(...globalIds);
  }
  if (!matches.length) return null;
  const row = await env.DB.prepare(`SELECT operator_id FROM blocks WHERE ${matches.join(" OR ")}
    ORDER BY CASE WHEN operator_id='*' THEN 0 ELSE 1 END LIMIT 1`).bind(...values).first<{ operator_id: string }>();
  return row?.operator_id || null;
}

async function isBlocked(env: AppEnv, ids: Array<string | null | undefined>, operatorId?: string, ipIds: Array<string | null | undefined> = []): Promise<boolean> {
  return Boolean(await blockingScope(env, ids, operatorId, ipIds));
}

async function rememberBlock(
  env: AppEnv,
  ids: Array<string | null | undefined>,
  operatorId = GLOBAL_BLOCK,
  seat?: Seat,
): Promise<void> {
  const fresh = presentIds(...ids);
  if (!fresh.length) return;
  const scope = blockScope(operatorId);
  const now = Date.now();
  const ownership = seat ? seatOwnership(seat, "?", [scope], true) : { sql: "1=1", values: [] };
  await env.DB.batch(
    fresh.map((id) =>
      env.DB.prepare(
        `INSERT INTO blocks (id, operator_id, created_at) SELECT ?, ?, ? WHERE ${ownership.sql} ON CONFLICT(id, operator_id) DO NOTHING`,
      ).bind(id, scope, now, ...ownership.values),
    ),
  );
}

async function forgetBlock(
  env: AppEnv,
  ids: Array<string | null | undefined>,
  operatorIds: string[],
  seat?: Seat,
): Promise<void> {
  const fresh = presentIds(...ids);
  if (!fresh.length) return;
  const marks = fresh.map(() => "?").join(", ");
  if (!operatorIds.length) {
    if (!seat?.super) throw new AuthError(403, "ADMIN_REQUIRED", "只有管理员可以解除全部范围的封禁。");
    await env.DB.prepare(`DELETE FROM blocks WHERE id IN (${marks})`).bind(...fresh).run();
    return;
  }
  const scopes = [...new Set(operatorIds.map(blockScope))];
  if (!scopes.length) return;
  const scopeMarks = scopes.map(() => "?").join(", ");
  const ownership = seat ? seatOwnership(seat, "blocks.operator_id", [], true) : { sql: "1=1", values: [] };
  await env.DB.prepare(
    `DELETE FROM blocks WHERE id IN (${marks}) AND operator_id IN (${scopeMarks}) AND ${ownership.sql}`,
  )
    .bind(...fresh, ...scopes, ...ownership.values)
    .run();
}

async function closeBlockedThreads(
  env: AppEnv,
  thread: { token_hash: string; visitor_hash: string | null; ip_hash: string | null; account_id?: string | null },
  operatorId: string,
  seat?: Seat,
): Promise<void> {
  const scope = blockScope(operatorId);
  const scoped = scope !== GLOBAL_BLOCK;
  const identity = scoped
    ? thread.account_id ? "account_id = ?" : "(token_hash = ? OR visitor_hash = ?)"
    : "(token_hash = ? OR visitor_hash = ? OR ip_hash = ? OR account_id = ?)";
  const ownership = seat ? seatOwnership(seat, "threads.operator_id", [], true) : { sql: "1=1", values: [] };
  const sql = `UPDATE threads
    SET awaiting = 0
    WHERE awaiting = 1
      ${scoped ? "AND operator_id = ?" : ""}
      AND ${identity} AND ${ownership.sql}`;
  const identities = scoped
    ? thread.account_id ? [thread.account_id] : [thread.token_hash, thread.visitor_hash]
    : [thread.token_hash, thread.visitor_hash, thread.ip_hash, thread.account_id || null];
  const bindings = scoped ? [scope, ...identities] : identities;
  await env.DB.prepare(sql).bind(...bindings, ...ownership.values).run();
}

async function visitorHash(request: Request): Promise<string> {
  const raw = request.headers.get("x-visitor") || "";
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(raw)) return "";
  return sha256(raw);
}

async function attachIdentity(
  env: AppEnv,
  thread: { id: string; token_hash: string; visitor_hash: string | null; ip_hash: string | null; account_id?: string | null },
  request: Request,
  operatorId: string,
): Promise<{ blocked: boolean }> {
  const visitor = await visitorHash(request);
  const ip = await clientHash(request);
  const ids = [accountBlockKey(thread.account_id), thread.token_hash, thread.visitor_hash, ...(thread.account_id ? [] : [visitor])];
  const scope = await blockingScope(env, ids, operatorId, [thread.ip_hash, ip]);
  if (scope) {
    const identityBlocked = scope !== GLOBAL_BLOCK || await isBlocked(env, ids);
    if (identityBlocked) {
      const remembered = thread.account_id ? [accountBlockKey(thread.account_id)] : ids;
      await rememberBlock(env, remembered, scope);
      await closeBlockedThreads(env, thread, scope);
    } else {
      // A shared-IP hit is temporary network scope, not proof that this visitor/account is banned.
      await env.DB.prepare("UPDATE threads SET awaiting = 0 WHERE id = ?").bind(thread.id).run();
    }
  }
  if (!thread.account_id && ((visitor && !thread.visitor_hash) || (ip && !thread.ip_hash))) {
    await env.DB.prepare(
      "UPDATE threads SET visitor_hash = COALESCE(visitor_hash, ?), ip_hash = COALESCE(ip_hash, ?) WHERE id = ?",
    )
      .bind(visitor || null, ip || null, thread.id)
      .run();
  }
  return { blocked: Boolean(scope) };
}

async function assertQueue(env: AppEnv, alreadyWaiting: boolean): Promise<void> {
  if (alreadyWaiting) return;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM threads WHERE awaiting = 1 AND ${unblockedThread("threads")}`).first<{ n: number }>();
  if (Number(row?.n ?? 0) >= QUEUE_CAP) {
    throw new HttpError(429, "笼里的屉已经顶到盖了。过一会儿再放一屉。");
  }
}

async function allow(env: AppEnv, bucket: string, limit: number, windowMs: number): Promise<boolean> {
  return consumeRate(env, bucket, limit, windowMs);
}

type LegacySeat = { super: boolean; operatorId: string };
type Seat = LegacySeat & { accountId: string; operatorUid: string | null };

function seatOwnership(seat: Seat, operatorExpression: string, expressionValues: unknown[] = [], adminAll = false): { sql: string; values: unknown[] } {
  if (seat.super) return adminAll ? { sql: "1=1", values: [] } : { sql: `${operatorExpression} = ?`, values: [...expressionValues, seat.operatorId] };
  return {
    sql: `EXISTS (SELECT 1 FROM operators seat_operator JOIN accounts seat_account ON seat_account.id = seat_operator.owner_account_id
      WHERE seat_operator.id = ${operatorExpression} AND seat_operator.operator_uid = ? AND seat_operator.owner_account_id = ?
        AND seat_operator.active = 1 AND seat_account.status = 'active' AND seat_account.verified_at > 0)`,
    values: [...expressionValues, seat.operatorUid, seat.accountId],
  };
}

async function ensureSeatModel(env: AppEnv, seat: Seat): Promise<void> {
  if (seat.super && !seat.operatorId) return;
  if (seat.super && seat.operatorId === HOME_MODEL) return;
  const ownership = seatOwnership(seat, "?", [seat.operatorId]);
  const current = await env.DB.prepare(`SELECT 1 AS current WHERE ${ownership.sql}`).bind(...ownership.values).first();
  if (!current) throw new AuthError(409, "MODEL_CHANGED", "型号或归属刚刚发生变化，请刷新后重试。");
}

async function requireSeat(request: Request, env: AppEnv): Promise<Seat> {
  const account = await getAccount(request, env);
  if (!account) {
    if (await legacySeat(request, env)) throw new AuthError(403, "LEGACY_MIGRATION_REQUIRED", "请先建立并验证账号、绑定原模型后继续使用后台。");
    throw new AuthError(401, "AUTH_REQUIRED", "请先用邮箱和密码登录。");
  }
  if (!account.verified) throw new AuthError(403, "EMAIL_UNVERIFIED", "请先验证邮箱。");
  if (account.roles.includes("admin")) {
    const [owned, homeOwner] = await Promise.all([
      env.DB.prepare("SELECT id,operator_uid FROM operators WHERE owner_account_id=?").bind(account.id).first<{ id: string; operator_uid: string | null }>(),
      env.DB.prepare("SELECT value FROM settings WHERE key = 'home_owner_account_id'").first<{ value: string }>(),
    ]);
    const operatorId = homeOwner?.value === account.id ? HOME_MODEL : owned?.id || "";
    return { super: true, operatorId, accountId: account.id, operatorUid: owned?.operator_uid || null };
  }
  const operator = await env.DB.prepare("SELECT id,active,operator_uid FROM operators WHERE owner_account_id=?").bind(account.id).first<{ id: string; active: number; operator_uid: string | null }>();
  if (!operator || !account.roles.includes("operator")) throw new AuthError(403, "OPERATOR_REQUIRED", "通过申请或绑定已有模型后，才能进入后台。");
  if (operator.active !== 1) throw new AuthError(403, "MODEL_DISABLED", "这个模型已停用，普通聊天仍可使用。");
  if (!operator.operator_uid) throw new AuthError(409, "MODEL_IDENTITY_REQUIRED", "模型身份尚未准备好，请联系管理员。");
  return { super: false, operatorId: operator.id, accountId: account.id, operatorUid: operator.operator_uid };
}

async function requireSuper(request: Request, env: AppEnv): Promise<Seat> {
  const seat = await requireSeat(request, env);
  if (!seat.super) throw new HttpError(403, "这笼不是你的。");
  return seat;
}

async function readSession(secret: string, cookie: string): Promise<LegacySeat | null> {
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

async function issueSession(request: Request, env: AppEnv, seat: LegacySeat): Promise<Response> {
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
): Promise<{ body?: unknown; password?: unknown; awake?: unknown; draw?: unknown; operator?: unknown; suffix?: unknown; email?: unknown; reason?: unknown; blurb?: unknown; endpoint?: unknown; keys?: unknown; pinned?: unknown; title?: unknown }> {
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
