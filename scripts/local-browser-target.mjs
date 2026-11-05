import { readFile } from "node:fs/promises";
import path from "node:path";

export async function localBrowserTarget(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--instance" || !/^[a-z][a-z0-9-]{0,39}$/.test(args[1])) throw new Error("只接受 --instance <已 prepare/dev/seed 的隔离实例>；不接受 URL、生产配置或浏览器凭据。");
  const instance = args[1];
  const directory = path.resolve(import.meta.dirname, "../.tmp/local-sandboxes", instance);
  const meta = JSON.parse(await readFile(path.join(directory, "instance.json"), "utf8"));
  if (meta.kind !== "tangbao-local-sandbox/v1" || meta.instance !== instance || !/^[a-f0-9]{48}$/.test(meta.nonce) || !Number.isInteger(meta.port) || meta.port < 1024 || meta.port > 65535) throw new Error("本地实例标记不匹配。");
  const base = `http://127.0.0.1:${meta.port}`;
  const health = await fetch(`${base}/__local/health`, { redirect: "error", signal: AbortSignal.timeout(2000) });
  const data = await health.json();
  if (!health.ok || health.headers.get("x-tangbao-local") !== meta.nonce || data.kind !== meta.kind || data.instance !== instance || data.externalSending !== false) throw new Error("本地服务身份不匹配，停止浏览器验证。");
  return { base, directory, instance };
}
