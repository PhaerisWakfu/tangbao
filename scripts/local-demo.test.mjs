import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { demoHtml,localClientUrl } from './local-demo.mjs';

const metadata={instance:'report-demo',port:8795,nonce:'synthetic-local-nonce'};
test('匿名A/B每次进入使用新主机名，不复用原有已登录客户端',()=>{
  for(const name of ['visitor-a','visitor-b']){
    const first=localClientUrl(metadata,{name},'11111111'),next=localClientUrl(metadata,{name},'22222222');
    assert.notEqual(first,next);assert.notEqual(new URL(first).hostname,`${name}-report-demo.localhost`);
    assert.match(new URL(first).hostname,/^guest-[ab]-11111111-report-demo\.localhost$/);
    assert.equal(new URL(first).pathname,'/chat');
  }
});
test('已登录角色的验收入口保持稳定；注册后的实际权限仍由账号决定',()=>{
  for(const [actor,path] of [[{name:'admin',email:'admin@example.test'},'/desk'],[{name:'operator-a',email:'a@example.test'},'/desk'],[{name:'member',email:'member@example.test'},'/chat'],[{name:'visitor-a',email:'member@example.test'},'/chat']]){
    const first=localClientUrl(metadata,actor,'11111111'),second=localClientUrl(metadata,actor,'22222222');
    assert.equal(first,second);assert.equal(new URL(first).pathname,path);
  }
});
test('本地角色入口拒绝非法主机、端口和会话后缀，并支持最长实例名',()=>{
  assert.equal(localClientUrl({...metadata,instance:'../bad'},{name:'visitor-a'},'11111111'),null);
  assert.equal(localClientUrl({...metadata,port:0},{name:'admin'}),null);
  assert.equal(localClientUrl(metadata,{name:'visitor-a'},'../bad'),null);
  assert.equal(localClientUrl(metadata,{name:'bad.test/escape'}),null);
  assert(new URL(localClientUrl({...metadata,instance:'a'.repeat(40)},{name:'visitor-a'},'11111111')).hostname.split('.')[0].length<=63);
});
test('验收面板生成的脚本可执行解析，匿名新入口逻辑实际嵌入页面',()=>{
  const html=demoHtml(metadata),scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,1);new Script(scripts[0][1]);assert(html.includes('localClientUrl(context,actor,entryId())'));
});
