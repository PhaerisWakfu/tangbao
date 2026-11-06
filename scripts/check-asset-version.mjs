import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const pages = path.resolve("src/pages");
const versionedScript = /\/assets\/(app|account|desk|md)-(\d+\.\d+\.\d+)\.js/g;
const versionedQuery = /[?&]v=(\d+\.\d+\.\d+)/g;
const versions = new Set();
const queryVersions = new Set();

for (const file of await readdir(pages)) {
  if (!file.endsWith(".html")) continue;
  const text = await readFile(path.join(pages, file), "utf8");
  for (const match of text.matchAll(versionedScript)) versions.add(match[2]);
  for (const match of text.matchAll(versionedQuery)) queryVersions.add(match[1]);
}

if (!versions.size) {
  console.error("asset version: no path-versioned script found");
  process.exit(1);
}
if (versions.size > 1) {
  console.error(`asset version: mixed script versions ${[...versions].join(", ")}`);
  process.exit(1);
}
if ([...queryVersions].some((version) => !versions.has(version))) {
  console.error(`asset version: query versions ${[...queryVersions].join(", ")} do not match ${[...versions][0]}`);
  process.exit(1);
}

const version = [...versions][0];
const server = await readFile(path.resolve("src/index.ts"), "utf8");
if (!server.includes("versionedScript") || !/\\d\+\\\.\\d\+\\\.\\d\+\\\.js/.test(server)) {
  console.error("asset version: server does not accept versioned script paths");
  process.exit(1);
}

console.log(`ok asset version ${version}`);
