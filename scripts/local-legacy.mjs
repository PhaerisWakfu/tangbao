import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, symlink, copyFile, cp, readdir } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { legacyRoles, roleOrigin, legacyWrapper } from "./local-legacy-ui.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const baseline="633893951f5249673a07353b37b05685af841a45";
const kind="tangbao-local-legacy-instance/v1";
const [command,...argv]=process.argv.slice(2),options={};
if(!["prepare","dev","info","backup"].includes(command))throw new Error("用法：local-legacy.mjs prepare|dev|info|backup [--instance manual-legacy] [--port 8900] [--inspector-port 8901]");
for(let i=0;i<argv.length;i+=2){const key=argv[i];if(!["--instance","--port","--inspector-port"].includes(key)||!argv[i+1]||options[key])throw new Error("只接受不重复的 --instance / --port / --inspector-port；不接受远程目标或Wrangler透传参数。");options[key]=argv[i+1];}
if(command!=="prepare"&&(options["--port"]||options["--inspector-port"]))throw new Error("端口仅供 prepare 设置；其他命令复用原实例地址。");
const instance=options["--instance"]||"manual-legacy";
if(!/^[a-z][a-z0-9-]{0,39}$/.test(instance))throw new Error("instance需为1–40位小写字母、数字、短横线，并以字母开头。");
const directory=path.join(root,".tmp/local-legacy",instance),source=path.join(directory,"source");
const native=path.join(source,".tmp/local-sandboxes",instance),config=path.join(native,"wrangler.json"),state=path.join(native,"state");
const metadataFile=path.join(directory,"legacy.json"),wrangler=path.join(root,"node_modules/wrangler/bin/wrangler.js");
const digest=value=>createHash("sha256").update(value).digest("hex");
function env(){const value={CI:"1",WRANGLER_SEND_METRICS:"false",CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:"false",CLOUDFLARE_INCLUDE_PROCESS_ENV:"false"};for(const key of ["PATH","HOME","USERPROFILE","SYSTEMROOT","SystemRoot","COMSPEC","ComSpec","PATHEXT","LANG","LC_ALL","TMPDIR","TEMP","TMP"])if(process.env[key])value[key]=process.env[key];return value;}
async function run(binary,args,{cwd=directory,log,inherit=false}={}){
 const child=spawn(binary,args,{cwd,env:env(),stdio:inherit?["ignore","inherit","inherit"]:["ignore","pipe","pipe"]});let stdout="",stderr="";
 if(!inherit){child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",x=>stdout+=x);child.stderr.on("data",x=>stderr+=x);}
 const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve)});
 if(log)await writeFile(log,stdout+"\n"+stderr,{mode:0o600,flag:"wx"});
 if(code!==0)throw new Error(`本地命令失败（${code}）${log?`；详情保留在 ${log}`:stderr.slice(-1000)}`);
 return stdout;
}
async function db(sql,{targetConfig=config,persist=state,cwd=native}={}){
 return JSON.parse(await run(process.execPath,[wrangler,"d1","execute","DB","--local","--config",targetConfig,"--persist-to",persist,"--command",sql,"--json"],{cwd})).flatMap(entry=>entry.results||[]);
}
async function verifySource(metadata){for(const [name,expected]of Object.entries(metadata.sourceHashes)){if(digest(await readFile(path.join(source,name)))!==expected)throw new Error(`冻结原版文件已变化：${name}；不覆盖，也不继续启动。`);}}
async function load(){const metadata=JSON.parse(await readFile(metadataFile,"utf8"));if(metadata.kind!==kind||metadata.instance!==instance||metadata.baseline!==baseline||!metadata.ready||!/^[a-f0-9]{48}$/.test(metadata.nonce))throw new Error("原版实例标记不完整；保留失败证据并换新名称。");await verifySource(metadata);return metadata;}
function port(value){const number=Number(value);if(!Number.isInteger(number)||number<1024||number>65535)throw new Error("端口必须为1024–65535整数。");return number;}
async function counts(target={}){const names=new Set((await db("SELECT name FROM sqlite_schema WHERE type='table'",target)).map(row=>row.name));const result={accountsTable:names.has("accounts")};for(const name of ["operators","applications","threads","messages","message_images"])result[name]=(await db(`SELECT COUNT(*) AS n FROM ${name}`,target))[0].n;return result;}
function info(metadata){console.log(`原版：${baseline}\n实例：${instance}\n数据目录：${directory}\nD1/KV：${state}\n引导：http://127.0.0.1:${metadata.port}/__legacy/guide?nonce=${metadata.nonce}`);for(const [role,label,route]of legacyRoles)console.log(`${label}：${roleOrigin(metadata,role)+route}\n保存浏览器数据：${roleOrigin(metadata,role)}/__legacy/browser?nonce=${metadata.nonce}`);}

async function prepare(){
 if(existsSync(directory)){const metadata=await load();for(const [key,name]of [["--port","port"],["--inspector-port","inspectorPort"]])if(options[key]&&port(options[key])!==metadata[name])throw new Error("已有实例端口不同；不改原数据或地址。");info(metadata);return;}
 if(!existsSync(wrangler))throw new Error("请先在当前checkout运行npm ci。");
 const http=port(options["--port"]||8900),inspector=port(options["--inspector-port"]||http+1);if(http===inspector)throw new Error("HTTP和inspector端口不能相同。");
 await mkdir(directory,{recursive:true,mode:0o700});await mkdir(source,{mode:0o700});
 const archive=path.join(directory,"original-source.tar");await run("git",["archive","--format=tar","--output",archive,baseline],{cwd:root});await run("tar",["-xf",archive,"-C",source]);
 const files=(await run("git",["ls-tree","-r","--name-only",baseline],{cwd:root})).trim().split("\n");const sourceHashes={};for(const name of files)sourceHashes[name]=digest(await readFile(path.join(source,name)));
 await symlink(path.join(root,"node_modules"),path.join(source,"node_modules"),"dir");
 await run(process.execPath,[path.join(source,"scripts/local-sandbox.mjs"),"prepare","--instance",instance,"--port",String(http),"--inspector-port",String(inspector)],{cwd:source,log:path.join(directory,"prepare-original.log")});
 const old=JSON.parse(await readFile(path.join(native,"instance.json"),"utf8"));
 // The original harness wrote literal backslash-n separators; normalize only its
 // freshly generated local secret file, without modifying frozen source.
 const varsFile=path.join(native,".dev.vars"),raw=await readFile(varsFile,"utf8");const vars=raw.replaceAll("\\n","\n");if(vars!==raw)await writeFile(varsFile,vars,{mode:0o600});
 const adminPassword=vars.match(/^ADMIN_PASSWORD=(.+)$/m)?.[1];if(!adminPassword||!vars.match(/^ADMIN_SECRET=.+$/m))throw new Error("原版本地随机凭据缺失。");
 const metadata={kind,instance,baseline,nonce:old.nonce,port:http,inspectorPort:inspector,createdAt:new Date().toISOString(),sourceHashes,archiveSHA256:digest(await readFile(archive)),adminPassword,ready:false};
 await writeFile(metadataFile,JSON.stringify(metadata,null,2),{mode:0o600,flag:"wx"});
 await copyFile(path.join(native,"worker.mjs"),path.join(native,"business-wrapper.mjs"));await writeFile(path.join(native,"worker.mjs"),legacyWrapper(metadata,adminPassword),{mode:0o600});
 const applied=await db("SELECT name FROM d1_migrations ORDER BY name");if(applied.length!==20||applied.some(row=>row.name>="0021"))throw new Error("原版必须严格保持前20份迁移。");
 metadata.initialCounts=await counts();if(metadata.initialCounts.accountsTable||Object.entries(metadata.initialCounts).some(([key,value])=>key!=="accountsTable"&&value!==0))throw new Error("手工原版实例必须为空白业务数据。");
 metadata.ready=true;await writeFile(metadataFile,JSON.stringify(metadata,null,2),{mode:0o600});await verifySource(metadata);info(metadata);
}

async function listening(http){return new Promise(resolve=>{const socket=net.connect({host:"127.0.0.1",port:http});socket.setTimeout(1000);socket.once("connect",()=>{socket.destroy();resolve(true)});socket.once("error",()=>resolve(false));socket.once("timeout",()=>{socket.destroy();resolve(true)});});}
async function backup(metadata){
 if(await listening(metadata.port))throw new Error("请先停止这个实例的 local:legacy:dev，再执行backup；工具不自动停服或复制正在变化的D1/KV。");
 const stamp=new Date().toISOString().replaceAll(":","-")+"-"+randomBytes(3).toString("hex"),destination=path.join(directory,"backups",stamp);await mkdir(destination,{recursive:true,mode:0o700});
 const report={kind:"tangbao-legacy-backup/v1",status:"started",instance,baseline,production:false,remote:false,kvCopied:true,createdAt:new Date().toISOString()};
 const record=()=>writeFile(path.join(destination,"backup.json"),JSON.stringify(report,null,2),{mode:0o600});await record();
 try{
  await cp(state,path.join(destination,"state"),{recursive:true,errorOnExist:true,force:false});
  await copyFile(path.join(native,".dev.vars"),path.join(destination,".dev.vars"));await copyFile(metadataFile,path.join(destination,"legacy.json"));
  const exportDir=path.join(destination,"export");await mkdir(exportDir,{mode:0o700});await cp(path.join(destination,"state"),path.join(exportDir,".wrangler/state"),{recursive:true,errorOnExist:true,force:false});
  const exportConfig=path.join(exportDir,"wrangler.json"),original=JSON.parse(await readFile(config,"utf8"));await writeFile(exportConfig,JSON.stringify({name:"tangbao-legacy-local-export",main:"worker.mjs",compatibility_date:original.compatibility_date,d1_databases:original.d1_databases},null,2),{mode:0o600});await writeFile(path.join(exportDir,"worker.mjs"),"export default {};\n",{mode:0o600});
  const snapshot=path.join(destination,"database.sql");await run(process.execPath,[wrangler,"d1","export","DB","--local","--config",exportConfig,"--output",snapshot],{cwd:exportDir,log:path.join(destination,"export.log")});
  const target={targetConfig:exportConfig,persist:path.join(exportDir,".wrangler/state"),cwd:exportDir};
  const migrations=await db("SELECT name FROM d1_migrations ORDER BY name",target);await writeFile(path.join(destination,"migrations.json"),JSON.stringify(migrations.map(row=>row.name),null,2),{mode:0o600});
  const browsers=await db("SELECT key,value FROM settings WHERE key LIKE 'local_legacy_browser:%' ORDER BY key",target);await writeFile(path.join(destination,"browser-data.json"),JSON.stringify(browsers.map(row=>({key:row.key,...JSON.parse(row.value)})),null,2),{mode:0o600});
  report.counts=await counts(target);report.browserCopies=browsers.length;report.migrations=migrations.length;report.sourceSHA256=digest(await readFile(snapshot));report.roles=legacyRoles.map(([role,label,route])=>({role,label,origin:roleOrigin(metadata,role),route}));
  const stateHashes={};async function walk(dir,relative=""){for(const entry of await readdir(dir,{withFileTypes:true})){const name=path.join(relative,entry.name),file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file,name);else if(entry.isFile())stateHashes[name]=digest(await readFile(file));}}
  await walk(path.join(destination,"state"));await writeFile(path.join(destination,"state-manifest.json"),JSON.stringify(stateHashes,null,2),{mode:0o600});
  report.status="complete";report.finishedAt=new Date().toISOString();await record();console.log(`本地原版数据备份完成：${destination}\nSQL、20份迁移清单、完整D1/KV、角色浏览器数据和仅本地凭据已保留；原实例未修改。`);
 }catch(error){report.status="failed";report.reason=error.message;await record();throw error;}
}

if(command==="prepare")await prepare();
else {const metadata=await load();if(command==="info")info(metadata);else if(command==="backup")await backup(metadata);else {
 info(metadata);await writeFile(path.join(native,"worker.mjs"),legacyWrapper(metadata,metadata.adminPassword),{mode:0o600});const child=spawn(process.execPath,[wrangler,"dev","--local","--config",config,"--ip","127.0.0.1","--port",String(metadata.port),"--inspector-port",String(metadata.inspectorPort),"--persist-to",state,"--show-interactive-dev-session=false","--test-scheduled"],{cwd:native,env:env(),stdio:["ignore","inherit","inherit"]});
 let stopping=false;for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{stopping=true;child.kill(signal)});const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve)});if(code!==0&&!stopping)throw new Error(`原版本地服务退出：${code}`);
}}
