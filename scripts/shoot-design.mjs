import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

// 用法：node scripts/shoot-design.mjs "forks/06-pleat.html?state=chat,06-chat.png,1440,900" ...
const base = process.env.DESIGN_URL || "http://127.0.0.1:8788/";
const specs = process.argv.slice(2).map((arg) => {
  const [path, out, width = "1440", height = "900"] = arg.split(",");
  return { path, out, width: Number(width), height: Number(height) };
});

mkdirSync(new URL("../design/shots/", import.meta.url), { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
let failed = false;
for (const spec of specs) {
  const page = await browser.newPage({ viewport: { width: spec.width, height: spec.height } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(new URL(spec.path, base).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `design/shots/${spec.out}` });
  if (errors.length) failed = true;
  console.log(spec.out, errors.length ? `errors: ${errors.join("; ")}` : "ok");
  await page.close();
}
await browser.close();
if (failed) process.exit(1);
