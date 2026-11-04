import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createServer } from "vite";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

test("isolated WebView2 saves source-layout PDF with real edited text and PNG with a host receipt", { timeout: 180_000 }, async () => {
  const tempRoot = resolve(import.meta.dirname, "../../.artifacts/runtime-tmp");
  await mkdir(tempRoot, { recursive: true });
  const canonicalRoot = await realpath(tempRoot);
  const profile = await mkdtemp(join(canonicalRoot, "source-layout-export-"));
  const canonicalProfile = await realpath(profile);
  assert.ok(canonicalProfile.startsWith(canonicalRoot + sep));
  let server, host, failure;
  try {
    server = await createServer({ server: { host: "127.0.0.1", port: 5174, strictPort: true } });
    await server.listen();
    host = await startNativeHost(canonicalProfile, { buildProfile: "debug" });
    const result = await host.page.evaluate(async ({ pdfPath, pngPath }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const image = document.createElement("canvas"); image.width = 794; image.height = 1123;
      const ctx = image.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 794, 1123);
      ctx.fillStyle = "black"; ctx.font = "18px Arial"; ctx.fillText("Original name", 50, 80); ctx.fillText("Original role", 50, 110);
      const background = image.toDataURL("image/png");
      const common = { page: 1, x: 50, width: 270, height: 22, fontSize: 18, lineHeight: 22,
        fontFamily: "Arial", fontWeight: "400", fontStyle: "normal", color: "#000", background: "#fff", align: "left" };
      const layout = { version: 1, pages: [{ width: 794, height: 1123, background }],
        boxes: [{ ...common, id: "name", y: 62, text: "Original name" }, { ...common, id: "role", y: 92, text: "Original role" }],
        extractedChars: 26, warnings: [] };
      const oldCatalog = await invoke("read_imported_template_catalog");
      const oldItems = oldCatalog ? JSON.parse(oldCatalog.payloadJson) : [];
      const template = { id: "isolated-source-template", name: "Synthetic", sourceName: "synthetic.pdf", sourceType: "pdf",
        createdAt: "2026-11-04T00:00:00Z", accent: "#000000", formatId: "legacy-v1", layout: "single-column",
        analysis: "synthetic", sourceLayout: layout };
      await invoke("write_imported_template_catalog", { payloadJson: JSON.stringify([...oldItems, template]), expectedRevision: oldCatalog?.revision ?? 0 });
      const catalog = await invoke("read_imported_template_catalog");
      const saved = JSON.parse(catalog.payloadJson).find(item => item.id === template.id);
      const revisionHash = saved.revisionHash;
      const edits = { name: "Edited name" };
      let state = await invoke("document_state");
      await invoke("apply_document_command", { envelope: { protocolVersion: 1, commandId: crypto.randomUUID(),
        documentId: state.cursor.documentId, contextId: state.cursor.contextId, expectedRevision: state.cursor.revision,
        expectedBranchId: state.cursor.branchId, expectedHeadId: state.cursor.headId,
        payload: { type: "setLegacyExtensions", extensions: { ...state.document.legacyExtensions,
          importedTemplate: { id: template.id, name: template.name, revisionHash },
          sourceLayoutEdits: { templateId: template.id, revisionHash, edits } } } } });
      state = await invoke("document_state");
      const frozen = { ...layout, pages: [{ ...layout.pages[0], backgroundAssetId: saved.sourceLayout.pages[0].backgroundAssetId }] };
      const { prepareSourceLayoutPrint } = await import("/src/ui/services/source-layout-print.tsx");
      const dispose = await prepareSourceLayoutPrint(frozen, edits);
      let pdf;
      try {
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        pdf = await invoke("render_source_layout_pdf", { cursor: state.cursor, templateId: template.id, revisionHash, edits, pageCount: 1 });
      } finally { dispose(); }
      const { checkExportOutput } = await import("/src/ui/services/export-output-checks.ts");
      const pdfFindings = await checkExportOutput(pdf, "pdf");
      if (pdfFindings.length) throw new Error(JSON.stringify(pdfFindings));
      const pdfWrite = await invoke("write_export_file", { path: pdfPath, dataBase64: pdf.data.pdfBase64,
        exportId: pdf.exportId, artifactId: "pdf", writeId: crypto.randomUUID() });
      const { renderSourceLayoutPages } = await import("/src/ui/services/source-layout-render.tsx");
      const { encodeSourceLayoutPng } = await import("/src/ui/services/source-layout-png.ts");
      const canvases = await renderSourceLayoutPages(frozen, edits, 144);
      let png;
      try { png = await encodeSourceLayoutPng(canvases); } finally { canvases.forEach(canvas => { canvas.width = 0; canvas.height = 0; }); }
      const data = { ...png, pageCount: 1, dpi: 144, product: "png", selectedPages: null, pdfBase64: "", pdfSha256: "",
        textMap: { version: 1, logicalText: "", clusters: [], hitRegions: [], links: [] } };
      const bundle = await invoke("register_source_layout_export", { cursor: state.cursor, templateId: template.id, revisionHash, edits, data });
      const pngFindings = await checkExportOutput(bundle, "png");
      if (pngFindings.length) throw new Error(JSON.stringify(pngFindings));
      const pngWrite = await invoke("write_export_file", { path: pngPath, dataBase64: bundle.data.longPng.dataBase64,
        exportId: bundle.exportId, artifactId: "png:long", writeId: crypto.randomUUID() });
      let staleRejected = false;
      try { await invoke("register_source_layout_export", { cursor: state.cursor, templateId: template.id, revisionHash,
        edits: { name: "different" }, data }); } catch { staleRejected = true; }
      return { pdfWrite, pngWrite, pdfSha: pdf.data.pdfSha256, pngSha: bundle.data.longPng.sha256,
        text: pdf.data.textMap.logicalText, width: bundle.data.longPng.width, height: bundle.data.longPng.height, staleRejected };
    }, { pdfPath: join(canonicalProfile, "source.pdf"), pngPath: join(canonicalProfile, "source.png") });
    const pdf = await readFile(join(canonicalProfile, "source.pdf"));
    const png = await readFile(join(canonicalProfile, "source.png"));
    if (process.env.ZINECV_KEEP_SOURCE_LAYOUT_PREVIEW === "1") {
      await writeFile(join(tempRoot, "source-layout-synthetic.pdf"), pdf);
      await writeFile(join(tempRoot, "source-layout-synthetic.png"), png);
    }
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    assert.equal(hash(pdf), result.pdfSha); assert.equal(hash(png), result.pngSha);
    assert.ok(result.pdfWrite.receipt); assert.ok(result.pngWrite.receipt);
    assert.match(result.text, /Edited name/); assert.match(result.text, /Original role/);
    assert.deepEqual([result.width, result.height], [1191, 1684]);
    assert.equal(result.staleRejected, true);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (host) await stopNativeHost(host);
    if (server) await server.close();
    try { await rm(canonicalProfile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
    catch (error) { if (!failure) throw error; console.error(`Isolated profile cleanup failed: ${error.message}`); }
  }
});
