import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { chromium } from "playwright";
import { createServer } from "vite";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

test("WebView2 freezes source links, checks their geometry and writes a verifiable PDF", { timeout: 180_000 }, async () => {
  const root = resolve(import.meta.dirname, "../../.artifacts/runtime-tmp");
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const profile = await realpath(await mkdtemp(join(canonicalRoot, "source-layout-links-")));
  assert.ok(profile.startsWith(canonicalRoot + sep));
  let server, host, failure;
  try {
    const sourceBrowser = await chromium.launch({ headless: true });
    let sourcePdf;
    try {
      const sourcePage = await sourceBrowser.newPage();
      await sourcePage.setContent('<style>@page{size:A4;margin:0}body{margin:0;font:18px Arial} a{position:absolute;display:block}</style><div style="position:absolute;left:50px;top:62px">Original name</div><a style="left:50px;top:62px;width:100px;height:22px" href="https://example.org/text"></a><a style="left:300px;top:400px;width:80px;height:40px" href="mailto:hello@example.org"></a>');
      sourcePdf = await sourcePage.pdf({ format: "A4", printBackground: true });
    } finally { await sourceBrowser.close(); }
    server = await createServer({ server: { host: "127.0.0.1", port: 5174, strictPort: true } });
    await server.listen();
    host = await startNativeHost(profile, { buildProfile: process.env.ZINECV_LINK_TEST_PROFILE ?? "release" });
    const result = await host.page.evaluate(async ({ path, source }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const { extractPdfSourceLayout } = await import("/src/ui/services/source-layout-pdf.ts");
      const bytes = Uint8Array.from(atob(source), char => char.charCodeAt(0));
      const layout = await extractPdfSourceLayout(new File([bytes], "source.pdf", { type: "application/pdf" }));
      if (!layout || layout.linkStatus !== "complete" || layout.sourceLinks.length !== 2) throw new Error("Source links were not extracted");
      const old = await invoke("read_imported_template_catalog");
      const items = old ? JSON.parse(old.payloadJson) : [];
      items.push({ id: "synthetic-linked-source", name: "Synthetic linked source", sourceName: "source.pdf", sourceType: "pdf",
        createdAt: "2026-11-05T00:00:00Z", accent: "#000000", formatId: "legacy-v1", layout: "single-column", analysis: "synthetic", sourceLayout: layout });
      await invoke("write_imported_template_catalog", { payloadJson: JSON.stringify(items), expectedRevision: old?.revision ?? 0 });
      const catalog = await invoke("read_imported_template_catalog");
      const saved = JSON.parse(catalog.payloadJson).find(item => item.id === "synthetic-linked-source");
      let state = await invoke("document_state");
      await invoke("apply_document_command", { envelope: { protocolVersion: 1, commandId: crypto.randomUUID(),
        documentId: state.cursor.documentId, contextId: state.cursor.contextId, expectedRevision: state.cursor.revision,
        expectedBranchId: state.cursor.branchId, expectedHeadId: state.cursor.headId,
        payload: { type: "setLegacyExtensions", extensions: { ...state.document.legacyExtensions,
          importedTemplate: { id: saved.id, name: saved.name, revisionHash: saved.revisionHash } } } } });
      state = await invoke("document_state");
      const { prepareSourceLayoutPrint } = await import("/src/ui/services/source-layout-print.tsx");
      const dispose = await prepareSourceLayoutPrint(layout, {});
      let output;
      try {
        await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
        output = await invoke("render_source_layout_pdf", { cursor: state.cursor, templateId: saved.id,
          revisionHash: saved.revisionHash, edits: {}, pageCount: 1 });
      } finally { dispose(); }
      const { checkExportOutput } = await import("/src/ui/services/export-output-checks.ts");
      const findings = await checkExportOutput(output, "pdf");
      const forged = structuredClone(output); forged.data.textMap.pageLinks[0].xPt += 20;
      const rejected = (await checkExportOutput(forged, "pdf")).some(item => item.id.includes("links"));
      if (findings.length || !rejected) throw new Error("Source link validation failed");
      const write = await invoke("write_export_file", { path, dataBase64: output.data.pdfBase64,
        exportId: output.exportId, artifactId: "pdf", writeId: crypto.randomUUID() });
      return { sha: output.data.pdfSha256, count: output.data.textMap.pageLinks.length, receipt: Boolean(write.receipt) };
    }, { path: join(profile, "linked.pdf"), source: sourcePdf.toString("base64") });
    const bytes = await readFile(join(profile, "linked.pdf"));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), result.sha);
    assert.equal(result.count, 2); assert.equal(result.receipt, true);
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    try {
      const pdf = await loading.promise;
      const links = (await (await pdf.getPage(1)).getAnnotations()).filter(item => item.subtype === "Link").map(item => item.url).sort();
      assert.deepEqual(links, ["https://example.org/text", "mailto:hello@example.org"]);
    } finally { await loading.destroy(); }
  } catch (error) { failure = error; throw error; }
  finally {
    if (host) await stopNativeHost(host);
    if (server) await server.close();
    try { await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
    catch (error) { if (!failure) throw error; console.error(`Isolated profile cleanup failed: ${error.message}`); }
  }
});
