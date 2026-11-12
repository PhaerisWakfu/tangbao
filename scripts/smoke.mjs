// Keep the old entry point as an alias of the current, isolated end-to-end suite.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const child = spawn(process.execPath, [fileURLToPath(new URL("./local-sandbox.mjs", import.meta.url)), "verify", ...process.argv.slice(2)], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
