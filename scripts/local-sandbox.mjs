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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const kind = "tangbao-local-sandbox/v1";
const commands = new Set(["prepare", "dev", "seed", "verify", "info"]);
const [command, ...args] = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--instance", "--port", "--inspector-port"].includes(args[i]) || !args[i + 1]) {
    throw new Error("只接受 --instance、--port、--inspector-port；不接受远程基址或 Wrangler 透传参数。");
  }
  if (options[args[i]]) throw new Error(`重复参数 ${args[i]}`);
  options[args[i]] = args[i + 1];
}
if (!commands.has(command)) {
  throw new Error("用法：node scripts/local-sandbox.mjs prepare|dev|seed|verify|info [--instance demo] [--port 8790]");
}
if (!["prepare", "verify"].includes(command) && (options["--port"] || options["--inspector-port"])) {
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

async function loadMetadata() {
  const data = JSON.parse(await readFile(metadataFile, "utf8"));
  if (data.kind !== kind || data.instance !== instance || !/^[a-f0-9]{48}$/.test(data.nonce)) {
    throw new Error("实例标记不匹配，停止操作。");
  }
  portOf(data.port);
  portOf(data.inspectorPort);
  return data;
}

async function prepare() {
  let metadata;
  if (existsSync(metadataFile)) {
    metadata = await loadMetadata();
    for (const [option, key] of [["--port", "port"], ["--inspector-port", "inspectorPort"]]) {
      if (options[option] && portOf(options[option]) !== metadata[key]) throw new Error("已有实例端口不匹配，请使用新 instance。");
    }
  } else {
    if (existsSync(directory)) throw new Error("目录已存在但没有有效实例标记；不覆盖，改用新 instance。");
    await mkdir(directory, { recursive: true });
    const port = options["--port"] ? portOf(options["--port"]) : command === "verify" ? await freePort() : 8790;
    let inspectorPort = options["--inspector-port"] ? portOf(options["--inspector-port"]) : command === "verify" ? await freePort() : portOf(port + 1);
    if (inspectorPort === port) throw new Error("HTTP 和 inspector 端口不能相同。");
    metadata = { kind, instance, nonce: randomBytes(24).toString("hex"), port, inspectorPort, createdAt: new Date().toISOString() };
    await writeFile(metadataFile, JSON.stringify(metadata, null, 2), { mode: 0o600, flag: "wx" });
    await writeFile(path.join(directory, ".dev.vars"), `ADMIN_PASSWORD=${randomBytes(18).toString("base64url")}\nADMIN_SECRET=${randomBytes(48).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  }
  const source = ts.parseConfigFileTextToJson("wrangler.jsonc", await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  if (source.error) throw new Error("无法解析仓库 wrangler.jsonc。");
  const disabled = {
    TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "", FEISHU_WEBHOOK: "",
    VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", VAPID_SUBJECT: "",
    RESEND_API_KEY: "", RESEND_WEBHOOK_SECRET: "", MAIL_MODE: "disabled", MAINTENANCE: "0",
  };
  const entry = path.relative(directory, path.join(root, "src/index.ts")).split(path.sep).join("/");
  const wrapper = `import worker from ${JSON.stringify(entry)};
const disabled = ${JSON.stringify(disabled)};
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__local/health") {
      return Response.json({kind: ${JSON.stringify(kind)}, instance: ${JSON.stringify(instance)}, integrations: "disabled"}, {headers: {"x-tangbao-local": ${JSON.stringify(metadata.nonce)}, "cache-control": "no-store"}});
    }
    return worker.fetch(request, {...env, ...disabled}, ctx);
  },
  scheduled(controller, env, ctx) { return worker.scheduled(controller, {...env, ...disabled}, ctx); }
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
  const vars = Object.fromEntries((await readFile(path.join(directory, ".dev.vars"), "utf8")).trim().split(/\r?\n/).map((line) => {
    const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
  }));
  return runScenarios({ metadata, directory, fixtureFile, adminPassword: vars.ADMIN_PASSWORD, checkServer: () => checkServer(metadata) });
}

if (command === "prepare") {
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
