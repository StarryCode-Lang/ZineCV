import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import ts from "typescript";

async function loadModule(path, dependencies) {
  const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", code)((name) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

test("failed session writes block flush, and a later durable write recovers", async () => {
  let fail = true;
  const store = { activeId: "s", sessions: [] };
  const sessions = await loadModule("src/ui/agent/sessions.ts", {
    "../../platform/ipc": { isTauriRuntime: () => true, nativeInvoke: async (command) => {
      if (command === "bootstrap_agent_sessions") return { revision: 0, store };
      if (fail) throw new Error("disk write failed");
      return 1;
    } },
  });
  await sessions.loadAgentSessions("account");
  assert.equal(await sessions.writeAgentSessions(store, "account"), false);
  await assert.rejects(sessions.flushAgentSessionWrites(), /disk write failed/);
  fail = false;
  assert.equal(await sessions.writeAgentSessions(store, "account"), true);
  await sessions.flushAgentSessionWrites();
});

test("template catalog exposes only acknowledged data", async () => {
  let rejectWrite;
  const catalog = await loadModule("src/ui/domain/imported-template.ts", {
    "../../platform/ipc": { isTauriRuntime: () => true, nativeInvoke: async (command) => {
      if (command === "read_imported_template_catalog") return { revision: 0, payloadJson: "[]" };
      return new Promise((resolve, reject) => { rejectWrite = reject; });
    } },
  });
  await catalog.loadImportedTemplates();
  const pending = catalog.writeImportedTemplates([{ id: "unsaved", name: "not durable" }]);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(catalog.readImportedTemplates(), []);
  rejectWrite(new Error("disk full"));
  await assert.rejects(pending, /disk full/);
  assert.deepEqual(catalog.readImportedTemplates(), []);
});

test("native template previews hydrate from assets and survive a failed catalog write", async () => {
  const assetHash = "a".repeat(64);
  const revisionHash = "b".repeat(64);
  const dataUrl = "data:image/png;base64,c3ludGhldGlj";
  let failWrite = false;
  let stored = {
    revision: 4,
    payloadJson: JSON.stringify([{
      id: "asset-template",
      name: "Saved template",
      sourceName: "fixture.pdf",
      sourceType: "pdf",
      accent: "#2455a4",
      formatId: "legacy-v1",
      layout: "single-column",
      analysis: "synthetic fixture",
      previewAssetId: assetHash,
      revisionHash,
      revisionStatus: "current",
      knownRevisions: [{ revisionHash, rendererStatus: "current" }],
    }]),
  };
  const writes = [];
  const catalog = await loadModule("src/ui/domain/imported-template.ts", {
    "../../platform/ipc": {
      isTauriRuntime: () => true,
      nativeInvoke: async (command, args) => {
        if (command === "read_imported_template_catalog") return stored;
        if (command === "read_avatar_asset") return { dataUrl };
        if (command === "write_imported_template_catalog") {
          writes.push(args);
          if (failWrite) throw new Error("catalog revision conflict");
          const incoming = JSON.parse(args.payloadJson);
          stored = {
            revision: stored.revision + 1,
            payloadJson: JSON.stringify(incoming.map((template) => ({
              ...template,
              previewAssetId: assetHash,
              revisionHash,
            }))),
          };
          return stored.revision;
        }
        throw new Error(`unexpected command ${command}`);
      },
    },
  });

  await catalog.loadImportedTemplates();
  assert.equal(catalog.readImportedTemplates()[0].previewDataUrl, dataUrl);
  assert.equal(catalog.readImportedTemplates()[0].revisionHash, revisionHash);
  await catalog.writeImportedTemplates(catalog.readImportedTemplates());
  assert.equal(writes.length, 1);
  assert.equal(writes[0].expectedRevision, 4);
  assert.equal(JSON.parse(writes[0].payloadJson)[0].previewDataUrl, undefined);
  assert.equal(catalog.readImportedTemplates()[0].previewDataUrl, dataUrl);

  failWrite = true;
  const edited = catalog.readImportedTemplates().map((template) => ({
    ...template,
    name: "Unsaved rename",
  }));
  await assert.rejects(catalog.writeImportedTemplates(edited), /catalog revision conflict/);
  assert.equal(catalog.readImportedTemplates()[0].name, "Saved template");
  assert.equal(catalog.readImportedTemplates()[0].previewDataUrl, dataUrl);
});

test("history avatar reads do not replace the active avatar cache or source hash", async () => {
  const calls = [];
  const flushOrder = [];
  const document = { basic: { avatarAssetId: "current" } };
  const workspace = await loadModule("src/platform/workspace.ts", {
    "./NativeDocumentClient": { NativeDocumentClient: class {
      snapshot = { document, cursor: {} };
      async load() { return this.snapshot; }
    } },
    "./documentBridge": { snapshotFromDocument: (document, avatar) => ({ resume: { basic: { avatar } } }) },
    "./ipc": { nativeInvoke: async (command, args) => {
      calls.push({ command, args });
      return command === "read_avatar_asset" ? { dataUrl: `data:${args.hash}` } : { hash: "new", dataUrl: args.dataUrl };
    } },
    "./editorBuffers": { flushEditorBuffers: async () => { flushOrder.push("editor"); } },
  });
  await workspace.loadWorkspaceState();
  const history = await workspace.snapshotFromLoadedDocument({ basic: { avatarAssetId: "history" } });
  assert.equal(history.resume.basic.avatar, "data:history");
  await workspace.storeAvatarAsset(document, "data:current");
  assert.equal(calls.filter(({ command }) => command === "store_avatar_asset").length, 0);
  await workspace.storeAvatarAsset(document, "data:new");
  assert.equal(calls.at(-1).args.previousHash, "current");
  workspace.registerDraftFlush(async () => {
    flushOrder.push("draft");
    return { ok: true };
  });
  await workspace.flushDraftBeforeVersionAction();
  assert.deepEqual(flushOrder, ["editor", "draft"]);
});
