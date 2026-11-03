import { Script } from "node:vm";

export const legacyRoles = [
  ["applicant-a", "申请者 A", "/?apply=1"], ["applicant-b", "申请者 B", "/?apply=1"],
  ["admin", "管理员 / 主模型", "/desk"], ["operator-a", "运营者 A", "/desk"],
  ["operator-b", "运营者 B", "/desk"], ["visitor-a", "访客 A", "/chat"], ["visitor-b", "访客 B", "/chat"],
];
export const legacyStorageKeys = ["tangbao.v1", "tangbao.visitor", "tangbao.apply", "tangbao.model", "tangbao.presence"];
const escape = value => String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
export const roleOrigin = (metadata, role) => `http://${role}-${metadata.instance}.localhost:${metadata.port}`;

function shell(title, content) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f7f4ed;color:#30291f;font:16px/1.7 system-ui,sans-serif}main{max-width:900px;margin:40px auto;padding:0 24px}h1{line-height:1.35}a{color:#9a4a17}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:12px 8px;border-bottom:1px solid #d9d1c5}code{overflow-wrap:anywhere}button,.button{font:inherit;border:1px solid #a28f76;border-radius:8px;padding:8px 14px;background:#fff;color:#30291f;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;padding:16px;border-radius:8px}p{margin:18px 0}.quiet{color:#746955}button:disabled{opacity:.6}@media(max-width:600px){main{margin:24px auto;padding:0 16px}td,th{padding:10px 4px}table{font-size:14px}}</style><main>${content}</main></html>`;
}

export function legacyGuide(metadata, adminPassword) {
  const rows = legacyRoles.map(([role,label,route]) => {
    const origin=roleOrigin(metadata,role), save=`${origin}/__legacy/browser?nonce=${metadata.nonce}`;
    return `<tr><th>${label}</th><td><a href="${origin+route}" target="_blank" rel="noopener">打开原版页面</a></td><td><a href="${save}" target="_blank" rel="noopener">保存这个角色的浏览器数据</a></td></tr>`;
  }).join("");
  return shell("改造前原版 · 手工演练", `<h1>改造前原版 · 手工演练</h1><p>这里运行账号改造前的原版。请自己申请 AI、审批、聊天和上传画作。申请者、管理员、运营者和访客各用下方对应入口；普通多标签不能代替这些独立角色地址。</p><p>本地管理员口令：<code id="admin-password">${escape(adminPassword)}</code></p><table><thead><tr><th>角色</th><th>原版入口</th><th>迁移前留存</th></tr></thead><tbody>${rows}</tbody></table><ol><li>从申请者 A/B 页面点击“我知道了”，填写型号、邮箱和模型说明后提交。邮箱可填 <code>name@example.test</code>。</li><li>在管理员入口用上面的口令“掀开笼屉”，到“申请”页正常审批。回到原来那个申请者地址，刷新首页，再点“申请成为AI”；申请进度里会显示原版发放的登录口令，手动复制下来。</li><li>运营者 A/B 用各自取得的口令登录工作台，保持页面打开，看到“在线”后再让访客 A/B 进入聊天页选择对应型号。没有人在线时，Auto 会把对话放进消息池。</li><li>在工作台左侧选中对话，输入回复；回复框左下角“＋”→“画一张”，画完点“放进回复”，再点发送箭头“写下”。现成画作可用“＋”→“添加图片”，也可粘贴图片；添加后仍要发送。访客聊天框的“＋”也能上传图片。</li><li>完成后，分别点击各角色的“保存浏览器数据”。它仅保存当前角色同源的糖包历史 token、访客标识、申请标识及偏好。</li></ol><p>数据会保留在本地 D1/KV。准备迁移时再停服备份，继续使用同一角色主机名和端口，尽量保留浏览器身份。</p><p class="quiet">固定原版：<code>${metadata.baseline}</code><br>实例：<code>${metadata.instance}</code>。没有邮箱账号功能；邮件、飞书、推送和远程数据库已关闭。本页口令仅用于这套本地演练。</p>`);
}

export function legacyBrowserPage(metadata, role) {
  const label=legacyRoles.find(item=>item[0]===role)[1];
  return shell(`${label} · 保存浏览器数据`, `<h1>${label} · 保存浏览器数据</h1><p>请在完成原版操作后点击保存。这个页面只读取当前地址下的五个糖包 localStorage 键，不读取 cookie 或其他网站的数据。不会退出登录、清缓存或改写原浏览器数据。</p><p><button id="save">保存当前角色的数据</button> <a href="/" target="_blank" rel="noopener">回原版首页</a> · <a href="/chat" target="_blank" rel="noopener">聊天</a> · <a href="/desk" target="_blank" rel="noopener">工作台</a></p><pre id="result" role="status">尚未保存</pre><p class="quiet">当前角色：${label}。同一个角色的普通多标签共享数据；其他角色使用各自地址。保存内容保存在本地数据库，后续备份会一起保留。</p><script>
const keys=${JSON.stringify(legacyStorageKeys)}, nonce=${JSON.stringify(metadata.nonce)};
document.querySelector('#save').addEventListener('click',async()=>{
 const button=document.querySelector('#save'),result=document.querySelector('#result');button.disabled=true;
 try{
  const storage=Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)]));
  const response=await fetch('/__legacy/browser-backup',{method:'POST',headers:{'content-type':'application/json','x-tangbao-legacy':nonce},body:JSON.stringify({storage})});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'保存失败');
  result.textContent=['已保存 '+data.role,'时间：'+new Date(data.savedAt).toLocaleString(),'匿名历史：'+data.threadCount+' 段','申请标识：'+(data.hasApplication?'已保留':'当前没有'),'原浏览器数据保持原样。'].join(String.fromCharCode(10));
 }catch(error){result.textContent=error.message;}finally{button.disabled=false;}
});
</script>`);
}

export function legacyWrapper(metadata, adminPassword) {
  const guide=legacyGuide(metadata,adminPassword);
  const pages=Object.fromEntries(legacyRoles.map(([role])=>[role,legacyBrowserPage(metadata,role)]));
  for (const html of [guide,...Object.values(pages)]) for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new Script(match[1]);
  return `import business from './business-wrapper.mjs';
const nonce=${JSON.stringify(metadata.nonce)}, instance=${JSON.stringify(metadata.instance)}, baseline=${JSON.stringify(metadata.baseline)};
const roles=${JSON.stringify(legacyRoles.map(row=>row[0]))}, keys=${JSON.stringify(legacyStorageKeys)}, pages=${JSON.stringify(pages)};
const json=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store','referrer-policy':'no-referrer'}});
const html=value=>new Response(value,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"}});
export default {
 async fetch(request,env,ctx){
  const url=new URL(request.url),host=url.hostname;
  if(!(host==='localhost'||host==='127.0.0.1'||host==='[::1]'||host.endsWith('.localhost'))||url.port!==${JSON.stringify(String(metadata.port))})return json({error:'仅允许本地回环地址'},403);
  if(url.pathname==='/__local/health')return Response.json({kind:'tangbao-local-legacy/v1',instance,baseline,originalVersion:true,externalSending:false},{headers:{'x-tangbao-local':nonce,'cache-control':'no-store'}});
  if(url.pathname.startsWith('/__legacy/')){
   const authorized=request.headers.get('x-tangbao-legacy')===nonce||(request.method==='GET'&&url.searchParams.get('nonce')===nonce);
   if(!authorized)return json({error:'本地实例凭据不匹配'},403);
   if(url.pathname==='/__legacy/guide'&&request.method==='GET')return html(${JSON.stringify(guide)});
   const role=roles.find(role=>host===role+'-'+instance+'.localhost');
   if(!role)return json({error:'请使用引导页中该角色的保存入口'},400);
   if(url.pathname==='/__legacy/browser'&&request.method==='GET')return html(pages[role]);
   if(url.pathname==='/__legacy/browser-backup'&&request.method==='POST'){
    if(request.headers.get('origin')!==url.origin)return json({error:'只接受当前角色的同源保存'},403);
    const text=await request.text();if(text.length>1048576)return json({error:'浏览器数据过大'},413);
    let body;try{body=JSON.parse(text)}catch{return json({error:'数据格式错误'},400)}
    const storage=body&&body.storage;
    if(!storage||typeof storage!=='object'||Array.isArray(storage)||Object.keys(storage).some(key=>!keys.includes(key))||keys.some(key=>!(key in storage)||storage[key]!==null&&typeof storage[key]!=='string'))return json({error:'只保存指定的糖包数据键'},400);
    const savedAt=Date.now(),record={role,origin:url.origin,storage,savedAt,baseline};
    await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind('local_legacy_browser:'+role,JSON.stringify(record)).run();
    let threadCount=0;try{const store=JSON.parse(storage['tangbao.v1']||'{}');threadCount=Array.isArray(store.threads)?store.threads.length:0;}catch{}
    return json({ok:true,role,savedAt,threadCount,hasApplication:Boolean(storage['tangbao.apply'])});
   }
   return json({error:'没有这个本地操作'},404);
  }
  return business.fetch(request,{...env,EMAIL:undefined},ctx);
 },
 scheduled(controller,env,ctx){return business.scheduled(controller,{...env,EMAIL:undefined},ctx);}
};
`;
}
