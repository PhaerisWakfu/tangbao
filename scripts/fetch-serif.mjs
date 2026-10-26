import { mkdir, writeFile } from "node:fs/promises";

// 衬线字只用在下面这些字上。页面里新增衬线文字时，把字加进来再跑一次。
const TEXT =
  "糖包需要我做什么？人工语言模型说明推理延迟准确度并发可用性关于桌子背面的0123456789 ·" +
  "回复你是一个真。，（）进入聊天成为这里能智怎使前请知道现在申指普通和般比较招聘训练师AIacdefgilnrtuv";
const TARGETS = (process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["public/assets/tb-serif.woff2", "design/assets/tb-serif.woff2"]
).map((path) => new URL(`../${path}`, import.meta.url));
const HOSTS = ["https://fonts.googleapis.com", "https://fonts.loli.net"];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

for (const host of HOSTS) {
  try {
    const query = `family=Noto+Serif+SC:wght@600&text=${encodeURIComponent(TEXT)}`;
    const cssResponse = await fetch(`${host}/css2?${query}`, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(10000),
    });
    const css = await cssResponse.text();
    const match = css.match(/url\((https:[^)]+)\)\s*format\(['"]woff2['"]\)/);
    if (!match) throw new Error("css 里没有 woff2");
    const fontResponse = await fetch(match[1], {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(15000),
    });
    const font = Buffer.from(await fontResponse.arrayBuffer());
    if (font.subarray(0, 4).toString("latin1") !== "wOF2") throw new Error("拿到的不是 woff2");
    for (const target of TARGETS) {
      await mkdir(new URL(".", target), { recursive: true });
      await writeFile(target, font);
    }
    console.log(`${host} -> ${font.length} bytes`);
    process.exit(0);
  } catch (err) {
    console.error(`${host}: ${err instanceof Error ? err.message : err}`);
  }
}
process.exit(1);
