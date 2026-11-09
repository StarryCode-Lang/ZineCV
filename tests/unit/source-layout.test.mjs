/* 由 3 个同域测试文件合并；各原文件体包块以保持原作用域。 */
import { test } from "node:test";
import { loadModule } from "./module-loader.mjs";
import { strict as assert } from "node:assert/strict";
import { sameCursor } from "../../src/platform/NativeDocumentClient.ts";
import { validateVersionSnapshot } from "../../src/ui/services/version-schema.mjs";

/* ==== 原 source-layout-geometry.test.mjs ==== */
{

test("overlap checks compare boxes on the same page only", async () => {
  const { layoutOverlapRatio } = await loadModule("src/ui/services/imported-layout.ts", {});
  const box = { x: 10, y: 20, width: 100, height: 20 };
  assert.equal(layoutOverlapRatio({ boxes: [{ ...box, page: 1 }, { ...box, page: 2 }] }), 0);
  assert.equal(layoutOverlapRatio({ boxes: [{ ...box, page: 1 }, { ...box, page: 1 }] }), 1);
});
}

/* ==== 原 source-layout-link-warning.test.mjs ==== */
{

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
}

/* ==== 原 source-layout-edits.test.mjs ==== */
{

test("source text edits are isolated to their template and validated without dropping empty edits", async () => {
  const { parseSourceLayoutEdits } = await loadModule("src/platform/sourceLayoutEdits.ts", {});
  const value = { templateId: "template-a", edits: { "p1-b1": "changed", "p1-b2": "" } };
  const parsed = parseSourceLayoutEdits(value, "template-a");
  assert.deepEqual(parsed, value);
  assert.notEqual(parsed.edits, value.edits);
  assert.throws(() => parseSourceLayoutEdits(value, "template-b"), /模板/);
  assert.throws(() => parseSourceLayoutEdits({ ...value, revisionHash: "v1" }, "template-a", "v2"), /修订/);
  assert.throws(() => parseSourceLayoutEdits({ templateId: "template-a", edits: { field: 9 } }, "template-a"), /文字/);
  assert.equal(parseSourceLayoutEdits(null, null), null);
});

test("version backup validation rejects text edits assigned to a different template revision", () => {
  const result = validateVersionSnapshot({ importedTemplate: { id: "a", name: "A", revisionHash: "r1" },
    sourceLayoutEdits: { templateId: "a", revisionHash: "r2", edits: { box: "text" } } });
  assert.ok(result.errors.some((error) => error.includes("sourceLayoutEdits")));
});

test("restoring a version validates template identity before updating any editor state", async () => {
  const edits = await loadModule("src/platform/sourceLayoutEdits.ts", {});
  const { runApplyVersionSnapshot } = await loadModule("src/ui/app/workspace/documents.tsx", {
    "../../../platform/NativeDocumentClient": {}, "../../../platform/sourceLayoutEdits": edits,
    "../../../platform/ipc": {}, "../../../platform/workspace": {},
    "../../domain/imported-template": { readImportedTemplates: () => [] },
    "../../domain/resume-model": { moduleTitles: {} },
    "../../domain/resume-normalization": { migratePersonalSites: (x) => x, normalizeResumeState: (x) => x, normalizeSectionOrder: (x) => x },
    "../../domain/template-model": { normalizePresentation: (x) => x },
    "../useImportedTemplates": {},
  });
  const calls = [], context = new Proxy({}, { get: (_target, name) => (value) => calls.push([name, value]) });
  const snapshot = { resume: {}, moduleOrder: [], moduleNames: {}, summaryTitle: "", resumeTitle: "Resume", layout: {},
    importedTemplate: { id: "a", name: "A", revisionHash: "r1" },
    sourceLayoutEdits: { templateId: "a", revisionHash: "r1", edits: { box: "" } } };
  assert.throws(() => runApplyVersionSnapshot(context, { ...snapshot, sourceLayoutEdits: { ...snapshot.sourceLayoutEdits, templateId: "b" } }), /模板/);
  assert.equal(calls.length, 0);
  runApplyVersionSnapshot(context, snapshot);
  assert.deepEqual(calls.find(([name]) => name === "setSourceLayoutEdits")[1], snapshot.sourceLayoutEdits);
});

test("creating another imported source does not copy the previous source's text edits", async () => {
  const edits = await loadModule("src/platform/sourceLayoutEdits.ts", {});
  const previous = { documentId: "doc-a", legacyExtensions: { importedTemplate: { id: "a" }, sourceLayoutEdits: { templateId: "a", edits: { box: "old" } }, retained: "yes" } };
  let request;
  const nativeClient = { snapshot: { cursor: { documentId: "doc-a" }, document: previous },
    switchEditingContext: async (input) => { request = input; return { created: true }; } };
  const { runApplyImportedTemplate } = await loadModule("src/ui/app/workspace/documents.tsx", {
    "../../../platform/NativeDocumentClient": {}, "../../../platform/sourceLayoutEdits": edits,
    "../../../platform/ipc": { hasDocumentRuntime: () => true },
    "../../../platform/workspace": { nativeClient, flushDraftBeforeVersionAction: async () => {} },
    "../../domain/imported-template": { readImportedTemplates: () => [] },
    "../../domain/resume-model": { moduleTitles: {} }, "../../domain/resume-normalization": {},
    "../../domain/template-model": {}, "../useImportedTemplates": { sourcePreviewDismissalKey: () => "source" },
  });
  const calls = [], context = new Proxy({ nativeReady: true, importedContextSwitching: { current: false } },
    { get: (target, name) => name in target ? target[name] : (value) => calls.push([name, value]) });
  assert.equal(await runApplyImportedTemplate(context, { id: "b", name: "B", formatId: "legacy-v1", layout: "single-column" }), true);
  assert.equal(request.initialDocument.legacyExtensions.sourceLayoutEdits, undefined);
  assert.equal(request.initialDocument.legacyExtensions.retained, "yes");
  assert.equal(previous.legacyExtensions.sourceLayoutEdits.edits.box, "old");
  assert.equal(calls.find(([name]) => name === "setSourceLayoutEdits")[1], null);
});
}
