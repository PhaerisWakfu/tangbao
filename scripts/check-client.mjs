import { readFileSync } from "node:fs";
import { Script } from "node:vm";

for (const file of ["src/client/app.txt", "src/client/desk.txt", "src/client/account.txt"]) {
  new Script(readFileSync(file, "utf8"), { filename: file });
  console.log(`ok ${file}`);
}
