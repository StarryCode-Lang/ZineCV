import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compiledSources = new Map();

// Keep each module instance and dependency map isolated between test scenarios.
export async function loadModule(path, dependencies, extra = "") {
  const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const input = source + extra;
  let code = compiledSources.get(input);
  if (code === undefined) {
    code = ts.transpileModule(input, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    compiledSources.set(input, code);
  }
  const exports = {};
  new Function("require", "exports", code)((name) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
