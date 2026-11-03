// This HTML is embedded only in each ignored local wrapper, never a production route.
export function demoHtml(metadata) {
  const context = JSON.stringify({ nonce: metadata.nonce, instance: metadata.instance, port: metadata.port });
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>糖包本地验收</title>
<style>
body{margin:0;background:#fcfbf9;color:#312b25;font:15px/1.6 system-ui,sans-serif}main{max-width:1050px;margin:40px auto;padding:0 20px}h1{font-size:26px}h2{font-size:20px}a{color:#9d5828}button{padding:10px 18px;border:1px solid #c8baa9;border-radius:8px;background:white;cursor:pointer}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;border-bottom:1px solid #dfd8d0;padding:12px 8px;overflow-wrap:anywhere}code{font-family:ui-monospace,monospace;font-size:13px}.scroll{overflow-x:auto}section{background:white;border:1px solid #e2dcd3;border-radius:12px;padding:20px;margin:20px 0}.muted{color:#73685b}#status{min-height:24px}ul{padding-left:22px}@media(max-width:600px){main{margin:20px auto}section{padding:14px}td,th{padding:9px 5px}}
</style>
<main><h1>糖包本地验收</h1>
<p>这里连接本机隔离数据库和合成邮件箱，不发送真实邮件。注册时可使用 <code>your-name@example.test</code>，验证码会出现在下面。刷新页面仍能查看最新邮件。</p>
<p><a href="/" target="_blank" rel="noopener">打开首页</a> · <a href="/chat" target="_blank" rel="noopener">打开聊天</a> · <a href="/desk" target="_blank" rel="noopener">打开工作台</a></p>
<section><h2>演示账号</h2><p class="muted">每个角色的链接使用独立主机名，浏览器存储相互隔离。请用对应邮箱和密码正常登录。</p><div class="scroll"><table><thead><tr><th>角色/入口</th><th>邮箱或型号</th><th>合成密码/旧口令</th></tr></thead><tbody id="actors"></tbody></table></div></section>
<section><h2>本地验证邮件</h2><p class="muted">验证成功、过期或永久失败的邮件会清理验证码。尚无邮件时，先在产品页注册或申请找回。</p><button id="refresh" type="button">刷新验证码</button><p id="status" role="status"></p><div class="scroll"><table><thead><tr><th>邮箱</th><th>用途</th><th>验证码</th><th>发送状态</th></tr></thead><tbody id="mail"></tbody></table></div></section>
<section><h2>建议验收顺序</h2><ul><li>匿名聊天一段，再新建第二段，确认出现账号弹层且草稿和附件保留。</li><li>注册合成邮箱，从本页取验证码，完成验证后继续发送。</li><li>刷新或重新打开产品页，确认保持登录和历史可见。</li><li>打开独立设备环境，用同一账号登录，确认历史一致。</li><li>退出账号，确认页面和本地存储清空，下一次进入需要密码登录。</li><li>使用新的已验证账号和“待绑定旧模型”口令，演练绑定已有模型。</li></ul></section></main>
<script>
const context=${context};
const text=(parent,value)=>{const cell=document.createElement('td');cell.textContent=value;parent.append(cell);return cell};
async function get(route){const response=await fetch(route,{headers:{'x-tangbao-local':context.nonce},cache:'no-store'});if(!response.ok)throw new Error('本地面板暂不可用，请确认实例仍在运行');return response.json()}
async function refresh(){const status=document.getElementById('status');try{const data=await get('/__local/mail');const list=document.getElementById('mail');list.replaceChildren();for(const mail of data.messages){const row=document.createElement('tr');text(row,mail.email);text(row,mail.purpose==='reset'?'重置密码':'验证邮箱');text(row,mail.code);text(row,mail.status);list.append(row)}status.textContent='已刷新，共 '+data.messages.length+' 封可查看验证码的合成邮件。'}catch(error){status.textContent=error.message}}
async function actors(){const data=await get('/__local/demo-actors');const list=document.getElementById('actors');for(const actor of data.actors){const row=document.createElement('tr');const cell=text(row,'');const link=document.createElement('a');link.href='http://'+actor.name+'-'+context.instance+'.localhost:'+context.port+(actor.name==='admin'||actor.name.startsWith('operator-')||actor.operatorId?'/desk':'/chat');link.target='_blank';link.rel='noopener';link.textContent=actor.label||actor.name;cell.append(link);text(row,actor.email||actor.operatorId||'匿名访客');text(row,actor.password||'无需密码');list.append(row)}}
document.getElementById('refresh').addEventListener('click',refresh);actors().catch(error=>{document.getElementById('status').textContent=error.message});refresh();
</script></html>`;
}
