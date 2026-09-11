/**
 * P9: build-failing symbol scan. Fails on any network symbol, ambient filesystem write, or
 * process-execution symbol in the shipped source.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, "network: fetch"],
  [/\bXMLHttpRequest\b/, "network: XMLHttpRequest"],
  [/from\s+["']node:(http|https|net|tls|dgram|dns)["']/, "network: node transport module"],
  [/\bWebSocket\b/, "network: WebSocket"],
  [/writeFile|appendFile|mkdir|rmSync|unlink/, "ambient filesystem write"],
  [/child_process|execSync|spawn\s*\(/, "process execution"],
];

const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p);
  }
})(ROOT);

const findings: string[] = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
    for (const [re, label] of FORBIDDEN) {
      if (re.test(line)) findings.push(`${file.split("/src/")[1]}:${i + 1} ${label}`);
    }
  });
}

if (findings.length) {
  console.error("symbol scan FAILED:\n" + findings.join("\n"));
  process.exit(1);
}
console.log(`symbol scan OK — ${files.length} files, 0 forbidden symbols`);
