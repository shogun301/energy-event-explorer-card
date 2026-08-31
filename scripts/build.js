import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const engine = (await readFile(resolve(root, "src/engine.js"), "utf8")).replace(/^export\s+/gm, "");
const cards = (await readFile(resolve(root, "src/cards.js"), "utf8"))
  .replace(/^import .*?;\r?\n/m, "")
  .replace(/^export\s+/gm, "");
const banner = `/* Energy Event Explorer Card v${packageJson.version} | Apache-2.0 */\n`;
const output = `${banner}${engine.trim()}\n\n${cards.trim()}\n`;
const destination = resolve(root, "dist/energy-event-explorer-card.js");
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, output, "utf8");
console.log(`Built dist/energy-event-explorer-card.js (${Buffer.byteLength(output)} bytes)`);
