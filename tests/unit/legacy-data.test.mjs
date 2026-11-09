/* 由 4 个同域测试文件合并；各原文件体包块以保持原作用域。 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadModule } from "./module-loader.mjs";

/* ==== 原 legacy-version-union.test.mjs ==== */
{

const { mergeLegacyVersionStores } = await loadModule("src/platform/legacyVersionUnion.ts", {});
const branch = { id: "main", name: "Main", headCommitId: "c1", createdAt: "2020" };
const commit = { id: "c1", branchId: "main", parentId: null, message: "one", createdAt: "2020", snapshot: { resumeTitle: "one" } };
const primary = { currentBranchId: "main", branches: [branch], commits: [commit] };

test("backup adds its extra branch without duplicating identical commits", () => {
  const backup = { ...primary, branches: [{ ...branch }, { id: "extra", name: "Extra", headCommitId: null, createdAt: "2020" }], commits: [{ ...commit }] };
  const result = mergeLegacyVersionStores(primary, backup);
  assert.equal(result.store.branches.length, 2);
  assert.equal(result.store.commits.length, 1);
  assert.equal(result.duplicateBackupCommits.length, 1);
  assert.equal(result.store.currentBranchId, "main");
});

test("conflicting backup retains a separate connected graph", () => {
  const backup = { ...primary, commits: [{ ...commit, message: "different" },
    { ...commit, id: "c2", parentId: "c1", message: "two" }],
    branches: [{ ...branch, headCommitId: "c2" }] };
  const result = mergeLegacyVersionStores(primary, backup);
  assert.equal(result.store.branches.length, 2);
  assert.equal(result.store.commits.length, 3);
  const other = result.store.branches[1];
  const second = result.store.commits.find((item) => item.id === other.headCommitId);
  assert.equal(second.branchId, other.id);
  assert.equal(result.store.commits.find((item) => item.id === second.parentId).message, "different");
  assert.equal(result.duplicateBackupCommits.length, 0);
  assert.throws(() => mergeLegacyVersionStores(primary, { ...backup, branches: [branch, branch] }), /重复 ID/);
});
}

/* ==== 原 legacy-draft-restore.test.mjs ==== */
{

const archive = await loadModule("src/platform/legacySourceArchive.ts", {});
const { loadLegacyDraftWithArchive } = await loadModule("src/ui/app/workspace/legacyDraft.ts", {
  "../../../platform/legacySourceArchive": archive,
  "../../../platform/documentBridge": { canonicalJsonValue: (value) => JSON.stringify(value) },
});

test("restoring a draft retains both source archives on the captured document", async () => {
  let document = archive.archiveLegacySource({ documentId: "A", legacyExtensions: {} }, { title: "previous" });
  let applied = false;
  const snapshot = { legacySourceArchive: { snapshot: { title: "imported" } } };
  await loadLegacyDraftWithArchive(snapshot, {
    captureTarget: () => ({ cursor: { documentId: "A" } }),
    assertTarget: (target) => assert.equal(target.cursor.documentId, document.documentId),
    currentDocument: () => document, flush: async () => {}, withAuthority: async (action) => action(),
    saveExtensions: async (extensions) => { document = { ...document, legacyExtensions: extensions }; },
    applySnapshot: () => { applied = true; },
  });
  assert.equal(applied, true);
  assert.equal(document.legacyExtensions.legacySourceSnapshot.title, "imported");
  assert.equal(document.legacyExtensions.legacySourceHistory[0].snapshot.title, "previous");
});

test("a document switch during flush cannot apply a backup to another document", async () => {
  let activeId = "A", writes = 0, applied = false;
  await assert.rejects(loadLegacyDraftWithArchive({ legacySourceArchive: { snapshot: {} } }, {
    captureTarget: () => ({ cursor: { documentId: activeId } }),
    assertTarget: (target) => { if (target.cursor.documentId !== activeId) throw Error("target changed"); },
    currentDocument: () => ({ documentId: activeId, legacyExtensions: {} }),
    flush: async () => { activeId = "B"; }, withAuthority: async (action) => action(),
    saveExtensions: async () => { writes++; }, applySnapshot: () => { applied = true; },
  }), /target changed/);
  assert.equal(writes, 0);
  assert.equal(applied, false);
});
}

/* ==== 原 legacy-source-archive.test.mjs ==== */
{

const archive = await loadModule("src/platform/legacySourceArchive.ts", {});

test("migration retains an independent original and ordinary saves keep it with the same document", async () => {
  const source = { resume: { basic: { targetRole: "original" } }, unsupportedHtml: '<span style="color:red">text</span>' };
  const originalDocument = { documentId: "A", title: "Before", legacyExtensions: {} };
  const migrated = archive.archiveLegacySource(originalDocument, source, '{"basic":{"targetRole":"unfiltered"}}');
  source.resume.basic.targetRole = "changed outside";
  assert.equal(migrated.legacyExtensions.legacySourceSnapshot.resume.basic.targetRole, "original");

  const target = { cursor: { documentId: "A" } };
  const nativeClient = {
    snapshot: { document: migrated }, saveStatus: "saved",
    assertTarget(value) { assert.equal(value.cursor.documentId, this.snapshot.document.documentId); },
    async submit(command) { this.snapshot.document = command.document; },
  };
  const persistence = await loadModule("src/platform/useNativeResumePersistence.ts", {
    react: {}, "./legacySourceArchive": archive, "./legacyDraftAlignment": { alignDraftDocument: (document) => document },
    "./documentBridge": {
      documentFromSnapshot: (snapshot, documentId) => ({ documentId, title: snapshot.title, legacyExtensions: {} }),
      snapshotFromDocument: (document) => ({ title: document.title }),
      documentsEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      nextDocumentCommand: (_a, b) => ({ document: b }),
    },
    "./workspace": { nativeClient, storeAvatarAsset: async (document) => document },
    "./ipc": {}, "../ui/agent/sessions": {},
  }, "\nexport { runPersist };\n");
  await persistence.runPersist({ title: "Edited", resume: { basic: {} } }, target);
  assert.equal(nativeClient.snapshot.document.title, "Edited");
  assert.equal(nativeClient.snapshot.document.legacyExtensions.legacySourceSnapshot.resume.basic.targetRole, "original");
  assert.equal(nativeClient.snapshot.document.legacyExtensions.legacySourceSnapshot.unsupportedHtml, '<span style="color:red">text</span>');
  assert.equal(JSON.parse(nativeClient.snapshot.document.legacyExtensions.legacySourceState).basic.targetRole, "unfiltered");
  const unrelated = archive.retainLegacySource({ ...originalDocument, documentId: "B" }, { ...originalDocument, documentId: "B" });
  assert.equal("legacySourceSnapshot" in unrelated.legacyExtensions, false);
});

test("version backups carry source provenance without exposing it in normal snapshots", () => {
  const document = archive.archiveLegacySource({ documentId: "A", legacyExtensions: {} },
    { resume: { basic: { targetRole: "retained" } } }, '{"old":"value"}');
  const snapshot = { resumeTitle: "saved" };
  archive.rememberLegacySource(snapshot, document);
  assert.equal(JSON.stringify(snapshot).includes("targetRole"), false);
  const backupSnapshot = JSON.parse(JSON.stringify(archive.exportLegacySource(snapshot)));
  assert.equal(backupSnapshot.legacySourceArchive.snapshot.resume.basic.targetRole, "retained");
  const restored = archive.restoreLegacySource({ documentId: "B", legacyExtensions: {} }, backupSnapshot);
  assert.equal(restored.legacyExtensions.legacySourceSnapshot.resume.basic.targetRole, "retained");
  assert.equal(restored.legacyExtensions.legacySourceState, '{"old":"value"}');
  const existing = archive.archiveLegacySource({ documentId: "B", legacyExtensions: {} }, { title: "earlier source" });
  const combined = archive.restoreLegacySource(existing, backupSnapshot);
  assert.equal(combined.legacyExtensions.legacySourceSnapshot.resume.basic.targetRole, "retained");
  assert.equal(combined.legacyExtensions.legacySourceHistory[0].snapshot.title, "earlier source");
  assert.equal(archive.restoreLegacySource(combined, backupSnapshot).legacyExtensions.legacySourceHistory.length, 1);
  assert.throws(() => archive.restoreLegacySource({ legacyExtensions: {} }, { legacySourceArchive: { rawState: 42 } }), /旧版原文无效/);
});
}

/* ==== 原 legacy-template-union.test.mjs ==== */
{

const hash = "a".repeat(64);
const legacySourceArchive = await loadModule("src/platform/legacySourceArchive.ts", {});
const legacyVersionUnion = await loadModule("src/platform/legacyVersionUnion.ts", {});
const cursor = { documentId: "doc", contextId: "ctx", revision: "1", branchId: "main", headId: null };
const original = { id: "shared", name: "desktop" };
const legacy = { id: "shared", name: "legacy", sourceName: "legacy.pdf", sourceType: "pdf", accent: "#000", formatId: "legacy-v1", layout: "single-column" };
const snapshot = { resumeTitle: "draft", importedTemplate: { id: "shared", name: "legacy", revisionHash: "old-revision" } };
const parsed = { kind: "browser-export", origin: "http://127.0.0.1:5173", snapshot,
  templates: [legacy], preferences: [], sessionKeyCount: 0,
  store: { currentBranchId: "main", branches: [], commits: [{ id: "old", branchId: "main", parentId: null, message: "old", createdAt: "", snapshot }] } };

async function importerWithCatalog(catalog) {
  const calls = [];
  const importer = await loadModule("src/platform/legacyImport.ts", {
    "./legacySourceArchive": legacySourceArchive,
    "./legacyVersionUnion": legacyVersionUnion,
    "../ui/domain/imported-template": {},
    "../ui/domain/resume-normalization": {},
    "../ui/domain/resume-model": {},
    "../ui/domain/template-model": {},
    "./documentBridge": { documentFromSnapshot: (value, documentId) => ({ documentId, importedTemplate: value.importedTemplate }) },
    "./workspace": { nativeClient: { snapshot: null } },
    "./ipc": { nativeInvoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "inspect_legacy_migration") return { readyForDryRun: true, namespaceDecisionRequired: false, issues: [], conflicts: [], sources: [{ sourceId: "browser-export", sourceSha256: hash, issues: [] }] };
      if (command === "read_imported_template_catalog") return catalog;
      if (command === "dry_run_legacy_migration") return { status: "ready", conversionIssues: [] };
      if (command === "inspect_legacy_identity_conflicts") return [];
      throw new Error(`unexpected command ${command}`);
    } },
  });
  return { importer, calls };
}

test("legacy template collisions preserve both catalogs, remap references and retry idempotently", async () => {
  const first = await importerWithCatalog({ revision: 3, payloadJson: JSON.stringify([original]) });
  const prepared = await first.importer.prepareLegacyMigration("{}", parsed, cursor, "legacy-test");
  const catalog = JSON.parse(prepared.request.templates.catalogJson);
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog[0], original);
  assert.equal(catalog[1].name, "legacy");
  assert.notEqual(catalog[1].id, original.id);
  assert.deepEqual(prepared.request.currentDraft.importedTemplate, { id: catalog[1].id, name: "legacy" });
  assert.deepEqual(prepared.request.versionGraph.commits[0].snapshot.importedTemplate, { id: catalog[1].id, name: "legacy" });
  assert.deepEqual(prepared.request.versionGraph.commits[0].snapshot.legacyExtensions.legacySourceSnapshot, snapshot);
  assert.equal(parsed.snapshot.importedTemplate.revisionHash, "old-revision", "source is unchanged");
  const second = await importerWithCatalog({ revision: 4, payloadJson: JSON.stringify(catalog) });
  const repeated = await second.importer.prepareLegacyMigration("{}", parsed, cursor, "legacy-test");
  assert.deepEqual(JSON.parse(repeated.request.templates.catalogJson), catalog);
});

test("legacy template migration refuses malformed existing or ambiguous source catalogs", async () => {
  const invalid = await importerWithCatalog({ revision: 1, payloadJson: "not json" });
  await assert.rejects(invalid.importer.prepareLegacyMigration("{}", parsed, cursor, "legacy-test"), /模板目录无法解析/);
  assert.equal(invalid.calls.some(call => call.command === "dry_run_legacy_migration"), false);
  const duplicate = await importerWithCatalog(null);
  await assert.rejects(duplicate.importer.prepareLegacyMigration("{}", { ...parsed, templates: [legacy, legacy] }, cursor, "legacy-test"), /旧版模板目录存在重复 ID/);
});

test("retrying an initially non-conflicting template does not add an alias", async () => {
  const first = await importerWithCatalog(null);
  const prepared = await first.importer.prepareLegacyMigration("{}", parsed, cursor, "legacy-test");
  const catalog = JSON.parse(prepared.request.templates.catalogJson);
  assert.equal(catalog.length, 1);
  const second = await importerWithCatalog({ revision: 1, payloadJson: JSON.stringify(catalog) });
  const repeated = await second.importer.prepareLegacyMigration("{}", parsed, cursor, "legacy-test");
  assert.deepEqual(JSON.parse(repeated.request.templates.catalogJson), catalog);
  assert.equal(repeated.request.currentDraft.importedTemplate.id, legacy.id);
});

test("identical backup snapshots are staged for inspection without duplicating history", async () => {
  const { importer, calls } = await importerWithCatalog(null);
  const withBackup = { ...parsed, duplicateBackupCommits: [parsed.store.commits[0]] };
  const prepared = await importer.prepareLegacyMigration("{}", withBackup, cursor, "legacy-test");
  const dryRun = calls.find((call) => call.command === "dry_run_legacy_migration").args.request;
  assert.equal(prepared.request.versionGraph.commits.length, 1);
  assert.equal(dryRun.convertedDocuments.length, 3);
  assert.equal(new Set(dryRun.convertedDocuments.map((item) => item.legacyId)).size, 3);
  assert.deepEqual(dryRun.convertedDocuments[2].document.legacyExtensions.legacySourceSnapshot, snapshot);
});
}
