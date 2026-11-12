import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import ts from 'typescript';
const source=await readFile(new URL('../src/client/reports.txt',import.meta.url),'utf8');
const ast=ts.createSourceFile('reports.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const declarations=[];
function visit(n){if(ts.isFunctionDeclaration(n))declarations.push(n);ts.forEachChild(n,visit);}visit(ast);
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function node(tag='',cls='',text=''){
  return{tag,className:cls,textContent:text,children:[],dataset:{},hidden:false,disabled:false,isConnected:true,value:'',
    append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},setAttribute(){},addEventListener(){},focus(){},
    querySelectorAll(){return this.children.flatMap(c=>[...(c.tag==='button'?[c]:[]),...c.querySelectorAll()]);}};
}
function setup(names){
  const dialogs=[];const context={URLSearchParams,generation:0,reviewViews:new WeakMap(),listViews:new WeakMap(),reviewStatus:'pending',reviewCursor:null,
    el:node,errorNode:()=>node('p'),showError:(n,e)=>n.textContent=e.message,date:n=>String(n),evidence(){},statusName:{pending:'待审核',upheld:'举报成功',rejected:'举报失败'},
    button:(label,action,cls)=>Object.assign(node('button',cls,label),{action}),invalidate(){},crypto,limits:{minimumReportScore:60},reportTypes:[{code:'other',label:'其他'}],window:{TangbaoAccount:{account:{verified:true}}},
    dialog(title){const d={node:node('dialog'),content:node('div'),open(){},close(){d.node.isConnected=false;}};dialogs.push(d);return d;},images(){},result:(box,row)=>box.append(node('p','',row.status)),
  };
  new Script(declarations.filter(n=>names.includes(n.name.text)).map(n=>n.getText(ast)).join('\n')).runInNewContext(context);
  const flatten=n=>[n,...n.children.flatMap(flatten)];return{context,dialogs,flatten};
}
const report=id=>({id,title:id,typeCode:'other',typeLabel:'其他',reason:'合成举报',status:'upheld',reporterId:'reporter',targetId:'target',reporterScore:100,targetScore:95,createdAt:1,decidedAt:2,scoreBefore:100,scoreAfter:95,reviewReason:'合成裁决'});
test('切换工单后迟到的详情不能覆盖当前工单',async()=>{
  const {context:c,flatten}=setup(['cancelReview','adminReview']);const a=defer(),b=defer(),container=node();c.request=path=>path.endsWith('/a')?a.promise:b.promise;
  const first=c.adminReview(container,'a'),second=c.adminReview(container,'b');b.resolve({report:report('b')});await second;
  const current=flatten(container).map(n=>n.textContent).join('|');assert(current.includes('b'));
  a.resolve({report:report('a')});await first;assert.equal(flatten(container).map(n=>n.textContent).join('|'),current);
});
test('离开审核视图及退出账号后不再渲染迟到详情',async()=>{
  for(const logout of [false,true]){
    const {context:c}=setup(['cancelReview','adminReview']);const response=defer(),container=node();c.request=()=>response.promise;
    const loading=c.adminReview(container,'a');if(logout)c.generation++;else c.cancelReview(container);
    container.replaceChildren(node('p','','原对话'));response.resolve({report:report('a')});await loading;
    assert.equal(container.children.length,1);assert.equal(container.children[0].textContent,'原对话');
  }
});
test('举报列表换筛选后旧请求不能覆盖新列表；相同结果不重建控件',async()=>{
  const {context:c,flatten}=setup(['adminList']);const a=defer(),b=defer(),container=node();let calls=0;c.request=()=>++calls===1?a.promise:b.promise;
  const first=c.adminList(container,()=>{});c.reviewStatus='upheld';const second=c.adminList(container,()=>{});
  b.resolve({reports:[report('new')],cursor:null});await second;const children=container.children;
  a.resolve({reports:[report('old')],cursor:null});await first;assert.strictEqual(container.children,children);
  assert(flatten(container).some(n=>n.textContent==='new'));assert(!flatten(container).some(n=>n.textContent==='old'));
  await c.adminList(container,()=>{});assert.strictEqual(container.children,children);
});
test('提交结果未知时重试保留原内容及请求键；先查原请求再发起幂等重试',async()=>{
  const {context:c,dialogs,flatten}=setup(['openSubmit']);const writes=[];let gets=0;
  c.request=async(path,data)=>{if(data){writes.push(data);if(writes.length===1)throw new Error('网络中断');return{report:{status:'pending'}};}gets++;return{report:null};};
  await c.openSubmit({id:'selected',body:'合成消息',reportLabel:'合成对象'});
  const input=flatten(dialogs[0].content).find(n=>n.tag==='textarea'),submit=flatten(dialogs[0].content).find(n=>n.textContent==='提交举报');
  flatten(dialogs[0].content).find(n=>n.tag==='select').value='other';
  input.value='首次举报原因';await submit.action();assert.equal(input.readOnly,true);
  await submit.action();assert.equal(gets,1);assert.equal(writes.length,2);assert.equal(writes[0].requestKey,writes[1].requestKey);assert.equal(writes[1].reason,'首次举报原因');
});
test('本人信誉加载时切换账号，旧分数不会写入新账号的设置',async()=>{
  const {context:c}=setup(['attachAccount']);const pending=defer(),container=node();c.request=()=>pending.promise;
  const loading=c.attachAccount(container,{verified:true});c.generation++;pending.resolve({score:82,minimumReportScore:60});await loading;
  const badge=container.children[0];assert.equal(badge.children[1].textContent,'信誉…');assert.equal(badge.disabled,true);
});
test('记录详情复用当前弹窗；返回列表后迟到的详情不再追加',async()=>{
  const {context:c,dialogs,flatten}=setup(['openRecord']),pending=defer(),host=c.dialog('举报记录');c.request=()=>pending.promise;
  const loading=c.openRecord('case',host,()=>host.content.replaceChildren(node('p','','原记录列表')));
  assert.equal(dialogs.length,1);flatten(host.content).find(n=>n.className==='report-back').action();
  pending.resolve({report:report('case')});await loading;
  assert.equal(host.content.children.length,1);assert.equal(host.content.children[0].textContent,'原记录列表');
});
test('离开工单后迟到的读取不会把手机页面滚回审核区',async()=>{
  const source=await readFile(new URL('../src/client/desk.txt',import.meta.url),'utf8');
  const ast=ts.createSourceFile('desk.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='openReportReview');
  const response=defer(),nodes=new Map();let scrolls=0;
  const context={activeReportId:null,selected:null,threadViewVersion:0,readonly:false,shown:'',thread:node(),reply:node(),
    showPane(){},TangbaoReports:{adminReview:()=>response.promise},openSlip(){},window:{matchMedia:()=>({matches:true})},
    $(selector){if(!nodes.has(selector))nodes.set(selector,{...node(),scrollIntoView(){scrolls++;}});return nodes.get(selector);}};
  new Script(fn.getText(ast)).runInNewContext(context);
  const loading=context.openReportReview('case');context.activeReportId=null;context.threadViewVersion++;
  response.resolve();await loading;assert.equal(scrolls,0);
});
test('分类未选不能提交；只选择分类即可提交空原因，长原因不裁剪',async()=>{
  const {context:c,dialogs,flatten}=setup(['openSubmit']),writes=[];
  c.request=async(path,data)=>{writes.push(data);return{report:{status:'pending'}};};
  await c.openSubmit({id:'message',reportLabel:'对方'});
  let controls=flatten(dialogs[0].content),select=controls.find(n=>n.tag==='select'),submit=controls.find(n=>n.textContent==='提交举报');
  await submit.action();assert.equal(writes.length,0);
  select.value='other';await submit.action();assert.equal(writes[0].reason,'');assert.equal(writes[0].typeCode,'other');
  await c.openSubmit({id:'another',reportLabel:'对方'});controls=flatten(dialogs[1].content);
  controls.find(n=>n.tag==='select').value='other';controls.find(n=>n.tag==='textarea').value='长内容😀'.repeat(3000);
  await controls.find(n=>n.textContent==='提交举报').action();assert.equal(writes[1].reason,'长内容😀'.repeat(3000));
});
test('匿名状态不会打开举报弹窗，即使旧消息对象带可举报标记',async()=>{
  const {context:c,dialogs}=setup(['openSubmit','attachMessage']);c.window.TangbaoAccount.account=null;
  await c.openSubmit({id:'stale',canReport:true});c.attachMessage(node(),{id:'stale',canReport:true});assert.equal(dialogs.length,0);
});
