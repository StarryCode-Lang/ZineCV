import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeDocumentClient, sameCursor } from "../../src/platform/NativeDocumentClient.ts";
import { loadModule } from "./module-loader.mjs";

async function scenario(options = {}) {
  const calls = [], notices = [], reviews = [], writes = [];
  let active = state("A", 1), busy = false, finished = false;
  const client = new NativeDocumentClient(async (command, args) => {
    if (command === "document_state") return active;
    if (command === "switch_active_document") {
      active = state(args.request.targetDocumentId, active.epoch + 1);
      return { ...active, documentId: active.cursor.documentId, meta: {} };
    }
    throw new Error(command);
  });
  await client.load();
  const switchToB = () => client.switchDocument({ targetDocumentId: "B", expectedCurrentId: "A", expectedEpoch: 1 });
  const artifact = { artifactId: "pdf", bytes: 3, sha256: "a".repeat(64) };
  const invoke = async (command, args) => {
    calls.push(command);
    if (command === "render_document_export") {
      const bundle = { cursor: structuredClone(args.cursor), renderKey: "frozen-key", exportId: "frozen-A",
        source: { documentTitle: "A title", branchName: "A branch" }, artifacts: options.partialPng ? [1, 2].map(page => ({ ...artifact, artifactId: `png:${page}` })) : [artifact],
        data: { pdfBase64: "YWJj", pngPages: options.partialPng ? [1, 2].map(page => ({ page, dataBase64: "YWJj" })) : [], longPng: null, longImageLimited: false } };
      if (options.switchAfterFreeze) await switchToB();
      return bundle;
    }
    if (command === "pick_export_path") { assert.match(args.defaultName, /Engineer-2026\.pdf$/); return "D:\\isolated\\resume.pdf"; }
    if (command === "pick_export_directory") return "D:\\isolated";
    if (command === "write_export_file") {
      writes.push(structuredClone(args));
      if (options.partialPng && writes.length >= 2) throw new Error("second page failed");
      if (options.loseAcknowledgement && writes.length === 1) throw new Error("lost acknowledgement");
      return { bytes: artifact.bytes, sha256: artifact.sha256,
        receipt: options.recordingError ? null : { cursor: state("A", 1).cursor }, recordingError: options.recordingError ?? null };
    }
    throw new Error(`Unexpected export command ${command}`);
  };
  const { runDownloadResume } = await loadModule("src/ui/app/workspace/exports.tsx", {
    "../../../platform/NativeDocumentClient": { sameCursor },
    "../../../platform/jobs": { loadJobMaterials: async () => ({ materials: [], links: [], revisions: [] }) },
    "../../../platform/capability": { platformCapabilities: () => ({ nativeDialogs: true }) },
    "../../../platform/ipc": { nativeInvoke: invoke, NativeIpcError: class extends Error {} },
    "../../../platform/legacyImport": {}, "../../../platform/versionDetails": {},
    "../../../platform/workspace": { nativeClient: client,
      flushDraftBeforeVersionAction: async () => { if (options.switchDuringFlush) await switchToB(); } },
    "../../agent/sessions": {}, "../../services/resume-copy": {},
    "../../services/export-checks": { checkExportContent: () => [], checkExportJobSupport: () => ({ findings: [], evidence: [] }) },
    "../../services/export-output-checks": { checkExportOutput: async () => options.badOutput ? [{ id: "bad", severity: "error" }] : [] },
    "../../services/version-backup": {}, "./shared": {},
  });
  await runDownloadResume({ exportingFormat: null, previewOverflow: null, previewOverflowMessage: null,
    exportFileName: "unused", branchName: "A branch", notify: () => {}, setPanel: () => {}, setExportingFormat: () => {},
    exportHost: { begin: () => { assert.equal(busy, false); busy = true; return true; },
      finish: () => { busy = false; finished = true; }, notify: value => notices.push(value),
      review: async report => { reviews.push(report); return { proceed: true, fileName: "Engineer-2026.pdf" }; } },
  }, options.partialPng ? "png" : "pdf");
  assert.equal(finished, true); assert.equal(busy, false);
  return { calls, notices, reviews, writes, client };
}
function state(id, epoch) {
  return { cursor: { documentId: id, contextId: "context", branchId: "main", headId: null, revision: "0" },
    document: { schemaVersion: 2, documentId: id, title: `${id} title` }, epoch };
}

test("export clicked on A never renders B if the workspace changes during draft flushing", async () => {
  const result = await scenario({ switchDuringFlush: true });
  assert.deepEqual(result.calls, []);
  assert.equal(result.client.snapshot.cursor.documentId, "B");
  assert.ok(result.notices.at(-1).includes("导出未完成"));
});

test("a frozen A export may finish on B without rebinding its write ticket or source notice", async () => {
  const result = await scenario({ switchAfterFreeze: true, loseAcknowledgement: true });
  assert.equal(result.client.snapshot.cursor.documentId, "B");
  assert.equal(result.writes.length, 2);
  assert.deepEqual(result.writes[0], result.writes[1]);
  assert.equal(result.writes[1].exportId, "frozen-A");
  assert.equal(result.writes[1].artifactId, "pdf");
  assert.ok(result.notices.at(-1).includes("A title / A branch / 修订 0"));
  assert.ok(result.notices.at(-1).includes("已保存"));
});

test("invalid actual output stops before a save dialog or filesystem write", async () => {
  const result = await scenario({ badOutput: true });
  assert.deepEqual(result.calls, ["render_document_export"]);
  assert.equal(result.reviews.at(-1).phase, "output");
  assert.ok(result.notices.at(-1).includes("没有写入文件"));
});

test("a failed export-history transaction reports the saved file and failed record separately", async () => {
  const result = await scenario({ recordingError: "isolated SQLite fault" });
  assert.equal(result.writes.length, 1);
  assert.ok(result.notices.at(-1).includes("文件已保存，但导出记录失败"));
  assert.ok(result.notices.at(-1).includes("isolated SQLite fault"));
});

test("partial PNG delivery keeps both the saved-page count and earlier recording errors", async () => {
  const result = await scenario({ partialPng: true, recordingError: "isolated record failure" });
  assert.ok(result.notices.at(-1).includes("保存 1/2 个文件"));
  assert.ok(result.notices.at(-1).includes("导出记录失败：isolated record failure"));
});
