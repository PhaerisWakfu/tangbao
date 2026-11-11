import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Real local Worker/D1/KV and normal account sessions. No direct business SQL or remote bindings.
export async function runReportScenarios({actor,admin,operatorA,operatorB,check,advance}){
  const user=actor('report-member');await user.register();
  const device=actor('report-member-device',{email:user.state.email,password:user.state.password});await device.login();
  const stranger=actor('report-stranger');await stranger.register();
  const image=()=>new File([Uint8Array.from([137,80,78,71,13,10,26,10])],'synthetic.png',{type:'image/png'});
  async function conversation(visitor=user,operator=operatorB,withImage=false){
    const thread=await visitor.request('/api/threads',{method:'POST',body:{body:'举报回归合成对话',operator:operator.state.operatorId}});
    assert.equal(thread.operator,operator.state.operatorId);
    let body={body:'举报回归合成回复'};
    if(withImage){body=new FormData();body.set('body','举报回归图片回复');body.append('images',image());}
    await operator.request(`/api/admin/threads/${thread.id}`,{method:'POST',body});
    const data=await visitor.request(`/api/threads/${thread.id}`);return{thread,message:data.messages.at(-1),visitorMessage:data.messages[0]};
  }
  const create=(client,message,key=randomUUID(),status=201)=>client.request('/api/reports',{method:'POST',body:{messageId:message.id,reason:'合成举报原因',requestKey:key},status});
  async function preview(id,outcome='rejected') {return admin.request(`/api/admin/reports/${id}/preview`,{method:'POST',body:{outcome,reason:'合成审核原因'}});}
  async function decide(id,outcome='rejected') {const impact=await preview(id,outcome);const result=await admin.request(`/api/admin/reports/${id}/decision`,{method:'POST',body:{outcome,reason:'合成审核原因',token:impact.token}});return{impact,result};}
  let first;
  await check('举报：双方账号、消息归属、普通账号越权与模型反向举报',async()=>{
    first=await conversation(user,operatorA,true);
    assert.equal(first.message.canReport,true);assert.equal(first.message.author,undefined);
    await create(stranger,first.message,undefined,403);
    await stranger.request('/api/admin/reports',{status:403});
    const anonymous=actor('report-anonymous');await anonymous.request('/api/reports',{method:'POST',body:{messageId:first.message.id,reason:'匿名举报',requestKey:randomUUID()},status:401});
    const read=await operatorA.request(`/api/admin/threads/${first.thread.id}`);assert.equal(read.messages[0].canReport,true);
    const reverse=(await create(operatorA,first.visitorMessage)).report;
    await decide(reverse.id,'rejected');assert.equal((await operatorA.request('/api/reputation')).score,99);
    assert.equal((await user.request('/api/reputation')).score,100);
    await operatorA.request(`/api/admin/threads/${first.thread.id}/block`,{method:'POST'});
  });
  let row,key;
  await check('举报：跨设备同请求并发只建一单，待审核互斥、恢复查询和内容冲突',async()=>{
    key=randomUUID();const results=await Promise.all([create(user,first.message,key,[200,201]),create(device,first.message,key,[200,201])]);
    row=results[0].report;assert.equal(results[1].report.id,row.id);
    assert.equal((await user.request('/api/reports?requestKey='+key)).report.id,row.id);
    await create(device,first.message,undefined,409);
    await device.request('/api/reports',{method:'POST',body:{messageId:first.message.id,reason:'修改原提交内容',requestKey:key},status:409});
    const states=await user.request('/api/reports/states',{method:'POST',body:{messageIds:[first.message.id]}});assert.equal(states.states[0].state,'pending');
    await stranger.request(`/api/reports/${row.id}`,{status:404});
  });
  await check('举报：拉黑后历史消息仍可举报；删聊天后证据图片仍可审核且隔离访问',async()=>{
    await operatorA.request(`/api/admin/threads/${first.thread.id}/block`,{method:'POST'});
    const data=await user.request(`/api/threads/${first.thread.id}`);assert.equal(data.blocked,true);
    assert.equal((await user.request('/api/reports/states',{method:'POST',body:{messageIds:[first.message.id]}})).states[0].state,'pending');
    await operatorA.request(`/api/admin/threads/${first.thread.id}/unblock`,{method:'POST'});
    await user.request(`/api/threads/${first.thread.id}`,{method:'DELETE'});
    const saved=(await admin.request(`/api/reports/${row.id}`)).report;assert.equal(saved.images.length,1);
    assert.equal((await user.request(saved.images[0].url))[0],137);
    await stranger.request(saved.images[0].url,{status:404});
    await operatorA.request(`/api/reports/${row.id}`,{status:404});
    const impact=await preview(row.id,'upheld');
    const decision={outcome:'upheld',reason:'合成审核原因',token:impact.token};
    await Promise.all([admin.request(`/api/admin/reports/${row.id}/decision`,{method:'POST',body:decision}),admin.request(`/api/admin/reports/${row.id}/decision`,{method:'POST',body:decision})]);
    assert.equal((await operatorA.request('/api/reputation')).score,94);
    assert.equal((await user.request('/api/reputation')).score,100);
    assert.equal((await operatorA.request(`/api/reports/${row.id}`)).report.deduction,5);
    await admin.request(`/api/admin/reports/${row.id}/decision`,{method:'POST',body:{...decision,outcome:'rejected'},status:409});
    await user.request(`/api/reports/${row.id}`);
    const later=await conversation(user,operatorA);await create(user,later.message,undefined,409);
    assert.equal((await user.request('/api/reports/states',{method:'POST',body:{messageIds:[later.message.id]}})).states[0].state,'locked');
  });
  await check('举报：7天失败阶梯按账号累计，窗口到期不返还已扣分',async()=>{
    let score=100;
    for(const penalty of [1,1,2,2,3,4,5,5]){
      const c=await conversation();const report=(await create(user,c.message)).report;
      const {impact}=await decide(report.id);assert.equal(impact.penalty,penalty);score-=penalty;
      assert.equal((await device.request('/api/reputation')).score,score);
    }
    await advance(604800000);
    const c=await conversation();const {impact}=await decide((await create(user,c.message)).report.id);assert.equal(impact.penalty,1);
    assert.equal((await user.request('/api/reputation')).score,score-1);
  });
  await check('举报：3个待处理对象上限、处理释放名额、同方向成功永久锁定',async()=>{
    const visitors=[];
    for(let i=0;i<4;i++){
      const v=actor('report-target-'+i);await v.register();visitors.push(await conversation(v,operatorB));
    }
    const reports=[];for(const c of visitors.slice(0,3))reports.push((await create(operatorB,c.visitorMessage)).report);
    await create(operatorB,visitors[3].visitorMessage,undefined,409);
    await decide(reports[0].id,'upheld');await create(operatorB,visitors[3].visitorMessage);
    await create(operatorB,visitors[0].visitorMessage,undefined,409);
  });
  await check('举报：旧线程入口适配同一工单，重放不重复计分或占位',async()=>{
    const v=actor('report-legacy-adapter');await v.register();const c=await conversation(v,operatorB);
    const old=await v.request(`/api/threads/${c.thread.id}/report`,{method:'POST',body:{reason:'旧页面合成举报'},status:201});
    const replay=await v.request(`/api/threads/${c.thread.id}/report`,{method:'POST',body:{reason:'旧页面合成举报'}});assert.equal(replay.report.id,old.report.id);
    assert.equal((await v.request('/api/reports')).reports.length,1);
    await decide(old.report.id);assert.equal((await v.request('/api/reputation')).score,99);
  });
}
