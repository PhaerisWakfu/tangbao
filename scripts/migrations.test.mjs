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
test("0027 clears all legacy copies while preserving verification, model state and other data", async t => {
  const client = await fixture(t); await apply(client, migrations.filter(name => name < "0027"));
  await client.execute("INSERT INTO accounts(id,email,password_hash,verified_at,created_at,updated_at) VALUES('synthetic-owner','owner@example.test','synthetic-unused',1,1,1)");
  for (const [id, active, owner, claimed] of [["active",1,null,0],["disabled",0,null,0],["owned",1,"synthetic-owner",1]]) {
    await client.execute({sql:"INSERT INTO operators(id,password_hash,active,created_at,owner_account_id,legacy_claimed_at) VALUES(?,?,?,?,?,?)",args:[id,`synthetic-digest-${id}`,active,1,owner,claimed]});
  }
  for (const [id, status, note] of [["approved","approved","synthetic-copy"],["pending","pending","synthetic-copy"],["rejected","rejected","synthetic-copy"],["empty","rejected",""],["null","rejected",null]]) {
    await client.execute({sql:"INSERT INTO applications(id,suffix,email,status,created_at,pass_note) VALUES(?,?,'legacy@example.test',?,1,?)",args:[id,id,status,note]});
  }
  await client.executeMultiple("INSERT INTO threads(id,token_hash,title,created_at,updated_at) VALUES('synthetic-thread','synthetic','keep',1,1); INSERT INTO messages(id,thread_id,role,body,created_at) VALUES('synthetic-message','synthetic-thread','visitor','keep',1)");
  const snapshot = async () => ({
    operators:(await client.execute("SELECT * FROM operators ORDER BY id")).rows,
    applications:(await client.execute("SELECT * FROM applications ORDER BY id")).rows.map(({pass_note,...row})=>row),
    accounts:(await client.execute("SELECT * FROM accounts ORDER BY id")).rows,
    messages:(await client.execute("SELECT * FROM messages ORDER BY id")).rows,
    version:(await client.execute("SELECT value FROM settings WHERE key='app_schema_version'")).rows,
  });
  const before = await snapshot(); await apply(client, migrations.filter(name => name.startsWith("0027")));
  assert.equal((await client.execute("SELECT count(*) AS n FROM applications WHERE pass_note IS NOT NULL")).rows[0].n,0);
  assert.deepEqual(await snapshot(),before);
  await apply(client, migrations.filter(name => name.startsWith("0027"))); assert.deepEqual(await snapshot(),before);
});
