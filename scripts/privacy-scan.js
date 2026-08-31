import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = new URL("../", import.meta.url);
const allowed = new Set([".js", ".json", ".md", ".yml", ".yaml", ".svg"]);
const excluded = new Set(["scripts/privacy-scan.js", "LICENSE", "package-lock.json"]);
const terms = [
  ["household-specific tariff label", ["my", "SCE"].join("")],
  ["absolute Windows user path", ["C:", "\\", "Users", "\\"].join("")],
];

async function walk(url) {
  const entries = await readdir(url, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, url);
    if (entry.isDirectory()) files.push(...await walk(child));
    else files.push(child);
  }
  return files;
}

const findings = [];
for (const url of await walk(root)) {
  const path = relative(new URL("../", import.meta.url).pathname, url.pathname).replaceAll("\\", "/").replace(/^\//, "");
  if (excluded.has(path) || !allowed.has(extname(path))) continue;
  const content = await readFile(url, "utf8");
  for (const [label, term] of terms) if (content.toLowerCase().includes(term.toLowerCase())) findings.push(`${path}: ${label}`);
  if (/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/.test(content)) findings.push(`${path}: private IP address`);
  if (/(?:api[_-]?key|token|secret|password)\s*[:=]\s*["'][^"']{8,}/i.test(content)) findings.push(`${path}: possible embedded secret`);
}
if (findings.length) { console.error(findings.join("\n")); process.exit(1); }
console.log("Privacy scan passed");
