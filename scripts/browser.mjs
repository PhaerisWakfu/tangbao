import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { localBrowserTarget } from "./local-browser-target.mjs";

export async function checkPages(page, base, shot = async () => {}) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [route, selector, name] of [["/", "#connect-tab", "home"], ["/chat", "#input", "chat"], ["/desk", "#desk-login", "desk"], ["/about", "#bars", "about"]]) {
      const response = await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      assert.equal(response.status(), 200);
      await page.locator(selector).first().waitFor({ state: "visible" });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${route} ${width}px 横向溢出`);
      if (route === "/") {
        await page.locator("#connect-tab").click();
        assert(await page.locator("#connect").evaluate(node => node.matches(":modal")));
        await page.keyboard.press("Escape");
        assert(await page.locator("#connect-tab").evaluate(node => node === document.activeElement));
      }
      await shot(page, `${name}-${width}`);
      console.log(`ok ${route} ${width}px`);
    }
  }
  assert.deepEqual(errors, []);
}
export async function browserCheck(shots = false) {
  const target = await localBrowserTarget();
  const channel = process.env.TANGBAO_BROWSER_CHANNEL || "chrome";
  if (!["chrome", "msedge", "chromium"].includes(channel)) throw new Error("TANGBAO_BROWSER_CHANNEL 只接受 chrome、msedge、chromium。");
  const browser = await chromium.launch({ ...(channel === "chromium" ? {} : { channel }), headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let shot;
    if (shots) {
      const { mkdir } = await import("node:fs/promises");
      const out = `${target.directory}/screenshots-${Date.now()}`;
      await mkdir(out, { recursive: true });
      shot = async (page, name) => { await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }); };
      console.log(`截图目录：${out}`);
    }
    await checkPages(page, target.base, shot);
  } finally { await browser.close(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await browserCheck();
