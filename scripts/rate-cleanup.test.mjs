import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import ts from "typescript";

const root=path.resolve(import.meta.dirname,"..");
const source=await readFile(path.join(root,"src/index.ts"),"utf8");
const ast=ts.createSourceFile("index.ts",source,ts.ScriptTarget.Latest,true);
const adapter=ast.statements.filter(n=>(ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n))&&["d1Meta","TursoStatement","TursoDatabase"].includes(n.name?.text)).map(n=>n.getText(ast)).join("\n");
const cleanup=await readFile(path.join(root,"src/rate-cleanup.ts"),"utf8");
async function fixture(t){
  await mkdir(path.join(root,".tmp"),{recursive:true});const directory=await mkdtemp(path.join(root,".tmp/rate-cleanup-"));
  const client=createClient({url:`file:${directory}/synthetic.db`});t.after(async()=>{client.close();await rm(directory,{recursive:true,force:true});});
  for(const file of (await readdir(path.join(root,"migrations"))).filter(n=>n.endsWith(".sql")).sort())await client.executeMultiple(await readFile(path.join(root,"migrations",file),"utf8"));
  const scope={exports:{}};new Script(ts.transpileModule(adapter+"\n"+cleanup+"\nglobalThis.Database=TursoDatabase;",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText).runInNewContext(scope);
  return {client,run:now=>scope.exports.processRateCleanup({DB:new scope.Database(client)},now)};
}
test("expired rate cleanup is bounded and preserves renewed windows and application data",async t=>{
  const {client,run}=await fixture(t);
  for(const table of ["rate_buckets","auth_rate_buckets"]){
    await client.batch(Array.from({length:505},(_,i)=>({sql:`INSERT INTO ${table}(id,hits,reset_at) VALUES(?,1,?)`,args:[`expired-${i}`,100]})),"write");
    await client.execute(`INSERT INTO ${table}(id,hits,reset_at) VALUES('renewed',3,101),('live',2,999)`);
    const plan=(await client.execute(`EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE reset_at<=100 ORDER BY reset_at LIMIT 500`)).rows;
    assert(plan.some(row=>String(row.detail).includes(`idx_${table}_expiry`)));
  }
  await client.execute("INSERT INTO settings(key,value) VALUES('synthetic-keep','unchanged')");
  await run(100);
  for(const table of ["rate_buckets","auth_rate_buckets"]){
    assert.equal((await client.execute(`SELECT count(*) AS n FROM ${table} WHERE reset_at<=100`)).rows[0].n,5);
    assert.equal((await client.execute(`SELECT hits FROM ${table} WHERE id='renewed'`)).rows[0].hits,3);
  }
  await run(100);
  for(const table of ["rate_buckets","auth_rate_buckets"])assert.equal((await client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n,2);
  assert.equal((await client.execute("SELECT value FROM settings WHERE key='synthetic-keep'")).rows[0].value,"unchanged");
});
