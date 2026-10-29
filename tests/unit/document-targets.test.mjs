import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeDocumentClient, sameCursor } from "../../src/platform/NativeDocumentClient.ts";
import { loadModule } from "./module-loader.mjs";

function state(id = "A", epoch = 7) {
  return {
    cursor: { documentId: id, contextId: "workspace-default-context", branchId: "main", headId: null, revision: "0" },
    document: { schemaVersion: 2, documentId: id, title: id, basic: {}, sections: [], presentation: {}, sourceRef: null, legacyExtensions: {} },
    epoch,
  };
}

function request(id, current = "A", epoch = 7n) {
  return { expectedEpoch: epoch, expectedCurrentId: current, targetDocumentId: id };
}

function host() {
  let active = state();
  const writes = [];
  const invoke = async (name, args) => {
    if (name === "document_state") return structuredClone(active);
    if (name === "switch_active_document") {
      active = state(args.request.targetDocumentId, active.epoch + 1);
      return { ...structuredClone(active), documentId: active.cursor.documentId, meta: {} };
    }
    if (name === "document_create") {
      active = state(`doc:${args.request.commandId}`, active.epoch + 1);
      active.document.title = "created";
      return { receipt: { commandId: args.request.commandId, documentId: active.cursor.documentId }, activeState: structuredClone(active) };
    }
    assert.equal(name, "apply_document_command");
    writes.push(args.envelope);
    active = { ...active, cursor: { ...active.cursor, revision: String(Number(active.cursor.revision) + 1) },
      document: { ...active.document, title: args.envelope.payload.title } };
    return { ...structuredClone(active), commandId: args.envelope.commandId, durable: true, changedIds: [], snapshotHash: "fixture" };
  };
  return { invoke, writes };
}

test("a save queued behind a document switch cannot acquire the destination identity", async () => {
  const service = host();
  const client = new NativeDocumentClient(service.invoke);
  await client.load();
  const switching = client.switchDocument(request("B"));
  const oldSave = client.submit({ type: "setDocumentTitle", title: "A late edit" });
  await switching;
  await assert.rejects(oldSave, /target|stale|changed/i);
  assert.equal(service.writes.length, 0);
  assert.equal(client.snapshot.document.title, "B");
  assert.equal(client.saveStatus, "saved");
});

test("a save queued behind creation stays bound to its original document", async () => {
  const service = host();
  const client = new NativeDocumentClient(service.invoke);
  await client.load();
  const creating = client.createDocument({ commandId: "new-document", expectedCurrentId: "A", expectedEpoch: 7n, payload: { kind: "blank", initialTitle: "created" } });
  const oldSave = client.submit({ type: "setDocumentTitle", title: "A late edit" });
  await creating;
  await assert.rejects(oldSave, /target|stale|changed/i);
  assert.equal(service.writes.length, 0);
  assert.equal(client.snapshot.document.title, "created");
});

test("a lost creation acknowledgement retries the exact identity and accepts the durable receipt once", async () => {
  const requests = [];
  let active = state();
  const client = new NativeDocumentClient(async (name, args) => {
    if (name === "document_state") return active;
    assert.equal(name, "document_create");
    requests.push(structuredClone(args.request));
    assert.equal(typeof args.request.expectedEpoch, "number");
    if (requests.length === 1) {
      active = state("doc:create-retry", 8);
      throw new Error("acknowledgement lost");
    }
    return { receipt: { commandId: "create-retry", documentId: "doc:create-retry" }, activeState: active };
  });
  await client.load();
  const request = { commandId: "create-retry", expectedCurrentId: "A", expectedEpoch: 7n, payload: { kind: "blank", initialTitle: "retry" } };
  await assert.rejects(client.createDocument(request), /lost/);
  assert.equal(client.snapshot.cursor.documentId, "A");
  await client.createDocument(request);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(client.snapshot.cursor.documentId, "doc:create-retry");
});

test("a replayed creation receipt with no active state cannot reclaim the active document", async () => {
  const client = new NativeDocumentClient(async name => name === "document_state" ? state("B", 9)
    : { receipt: { commandId: "old-create", documentId: "doc:old-create" }, activeState: null });
  await client.load();
  await client.createDocument({ commandId: "old-create", expectedCurrentId: "A", expectedEpoch: 7n,
    payload: { kind: "duplicate", sourceDocumentId: "A", initialTitle: "copy" } });
  assert.equal(client.snapshot.cursor.documentId, "B");
});

test("a captured target remains stale after A to B to A with identical context and branch IDs", async () => {
  const service = host();
  const client = new NativeDocumentClient(service.invoke);
  await client.load();
  const target = client.captureTarget();
  await client.switchDocument(request("B"));
  await client.switchDocument(request("A", "B", 8n));
  await assert.rejects(client.submit({ type: "setDocumentTitle", title: "old A" }, target), /target|stale|changed/i);
  assert.equal(service.writes.length, 0);
  assert.equal(client.snapshot.document.title, "A");
});

test("switch receipts must agree on requested document, cursor and content identities", async () => {
  const client = new NativeDocumentClient(async name => name === "document_state" ? state()
    : { ...state("C", 8), documentId: "B", meta: {} });
  await client.load();
  await assert.rejects(client.switchDocument(request("B")), /invalid|target|identity/i);
  assert.equal(client.snapshot.document.documentId, "A");
});

test("switch epochs use an exact JSON-safe transport number and reject unsafe counters", async () => {
  const service = host();
  const client = new NativeDocumentClient(async (name, args) => {
    if (name === "switch_active_document") {
      assert.equal(args.request.expectedEpoch, 7);
      assert.doesNotThrow(() => JSON.stringify(args));
    }
    return service.invoke(name, args);
  });
  await client.load();
  await client.switchDocument(request("B"));
  await assert.rejects(client.switchDocument(request("A", "B", 9007199254740993n)), /epoch|counter|integer/i);
  assert.equal(client.snapshot.document.documentId, "B");
});

test("reload invalidates the session when another document has identical context and branch IDs", async () => {
  let active = state();
  const client = new NativeDocumentClient(async () => structuredClone(active));
  await client.load();
  const target = client.captureTarget();
  active = state("B", 8);
  await client.reload();
  assert.throws(() => client.assertTarget(target), /target|changed/i);
  assert.notEqual(client.currentSessionEpoch, target.sessionEpoch);
});

test("an older load reply cannot overwrite a newer host epoch", async () => {
  const replies = [];
  const client = new NativeDocumentClient(() => new Promise(resolve => replies.push(resolve)));
  const first = client.load();
  const second = client.load();
  replies[1](state("B", 8));
  await second;
  replies[0](state("A", 7));
  await assert.rejects(first, /stale|epoch/i);
  assert.equal(client.snapshot.document.documentId, "B");
});

function loadWorkspace(invoke) {
  return loadModule("src/platform/workspace.ts", {
    "./NativeDocumentClient": { NativeDocumentClient, sameCursor },
    "./ipc": { nativeInvoke: invoke },
    "./documentBridge": { snapshotFromDocument: (document, avatar) => ({ documentId: document.documentId, resume: { basic: { avatar } } }) },
    "./editorBuffers": { flushEditorBuffers: async () => {} },
  });
}

test("a delayed avatar hydration cannot display A after a same-context reload into B", async () => {
  let active = state();
  active.document.basic.avatarAssetId = "avatar-a";
  let readStarted, completeRead;
  const started = new Promise(resolve => { readStarted = resolve; });
  const reading = new Promise(resolve => { completeRead = resolve; });
  const workspace = await loadWorkspace(async name => {
    if (name === "document_state") return structuredClone(active);
    assert.equal(name, "read_avatar_asset");
    readStarted();
    return reading;
  });
  const loading = workspace.loadWorkspaceState();
  await started;
  active = state("B", 8);
  await workspace.nativeClient.reload();
  completeRead({ dataUrl: "data:avatar-a" });
  await assert.rejects(loading, /inactive|stale/i);
  assert.equal(workspace.nativeClient.snapshot.document.documentId, "B");
});

test("late avatar storage neither updates B nor poisons its asset cache", async () => {
  const service = host();
  let beginStore, completeStore;
  const started = new Promise(resolve => { beginStore = resolve; });
  const storing = new Promise(resolve => { completeStore = resolve; });
  const calls = [];
  const workspace = await loadWorkspace(async (name, args) => {
    if (name !== "store_avatar_asset") return service.invoke(name, args);
    calls.push(args);
    if (calls.length === 1) { beginStore(); return storing; }
    return { hash: "asset-b", dataUrl: args.dataUrl };
  });
  await workspace.loadWorkspaceState();
  const pending = workspace.storeAvatarAsset(workspace.nativeClient.snapshot.document, "data:shared-avatar");
  await started;
  await workspace.nativeClient.switchDocument(request("B"));
  completeStore({ hash: "asset-a", dataUrl: "data:shared-avatar" });
  await assert.rejects(pending, /target|changed/i);
  const fresh = await workspace.storeAvatarAsset(workspace.nativeClient.snapshot.document, "data:shared-avatar");
  assert.equal(calls.length, 2, "the late A response must not become B's acknowledged cache");
  assert.equal(calls[1].cursor.documentId, "B");
  assert.equal(fresh.basic.avatarAssetId, "asset-b");
});

test("the persistence loop rechecks its captured target after asynchronous asset work", async () => {
  const service = host();
  const client = new NativeDocumentClient(service.invoke);
  await client.load();
  const target = client.captureTarget();
  let beginAsset, finishAsset;
  const started = new Promise(resolve => { beginAsset = resolve; });
  const pendingAsset = new Promise(resolve => { finishAsset = resolve; });
  const persistence = await loadModule("src/platform/useNativeResumePersistence.ts", {
    react: {},
    "./documentBridge": {
      documentFromSnapshot: (snapshot, documentId) => ({ ...state(documentId).document, title: snapshot.title }),
      documentsEqual: (a, b) => a.documentId === b.documentId && a.title === b.title,
      nextDocumentCommand: (_a, b) => ({ type: "setDocumentTitle", title: b.title }),
    },
    "./workspace": { nativeClient: client, storeAvatarAsset: async document => { beginAsset(); await pendingAsset; return document; } },
    "./ipc": {}, "../ui/agent/sessions": {},
  }, "\nexport { runPersist };\n");
  const saving = persistence.runPersist({ title: "A changed", resume: { basic: { avatar: "data:a" } } }, target);
  await started;
  await client.switchDocument(request("B"));
  finishAsset();
  await assert.rejects(saving, /target|changed/i);
  assert.equal(service.writes.length, 0);
  assert.equal(client.snapshot.document.title, "B");
});
