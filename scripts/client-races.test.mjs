import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = process.env.CLIENT_RACE_SOURCE_DIR || path.join(root, "src/client");
const sources = Object.fromEntries(await Promise.all(["app", "desk"].map(async name => [name, await readFile(path.join(sourceRoot, `${name}.txt`), "utf8")])));
const pagerScope = { window: {}, document: {}, URLSearchParams, Set };
new Script(await readFile(path.join(root, "src/client/messages.txt"), "utf8")).runInNewContext(pagerScope);
function functions(name, names, context, replySubmit = false) {
  context.messagePages ||= new pagerScope.window.TangbaoMessagePages((...args) => context.api(...args));
  const source = sources[name], ast = ts.createSourceFile(`${name}.js`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(ast));
  assert.equal(code.length, names.length);
  if (replySubmit) {
    const listener = ast.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) &&
      n.expression.expression.getText(ast) === "reply.addEventListener" && n.expression.arguments[0].text === "submit");
    assert(listener); code.push(`globalThis.submit = ${listener.expression.arguments[1].getText(ast)};`);
  }
  new Script(code.join("\n")).runInNewContext(context);
  return context;
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function desk() {
  const rendered = [], nodes = new Map(), timers = new Map();
  const node = () => ({ hidden: false, textContent: "", value: "", focus() {}, replaceChildren() {}, scrollIntoView() {}, querySelectorAll: () => [] });
  const button = { disabled: false };
  const context = { Date, FormData, Set, URL: { revokeObjectURL() {} },
    selected: "a", threadViewVersion: 0, readonly: false, shown: "", waiting: 0, pending: 0, timer: 0, ticking: null, pollingAccountId: null,
    POLL_MS: 60000, deskAccountId: "account", loggedOut: false, replying: false, replyGuard: { key: "", at: 0 }, pendingImages: [],
    seat: { operatorId: "operator" }, setDeskThreadUrl() {}, closeDeskThreadNotification: async () => {},
    thread: node(), replyErr: node(), answer: node(), reply: { ...node(), querySelector: () => button }, desk: node(), document: { hidden: false },
    TangbaoAccount: { account: { id: "account", verified: true, operatorId: "operator" }, refresh: async () => {} },
    ApiError: class extends Error {}, renderThread: data => rendered.push(data), loadQueue: async () => {}, loadApplications: async () => {}, loadAudit: async () => {},
    clearAttach() { context.pendingImages = []; }, showAttach() {}, resetDeskView() {}, loginErr: node(),
    window: { matchMedia: () => ({ matches: false }) },
    $: selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); },
    setTimeout: fn => { const id = Math.random(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
  };
  context.$("#pane-apply").hidden = true; context.$("#pane-audit").hidden = true;
  return { context, rendered, nodes, timers, button };
}
function app() {
  const errors = [], timers = new Map();
  const context = { Date, timer: 0, ticking: null, document: { hidden: false }, loggedOut: false, current: null, openAwaiting: false, POLL_MS: 60000,
    modelSearchMode: true, modelSearchHasMore: true, modelSearchSeq: 1, modelSearchPage: 1, modelSearchQuery: "test", modelMoreRequest: null,
    models: [{ id: "first" }], autoModel: "", paintModels() {}, freshModelStatuses: async list => list, refreshUnread: async () => {}, showSys: text => errors.push(text),
    setTimeout: fn => { const id = Math.random(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), validId: () => true,
  };
  return { context, errors, timers };
}

test("chat empty rendering works before sketch canvas initialization", () => {
  const ast = ts.createSourceFile("app.js", sources.app, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === "paint");
  let clears = 0;
  const context = { messagePages: { clear() { clears++; } }, openAwaiting: false, blocked: false, painted: "",
    messages: null, body: { dataset: {} }, current: null, titleEl: {}, log: { replaceChildren() {} },
    tickPending() {}, stage: { scrollTop: 0, scrollHeight: 120 } };
  new Script(declarations.map(n => n.getText(ast)).join("\n")).runInNewContext(context);
  context.paint([]);
  assert.equal(clears, 1);
  assert.equal(context.body.dataset.state, "empty");
  assert.equal(context.messages.length, 0);
});

test("desk polling does not overlap when refresh is clicked repeatedly", async () => {
  const f = desk(), pending = deferred(); let calls = 0;
  f.context.selected = null; f.context.loadQueue = () => { calls++; return pending.promise; };
  functions("desk", ["tick", "arm"], f.context);
  const a = f.context.tick(), b = f.context.tick(); pending.resolve(); await Promise.all([a, b]);
  assert.equal(calls, 1); assert.equal(f.timers.size, 1);
});
test("desk late poll response does not render the previously selected thread", async () => {
  const f = desk(), pending = deferred(); f.context.api = () => pending.promise;
  functions("desk", ["tick", "arm"], f.context);
  const poll = f.context.tick(); await flush(); f.context.selected = "b"; f.context.threadViewVersion++;
  pending.resolve({ thread: { id: "a" } }); await poll; assert.equal(f.rendered.length, 0);
});
test("desk A-B-A switching rejects the first A response", async () => {
  const f = desk(), first = deferred(); let aCalls = 0;
  f.context.api = route => route.split("?")[0].endsWith("/a") && ++aCalls === 1 ? first.promise : Promise.resolve({ thread: { operatorId: "other" }, title: route.split("?")[0].endsWith("/a") ? "new A" : "B" });
  functions("desk", ["openSlip", "showPane"], f.context);
  const old = f.context.openSlip("a"); await f.context.openSlip("b"); await f.context.openSlip("a");
  first.resolve({ thread: { operatorId: "other" }, title: "old A" }); await old; assert.equal(f.rendered.at(-1).title, "new A");
});
test("desk stale request errors do not replace the new thread error area", async () => {
  const f = desk(), first = deferred(); f.context.api = route => route.split("?")[0].endsWith("/a") ? first.promise : Promise.resolve({ thread: { operatorId: "other" } });
  functions("desk", ["openSlip", "showPane"], f.context);
  const old = f.context.openSlip("a"); await f.context.openSlip("b"); first.reject(new Error("old failure")); await old;
  assert.equal(f.context.replyErr.textContent, "");
});
test("late reply completion cannot clear another thread draft or read that thread", async () => {
  const f = desk(), sent = deferred(), paths = []; f.context.answer.value = "reply A";
  f.context.api = (route, options) => { paths.push(route); return options?.method === "POST" ? sent.promise : Promise.resolve({}); };
  functions("desk", [], f.context, true);
  const sending = f.context.submit({ preventDefault() {} }); f.context.selected = "b"; f.context.threadViewVersion++; f.context.answer.value = "draft B";
  sent.resolve({}); await sending; assert.equal(f.context.answer.value, "draft B"); assert(!paths.includes("/api/admin/threads/b"));
});
test("late reply completion preserves text typed while the send is pending", async () => {
  const f = desk(), sent = deferred(); f.context.answer.value = "sent text";
  f.context.api = (_route, options) => options?.method === "POST" ? sent.promise : Promise.resolve({});
  functions("desk", [], f.context, true);
  const sending = f.context.submit({ preventDefault() {} }); f.context.answer.value = "next draft"; sent.resolve({}); await sending;
  assert.equal(f.context.answer.value, "next draft");
});
test("identical replies to different threads are not suppressed by the local guard", async () => {
  const f = desk(); let posts = 0;
  f.context.api = async (_route, options) => { if (options?.method === "POST") posts++; return {}; };
  functions("desk", [], f.context, true);
  f.context.answer.value = "same"; await f.context.submit({ preventDefault() {} });
  f.context.selected = "b"; f.context.threadViewVersion++; f.context.answer.value = "same"; await f.context.submit({ preventDefault() {} });
  assert.equal(posts, 2);
});
test("app model pagination requests one copy of each page", async () => {
  const f = app(), pending = deferred(); let calls = 0;
  f.context.api = () => { calls++; return pending.promise; };
  functions("app", ["loadMoreModels"], f.context);
  const a = f.context.loadMoreModels(), b = f.context.loadMoreModels(); pending.resolve({ models: [{ id: "second" }], hasMore: false }); await Promise.all([a, b]);
  assert.equal(calls, 1); assert.equal(f.context.models.length, 2);
});
test("app stale model pagination failure does not overwrite the new search", async () => {
  const f = app(), pending = deferred(); f.context.api = () => pending.promise;
  functions("app", ["loadMoreModels"], f.context);
  const old = f.context.loadMoreModels(); f.context.modelSearchSeq++; pending.reject(new Error("old search failed")); await old;
  assert.equal(f.errors.length, 0);
});
test("typing a new model search invalidates the previous page before debounce", async () => {
  const f = app(), pending = deferred(); f.context.api = () => pending.promise;
  f.context.modelSearch = { value: "new query" }; f.context.modelSearchTimer = 0; f.context.searchModels = async () => {};
  functions("app", ["loadMoreModels"], f.context);
  const ast = ts.createSourceFile("app.js", sources.app, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const listener = ast.statements.find(n => ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) &&
    n.expression.expression.getText(ast) === "modelSearch.addEventListener" && n.expression.arguments[0].text === "input");
  new Script(`globalThis.onInput = ${listener.expression.arguments[1].getText(ast)};`).runInNewContext(f.context);
  const old = f.context.loadMoreModels(); f.context.onInput(); pending.reject(new Error("old search failed")); await old;
  assert.equal(f.errors.length, 0); assert.equal(f.context.modelSearchHasMore, false);
});
test("app repeated visibility refresh coalesces the polling request", async () => {
  const f = app(), pending = deferred(); let calls = 0;
  f.context.loadModels = () => { calls++; return pending.promise; }; f.context.refresh = async () => {};
  functions("app", ["tick", "arm"], f.context);
  const a = f.context.tick(), b = f.context.tick(); pending.resolve(); await Promise.all([a, b]); assert.equal(calls, 1); assert.equal(f.timers.size, 1);
});
test("app reopening the same object invalidates an earlier failed refresh", async () => {
  const f = app(), pending = deferred(); f.context.current = { id: "a" }; f.context.viewVersion = 0;
  f.context.api = () => pending.promise; f.context.ApiError = class extends Error {};
  functions("app", ["refresh"], f.context);
  const old = f.context.refresh(); f.context.viewVersion++; pending.reject(new Error("old failure")); await assert.doesNotReject(old);
});
test("switching desk thread hides the old reply form until the new read completes", async () => {
  const f = desk(), pending = deferred(); f.context.api = () => pending.promise;
  functions("desk", ["openSlip", "showPane"], f.context);
  const opening = f.context.openSlip("b");
  assert.equal(f.context.reply.hidden, true);
  assert.equal(f.context.$("#block").hidden, true);
  assert.equal(f.context.$("#shelve").hidden, true);
  pending.resolve({ thread: { operatorId: "other" } }); await opening;
});
for (const narrow of [true, false]) test(`older desk history preserves the ${narrow ? "mobile document" : "desktop thread"} scroll position`, async () => {
  const f = desk();
  const root = { scrollTop: 200, scrollHeight: 2000, clientHeight: 844 };
  f.context.document.scrollingElement = root;
  f.context.thread = { scrollTop: narrow ? 0 : 400, scrollHeight: 1000, clientHeight: narrow ? 1000 : 600 };
  f.context.window.matchMedia = () => ({ matches: narrow });
  f.context.api = async route => route.includes("before=")
    ? { messages: [{ id: "a-0" }, { id: "a-1" }], messagePage: { oldest: "a-0", newest: "a-1", hasOlder: false, hasNewer: false } }
    : { messages: [{ id: "a-2" }, { id: "a-3" }], messagePage: { oldest: "a-2", newest: "a-3", hasOlder: true, hasNewer: false } };
  functions("desk", ["loadOlderMessages", ...(sources.desk.includes("function messageScroller()") ? ["messageScroller"] : [])], f.context);
  await f.context.messagePages.load("0:a", "/api/admin/threads/a");
  f.context.renderThread = data => {
    assert.equal(data.messages.length, 4);
    f.context.thread.scrollHeight += 1000;
    if (narrow) { f.context.thread.clientHeight += 1000; root.scrollHeight += 1000; }
  };
  await f.context.loadOlderMessages();
  assert.equal(root.scrollTop, narrow ? 1200 : 200);
  if (!narrow) assert.equal(f.context.thread.scrollTop, 1400);
});
