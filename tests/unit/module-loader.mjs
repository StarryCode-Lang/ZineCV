import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Keep each module instance and dependency map isolated between test scenarios.
export async function loadModule(path, dependencies, extra = "") {
  const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
