import { loadModule } from "./module-loader.mjs";
import { test } from "node:test";
import { strict as assert } from "node:assert";


test("1001-commit graph keeps missing snapshots lazy and preserves metadata", async () => {
  let hydrated = 0;
  const { storeFromGraph, parseGraph } = await loadModule("src/platform/useNativeResumeVersions.ts", {
    react: {}, "./documentBridge": {}, "./ipc": {}, "./versionDetails": {},
    "./workspace": { snapshotFromLoadedDocument: async (document) => { hydrated++; return document; } },
  }, "\nexport { storeFromGraph, parseGraph };\n");
  const commits = Array.from({ length: 1001 }, (_, index) => ({
    id: `commit-${index}`, originBranchId: "main", parentId: index ? `commit-${index - 1}` : null,
    message: `version ${index}`, createdAt: "2020-01-01T00:00:00Z",
    snapshotDocumentJson: index < 1000 ? JSON.stringify({ title: `snapshot ${index}` }) : "",
  }));
  const store = await storeFromGraph(parseGraph({ cursor: {},
    branches: [{ id: "main", name: "main", isCurrent: true, headCommitId: "commit-0", createdAt: "" }], commits }));
  assert.equal(store.commits.length, 1001);
  assert.equal(hydrated, 1000);
  assert.equal(store.commits[1000].snapshot, null);
  assert.equal(store.commits[1000].message, "version 1000");
  assert.equal(store.currentBranchId, "main");
});

test("graph refresh reuses unchanged snapshots, but never stale replacement or other-context data", async () => {
  let hydrated = 0;
  const { storeFromGraph, parseGraph } = await loadModule("src/platform/useNativeResumeVersions.ts", {
    react: {}, "./documentBridge": {}, "./ipc": {}, "./versionDetails": {},
    "./workspace": { snapshotFromLoadedDocument: async document => { hydrated++; return { document }; } },
  }, "\nexport { storeFromGraph, parseGraph };\n");
  const raw = { cursor: { documentId: "doc", contextId: "one" },
    branches: [{ id: "main", name: "main", isCurrent: true, headCommitId: "v0", createdAt: "" }],
    commits: Array.from({ length: 1000 }, (_, index) => ({ id: `v${index}`, originBranchId: "main",
      parentId: null, message: `version ${index}`, createdAt: "2020-01-01",
      snapshotDocumentJson: JSON.stringify({ title: `snapshot ${index}` }) })) };
  let graph = parseGraph(raw), store = await storeFromGraph(graph);
  assert.equal(graph.commits.filter(commit => commit.snapshotDocument).length, 1,
    "only the native head needs a second parsed document graph");
  const original = store;
  for (let index = 0; index < 20; index++) {
    const next = parseGraph(structuredClone(raw), graph);
    store = await storeFromGraph(next, { graph, store }); graph = next;
  }
  assert.equal(hydrated, 1000, "20 refreshes must not allocate 20,000 additional snapshots");
  assert.deepEqual(store, original);
  assert.equal(store.commits[999], original.commits[999]);
  const movedHead = structuredClone(raw);
  movedHead.branches[0].headCommitId = "v999";
  let moved = parseGraph(movedHead, graph);
  const movedStore = await storeFromGraph(moved, { graph, store });
  assert.equal(moved.commits[999].snapshotDocument.title, "snapshot 999");
  assert.equal(moved.commits.filter(commit => commit.snapshotDocument).length, 1);
  assert.equal(movedStore.commits[999].snapshot, store.commits[999].snapshot);
  assert.equal(hydrated, 1000, "moving the head does not rematerialize UI snapshots");
  const lazy = structuredClone(movedHead);
  lazy.commits[998].snapshotDocumentJson = "";
  const lazyGraph = parseGraph(lazy, moved);
  const lazyStore = await storeFromGraph(lazyGraph, { graph: moved, store: movedStore });
  assert.equal(lazyStore.commits[998].snapshot, null, "an unmaterialized commit must not reuse stale UI content");
  const changed = structuredClone(raw);
  changed.commits[0].snapshotDocumentJson = JSON.stringify({ title: "replaced same ID" });
  changed.commits[1].message = "metadata changed";
  let next = parseGraph(changed, graph);
  const replaced = await storeFromGraph(next, { graph, store });
  assert.equal(hydrated, 1001);
  assert.equal(replaced.commits[0].snapshot.document.title, "replaced same ID");
  assert.equal(replaced.commits[1].message, "metadata changed");
  assert.equal(replaced.commits[1].snapshot, store.commits[1].snapshot);
  const otherContext = structuredClone(changed);
  otherContext.cursor.contextId = "other";
  graph = next; next = parseGraph(otherContext, graph);
  await storeFromGraph(next, { graph, store: replaced });
  assert.equal(hydrated, 2001, "a different editing context must hydrate afresh");
});

test("detail loads only requested snapshot, backup hydrates missing items sequentially", async () => {
  const calls = [];
  let active = 0;
  let peak = 0;
  const workspace = { nativeClient: { currentSessionEpoch: 1, snapshot: { cursor: {
    documentId: "doc", contextId: "a", branchId: "main", headId: "cached", revision: "1",
  } } },
    snapshotFromLoadedDocument: async (document) => document };
  const details = await loadModule("src/platform/versionDetails.ts", {
    "./workspace": workspace,
    "./ipc": { nativeInvoke: async (command, args) => {
      calls.push([command, args]); peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { id: args.commitId, snapshotDocumentJson: JSON.stringify({ title: args.commitId }) };
    } },
  });
  assert.deepEqual(await details.loadCommitDetail("older"), { title: "older" });
  assert.deepEqual(calls[0], ["version_commit_detail", { commitId: "older" }]);
  const complete = { id: "cached", snapshot: { title: "cached" } };
  const result = await details.materializeVersionStore({ currentBranchId: "main",
    branches: [{ id: "main", headCommitId: "cached" }], commits: [complete,
    { id: "old-a", snapshot: null }, { id: "old-b", snapshot: null }] });
  assert.equal(result.commits[0], complete);
  assert.deepEqual(result.commits[2].snapshot, { title: "old-b" });
  assert.equal(peak, 1);
  assert.equal(calls.length, 3);
});

test("backup rejects same-context revision changes during asynchronous detail reads", async () => {
  const nativeClient = { currentSessionEpoch: 1, snapshot: { cursor: {
    documentId: "doc", contextId: "a", branchId: "main", headId: "cached", revision: "1",
  } } };
  const details = await loadModule("src/platform/versionDetails.ts", {
    "./workspace": { nativeClient, snapshotFromLoadedDocument: async (document) => document },
    "./ipc": { nativeInvoke: async (_command, args) => {
      await new Promise((resolve) => setImmediate(resolve));
      nativeClient.snapshot.cursor.revision = "2";
      return { id: args.commitId, snapshotDocumentJson: "{}" };
    } },
  });
  const store = { currentBranchId: "main", branches: [{ id: "main", headCommitId: "cached" }],
    commits: [{ id: "cached", snapshot: {} }, { id: "old", snapshot: null }] };
  await assert.rejects(details.materializeVersionStore(store), /版本库已变化/);
});

test("backup rejects a graph whose current branch head does not match the authority cursor", async () => {
  const details = await loadModule("src/platform/versionDetails.ts", {
    "./workspace": { nativeClient: { currentSessionEpoch: 1, snapshot: { cursor: {
      documentId: "doc", contextId: "a", branchId: "main", headId: "new-head", revision: "2",
    } } } }, "./ipc": {},
  });
  await assert.rejects(details.materializeVersionStore({ currentBranchId: "main",
    branches: [{ id: "main", headCommitId: "old-head" }],
    commits: [{ id: "old-head", snapshot: {} }] }), /版本库已变化/);
});

test("detail rejects malformed replies and stale editing contexts", async () => {
  const nativeClient = { currentSessionEpoch: 1, snapshot: { cursor: { contextId: "a" } } };
  let response = { id: "wrong", snapshotDocumentJson: "{}" };
  let changeContext = false;
  const details = await loadModule("src/platform/versionDetails.ts", {
    "./workspace": { nativeClient, snapshotFromLoadedDocument: async (document) => document },
    "./ipc": { nativeInvoke: async () => {
      if (changeContext) nativeClient.currentSessionEpoch++;
      return response;
    } },
  });
  await assert.rejects(details.loadCommitDetail("old"), /版本详情无效/);
  response = { id: "old", snapshotDocumentJson: "" };
  await assert.rejects(details.loadCommitDetail("old"), /版本详情无效/);
  response = { id: "old", snapshotDocumentJson: "{}" };
  changeContext = true;
  await assert.rejects(details.loadCommitDetail("old"), /工作区已切换/);
});
