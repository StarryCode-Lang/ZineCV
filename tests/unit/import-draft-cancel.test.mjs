import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./module-loader.mjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function scenario(stage, run, { mutationError = null, cleanupError = null } = {}) {
  const previousWindow = globalThis.window;
  const entered = deferred(), release = deferred();
  const drafts = new Map(), calls = [], timers = new Map(), budgets = [];
  let gated = false, serial = 0, parserCalls = 0;
  let targetGeneration = 1;
  const importTarget = { cursor: { documentId: "workspace-default-document" }, sessionEpoch: 1, hostEpoch: 7 };
  const pause = async checkpoint => {
    if (checkpoint === stage && !gated) {
      gated = true;
      entered.resolve();
      await release.promise;
    }
  };
  globalThis.window = {
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, callback); budgets.push(delay); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const invoke = async (command, args) => {
    calls.push({ command, args: structuredClone(args) });
    if (command === "create_import_draft") {
      assert.equal(args.request.expectedEpoch, 7, "creation retains the host epoch captured before hashing");
      const draft = { id: args.request.draftId, status: "queued", candidates: [], warnings: [], unsupportedFeatures: [] };
      drafts.set(draft.id, draft);
      await pause("create");
      if (mutationError) throw mutationError;
      return structuredClone(draft);
    }
    if (command === "get_import_draft") return structuredClone(drafts.get(args.draftId) ?? null);
    assert.equal(command, "transition_import_draft");
    const request = args.request, draft = drafts.get(request.draftId);
    assert.ok(draft, "transitions must target an existing durable draft");
    assert.equal(draft.status, request.expectedStatus);
    if ((request.nextStatus === "failed" || request.nextStatus === "cancelled") && cleanupError) throw cleanupError;
    draft.status = request.nextStatus;
    if (request.nextStatus === "running") await pause("running");
    if (request.nextStatus === "review_required") await pause("review");
    return structuredClone(draft);
  };
  try {
    const { createImportReviewDraft } = await loadModule("src/ui/services/import-draft.ts", {
      "../../platform/documentBridge": { blocksFromLegacyHtml: () => [] },
      "../../platform/ipc": { hasDocumentRuntime: () => true, nativeInvoke: invoke },
      "../../platform/workspace": {
        captureDocumentHostTarget: () => structuredClone(importTarget),
        nativeClient: { assertTarget(target) { if (target.sessionEpoch !== targetGeneration) throw new Error("Document target changed"); } },
      },
      "../utils/resume": { createEntityId: prefix => `${prefix}-${++serial}` },
      "./import-limits": { IMPORT_LIMITS: { fileBytes: 18 * 1024 * 1024, timeoutMs: 120000, reviewBytes: 2 * 1024 * 1024 } },
      "./template-import": {
        importedTemplateFieldProvenance: () => ({}),
        recognizeTemplate: async () => {
          parserCalls += 1;
          return { previewDataUrl: "data:image/png;base64,AA==", extractedText: "", recognitionWarnings: [] };
        },
      },
    });
    const file = { name: "owned.pdf", size: 5, type: "application/pdf", async arrayBuffer() {
      await pause("hash");
      return new Uint8Array([1, 2, 3, 4, 5]).buffer;
    } };
    await run({ createImportReviewDraft, file, entered, release, drafts, calls, timers, budgets,
      changeTarget() { targetGeneration++; },
      get parserCalls() { return parserCalls; } });
    assert.equal(timers.size, 0, "every completed attempt must release its timeout");
    assert.ok(budgets.every(delay => delay === 120000), "the production timeout must remain 120 seconds");
  } finally {
    release.resolve();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

test("switching targets during source hashing prevents draft creation instead of rebinding the target", async () => {
  await scenario("hash", async state => {
    const rejected = assert.rejects(state.createImportReviewDraft(state.file, () => {}), /target changed/);
    await state.entered.promise;
    state.changeTarget();
    state.release.resolve();
    await rejected;
    assert.equal(state.calls.length, 0);
    assert.equal(state.parserCalls, 0);
  });
});

for (const stage of ["hash", "create", "running"]) {
  test(`cancellation during ${stage} preparation never starts parsing, cleans durable drafts and permits retry`, async () => {
    await scenario(stage, async state => {
      const controller = new AbortController();
      const rejected = assert.rejects(state.createImportReviewDraft(state.file, () => {}, controller.signal), error => error.name === "AbortError");
      await state.entered.promise;
      controller.abort();
      if (stage !== "hash") state.release.resolve();
      await rejected;
      assert.equal(state.parserCalls, 0);
      if (stage === "hash") {
        assert.equal(state.drafts.size, 0, "aborted hashing must not create a native draft");
        assert.equal(state.calls.length, 0);
        state.release.resolve();
      } else {
        assert.equal(state.drafts.size, 1);
        assert.equal([...state.drafts.values()][0].status, "cancelled");
        const cancellation = state.calls.find(call => call.args?.request?.nextStatus === "cancelled");
        assert.equal(cancellation.args.request.expectedStatus, stage === "create" ? "queued" : "running");
      }
      const retry = await state.createImportReviewDraft(state.file, () => {}, new AbortController().signal);
      assert.equal(retry.draft.status, "review_required");
      assert.equal(state.parserCalls, 1);
      assert.equal(state.timers.size, 0);
    });
  });
}

test("the unchanged 120 second deadline covers preparation and prevents post-timeout creation", async () => {
  await scenario("hash", async state => {
    const rejected = assert.rejects(state.createImportReviewDraft(state.file, () => {}), error => error.name === "AbortError");
    await state.entered.promise;
    assert.equal(state.timers.size, 1);
    [...state.timers.values()][0]();
    await rejected;
    state.release.resolve();
    assert.equal(state.parserCalls, 0);
    assert.equal(state.calls.length, 0);
  });
});

test("a rejected creation acknowledgement cleans its persisted queued draft without masking the original failure", async () => {
  const failure = new Error("creation acknowledgement lost");
  await scenario(null, async state => {
    await assert.rejects(state.createImportReviewDraft(state.file, () => {}), error => error === failure);
    assert.equal(state.parserCalls, 0);
    assert.equal([...state.drafts.values()][0].status, "failed");
  }, { mutationError: failure });
});

test("cleanup failure preserves the original preparation error", async () => {
  const failure = new Error("native create failure");
  await scenario(null, async state => {
    await assert.rejects(state.createImportReviewDraft(state.file, () => {}), error => error === failure);
    assert.equal(state.parserCalls, 0);
  }, { mutationError: failure, cleanupError: new Error("cleanup unavailable") });
});

test("cancellation while review persistence is pending clears the late review instead of returning it", async () => {
  await scenario("review", async state => {
    const controller = new AbortController();
    const rejected = assert.rejects(state.createImportReviewDraft(state.file, () => {}, controller.signal), error => error.name === "AbortError");
    await state.entered.promise;
    controller.abort();
    state.release.resolve();
    await rejected;
    assert.equal(state.parserCalls, 1);
    assert.equal([...state.drafts.values()][0].status, "cancelled");
    const cancellation = state.calls.find(call => call.args?.request?.nextStatus === "cancelled");
    assert.equal(cancellation.args.request.expectedStatus, "review_required");
  });
});

test("already cancelled callers produce no native draft or timer", async () => {
  await scenario(null, async state => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(state.createImportReviewDraft(state.file, () => {}, controller.signal), error => error.name === "AbortError");
    assert.equal(state.calls.length, 0);
    assert.equal(state.budgets.length, 0);
    assert.equal(state.parserCalls, 0);
  });
});
