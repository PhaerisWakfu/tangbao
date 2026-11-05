import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".tmp"), { recursive: true, mode: 0o700 });
const source = await readFile(path.join(root, "src/index.ts"), "utf8");
const cleanup = await readFile(path.join(root, "src/image-cleanup.ts"), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const names = ["writeMessage", "storeImages", "imageInserts", "caption", "previewFrom"];
const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
assert.equal(functions.length, names.length);
const adapter = source.slice(source.indexOf("function d1Meta("), source.indexOf("let reportsSchemaReady"));
const code = ts.transpileModule(adapter + "\n" + cleanup + "\n" + functions.map(n => n.getText(ast)).join("\n") +
  "\nglobalThis.Database=TursoDatabase;globalThis.append=writeMessage;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function fixture(t) {
  const directory = await mkdtemp(path.join(root, ".tmp/image-upload-test-"));
  const client = createClient({ url: `file:${path.join(directory, "synthetic.db")}` });
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  for (const file of ["0001_init.sql", "0003_images.sql", "0004_message_images.sql", "0005_draw.sql", "0017_thread_last_role.sql", "0023_image_cleanup_jobs.sql"]) {
    await client.executeMultiple(await readFile(path.join(root, "migrations", file), "utf8"));
  }
  let now = 1_800_000_000_000;
  class AuthError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  const scope = { exports: {}, Date: { now: () => now }, randomId: () => randomUUID(), AuthError, console: { log() {} } };
  new Script(code).runInNewContext(scope);
  const db = new scope.Database(client), files = new Map([["img/existing", new Uint8Array([9])]]);
  await client.executeMultiple("INSERT INTO threads(id,token_hash,title,created_at,updated_at) VALUES('thread','synthetic','合成对话',1,1); INSERT INTO messages(id,thread_id,role,body,created_at) VALUES('existing','thread','visitor','已有消息',1); INSERT INTO message_images(id,message_id,image_key,image_type,position) VALUES('existing','existing','img/existing','image/png',0)");
  const fault = { put: "", db: "", verify: false, queue: false, delete: false, late: null };
  const originalError = new Error("synthetic upload failure");
  const calls = { put: [], delete: [], batches: [], verify: 0 };
  const env = { DB: {
    prepare(sql) {
      if (sql.startsWith("SELECT id FROM messages")) { calls.verify++; if (fault.verify) throw new Error("synthetic read unavailable"); }
      return db.prepare(sql);
    },
    async batch(statements) {
      calls.batches.push(statements.length);
      if (statements[0].sql.includes("INSERT INTO image_cleanup_jobs") && fault.queue) throw new Error("synthetic queue unavailable");
      if (statements[0].sql.startsWith("INSERT INTO messages")) {
        if (fault.db === "late") { fault.late = statements; throw new Error("synthetic delayed transaction"); }
        if (fault.db === "unknown") throw new Error("synthetic transport failure");
        const result = await db.batch(statements);
        if (fault.db === "response-lost") throw new Error("synthetic commit response lost");
        return result;
      }
      return db.batch(statements);
    },
  }, IMAGES: {
    async put(key, bytes) {
      calls.put.push(key);
      if (fault.put === "second" && calls.put.length === 2) throw originalError;
      files.set(key, bytes);
      if (fault.put === "unknown" && calls.put.length === 1) throw originalError;
    },
    async delete(key) { calls.delete.push(key); if (fault.delete && key !== "img/existing") throw new Error("synthetic delete unavailable"); files.delete(key); },
  } };
  const input = count => ({ body: "合成消息", draw: false, images: Array.from({ length: count }, () => ({ bytes: new Uint8Array([1]).buffer, type: "image/png" })) });
  const append = (role = "visitor", count = 2) => scope.append(env, "thread", role, input(count), role === "visitor" ? 1 : 0);
  const count = async table => Number((await client.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n);
  const rejectDB = () => client.execute("CREATE TRIGGER synthetic_abort BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
  return { client, db, files, fault, calls, env, scope, append, count, rejectDB, originalError, advance: () => { now += 3_600_000; } };
}

for (const role of ["visitor", "tangbao"]) {
  test(`${role}: successful upload has no compensation queries or jobs`, async t => {
    const f = await fixture(t); await f.append(role);
    assert.equal(await f.count("messages"), 2); assert.equal(await f.count("message_images"), 3);
    assert.equal(f.files.size, 3); assert.deepEqual(f.calls.batches, [4]);
    assert.equal(f.calls.verify, 0); assert.equal(f.calls.delete.length, 0); assert.equal(await f.count("image_cleanup_jobs"), 0);
  });
  test(`${role}: second upload failure reclaims attempted files and preserves old image`, async t => {
    const f = await fixture(t); f.fault.put = "second";
    await assert.rejects(f.append(role), e => e === f.originalError);
    assert.deepEqual([...f.files.keys()], ["img/existing"]); assert.equal(await f.count("messages"), 1);
    assert.equal(await f.count("image_cleanup_jobs"), 0); assert.equal(f.calls.delete.length, 2);
  });
  test(`${role}: actual SQL rollback reclaims images without affecting the old message`, async t => {
    const f = await fixture(t); await f.rejectDB();
    await assert.rejects(f.append(role), /synthetic rollback/);
    assert.deepEqual([...f.files.keys()], ["img/existing"]); assert.equal(await f.count("messages"), 1);
    assert.equal(await f.count("message_images"), 1); assert.equal(await f.count("image_cleanup_jobs"), 0);
  });
  test(`${role}: lost commit response returns success and preserves sent images`, async t => {
    const f = await fixture(t); f.fault.db = "response-lost"; await f.append(role);
    assert.equal(await f.count("messages"), 2); assert.equal(await f.count("message_images"), 3);
    assert.equal(f.files.size, 3); assert.equal(f.calls.delete.length, 0); assert.equal(await f.count("image_cleanup_jobs"), 0);
  });
}

test("KV write acknowledgement lost still tracks the attempted key", async t => {
  const f = await fixture(t); f.fault.put = "unknown";
  await assert.rejects(f.append(), e => e === f.originalError);
  assert.deepEqual([...f.files.keys()], ["img/existing"]); assert.equal(await f.count("messages"), 1);
});

test("cleanup failure retains durable jobs for the existing retry processor", async t => {
  const f = await fixture(t); f.fault.put = "second"; f.fault.delete = true;
  await assert.rejects(f.append(), e => e === f.originalError);
  assert.equal(await f.count("image_cleanup_jobs"), 2); assert.equal(f.files.size, 2);
  f.fault.delete = false; f.advance(); await f.scope.exports.processImageCleanup(f.env);
  assert.equal(await f.count("image_cleanup_jobs"), 0); assert.deepEqual([...f.files.keys()], ["img/existing"]);
});

test("unknown result with no visible row is not assumed to be a rollback", async t => {
  const f = await fixture(t); f.fault.db = "unknown";
  await assert.rejects(f.append(), e => e.code === "MESSAGE_WRITE_UNKNOWN" && e.status === 503);
  assert.equal(await f.count("messages"), 1); assert.equal(f.files.size, 3);
  assert.equal(f.calls.delete.length, 0); assert.equal(await f.count("image_cleanup_jobs"), 0);
});

test("an initially invisible transaction can commit later without losing its files", async t => {
  const f = await fixture(t); f.fault.db = "late";
  await assert.rejects(f.append(), e => e.code === "MESSAGE_WRITE_UNKNOWN");
  await f.db.batch(f.fault.late); await f.scope.exports.processImageCleanup(f.env);
  assert.equal(await f.count("messages"), 2); assert.equal(await f.count("message_images"), 3);
  assert.equal(f.files.size, 3); assert.equal(f.calls.delete.length, 0);
});

test("committed message is retained if verification is unavailable", async t => {
  const f = await fixture(t); f.fault.db = "response-lost"; f.fault.verify = true;
  await assert.rejects(f.append(), e => e.code === "MESSAGE_WRITE_UNKNOWN");
  assert.equal(await f.count("messages"), 2); assert.equal(f.files.size, 3); assert.equal(f.calls.delete.length, 0);
});

test("a failed cleanup registration preserves the original sending error", async t => {
  const f = await fixture(t); f.fault.put = "second"; f.fault.queue = true;
  await assert.rejects(f.append(), e => e === f.originalError);
  assert.equal(await f.count("messages"), 1); assert.equal(await f.count("image_cleanup_jobs"), 0);
  assert.equal(f.files.size, 2); // Explicit boundary: no durable recovery was registered.
});

test("already-associated image cannot be registered for failed-upload cleanup", async t => {
  const f = await fixture(t);
  await f.scope.exports.cleanupUncommittedImages(f.env, "thread", [{ id: "existing", key: "img/existing" }]);
  assert.equal(f.files.size, 1); assert.equal(f.calls.delete.length, 0); assert.equal(await f.count("image_cleanup_jobs"), 0);
});

test("SQL rejection classification excludes transport and generic D1 failures", async t => {
  const f = await fixture(t), classify = f.scope.exports.isDefiniteDatabaseRejection;
  assert.equal(classify({ name: "LibsqlError", code: "SQLITE_CONSTRAINT" }), true);
  assert.equal(classify({ name: "D1_ERROR", message: "synthetic rollback: SQLITE_CONSTRAINT" }), true);
  assert.equal(classify({ name: "Error", message: "D1_ERROR: synthetic rollback: SQLITE_CONSTRAINT" }), true);
  for (const error of [{ name: "LibsqlError", code: "SERVER_ERROR" }, { name: "D1_ERROR", message: "connection lost" }, { message: "SQLITE_CONSTRAINT" }, new Error("timeout")]) assert.equal(classify(error), false);
});

test("text-only failures do not add image compensation or verification calls", async t => {
  const f = await fixture(t); await f.rejectDB(); await assert.rejects(f.append("visitor", 0));
  assert.equal(f.calls.verify, 0); assert.equal(f.calls.delete.length, 0); assert.equal(await f.count("image_cleanup_jobs"), 0);
});
