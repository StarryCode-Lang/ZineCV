import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";

async function loadModule(path, dependencies) {
  const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  new Function("require", "exports", code)(name => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
const workspace = await loadModule("src/platform/workspace.ts", {
  "./NativeDocumentClient": {NativeDocumentClient: class {}}, "./ipc": {}, "./documentBridge": {}, "./editorBuffers": {},
});
const {registerDraftFlush, runDraftAuthorityAction} = workspace;
const {serializePersistAction} = await loadModule("src/platform/useNativeResumePersistence.ts", {
  react: {}, "./documentBridge": {}, "./workspace": workspace, "./ipc": {}, "../ui/agent/sessions": {},
});

test("version authority waits for preceding saves and prevents autosave during command and reload", async () => {
  const unregister = registerDraftFlush(async () => ({ok: true}), serializePersistAction);
  const events = []; let cursor = 0, releaseSave, releaseVersion;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  const versionGate = new Promise(resolve => { releaseVersion = resolve; });
  try {
    const first = serializePersistAction(async () => { events.push("save-start"); await saveGate; cursor++; events.push("save-end"); });
    const version = runDraftAuthorityAction(async () => { assert.equal(cursor, 1); events.push("version-start"); await versionGate; cursor++; events.push("reload-end"); });
    const second = serializePersistAction(async () => { assert.equal(cursor, 2); events.push("next-save"); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["save-start"]);
    releaseSave(); await first; await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ["save-start", "save-end", "version-start"]);
    releaseVersion(); await Promise.all([version, second]);
    assert.deepEqual(events, ["save-start", "save-end", "version-start", "reload-end", "next-save"]);
  } finally { releaseSave(); releaseVersion(); unregister(); }
});

test("failed authority operation releases the persistence queue without swallowing the error", async () => {
  const unregister = registerDraftFlush(async () => ({ok: true}), serializePersistAction);
  try {
    await assert.rejects(runDraftAuthorityAction(async () => { throw new Error("native CAS conflict"); }), /native CAS conflict/);
    let saved = false;
    await serializePersistAction(async () => { saved = true; });
    assert.equal(saved, true);
  } finally { unregister(); }
});
