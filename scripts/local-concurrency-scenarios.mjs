import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

// Runs only inside the nonce-checked local sandbox. No production URL or SQL
// HTTP endpoint is introduced; fixture SQL uses the instance's own D1 config.
export async function runConcurrencyScenarios({ actor, admin, operatorA, operatorB, check, checkServer, directory, metadata }) {
  const root = path.resolve(import.meta.dirname, "..");
  let operation = 0;
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  async function db(statement) {
    await checkServer();
    const env = { CI:"1", WRANGLER_SEND_METRICS:"false", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:"false", CLOUDFLARE_INCLUDE_PROCESS_ENV:"false" };
    for (const key of ["PATH","HOME","USERPROFILE","SYSTEMROOT","SystemRoot","COMSPEC","ComSpec","PATHEXT","LANG","LC_ALL","TMPDIR","TEMP","TMP"]) if (process.env[key]) env[key] = process.env[key];
    const result = spawnSync(process.execPath, [path.join(root,"node_modules/wrangler/bin/wrangler.js"),"d1","execute","DB","--local","--config",path.join(directory,"wrangler.json"),"--persist-to",path.join(directory,"state"),"--command",statement,"--json"], { cwd:directory, env, encoding:"utf8", timeout:60000 });
    await writeFile(path.join(directory,`concurrency-fixture-${++operation}.log`),`${result.stdout||""}\n${result.stderr||""}`,{mode:0o600,flag:"wx"});
    assert.equal(result.status,0,result.error?.message||result.stderr||"Local fixture failed");
    return JSON.parse(result.stdout).flatMap(entry=>entry.results||[]);
  }
  await check("后台状态更新拒绝错误来源，同源浏览器读取可继续", async () => {
    const model=quote(operatorA.state.operatorId);
    const [before]=await db(`SELECT last_seen_at FROM operators WHERE id=${model}`);
    await operatorA.request("/api/admin/queue",{origin:"https://example.test",status:403});
    const [after]=await db(`SELECT last_seen_at FROM operators WHERE id=${model}`);
    assert.equal(after.last_seen_at,before.last_seen_at);
    await operatorA.request("/api/admin/queue",{origin:"null",headers:{referer:`http://127.0.0.1:${metadata.port}/desk`}});
  });
  await check("保留型号被拒绝；同账号并发申请最多一个待审批记录", async () => {
    const user = actor("application-race"); await user.register();
    for (const suffix of ["pool", "vme50-flash"]) await user.request("/api/applications", { method:"POST", body:{suffix,blurb:"合成并发核验"}, status:400 });
    const responses = await Promise.all(["race-a","race-b"].map(suffix=>user.request("/api/applications",{method:"POST",body:{suffix,blurb:"合成并发核验"},status:[200,409]})));
    const ids = new Set(responses.filter(row=>row.id).map(row=>row.id)); assert.equal(ids.size,1);
    const [row] = await db(`SELECT count(*) AS n FROM applications WHERE account_id=${quote(user.state.accountId)} AND status IN ('pending','approved')`);
    assert.equal(row.n,1);
    const id = [...ids][0];
    const results = await Promise.all([
      admin.request(`/api/admin/applications/${id}/approve`, {method:"POST",status:[200,409]}),
      admin.request(`/api/admin/applications/${id}/reject`, {method:"POST",body:{reason:"合成并发核验"},status:[200,400,409]}),
    ]);
    assert.equal(results.filter(result=>result.ok).length,1);
    const status = await user.request("/api/applications/mine");
    const [state] = await db(`SELECT (SELECT count(*) FROM operators WHERE owner_account_id=${quote(user.state.accountId)}) AS models,(SELECT count(*) FROM account_roles WHERE account_id=${quote(user.state.accountId)} AND role='operator') AS roles`);
    assert.equal(state.models,status.status==="approved"?1:0); assert.equal(state.roles,state.models);
    await admin.request(`/api/admin/applications/${id}/approve`, {method:"POST",status:409});
    await admin.request(`/api/admin/applications/${id}/reject`, {method:"POST",body:{reason:"重复处理"},status:400});
    if(status.modelId) await admin.request(`/api/admin/operators/${status.modelId}/disable`,{method:"POST"});
  });
  await check("同申请并发审批仅一次成功；不同账号同型号仅一份有效申请", async () => {
    const users = [actor("suffix-race-a"), actor("suffix-race-b")];
    for(const user of users)await user.register();
    const responses=await Promise.all(users.map(user=>user.request("/api/applications",{method:"POST",body:{suffix:"same-race",blurb:"合成唯一性核验"},status:[200,409]})));
    const accepted=responses.filter(row=>row.id); assert.equal(accepted.length,1);
    const results=await Promise.all([0,1].map(()=>admin.request(`/api/admin/applications/${accepted[0].id}/approve`,{method:"POST",status:[200,409]})));
    assert.equal(results.filter(result=>result.ok).length,1);
    await admin.request(`/api/admin/operators/tangbao-same-race/disable`,{method:"POST"});
  });
  await check("容量临界并发领池不超额且每段只归一个模型", async () => {
    const models=[operatorA.state.operatorId,operatorB.state.operatorId];
    const prefix=`synthetic-pool-${randomBytes(6).toString("hex")}`;
    // Preserve prior messages; settle their awaiting flags only in this fresh
    // full-regression instance before creating a bounded synthetic queue.
    await db("UPDATE threads SET awaiting=0; UPDATE operators SET last_seen_at=0;");
    const now=Date.now();
    const statements=[];
    for(const [i,model] of models.entries())statements.push(`INSERT INTO threads(id,token_hash,title,created_at,updated_at,operator_id,auto_home,queued,awaiting) VALUES(${quote(`${prefix}-owned-${i}`)},'synthetic','合成容量边界',${now},${now},${quote(model)},0,0,1)`);
    for(let i=0;i<8;i++)statements.push(`INSERT INTO threads(id,token_hash,title,created_at,updated_at,operator_id,auto_home,queued,awaiting) VALUES(${quote(`${prefix}-${i}`)},'synthetic','合成待分配',${now+i},${now+i},'tangbao-pool',1,1,1)`);
    await db(statements.join(";"));
    await Promise.all([operatorA,operatorA,operatorB,operatorB].map(operator=>operator.request("/api/admin/queue")));
    const rows=await db(`SELECT operator_id AS model,queued,count(*) AS n FROM threads WHERE id LIKE ${quote(prefix+'%')} GROUP BY operator_id,queued`);
    for(const model of models)assert.equal(rows.find(row=>row.model===model&&row.queued===0)?.n,2);
    assert.equal(rows.find(row=>row.model==='tangbao-pool')?.n,6);
    assert.equal(rows.reduce((total,row)=>total+row.n,0),10);
    await db(`DELETE FROM threads WHERE id LIKE ${quote(prefix+'%')}`);
  });
  await check("main队列准入按模型20条，其他模型与已有对话不被全局积压阻断", async () => {
    const user=actor("queue-admission-review"); await user.register();
    const a=operatorA.state.operatorId,b=operatorB.state.operatorId,now=Date.now();
    const prefix=`synthetic-admission-${randomBytes(6).toString("hex")}`;
    await db(`UPDATE threads SET awaiting=0; UPDATE operators SET last_seen_at=${now}, away_at=0;`);
    await db(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<400)
      INSERT INTO threads(id,token_hash,title,created_at,updated_at,operator_id,queued,auto_home,awaiting)
      SELECT ${quote(prefix)}||'-'||n,'synthetic','合成准入边界',${now},${now},
        CASE WHEN n<=20 THEN ${quote(a)} ELSE 'tangbao-pool' END,
        CASE WHEN n<=20 THEN 0 ELSE 1 END,CASE WHEN n<=20 THEN 0 ELSE 1 END,1 FROM seq`);
    const existing=`${prefix}-existing`;
    await db(`INSERT INTO threads(id,token_hash,title,created_at,updated_at,operator_id,awaiting,account_id)
      VALUES(${quote(existing)},'synthetic','已有对话续聊',${now},${now},${quote(a)},0,${quote(user.state.accountId)})`);
    await user.request("/api/threads",{method:"POST",body:{body:"满模型拒绝新建",operator:a},status:429});
    const other=await user.request("/api/threads",{method:"POST",body:{body:"其他模型仍可新建",operator:b}});assert.equal(other.operator,b);
    await user.request(`/api/threads/${existing}/messages`,{method:"POST",body:{body:"满队列仍可继续原对话"}});
    assert.equal((await user.request(`/api/threads/${existing}`)).messages.at(-1).body,"满队列仍可继续原对话");
    for(const [operator,queued] of [["tangbao-vme50-flash",false],["",true]]){
      const created=await user.request("/api/threads",{method:"POST",body:{body:"主模型与消息池不受普通模型准入上限限制",operator}});
      assert.equal(created.queued,queued);assert.equal(created.operator,queued?"tangbao-pool":operator);
    }
    await db(`UPDATE threads SET awaiting=0 WHERE id IN (${quote(prefix+'-1')},${quote(prefix+'-2')})`);
    const admitted=await user.request("/api/threads",{method:"POST",body:{body:"19条时仍允许新建",operator:a}});assert.equal(admitted.operator,a);
    await db(`DELETE FROM threads WHERE id LIKE ${quote(prefix+'%')}`);
  });
}
