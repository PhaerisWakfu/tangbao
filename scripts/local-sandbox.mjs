import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";
import { runScenarios } from "./local-scenarios.mjs";
import { demoHtml } from "./local-demo.mjs";
import { importSnapshot } from "./local-snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const kind = "tangbao-local-sandbox/v1";
const commands = new Set(["prepare", "dev", "seed", "verify", "info", "clone"]);
const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--instance", "--port", "--inspector-port", "--snapshot", "--baseline"].includes(args[i]) || !args[i + 1]) {
    throw new Error("只接受 --instance、--port、--inspector-port；不接受远程基址或 Wrangler 透传参数。");
  }
  if (options[args[i]]) throw new Error(`重复参数 ${args[i]}`);
  options[args[i]] = args[i + 1];
}
if (!commands.has(command)) {
  throw new Error("用法：node scripts/local-sandbox.mjs prepare|dev|seed|verify|info [--instance demo] [--port 8790]");
}
if (command !== "clone" && (options["--snapshot"] || options["--baseline"])) throw new Error("快照参数只供 clone 使用。");
if (!["prepare", "verify", "clone"].includes(command) && (options["--port"] || options["--inspector-port"])) {
  throw new Error("端口只在 prepare/verify 时设置，dev/seed/info 使用实例已记录的端口。");
}
for (const key of ["--port", "--inspector-port"]) if (options[key]) portOf(options[key]);
const instance = options["--instance"] || (command === "verify" ? `check-${Date.now()}-${randomBytes(3).toString("hex")}` : "demo");
if (!/^[a-z][a-z0-9-]{0,39}$/.test(instance)) throw new Error("instance 仅允许 1–40 位小写字母、数字、短横线，且以字母开头。");
const directory = path.join(root, ".tmp/local-sandboxes", instance);
const metadataFile = path.join(directory, "instance.json");
const configFile = path.join(directory, "wrangler.json");
const stateDirectory = path.join(directory, "state");
const fixtureFile = path.join(directory, "actors.json");

function portOf(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口必须是 1024–65535 的整数。");
  return port;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Only OS/runtime essentials cross into Wrangler. Neither shell provider keys nor
// another project's Cloudflare/Turso settings are inherited by the sandbox.
function childEnv() {
  const env = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (process.platform === "win32") env.TEMP = env.TMP = directory;
  return {
    ...env,
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
  };
}

function launch(argv, stdio = "inherit") {
  if (!existsSync(wrangler)) throw new Error("缺少 Wrangler，请先运行 npm ci。");
  return spawn(process.execPath, [wrangler, ...argv, "--config", configFile], {
    cwd: directory,
    env: childEnv(),
    stdio: stdio === "inherit" ? ["ignore", "inherit", "inherit"] : stdio,
    windowsHide: true,
  });
}

function completed(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Wrangler 退出：${code ?? signal}`)));
  });
}

async function loadMetadata({ allowIncompleteClone = false } = {}) {
  const data = JSON.parse(await readFile(metadataFile, "utf8"));
  if (data.kind !== kind || data.instance !== instance || !/^[a-f0-9]{48}$/.test(data.nonce)) {
    throw new Error("实例标记不匹配，停止操作。");
  }
  portOf(data.port);
  portOf(data.inspectorPort);
  if (data.snapshotImport && !allowIncompleteClone) {
    const report = await readFile(path.join(directory, "clone-report.json"), "utf8").then(JSON.parse).catch(() => null);
    if (report?.status !== "complete") throw new Error("数据库副本尚未完整导入/迁移，不允许启动或复用。保留现场并用新 instance 重试。");
  }
  return data;
}

async function prepare({ applyMigrations = true, allowIncompleteClone = false } = {}) {
  let metadata;
  if (existsSync(metadataFile)) {
    metadata = await loadMetadata({ allowIncompleteClone });
    for (const [option, key] of [["--port", "port"], ["--inspector-port", "inspectorPort"]]) {
      if (options[option] && portOf(options[option]) !== metadata[key]) throw new Error("已有实例端口不匹配，请使用新 instance。");
    }
  } else {
    if (existsSync(directory)) throw new Error("目录已存在但没有有效实例标记；不覆盖，改用新 instance。");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const port = options["--port"] ? portOf(options["--port"]) : command === "verify" ? await freePort() : 8790;
    let inspectorPort = options["--inspector-port"] ? portOf(options["--inspector-port"]) : command === "verify" ? await freePort() : portOf(port + 1);
    if (inspectorPort === port) throw new Error("HTTP 和 inspector 端口不能相同。");
    metadata = { kind, instance, nonce: randomBytes(24).toString("hex"), port, inspectorPort, createdAt: new Date().toISOString(), ...(command === "clone" ? { snapshotImport: true } : {}) };
    await writeFile(metadataFile, JSON.stringify(metadata, null, 2), { mode: 0o600, flag: "wx" });
    await writeFile(path.join(directory, ".dev.vars"), `ADMIN_PASSWORD=${randomBytes(18).toString("base64url")}\nADMIN_SECRET=${randomBytes(48).toString("base64url")}\nEMAIL_CODE_PEPPER=${randomBytes(48).toString("base64url")}\nMAIL_PAYLOAD_KEY=${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  }
  // Older local instances keep their credentials/data; only add missing local mail secrets.
  const localVarsFile = path.join(directory, ".dev.vars");
  const localVars = await readFile(localVarsFile, "utf8");
  let additions = "";
  for (const key of ["EMAIL_CODE_PEPPER", "MAIL_PAYLOAD_KEY"]) {
    if (!new RegExp(`^${key}=.+$`, "m").test(localVars)) additions += `${key}=${randomBytes(48).toString("base64url")}\n`;
  }
  if (additions) await writeFile(localVarsFile, `${localVars.endsWith("\n") ? "" : "\n"}${additions}`, { flag: "a", mode: 0o600 });
  const source = ts.parseConfigFileTextToJson("wrangler.jsonc", await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  if (source.error) throw new Error("无法解析仓库 wrangler.jsonc。");
  const disabled = {
    TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "", FEISHU_WEBHOOK: "",
    VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "",
    RESEND_API_KEY: "", RESEND_WEBHOOK_SECRET: "", MAIL_MODE: "test", MAIL_DAILY_LIMIT: "200", MAIL_FROM: "noreply@mail.example.test", MAINTENANCE: "0",
  };
  const entry = path.relative(directory, path.join(root, "src/index.ts")).split(path.sep).join("/");
  const emailEntry = path.relative(directory, path.join(root, "src/email.ts")).split(path.sep).join("/");
  const wrapper = `import worker from ${JSON.stringify(entry)};
import { readTestMail, processMailOutbox } from ${JSON.stringify(emailEntry)};
const disabled = ${JSON.stringify(disabled)};
const nonce = ${JSON.stringify(metadata.nonce)};
const control = {};
const json = (value, status = 200) => Response.json(value, {status, headers: {"cache-control": "no-store"}});
const isLoopback = host => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, "0")).join("");
async function fixture(request, env) {
  const text = await request.text();
  if (text.length > 16000) return json({error:"本地请求过大"}, 413);
  const body = JSON.parse(text || "{}");
  if (body.action === "set-demo-actors") {
    if (!Array.isArray(body.actors) || body.actors.length > 20 || body.actors.some(actor => typeof actor.name !== "string" || typeof actor.password !== "string" || actor.password.length > 128 || actor.email && !actor.email.endsWith("@example.test"))) return json({error:"只允许本地合成演示账号"},400);
    await env.DB.prepare("INSERT INTO settings (key,value) VALUES ('local_demo_actors',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(body.actors)).run();
    return json({ok:true});
  }
  if (body.action === "grant-admin") {
    const account = await env.DB.prepare("SELECT id FROM accounts WHERE id = ? AND email LIKE '%@example.test' AND verified_at > 0 AND status = 'active'").bind(body.accountId).first();
    if (!account) return json({error:"只允许已验证的本地合成账号"}, 400);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO account_roles (account_id, role) VALUES (?, 'admin')").bind(account.id),
      env.DB.prepare("UPDATE accounts SET session_version = session_version + 1 WHERE id = ?").bind(account.id),
      env.DB.prepare("UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at = 0").bind(Date.now(), account.id),
    ]);
    return json({ok:true});
  }
  if (body.action === "create-legacy") {
    if (!/^tangbao-local-legacy[a-z0-9-]{0,30}$/.test(body.operatorId || "") || typeof body.password !== "string" || body.password.length < 16) return json({error:"合成模型格式错误"}, 400);
    await env.DB.prepare("INSERT INTO operators (id, password_hash, active, awake, created_at, blurb) VALUES (?, ?, ?, 0, ?, '本地旧模型迁移演练')").bind(body.operatorId, await hash(body.password), body.active === false ? 0 : 1, Date.now()).run();
    return json({ok:true,operatorId:body.operatorId});
  }
  return json({error:"未知的本地合成操作"},400);
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const scoped = {...env, ...disabled, ...control, APP_ORIGIN: url.origin, EMAIL: undefined};
    if (!isLoopback(url.hostname)) return json({error:"本地沙箱仅允许回环主机"},403);
    if (url.pathname === "/__local/health") {
      return Response.json({kind: ${JSON.stringify(kind)}, instance: ${JSON.stringify(instance)}, integrations: "local-mail-test", externalSending: false}, {headers: {"x-tangbao-local": nonce, "cache-control": "no-store"}});
    }
    if (url.pathname.startsWith("/__local/")) {
      const demoAuthorized = url.pathname === "/__local/demo" && request.method === "GET" && url.searchParams.get("nonce") === nonce;
      if (request.headers.get("x-tangbao-local") !== nonce && !demoAuthorized) return json({error:"本地实例凭据不匹配"},403);
      if (demoAuthorized) return new Response(${JSON.stringify(demoHtml(metadata))}, {headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer"}});
      if (url.pathname === "/__local/demo-actors" && request.method === "GET") {
        const row = await env.DB.prepare("SELECT value FROM settings WHERE key='local_demo_actors'").first();
        return json({actors: row ? JSON.parse(row.value) : []});
      }
      if (url.pathname === "/__local/model-state" && request.method === "GET") {
        const account = await env.DB.prepare("SELECT id FROM accounts WHERE id=? AND email LIKE '%@example.test'").bind(url.searchParams.get("accountId")).first();
        if (!account) return json({error:"只允许本地合成账号"},400);
        const model = await env.DB.prepare("SELECT id,operator_uid AS uid,owner_account_id AS owner,active FROM operators WHERE owner_account_id=?").bind(account.id).first();
        if (!model) return json({model:null,applications:[],blocks:[],subscriptions:[]});
        const [applications,blocks,subscriptions] = await Promise.all([
          env.DB.prepare("SELECT operator_id AS operatorId,suffix,status FROM applications WHERE account_id=?").bind(account.id).all(),
          env.DB.prepare("SELECT id,operator_id AS operatorId FROM blocks WHERE operator_id=? ORDER BY id LIMIT 100").bind(model.id).all(),
          env.DB.prepare("SELECT endpoint,operator_id AS operatorId FROM push_subscriptions WHERE operator_id=? ORDER BY endpoint LIMIT 100").bind(model.id).all(),
        ]);
        return json({model,applications:applications.results,blocks:blocks.results,subscriptions:subscriptions.results});
      }
      if (url.pathname === "/__local/deliveries" && request.method === "GET") {
        await processMailOutbox(scoped);
        return json({deliveries:(await env.DB.prepare("SELECT challenge_id AS challengeId,status,attempts,last_error AS lastError,expires_at AS expiresAt FROM mail_deliveries ORDER BY created_at DESC LIMIT 100").all()).results});
      }
      if (url.pathname === "/__local/mail" && request.method === "GET") {
        await processMailOutbox(scoped);
        return json({messages: await readTestMail(scoped, url.searchParams.get("challengeId") || undefined)});
      }
      if (url.pathname === "/__local/fixture" && request.method === "POST") return fixture(request, scoped);
      if (url.pathname === "/__local/control" && request.method === "POST") {
        const body = await request.json();
        if (body.now === null) delete control.AUTH_TEST_NOW;
        else if (body.now !== undefined) {
          if (!Number.isSafeInteger(body.now) || body.now < 1) return json({error:"无效测试时钟"},400);
          control.AUTH_TEST_NOW = String(body.now);
        }
        if (body.failure === null) delete control.MAIL_TEST_FAILURE;
        else if (body.failure !== undefined) {
          if (!["rate_limit","permanent","unknown"].includes(body.failure)) return json({error:"无效邮件故障"},400);
          control.MAIL_TEST_FAILURE = body.failure;
        }
        if (body.budgetUsed !== undefined) {
          if (!Number.isInteger(body.budgetUsed) || body.budgetUsed < 0 || body.budgetUsed > 200) return json({error:"无效测试预算"},400);
          const period = new Date(Number(control.AUTH_TEST_NOW) || Date.now()).toISOString().slice(0,10);
          await env.DB.prepare("INSERT INTO mail_budgets (period, used) VALUES (?, ?) ON CONFLICT(period) DO UPDATE SET used=excluded.used").bind(period,body.budgetUsed).run();
        }
        return json({ok:true});
      }
      return json({error:"没有该本地操作"},404);
    }
    return worker.fetch(request, scoped, ctx);
  },
  scheduled(controller, env, ctx) { return worker.scheduled(controller, {...env, ...disabled, ...control, APP_ORIGIN: "http://127.0.0.1:${metadata.port}", EMAIL: undefined}, ctx); }
};\n`;
  await writeFile(path.join(directory, "worker.mjs"), wrapper);
  await writeFile(configFile, JSON.stringify({
    name: `tangbao-local-${instance}`,
    main: "./worker.mjs",
    compatibility_date: source.config.compatibility_date,
    compatibility_flags: source.config.compatibility_flags,
    tsconfig: path.relative(directory, path.join(root, "tsconfig.json")).split(path.sep).join("/"),
    workers_dev: false,
    preview_urls: false,
    assets: { directory: path.join(root, "public"), binding: "ASSETS", html_handling: "none", run_worker_first: ["/api/*", "/__local/*"] },
    kv_namespaces: [{ binding: "IMAGES", id: "00000000000000000000000000000000", remote: false }],
    d1_databases: [{ binding: "DB", database_name: `tangbao-local-${instance}`, database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: path.join(root, "migrations"), remote: false }],
    vars: disabled,
  }, null, 2));
  if (!applyMigrations) return metadata;
  const migrationLog = path.join(directory, "migrations.log");
  const log = openSync(migrationLog, "a", 0o600);
  try {
    await completed(launch(["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDirectory], ["ignore", log, log]));
  } catch (error) {
    throw new Error(`${error.message}；迁移日志：${migrationLog}`);
  } finally { closeSync(log); }
  const expected = (await readdir(path.join(root, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
  const query = launch(["d1", "execute", "DB", "--local", "--persist-to", stateDirectory, "--command", "SELECT name FROM d1_migrations ORDER BY name", "--json"], ["ignore", "pipe", "pipe"]);
  let output = "";
  query.stdout.on("data", (chunk) => { output += chunk; });
  query.stderr.on("data", () => {});
  await completed(query);
  const applied = JSON.parse(output).flatMap((result) => result.results.map((row) => row.name)).sort();
  if (JSON.stringify(applied) !== JSON.stringify(expected)) throw new Error("本地 D1 迁移清单与源码不一致。");
  console.log(`本地 D1 已核验 ${applied.length} 份迁移；日志：${migrationLog}`);
  return metadata;
}

async function checkServer(metadata) {
  const response = await fetch(`http://127.0.0.1:${metadata.port}/__local/health`, { redirect: "error", signal: AbortSignal.timeout(1500) });
  const data = await response.json();
  if (!response.ok || response.headers.get("x-tangbao-local") !== metadata.nonce || data.kind !== kind || data.instance !== instance) {
    throw new Error("本地服务标记不匹配，禁止向该服务写入测试数据。");
  }
}

function startServer(metadata, stdio = "inherit") {
  return launch(["dev", "--local", "--ip", "127.0.0.1", "--port", String(metadata.port), "--inspector-port", String(metadata.inspectorPort), "--persist-to", stateDirectory, "--show-interactive-dev-session=false", "--test-scheduled"], stdio);
}

async function waitReady(metadata, child) {
  const deadline = Date.now() + 30000;
  let last;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("本地 Worker 在就绪前退出。");
    try { await checkServer(metadata); return; } catch (error) { last = error; }
    await delay(250);
  }
  throw new Error(`Worker 未就绪：${last?.message}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  await stopped;
  clearTimeout(timeout);
}

function showInfo(metadata) {
  console.log(`实例：${instance}\n数据及凭据：${directory}\n服务：http://127.0.0.1:${metadata.port}`);
  console.log(`本地验收与验证码：http://127.0.0.1:${metadata.port}/__local/demo?nonce=${metadata.nonce}`);
  for (const role of ["admin", "operator-a", "operator-b", "visitor-a", "visitor-b"]) {
    console.log(`${role}: http://${role}-${instance}.localhost:${metadata.port}/${role.startsWith("visitor") ? "chat" : "desk"}`);
  }
}

async function seed(metadata) {
  await checkServer(metadata);
  if (existsSync(fixtureFile)) {
    const fixture = JSON.parse(await readFile(fixtureFile, "utf8"));
    if (fixture.instanceNonce !== metadata.nonce) throw new Error("合成数据不属于此实例。");
    if (fixture.status !== "complete") throw new Error("上一次合成流程未完整结束；保留证据并使用新的 instance。");
    console.log(`复用既有合成身份，不重复申请/创建：${fixtureFile}`);
    return fixture;
  }
  return runScenarios({ metadata, directory, fixtureFile, includeEdgeScenarios: command === "verify", checkServer: () => checkServer(metadata) });
}

if (command === "clone") {
  if (!options["--instance"] || !options["--snapshot"] || !options["--baseline"]) throw new Error("clone 需要 --instance、--snapshot <SQL备份>、--baseline <已执行迁移JSON>；可用 --port 指定端口。");
  if (existsSync(directory)) throw new Error("副本必须使用全新 instance；不覆盖已有数据或失败证据。");
  const metadata = await prepare({ applyMigrations: false });
  await importSnapshot({ snapshot: options["--snapshot"], baseline: options["--baseline"], directory, stateDirectory, root, launch, completed, applyMigrations: () => prepare({ allowIncompleteClone: true }) });
  showInfo(metadata);
} else if (command === "prepare") {
  showInfo(await prepare());
} else if (command === "dev") {
  const metadata = await loadMetadata();
  showInfo(metadata);
  const child = startServer(metadata);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stopping = true; child.kill(signal); });
  try { await completed(child); } catch (error) { if (!stopping) throw error; }
} else if (command === "info") {
  showInfo(await loadMetadata());
} else if (command === "seed") {
  await seed(await loadMetadata());
} else if (command === "verify") {
  if (existsSync(metadataFile)) throw new Error("自动验证必须使用全新 instance；历史结果保留，不覆盖或自动清空。");
  const metadata = await prepare();
  showInfo(metadata);
  const log = openSync(path.join(directory, "server.log"), "a", 0o600);
  const child = startServer(metadata, ["ignore", log, log]);
  const lifecycle = { instance, startedAt: new Date().toISOString(), status: "starting" };
  try {
    await waitReady(metadata, child);
    lifecycle.status = "ready";
    await seed(metadata);
    lifecycle.status = "complete";
  } catch (error) {
    lifecycle.status = "failed";
    lifecycle.reason = error.message;
    throw error;
  } finally {
    await stopServer(child);
    closeSync(log);
    lifecycle.stoppedAt = new Date().toISOString();
    await writeFile(path.join(directory, "lifecycle.json"), JSON.stringify(lifecycle, null, 2), { mode: 0o600, flag: "wx" });
  }
}
