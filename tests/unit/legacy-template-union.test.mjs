import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadModule } from "./module-loader.mjs";

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
