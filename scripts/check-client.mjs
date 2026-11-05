import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Script } from "node:vm";

for (const file of ["src/client/app.txt", "src/client/desk.txt", "src/client/account.txt", "src/client/md.txt", "src/client/sw.txt", "src/client/modal.txt", "src/client/messages.txt"]) {
  new Script(readFileSync(file, "utf8"), { filename: file });
  console.log(`ok ${file}`);
}

for (const name of readdirSync("src/pages").filter(name => name.endsWith(".html")).sort()) {
  const file = path.join("src/pages", name);
  let index = 0;
  for (const match of readFileSync(file, "utf8").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1];
    if (/(?:^|\s)src\s*=/i.test(attributes)) continue;
    const typeAttribute = attributes.match(/(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const type = (typeAttribute?.[1] || typeAttribute?.[2] || typeAttribute?.[3] || "").toLowerCase();
    if (type && !["text/javascript", "application/javascript", "module"].includes(type)) continue;
    const filename = `${file}:inline-${++index}`;
    if (type === "module") {
      const result = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: match[2], encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new SyntaxError(`${filename}\n${result.stderr}`);
    } else {
      new Script(match[2], { filename });
    }
    console.log(`ok ${filename}`);
  }
}
