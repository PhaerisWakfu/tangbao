import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import ts from "typescript";
const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".tmp"), { recursive: true });
const source = await readFile(path.join(root, "src/index.ts"), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const list = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "listMessages");
const adapter = ast.statements.filter(n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && ["d1Meta", "TursoStatement", "TursoDatabase"].includes(n.name?.text)).map(n => n.getText(ast)).join("\n");
async function fixture(t) {
  const directory = await mkdtemp(path.join(root, ".tmp/messages-test-"));
  const client = createClient({ url: `file:${path.join(directory, "synthetic.db")}` });
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  for (const file of (await readdir(path.join(root, "migrations"))).filter(n => n.endsWith(".sql")).sort()) await client.executeMultiple(await readFile(path.join(root, "migrations", file), "utf8"));
  const scope = { Date, Map, URLSearchParams, HttpError: class extends Error { constructor(status, text) { super(text); this.status = status; } }, imageSignature: async () => "synthetic-signature" };
  const code = ts.transpileModule(adapter + "\n" + list.getText(ast) + "\nglobalThis.Database=TursoDatabase;globalThis.list=listMessages;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Script(code).runInNewContext(scope);
  await client.batch(["a", "b"].map(id => ({ sql: "INSERT INTO threads(id,token_hash,title,created_at,updated_at) VALUES(?,'synthetic','synthetic',1,1)", args: [id] })), "write");
  const bindings = [], sqls = [], database = new scope.Database(client);
  const env = { DB: { prepare(sql) { sqls.push(sql); return { bind(...args) { bindings.push(args.length); assert(args.length <= 50); return database.prepare(sql).bind(...args); } }; } } };
  return { client, bindings, sqls,
    list: (thread = "a", query = "") => scope.list(env, thread, new URLSearchParams(`order=written${query ? `&${query}` : ""}`)),
    legacyList: (query = "") => scope.list(env, "a", new URLSearchParams(query)),
  };
}
async function insert(f, count = 144) {
  await f.client.batch(Array.from({ length: count }, (_, i) => ({ sql: "INSERT INTO messages(id,thread_id,role,body,created_at) VALUES(?,'a','visitor',?,100)", args: [`a-${i}`, `message-${i}`] })), "write");
  await f.client.execute("INSERT INTO messages(id,thread_id,role,body,created_at) VALUES('b-0','b','visitor','private-other',100)");
}
test("main's existing clients retain hasMore and timestamp/id cursors without reloading", async t => {
  const f = await fixture(t); await insert(f);
  let query = "", all = [], requests = 0;
  do {
    const page = await f.legacyList(query); requests++;
    assert.equal(typeof page.hasMore, "boolean");
    assert(page.messages.length <= 50);
    all = [...page.messages, ...all];
    if (!page.hasMore) break;
    assert(requests < 5, "legacy cursor must make progress even when every timestamp is equal");
    query = `before=${page.messages[0].id}`;
  } while (true);
  assert.equal(all.length,144); assert.equal(new Set(all.map(row => row.id)).size,144);
  assert.deepEqual(all.map(row => row.id), Array.from({length:144}, (_,i)=>`a-${i}`).sort());
});
test("first/older message pages stay bounded and preserve every same-timestamp message and image", async t => {
  const f = await fixture(t); await insert(f);
  for (const [id, msg, pos] of [["second", "a-0", 1], ["first", "a-0", 0], ["last", "a-143", 0], ["other", "b-0", 0]]) await f.client.execute({ sql: "INSERT INTO message_images(id,message_id,image_key,image_type,position) VALUES(?,?,?,'image/png',?)", args: [id, msg, `img/${id}`, pos] });
  const latest = await f.list(); assert.equal(latest.messages.length, 50); assert.equal(latest.messages[0].id, "a-94"); assert(latest.messagePage.hasOlder); assert.equal(latest.messages.at(-1).images[0].id, "last");
  const middle = await f.list("a", "before=" + latest.messagePage.oldest); assert.equal(middle.messages.length, 50);
  const oldest = await f.list("a", "before=" + middle.messagePage.oldest); assert.equal(oldest.messages.length, 44); assert.equal(oldest.messagePage.hasOlder, false);
  const all = [...oldest.messages, ...middle.messages, ...latest.messages]; assert.equal(new Set(all.map(m => m.id)).size, 144);
  assert.deepEqual(Array.from(all[0].images, i => i.id), ["first", "second"]); assert(!all.some(m => m.images.some(i => i.id === "other")));
  assert(Math.max(...f.bindings) <= 50);
  const plan = (await f.client.execute("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE thread_id='a' AND rowid<100 ORDER BY rowid DESC LIMIT 51")).rows.map(r => r.detail).join(" ");
  assert.match(plan, /idx_messages_thread_order/); assert(!/TEMP B-TREE/.test(plan));
});
test("incremental backlog advances only through delivered rows and survives clock skew/rowid reuse in other threads", async t => {
  const f = await fixture(t); await insert(f, 50); const first = await f.list();
  // Another thread can be deleted without invalidating the retained anchor.
  await f.client.execute("DELETE FROM messages WHERE thread_id='b'");
  await f.client.batch(Array.from({ length: 75 }, (_, i) => ({ sql: "INSERT INTO messages(id,thread_id,role,body,created_at) VALUES(?,'a','tangbao','new',1)", args: [`new-${i}`] })), "write");
  const next = await f.list("a", "after=" + first.messagePage.newest); assert.equal(next.messages.length, 50); assert(next.messagePage.hasNewer);
  const rest = await f.list("a", "after=" + next.messagePage.newest); assert.equal(rest.messages.length, 25); assert.equal(rest.messagePage.hasNewer, false);
  const none = await f.list("a", "after=" + rest.messagePage.newest); assert.equal(none.messages.length, 0); assert.equal(none.messagePage.newest, "new-74");
  assert.equal(new Set([...first.messages, ...next.messages, ...rest.messages].map(m => m.id)).size, 125);
});
test("cross-thread, missing and malformed message cursors are rejected", async t => {
  const f = await fixture(t); await insert(f, 1);
  for (const query of ["after=b-0", "before=missing", "after=", "before=a-0&after=a-0", "after=%3Bbad"]) await assert.rejects(f.list("a", query), error => error.status === 400);
});
