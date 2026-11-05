import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { migrate } from "./migrate-turso.mjs";
import { localBrowserTarget } from "./local-browser-target.mjs";

async function fixture(t) {
  await mkdir(new URL("../.tmp/", import.meta.url), { recursive: true });
  const dir = await mkdtemp(new URL("../.tmp/turso-cli-", import.meta.url));
  const client = createClient({ url: `file:${dir}/test.db` });
  t.after(async () => { client.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, client };
}
test("Turso entry applies all migrations and reruns without duplicating", async t => {
  const { client } = await fixture(t);
  assert.equal((await migrate(client, new URL("../migrations/", import.meta.url))).length, 28);
  assert.deepEqual(await migrate(client, new URL("../migrations/", import.meta.url)), []);
  assert.equal((await client.execute("SELECT value FROM settings WHERE key='app_schema_version'")).rows[0].value, "26");
});
test("Turso refuses untracked populated schema", async t => {
  const { client } = await fixture(t); await client.execute("CREATE TABLE keep_me(id INT)");
  await assert.rejects(migrate(client, new URL("../migrations/", import.meta.url)), /缺少/);
  assert.equal((await client.execute("SELECT count(*) n FROM sqlite_master WHERE name='_tangbao_migrations'")).rows[0].n, 0);
});
for (const missing of ["0023_thread_pins.sql", "0023_image_cleanup_jobs.sql", "0027_clear_legacy_credentials.sql"]) {
  test(`Turso merges branch migration history without replaying applied files: ${missing}`, async t => {
    const { client, dir } = await fixture(t);
    const baseline = path.join(dir, "baseline"); await mkdir(baseline);
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(directory)).filter(n => n.endsWith(".sql") && n !== missing)) {
      await writeFile(path.join(baseline, file), await readFile(new URL(file, directory)));
    }
    await migrate(client, baseline);
    await client.execute("INSERT INTO settings(key,value) VALUES('synthetic-keep','unchanged')");
    if (missing.startsWith("0027")) await client.execute("INSERT INTO applications(id,suffix,email,status,created_at,pass_note) VALUES('synthetic-app','synthetic','synthetic@example.test','pending',1,'synthetic-copy')");
    assert.deepEqual(await migrate(client, directory), [missing]);
    assert.equal((await client.execute("SELECT value FROM settings WHERE key='synthetic-keep'")).rows[0].value, "unchanged");
    assert.equal((await client.execute("SELECT count(*) n FROM _tangbao_migrations")).rows[0].n, 28);
    if (missing.startsWith("0027")) assert.equal((await client.execute("SELECT pass_note FROM applications WHERE id='synthetic-app'")).rows[0].pass_note, null);
    assert.deepEqual(await migrate(client, directory), []);
  });
}
test("Turso rolls back the whole failed batch and rejects changed history", async t => {
  const { client, dir } = await fixture(t); const sql = path.join(dir, "sql"); await mkdir(sql);
  await writeFile(path.join(sql, "0001_test.sql"), "CREATE TABLE sample(id INT);");
  await writeFile(path.join(sql, "0002_fail.sql"), "INSERT INTO missing VALUES(1);");
  await assert.rejects(migrate(client, sql));
  assert.equal((await client.execute("SELECT count(*) n FROM sqlite_master WHERE name='sample'")).rows[0].n, 0);
  await rm(path.join(sql, "0002_fail.sql")); await migrate(client, sql);
  await writeFile(path.join(sql, "0001_test.sql"), "CREATE TABLE changed(id INT);");
  await assert.rejects(migrate(client, sql), /不一致/);
});
test("browser entry rejects URL, traversal and old implicit default before accessing services", async () => {
  for (const args of [[], ["--base", "https://example.com"], ["--instance", "../demo"], ["--instance", "demo", "--url", "http://localhost:8787"]]) {
    await assert.rejects(localBrowserTarget(args), /只接受/);
  }
});
