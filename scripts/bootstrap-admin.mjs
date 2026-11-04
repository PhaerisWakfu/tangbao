import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

// This script never loads business secrets. The deployment owner authorizes a
// particular Wrangler target and a verified account, rather than publishing a
// password-based role-grant endpoint.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (["--local", "--remote", "--execute", "--recovery"].includes(key)) {
    if (options[key]) throw Error(`重复参数 ${key}`);
    options[key] = true;
  } else if (["--account-id", "--config", "--persist-to"].includes(key) && args[i + 1]) {
    if (options[key]) throw Error(`重复参数 ${key}`);
    options[key] = args[++i];
  } else throw Error("用法：node scripts/bootstrap-admin.mjs --account-id <已验证账号ID> --config <wrangler配置> (--local --persist-to <目录> | --remote) [--execute] [--recovery]");
}
const accountId = options["--account-id"];
if (!/^[A-Za-z0-9_-]{16,80}$/.test(accountId || "")) throw Error("必须指定有效的已验证账号 ID。");
if (!options["--config"] || Boolean(options["--local"]) === Boolean(options["--remote"])) throw Error("必须明确配置文件，并且只选择 --local 或 --remote。");
if (options["--local"] && !options["--persist-to"]) throw Error("本地操作必须指定隔离实例的 --persist-to。");
if (options["--remote"] && options["--persist-to"]) throw Error("远程目标不能附带本地持久化目录。");

const sql = `-- Verified target: ${accountId}; mode: ${options["--recovery"] ? "controlled recovery" : "first administrator"}
INSERT INTO account_roles(account_id,role)
SELECT id,'admin' FROM accounts
WHERE id='${accountId}' AND verified_at>0 AND status='active'
${options["--recovery"] ? "" : "AND NOT EXISTS(SELECT 1 FROM account_roles WHERE role='admin')"}
ON CONFLICT(account_id,role) DO NOTHING;
SELECT a.id,a.status,a.verified_at,
  EXISTS(SELECT 1 FROM account_roles r WHERE r.account_id=a.id AND r.role='admin') AS is_admin
FROM accounts a WHERE a.id='${accountId}';
SELECT event,created_at,details FROM account_admin_audit WHERE account_id='${accountId}' ORDER BY created_at DESC LIMIT 5;
`;
const directory = path.join(root, ".tmp/admin-bootstrap");
mkdirSync(directory, { recursive: true });
const sqlFile = path.join(directory, `${Date.now()}-${randomBytes(4).toString("hex")}.sql`);
writeFileSync(sqlFile, sql, { mode: 0o600, flag: "wx" });
const argv = [path.join(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "DB", "--config", path.resolve(options["--config"]), options["--remote"] ? "--remote" : "--local", "--file", sqlFile, "--json"];
if (options["--persist-to"]) argv.push("--persist-to", path.resolve(options["--persist-to"]));
console.log(`目标：${options["--remote"] ? "远程 D1" : "本地隔离 D1"}；账号：${accountId}`);
console.log(`SQL 预览：${sqlFile}`);
console.log(sql);
if (!options["--execute"]) {
  console.log("仅生成预览。核对目标后添加 --execute 才会执行；远程操作应由有权限的部署者完成。");
} else {
  const result = spawnSync(process.execPath, argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "Wrangler 执行失败。\n");
    process.exitCode = result.status || 1;
  } else {
    const entries = JSON.parse(result.stdout);
    const rows = entries.flatMap(entry => entry.results || []);
    const account = rows.find(row => row.id === accountId && "is_admin" in row);
    if (!account || account.is_admin !== 1) throw Error("没有授予管理员：请确认账号已验证/启用；首个管理员模式要求当前尚无管理员。");
    console.log(JSON.stringify({ accountId, administrator: true, audit: rows.filter(row => row.event) }));
    console.log("管理员资格已核对；请使用邮箱和密码正常登录。原旧管理员口令不会成为新账号密码。");
  }
}
