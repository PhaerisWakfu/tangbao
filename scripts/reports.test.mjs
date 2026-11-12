import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Script } from 'node:vm';
import { createClient } from '@libsql/client';
import ts from 'typescript';

const root=path.resolve(import.meta.dirname,'..');
const source=await readFile(path.join(root,'src/index.ts'),'utf8');
const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
const adapter=ast.statements.filter(n=>(ts.isFunctionDeclaration(n)||ts.isClassDeclaration(n))&&['d1Meta','TursoStatement','TursoDatabase'].includes(n.name?.text)).map(n=>n.getText(ast)).join('\n');
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const reports=compile(await readFile(path.join(root,'src/reports.ts'),'utf8'));
const bytes=compile(await readFile(path.join(root,'src/request-body.ts'),'utf8'));
class AuthError extends Error{constructor(status,code,message){super(message);Object.assign(this,{status,code});}}
async function fixture(t,withTypes=true){
  await mkdir(path.join(root,'.tmp'),{recursive:true});const dir=await mkdtemp(path.join(root,'.tmp/report-test-'));
  const client=createClient({url:`file:${path.join(dir,'synthetic.db')}`});t.after(async()=>{client.close();await rm(dir,{recursive:true,force:true});});
  for(const file of(await readdir(path.join(root,'migrations'))).filter(n=>n.endsWith('.sql')&&(withTypes||n<'0031')).sort())await client.executeMultiple(await readFile(path.join(root,'migrations',file),'utf8'));
  const sql=async(query,...args)=>(await client.execute({sql:query,args})).rows;
  for(const id of ['a','b','c','d','e','f','admin','reviewer']){
    await sql("INSERT INTO accounts(id,email,password_hash,verified_at,created_at,updated_at) VALUES(?,?,'synthetic',1,1,1)",id,`${id}@example.test`);
    if(['admin','reviewer'].includes(id))await sql("INSERT INTO account_roles(account_id,role) VALUES(?,'admin')",id);
    else{await sql("INSERT INTO account_roles(account_id,role) VALUES(?,'operator')",id);await sql("INSERT INTO operators(id,password_hash,created_at,owner_account_id,operator_uid) VALUES(?,'synthetic',1,?,?)",`model-${id}`,id,`uid-${id}`);}
  }
  await sql("INSERT INTO settings(key,value) VALUES('home_owner_account_id','admin') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const scope={};new Script(compile(adapter+'\nglobalThis.Database=TursoDatabase;')).runInNewContext(scope);
  const db=new scope.Database(client);let now=1_800_000_000_000, sequence=0, loseInsert=false, loseDecision=false;
  const env={DB:{prepare(query){const stmt=db.prepare(query);return{
    bind(...args){const bound=stmt.bind(...args);return{...bound,first:()=>bound.first(),all:()=>bound.all(),async run(){const result=await bound.run();if(loseInsert&&query.startsWith('INSERT INTO reports(')){loseInsert=false;throw new Error('synthetic lost acknowledgement');}if(loseDecision&&query.startsWith('UPDATE reports SET status=')){loseDecision=false;throw new Error('synthetic lost acknowledgement');}return result;}};},
    first:()=>stmt.first(),all:()=>stmt.all(),run:()=>stmt.run(),
  };},batch:s=>db.batch(s)},IMAGES:{async get(key){return key==='img/synthetic'?new Uint8Array([137,80,78,71]).buffer:null;}}};
  const auth={AuthError,authNow:()=>now,sha256:async s=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex'),async requireAccount(request){
    const id=request.headers.get('x-test-account');const [a]=await sql('SELECT * FROM accounts WHERE id=?',id);if(!a||a.status!=='active'||!a.verified_at)throw new AuthError(401,'AUTH_REQUIRED','请登录。');
    return{id,verified:true,roles:(await sql('SELECT role FROM account_roles WHERE account_id=?',id)).map(r=>r.role),home:id==='admin'};
  }};
  const byteScope={exports:{},Uint8Array,Response};new Script(bytes).runInNewContext(byteScope);
  const context={exports:{},Request,Response,URL,TextDecoder,crypto,atob,btoa,console,require(name){if(name==='./auth')return auth;if(name==='./request-body')return byteScope.exports;if(name==='./account-business')return{consumeRate:async()=>true};throw Error(name);}};
  new Script(reports).runInNewContext(context);
  async function call(actor,url,data,status=200){let response;
    try{response=await context.exports.reportRoute(new Request('https://local.example'+url,{method:data===undefined?'GET':'POST',headers:{'x-test-account':actor,'content-type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)}),env);}
    catch(e){if(!e.status)throw e;response=Response.json({code:e.code,error:e.message},{status:e.status});}
    assert((Array.isArray(status)?status:[status]).includes(response.status),`${url}: ${await response.clone().text()}`);
    return response.headers.get('content-type')?.includes('json')?response.json():new Uint8Array(await response.arrayBuffer());
  }
  async function message(visitor='a',operator='b',role='tangbao',image=false){
    const thread=`thread-${++sequence}`,id=`message-${sequence}`,author=role==='tangbao'?operator:visitor;
    await sql("INSERT INTO threads(id,token_hash,title,created_at,updated_at,account_id,operator_id) VALUES(?,'synthetic','合成对话',?,?,?,?)",thread,now,now,visitor,`model-${operator}`);
    await sql('INSERT INTO messages(id,thread_id,role,body,draw,created_at,author_account_id) VALUES(?,?,?,?,0,?,?)',id,thread,role,'合成消息',now,author);
    if(image)await sql("INSERT INTO message_images(id,message_id,image_key,image_type,position) VALUES(?,?,'img/synthetic','image/png',0)",`image-${sequence}`,id);
    return{id,thread};
  }
  const create=async(actor,m,key=crypto.randomUUID(),status=201)=>call(actor,'/api/reports',{messageId:m.id,typeCode:'other',reason:'合成举报原因',requestKey:key},status);
  async function decide(id,outcome='rejected',actor='admin'){
    const reason='合成审核理由';const p=await call(actor,`/api/admin/reports/${id}/preview`,{outcome,reason});
    const result=await call(actor,`/api/admin/reports/${id}/decision`,{outcome,reason,token:p.token});return{...p,result};
  }
  return{sql,call,message,create,decide,env,db,applyTypes:async()=>client.executeMultiple(await readFile(path.join(root,'migrations/0031_report_types.sql'),'utf8')),setNow:v=>now=v,now:()=>now,loseInsert:()=>loseInsert=true,loseDecision:()=>loseDecision=true};
}
test('双向消息授权、匿名和旧消息边界、普通用户不可读取他人信誉或审核',async t=>{
  const f=await fixture(t),m=await f.message();
  const states=await f.call('a','/api/reports/states',{messageIds:[m.id]});assert.equal(states.states[0].state,'available');
  await f.create('c',m,undefined,403);await f.call('a','/api/admin/reports',undefined,403);
  await f.call('a','/api/reputation?accountId=b');assert.equal((await f.call('a','/api/reputation')).score,100);
  await f.sql('UPDATE accounts SET verified_at=0 WHERE id=?','b');await f.create('a',m,undefined,403);
  await f.sql('UPDATE accounts SET verified_at=1,status=? WHERE id=?','disabled','b');
  const row=(await f.create('a',m)).report;await f.call('c',`/api/reports/${row.id}`,undefined,404);
  await f.call('b',`/api/reports/${row.id}`,undefined,401); // disabled accounts cannot read sessions
  const opposite=await f.message('a','c','visitor');assert.equal((await f.create('c',opposite)).report.status,'pending');
  const old=await f.message('d','e');await f.sql('DELETE FROM messages WHERE id=?',old.id);
  await f.sql("INSERT INTO messages(id,thread_id,role,body,created_at) VALUES(?,?,'tangbao','历史消息',1)",old.id,old.thread);
  assert.equal((await f.call('d','/api/reports/states',{messageIds:[old.id]})).states[0].state,'unavailable');
});
test('同对象待审核唯一、三对象上限、释放容量、成功永久锁定且方向独立',async t=>{
  const f=await fixture(t),ab=await f.message(),ac=await f.message('a','c'),ad=await f.message('a','d'),ae=await f.message('a','e');
  const first=(await f.create('a',ab)).report;await f.create('a',ab,undefined,409);
  await f.create('a',ac);await f.create('a',ad);await f.create('a',ae,undefined,409);
  await f.decide(first.id,'rejected');const next=(await f.create('a',ae)).report;assert.equal(next.status,'pending');
  await f.create('a',ab,undefined,409);
  await f.decide(next.id,'upheld');
  const retry=(await f.create('a',ab)).report;assert.equal(retry.status,'pending');
  await f.create('a',ae,undefined,409);
});
test('并发提交只接受一张；丢失响应按请求键恢复，不重复占用容量',async t=>{
  const f=await fixture(t),m=await f.message(),key=crypto.randomUUID();f.loseInsert();
  const row=(await f.create('a',m,key,200)).report;
  assert.equal((await f.create('a',m,key,200)).report.id,row.id);
  assert.equal((await f.call('a','/api/reports?requestKey='+key)).report.id,row.id);
  await f.call('a','/api/reports',{messageId:m.id,typeCode:'other',reason:'更换举报原因',requestKey:key},409);
  assert.equal((await f.sql('SELECT count(*) n FROM reports'))[0].n,1);
  const other=await f.message('c','d');const data={messageId:other.id,typeCode:'other',reason:'并发测试',requestKey:crypto.randomUUID()};
  const request=()=>f.call('c','/api/reports',data,[200,201]);
  // Real SQL trigger concurrency is also exercised by the D1 HTTP regression.
  await Promise.all([request(),request()]);assert.equal((await f.sql('SELECT count(*) n FROM reports WHERE reporter_id=?','c'))[0].n,1);
});
test('失败滚动档位1/1/2/2/3/4/5，成功不清零；恰好7天退出窗口',async t=>{
  const f=await fixture(t),m=await f.message();let score=100;
  for(const penalty of [1,1,2,2,3,4,5,5]){
    const row=(await f.create('a',m)).report;const impact=await f.decide(row.id);assert.equal(impact.penalty,penalty);score-=penalty;
    assert.equal((await f.call('a','/api/reputation')).score,score);
  }
  const good=await f.message('a','c');await f.decide((await f.create('a',good)).report.id,'upheld');
  assert.equal((await f.call('a','/api/reputation')).score,score);
  assert.equal((await f.decide((await f.create('a',m)).report.id)).penalty,5);score-=5;
  f.setNow(f.now()+604800000);
  assert.equal((await f.decide((await f.create('a',m)).report.id)).penalty,1);
  assert.equal((await f.call('a','/api/reputation')).score,score-1);
});
test('60分可以提交，59分拒绝；已受理案件继续审核，分数最低0',async t=>{
  const f=await fixture(t),m=await f.message();await f.sql("UPDATE account_reputations SET score=60 WHERE account_id='a'");
  const row=(await f.create('a',m)).report;await f.sql("UPDATE account_reputations SET score=59 WHERE account_id='a'");
  await f.create('a',await f.message('a','c'),undefined,403);
  await f.sql("UPDATE account_reputations SET score=1 WHERE account_id='a'");await f.decide(row.id,'rejected');
  assert.equal((await f.call('a','/api/reputation')).score,0);
});
test('缺失信誉快照不能假装100分，也不能绕过受理门槛',async t=>{
  const f=await fixture(t),m=await f.message();await f.sql("DELETE FROM account_reputations WHERE account_id='a'");
  await f.call('a','/api/reputation',undefined,503);
  await f.call('a','/api/reports/states',{messageIds:[m.id]},503);
  await f.create('a',m,undefined,503);assert.equal((await f.sql('SELECT count(*) n FROM reports'))[0].n,0);
});
test('审核预览变化需重确认，双审核员及丢失响应只扣一次，终态不可改',async t=>{
  const f=await fixture(t),m=await f.message(),row=(await f.create('a',m)).report;
  const p=await f.call('admin',`/api/admin/reports/${row.id}/preview`,{outcome:'upheld',reason:'确认违规'});
  await f.sql("UPDATE account_reputations SET score=99,revision=revision+1 WHERE account_id='b'");
  await f.call('admin',`/api/admin/reports/${row.id}/decision`,{outcome:'upheld',reason:'确认违规',token:p.token},409);
  f.loseDecision();await f.decide(row.id,'upheld');assert.equal((await f.call('b','/api/reputation')).score,94);
  await f.call('reviewer',`/api/admin/reports/${row.id}/decision`,{outcome:'upheld',reason:'再次审核',token:'old'});
  assert.equal((await f.call('b','/api/reputation')).score,94);
  await f.call('admin',`/api/admin/reports/${row.id}/decision`,{outcome:'rejected',reason:'改变结果'},409);
  await assert.rejects(f.sql('UPDATE reports SET review_reason=? WHERE id=?','篡改',row.id),/REPORT_IMMUTABLE/);
  assert.equal((await f.call('a','/api/reports/states',{messageIds:[m.id]})).states[0].state,'locked');
  const reverse=await f.message('a','b','visitor');assert.equal((await f.create('b',reverse)).report.status,'pending');
});
test('证据随工单保留；普通人不能读取他人的图片、身份和扣分；旧标记不扣分',async t=>{
  const f=await fixture(t),m=await f.message('a','b','tangbao',true);await f.sql('UPDATE threads SET reported_at=1,report_reason=? WHERE id=?','历史举报',m.thread);
  const row=(await f.create('a',m)).report;assert.equal(row.reporterId,undefined);assert.equal(row.targetId,undefined);
  await f.sql('DELETE FROM message_images WHERE message_id=?',m.id);await f.sql('DELETE FROM messages WHERE id=?',m.id);await f.sql('DELETE FROM threads WHERE id=?',m.thread);
  const saved=(await f.call('admin',`/api/reports/${row.id}`)).report;assert.equal(saved.message.body,'合成消息');
  assert.equal((await f.call('a',saved.images[0].url))[0],137);await f.call('c',saved.images[0].url,undefined,404);
  await f.call('b',`/api/reports/${row.id}`,undefined,404);
  await f.decide(row.id,'upheld');const received=(await f.call('b',`/api/reports/${row.id}`)).report;
  assert.equal(received.deduction,5);assert.equal(received.reporterId,undefined);assert.equal(received.targetId,undefined);
  assert.equal((await f.call('a',`/api/reports/${row.id}`)).report.scoreAfter,null);
});
test('配置只有所有者可发布，版本不可变、预览CAS、回滚新建版本且旧结算不重算',async t=>{
  const f=await fixture(t),active=await f.call('admin','/api/admin/report-policy');
  const policy={...active.policy,upheldPenalty:4,minimumReportScore:65};const reason='调整合成规则';
  await f.call('reviewer','/api/admin/report-policy/preview',{policy,reason},403);
  await f.call('admin','/api/admin/report-policy/preview',{policy:{...policy,upheldPenalty:101},reason},400);
  const preview=await f.call('admin','/api/admin/report-policy/preview',{policy,reason});
  const published=await f.call('admin','/api/admin/report-policy/publish',{...preview,reason});assert.notEqual(published.id,active.id);
  await f.call('admin','/api/admin/report-policy/publish',{...preview,reason},409);
  const m=await f.message(),row=(await f.create('a',m)).report;await f.decide(row.id,'upheld');assert.equal((await f.call('b','/api/reputation')).score,96);
  const back=await f.call('admin','/api/admin/report-policy/preview',{version:active.id,reason:'回滚合成规则'});
  const rollback=await f.call('admin','/api/admin/report-policy/rollback',{...back,version:active.id,reason:'回滚合成规则'});assert.notEqual(rollback.id,active.id);
  assert.equal((await f.call('b','/api/reputation')).score,96);
  await assert.rejects(f.sql('UPDATE report_policy_versions SET reason=? WHERE id=?','篡改',active.id),/REPORT_POLICY_IMMUTABLE/);
  await f.create('a',m,undefined,409);
});

test('部署配置可指定规则维护者，不能凭管理员身份越过该定义权',async t=>{
  const f=await fixture(t),active=await f.call('admin','/api/admin/report-policy');
  f.env.REPORT_POLICY_OWNER_ACCOUNT_ID='reviewer';
  await f.call('admin','/api/admin/report-policy/preview',{policy:active.policy,reason:'越权修改'},403);
  await f.call('reviewer','/api/admin/report-policy/preview',{policy:active.policy,reason:'指定维护者预览'});
});

test('参数调整实际改变容量；受理时冻结的成功上限不会被后续版本解锁',async t=>{
  const f=await fixture(t),active=await f.call('admin','/api/admin/report-policy');
  async function publish(policy){const reason='调整容量';const p=await f.call('admin','/api/admin/report-policy/preview',{policy,reason});return f.call('admin','/api/admin/report-policy/publish',{...p,reason});}
  const policy={...active.policy,successLimit:2,pendingPerPair:2,pendingTargets:1};await publish(policy);
  const m=await f.message(),first=(await f.create('a',m)).report,second=(await f.create('a',m)).report;
  await f.create('a',m,undefined,409);await f.create('a',await f.message('a','c'),undefined,409);
  await f.decide(first.id,'upheld');await f.create('a',m,undefined,409);
  await f.decide(second.id,'rejected');const final=(await f.create('a',m)).report;await f.decide(final.id,'upheld');
  await publish({...policy,successLimit:3});await f.create('a',m,undefined,409);
});

test('分类调整后原已受理请求仍可重放，保持原工单和金额',async t=>{
  const f=await fixture(t),m=await f.message(),key=crypto.randomUUID(),row=(await f.create('a',m,key)).report;
  const current=await f.call('admin','/api/admin/report-policy'),policy={...current.policy,reportTypes:current.policy.reportTypes.filter(t=>t.code!=='other')},reason='调整分类';
  const p=await f.call('admin','/api/admin/report-policy/preview',{policy,reason});await f.call('admin','/api/admin/report-policy/publish',{...p,reason});
  assert.equal((await f.create('a',m,key,200)).report.id,row.id);
});

test('账号、队列、失败窗口及图片引用查询使用对应索引',async t=>{
  const f=await fixture(t);
  for(const [query,index] of [
    ["SELECT id FROM reports WHERE reporter_id='a' ORDER BY created_at DESC,id DESC LIMIT 11",'idx_reports_reporter_page'],
    ["SELECT id FROM reports WHERE target_id='a' AND status='upheld' ORDER BY created_at DESC,id DESC LIMIT 11",'idx_reports_target_page'],
    ["SELECT count(*) FROM reports WHERE reporter_id='a' AND status='rejected' AND decided_at>100 AND decided_at<=200",'idx_reports_failure_window'],
    ["SELECT id FROM reports WHERE status='pending' AND model_uid='uid-b' ORDER BY created_at DESC,id DESC LIMIT 11",'idx_reports_model_queue'],
    ["SELECT 1 FROM message_images WHERE image_key='img/synthetic' LIMIT 1",'idx_message_images_key'],
    ["SELECT 1 FROM report_images WHERE image_key='img/synthetic' LIMIT 1",'idx_report_images_key'],
  ])assert((await f.sql('EXPLAIN QUERY PLAN '+query)).some(row=>row.detail.includes(index)),query);
});

test('举报类型必选且校验码值；选填原因支持空值、单字、长中文和特殊字符',async t=>{
  const f=await fixture(t),m=await f.message();
  for(const typeCode of [undefined,'unknown','legacy'])await f.call('a','/api/reports',{messageId:m.id,typeCode,requestKey:crypto.randomUUID()},400);
  assert.equal((await f.sql('SELECT count(*) n FROM reports'))[0].n,0);
  const options=await f.call('a','/api/reports/states',{messageIds:[m.id]});assert.equal(options.reportTypes.length,9);
  for(const [index,reason] of [undefined,'','。','说明😀 <script>\n"\u0000'.repeat(1500)].entries()){
    const type=options.reportTypes[index];
    const row=(await f.call('a','/api/reports',{messageId:m.id,typeCode:type.code,typeLabel:'伪造分类名',reason,requestKey:crypto.randomUUID()},201)).report;
    assert.equal(row.typeCode,type.code);assert.equal(row.typeLabel,type.label);assert.equal(row.reason,(reason || '').replace(/\u0000/g,''));
    if(index===3){
      for(const [actor,url] of [['a','/api/reports'],['admin','/api/admin/reports']]){
        const preview=(await f.call(actor,url)).reports.find(r=>r.id===row.id);
        assert.equal(preview.reason,[...row.reason].slice(0,200).join(''));assert.equal(preview.typeLabel,type.label);
      }
      assert.equal((await f.call('admin',`/api/reports/${row.id}`)).report.reason,row.reason);
    }
    await f.decide(row.id);
  }
});

test('只改变分类也视为不同提交内容；已受理分类不可篡改',async t=>{
  const f=await fixture(t),m=await f.message(),key=crypto.randomUUID(),row=(await f.create('a',m,key)).report;
  await f.call('a','/api/reports',{messageId:m.id,typeCode:'sexual',reason:'合成举报原因',requestKey:key},409);
  await assert.rejects(f.sql('UPDATE reports SET type_code=?,type_label=? WHERE id=?','sexual','色情低俗',row.id),/REPORT_IMMUTABLE/);
  assert.equal((await f.call('a',`/api/reports/${row.id}`)).report.typeCode,'other');
});

test('分类可配置且旧工单名称冻结；不合法的分类配置拒绝发布',async t=>{
  const f=await fixture(t),m=await f.message(),row=(await f.create('a',m)).report;
  const current=await f.call('admin','/api/admin/report-policy');
  for(const reportTypes of [[],[{code:'bad code',label:'非法'}],[{code:'other',label:'重复'},{code:'other',label:'重复码'}]])
    await f.call('admin','/api/admin/report-policy/preview',{policy:{...current.policy,reportTypes},reason:'非法分类'},400);
  const policy={...current.policy,reportTypes:[{code:'other',label:'其他内容'}]},reason='调整分类名';
  const p=await f.call('admin','/api/admin/report-policy/preview',{policy,reason});await f.call('admin','/api/admin/report-policy/publish',{...p,reason});
  assert.equal((await f.call('a',`/api/reports/${row.id}`)).report.typeLabel,'其他');
  assert.equal((await f.create('c',await f.message('c','d'))).report.typeLabel,'其他内容');
});

test('升级保留旧工单及扣分，旧请求可恢复；回滚旧版本不会恢复原因字数门槛',async t=>{
  const f=await fixture(t,false),m=await f.message(),reason='旧举报原因',requestKey='legacy_test_key';
  const fingerprint=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([m.id,reason])))).toString('hex');
  await f.sql(`INSERT INTO reports(id,reporter_id,target_id,thread_id,message_id,reporter_role,target_label,model_uid,thread_title,snapshot,reason,request_key,fingerprint,created_at,creation_policy_id)
    VALUES('old-report','a','b',?,?,'visitor','model-b','uid-b','合成对话','{"body":"旧消息"}',?,?,?,?, 'reports-v1')`,m.thread,m.id,reason,requestKey,fingerprint,f.now());
  await f.decide('old-report','upheld');const before=await f.sql('SELECT score,deducted,event_count,revision FROM account_reputations ORDER BY account_id');
  await f.applyTypes();assert.deepEqual(await f.sql('SELECT score,deducted,event_count,revision FROM account_reputations ORDER BY account_id'),before);
  const recovered=(await f.call('a','/api/reports',{messageId:m.id,reason,requestKey})).report;
  assert.equal(recovered.id,'old-report');assert.equal(recovered.typeCode,'legacy');assert.equal(recovered.typeLabel,'未分类');assert.equal(recovered.status,'upheld');
  await f.call('a','/api/reports',{messageId:m.id,reason,requestKey:crypto.randomUUID()},400);
  const back=await f.call('admin','/api/admin/report-policy/preview',{version:'reports-v1',reason:'回滚旧规则'});
  const restored=await f.call('admin','/api/admin/report-policy/rollback',{...back,version:'reports-v1',reason:'回滚旧规则'});
  assert.equal(restored.policy.reasonMinLength,undefined);assert.equal(restored.policy.reasonMaxLength,undefined);assert.equal(restored.policy.reportTypes.length,9);
  assert.equal((await f.call('b','/api/reputation')).score,95);
});

test('匿名直调创建、旧入口、资格、记录和信誉均被拒绝，整体超大请求不落工单',async t=>{
  const f=await fixture(t),m=await f.message();
  for(const [url,data] of [['/api/reports',{messageId:m.id,typeCode:'other',requestKey:crypto.randomUUID()}],
    [`/api/threads/${m.thread}/report`,{typeCode:'other',reason:'匿名举报'}],['/api/reports/states',{messageIds:[m.id]}],['/api/reports',undefined],['/api/reputation',undefined]])
    await f.call('',url,data,401);
  await f.call('a','/api/reports',{messageId:m.id,typeCode:'other',reason:'x'.repeat(270000),requestKey:crypto.randomUUID()},413);
  assert.equal((await f.sql('SELECT count(*) n FROM reports'))[0].n,0);
});
