import { test } from "node:test";
import assert from "node:assert/strict";
import { sameCursor } from "../../src/platform/NativeDocumentClient.ts";
import { loadModule } from "./module-loader.mjs";

test("source PDF export explains unknown or incomplete legacy link data before printing", async () => {
  const cursor = { documentId: "A", contextId: "C", branchId: "B", headId: null, revision: "0" };
  const state = { cursor, document: { title: "Synthetic" }, pendingImportCount: 0 };
  const client = { snapshot: state, captureTarget: () => ({}), assertTarget: () => {}, reload: async () => state };
  const { runDownloadResume } = await loadModule("src/ui/app/workspace/exports.tsx", {
    "../../../platform/NativeDocumentClient": { sameCursor },
    "../../../platform/jobs": {}, "../../../platform/capability": { platformCapabilities: () => ({ nativeDialogs: false }) },
    "../../../platform/ipc": {}, "../../../platform/legacyImport": {}, "../../../platform/versionDetails": {},
    "../../../platform/legacySourceArchive": {}, "../../../platform/workspace": { nativeClient: client, flushDraftBeforeVersionAction: async () => {} },
    "../../agent/sessions": {}, "../../services/resume-copy": {},
    "../../services/export-checks": { checkExportContent: () => [], checkExportJobSupport: () => ({ findings: [], evidence: [] }) },
    "../../services/export-output-checks": {}, "../../services/version-backup": {}, "./shared": {},
  });
  async function review(sourceLayout, format = "pdf") {
    let findings;
    await runDownloadResume({ exportingFormat: null, previewOverflow: null, previewOverflowMessage: null,
      exportFileName: "synthetic", setPanel: () => {}, setExportingFormat: () => {}, notify: () => {},
      sourceLayoutTemplate: { id: "source", sourceType: "pdf", sourceLayout },
      exportHost: { begin: () => true, finish: () => {}, notify: () => {}, review: async report => {
        findings = report.findings; return { proceed: false };
      } } }, format);
    return findings;
  }
  assert.ok((await review({})).some(item => item.id === "source-links-unknown" && item.severity === "suggestion"));
  assert.ok((await review({ linkStatus: "incomplete" })).some(item => item.id === "source-links-incomplete" && item.severity === "error"));
  assert.deepEqual(await review({ linkStatus: "complete", sourceLinks: [] }), []);
  assert.deepEqual(await review({}, "png"), []);
});
