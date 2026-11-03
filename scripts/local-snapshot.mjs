import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

// D1 exports can interleave CREATE and INSERT while later tables are FK targets.
// Reuse Wrangler's SQLite-aware splitter (including quoted ';' and trigger bodies)
// rather than executing the dump in another engine or splitting on semicolons.
export async function normalizeD1Snapshot(source) {
  const { unstable_splitSqlQuery } = await import("wrangler");
  if (typeof unstable_splitSqlQuery !== "function") throw new Error("当前Wrangler未提供SQL分句器，请核对锁定版本后重试。");
  const tables = [], data = [], indexes = [], triggers = [];
  for (const statement of unstable_splitSqlQuery(new TextDecoder("utf-8", { fatal: true }).decode(source))) {
    const head = statement.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
    if (!head) continue;
    if (/^PRAGMA\s+defer_foreign_keys\s*=\s*(TRUE|ON|1)\s*;?$/i.test(head)) continue;
    if (/^CREATE\s+TABLE\s/i.test(head)) tables.push(statement);
    else if (/^(INSERT|REPLACE)\s+INTO\s/i.test(head)) data.push(statement);
    else if (/^DELETE\s+FROM\s+(sqlite_sequence|"sqlite_sequence"|`sqlite_sequence`|\[sqlite_sequence\])\s*;?$/i.test(head)) data.push(statement);
    else if (/^CREATE\s+(UNIQUE\s+)?INDEX\s/i.test(head) || /^CREATE\s+VIEW\s/i.test(head)) indexes.push(statement);
    else if (/^CREATE\s+TRIGGER\s/i.test(head)) triggers.push(statement);
    else throw new Error("快照包含不支持的SQL语句；仅接受完整D1结构/数据导出，请先核对备份格式。");
  }
  if (!tables.length) throw new Error("快照没有建表结构，不能作为完整数据库副本导入。");
  return ["PRAGMA defer_foreign_keys=TRUE", ...tables, ...indexes, ...data, ...triggers].map(statement => statement.trim().replace(/;$/, "") + ";").join("\n");
}

// This module only receives the sandbox's fixed local Wrangler launcher. It has
// no provider credentials, remote target, export or production-write operation.
export async function importSnapshot({ snapshot, baseline, directory, stateDirectory, root, launch, completed, applyMigrations }) {
  const report = { status: "started", remote: false, sourceModified: false, realSending: false, startedAt: new Date().toISOString() };
  const reportFile = path.join(directory, "clone-report.json");
  let operation = 0;
  const record = () => writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  async function run(args) {
    const child = launch([...args, "--local", "--persist-to", stateDirectory], ["ignore", "pipe", "pipe"]);
    let stdout = "", stderr = "";
    // A pipe chunk can end inside a multibyte character; decode across chunks.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    try { await completed(child); }
    catch {
      // SQL/errors may contain real records: keep details in a private local log.
      await writeFile(path.join(directory, `clone-operation-${++operation}.log`), stdout + "\n" + stderr, { mode: 0o600 });
      throw new Error("副本导入失败；详情仅写入实例目录，源备份和线上数据库未改动。请保留实例并使用新名称重试。");
    }
    return JSON.parse(stdout);
  }
  const query = async sql => (await run(["d1", "execute", "DB", "--command", sql, "--json"])).flatMap(entry => entry.results || []);
  const fileSQL = async (name, sql) => {
    const file = path.join(directory, name);
    await writeFile(file, sql, { mode: 0o600, flag: "wx" });
    return run(["d1", "execute", "DB", "--file", file, "--json"]);
  };
  const counts = async () => {
    const names = ["threads", "messages", "message_images", "operators", "applications", "accounts"];
    const existing = new Set((await query("SELECT name FROM sqlite_schema WHERE type='table'")).map(row => row.name));
    const result = {};
    for (const name of names) if (existing.has(name)) result[name] = (await query(`SELECT COUNT(*) AS count FROM "${name}"`))[0].count;
    return result;
  };
  await record();
  try {
    const [source, manifest, files] = await Promise.all([
      readFile(path.resolve(snapshot)), readFile(path.resolve(baseline), "utf8"), readdir(path.join(root, "migrations")),
    ]);
    const parsed = JSON.parse(manifest);
    const rows = Array.isArray(parsed) && parsed.every(value => typeof value === "string") ? parsed
      : Array.isArray(parsed) ? parsed.flatMap(value => value.results || [value]).map(value => value.name) : parsed.migrations;
    const expected = files.filter(file => file.endsWith(".sql")).sort();
    if (!Array.isArray(rows) || rows.length === 0 || rows.some(value => typeof value !== "string")) throw new Error("请提供真实已执行迁移清单（JSON名称数组或Wrangler查询JSON），不能猜测源库版本。");
    const applied = [...new Set(rows)].sort();
    if (applied.length !== rows.length || JSON.stringify(applied) !== JSON.stringify(expected.slice(0, applied.length))) throw new Error("源迁移清单不是当前代码的连续已知版本，需先核对源库，不自动补造版本。");
    report.sourceSHA256 = createHash("sha256").update(source).digest("hex");
    report.baseline = applied;
    // Copy the immutable input before execution. The original file is never edited.
    const copied = path.join(directory, "source-snapshot.sql");
    await writeFile(copied, source, { mode: 0o600, flag: "wx" });
    await fileSQL("normalized-snapshot.sql", await normalizeD1Snapshot(source));
    report.normalization = "Wrangler SQLite splitter; all tables before data; indexes before data, triggers after data; original unchanged";
    await fileSQL("snapshot-registry.sql", `CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);`);
    const imported = (await query("SELECT name FROM d1_migrations ORDER BY name")).map(row => row.name);
    if (imported.length && JSON.stringify(imported) !== JSON.stringify(applied)) throw new Error("SQL备份中的迁移记录与独立清单不一致，停止迁移副本。");
    if (!imported.length) await fileSQL("snapshot-baseline.sql", applied.map(name => `INSERT INTO d1_migrations(name) VALUES ('${name}');`).join("\n"));
    report.before = await counts();
    if (!["threads", "messages", "operators", "applications"].every(name => name in report.before)) throw new Error("备份缺少糖包核心表，请核对是否为完整备份。");
    await applyMigrations();
    report.after = await counts();
    if (Object.entries(report.before).some(([name, count]) => report.after[name] !== count)) throw new Error("迁移前后核心记录数量变化，停止交付并保留副本调查。");
    // A copied session/outbox must never impersonate production or resend old mail.
    await fileSQL("snapshot-local-reset.sql", `
      UPDATE account_sessions SET revoked_at=1 WHERE revoked_at=0;
      UPDATE legacy_claims SET consumed_at=1 WHERE consumed_at=0;
      UPDATE email_challenges SET revoked_at=1 WHERE revoked_at=0;
      UPDATE mail_deliveries SET payload_ciphertext=NULL,
        status=CASE WHEN status IN ('queued','sending','retry') THEN 'cancelled' ELSE status END;
    `);
    report.pendingApplied = expected.slice(applied.length);
    report.images = { metadata: report.after.message_images || 0, kvCopied: false, note: "SQL不含KV图片文件；旧图片待单独复制，禁止回连生产KV。" };
    report.status = "complete";
    report.finishedAt = new Date().toISOString();
    await record();
    console.log(`副本已导入并迁移；源文件未改动，真实邮件/推送关闭。结果：${reportFile}`);
    if (report.images.metadata) console.log("备份含图片元数据，KV文件未复制，旧图片尚不可验收。");
  } catch (error) {
    report.status = "failed";
    report.reason = error.message;
    await record();
    throw error;
  }
}
