// Copy the Pyodide files the static site needs into <out>/pyodide/, so the site does not load
// them from a CDN: the Pyodide core from node_modules, and the PyYAML wheel (not in the npm
// package), downloaded once from the Pyodide release and checked against its lock file.
//
//   node scripts/copy-pyodide.mjs dist
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../node_modules/pyodide");
const cache = resolve(here, "../.pyodide-cache");
const CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const PACKAGES = ["pyyaml"];

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/copy-pyodide.mjs <out folder>");
  process.exit(2);
}
const target = resolve(out, "pyodide");
await mkdir(target, { recursive: true });

const { version } = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(source, "pyodide-lock.json"), "utf8"));
for (const name of CORE) await copyFile(join(source, name), join(target, name));

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
for (const name of PACKAGES) {
  const entry = lock.packages[name];
  if (!entry) throw new Error(`${name} is not in Pyodide ${version}`);
  if (entry.depends.length) throw new Error(`${name} needs ${entry.depends.join(", ")}; add them to PACKAGES`);
  const cached = join(cache, version, entry.file_name);
  if (!existsSync(cached)) {
    const url = `https://cdn.jsdelivr.net/pyodide/v${version}/full/${entry.file_name}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${url}: ${response.status}`);
    await mkdir(dirname(cached), { recursive: true });
    await writeFile(cached, Buffer.from(await response.arrayBuffer()));
  }
  const data = await readFile(cached);
  if (sha256(data) !== entry.sha256) throw new Error(`${entry.file_name} does not match the Pyodide lock file`);
  await writeFile(join(target, entry.file_name), data);
}
console.log(`Pyodide ${version} copied to ${target}`);
