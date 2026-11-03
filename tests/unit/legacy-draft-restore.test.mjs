import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadModule } from "./module-loader.mjs";

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
