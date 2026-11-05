import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

// A separate journal avoids pretending that D1's migration bookkeeping is portable.
export async function migrate(client, directory) {
  directory = directory instanceof URL ? fileURLToPath(directory) : directory;
  const files = (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const tx = await client.transaction("write");
  const applied = [];
  try {
    const tables = (await tx.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows.map(row => row.name);
    if (tables.length && !tables.includes("_tangbao_migrations")) throw new Error("已有数据库缺少 Turso 迁移台账，停止；请先核对已执行 SQL，不自动猜测或重放历史迁移。");
    await tx.execute("CREATE TABLE IF NOT EXISTS _tangbao_migrations(name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)");
    const history = (await tx.execute("SELECT name, sha256 FROM _tangbao_migrations ORDER BY name")).rows;
    const migrations = await Promise.all(files.map(async name => {
      const sql = await readFile(path.join(directory, name), "utf8");
      return { name, sql, hash: createHash("sha256").update(sql).digest("hex") };
    }));
    for (let i = 0; i < history.length; i++) {
      if (history[i].name !== migrations[i]?.name || history[i].sha256 !== migrations[i]?.hash) throw new Error("已执行迁移与当前文件不一致，停止；请核对版本和迁移基线。");
    }
    for (const migration of migrations.slice(history.length)) {
      await tx.executeMultiple(migration.sql);
      await tx.execute({ sql: "INSERT INTO _tangbao_migrations(name,sha256) VALUES(?,?)", args: [migration.name, migration.hash] });
      applied.push(migration.name);
    }
    await tx.commit();
    return applied;
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  } finally { tx.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let options;
  if (args.length === 2 && args[0] === "--database" && !args[1].includes("://")) {
    options = { url: pathToFileURL(path.resolve(args[1])).href };
  } else if (args.length === 1 && args[0] === "--remote") {
    if (!/^(libsql|https):\/\//.test(process.env.TURSO_DATABASE_URL || "") || !process.env.TURSO_AUTH_TOKEN) throw new Error("远程入口需要环境变量 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN；不从 .dev.vars 读取。");
    options = { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN };
  } else throw new Error("用法：npm run migrate:turso -- --database .tmp/turso-test.db（本地）；远程需另行授权后使用 --remote 和环境变量。不透传其他参数。");
  const client = createClient(options);
  try {
    const applied = await migrate(client, new URL("../migrations/", import.meta.url));
    console.log(applied.length ? `已应用 ${applied.length} 份迁移：\n${applied.join("\n")}` : "数据库迁移已是当前版本。");
  } catch { console.error("迁移未完成，事务已回滚。检查数据库可用性、迁移台账及当前 SQL；不要手工跳过失败的迁移。"); process.exitCode = 1; }
  finally { client.close(); }
}
