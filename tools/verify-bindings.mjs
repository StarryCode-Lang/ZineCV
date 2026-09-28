import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bindings = join(root, "src-tauri", "src", "domain", "bindings");
const status = spawnSync("git", ["status", "--porcelain", "--", "src-tauri/src/domain/bindings"], { cwd: root, encoding: "utf8", windowsHide: true });
if (status.error) throw status.error;
if (status.status !== 0 || status.stdout.trim()) {
  process.stderr.write(status.stdout);
  throw new Error("Generated domain bindings drifted from committed files");
}

const files = readdirSync(bindings).filter((name) => name.endsWith(".ts")).map((name) => join(bindings, name));
if (files.length === 0) throw new Error("No generated domain bindings found");
const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict", "--module", "esnext", "--moduleResolution", "bundler", "--target", "es2022", ...files], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`TypeScript binding validation failed: ${result.status}`);
console.log(`Verified ${files.length} generated domain bindings; no drift.`);