import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const base = "http://127.0.0.1:8787";
const out = "design/shots/site";
mkdirSync(new URL(`../${out}/`, import.meta.url), { recursive: true });
const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const shot = async (name) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name);
};
const desk = async (path, body) => {
  const response = await page.request.fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    data: body,
  });
  return response.json();
};

await page.goto(`${base}/desk`);
await page.locator("#password").fill(vars.ADMIN_PASSWORD);
await page.locator("#login .primary").click();
await page.locator("#lamp").waitFor();
await desk("/api/admin/status", { awake: true });

await page.goto(`${base}/`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await shot("empty");

await page.locator("#input").fill("今晚要不要早一点睡");
await page.locator("button.send").click();
await page.locator(".pending").waitFor();
await page.locator("#history a").first().waitFor();
const { id } = await page.evaluate(() => JSON.parse(localStorage.getItem("tangbao.v1")).threads[0]);
await desk(`/api/admin/threads/${id}`, { body: "要。你会问这句，说明心里已经有答案了。\n没做完的事，明天的你会比现在清醒。" });
await page.reload();
await page.locator(".b-text").waitFor();
await page.locator("#input").fill("那明天早上的会怎么办");
await page.locator("button.send").click();
await page.locator(".pending").waitFor();
await shot("chat");
await page.locator(".thought summary").first().click();
await shot("chat-thought");

await page.setViewportSize({ width: 390, height: 844 });
await page.reload();
await page.locator(".pending").waitFor();
await shot("narrow-chat");
await page.setViewportSize({ width: 1440, height: 900 });

await desk("/api/admin/status", { awake: false });
await page.reload();
await page.locator("body[data-presence='asleep']").waitFor();
await shot("asleep");

await page.goto(`${base}/about`);
await page.waitForFunction(() => document.getElementById("ratio").textContent.includes("%"));
await shot("about-asleep");
await desk("/api/admin/status", { awake: true });
await page.reload();
await page.waitForFunction(() => document.getElementById("ratio").textContent.includes("%"));
await shot("about");

await page.goto(`${base}/desk`);
await page.locator(".slip").first().click();
await page.locator(".me, .them").first().waitFor();
await shot("desk");

await page.evaluate(() => fetch("/api/admin/logout", { method: "POST" }));
await page.goto(`${base}/desk`);
await page.locator("#login").waitFor();
await shot("desk-gate");

await browser.close();
