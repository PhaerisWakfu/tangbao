import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { test } from "node:test";
const source = await readFile(new URL("../src/client/messages.txt", import.meta.url), "utf8");
function pager(fetchPage, extras = {}) {
  const scope = { window: {}, document: {}, URLSearchParams, Set, URL, Date, location: { origin: "http://localhost" }, ...extras };
  new Script(source).runInNewContext(scope);
  return { pages: new scope.window.TangbaoMessagePages(fetchPage), Class: scope.window.TangbaoMessagePages };
}
const message = id => ({ id, body: id, images: [] });
const page = (ids, { older = false, newer = false, cursor } = {}) => ({ messages: ids.map(message), messagePage: { oldest: ids[0] || null, newest: ids.at(-1) || cursor || null, hasOlder: older, hasNewer: newer } });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
test("older pages and incremental refresh preserve loaded history, deduplicate and keep empty-page cursor", async () => {
  const calls = [], responses = [page(["m3", "m4"], { older: true }), page(["m1", "m2"], { older: false }), page(["m4", "m5"], { newer: true }), page([], { cursor: "m5" })];
  const { pages } = pager(async path => { calls.push(path); return responses.shift(); });
  await pages.load("v1", "/thread"); await pages.load("v1", "/thread", {}, "older");
  await pages.load("v1", "/thread"); await pages.load("v1", "/thread");
  assert.deepEqual(Array.from(pages.items, m => m.id), ["m1", "m2", "m3", "m4", "m5"]);
  assert.deepEqual(calls, ["/thread", "/thread?before=m3", "/thread?after=m4", "/thread?after=m5"]);
  assert.equal(pages.newest, "m5"); assert.equal(pages.oldest, "m1"); assert.equal(pages.hasOlder, false);
});
test("page requests coalesce and old A cannot overwrite B or reopened A", async () => {
  const old = deferred(), calls = []; let first = true;
  const { pages } = pager(path => { calls.push(path); if (first) { first = false; return old.promise; } return Promise.resolve(page([path])); });
  const a = pages.load("a1", "/a"), same = pages.load("a1", "/a"); assert.equal(a, same);
  await pages.load("b1", "/b"); await pages.load("a2", "/a"); old.resolve(page(["old-a"])); await a;
  assert.deepEqual(Array.from(pages.items, m => m.id), ["/a"]); assert.equal(calls.length, 3);
});
test("failed older request retains history and cursor; a retry recovers without skipping", async () => {
  let n = 0; const calls = [];
  const { pages } = pager(async path => { calls.push(path); n++; if (n === 2) throw Error("offline"); return n === 1 ? page(["m3"], { older: true }) : page(["m1", "m2"]); });
  await pages.load("a", "/a"); await assert.rejects(pages.load("a", "/a", {}, "older"));
  assert.equal(pages.oldest, "m3"); assert.equal(pages.pending, null); assert.equal(pages.items.length, 1);
  await pages.load("a", "/a", {}, "older"); assert.deepEqual(calls.slice(1), ["/a?before=m3", "/a?before=m3"]);
  assert.equal(pages.error, ""); assert.equal(pages.items.length, 3);
});
test("logout/clear invalidates in-flight page state and late failures", async () => {
  const delayed = deferred(); const { pages } = pager(() => delayed.promise);
  const pending = pages.load("old", "/old"); pages.clear(); delayed.reject(Error("old account"));
  await assert.rejects(pending); assert.equal(pages.key, ""); assert.equal(pages.items.length, 0); assert.equal(pages.error, "");
});
test("expired anonymous image URLs reuse the existing bearer authorization without extending signatures", async () => {
  let options;
  const { Class } = pager(async () => {}, { URL: class extends URL { static createObjectURL() { return "blob:synthetic"; } }, fetch: async (url, value) => { options = value; return { ok: true, blob: async () => ({}) }; } });
  assert.equal(await Class.imageSource("/api/images/test?e=1&s=expired", "thread-token"), "blob:synthetic");
  assert.equal(options.headers.Authorization, "Bearer thread-token"); assert.equal(options.credentials, "same-origin");
  assert.equal(await Class.imageSource("/api/images/test", undefined), "/api/images/test");
});
test("post-send refresh waits for the pre-send read and then requests committed additions", async () => {
  const delayed = deferred(); let calls = 0;
  const { pages } = pager(() => ++calls === 1 ? delayed.promise : Promise.resolve(page(["committed"])));
  const before = pages.load("a", "/a"); const after = pages.fresh("a", "/a");
  delayed.resolve(page(["before"])); await before; const data = await after;
  assert.equal(calls, 2); assert.deepEqual(Array.from(data.messages, m => m.id), ["before", "committed"]);
});
test("expired image renewal never forwards a thread token to another origin", async () => {
  let calls = 0; const { Class } = pager(async () => {}, { fetch: async () => { calls++; } });
  await assert.rejects(Class.imageSource("https://example.test/api/images/x?e=1", "private-token")); assert.equal(calls, 0);
});
test("a successful poll cannot hide an older-page failure", async () => {
  let n = 0; const { pages } = pager(async () => { n++; if (n === 2) throw Error("older failed"); return n === 1 ? page(["a"], { older: true }) : page([], { cursor: "a" }); });
  await pages.load("a", "/a"); await assert.rejects(pages.load("a", "/a", {}, "older"));
  await pages.load("a", "/a"); assert.equal(pages.error, "older failed");
});
