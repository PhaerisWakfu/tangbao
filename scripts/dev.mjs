import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Miniflare's local email-store Durable Object lives under os.tmpdir().
// On this Windows machine, workerd is denied creating directories/files under
// %TEMP% by the active real-time security shield, while the project directory
// is allowed. Keep the temp tree inside the workspace so `npm run dev` works
// from any terminal without changing the machine-wide TEMP variable.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, ".tmp");
mkdirSync(tmp, { recursive: true });

if (process.platform === "win32") {
  process.env.TEMP = tmp;
  process.env.TMP = tmp;
}

const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
if (!existsSync(wrangler)) {
  console.error("找不到 node_modules/wrangler。先运行 npm install。");
  process.exit(1);
}

const child = spawn(process.execPath, [wrangler, "dev", ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
