import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadModule } from "./module-loader.mjs";

test("native catalog hydrates source pages and sends references without duplicating image bytes", async () => {
  const hash = "a".repeat(64), image = "data:image/png;base64,c291cmNl";
  let payload = JSON.stringify([{ id: "source", name: "Source", sourceName: "source.pdf", sourceType: "pdf",
    accent: "#000", formatId: "legacy-v1", layout: "single-column",
    sourceLayout: { version: 1, pages: [{ width: 794, height: 1123, backgroundAssetId: hash }], boxes: [], extractedChars: 0, warnings: [] } }]);
  let sent;
  const catalog = await loadModule("src/ui/domain/imported-template.ts", { "../../platform/ipc": {
    hasDocumentRuntime: () => true,
    nativeInvoke: async (command, args) => {
      if (command === "read_imported_template_catalog") return { revision: 1, payloadJson: payload };
      if (command === "read_avatar_asset") { assert.equal(args.hash, hash); return { dataUrl: image }; }
      if (command === "write_imported_template_catalog") { sent = JSON.parse(args.payloadJson); payload = args.payloadJson; return 2; }
      throw new Error(command);
    },
  } });
  const loaded = await catalog.loadImportedTemplates();
  assert.equal(loaded[0].sourceLayout.pages[0].background, image);
  await catalog.writeImportedTemplates(loaded);
  assert.equal(sent[0].sourceLayout.pages[0].background, undefined);
  assert.equal(sent[0].sourceLayout.pages[0].backgroundAssetId, hash);
});

test("a missing source page reports recovery instead of inventing a background", async () => {
  const payload = JSON.stringify([{ id: "missing", name: "Missing", sourceName: "source.pdf", sourceType: "pdf",
    accent: "#000", formatId: "legacy-v1", sourceLayout: { version: 1,
      pages: [{ width: 794, height: 1123, backgroundAssetId: "b".repeat(64) }], boxes: [], extractedChars: 0, warnings: [] } }]);
  const catalog = await loadModule("src/ui/domain/imported-template.ts", { "../../platform/ipc": {
    hasDocumentRuntime: () => true,
    nativeInvoke: async (command) => {
      if (command === "read_imported_template_catalog") return { revision: 1, payloadJson: payload };
      if (command === "read_avatar_asset") throw new Error("missing asset");
      throw new Error(command);
    },
  } });
  const [template] = await catalog.loadImportedTemplates();
  assert.match(template.previewRecoveryWarning, /背景资源缺失/);
  assert.equal(template.sourceLayout.pages[0].background, undefined);
});
