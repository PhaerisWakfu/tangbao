import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createClient } from "@libsql/client";

const root = path.resolve(import.meta.dirname, "..");
await mkdir(path.join(root, ".tmp"), { recursive: true, mode: 0o700 });
const migrations = (await readdir(path.join(root, "migrations"))).filter(name => name.endsWith(".sql")).sort();
async function fixture(t) {
  const directory = await mkdtemp(path.join(root, ".tmp/migration-test-"));
  const client = createClient({ url: `file:${path.join(directory, "synthetic.db")}` });
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  return client;
}
async function apply(client, names) {
  for (const name of names) await client.executeMultiple(await readFile(path.join(root, "migrations", name), "utf8"));
}
test("all current migrations apply from an empty local libSQL database", async t => {
  const client = await fixture(t); await apply(client, migrations);
  for (const table of ["accounts", "messages", "message_images", "image_cleanup_jobs"]) {
    assert.equal(Number((await client.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n), 0);
  }
});
test("0019 preserves model attribution, nearest time, tie order and orphan removal", async t => {
  const client = await fixture(t); await apply(client, migrations.filter(name => name < "0019"));
  const threads = [
    ["home", "home-id", null, null, 100, "tangbao-vme50-flash"],
    ["visitor", "visitor-token", "visitor-id", null, 100, "model-visitor"],
    ["ip", "ip-token", null, "ip-id", 100, "model-ip"],
    ["near-older", "nearest-id", null, null, 80, "model-older"],
    ["near-newer", "nearest-id", null, null, 119, "model-nearest"],
    ["tie-older", "tie-id", null, null, 90, "model-tie-older"],
    ["tie-newer", "tie-id", null, null, 110, "model-tie-newer"],
  ];
  await client.batch(threads.map(([id, token, visitor, ip, updated, operator]) => ({
    sql: "INSERT INTO threads(id,token_hash,title,visitor_hash,ip_hash,created_at,updated_at,operator_id) VALUES(?,?,'synthetic',?,?,1,?,?)",
    args: [id, token, visitor, ip, updated, operator],
  })), "write");
  await client.batch(["home-id", "visitor-id", "ip-id", "nearest-id", "tie-id", "orphan-id"].map(id => ({ sql: "INSERT INTO blocks(id,created_at) VALUES(?,100)", args: [id] })), "write");
  await apply(client, migrations.filter(name => name >= "0019"));
  const rows = (await client.execute("SELECT id,operator_id,created_at FROM blocks ORDER BY id")).rows.map(row => [row.id, row.operator_id, Number(row.created_at)]);
  assert.deepEqual(rows, [["home-id", "*", 100], ["ip-id", "model-ip", 100], ["nearest-id", "model-nearest", 100], ["tie-id", "model-tie-newer", 100], ["visitor-id", "model-visitor", 100]]);
});
