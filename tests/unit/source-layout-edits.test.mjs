import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadModule } from "./module-loader.mjs";
import { validateVersionSnapshot } from "../../src/ui/services/version-schema.mjs";

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
