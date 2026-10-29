import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeDocumentClient, sameCursor } from "../../src/platform/NativeDocumentClient.ts";
import { loadModule } from "./module-loader.mjs";

const state = (id, epoch) => ({
  cursor: { documentId: id, contextId: "same-context", branchId: "main", headId: null, revision: "0" },
  document: { schemaVersion: 2, documentId: id }, epoch,
});

async function scenario(invoke) {
  let active = state("A", 7);
  const client = new NativeDocumentClient(async (command, args) => {
    if (command === "document_state") return active;
    if (command === "switch_active_document") {
      active = state(args.request.targetDocumentId, active.epoch + 1);
      return { ...active, documentId: active.cursor.documentId, meta: {} };
    }
    throw new Error(`Unexpected client command ${command}`);
  });
  await client.load();
  const jobs = await loadModule("src/platform/jobs.ts", {
    "./ipc": { nativeInvoke: invoke },
    "./workspace": {
      nativeClient: client,
      captureDocumentHostTarget: () => ({ ...client.captureTarget(), hostEpoch: Number(client.snapshot.epoch) }),
    },
  });
  return { jobs, client, switchTo: async (id) => client.switchDocument({
    targetDocumentId: id, expectedCurrentId: client.snapshot.cursor.documentId, expectedEpoch: BigInt(client.snapshot.epoch),
  }) };
}

test("job writes retain the exact command, material revision and numeric epoch after a lost acknowledgement", async () => {
  const requests = [];
  const { jobs } = await scenario(async (command, args) => {
    assert.equal(command, "job_material_save");
    requests.push(structuredClone(args.request));
    JSON.stringify(args);
    if (requests.length === 1) throw new Error("ack lost");
    return { id: "job:saved", documentId: "A", revision: 2 };
  });
  const material = { id: "job:old", documentId: "A", revision: 1 };
  const input = { title: "Engineer", company: "Company", jobDescription: "TypeScript", sourceNote: "pasted" };
  const save = jobs.prepareJobSave(input, material);
  input.title = "changed after click"; material.revision = 99;
  await assert.rejects(save(), /lost/);
  await save();
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].title, "Engineer");
  assert.equal(requests[1].jobMaterial.revision, 1);
  assert.equal(requests[1].expectedEpoch, 7);
});

test("prepared job saves, deletes and unlink operations remain stale after A to B to A", async () => {
  const calls = [];
  const { jobs, switchTo } = await scenario(async (...args) => { calls.push(args); });
  const actions = [jobs.prepareJobSave({ title: "role" }, null), jobs.prepareJobDelete("job:a"), jobs.prepareJobUnlink("link:a")];
  await switchTo("B"); await switchTo("A");
  for (const action of actions) await assert.rejects(action(), /target|changed|stale/i);
  assert.deepEqual(calls, []);
});

test("late job reads cannot display another document's workspace", async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const { jobs, switchTo } = await scenario(async () => {
    entered(); return new Promise(resolve => { release = resolve; });
  });
  const read = jobs.loadJobMaterials();
  const rejected = assert.rejects(read, /target|changed|stale/i);
  await started; await switchTo("B");
  release({ materials: [{ documentId: "A" }], links: [], revisions: [] });
  await rejected;
});

test("job links transport the captured complete cursor rather than a document-only target", async () => {
  let request;
  const { jobs } = await scenario(async (_command, args) => { request = args.request; return {}; });
  await jobs.prepareJobLink({ id: "job:a", revision: 3 }, "branch:role")();
  assert.equal(request.cursor.documentId, "A");
  assert.equal(request.cursor.contextId, "same-context");
  assert.equal(request.cursor.revision, "0");
  assert.equal(request.branchId, "branch:role");
  assert.equal(request.jobMaterialRevision, 3);
  assert.equal("documentId" in request, false);
});

test("native proposal undo stays bound to its original document before and during draft flushing", async () => {
  for (const switchedBeforeClick of [true, false]) {
    const calls = [], errors = [];
    const { client, switchTo } = await scenario(async () => {});
    const original = structuredClone(client.snapshot.cursor);
    if (switchedBeforeClick) await switchTo("B");
    const { runUndoNativeProposal } = await loadModule("src/ui/agent/overlay/proposals.tsx", {
      "../../../platform/ipc": { nativeInvoke: async (...args) => { calls.push(args); } },
      "../../../platform/NativeDocumentClient": { sameCursor },
      "../../../platform/workspace": { nativeClient: client,
        flushDraftBeforeVersionAction: async () => { if (!switchedBeforeClick) await switchTo("B"); },
        reloadWorkspaceState: async () => { throw new Error("wrong target must not reload after a write"); } },
      "../../domain/resume-model": { moduleTitles: {} }, "../../utils/resume": {},
      "../agentOverlayUtils": {}, "./shared": {},
    });
    await runUndoNativeProposal({
      acceptingProposalIds: { current: new Set() }, setAcceptingProposalId: () => {},
      proposalCommandId: () => "undo-original", onNativeWorkspaceReload: () => {},
      refreshNativeProposalInbox: async () => null, appendMessage: () => {},
      setLocalError: message => errors.push(message),
    }, { receiptId: "receipt-A", cursor: original });
    assert.deepEqual(calls, []);
    assert.equal(errors.length, 1);
    assert.equal(client.snapshot.cursor.documentId, "B");
  }
});
