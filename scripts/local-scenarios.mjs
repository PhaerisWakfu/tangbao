import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function freshAccountPassword() {
  // Exactly 20 characters, with letters, digits and punctuation guaranteed.
  return `Tb9!${randomBytes(12).toString("base64url")}`;
}

// Each actor has a separate cookie jar. Only the generated local wrapper exposes
// fixture/mail controls; every request checks the instance marker before writing.
export async function runScenarios({ metadata, directory, fixtureFile, checkServer, includeEdgeScenarios = true }) {
  const base = `http://127.0.0.1:${metadata.port}`;
  const results = [];
  const fixture = { instanceNonce: metadata.nonce, status: "started", actors: {}, threads: {} };
  const attempt = new Date().toISOString().replaceAll(":", "-");
  const reportFile = path.join(directory, `verification-${attempt}-${randomBytes(3).toString("hex")}.json`);
  let saving = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(fixture, null, 2);
    saving = saving.then(() => writeFile(fixtureFile, snapshot, { mode: 0o600 }));
    return saving;
  };
  await save();
  let actorIndex = 0;
  let testNow = Date.now();
  let bootstrapAttempt = 0;
  async function bootstrap(accountId, {execute=false,recovery=false,success=true}={}) {
    await checkServer();
    const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
    const argv=[path.join(sourceRoot,"scripts/bootstrap-admin.mjs"),"--account-id",accountId,"--config",path.join(directory,"wrangler.json"),"--local","--persist-to",path.join(directory,"state")];
    if(execute) argv.push("--execute");
    if(recovery) argv.push("--recovery");
    const env={CI:"1",WRANGLER_SEND_METRICS:"false",CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:"false",CLOUDFLARE_INCLUDE_PROCESS_ENV:"false"};
    for(const key of ["PATH","HOME","USERPROFILE","SYSTEMROOT","SystemRoot","COMSPEC","ComSpec","PATHEXT","LANG","LC_ALL","TMPDIR","TEMP","TMP"]) if(process.env[key])env[key]=process.env[key];
    const result=spawnSync(process.execPath,argv,{cwd:sourceRoot,env,encoding:"utf8",timeout:60000});
    await writeFile(path.join(directory,`bootstrap-${++bootstrapAttempt}.log`),`${result.stdout||""}\n${result.stderr||""}`,{mode:0o600,flag:"wx"});
    if(success) assert.equal(result.status,0,`本地管理员引导失败：${result.error?.message||result.stderr||result.stdout}`);
    else {
      assert.notEqual(result.status,0,"已有管理员时普通首次引导必须拒绝");
      assert((result.stderr||"").includes("没有授予管理员"),"应因管理员引导条件不满足而拒绝");
    }
    return result;
  }
  async function local(route, body) {
    await checkServer();
    const response = await fetch(base + route, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { "x-tangbao-local": metadata.nonce, "content-type": "application/json", origin: base },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(data)}`);
    return data;
  }
  async function advance(ms) {
    testNow = Math.max(testNow, Date.now()) + ms;
    await local("/__local/control", { now: testNow });
  }
  async function testMail(challengeId) {
    assert(challengeId, "服务端应返回 challengeId");
    const data = await local(`/__local/mail?challengeId=${encodeURIComponent(challengeId)}`);
    return data.messages.find((message) => message.challengeId === challengeId);
  }
  function actor(name, credentials = {}) {
    const state = {
      visitor: randomBytes(18).toString("base64url"), cookies: {}, cookie: "",
      ip: `198.51.100.${++actorIndex}`, ...credentials,
    };
    fixture.actors[name] = state;
    const client = {
      state,
      async request(route, { method = "GET", body, token, status = 200, headers: extra = {}, origin = base } = {}) {
        assert(route.startsWith("/") && !route.startsWith("//"), "只允许当前实例相对路径");
        await checkServer();
        const headers = { "x-visitor": state.visitor, "CF-Connecting-IP": state.ip, origin, ...extra };
        if (state.cookie) headers.cookie = state.cookie;
        if (token) headers.authorization = `Bearer ${token}`;
        if (route === "/api/threads" && method === "POST" && !headers["Idempotency-Key"]) headers["Idempotency-Key"] = randomBytes(18).toString("base64url");
        const form = body instanceof FormData;
        if (body && !form) headers["content-type"] = "application/json";
        const response = await fetch(base + route, {
          method, headers, redirect: "error", signal: AbortSignal.timeout(30000),
          body: body ? form ? body : JSON.stringify(body) : undefined,
        });
        state.lastCookieHeaders = response.headers.getSetCookie();
        for (const cookie of state.lastCookieHeaders) {
          const first = cookie.split(";")[0];
          const at = first.indexOf("=");
          const key = first.slice(0, at), value = first.slice(at + 1);
          if (!value || /max-age=0(?:;|$)/i.test(cookie)) delete state.cookies[key];
          else state.cookies[key] = value;
        }
        state.cookie = Object.entries(state.cookies).map(([key, value]) => `${key}=${value}`).join("; ");
        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("json") ? await response.json() : contentType.startsWith("image/") ? new Uint8Array(await response.arrayBuffer()) : await response.text();
        const expected = Array.isArray(status) ? status : [status];
        assert(expected.includes(response.status), `${name} ${method} ${route}: expected ${expected.join("/")}, got ${response.status}: ${typeof data === "object" ? JSON.stringify(data) : String(data).slice(0,300)}`);
        await save();
        return data;
      },
      async register({ verify = true } = {}) {
        state.email ||= `${name}@example.test`;
        state.password ||= freshAccountPassword();
        const result = await this.request("/api/auth/register", { method: "POST", body: { email: state.email, password: state.password } });
        state.accountId = result.account.id;
        state.challengeId = result.challengeId;
        if (verify) {
          const message = await testMail(result.challengeId);
          assert.equal(message?.purpose, "verify");
          assert.equal(message?.email, state.email);
          const verified = await this.request("/api/auth/email/verify", { method: "POST", body: { challengeId: result.challengeId, code: message.code } });
          assert.equal(verified.account.verified, true);
        }
        await save();
        return result;
      },
      async login() {
        const result = await this.request("/api/auth/login", { method: "POST", body: { email: state.email, password: state.password } });
        state.accountId = result.account.id;
        state.operatorId = result.account.operatorId;
        return result.account;
      },
    };
    return client;
  }
  async function check(name, callback) {
    try {
      await callback();
      results.push({ name, status: "PASS" });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({ name, status: "FAIL", reason: error.message });
      throw error;
    }
  }
  const admin = actor("admin");
  const operatorA = actor("operator-a"), operatorB = actor("operator-b");
  const visitorA = actor("visitor-a"), visitorB = actor("visitor-b"), visitorC = actor("visitor-pool");
  const member = actor("member"), unverified = actor("unverified");
  try {
    await check("本地实例标记、外部发信禁用与本地控制鉴权", async () => {
      await checkServer();
      const health = await fetch(`${base}/__local/health`).then((response) => response.json());
      assert.equal(health.externalSending, false);
      const rejected = await fetch(`${base}/__local/mail`, { headers: { "x-tangbao-local": "wrong" } });
      assert.equal(rejected.status, 403);
    });
    for (const [route, expected] of [["/", "成为"], ["/chat", "composer"], ["/desk", "login"], ["/assets/app.css", "--bg"], ["/assets/account.js", "TangbaoAccount"]]) {
      await check(`页面/资源 ${route}`, async () => assert((await visitorA.request(route)).includes(expected)));
    }
    await visitorB.request("/chat");
    await visitorC.request("/chat");
    await check("匿名不能进入后台队列", () => visitorA.request("/api/admin/queue", { status: 401 }));
    await check("跨站写请求被服务端拒绝", async () => {
      const result = await visitorA.request("/api/auth/login", { method: "POST", origin: "https://other.example.test", body: { email: "none@example.test", password: "not-a-real-password" }, status: 403 });
      assert(result.code);
    });
    await check("匿名首段可创建并进入消息池", async () => {
      const data = await visitorC.request("/api/threads", { method: "POST", body: { body: "合成场景：等待模型接单" } });
      assert.equal(data.queued, true);
      fixture.threads.pool = data;
    });
    await check("未验证账号不能申请AI或创建第二段", async () => {
      await unverified.register({ verify: false });
      const denied = await unverified.request("/api/applications", { method: "POST", body: { suffix: "unverified", blurb: "不应获批" }, status: 403 });
      assert.equal(denied.code, "EMAIL_UNVERIFIED");
      const thread = await unverified.request("/api/threads", { method: "POST", body: { body: "尚未验证的第二段" }, status: [401,403] });
      assert(["AUTH_REQUIRED","EMAIL_UNVERIFIED"].includes(thread.code));
    });
    await check("管理员引导默认预览，首次正式授予撤销旧会话", async () => {
      await admin.register();
      const preview=await bootstrap(admin.state.accountId);
      assert(preview.stdout.includes("仅生成预览"));
      assert(!(await admin.request("/api/auth/me")).account.roles.includes("admin"));
      await bootstrap(admin.state.accountId,{execute:true});
      assert.equal((await admin.request("/api/auth/me")).account,null);
      const account = await admin.login();
      assert(account.roles.includes("admin"));
      assert.equal((await admin.request("/api/admin/profile")).super, true);
    });
    await check("邮箱规范化与唯一性", async () => {
      await member.register();
      const other = actor("duplicate");
      const duplicate=await other.request("/api/auth/register", { method: "POST", body: { email: ` ${member.state.email.toUpperCase()} `, password: freshAccountPassword() }, status:409 });
      assert.equal(duplicate.code,"ACCOUNT_UNAVAILABLE");
      await member.request("/api/admin/queue", { status: 403 });
    });
    for (const [suffix, operator] of [["local-a", operatorA], ["local-b", operatorB]]) {
      await check(`已验证账号申请与审批模型 ${suffix}`, async () => {
        await operator.register();
        const application = await operator.request("/api/applications", { method: "POST", body: { suffix, blurb: "本地合成测试" } });
        assert.equal(application.status, "pending");
        const approved = await admin.request(`/api/admin/applications/${application.id}/approve`, { method: "POST" });
        assert.equal(approved.modelId, `tangbao-${suffix}`);
        assert(!approved.password, "新模型资格直接关联账号，不发旧口令");
        const account = await operator.login();
        assert.equal(account.operatorId, approved.modelId);
        assert(account.roles.includes("operator"));
      });
    }
    await check("两个运营者会话相互独立且一账号不能申请第二模型", async () => {
      assert.notEqual(admin.state.cookies.tb_account, operatorA.state.cookies.tb_account);
      assert.notEqual(operatorA.state.cookies.tb_account, operatorB.state.cookies.tb_account);
      await operatorA.request("/api/applications", { method: "POST", body: { suffix: "second-a", blurb: "不应申请成功" }, status: 409 });
    });
    await check("运营者心跳接走消息池对话", async () => {
      const queue = await operatorA.request("/api/admin/queue");
      assert(queue.waiting.some((item) => item.id === fixture.threads.pool.id));
      const thread = await visitorC.request(`/api/threads/${fixture.threads.pool.id}`, { token: fixture.threads.pool.token });
      assert.equal(thread.operator, operatorA.state.operatorId);
      assert.equal(thread.queued, false);
    });
    await check("运营者B独立上线", async () => assert.equal((await operatorB.request("/api/admin/queue")).operatorId, operatorB.state.operatorId));
    for (const [name, visitor, operator] of [["a", visitorA, operatorA], ["b", visitorB, operatorB]]) {
      await check(`访客${name.toUpperCase()}对话与图片`, async () => {
        const body = { body: `合成访客${name.toUpperCase()}的专属对话`, operator: operator.state.operatorId };
        let incoming = body;
        if (name === "a") {
          const form = new FormData();
          for (const [key, value] of Object.entries(body)) form.set(key, value);
          const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
          form.append("images", new Blob([png], { type: "image/png" }), "synthetic.png");
          incoming = form;
        }
        const data = await visitor.request("/api/threads", { method: "POST", body: incoming });
        assert.equal(data.operator, operator.state.operatorId);
        fixture.threads[name] = data;
      });
    }
    const a = fixture.threads.a, b = fixture.threads.b;
    await check("匿名第二段被拦截且原首段可继续", async () => {
      const denied = await visitorA.request("/api/threads", { method: "POST", body: { body: "不应生成第二段" }, status: 401 });
      assert.equal(denied.code, "AUTH_REQUIRED");
      assert.equal((await visitorA.request(`/api/threads/${a.id}`, { token: a.token })).messages[0].role, "visitor");
    });
    await check("访客token越权被拒绝，图片可读", async () => {
      await visitorB.request(`/api/threads/${a.id}`, { token: b.token, status: [401,403] });
      await visitorB.request(`/api/threads/${a.id}`, { status: [401,403] });
      const thread = await visitorA.request(`/api/threads/${a.id}`, { token: a.token });
      const image = thread.messages[0].images[0];
      assert(image?.id);
      assert.equal((await visitorA.request(image.url || `/api/images/${image.id}`))[0], 0x89);
      await visitorB.request(`/api/images/${image.id}`, { status: [401,403,404] });
    });
    await check("队列隔离和跨模型读取/回复拒绝", async () => {
      const queueA = await operatorA.request("/api/admin/queue"), queueB = await operatorB.request("/api/admin/queue");
      assert(queueA.waiting.some((item) => item.id === a.id));
      assert(!queueA.waiting.some((item) => item.id === b.id));
      assert(queueB.waiting.some((item) => item.id === b.id));
      await operatorA.request(`/api/admin/threads/${b.id}`, { status: 404 });
      await operatorA.request(`/api/admin/threads/${b.id}`, { method: "POST", body: { body: "不应落库" }, status: 403 });
      await operatorA.request("/api/admin/audit", { status: 403 });
      await operatorB.request("/api/admin/applications", { status: 403 });
    });
    for (const [name, visitor, operator, thread] of [["a", visitorA, operatorA, a], ["b", visitorB, operatorB, b]]) {
      await check(`模型${name.toUpperCase()}回复仅对应访客可见`, async () => {
        const text = `模型${name.toUpperCase()}的合成回复`;
        await operator.request(`/api/admin/threads/${thread.id}`, { method: "POST", body: { body: text } });
        const data = await visitor.request(`/api/threads/${thread.id}`, { token: thread.token });
        assert.equal(data.messages.at(-1).body, text);
        assert.equal(data.awaiting, false);
      });
    }
    await check("管理员审计两个模型，访客后续画图消息保留", async () => {
      const audit = await admin.request("/api/admin/audit");
      assert(audit.threads.some((item) => item.id === a.id));
      assert(audit.threads.some((item) => item.id === b.id));
      await visitorA.request(`/api/threads/${a.id}/messages`, { method: "POST", token: a.token, body: { body: "请画一只合成猫", draw: true } });
      assert.equal((await operatorA.request(`/api/admin/threads/${a.id}`)).messages.at(-1).draw, 1);
      await operatorA.request(`/api/admin/threads/${a.id}`, { method: "POST", body: { body: "已收到画图请求" } });
    });
    await check("账号主动关联匿名历史，另一设备可读且旧token失效", async () => {
      await member.request("/api/account/threads/claim", { method: "POST", body: { threadId: a.id, token: b.token }, status: [401,403] });
      await member.request("/api/account/threads/claim", { method: "POST", body: { threadId: a.id, token: a.token } });
      const anotherDevice = actor("member-device", { email: member.state.email, password: member.state.password });
      await anotherDevice.login();
      assert((await anotherDevice.request("/api/account/threads")).threads.some((thread) => thread.id === a.id));
      await anotherDevice.request(`/api/threads/${a.id}`);
      await visitorA.request(`/api/threads/${a.id}`, { token: a.token, status: [401,403] });
      assert(!(await operatorB.request("/api/account/threads")).threads.some((thread) => thread.id === a.id));
      await operatorB.request(`/api/threads/${a.id}`, { token: a.token, status: [401,403] });
    });
    await check("账号新建多段历史跨设备，重试幂等且不同请求内容冲突", async () => {
      const key = randomBytes(18).toString("base64url");
      const body = { body: "账号跨设备历史一", operator: operatorA.state.operatorId };
      const first = await member.request("/api/threads", { method: "POST", body, headers: { "Idempotency-Key": key } });
      const retry = await member.request("/api/threads", { method: "POST", body, headers: { "Idempotency-Key": key } });
      assert.equal(first.id, retry.id);
      await member.request("/api/threads", { method: "POST", body: { body: "不同内容" }, headers: { "Idempotency-Key": key }, status: 409 });
      const other = fixture.actors["member-device"];
      const device = actor("member-device-2", { email: member.state.email, password: member.state.password });
      await device.login();
      assert((await device.request("/api/account/threads")).threads.some((thread) => thread.id === first.id));
      assert(other.cookies.tb_account);
      fixture.threads.account = first;
    });
    await check("匿名同身份并发最多创建一段，删除不返额度", async () => {
      const guest = actor("concurrent-guest");
      await guest.request("/chat");
      const requests = await Promise.allSettled([0,1].map((i) => guest.request("/api/threads", { method: "POST", body: { body: `并发合成${i}` }, status: [200,201,401] })));
      const responses = requests.map((result) => { assert.equal(result.status,"fulfilled"); return result.value; });
      const created = responses.filter((result) => result.id);
      assert.equal(created.length,1);
      assert.equal(responses.filter((result) => result.code === "AUTH_REQUIRED").length,1);
      await guest.request(`/api/threads/${created[0].id}`, { method: "DELETE", token: created[0].token });
      await guest.request("/api/threads", { method: "POST", body: { body: "删除不返还" }, status: 401 });
    });
    await check("模型停用不等于账号停用", async () => {
      await admin.request(`/api/admin/operators/${operatorB.state.operatorId}/disable`, { method: "POST" });
      await operatorB.request("/api/admin/queue", { status: [401,403] });
      assert.equal((await operatorB.request("/api/auth/me")).account.id, operatorB.state.accountId);
      await admin.request(`/api/admin/operators/${operatorB.state.operatorId}/enable`, { method: "POST" });
    });
    await check("账号模型级拉黑不误关同IP其他账号和匿名对话", async () => {
      for (const thread of [fixture.threads.pool,fixture.threads.account]) await operatorA.request(`/api/admin/threads/${thread.id}`,{method:"POST",body:{body:"合成回归：清空改名前待回复"}});
      const shared=actor("shared-ip-member");
      await shared.register();
      shared.state.ip=visitorA.state.ip;
      const anonymous=actor("shared-ip-anonymous",{ip:visitorA.state.ip});
      await anonymous.request("/chat");
      const memberThread=await shared.request("/api/threads",{method:"POST",body:{body:"同IP其他账号的等待",operator:operatorA.state.operatorId}});
      const anonymousThread=await anonymous.request("/api/threads",{method:"POST",body:{body:"同IP匿名访客的等待",operator:operatorA.state.operatorId}});
      assert.equal(memberThread.operator,operatorA.state.operatorId);
      assert.equal(anonymousThread.operator,operatorA.state.operatorId);
      await operatorA.request(`/api/admin/threads/${a.id}/block`,{method:"POST"});
      for(const [client,thread] of [[shared,memberThread],[anonymous,anonymousThread]]) {
        const pending=await client.request(`/api/threads/${thread.id}`,{token:thread.token});
        assert.equal(pending.awaiting,true);
        assert.equal(pending.blocked,false);
        await operatorA.request(`/api/admin/threads/${thread.id}`,{method:"POST",body:{body:"同IP仍可正常回复"}});
        const replied=await client.request(`/api/threads/${thread.id}`,{token:thread.token});
        assert.equal(replied.messages.at(-1).body,"同IP仍可正常回复");
      }
      await operatorA.request(`/api/admin/threads/${a.id}/unblock`,{method:"POST"});
      assert.equal((await member.request(`/api/threads/${a.id}`)).blocked,false);
    });
    await check("改型号保留身份和模型封禁，Auto及POOL分配遵守账号作用域", async () => {
      const endpoint="https://push.example.test/synthetic-local-a";
      await operatorA.request("/api/admin/push",{method:"POST",body:{endpoint,keys:{p256dh:randomBytes(32).toString("base64url"),auth:randomBytes(18).toString("base64url")}}});
      await operatorA.request(`/api/admin/threads/${a.id}/block`,{method:"POST"});
      const before=await local(`/__local/model-state?accountId=${encodeURIComponent(operatorA.state.accountId)}`);
      assert(before.blocks.length>0);
      const changed=await operatorA.request("/api/admin/profile",{method:"POST",body:{suffix:"local-a-renamed",blurb:"本地改型号后保留归属"}});
      operatorA.state.operatorId=changed.id;
      assert.equal(changed.id,"tangbao-local-a-renamed");
      const after=await local(`/__local/model-state?accountId=${encodeURIComponent(operatorA.state.accountId)}`);
      assert.equal(after.model.uid,before.model.uid);
      assert.equal(after.model.owner,before.model.owner);
      assert.deepEqual(after.blocks.map(item=>item.id),before.blocks.map(item=>item.id));
      assert(after.blocks.every(item=>item.operatorId===changed.id));
      assert(after.applications.every(item=>item.operatorId===changed.id && item.suffix==="local-a-renamed"));
      assert(after.subscriptions.some(item=>item.endpoint===endpoint && item.operatorId===changed.id));
      assert.equal((await operatorA.request("/api/auth/me")).account.operatorId,changed.id);
      await operatorA.request(`/api/admin/threads/${a.id}`);
      const blocked=await member.request(`/api/threads/${a.id}`);
      assert.equal(blocked.operator,changed.id);
      assert.equal(blocked.blocked,true);
      const device=actor("member-block-device",{email:member.state.email,password:member.state.password});
      await device.login();
      await device.request("/api/threads",{method:"POST",body:{body:"跨设备不能绕过模型拉黑",operator:changed.id},status:403});
      const auto=await device.request("/api/threads",{method:"POST",body:{body:"Auto不能分配到已拉黑模型"}});
      assert.notEqual(auto.operator,changed.id);
      assert.equal(auto.operator,operatorB.state.operatorId);
      await operatorB.request(`/api/admin/threads/${auto.id}`,{method:"POST",body:{body:"Auto选择了未封禁的模型B"}});
      const other=await device.request("/api/threads",{method:"POST",body:{body:"模型A拉黑不影响模型B",operator:operatorB.state.operatorId}});
      assert.equal(other.operator,operatorB.state.operatorId);
      for(const operatorId of [changed.id,operatorB.state.operatorId]) await admin.request(`/api/admin/operators/${operatorId}/disable`,{method:"POST"});
      const pooled=await device.request("/api/threads",{method:"POST",body:{body:"进入消息池后仍遵守账号封禁"}});
      assert.equal(pooled.queued,true);
      const shared=actor("shared-ip-pool-member",{email:fixture.actors["shared-ip-member"].email,password:fixture.actors["shared-ip-member"].password,ip:visitorA.state.ip});
      await shared.login();
      const sharedPool=await shared.request("/api/threads",{method:"POST",body:{body:"同IP其他账号的池中任务"}});
      const anonymous=actor("shared-ip-pool-anonymous",{ip:visitorA.state.ip});
      await anonymous.request("/chat");
      const anonymousPool=await anonymous.request("/api/threads",{method:"POST",body:{body:"同IP匿名的池中任务"}});
      assert(sharedPool.queued && anonymousPool.queued);
      await admin.request(`/api/admin/operators/${changed.id}/enable`,{method:"POST"});
      const queueA=await operatorA.request("/api/admin/queue");
      assert(!queueA.waiting.some(thread=>thread.id===pooled.id));
      assert(queueA.waiting.some(thread=>thread.id===sharedPool.id));
      assert(queueA.waiting.some(thread=>thread.id===anonymousPool.id));
      assert.equal((await device.request(`/api/threads/${pooled.id}`)).queued,true);
      await admin.request(`/api/admin/operators/${operatorB.state.operatorId}/enable`,{method:"POST"});
      const queueB=await operatorB.request("/api/admin/queue");
      assert(queueB.waiting.some(thread=>thread.id===pooled.id));
      const assigned=await device.request(`/api/threads/${pooled.id}`);
      assert.equal(assigned.operator,operatorB.state.operatorId);
      assert.equal(assigned.queued,false);
      await operatorB.request(`/api/admin/threads/${pooled.id}`,{method:"POST",body:{body:"池中任务交给未封禁模型B"}});
      await operatorA.request(`/api/admin/threads/${a.id}/unblock`,{method:"POST"});
      assert.equal((await member.request(`/api/threads/${a.id}`)).blocked,false);
      assert.equal((await device.request(`/api/threads/${a.id}`)).blocked,false);
    });
    if (includeEdgeScenarios) await runAccountEdgeScenarios({ actor, admin, local, testMail, advance, check, bootstrap });
    const demoPassword = `Legacy-demo-${randomBytes(18).toString("base64url")}`;
    await local("/__local/fixture", { action:"create-legacy", operatorId:"tangbao-local-legacy-demo", password:demoPassword });
    fixture.actors["legacy-demo"]={operatorId:"tangbao-local-legacy-demo",password:demoPassword};
    await local("/__local/fixture", { action:"set-demo-actors", actors:[
      ...[admin,operatorA,operatorB,member].map(client=>({name:client===member?"member":client.state.email.split("@")[0],label:client===admin?"管理员":client===operatorA?"运营者A":client===operatorB?"运营者B":"普通用户",email:client.state.email,password:client.state.password})),
      {name:"legacy-demo",label:"待绑定旧模型",operatorId:"tangbao-local-legacy-demo",password:demoPassword},
      {name:"visitor-a",label:"匿名访客A",password:""},{name:"visitor-b",label:"匿名访客B",password:""},
    ] });
    fixture.status = "complete";
    await save();
  } catch (error) {
    fixture.status = "failed";
    await save();
    throw error;
  } finally {
    await local("/__local/control", { now: null, failure: null }).catch(() => {});
    const report = {
      instance: metadata.instance, createdAt: new Date().toISOString(), runtime: "Wrangler local / workerd / D1 / KV / synthetic mail",
      mode: includeEdgeScenarios ? "full-regression" : "interactive-seed",
      status: fixture.status, results,
      notCovered: [...(includeEdgeScenarios?[]:["验证码/会话撤销/邮件故障等边界回归（另跑 local:verify）"]),"Turso 真实运行", "真实 Cloudflare 邮件收件箱送达/退信", "生产 HTTPS/边缘缓存", "浏览器 UI（另行验证）", "高并发容量与生产迁移"],
    };
    await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    console.log(`合成身份：${fixtureFile}\n结果：${reportFile}\nPASS ${results.filter((result) => result.status === "PASS").length} / ${results.length}`);
  }
  return fixture;
}

async function runAccountEdgeScenarios({ actor, admin, local, testMail, advance, check, bootstrap }) {
  const recovery = actor("recovery");
  const claimantA = actor("claimant-a"), claimantB = actor("claimant-b");
  let migratedWinner;
  await check("新密码限制6至20字符并要求数字字母特殊字符至少两类",async()=>{
    for(const [i,password] of ["Tb9!a",`Tb9!${"a".repeat(17)}`,"123456","abcdef","!@#$%^"].entries()) {
      const client=actor(`password-invalid-${i}`);
      const rejected=await client.request("/api/auth/register",{method:"POST",body:{email:`password-invalid-${i}@example.test`,password},status:400});
      assert(/^PASSWORD_/.test(rejected.code));
      assert(!rejected.account);
    }
    for(const [i,password] of ["abc123","123!@#","abc!@#",freshAccountPassword()].entries()) {
      const client=actor(`password-valid-${i}`);
      const accepted=await client.request("/api/auth/register",{method:"POST",body:{email:`password-valid-${i}@example.test`,password}});
      assert(accepted.account.id);
    }
  });
  await check("同邮箱并发注册最多一个账号和验证任务",async()=>{
    const left=actor("register-race-a"),right=actor("register-race-b");
    const body={email:"register-race@example.test",password:freshAccountPassword()};
    const result=await Promise.all([left,right].map(client=>client.request("/api/auth/register",{method:"POST",body,status:[200,409]})));
    assert.equal(result.filter(value=>value.account).length,1);
    assert.equal(result.filter(value=>value.code==="ACCOUNT_UNAVAILABLE").length,1);
    const messages=(await local("/__local/mail")).messages.filter(message=>message.email===body.email);
    assert.equal(messages.length,1);
  });
  await check("已有管理员时默认引导拒绝，显式recovery受控恢复并撤销旧会话",async()=>{
    const recoveryAdmin=actor("recovery-admin");
    await recoveryAdmin.register();
    await bootstrap(recoveryAdmin.state.accountId,{execute:true,success:false});
    assert(!(await recoveryAdmin.request("/api/auth/me")).account.roles.includes("admin"));
    await bootstrap(recoveryAdmin.state.accountId,{execute:true,recovery:true});
    assert.equal((await recoveryAdmin.request("/api/auth/me")).account,null);
    assert((await recoveryAdmin.login()).roles.includes("admin"));
  });
  await check("普通登录零邮件，退出撤销旧会话", async () => {
    await recovery.register();
    const before = (await local("/__local/mail")).messages.length;
    const device = actor("recovery-device", { email: recovery.state.email, password: recovery.state.password });
    await device.login();
    const persistent = device.state.lastCookieHeaders.find(cookie => cookie.startsWith("tb_account="));
    assert(persistent && /httponly/i.test(persistent));
    const maxAge = Number(persistent.match(/Max-Age=(\d+)/i)?.[1]);
    assert(maxAge >= 300*86400 && maxAge <= 400*86400,"登录cookie应为约400天的持久cookie");
    assert.equal((await local("/__local/mail")).messages.length,before);
    const restart = actor("persistent-restart", { cookies:{...device.state.cookies}, cookie:device.state.cookie });
    assert.equal((await restart.request("/api/auth/me")).account.id,recovery.state.accountId);
    await advance(40*86400000);
    assert.equal((await restart.request("/api/auth/me")).account.id,recovery.state.accountId);
    const renewal=restart.state.lastCookieHeaders.find(cookie=>cookie.startsWith("tb_account="));
    assert(renewal && Number(renewal.match(/Max-Age=(\d+)/i)?.[1]) >= 300*86400,"活跃使用应续期持久cookie");
    const old = { ...device.state.cookies };
    const logout = await device.request("/api/auth/logout", { method: "POST" });
    assert(!("token" in logout),"退出不返回新的匿名token");
    assert(!Object.keys(device.state.cookies).length,"退出应清除该客户端所有本站cookie");
    assert(device.state.lastCookieHeaders.every(cookie => /Max-Age=0(?:;|$)/i.test(cookie)),"退出只应发送删除cookie");
    const replay = actor("logout-replay", { cookies: old, cookie: Object.entries(old).map(([k,v]) => `${k}=${v}`).join("; ") });
    assert.equal((await replay.request("/api/auth/me")).account,null);
    assert.equal((await recovery.request("/api/auth/me")).account.id,recovery.state.accountId,"退出当前设备不能撤销另一设备会话");
  });
  await check("验证码重发旧码失效、正确码仅消费一次", async () => {
    const user = actor("resend");
    const initial = await user.register({ verify:false });
    const oldMail = await testMail(initial.challengeId);
    await user.request("/api/auth/email/resend", { method:"POST", status:429 });
    await advance(61000);
    const fresh = await user.request("/api/auth/email/resend", { method:"POST" });
    await user.request("/api/auth/email/verify", { method:"POST", body:{challengeId:initial.challengeId,code:oldMail.code}, status:[400,409] });
    const mail = await testMail(fresh.challengeId);
    await user.request("/api/auth/email/verify", { method:"POST", body:{challengeId:fresh.challengeId,code:mail.code} });
    await user.request("/api/auth/email/verify", { method:"POST", body:{challengeId:fresh.challengeId,code:mail.code}, status:[400,409] });
  });
  await check("验证码过期和错误次数限制", async () => {
    const user = actor("expiry");
    const initial = await user.register({ verify:false });
    const mail = await testMail(initial.challengeId);
    const wrong = mail.code === "000000" ? "999999" : "000000";
    for (let i=0;i<5;i++) await user.request("/api/auth/email/verify", {method:"POST",body:{challengeId:initial.challengeId,code:wrong},status:[400,429]});
    await user.request("/api/auth/email/verify", {method:"POST",body:{challengeId:initial.challengeId,code:mail.code},status:[400,429]});
    await advance(61000);
    const fresh = await user.request("/api/auth/email/resend", {method:"POST"});
    const freshMail = await testMail(fresh.challengeId);
    await advance(11*60000);
    await user.request("/api/auth/email/verify", {method:"POST",body:{challengeId:fresh.challengeId,code:freshMail.code},status:[400,410]});
  });
  await check("找回统一提示且重置撤销所有旧设备会话", async () => {
    const ghost = actor("forgot-ghost");
    const absent = await ghost.request("/api/auth/password/forgot", {method:"POST",body:{email:"absent@example.test"}});
    const result = await recovery.request("/api/auth/password/forgot", {method:"POST",body:{email:recovery.state.email}});
    assert.deepEqual(Object.keys(result).sort(),Object.keys(absent).sort());
    assert.equal(result.ok,true);
    const mail = await testMail(result.challengeId);
    assert.equal(mail.purpose,"reset");
    await recovery.request("/api/auth/email/verify", {method:"POST",body:{challengeId:result.challengeId,code:mail.code},status:[400,409]});
    const invalid=await recovery.request("/api/auth/password/reset", {method:"POST",body:{challengeId:result.challengeId,code:mail.code,password:"123456"},status:400});
    assert(/^PASSWORD_/.test(invalid.code));
    const newPassword = freshAccountPassword();
    await recovery.request("/api/auth/password/reset", {method:"POST",body:{challengeId:result.challengeId,code:mail.code,password:newPassword}});
    assert.equal((await recovery.request("/api/auth/me")).account,null);
    await recovery.request("/api/auth/login", {method:"POST",body:{email:recovery.state.email,password:recovery.state.password},status:401});
    recovery.state.password=newPassword;
    await recovery.login();
    await recovery.request("/api/auth/password/reset", {method:"POST",body:{challengeId:result.challengeId,code:mail.code,password:newPassword},status:[400,409]});
  });
  await check("修改密码撤销当前会话，新密码可正常登录", async () => {
    const invalid=await recovery.request("/api/auth/password/change", {method:"POST",body:{currentPassword:recovery.state.password,password:"abcdef"},status:400});
    assert(/^PASSWORD_/.test(invalid.code));
    assert((await recovery.request("/api/auth/me")).account);
    const password = freshAccountPassword();
    await recovery.request("/api/auth/password/change", {method:"POST",body:{currentPassword:recovery.state.password,password}});
    assert.equal((await recovery.request("/api/auth/me")).account,null);
    recovery.state.password=password;
    await recovery.login();
  });
  await check("旧模型凭口令认领，并发最多一个owner", async () => {
    await claimantA.register(); await claimantB.register();
    const password=`Legacy-proof-${randomBytes(18).toString("base64url")}`;
    const operatorId="tangbao-local-legacy-race";
    await local("/__local/fixture",{action:"create-legacy",operatorId,password});
    const legacy=actor("legacy-cookie");
    const migration=await legacy.request("/api/admin/login",{method:"POST",body:{password},status:403});
    assert.equal(migration.code,"LEGACY_MIGRATION_REQUIRED");
    assert.equal((await legacy.request("/api/account/legacy-seat")).operatorId,operatorId);
    const gated=await legacy.request("/api/admin/queue",{status:403});
    assert.equal(gated.code,"LEGACY_MIGRATION_REQUIRED");
    const proofA=await claimantA.request("/api/account/legacy-claims",{method:"POST",body:{password}});
    const proofB=await claimantB.request("/api/account/legacy-claims",{method:"POST",body:{password}});
    assert.equal(proofA.operatorId,operatorId);
    const result=await Promise.all([
      claimantA.request(`/api/account/legacy-claims/${proofA.claimId}/confirm`,{method:"POST",status:[200,409]}),
      claimantB.request(`/api/account/legacy-claims/${proofB.claimId}/confirm`,{method:"POST",status:[200,409]}),
    ]);
    assert.equal(result.filter(value=>value.operatorId===operatorId).length,1);
    const winner=result[0].operatorId?claimantA:claimantB;
    migratedWinner=winner;
    const loser=winner===claimantA?claimantB:claimantA;
    const winningProof=winner===claimantA?proofA:proofB;
    assert.equal((await winner.request("/api/auth/me")).account.operatorId,operatorId);
    await winner.request(`/api/account/legacy-claims/${winningProof.claimId}/confirm`,{method:"POST",status:409});
    await loser.request(`/api/account/legacy-claims/${winningProof.claimId}/confirm`,{method:"POST",status:[403,404,409]});
    const invalid=await loser.request("/api/account/legacy-claims",{method:"POST",body:{password},status:403});
    assert.equal(invalid.code,"LEGACY_PROOF_INVALID");
    await winner.request("/api/applications",{method:"POST",body:{suffix:"legacy-second",blurb:"不应成为第二个模型"},status:409});
    assert.equal((await legacy.request("/api/account/legacy-seat")).operatorId,null);
    await legacy.request("/api/admin/queue",{status:401});
  });
  await check("停用模型owner后不再分配新对话", async () => {
    await migratedWinner.request("/api/admin/queue");
    const beforeVisitor=actor("enabled-owner-visitor");
    await beforeVisitor.request("/chat");
    const before=await beforeVisitor.request("/api/threads",{method:"POST",body:{body:"停用前可正常分配的合成对话",operator:"tangbao-local-legacy-race"}});
    assert.equal(before.operator,"tangbao-local-legacy-race");
    await admin.request(`/api/admin/accounts/${migratedWinner.state.accountId}/disable`,{method:"POST"});
    assert.equal((await migratedWinner.request("/api/auth/me")).account,null);
    const visitor=actor("disabled-owner-visitor");
    await visitor.request("/chat");
    const created=await visitor.request("/api/threads",{method:"POST",body:{body:"停用owner后的合成新对话",operator:"tangbao-local-legacy-race"}});
    assert.notEqual(created.operator,"tangbao-local-legacy-race");
  });
  await check("账号停用撤销全部会话", async () => {
    await admin.request(`/api/admin/accounts/${recovery.state.accountId}/disable`,{method:"POST"});
    assert.equal((await recovery.request("/api/auth/me")).account,null);
    await recovery.request("/api/auth/login",{method:"POST",body:{email:recovery.state.email,password:recovery.state.password},status:401});
  });
  await check("邮件限流有界退避，恢复后消费同一任务", async () => {
    await local("/__local/control", { failure:"rate_limit" });
    const user=actor("mail-retry");
    const result=await user.register({verify:false});
    const deliveries=(await local("/__local/deliveries")).deliveries;
    const first=deliveries.find(item=>item.challengeId===result.challengeId);
    assert.equal(first.status,"retry");
    assert.equal(first.attempts,1);
    await local("/__local/control", { failure:null });
    await advance(61000);
    const retried=await testMail(result.challengeId);
    assert.equal(retried.status,"test");
    assert.equal(retried.attempts,2);
  });
  await check("永久发送错误停止重试，未知结果不盲目重发", async () => {
    for (const [failure,status,name] of [["permanent","failed","mail-permanent"],["unknown","unknown","mail-unknown"]]) {
      await local("/__local/control", { failure });
      const user=actor(name);
      const result=await user.register({verify:false});
      const first=(await local("/__local/deliveries")).deliveries.find(item=>item.challengeId===result.challengeId);
      assert.equal(first.status,status);
      assert.equal(first.attempts,1);
      await local("/__local/control", { failure:null });
      await advance(61000);
      const after=(await local("/__local/deliveries")).deliveries.find(item=>item.challengeId===result.challengeId);
      assert.equal(after.status,status);
      assert.equal(after.attempts,1);
      assert(!(await local(`/__local/mail?challengeId=${encodeURIComponent(result.challengeId)}`)).messages.length);
    }
  });
  await check("日预算在调用发送前拦截", async () => {
    await local("/__local/control",{budgetUsed:200});
    const user=actor("budget");
    await user.request("/api/auth/register",{method:"POST",body:{email:"budget@example.test",password:freshAccountPassword()},status:[200,429,503]});
    const messages=(await local("/__local/mail")).messages;
    assert(!messages.some(message=>message.email==="budget@example.test" && ["test","accepted"].includes(message.status)));
    await local("/__local/control",{budgetUsed:0});
  });
}
