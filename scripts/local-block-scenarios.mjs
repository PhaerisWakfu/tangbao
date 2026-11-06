import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const hash = value => createHash("sha256").update(value).digest("hex");
const sql = value => `'${String(value).replaceAll("'", "''")}'`;

// These fixtures exercise old block rows that cannot be created by the current
// UI. Wrangler is fixed to the verified local instance; no SQL HTTP API is added.
export async function runBlockMergeScenarios({ actor, admin, operatorA, operatorB, check, checkServer, directory }) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let operation = 0;
  async function db(statement) {
    await checkServer();
    const env = { CI:"1", WRANGLER_SEND_METRICS:"false", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:"false", CLOUDFLARE_INCLUDE_PROCESS_ENV:"false" };
    for (const key of ["PATH","HOME","USERPROFILE","SYSTEMROOT","SystemRoot","COMSPEC","ComSpec","PATHEXT","LANG","LC_ALL","TMPDIR","TEMP","TMP"]) if (process.env[key]) env[key]=process.env[key];
    const result = spawnSync(process.execPath, [path.join(root,"node_modules/wrangler/bin/wrangler.js"),"d1","execute","DB","--local","--config",path.join(directory,"wrangler.json"),"--persist-to",path.join(directory,"state"),"--command",statement,"--json"], { cwd:directory, env, encoding:"utf8", timeout:60000 });
    await writeFile(path.join(directory,`block-fixture-${++operation}.log`),`${result.stdout||""}\n${result.stderr||""}`,{mode:0o600,flag:"wx"});
    assert.equal(result.status,0,result.error?.message||result.stderr||"本地封禁 fixture 失败");
    return JSON.parse(result.stdout).flatMap(entry=>entry.results||[]);
  }
  async function settle(operator) {
    const queue = await operator.request("/api/admin/queue");
    for (const thread of queue.waiting) await operator.request(`/api/admin/threads/${thread.id}`,{method:"POST",body:{body:"共享消费者回归：清空待回"}});
  }
  async function guest(name, ip) {
    const client=actor(name,{ip}); await client.request("/chat"); return client;
  }
  async function create(client, body, operator) {
    if (operator === operatorA.state.operatorId) await operatorA.request("/api/admin/queue");
    if (operator === operatorB.state.operatorId) await operatorB.request("/api/admin/queue");
    return client.request("/api/threads",{method:"POST",body:{body,...(operator?{operator}: {})}});
  }
  const read = (client, thread) => client.request(`/api/threads/${thread.id}`,{token:thread.token});
  const block = (operator, thread) => operator.request(`/api/admin/threads/${thread.id}/block`,{method:"POST"});
  const unblock = (operator, thread) => operator.request(`/api/admin/threads/${thread.id}/unblock`,{method:"POST"});
  const reply = (operator, thread) => operator.request(`/api/admin/threads/${thread.id}`,{method:"POST",body:{body:"共享消费者回归：正常回复"}});
  const a=operatorA.state.operatorId, b=operatorB.state.operatorId;
  await settle(operatorA); await settle(operatorB);

  await check("合并main：匿名模型拉黑只写token/visitor，不误关共享IP或阻止新访客",async()=>{
    const ip="198.51.100.180";
    const target=await guest("merge-anon-target",ip), peer=await guest("merge-anon-peer",ip);
    const left=await create(target,"匿名模型封禁目标",a),right=await create(peer,"共享IP仍待回复",a);
    await block(operatorA,left);
    const rows=await db(`SELECT id FROM blocks WHERE operator_id=${sql(a)}`);
    assert(rows.some(row=>row.id===hash(left.token)));
    assert(rows.some(row=>row.id===hash(target.state.visitor)));
    assert(!rows.some(row=>row.id===hash(ip)),"普通模型不得写IP封禁");
    assert.equal((await read(target,left)).blocked,true);
    const visible=await read(peer,right);assert.equal(visible.blocked,false);assert.equal(visible.awaiting,true);
    const queue=await operatorA.request("/api/admin/queue");assert(queue.waiting.some(t=>t.id===right.id));assert(!queue.blocked.some(t=>t.id===right.id));
    const next=await guest("merge-anon-after-block",ip),nextThread=await create(next,"拉黑后同IP新访客仍可创建",a);
    assert.equal(nextThread.operator,a);
    await reply(operatorA,right);await reply(operatorA,nextThread);await unblock(operatorA,left);
    assert.equal((await read(target,left)).blocked,false);
  });

  const legacyIp="198.51.100.181",legacyHash=hash(legacyIp);
  const legacyMember=actor("merge-legacy-ip-member",{ip:legacyIp});
  await legacyMember.register();
  await check("合并main：旧模型IP-only不影响创建/读取/队列/待回及匿名历史关联",async()=>{
    await db(`INSERT INTO blocks(id,operator_id,created_at) VALUES(${sql(legacyHash)},${sql(a)},${Date.now()})`);
    const anonymous=await guest("merge-legacy-ip-anonymous",legacyIp);
    const anonymousThread=await create(anonymous,"旧IP-only匿名历史",a);
    const accountThread=await create(legacyMember,"旧IP-only账号历史",a);
    for(const [client,thread] of [[anonymous,anonymousThread],[legacyMember,accountThread]]) {
      const data=await read(client,thread);assert.equal(data.blocked,false);assert.equal(data.awaiting,true);
      assert.equal((await operatorA.request(`/api/admin/threads/${thread.id}`)).thread.blocked,false);
    }
    const queue=await operatorA.request("/api/admin/queue");
    for(const thread of [anonymousThread,accountThread]){assert(queue.waiting.some(t=>t.id===thread.id));assert(!queue.blocked.some(t=>t.id===thread.id));}
    const models=await legacyMember.request(`/api/models?q=${encodeURIComponent(a)}&page=1`);
    const model=models.models.find(item=>item.id===a);assert(model);assert.equal(model.pending,2);assert.equal(model.status,"busy");
    await legacyMember.request("/api/account/threads/claim",{method:"POST",body:{threadId:anonymousThread.id,token:anonymousThread.token}});
    assert.equal((await legacyMember.request(`/api/threads/${anonymousThread.id}`)).blocked,false);
    const accountBlocks=await db(`SELECT id FROM blocks WHERE id=${sql(`account:${legacyMember.state.accountId}`)}`);
    assert.equal(accountBlocks.length,0,"模型IP-only不能在历史关联时升级为账号封禁");
    await anonymous.request(`/api/threads/${anonymousThread.id}`,{token:anonymousThread.token,status:401});
    await reply(operatorA,anonymousThread);await reply(operatorA,accountThread);
  });

  await check("合并main：旧模型IP-only不影响Auto选择和POOL回收",async()=>{
    await admin.request(`/api/admin/operators/${b}/disable`,{method:"POST"});
    await operatorA.request("/api/admin/queue");
    const automatic=await create(legacyMember,"旧IP-only仍可Auto分配");assert.equal(automatic.operator,a);assert.equal(automatic.queued,false);await reply(operatorA,automatic);
    await admin.request(`/api/admin/operators/${a}/disable`,{method:"POST"});
    const pooledAccount=await create(legacyMember,"旧IP-only账号入池");
    const anonymous=await guest("merge-legacy-ip-pool",legacyIp),pooledAnonymous=await create(anonymous,"旧IP-only匿名入池");
    assert.equal(pooledAccount.queued,true);assert.equal(pooledAnonymous.queued,true);
    await admin.request(`/api/admin/operators/${a}/enable`,{method:"POST"});
    const queue=await operatorA.request("/api/admin/queue");
    for(const [client,thread] of [[legacyMember,pooledAccount],[anonymous,pooledAnonymous]]) {
      assert(queue.waiting.some(t=>t.id===thread.id));assert(!queue.blocked.some(t=>t.id===thread.id));
      const data=await read(client,thread);assert.equal(data.operator,a);assert.equal(data.queued,false);assert.equal(data.blocked,false);await reply(operatorA,thread);
    }
    await admin.request(`/api/admin/operators/${b}/enable`,{method:"POST"});
    await db(`DELETE FROM blocks WHERE id=${sql(legacyHash)} AND operator_id=${sql(a)}`);
  });

  await check("合并main：全局IP封禁继续影响共享IP并在全部解开后恢复",async()=>{
    const ip="198.51.100.182",left=await guest("merge-global-target",ip),peer=await guest("merge-global-peer",ip);
    const target=await create(left,"全局IP封禁目标",a),other=await create(peer,"全局IP同网访客",b);
    const independent=await guest("merge-global-independent",ip),independentThread=await create(independent,"共享IP但有独立封禁的访客",b);
    const account=actor("merge-global-account",{ip});await account.register();
    const accountThread=await create(account,"全局IP同网账号",a);
    await block(operatorB,independentThread);
    await db(`INSERT INTO blocks(id,operator_id,created_at) VALUES(${sql(hash(independent.state.visitor))},'*',${Date.now()})`);
    await block(admin,target);
    assert((await db(`SELECT id FROM blocks WHERE id=${sql(hash(ip))} AND operator_id='*'`)).length===1);
    assert.equal((await read(peer,other)).blocked,true);
    assert.equal((await read(account,accountThread)).blocked,true);
    await account.request("/api/account/threads/claim",{method:"POST",body:{threadId:other.id,token:other.token}});
    assert.equal((await account.request(`/api/threads/${other.id}`)).blocked,true);
    assert.equal((await operatorB.request(`/api/admin/threads/${other.id}`)).thread.blocked,true);
    const queue=await operatorB.request("/api/admin/queue");assert(!queue.waiting.some(t=>t.id===other.id));assert(queue.blocked.some(t=>t.id===other.id));
    const newcomer=await guest("merge-global-newcomer",ip);
    for(const operator of [undefined,a,b]) await newcomer.request("/api/threads",{method:"POST",body:{body:"全局IP拒绝创建",...(operator?{operator}: {})},status:403});
    await unblock(admin,target);
    assert.equal((await account.request(`/api/threads/${other.id}`)).blocked,false);
    assert.equal((await read(account,accountThread)).blocked,false);
    assert.equal((await read(independent,independentThread)).blocked,true);
    const preserved=await db(`SELECT id,operator_id FROM blocks WHERE (id=${sql(hash(independent.state.visitor))} AND operator_id='*') OR (id=${sql(hash(independentThread.token))} AND operator_id=${sql(b)})`);assert.equal(preserved.length,2,"不能按共享IP聚合删除别人的独立封禁");
    const inherited=await db(`SELECT id FROM blocks WHERE id IN(${sql(`account:${account.state.accountId}`)},${sql(hash(peer.state.visitor))},${sql(hash(other.token))})`);assert.equal(inherited.length,0,"IP-only不能升级为其他visitor/account的永久封禁");
    const resumed=await create(newcomer,"全局解开后恢复创建",a);assert.equal(resumed.operator,a);await reply(operatorA,resumed);
    await unblock(admin,independentThread);
    assert.equal((await read(independent,independentThread)).blocked,false);
  });

  async function oldAnonymousPair() {
    const visitor=randomBytes(18).toString("base64url"),ip="198.51.100.183";
    const client=actor("merge-old-multi-anonymous",{visitor,ip});await client.request("/chat");
    const threads=[a,b].map(operator=>({id:randomBytes(16).toString("base64url"),token:randomBytes(32).toString("base64url"),operator}));
    const statements=threads.flatMap((thread,i)=>[
      `INSERT INTO threads(id,token_hash,title,preview,created_at,updated_at,awaiting,visitor_hash,ip_hash,operator_id,last_role) VALUES(${sql(thread.id)},${sql(hash(thread.token))},'合成旧匿名多段','旧对话',${Date.now()+i},${Date.now()+i},0,${sql(hash(visitor))},${sql(hash(ip))},${sql(thread.operator)},'visitor')`,
      `INSERT INTO messages(id,thread_id,role,body,created_at) VALUES(${sql(randomBytes(16).toString("base64url"))},${sql(thread.id)},'visitor','合成旧匿名多段',${Date.now()+i})`,
    ]);
    await db(statements.join(";\n"));return {client,threads};
  }
  await check("合并main：普通运营者仅解本模型，管理员全部解开匿名跨模型全部身份",async()=>{
    const {client,threads:[left,right]}=await oldAnonymousPair();
    await block(operatorA,left);await block(operatorB,right);await unblock(operatorA,left);
    assert.equal((await read(client,left)).blocked,false);assert.equal((await read(client,right)).blocked,true);
    await block(operatorA,left);await block(admin,left);await unblock(operatorA,left);
    const scopes=await db(`SELECT DISTINCT operator_id FROM blocks WHERE id IN(${sql(hash(client.state.visitor))},${sql(hash(left.token))},${sql(hash(right.token))},${sql(hash(client.state.ip))}) ORDER BY operator_id`);
    assert(scopes.some(row=>row.operator_id===b));assert(scopes.some(row=>row.operator_id==='*'));assert(!scopes.some(row=>row.operator_id===a));
    await unblock(admin,left);
    assert.equal((await read(client,left)).blocked,false);assert.equal((await read(client,right)).blocked,false);
    const remaining=await db(`SELECT id FROM blocks WHERE id IN(${sql(hash(client.state.visitor))},${sql(hash(left.token))},${sql(hash(right.token))},${sql(hash(client.state.ip))})`);assert.equal(remaining.length,0);
    for (const [index,visitorHash] of ["",null].entries()) {
      const clients=[0,1].map(i=>actor(`merge-no-visitor-${index}-${i}`,{visitor:"",ip:`198.51.100.${185+index*2+i}`}));
      const missing=[a,b].map(operator=>({id:randomBytes(16).toString("base64url"),token:randomBytes(32).toString("base64url"),operator}));
      await db(missing.flatMap((thread,i)=>[
        `INSERT INTO threads(id,token_hash,title,preview,created_at,updated_at,awaiting,visitor_hash,ip_hash,operator_id,last_role) VALUES(${sql(thread.id)},${sql(hash(thread.token))},'合成缺失visitor旧对话','旧对话',${Date.now()+i},${Date.now()+i},0,${visitorHash===null?"NULL":sql(visitorHash)},${sql(hash(clients[i].state.ip))},${sql(thread.operator)},'visitor')`,
        `INSERT INTO messages(id,thread_id,role,body,created_at) VALUES(${sql(randomBytes(16).toString("base64url"))},${sql(thread.id)},'visitor','缺失visitor不代表同一个人',${Date.now()+i})`,
      ]).join(";\n"));
      await block(operatorA,missing[0]);await block(operatorB,missing[1]);await block(admin,missing[0]);
      await unblock(admin,missing[0]);
      assert.equal((await read(clients[0],missing[0])).blocked,false);
      assert.equal((await read(clients[1],missing[1])).blocked,true,`${visitorHash===null?"NULL":"空串"}visitor不能聚合清除另一段独立对话`);
      await unblock(admin,missing[1]);
      assert.equal((await read(clients[1],missing[1])).blocked,false);
    }
  });

  await check("合并main：管理员全部解开账号跨模型及旧历史身份，保留其他访客封禁",async()=>{
    const client=actor("merge-multi-account",{ip:"198.51.100.184"});await client.register();
    const left=await create(client,"账号跨模型A",a),right=await create(client,"账号跨模型B",b);
    await block(operatorA,left);await block(operatorB,right);await unblock(operatorA,left);
    assert.equal((await read(client,left)).blocked,false);assert.equal((await read(client,right)).blocked,true);
    await block(operatorA,left);await block(admin,left);
    const unrelated=hash("merge-unrelated-visitor");
    await db([`INSERT INTO blocks(id,operator_id,created_at) VALUES(${sql(hash(left.token))},${sql(a)},${Date.now()})`,`INSERT INTO blocks(id,operator_id,created_at) VALUES(${sql(hash(right.token))},${sql(b)},${Date.now()})`,`INSERT INTO blocks(id,operator_id,created_at) VALUES(${sql(unrelated)},${sql(a)},${Date.now()})`,`INSERT INTO blocks(id,operator_id,created_at) VALUES(${sql(unrelated)},${sql(b)},${Date.now()})`].join(";\n"));
    await unblock(operatorA,left);
    const global=await db(`SELECT id FROM blocks WHERE id=${sql(`account:${client.state.accountId}`)} AND operator_id='*'`);assert.equal(global.length,1);
    await unblock(admin,left);
    assert.equal((await read(client,left)).blocked,false);assert.equal((await read(client,right)).blocked,false);
    const remaining=await db(`SELECT id FROM blocks WHERE id IN(${sql(`account:${client.state.accountId}`)},${sql(hash(left.token))},${sql(hash(right.token))},${sql(hash(client.state.visitor))},${sql(hash(client.state.ip))})`);assert.equal(remaining.length,0);
    const kept=await db(`SELECT id FROM blocks WHERE id=${sql(unrelated)}`);assert.equal(kept.length,2);
    await db(`DELETE FROM blocks WHERE id=${sql(unrelated)}`);
  });

  await check("合并main：执行newChat清除旧blocked状态并恢复输入和焦点",()=>verifyNewChatReset(root,a));
}

export async function verifyNewChatReset(root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),a="tangbao-local-previous") {
    const source=await readFile(path.join(root,"src/client/app.txt"),"utf8");
    const start=source.indexOf("function newChat(");const end=source.indexOf("\nfunction shotFiles(",start);assert(start>=0&&end>start);
    const growStart=source.indexOf("function grow()");const growEnd=source.indexOf("\nasync function sendText(",growStart);assert(growStart>=0&&growEnd>growStart);
    const paintStart=source.indexOf("function paint(list)");const paintEnd=source.indexOf("\nfunction historyModel(",paintStart);assert(paintStart>=0&&paintEnd>paintStart);
    const blockedStart=source.indexOf("function applyBlocked(");const blockedEnd=source.indexOf("\nfunction applyStatus(",blockedStart);assert(blockedStart>=0&&blockedEnd>blockedStart);
    for (const [sending,pick] of [[false,true],[true,true],[false,false]]) {
      const nodes=Object.fromEntries(["#plus","#file","#make-off"].map(id=>[id,{disabled:true}]));
      const context={viewVersion:3,current:{id:"blocked-old"},blocked:true,threadModel:a,threadQueued:false,store:{activeId:"blocked-old"},painted:"old",openAwaiting:false,chosen:a,sending,making:false,pendingImages:[],input:{disabled:true,value:"新的问题",style:{},scrollHeight:24,focus(){if(!this.disabled)context.focused=true;}},send:{disabled:true},focused:false,sys:{hidden:false,textContent:"被拉黑"},BLOCKED:"被拉黑",body:{dataset:{}},titleEl:{textContent:"旧对话"},log:{replaceChildren(){}},stage:{scrollHeight:20,scrollTop:0},messages:[],tickPending(){},updateReportEntry(){},saveStore(){},renderHistory(){},closeSide(){},closeCard(){},paintModels(){},loadModels(){},setThreadUrl(){},$(id){return nodes[id]}};
      vm.createContext(context);vm.runInContext(`${source.slice(growStart,growEnd)}\n${source.slice(paintStart,paintEnd)}\n${source.slice(blockedStart,blockedEnd)}\n${source.slice(start,end)}\nnewChat(${pick?"'tangbao-local-new'":""});`,context);
      assert.equal(context.blocked,false);assert.equal(context.current,null);assert.equal(context.store.activeId,null);assert.equal(context.input.disabled,sending,"新对话必须解除旧input.disabled，并保留发送中保护");assert.equal(context.send.disabled,sending);assert.equal(nodes["#plus"].disabled,sending);assert.equal(context.sys.textContent,"");assert.equal(context.focused,!sending);
    }
}
