import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".tmp"), { recursive: true, mode: 0o700 });
const source = await readFile(path.join(root, "src/index.ts"), "utf8");
const cleanupSource = await readFile(path.join(root, "src/image-cleanup.ts"), "utf8");
const adapterSource = source.slice(source.indexOf("function d1Meta("), source.indexOf("let reportsSchemaReady"));
const deletionSource = "async function deleteThread(" + source.split("async function deleteThread(")[1].split("\nfunction reportReasonOf")[0];
const compile = text => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function fixture(t) {
  // Only synthetic tables/files in a new local directory; no Wrangler config,
  // remote credentials, production data, or network service is used here.
  const directory = await mkdtemp(path.join(root, ".tmp/image-cleanup-test-"));
  const client = createClient({ url: `file:${path.join(directory, "synthetic.db")}` });
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  for (const name of ["0001_init.sql", "0003_images.sql", "0004_message_images.sql", "0005_draw.sql", "0023_image_cleanup_jobs.sql"]) {
    await client.executeMultiple(await readFile(path.join(root, "migrations", name), "utf8"));
  }
  const scope = {};
  new Script(compile(adapterSource + "\nglobalThis.Database = TursoDatabase;")).runInNewContext(scope);
  const db = new scope.Database(client);
  const files = new Map(), calls = [], failing = new Set();
  let now = 1_800_000_000_000;
  const env = { DB: db, IMAGES: { async delete(key) {
    calls.push(key);
    if (failing.has(key)) throw new Error("synthetic KV failure");
    files.delete(key);
  } } };
  const count = async (table, where = "1", args = []) => Number((await client.execute({ sql: `SELECT count(*) n FROM ${table} WHERE ${where}`, args })).rows[0].n);
  function loadWorker() {
    const context = { exports: {}, Date: { now: () => now }, console: { log() {} },
      loadOwned: async (_env, id) => assert.equal(await count("threads", "id=?", [id]), 1),
      bearer: () => "synthetic", json: value => value };
    new Script(compile(cleanupSource + "\n" + deletionSource + "\nglobalThis.remove = deleteThread;")).runInNewContext(context);
    return { drain: context.exports.processImageCleanup, remove: context.remove };
  }
  async function thread(id, images = 1) {
    const statements = [
      { sql: "INSERT INTO threads(id,token_hash,title,created_at,updated_at) VALUES(?,'synthetic','合成对话',1,1)", args: [id] },
      { sql: "INSERT INTO messages(id,thread_id,role,body,created_at) VALUES(?,?,'visitor','合成消息',1)", args: [`m-${id}`, id] },
    ];
    for (let i = 0; i < images; i++) {
      const key = `img/${id}-${i}`;
      files.set(key, new Uint8Array([1, 2, 3]));
      statements.push({ sql: "INSERT INTO message_images(id,message_id,image_key,image_type,position) VALUES(?,?,?,'image/png',?)", args: [`i-${id}-${i}`, `m-${id}`, key, i] });
    }
    await client.batch(statements, "write");
  }
  async function job(id) {
    await client.execute({ sql: "INSERT INTO image_cleanup_jobs(image_key,thread_id,attempts,next_attempt_at,created_at) VALUES(?,?,0,?,?)", args: [`img/${id}`, id, now, now] });
    files.set(`img/${id}`, new Uint8Array([1]));
  }
  return { client, db, env, files, calls, failing, count, loadWorker, thread, job, setNow: value => { now = value; }, now: () => now };
}

test("deletion clears metadata and files while preserving another thread", async t => {
  const f = await fixture(t), worker = f.loadWorker();
  await f.thread("deleted", 3); await f.thread("kept", 1);
  assert.equal((await worker.remove({}, f.env, "deleted")).ok, true);
  assert.equal(await f.count("threads", "id=?", ["deleted"]), 0);
  assert.equal(await f.count("messages", "thread_id=?", ["deleted"]), 0);
  assert.equal(await f.count("message_images"), 1);
  assert.equal(await f.count("image_cleanup_jobs"), 0);
  assert.deepEqual([...f.files.keys()], ["img/kept-0"]);
});

test("failed KV deletion survives handler reload, backs off, and eventually clears", async t => {
  const f = await fixture(t); await f.thread("retry", 2); f.failing.add("img/retry-0");
  assert.equal((await f.loadWorker().remove({}, f.env, "retry")).ok, true);
  assert.equal(await f.count("threads"), 0); assert.equal(await f.count("message_images"), 0);
  assert.equal(await f.count("image_cleanup_jobs"), 1); assert.equal(f.files.size, 1);
  let row = (await f.client.execute("SELECT attempts,next_attempt_at FROM image_cleanup_jobs")).rows[0];
  assert.equal(row.attempts, 1); assert.equal(row.next_attempt_at, f.now() + 60_000);
  const reloaded = f.loadWorker(), previousCalls = f.calls.length;
  await reloaded.drain(f.env); assert.equal(f.calls.length, previousCalls);
  f.setNow(Number(row.next_attempt_at)); await reloaded.drain(f.env);
  row = (await f.client.execute("SELECT attempts,next_attempt_at FROM image_cleanup_jobs")).rows[0];
  assert.equal(row.attempts, 2); assert.equal(row.next_attempt_at, f.now() + 120_000);
  f.failing.clear(); f.setNow(Number(row.next_attempt_at)); await reloaded.drain(f.env);
  assert.equal(f.files.size, 0); assert.equal(await f.count("image_cleanup_jobs"), 0);
});

test("database rollback also rolls back jobs, before any file deletion", async t => {
  const f = await fixture(t); await f.thread("rollback", 2);
  await f.client.execute("CREATE TRIGGER synthetic_abort BEFORE DELETE ON threads BEGIN SELECT RAISE(ABORT,'synthetic abort'); END");
  await assert.rejects(f.loadWorker().remove({}, f.env, "rollback"), /synthetic abort/);
  assert.equal(await f.count("threads"), 1); assert.equal(await f.count("messages"), 1);
  assert.equal(await f.count("message_images"), 2); assert.equal(await f.count("image_cleanup_jobs"), 0);
  assert.equal(f.files.size, 2); assert.equal(f.calls.length, 0);
});

test("lost cleanup acknowledgement safely retries an already absent file", async t => {
  const f = await fixture(t); await f.job("ack");
  let failAck = true;
  const env = { ...f.env, DB: { prepare(sql) {
    if (failAck && sql.startsWith("DELETE FROM image_cleanup_jobs")) return { bind() { return { async run() { throw new Error("synthetic acknowledgement failure"); } }; } };
    return f.db.prepare(sql);
  } } };
  await f.loadWorker().drain(env); assert.equal(f.files.size, 0); assert.equal(await f.count("image_cleanup_jobs"), 1);
  failAck = false; f.setNow(f.now() + 60_000); await f.loadWorker().drain(env);
  assert.equal(await f.count("image_cleanup_jobs"), 0); assert.equal(f.calls.length, 2);
});

test("pending jobs survive failure to query the cleanup table", async t => {
  const f = await fixture(t); await f.thread("query", 1);
  const env = { ...f.env, DB: { prepare(sql) {
    if (sql.includes("SELECT image_key, attempts FROM image_cleanup_jobs")) throw new Error("synthetic query failure");
    return f.db.prepare(sql);
  }, batch: statements => f.db.batch(statements) } };
  assert.equal((await f.loadWorker().remove({}, env, "query")).ok, true);
  assert.equal(await f.count("image_cleanup_jobs"), 1); assert.equal(f.files.size, 1);
  await f.loadWorker().drain(f.env); assert.equal(await f.count("image_cleanup_jobs"), 0);
});

test("scoped immediate cleanup and bounded background batches", async t => {
  const f = await fixture(t), worker = f.loadWorker();
  for (let i = 0; i < 23; i++) await f.job(`batch-${i}`);
  await worker.drain(f.env, "batch-0"); assert.equal(await f.count("image_cleanup_jobs"), 22);
  await worker.drain(f.env); assert.equal(await f.count("image_cleanup_jobs"), 2);
  await worker.drain(f.env); assert.equal(await f.count("image_cleanup_jobs"), 0); assert.equal(f.files.size, 0);
});

test("duplicate cleanup jobs and concurrent drains are idempotent", async t => {
  const f = await fixture(t); await f.thread("duplicate", 1);
  await f.client.execute({ sql: "INSERT INTO image_cleanup_jobs(image_key,thread_id,next_attempt_at,created_at) VALUES('img/duplicate-0','duplicate',?,?)", args: [f.now(), f.now()] });
  await f.loadWorker().remove({}, f.env, "duplicate"); assert.equal(await f.count("image_cleanup_jobs"), 0);
  await f.job("concurrent"); const worker = f.loadWorker();
  await Promise.all([worker.drain(f.env), worker.drain(f.env)]);
  assert.equal(await f.count("image_cleanup_jobs"), 0); assert.equal(f.files.size, 0);
});
