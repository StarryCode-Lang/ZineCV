import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Rust owns the schema; TS is checked for consistency, not historical bytes.
export async function inspectBindings(root) {
  const directory = join(root, "src-tauri/src/domain/bindings");
  const names = (await readdir(directory)).filter(name => name.endsWith(".ts")).sort();
  if (!names.length) throw new Error("No domain bindings found");
  const known = new Set(names);
  for (const name of names) {
    const source = await readFile(join(directory, name), "utf8");
    if (!/export\s+(?:type|interface|enum)\s+\w+/.test(source)) throw new Error(`Missing binding export: ${name}`);
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const reference = match[1];
      if (!reference.startsWith("./") || !known.has(`${reference.slice(2).replace(/\.[cm]?[jt]s$/, "")}.ts`)) {
        throw new Error(`Unresolved binding import in ${name}: ${reference}`);
      }
    }
  }
  return names.map(name => join(directory, name));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== undefined && mode !== "--structure") throw new Error("Usage: node tools/verify-bindings.mjs [--structure]");
  const root = resolve(import.meta.dirname, "..");
  const files = await inspectBindings(root);
  if (mode !== "--structure") {
    const compiler = join(root, "node_modules/typescript/bin/tsc");
    const result = spawnSync(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict", "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", ...files], { cwd: root, stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`TypeScript binding validation failed: ${result.status}`);
  }
  console.log(`Verified ${files.length} domain bindings (${mode === "--structure" ? "structure only; type check not run" : "structure and strict types"}); no fixed hash baseline.`);
}
