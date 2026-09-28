import { test } from "node:test";
import { strict as assert } from "node:assert";
import { NativeDocumentClient } from "../../src/bridge/NativeDocumentClient.ts";

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
  const invoke = async (command, args) => {
    if (command === "document_state") return initialState();
    envelopes.push(structuredClone(args.envelope));
    if (envelopes.length === 1) throw new Error("transport lost acknowledgement");
    return receipt(args.envelope);
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
  const invoke = async (command, args) => {
    if (command === "document_state") return initialState();
    envelopes.push(structuredClone(args.envelope));
    return receipt(args.envelope, durable);
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
