import { loadModule } from "./module-loader.mjs";
import { test } from "node:test";
import { strict as assert } from "node:assert";

async function loadImportedTemplateParser() {
  return loadModule('src/ui/domain/imported-template.ts', {
    '../../platform/ipc': { hasDocumentRuntime: () => false, nativeInvoke: async () => {
      throw new Error('unexpected template IPC call');
    } },
  });
}

async function loadLegacyImporter() {
  const dependencies = {
    "../ui/domain/imported-template": await loadImportedTemplateParser(),
    "../ui/domain/resume-normalization": {
      migratePersonalSites: (value) => value,
      normalizeResumeState: (value) => value,
      normalizeSectionOrder: (value) => value,
    },
    "../ui/domain/resume-model": {
      moduleTitles: {},
    },
    "../ui/domain/template-model": {
      normalizePresentation: (value) => value,
    },
    "./documentBridge": {
      documentFromSnapshot: () => ({ schemaVersion: 2 }),
    },
    "./workspace": {
      nativeClient: { snapshot: null },
    },
    "./ipc": {
      nativeInvoke: async () => {
        throw new Error("unexpected native IPC call");
      },
    },
  };
  return loadModule('src/platform/legacyImport.ts', dependencies);
}

test("versions-only import keeps history without inferring a current draft", async () => {
  const importer = await loadLegacyImporter();
  const source = {
    currentBranchId: "main",
    branches: [{
      id: "main",
      name: "默认版本",
      createdAt: "2026-01-01T00:00:00Z",
      headCommitId: "commit-head",
    }],
    commits: [{
      id: "commit-head",
      branchId: "main",
      parentId: null,
      message: "synthetic head",
      createdAt: "2026-01-01T00:00:00Z",
      snapshot: { resumeTitle: "合成历史快照" },
    }],
  };
  const before = structuredClone(source);

  const imported = importer.parseLegacyDataFile(source);

  assert.equal(imported.kind, "project-versions");
  assert.equal(imported.snapshot, null);
  assert.equal(imported.store.commits[0].snapshot.resumeTitle, "合成历史快照");
  assert.deepEqual(source, before);
});

test("migration preparation keeps source bytes, explicit namespace, graph IDs, and conflict acknowledgements", async () => {
  const sourceHash = "a".repeat(64);
  const conflictKey = "reviewed-identity-update";
  const calls = [];
  const source = {
    currentBranchId: "main",
    branches: [{
      id: "main",
      name: "Imported main",
      createdAt: "2026-01-01T00:00:00Z",
      headCommitId: "commit-a",
    }],
    commits: [{
      id: "commit-a",
      branchId: "main",
      parentId: null,
      message: "synthetic",
      createdAt: "2026-01-01T00:00:00Z",
      snapshot: { resumeTitle: "Synthetic history" },
    }],
  };
  const dependencies = {
    "../ui/domain/imported-template": await loadImportedTemplateParser(),
    "../ui/domain/resume-normalization": {
      migratePersonalSites: (value) => value,
      normalizeResumeState: (value) => value,
      normalizeSectionOrder: (value) => value,
    },
    "../ui/domain/resume-model": { moduleTitles: {} },
    "../ui/domain/template-model": { normalizePresentation: (value) => value },
    "./documentBridge": {
      documentFromSnapshot: (snapshot, documentId) => ({
        schemaVersion: 2,
        documentId,
        title: snapshot.resumeTitle,
      }),
    },
    "./workspace": { nativeClient: { snapshot: null } },
    "./ipc": {
      nativeInvoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "inspect_legacy_migration") {
          return {
            readyForDryRun: true,
            namespaceDecisionRequired: false,
            sources: [{
              sourceId: "version-json",
              sourceSha256: sourceHash,
              issues: [],
            }],
            issues: [],
            conflicts: [],
          };
        }
        if (command === "dry_run_legacy_migration") {
          return {
            status: "ready",
            stagedDocumentCount: 1,
            conversionIssues: [],
          };
        }
        if (command === "inspect_legacy_identity_conflicts") {
          return [{
            conflictKey,
            entityKind: "commit",
            legacyId: "commit-a",
            existingVariantCount: 1,
          }];
        }
        throw new Error(`unexpected command ${command}`);
      },
    },
  };
  const exports = await loadModule('src/platform/legacyImport.ts', dependencies);

  const raw = JSON.stringify(source);
  const prepared = await exports.prepareLegacyMigration(
    raw,
    { kind: "project-versions", snapshot: null, store: source },
    {
      documentId: "native-doc",
      contextId: "context-a",
      revision: "4",
      branchId: "main:native-doc",
      headId: null,
    },
    "resume-diy-versions-synthetic",
  );

  assert.deepEqual(calls.map((item) => item.command), [
    "inspect_legacy_migration",
    "dry_run_legacy_migration",
    "inspect_legacy_identity_conflicts",
  ]);
  assert.equal(calls[0].args.request.sources[0].rawJson, raw);
  assert.equal(calls[0].args.request.sourceNamespace, "resume-diy-versions-synthetic");
  assert.equal(calls[1].args.request.convertedDocuments[0].document.documentId, "native-doc");
  assert.equal(calls[2].args.request.versionGraph.commits[0].id, "commit-a");
  assert.equal(prepared.request.currentDraft, null);
  assert.deepEqual(prepared.request.acceptedIdentityUpdates, [conflictKey]);
});
