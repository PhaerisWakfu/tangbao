import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

// HTTP clients keep separate cookie jars. These are synthetic identities using
// today's legacy API, not fake implementations of future email accounts.
export async function runScenarios({ metadata, directory, fixtureFile, adminPassword, checkServer }) {
  const base = `http://127.0.0.1:${metadata.port}`;
  const results = [];
  const fixture = {
    instanceNonce: metadata.nonce,
    status: "started",
    actors: {}, threads: {},
  };
  const attempt = new Date().toISOString().replaceAll(":", "-");
  const reportFile = path.join(directory, `verification-${attempt}-${randomBytes(3).toString("hex")}.json`);
  const save = () => writeFile(fixtureFile, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  await save();
  function actor(name, password) {
    const state = { visitor: randomBytes(18).toString("base64url"), cookie: "", ...(password ? { password } : {}) };
    fixture.actors[name] = state;
    return {
      state,
      async request(route, { method = "GET", body, token, status = 200 } = {}) {
        assert(route.startsWith("/") && !route.startsWith("//"), "只允许当前实例相对路径");
        // Some legacy GET endpoints update presence and assign pooled threads.
        // Guard every request, rather than assuming GET is read-only.
        await checkServer();
        const headers = { "x-visitor": state.visitor };
        if (state.cookie) headers.cookie = state.cookie;
        if (token) headers.authorization = `Bearer ${token}`;
        const form = body instanceof FormData;
        if (body && !form) headers["content-type"] = "application/json";
        const response = await fetch(base + route, {
          method, headers, redirect: "error", signal: AbortSignal.timeout(10000),
          body: body ? form ? body : JSON.stringify(body) : undefined,
        });
        const cookie = response.headers.get("set-cookie");
        if (cookie) { state.cookie = cookie.split(";")[0]; await save(); }
        assert.equal(response.status, status, `${name} ${method} ${route} status`);
        const contentType = response.headers.get("content-type") || "";
        const data = contentType.includes("json") ? await response.json() : contentType.startsWith("image/") ? new Uint8Array(await response.arrayBuffer()) : await response.text();
        return data;
      },
      async login() {
        const data = await this.request("/api/admin/login", { method: "POST", body: { password: state.password } });
        state.operatorId = data.operatorId;
        return data;
      },
    };
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
  const admin = actor("admin", adminPassword);
  const applicantA = actor("applicant-a");
  const applicantB = actor("applicant-b");
  const visitorA = actor("visitor-a");
  const visitorB = actor("visitor-b");
  const visitorC = actor("visitor-pool");
  let operatorA, operatorB;
  try {
    await check("本地实例标记与集成禁用", checkServer);
    for (const [route, expected] of [["/", "成为"], ["/chat", "composer"], ["/desk", "login"], ["/assets/app.css", "--bg"]]) {
      await check(`页面/资源 ${route}`, async () => assert((await visitorA.request(route)).includes(expected)));
    }
    await check("匿名不能进入后台队列", () => visitorA.request("/api/admin/queue", { status: 401 }));
    await check("无人在线时 Auto 进入消息池", async () => {
      const data = await visitorC.request("/api/threads", { method: "POST", body: { body: "合成场景：等待模型接单" } });
      assert.equal(data.queued, true);
      fixture.threads.pool = data;
      await save();
    });
    await check("管理员口令登录及角色", async () => assert.equal((await admin.login()).super, true));
    for (const [suffix, applicant, key] of [["local-a", applicantA, "a"], ["local-b", applicantB, "b"]]) {
      await check(`申请与审批模型 ${suffix}`, async () => {
        const application = await applicant.request("/api/applications", { method: "POST", body: { suffix, email: `${suffix}@example.test`, blurb: "本地合成测试" } });
        assert.equal(application.status, "pending");
        const approved = await admin.request(`/api/admin/applications/${application.id}/approve`, { method: "POST" });
        const operator = actor(`operator-${key}`, approved.password);
        assert.equal(approved.modelId, `tangbao-${suffix}`);
        if (key === "a") operatorA = operator; else operatorB = operator;
        await save();
      });
    }
    await check("两个运营者各自登录，cookie 相互独立", async () => {
      assert.equal((await operatorA.login()).super, false);
      assert.equal((await operatorB.login()).super, false);
      assert.notEqual(admin.state.cookie, operatorA.state.cookie);
      assert.notEqual(operatorA.state.cookie, operatorB.state.cookie);
    });
    await check("运营者 A 的心跳接走消息池对话", async () => {
      const queue = await operatorA.request("/api/admin/queue");
      assert(queue.waiting.some((item) => item.id === fixture.threads.pool.id));
      const thread = await visitorC.request(`/api/threads/${fixture.threads.pool.id}`, { token: fixture.threads.pool.token });
      assert.equal(thread.operator, operatorA.state.operatorId);
      assert.equal(thread.queued, false);
    });
    await check("运营者 B 独立上线", async () => assert.equal((await operatorB.request("/api/admin/queue")).operatorId, operatorB.state.operatorId));
    for (const [name, visitor, operator] of [["a", visitorA, operatorA], ["b", visitorB, operatorB]]) {
      await check(`访客 ${name.toUpperCase()} 指定对应模型对话`, async () => {
        const body = { body: `合成访客 ${name.toUpperCase()} 的专属对话`, operator: operator.state.operatorId };
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
        assert.equal(data.queued, false);
        fixture.threads[name] = data;
        await save();
      });
    }
    const a = fixture.threads.a, b = fixture.threads.b;
    await check("访客拥有正确 token 才能读取", async () => {
      assert.equal((await visitorA.request(`/api/threads/${a.id}`, { token: a.token })).messages[0].role, "visitor");
      await visitorB.request(`/api/threads/${a.id}`, { token: b.token, status: 401 });
      await visitorB.request(`/api/threads/${a.id}`, { status: 401 });
    });
    await check("D1 图片元数据和本地 KV 二进制可读", async () => {
      const thread = await visitorA.request(`/api/threads/${a.id}`, { token: a.token });
      const image = thread.messages[0].images[0];
      assert(image?.id);
      const bytes = await visitorA.request(`/api/images/${image.id}`);
      assert(bytes.length > 0);
      assert.equal(bytes[0], 0x89);
    });
    await check("各自队列包含本人的对话", async () => {
      const queueA = await operatorA.request("/api/admin/queue");
      const queueB = await operatorB.request("/api/admin/queue");
      assert(queueA.waiting.some((item) => item.id === a.id));
      assert(!queueA.waiting.some((item) => item.id === b.id));
      assert(queueB.waiting.some((item) => item.id === b.id));
      assert(!queueB.waiting.some((item) => item.id === a.id));
    });
    await check("运营者不能读取或回复另一模型对话", async () => {
      await operatorA.request(`/api/admin/threads/${b.id}`, { status: 404 });
      await operatorA.request(`/api/admin/threads/${b.id}`, { method: "POST", body: { body: "不应落库的合成回复" }, status: 403 });
      await operatorB.request(`/api/admin/threads/${a.id}`, { status: 404 });
    });
    await check("运营者不能审批或查看管理审计", async () => {
      await operatorA.request("/api/admin/audit", { status: 403 });
      await operatorB.request("/api/admin/applications", { status: 403 });
    });
    for (const [name, visitor, operator, thread] of [["a", visitorA, operatorA, a], ["b", visitorB, operatorB, b]]) {
      await check(`模型 ${name.toUpperCase()} 回复由对应访客收到`, async () => {
        const text = `模型 ${name.toUpperCase()} 的合成回复`;
        await operator.request(`/api/admin/threads/${thread.id}`, { method: "POST", body: { body: text } });
        const data = await visitor.request(`/api/threads/${thread.id}`, { token: thread.token });
        assert.equal(data.messages.at(-1).body, text);
        assert.equal(data.messages.at(-1).role, "tangbao");
        assert.equal(data.awaiting, false);
      });
    }
    await check("管理员可以审计两个模型对话", async () => {
      const audit = await admin.request("/api/admin/audit");
      assert(audit.threads.some((item) => item.id === a.id));
      assert(audit.threads.some((item) => item.id === b.id));
      await admin.request(`/api/admin/threads/${a.id}`);
      await admin.request(`/api/admin/threads/${b.id}`);
    });
    await check("对话后续消息与画图标记", async () => {
      await visitorA.request(`/api/threads/${a.id}/messages`, { method: "POST", token: a.token, body: { body: "合成场景：请画一只猫", draw: true } });
      const data = await operatorA.request(`/api/admin/threads/${a.id}`);
      assert.equal(data.messages.at(-1).draw, 1);
      await operatorA.request(`/api/admin/threads/${a.id}`, { method: "POST", body: { body: "合成场景：已收到画图请求" } });
    });
    await check("停用模型后既有会话被拒绝", async () => {
      await admin.request(`/api/admin/operators/${operatorB.state.operatorId}/disable`, { method: "POST" });
      await operatorB.request("/api/admin/queue", { status: 401 });
      await admin.request(`/api/admin/operators/${operatorB.state.operatorId}/enable`, { method: "POST" });
    });
    fixture.status = "complete";
    await save();
  } catch (error) {
    fixture.status = "failed";
    await save();
    throw error;
  } finally {
    const report = {
      instance: metadata.instance, createdAt: new Date().toISOString(),
      runtime: "Wrangler local / workerd / D1 / KV", status: fixture.status,
      results,
      notImplemented: ["邮箱密码账号", "匿名第二段注册门槛", "邮箱验证/密码找回", "旧口令绑定新账号"],
      notCovered: ["Turso", "真实 Resend 或 Web Push 送达", "生产 HTTPS/边缘缓存", "浏览器 UI（另行验证）", "高并发容量"],
    };
    await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    console.log(`合成身份：${fixtureFile}\n结果：${reportFile}\nPASS ${results.filter((result) => result.status === "PASS").length} / ${results.length}`);
  }
  return fixture;
}
