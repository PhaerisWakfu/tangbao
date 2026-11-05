import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".tmp"), { recursive: true, mode: 0o700 });
const source = await readFile(path.join(root, "src/index.ts"), "utf8");
const schema = await readFile(path.join(root, "src/schema.ts"), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const adapter = ast.statements.filter(n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) &&
  ["d1Meta", "TursoStatement", "TursoDatabase"].includes(n.name?.text)).map(n => n.getText(ast)).join("\n");
const compile = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
async function fixture(t, complete = true) {
  const directory = await mkdtemp(path.join(root, ".tmp/schema-test-"));
  const client = createClient({ url: `file:${path.join(directory, "synthetic.db")}` });
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  for (const file of (await readdir(path.join(root, "migrations"))).filter(n => n.endsWith(".sql") && (complete || n < "0024")).sort()) {
    await client.executeMultiple(await readFile(path.join(root, "migrations", file), "utf8"));
  }
  let now = 1_800_000_000_000;
  const scope = { exports: {}, Date: { now: () => now }, console: { log() {} } };
  new Script(compile(adapter + "\n" + schema + "\nglobalThis.Database=TursoDatabase;")).runInNewContext(scope);
  const database = new scope.Database(client), statements = [];
  const binding = { prepare(sql) { statements.push(sql); return database.prepare(sql); } };
  return { client, binding, statements, check: scope.exports.assertSchemaReady, advance: n => { now += n; },
    upgrade: () => client.executeMultiple(migration24 + "\n" + migration25),
  };
}
const migration24 = await readFile(path.join(root, "migrations/0024_app_schema_version.sql"), "utf8");
const migration25 = await readFile(path.join(root, "migrations/0025_message_paging.sql"), "utf8");
const missing = error => error.code === "SCHEMA_NOT_READY" && !error.message.includes("SELECT");

test("missing migration fails without schema repair or user-data writes", async t => {
  const f = await fixture(t, false);
  const before = await f.client.execute("SELECT name,sql FROM sqlite_schema ORDER BY name");
  await assert.rejects(f.check(f.binding), missing);
  assert.deepEqual((await f.client.execute("SELECT name,sql FROM sqlite_schema ORDER BY name")).rows, before.rows);
  assert.equal((await f.client.execute("SELECT value FROM settings WHERE key='app_schema_version'")).rows.length, 0);
  assert.equal(f.statements.length, 1); assert(f.statements.every(sql => sql.trimStart().startsWith("SELECT")));
});
test("complete schema uses a single cached read and coalesces concurrent checks", async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 10 }, () => f.check(f.binding)));
  await f.check(f.binding); assert.equal(f.statements.length, 1);
  f.advance(60_001); await f.check(f.binding); assert.equal(f.statements.length, 2);
});
test("applying the missing migration recovers after the short negative cache", async t => {
  const f = await fixture(t, false); await assert.rejects(f.check(f.binding), missing);
  await f.upgrade(); await assert.rejects(f.check(f.binding), missing);
  f.advance(1_001); await f.check(f.binding); assert.equal(f.statements.length, 2);
});
test("marker alone cannot hide a missing core column", async t => {
  const f = await fixture(t); await f.client.execute("ALTER TABLE threads RENAME COLUMN reported_at TO missing_reported_at");
  await assert.rejects(f.check(f.binding), missing);
  assert.equal((await f.client.execute("SELECT name FROM pragma_table_info('threads') WHERE name='reported_at'")).rows.length, 0);
});
test("one database binding cannot reuse another binding's successful check", async t => {
  const f = await fixture(t), other = await fixture(t, false);
  await f.check(f.binding); await assert.rejects(f.check(other.binding), missing);
});
test("manual marker changes are detected after positive cache expiry", async t => {
  const f = await fixture(t); await f.check(f.binding);
  await f.client.execute("DELETE FROM settings WHERE key='app_schema_version'");
  await f.check(f.binding); assert.equal(f.statements.length, 1);
  f.advance(60_001); await assert.rejects(f.check(f.binding), missing);
});
test("a version marker cannot hide a missing message paging index", async t => {
  const f = await fixture(t); await f.client.execute("DROP INDEX idx_messages_thread_order");
  await assert.rejects(f.check(f.binding), missing);
});
test("a pre-merge schema marker cannot hide the missing pin migration", async t => {
  const f = await fixture(t); await f.client.execute("DROP TABLE thread_pins");
  await assert.rejects(f.check(f.binding), missing);
});
