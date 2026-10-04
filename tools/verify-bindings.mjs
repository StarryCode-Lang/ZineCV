import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bindings = join(root, "src-tauri", "src", "domain", "bindings");
const manifestPath = join(root, "contracts", "ts-bindings-sha256.json");
const fileNames = readdirSync(bindings).filter((name) => name.endsWith(".ts")).sort();
const files = fileNames.map((name) => join(bindings, name));
if (files.length === 0) throw new Error("No generated domain bindings found");
const hashes = Object.fromEntries(await Promise.all(fileNames.map(async (name) => {
  const contents = await readFile(join(bindings, name));
  return [name, createHash("sha256").update(contents).digest("hex")];
})));
if (process.argv[2] === "--update") {
  await writeFile(manifestPath, `${JSON.stringify({ generatedBy: "Rust ts-rs exports", sha256: hashes }, null, 2)}\n`);
  console.log(`Updated Rust binding hash manifest for ${fileNames.length} files.`);
} else {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Binding hash manifest is missing or invalid: ${error.message}`);
  }
  const expected = JSON.stringify(manifest.sha256);
  const actual = JSON.stringify(hashes);
  if (expected !== actual) {
    const changed = [...new Set([...Object.keys(manifest.sha256 ?? {}), ...fileNames])]
      .filter((name) => manifest.sha256?.[name] !== hashes[name]);
    throw new Error(`Generated Rust bindings drifted from contracts/ts-bindings-sha256.json: ${changed.join(", ")}`);
  }
}
const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict", "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", ...files], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`TypeScript binding validation failed: ${result.status}`);
console.log(`Verified ${files.length} generated domain bindings; no drift.`);
