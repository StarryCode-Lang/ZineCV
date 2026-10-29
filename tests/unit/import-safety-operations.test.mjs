import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./module-loader.mjs";

// IQ-B12 target-switch protection, asserted against the production apply path.
// The browser page used by tools/import-quality-baseline.mjs cannot inject IPC
// mocks, so these unit-level cases carry the boundary's evidence (reported as
// scope "unit-evidence"; no end-to-end claim is made).
const cursorOf = (documentId, revision) =>
  ({ documentId, contextId: "ctx-shared", revision, branchId: "main", headId: `head-${documentId}-${revision}` });
const sameCursor = (left, right) =>
  left.documentId === right.documentId && left.contextId === right.contextId &&
  left.revision === right.revision && left.branchId === right.branchId && left.headId === right.headId;

const DOCUMENT_A = "document-a";
const DOCUMENT_B = "document-b";
const TARGET_A = { cursor: cursorOf(DOCUMENT_A, 1), sessionEpoch: 1 };
const NO_CORRECTIONS = [];

async function scenario(config, run) {
  const calls = { applyImport: [], flush: 0, appliedSnapshots: [], selected: [], notified: [] };
  const state = { cursor: config.initialCursor ?? cursorOf(DOCUMENT_A, 1), epoch: config.initialEpoch ?? 1 };
  const nativeClient = {
    get snapshot() { return state.cursor ? { cursor: state.cursor } : null; },
    get currentSessionEpoch() { return state.epoch; },
    async applyImport(draftId, acceptedCandidateIds, expectedCursor, corrections) {
      calls.applyImport.push({ draftId,
        acceptedCandidateIds: [...acceptedCandidateIds],
        corrections: structuredClone(corrections ?? []),
        expectedCursor: structuredClone(expectedCursor) });
      // Mirrors the real native guard: a write may only land on the captured cursor.
      if (!sameCursor(state.cursor, expectedCursor))
        throw new Error("Import target changed after the candidates were prepared");
      const appliedCursor = structuredClone(state.cursor);
      config.duringNativeApply?.(state);
      return { cursor: appliedCursor, document: { marker: "applied-document" } };
    },
  };
  const moduleExports = await loadModule("src/ui/app/workspace/documents.tsx", {
    "../../../platform/NativeDocumentClient": { sameCursor },
    "../../../platform/ipc": { hasDocumentRuntime: () => true },
    "../../../platform/workspace": {
      flushDraftBeforeVersionAction: async () => {
        calls.flush += 1;
        config.duringFlush?.(state);
      },
      nativeClient,
      snapshotFromLoadedDocument: async document => {
        config.duringSnapshotAdoption?.(state);
        return { marker: "snapshot", from: document };
      },
    },
    "../../domain/imported-template": { readImportedTemplates: () => [] },
    "../../domain/resume-model": { moduleTitles: {} },
    "../../domain/resume-normalization": {
      migratePersonalSites: resume => resume,
      normalizeResumeState: resume => resume,
      normalizeSectionOrder: order => order,
    },
    "../../domain/template-model": { normalizePresentation: presentation => presentation },
    "../useImportedTemplates": { sourcePreviewDismissalKey: () => "source-preview" },
  });
  await run({
    runApplyImportDraft: moduleExports.runApplyImportDraft,
    context: {
      nativeReady: true,
      applyVersionSnapshot: snapshot => calls.appliedSnapshots.push(snapshot),
      selectWorkspace: view => calls.selected.push(view),
      notify: message => calls.notified.push(message),
    },
    calls,
    state,
  });
}

test("[IQ-B12] a confirmation after the import target switched to another document is rejected before any native write", async () => {
  await scenario({ initialCursor: cursorOf(DOCUMENT_B, 1), initialEpoch: 2 }, async state => {
    // The draft was prepared on document A/epoch 1; the workspace now edits B/epoch 2.
    await assert.rejects(state.runApplyImportDraft(state.context, "draft-1", ["candidate-1"], NO_CORRECTIONS, TARGET_A),
      error => error.message.includes("编辑来源或文档修订已变化"));
    assert.equal(state.calls.applyImport.length, 0, "the switched target must not receive a native write");
    assert.equal(state.calls.flush, 0, "no flush may run against the wrong target");
    assert.equal(state.calls.appliedSnapshots.length, 0, "B's editor content must stay untouched");
    assert.equal(state.calls.selected.length, 0);
  });
});

test("[IQ-B12] a resume edited while the review was open blocks the stale confirmation at the re-check before applyImport", async () => {
  await scenario({
    duringFlush(state) {
      // The user switches documents while the pre-confirmation flush is running.
      state.cursor = cursorOf(DOCUMENT_B, 2);
      state.epoch = 2;
    },
  }, async state => {
    await assert.rejects(state.runApplyImportDraft(state.context, "draft-1", ["candidate-1"], NO_CORRECTIONS, TARGET_A),
      error => error.message.includes("简历已发生变化"));
    assert.equal(state.calls.flush, 1);
    assert.equal(state.calls.applyImport.length, 0, "the stale confirmation must not reach the native apply");
    assert.equal(state.calls.appliedSnapshots.length, 0);
  });
});

test("[IQ-B12] a late apply receipt that belongs to a switched editing source is refused instead of overwriting the editor", async () => {
  await scenario({
    duringNativeApply(state) {
      // The receipt is still in flight while the workspace switches to B/epoch 2.
      state.cursor = cursorOf(DOCUMENT_B, 2);
      state.epoch = 2;
    },
  }, async state => {
    await assert.rejects(state.runApplyImportDraft(state.context, "draft-1", ["candidate-1"], NO_CORRECTIONS, TARGET_A),
      error => error.message.includes("已拒绝覆盖当前界面"));
    assert.equal(state.calls.applyImport.length, 1);
    assert.deepEqual(state.calls.applyImport[0].expectedCursor, TARGET_A.cursor,
      "the native write must only ever target the captured cursor, never the switched document");
    assert.equal(state.calls.appliedSnapshots.length, 0, "the late receipt must not be adopted into B's editor");
    assert.equal(state.calls.selected.length, 0);
  });
});

test("[IQ-B12] an import result that expires between the receipt and its adoption never reaches the editor", async () => {
  await scenario({
    duringSnapshotAdoption(state) {
      // A session switch lands while the receipt is being prepared for adoption.
      state.epoch = 2;
    },
  }, async state => {
    await assert.rejects(state.runApplyImportDraft(state.context, "draft-1", ["candidate-1"], NO_CORRECTIONS, TARGET_A),
      error => error.message.includes("已过期"));
    assert.equal(state.calls.applyImport.length, 1);
    assert.equal(state.calls.appliedSnapshots.length, 0, "an expired result must not reach applyVersionSnapshot");
    assert.equal(state.calls.selected.length, 0);
  });
});

test("[IQ-B12] an unchanged target still applies the confirmed candidates to the captured cursor", async () => {
  await scenario({}, async state => {
    const corrections = [{ candidateId: "candidate-1", value: { type: "basicField", field: "name", value: "Alex Corrected" } }];
    const result = await state.runApplyImportDraft(state.context, "draft-1", ["candidate-1", "candidate-2"], corrections, TARGET_A);
    assert.equal(state.calls.applyImport.length, 1);
    assert.deepEqual(state.calls.applyImport[0].expectedCursor, TARGET_A.cursor);
    assert.deepEqual(state.calls.applyImport[0].acceptedCandidateIds, ["candidate-1", "candidate-2"]);
    assert.deepEqual(state.calls.applyImport[0].corrections, corrections,
      "reviewed corrections travel with the apply request to the native host");
    assert.equal(state.calls.appliedSnapshots.length, 1);
    assert.deepEqual(state.calls.selected, ["editor"]);
    assert.ok(state.calls.notified.some(message => message.includes("原子写入")));
    assert.ok(result === undefined, "the apply path resolves after adopting the snapshot");
  });
});
