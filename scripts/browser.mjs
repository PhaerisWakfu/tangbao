import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
);

const base = "http://127.0.0.1:8787";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on("pageerror", (err) => pageErrors.push(err.message));
const problems = [];
const note = (cond, message) => {
  if (!cond) problems.push(message);
  else console.log("ok", message);
};

await page.goto(`${base}/`, { waitUntil: "load" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "load" });
note((await page.locator(".hello h1").innerText()) === "需要我做什么？", "desktop greeting");
note(!(await page.locator(".chips").innerText()).includes("我是不是想太多了"), "odd suggestion is gone");
note((await page.locator("#model").innerText()).includes("tangbao-vme50-flash"), "model id looks like a lineup");
note((await page.locator("body").getAttribute("data-state")) === "empty", "starts empty");
note((await page.locator(".fine").innerText()).includes("这里的 AI 是人工"), "desktop fine print");
note(await page.locator("#open-side").isHidden(), "desktop hides the drawer button");
note(await page.evaluate(() => document.fonts.check('600 34px "TB Serif"', "需要我做什么")), "serif subset loaded");

const focusRing = await page.evaluate(() => {
  document.querySelector("#input").focus();
  return getComputedStyle(document.querySelector("#input")).outlineStyle;
});
note(focusRing === "none", "no black box around the input");

await page.locator("#model").click();
note((await page.locator("#card").innerText()).includes("十根手指"), "model card shows the hardware");
await page.keyboard.press("Escape");

const question = `短一点 ${Date.now()}`;
await page.locator("#input").fill(question);
await page.locator("button.send").click();
await page.locator(".pending").waitFor();
await page.locator("#history a", { hasText: question }).waitFor();
note((await page.locator("body").getAttribute("data-state")) === "chat", "chat state after sending");
note((await page.locator(".pending b").innerText()).includes("思考中"), "thinking state");
note((await page.locator(".pending small").innerText()).includes("不是在生成"), "thinking caption stays small");

await page.goto(`${base}/desk`, { waitUntil: "load" });
await page.locator("#password").fill(vars.ADMIN_PASSWORD);
await page.locator("#login .primary").click();
await page.locator(".slip", { hasText: question }).click();
await page.locator("#answer").fill("留下你真正要的那句。");
await page.locator("#reply .send").click();
await page.locator(".me p", { hasText: "留下你真正要的那句。" }).waitFor();
note(true, "desk reply is on the page");

await page.locator("#lamp").click();
await page.locator("body[data-presence='asleep']").waitFor();
note((await page.locator("#lamp b").innerText()) === "灯灭了", "lamp off copy");

await page.goto(`${base}/`, { waitUntil: "load" });
await page.locator(".b-text", { hasText: "留下你真正要的那句。" }).waitFor();
note((await page.locator("body").getAttribute("data-presence")) === "asleep", "visitor page turns to night");
note((await page.locator("#status-label").innerText()) === "繁忙", "visitor sees busy");
note((await page.locator("#status-note").innerText()).includes("他睡了"), "visitor note names the sleep");
await page.locator(".thought summary").last().click();
const thought = await page.locator(".thought-body").last().innerText();
note(thought.includes("糖包本人") && thought.includes("字/分钟"), "thinking details show core and throughput");

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${base}/`, { waitUntil: "load" });
note(await page.locator("#open-side").isVisible(), "narrow screen shows the drawer button");
note(await page.locator(".fine").isVisible(), "narrow fine print");
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
note(overflow <= 1, `narrow page does not overflow sideways (${overflow}px)`);
await page.locator("#open-side").click();
note(await page.evaluate(() => document.body.classList.contains("drawer")), "narrow drawer opens");

await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`${base}/about`, { waitUntil: "load" });
note((await page.locator(".doc small").first().innerText()).includes("糖包本人"), "about small print");
await page.waitForFunction(() => document.getElementById("ratio").textContent.includes("%"));
note((await page.locator("#bars i").count()) === 24, "about shows 24 hours of availability");

await page.goto(`${base}/`, { waitUntil: "load" });
const row = page.locator(".hist-row", { hasText: question });
await row.hover();
await row.locator(".hist-x").click();
await row.locator(".hist-x", { hasText: "删" }).click();
await page.locator(".hist-row", { hasText: question }).waitFor({ state: "detached" });
note(true, "conversation can be deleted");

await page.goto(`${base}/desk`, { waitUntil: "load" });
await page.locator("#lamp").waitFor();
if ((await page.locator("#lamp").getAttribute("aria-checked")) === "false") {
  await page.locator("#lamp").click();
  await page.locator("body[data-presence='awake']").waitFor();
}

await browser.close();
note(!pageErrors.length, `no page errors ${pageErrors.join("; ")}`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("browser passed");
