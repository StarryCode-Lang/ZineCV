import { test } from "node:test";
import { strict as assert } from "node:assert";
import { NativeDocumentClient } from "../../src/platform/NativeDocumentClient.ts";

function initialState() {
  return {
    cursor: {
      documentId: "doc-1", contextId: "context-1", revision: "0",
      branchId: "main", headId: null,
    },
    document: {
      schemaVersion: 2, documentId: "doc-1", title: "原标题", basic: {},
      sections: [], presentation: {}, sourceRef: null, legacyExtensions: {},
    },
  };
}

function receipt(envelope, durable = true) {
  return {
    commandId: envelope.commandId,
    cursor: { ...initialState().cursor, revision: String(Number(envelope.expectedRevision) + 1) },
    durable,
    snapshotHash: "fixture-hash",
    document: { ...initialState().document, title: envelope.payload.title },
    changedIds: ["doc-1"],
  };
}

test("reselecting the active editing source accepts only an unchanged no-op receipt", async () => {
  const state = initialState();
  let changed = false;
  const client = new NativeDocumentClient(async command => command === "document_state"
    ? structuredClone(state)
    : { ...structuredClone(state), created: false, document: { ...state.document, title: changed ? "unacknowledged" : state.document.title } });
  await client.load();
  const request = { expectedCursor: state.cursor, sourceKind: "imported_template", sourceId: "active", initialDocument: state.document };
  const result = await client.switchEditingContext(request);
  assert.equal(result.created, false);
  assert.deepEqual(client.snapshot, state);
  assert.equal(client.saveStatus, "saved");
  changed = true;
  await assert.rejects(client.switchEditingContext(request), /invalid context switch/);
  assert.deepEqual(client.snapshot, state);
});

test("serializes commands against the latest durable cursor", async () => {
  const envelopes = [];
  let releaseFirst;
  const firstAck = new Promise((resolve) => { releaseFirst = resolve; });
  const invoke = async (command, args) => {
    if (command === "document_state") return initialState();
    assert.equal(command, "apply_document_command");
    envelopes.push(args.envelope);
    if (envelopes.length === 1) await firstAck;
    return receipt(args.envelope);
  };
  let sequence = 0;
  const client = new NativeDocumentClient(invoke, () => `command-${++sequence}`);
  await client.load();
  const first = client.submit({ type: "setDocumentTitle", title: "第一版" });
  const second = client.submit({ type: "setDocumentTitle", title: "第二版" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(envelopes.length, 1);
  assert.equal(client.saveStatus, "saving");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(envelopes.map((item) => item.expectedRevision), ["0", "1"]);
  assert.deepEqual(envelopes.map((item) => item.commandId), ["command-1", "command-2"]);
  assert.equal((await client.flush()).document.title, "第二版");
  assert.equal(client.saveStatus, "saved");
});

test("lost ack keeps the exact command for retry and does not report saved", async () => {
  const envelopes = [];
  let state = initialState();
  const invoke = async (command, args) => {
    if (command === "document_state") return state;
    envelopes.push(structuredClone(args.envelope));
    const result = receipt(args.envelope);
    state = { cursor: result.cursor, document: result.document };
    if (envelopes.length === 1) throw new Error("transport lost acknowledgement");
    return result;
  };
  const client = new NativeDocumentClient(invoke, () => "stable-id");
  await client.load();
  await assert.rejects(client.submit({ type: "setDocumentTitle", title: "保留输入" }), /acknowledgement/);
  await assert.rejects(client.flush(), /acknowledgement/);
  assert.equal(client.snapshot.document.title, "原标题");
  assert.equal(client.saveStatus, "failed");
  await client.retryFailed();
  assert.deepEqual(envelopes[1], envelopes[0]);
  assert.equal(client.snapshot.document.title, "保留输入");
  assert.equal(client.saveStatus, "saved");
});

test("missing durable ack blocks later commands without losing the pending request", async () => {
  const envelopes = [];
  let durable = false;
  let state = initialState();
  const invoke = async (command, args) => {
    if (command === "document_state") return state;
    envelopes.push(structuredClone(args.envelope));
    const result = receipt(args.envelope, durable);
    if (durable) state = { cursor: result.cursor, document: result.document };
    return result;
  };
  let sequence = 0;
  const client = new NativeDocumentClient(invoke, () => `command-${++sequence}`);
  client.subscribe(() => { throw new Error("observer failure"); });
  await client.load();
  const first = client.submit({ type: "setDocumentTitle", title: "未确认" });
  const second = client.submit({ type: "setDocumentTitle", title: "后续编辑" });
  await assert.rejects(first, /durable/);
  await assert.rejects(second, /durable/);
  assert.equal(envelopes.length, 1);
  assert.equal(client.snapshot.cursor.revision, "0");
  durable = true;
  await client.retryFailed();
  assert.deepEqual(envelopes[1], envelopes[0]);
  assert.equal(client.snapshot.cursor.revision, "1");
  await client.submit({ type: "setDocumentTitle", title: "重新发起" });
  assert.equal(envelopes[2].expectedRevision, "1");
  assert.equal(client.saveStatus, "saved");
});

test("retry acknowledges the old receipt and preserves a later durable edit", async () => {
  let state = initialState();
  let original;
  const envelopes = [];
  const client = new NativeDocumentClient(async (command, args) => {
    if (command === "document_state") return state;
    envelopes.push(structuredClone(args.envelope));
    if (!original) {
      original = receipt(args.envelope);
      state = { cursor: original.cursor, document: original.document };
      throw new Error("lost ack");
    }
    return original;
  }, () => "lost-command");
  await client.load();
  await assert.rejects(client.submit({ type: "setDocumentTitle", title: "第一版" }), /lost ack/);
  state = { cursor: { ...state.cursor, revision: "2" }, document: { ...state.document, title: "另一窗口后续编辑" } };
  await client.retryFailed();
  assert.deepEqual(envelopes[0], envelopes[1]);
  assert.equal(client.snapshot.cursor.revision, "2");
  assert.equal(client.snapshot.document.title, "另一窗口后续编辑");
  assert.equal(client.saveStatus, "saved");
});

test("failed context switch preserves the current context and can be retried", async () => {
  let fail = true;
  const state = initialState();
  const calls = [];
  const client = new NativeDocumentClient(async (command, args) => {
    if (command === "document_state") return state;
    assert.equal(command, "switch_editing_context");
    calls.push(args.request);
    if (fail) throw new Error("context store busy");
    return {
      cursor: { ...state.cursor, contextId: "source-b", revision: "1" },
      document: { ...state.document, title: "B 草稿" },
      created: false,
    };
  });
  await client.load();
  const request = {
    expectedCursor: state.cursor,
    sourceKind: "imported_template",
    sourceId: "source-b-id",
    initialDocument: state.document,
  };

  await assert.rejects(client.switchEditingContext(request), /context store busy/);
  assert.equal(client.snapshot.cursor.contextId, "context-1");
  assert.equal(client.snapshot.document.title, "原标题");
  assert.equal(client.saveStatus, "idle");

  fail = false;
  const switched = await client.switchEditingContext(request);
  assert.equal(switched.created, false);
  assert.equal(client.snapshot.cursor.contextId, "source-b");
  assert.equal(client.snapshot.document.title, "B 草稿");
  assert.equal(client.currentSessionEpoch, 2);
  assert.equal(calls.length, 2);
});

test("reload advances the context epoch when history activates another source", async () => {
  let state = initialState();
  const client = new NativeDocumentClient(async (command) => {
    assert.equal(command, "document_state");
    return state;
  });
  await client.load();
  state = {
    cursor: { ...state.cursor, contextId: "source-b", revision: "1" },
    document: { ...state.document, title: "历史里的来源 B" },
  };
  const reloaded = await client.reload();
  assert.equal(client.currentSessionEpoch, 1);
  assert.equal(reloaded.cursor.contextId, "source-b");
  assert.equal(client.snapshot.document.title, "历史里的来源 B");
});

test("import lost acknowledgement retries the identical atomic request", async () => {
  let state = initialState();
  const requests = [];
  const invoke = async (command, args) => {
    if (command === "document_state") return state;
    assert.equal(command, "apply_import");
    requests.push(structuredClone(args.request));
    const request = args.request;
    const result = {
      commandId: request.commandId,
      cursor: { ...request.cursor, revision: String(Number(request.cursor.revision) + 1) },
      durable: true,
      snapshotHash: "import-fixture-hash",
      document: { ...initialState().document, basic: { name: "导入姓名" } },
      changedIds: request.acceptedCandidateIds,
    };
    state = { cursor: result.cursor, document: result.document };
    if (requests.length === 1) throw new Error("import acknowledgement lost");
    return result;
  };
  const client = new NativeDocumentClient(invoke, () => "import-command-stable");
  await client.load();
  const target = client.snapshot.cursor;
  await assert.rejects(
    client.applyImport("import-draft-1", ["candidate-1"], target),
    /acknowledgement lost/,
  );
  assert.equal(client.snapshot.cursor.revision, "0");
  await client.retryFailed();
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(client.snapshot.cursor.revision, "1");
  assert.equal(client.snapshot.document.basic.name, "导入姓名");
});

test("an import parsed against an old editing cursor cannot target a switched source", async () => {
  let state = initialState();
  const applied = [];
  const client = new NativeDocumentClient(async (command, args) => {
    if (command === "document_state") return state;
    if (command === "switch_editing_context") {
      state = {
        cursor: { ...state.cursor, contextId: "source-b", revision: "1" },
        document: { ...state.document, title: "来源 B" },
      };
      return { ...state, created: false };
    }
    if (command === "apply_import") applied.push(args.request);
    throw new Error(`unexpected native command: ${command}`);
  });
  await client.load();
  const parsedAgainst = client.snapshot.cursor;
  await client.switchEditingContext({
    expectedCursor: parsedAgainst,
    sourceKind: "imported_template",
    sourceId: "source-b",
    initialDocument: client.snapshot.document,
  });
  await assert.rejects(
    client.applyImport("import-draft-2", ["candidate-2"], parsedAgainst),
    /target changed after the candidates were prepared/,
  );
  assert.deepEqual(applied, []);
  assert.equal(client.snapshot.cursor.contextId, "source-b");
  assert.equal(client.snapshot.document.title, "来源 B");
});
