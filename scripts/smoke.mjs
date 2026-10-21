import { readFileSync } from "node:fs";

const base = "http://127.0.0.1:8787";
const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);
const password = process.env.ADMIN_PASSWORD || vars.ADMIN_PASSWORD;
if (!password) throw new Error("missing ADMIN_PASSWORD");

let cookie = "";
const failures = [];

function assert(cond, message) {
  if (!cond) failures.push(message);
  else console.log("ok", message);
}

async function req(path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("cookie", cookie);
  if (!headers.has("x-visitor")) headers.set("x-visitor", "smoke-visitor-0001");
  const response = await fetch(base + path, { ...options, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json() : await response.text();
  return { response, body };
}

const home = await req("/");
assert(home.response.status === 200, "home 200");
assert(home.body.includes("制作图片"), "make image in the menu");
assert(home.body.includes("需要我做什么？"), "greeting");
assert(home.body.includes("这里的 AI 是「能工智人」"), "fine print");
assert(!home.body.includes("<h1>其实是人"), "headline stays in product voice");

const about = await req("/about");
assert(about.response.status === 200, "about 200");
assert(about.body.includes("操作员是糖包本人"), "about reveal");
assert(about.body.includes("图从笔尖出来"), "about text-to-image");

const desk = await req("/desk");
assert(desk.response.status === 200, "desk 200");
assert(desk.body.includes("桌子背面"), "desk title");

const status = await req("/api/status");
assert(status.body.state === "available" && status.body.note === "他醒着", "awake status");

const presence = await req("/api/presence");
assert(presence.body.hours.length === 24 && typeof presence.body.ratio === "number", "presence history");

const created = await req("/api/threads", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ body: "这封信要不要回？" }),
});
assert(created.response.status === 200 && created.body.token, "create thread");

const denied = await req(`/api/threads/${created.body.id}`);
assert(denied.response.status === 401, "thread requires key");

const read = await req(`/api/threads/${created.body.id}`, {
  headers: { authorization: `Bearer ${created.body.token}` },
});
assert(read.response.status === 200 && read.body.messages.length === 1, "owner can read");
assert(read.body.messages[0].body === "这封信要不要回？", "message stored");
assert(read.body.messages[0].draw === 0, "plain message is not a picture");

const rude = await req(`/api/threads/${created.body.id}/messages`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${created.body.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ body: "你这个傻逼，信还是要回。兼职招聘。" }),
});
assert(rude.response.status === 200, "rude message accepted");
const masked = await req(`/api/threads/${created.body.id}`, {
  headers: { authorization: `Bearer ${created.body.token}` },
});
assert(masked.body.messages.at(-1).body === "你这个**，信还是要回。****。", "blocked words become stars");

const drawn = await req(`/api/threads/${created.body.id}/messages`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${created.body.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ body: "窗边一只猫", draw: true }),
});
assert(drawn.response.status === 200, "draw prompt accepted");
const withDraw = await req(`/api/threads/${created.body.id}`, {
  headers: { authorization: `Bearer ${created.body.token}` },
});
assert(withDraw.body.messages.at(-1).draw === 1, "draw flag stored");

const empty = await req(`/api/threads/${created.body.id}/messages`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${created.body.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ body: "   " }),
});
assert(empty.response.status === 400 && empty.body.error.includes("先写一句"), "empty message");

const badLogin = await req("/api/admin/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "nope" }),
});
assert(badLogin.response.status === 401, "bad password");

const login = await req("/api/admin/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password }),
});
assert(login.response.status === 200 && cookie.startsWith("tb_desk="), "login cookie");

const queue = await req("/api/admin/queue");
assert(queue.body.waiting.some((item) => item.id === created.body.id), "queue has the slip");

const reply = await req(`/api/admin/threads/${created.body.id}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ body: "留一句你真正想说的，其余的谢谢先拿掉。" }),
});
assert(reply.response.status === 200, "reply");

const after = await req(`/api/threads/${created.body.id}`, {
  headers: { authorization: `Bearer ${created.body.token}` },
});
assert(after.body.messages.at(-1).role === "tangbao", "visitor sees the reply");

const asleep = await req("/api/admin/status", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ awake: false }),
});
assert(asleep.body.state === "busy" && asleep.body.note === "他睡了", "lamp off");

const seen = await req("/api/status");
assert(seen.body.label === "繁忙", "public status follows the lamp");

const awake = await req("/api/admin/status", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ awake: true }),
});
assert(awake.body.awake === true, "lamp back on");

const blocked = await req(`/api/admin/threads/${created.body.id}/block`, { method: "POST" });
assert(blocked.response.status === 200, "block visitor");
const silenced = await req(`/api/threads/${created.body.id}/messages`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${created.body.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ body: "再写一句" }),
});
assert(silenced.response.status === 403, "blocked thread cannot send");
const fresh = await req("/api/threads", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ body: "换一段对话" }),
});
assert(fresh.response.status === 403, "blocked visitor cannot start again");
const opened = await req(`/api/admin/threads/${created.body.id}/unblock`, { method: "POST" });
assert(opened.response.status === 200, "unblock visitor");

const removed = await req(`/api/threads/${created.body.id}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${created.body.token}` },
});
assert(removed.response.status === 200, "visitor can delete the thread");
const gone = await req(`/api/threads/${created.body.id}`, {
  headers: { authorization: `Bearer ${created.body.token}` },
});
assert(gone.response.status === 401, "deleted thread no longer opens");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("smoke passed");
