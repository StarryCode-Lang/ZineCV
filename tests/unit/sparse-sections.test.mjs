import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadModule } from "./module-loader.mjs";

test("a missing section is inserted instead of moving an unknown identifier", async () => {
  const bridge = await loadModule("src/platform/documentBridge.ts", {
    "./legacySnapshot": {}, "./legacyRichText": {}, "./sourceLayoutEdits": {},
    "../ui/domain/resume-model": { moduleTitles: {} },
    "../ui/domain/template-model": {},
  });
  const summary = { id: "old-summary", kind: "summary", title: "Summary", visible: true, body: [] };
  const work = { id: "legacy-section:work", kind: "work", title: "Work", visible: true, entries: [] };
  const current = { title: "Resume", basic: {}, sections: [summary], presentation: {}, legacyExtensions: {} };
  const desired = { ...current, sections: [summary, work] };
  assert.deepEqual(bridge.nextDocumentCommand(current, desired), { type: "addSection", section: work, index: 1 });
});

test("unmodified projected layout retains original native values and unknown overrides", async () => {
  const { alignDraftDocument } = await loadModule("src/platform/legacyDraftAlignment.ts", {});
  const current = { basic: {}, sections: [], presentation: { fontSetId: "fixture-fonts", fontSizePt: 10, legacyOverrides: { opaque: "kept" } }, legacyExtensions: {} };
  const projected = { ...current, presentation: { fontSetId: "legacy-font:宋体", fontSizePt: 10, legacyOverrides: { generated: "value" } } };
  assert.deepEqual(alignDraftDocument(projected, current, projected).presentation, current.presentation);
  const edited = { ...projected, presentation: { ...projected.presentation, fontSizePt: 12 } };
  assert.deepEqual(alignDraftDocument(edited, current, projected).presentation, { ...current.presentation, fontSizePt: 12 });
});

test("sparse drafts preserve section identities, absent empty sections and nullable fields", async () => {
  const { alignDraftDocument } = await loadModule("src/platform/legacyDraftAlignment.ts", {});
  const summary = { id: "old-summary", kind: "summary", title: "Summary", visible: true, body: [] };
  const work = { id: "legacy-section:work", kind: "work", title: "Work", visible: false, entries: [] };
  const current = { basic: { website: null }, sections: [summary], presentation: {}, legacyExtensions: { opaque: { value: 1 } } };
  const desired = { basic: { website: "" }, sections: [{ ...summary, id: "legacy-section:summary" }, work], presentation: {}, legacyExtensions: {} };
  assert.deepEqual(alignDraftDocument(desired, current), current);
  const populated = { ...work, entries: [{ id: "entry-1" }] };
  const aligned = alignDraftDocument({ ...desired, sections: [desired.sections[0], populated] }, current);
  assert.equal(aligned.sections[0].id, "old-summary");
  assert.deepEqual(aligned.sections[1], populated);
  assert.throws(() => alignDraftDocument(desired, { ...current, sections: [summary, { ...summary, id: "duplicate" }] }), /section/i);
  const withSourceEdits = { ...current, legacyExtensions: { ...current.legacyExtensions, sourceLayoutEdits: { templateId: "a", edits: { box: "old" } } } };
  assert.equal(alignDraftDocument(desired, withSourceEdits).legacyExtensions.sourceLayoutEdits, undefined);
});
