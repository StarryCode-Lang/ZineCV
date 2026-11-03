import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadModule } from "./module-loader.mjs";

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
