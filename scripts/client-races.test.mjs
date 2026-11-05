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
    models: [{ id: "first" }], autoModel: "", paintModels() {}, showSys: text => errors.push(text),
    setTimeout: fn => { const id = Math.random(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id), validId: () => true,
  };
  return { context, errors, timers };
}

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
  f.context.api = route => route.endsWith("/a") && ++aCalls === 1 ? first.promise : Promise.resolve({ title: route.endsWith("/a") ? "new A" : "B" });
  functions("desk", ["openSlip", "showPane"], f.context);
  const old = f.context.openSlip("a"); await f.context.openSlip("b"); await f.context.openSlip("a");
  first.resolve({ title: "old A" }); await old; assert.equal(f.rendered.at(-1).title, "new A");
});
test("desk stale request errors do not replace the new thread error area", async () => {
  const f = desk(), first = deferred(); f.context.api = route => route.endsWith("/a") ? first.promise : Promise.resolve({});
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
  pending.resolve({}); await opening;
});
