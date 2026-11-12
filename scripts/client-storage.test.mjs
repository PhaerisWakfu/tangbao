import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
const source = await readFile(new URL("../src/client/app.txt", import.meta.url), "utf8");
const ast = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ["validId", "visitorId", "loadStore", "saveStore", "remember", "sendText", "setThreadUrl"];
const code = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(ast)).join("\n");
for (const failure of ["SecurityError", "QuotaExceededError"]) test(`${failure} does not turn successful sending into a failed/repeated POST`, async () => {
  const notices = [], posts = [];
  const context = { Date, JSON, crypto, FormData, STORE_KEY: "test", VISITOR_KEY: "visitor", blocked: false, sending: false,
    viewVersion: 1, pendingImages: [], current: null, messages: [], making: false, sentGuard: { key: "", at: 0 }, creationAttempt: null,
    store: { threads: [], activeId: null }, ownedThreads: [], TangbaoAccount: { ready: Promise.resolve(), account: null },
    localStorage: { getItem() { throw new DOMException("disabled", failure); }, setItem() { throw new DOMException("full", failure); } },
    input: { value: "synthetic", focus() {} }, titleEl: {}, $: () => ({ value: "" }), renderHistory() {}, activeModel: () => "", grow() {}, showAttach() {}, paint() {},
    showSys: text => notices.push(text), refresh: async () => {}, URL: { revokeObjectURL() {} },
    location: { pathname: "/chat", search: "" }, window: { history: { replaceState() { throw new DOMException("disabled", failure); } } },
    api: async (route, options) => { posts.push([route, options]); return { id: "aaaaaaaaaaaaaaaaaaaaaaaa", token: "synthetic-token" }; },
  };
  new Script(code).runInNewContext(context);
  assert.equal(context.loadStore().threads.length, 0);
  assert.equal(context.visitorId(), "");
  await context.sendText("synthetic");
  assert.equal(posts.length, 1); assert.equal(context.store.threads.length, 1); assert.equal(context.input.value, "");
  assert.equal(context.current.id, "aaaaaaaaaaaaaaaaaaaaaaaa"); assert.equal(context.sending, false);
  assert(notices.some(text => text.includes("无法保存匿名历史")));
  assert(!notices.some(text => text.includes("消息尚未发送")));
});
