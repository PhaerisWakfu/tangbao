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
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const list = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "listMessages");
const adapter = ast.statements.filter(n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) &&
  ["d1Meta", "TursoStatement", "TursoDatabase"].includes(n.name?.text)).map(n => n.getText(ast)).join("\n");

test("long conversation images use one bound thread ID and preserve image order/isolation", async t => {
  const directory = await mkdtemp(path.join(root, ".tmp/messages-test-"));
  const client = createClient({ url: `file:${path.join(directory, "synthetic.db")}` });
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  for (const file of (await readdir(path.join(root, "migrations"))).filter(n => n.endsWith(".sql")).sort()) {
    await client.executeMultiple(await readFile(path.join(root, "migrations", file), "utf8"));
  }
  const scope = { Date, Map, imageSignature: async () => "synthetic-signature" };
  const code = ts.transpileModule(adapter + "\n" + list.getText(ast) + "\nglobalThis.Database=TursoDatabase;globalThis.list=listMessages;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Script(code).runInNewContext(scope);
  const statements = ["a", "b"].map(id => ({ sql: "INSERT INTO threads(id,token_hash,title,created_at,updated_at) VALUES(?,'synthetic','synthetic',1,1)", args: [id] }));
  for (let i = 0; i < 144; i++) statements.push({ sql: "INSERT INTO messages(id,thread_id,role,body,created_at) VALUES(?,'a','visitor',?,?)", args: [`a-${i}`, `message-${i}`, i] });
  statements.push({ sql: "INSERT INTO messages(id,thread_id,role,body,created_at) VALUES('b-0','b','visitor','other',1)", args: [] });
  for (const [id, message, position] of [["a-second", "a-0", 1], ["a-first", "a-0", 0], ["a-last", "a-143", 0], ["b-only", "b-0", 0]]) statements.push({ sql: "INSERT INTO message_images(id,message_id,image_key,image_type,position) VALUES(?,?,?,'image/png',?)", args: [id, message, `img/${id}`, position] });
  await client.batch(statements, "write");
  const database = new scope.Database(client), bindingCounts = [];
  const env = { DB: { prepare(sql) { return { bind(...args) {
    // Cloudflare D1 allows at most 100 bindings for an individual query.
    bindingCounts.push(args.length); assert(args.length <= 100);
    return database.prepare(sql).bind(...args);
  } }; } } };
  const messages = await scope.list(env, "a");
  assert.equal(messages.length, 144); assert.deepEqual(Array.from(messages[0].images, image => image.id), ["a-first", "a-second"]);
  assert.equal(messages.at(-1).images[0].id, "a-last"); assert(!messages.some(m => m.images.some(i => i.id === "b-only")));
  assert.equal(Math.max(...bindingCounts), 1); assert.equal(bindingCounts.length, 3);
});
