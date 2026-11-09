/* 由 4 个同组测试文件合并；测试块自包含，行为与合并前一致。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";
import { composePdf } from "../../fixtures/import-quality/materialize.mjs";
import { syntheticDocx, syntheticComplexDocx } from "./fixtures/synthetic-docx.mjs";

/* ==== 原 imported-layout-components.test.mjs ==== */

test("source layout edits only changed boxes and can restore the original", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(async () => (await import("/tests/browser/fixtures/imported-layout.tsx")).mountImportedLayout());
    const name = page.locator('[data-imported-layout-field="name"] input');
    await name.waitFor();
    assert.equal(await page.locator(".imported-layout-patch").count(), 0);
    await name.fill("Changed name");
    assert.equal(await page.locator('[data-imported-layout-patch="name"]').innerText(), "Changed name");
    assert.equal(await page.locator('[data-imported-layout-patch="role"]').count(), 0);
    await name.fill("");
    assert.equal(await page.locator('[data-imported-layout-cover="name"]').count(), 1);
    const coverBottom = await page.locator('[data-imported-layout-cover="name"]').evaluate((element) => element.offsetTop + element.offsetHeight);
    assert.ok(coverBottom < 92, "cover must not obscure the next line");
    await page.getByRole("button", { name: "恢复原文" }).click();
    assert.equal(await name.inputValue(), "Original name");
    assert.equal(await page.locator(".imported-layout-patch").count(), 0);
  } finally { await browser.close(); await server.close(); }
});

test("source layout print produces real PDF text for changed and unchanged boxes", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(async () => {
      const { layout } = await import("/tests/browser/fixtures/imported-layout.tsx");
      const { prepareSourceLayoutPrint } = await import("/src/ui/services/source-layout-print.tsx");
      const image = new Image(); image.src = layout.pages[0].background; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      canvas.getContext("2d").drawImage(image, 0, 0);
      const rasterLayout = { ...layout, pages: [{ ...layout.pages[0], background: canvas.toDataURL("image/png") }] };
      window.disposeSourcePrint = await prepareSourceLayoutPrint(rasterLayout, { name: "Changed name" });
    });
    const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    const extracted = await page.evaluate(async bytes => {
      const pdfjs = await import("/node_modules/pdfjs-dist/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs";
      const loading = pdfjs.getDocument({ data: new Uint8Array(bytes) });
      const doc = await loading.promise;
      try { const first = await doc.getPage(1); return { pages: doc.numPages,
        text: (await first.getTextContent()).items.map(item => item.str ?? "").join(" ") }; }
      finally { await loading.destroy(); }
    }, [...pdf]);
    assert.equal(extracted.pages, 1);
    assert.match(extracted.text, /Changed name/);
    assert.match(extracted.text, /Original role/);
    assert.doesNotMatch(extracted.text, /Original name/);
    await page.evaluate(() => window.disposeSourcePrint());
    assert.equal(await page.locator("[data-source-layout-print-root]").count(), 0);
  } finally { await browser.close(); await server.close(); }
});

test("source layout print refuses PDF export when a page has no editable text", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const rejection = await page.evaluate(async () => {
      const { layout } = await import("/tests/browser/fixtures/imported-layout.tsx");
      const { prepareSourceLayoutPrint } = await import("/src/ui/services/source-layout-print.tsx");
      // 第二页没有任何文字框：PDF 导出必须显式拒绝而不是虚称成功。
      const sparse = { ...layout, pages: [...layout.pages, layout.pages[0]] };
      try {
        const dispose = await prepareSourceLayoutPrint(sparse, {});
        dispose();
        return null;
      } catch (error) { return error.message; }
    });
    assert.match(rejection, /部分页面没有可编辑文字/);
    assert.equal(await page.locator("[data-source-layout-print-root]").count(), 0);
  } finally { await browser.close(); await server.close(); }
});

/* ==== 原 source-layout-pdf.test.mjs ==== */

test("source layout extracts each PDF page and keeps its own coordinates and baseline", { timeout: 90000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const external = [];
    page.on("request", (request) => { if (!request.url().startsWith(origin) && !request.url().startsWith("data:") && !request.url().startsWith("blob:")) external.push(request.url()); });
    await page.goto(`${origin}/__zinecv_browser_test_page.html`);
    const pdf = composePdf([{ lines: ["FIRST PAGE NAME", "FIRST PAGE ROLE"] }, { lines: ["SECOND PAGE NAME", "SECOND PAGE ROLE"] }]);
    const result = await page.evaluate(async (encoded) => {
      const { extractPdfSourceLayout } = await import("/src/ui/services/source-layout-pdf.ts");
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      const file = new File([bytes], "two-pages.pdf", { type: "application/pdf" });
      const layout = await extractPdfSourceLayout(file);
      const controller = new AbortController(); controller.abort();
      let cancelled = false;
      try { await extractPdfSourceLayout(file, controller.signal); } catch (error) { cancelled = error.name === "AbortError"; }
      return { layout, cancelled };
    }, pdf.toString("base64"));
    assert.equal(result.cancelled, true);
    assert.deepEqual(external, []);
    assert.equal(result.layout.pages.length, 2);
    for (let index = 0; index < 2; index++) {
      const boxes = result.layout.boxes.filter((box) => box.page === index + 1);
      assert.ok(boxes.length >= 2);
      assert.ok(boxes.every((box) => box.id.startsWith(`p${index + 1}-`) && Number.isFinite(box.baseline) && box.y >= 0));
      assert.match(result.layout.pages[index].background, /^data:image\//);
      assert.ok(boxes.some((box) => box.text.includes(index ? "SECOND PAGE" : "FIRST PAGE")));
    }
  } finally { await browser.close(); await server.close(); }
});

test("a page without selectable text stays in the source layout without invented boxes", { timeout: 90000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const pdf = composePdf([{ lines: ["Selectable first page"] }, { lines: [] }]);
    const layout = await page.evaluate(async (encoded) => {
      const { extractPdfSourceLayout } = await import("/src/ui/services/source-layout-pdf.ts");
      return extractPdfSourceLayout(new File([Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))], "blank-page.pdf", { type: "application/pdf" }));
    }, pdf.toString("base64"));
    assert.equal(layout.pages.length, 2);
    assert.equal(layout.boxes.filter((box) => box.page === 2).length, 0);
    assert.ok(layout.warnings.some((warning) => warning.includes("第 2 页")));
  } finally { await browser.close(); await server.close(); }
});

test("optional source layout retains structured recognition and does not alter the default import", { timeout: 90000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const pdf = composePdf([{ lines: ["Alex Sample", "alex@example.invalid", "Work Experience", "Example Company 2020 - 2024"] }]);
    const result = await page.evaluate(async (encoded) => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      const file = new File([bytes], "source.pdf", { type: "application/pdf" });
      const regular = await recognizeTemplate(file);
      const retained = await recognizeTemplate(file, undefined, undefined, { preserveSourceLayout: true });
      return { regular: { text: regular.extractedText, resume: regular.resume, sourceLayout: regular.sourceLayout },
        retained: { text: retained.extractedText, resume: retained.resume, sourceLayout: retained.sourceLayout } };
    }, pdf.toString("base64"));
    assert.equal(result.regular.sourceLayout, undefined);
    assert.equal(result.retained.text, result.regular.text);
    const withoutGeneratedIds = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === "id" ? undefined : item));
    assert.deepEqual(withoutGeneratedIds(result.retained.resume), withoutGeneratedIds(result.regular.resume));
    assert.equal(result.retained.sourceLayout.pages.length, 1);
    assert.ok(result.retained.sourceLayout.boxes.length > 0);
  } finally { await browser.close(); await server.close(); }
});

/* ==== 原 source-layout-word.test.mjs ==== */

test("Word source layout uses the isolated preview and retains recognized text", { timeout: 90000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const external = [];
    page.on("request", (request) => { if (!request.url().startsWith(origin) && !request.url().startsWith("data:") && !request.url().startsWith("blob:")) external.push(request.url()); });
    await page.goto(`${origin}/__zinecv_browser_test_page.html`);
    const result = await page.evaluate(async (encoded) => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      const file = new File([bytes], "source.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      return recognizeTemplate(file, undefined, undefined, { preserveSourceLayout: true });
    }, syntheticDocx(["Alex Sample", "Work Experience", "Example Company 2020 to 2024"]).toString("base64"));
    assert.match(result.extractedText, /Example Company/);
    assert.equal(result.sourceLayout.pages.length, 1);
    assert.ok(result.sourceLayout.boxes.some((box) => box.text.includes("Alex Sample")));
    assert.match(result.sourceLayout.pages[0].background, /^data:image\//);
    assert.deepEqual(external, []);
  } finally { await browser.close(); await server.close(); }
});

test("complex Word source layout retains visible textbox content or explicitly falls back", { timeout: 90000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const result = await page.evaluate(async (encoded) => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      return recognizeTemplate(new File([bytes], "complex.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), undefined, undefined, { preserveSourceLayout: true });
    }, syntheticComplexDocx().toString("base64"));
    assert.match(result.extractedText, /OWNED TEXTBOX/);
    if (result.sourceLayout) assert.ok(result.sourceLayout.boxes.some((box) => box.text.includes("OWNED TEXTBOX")));
    else assert.ok(result.recognitionWarnings.some((warning) => warning.includes("原版式未通过")));
  } finally { await browser.close(); await server.close(); }
});

/* ==== 原 source-layout-workspace.test.mjs ==== */

test("source editing updates the correct preview page and pagination", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../..")); await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/source-layout-workspace.tsx"));
    const input = page.locator('[data-imported-layout-field="p1-b1"] input'); await input.waitFor();
    assert.equal(await page.locator(".resume-pages .imported-layout-paper").count(), 2);
    assert.match(await page.locator(".preview-pagination").getAttribute("aria-label"), /共 2 页/);
    await input.fill("Updated");
    assert.equal(await page.locator('[data-page-number="1"] [data-imported-layout-patch="p1-b1"]').innerText(), "Updated");
    assert.equal(await page.locator('[data-page-number="2"] .imported-layout-patch').count(), 0);
    await page.getByRole("button", { name: "下一页" }).click();
    await page.waitForFunction(() => document.querySelector(".preview-pagination")?.getAttribute("aria-label")?.includes("第 2 页"));
  } finally { await browser.close(); await server.close(); }
});

test("source layout rendering preserves page order and edited text without leaving temporary papers", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../..")); await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const result = await page.evaluate(async () => {
      const { renderSourceLayoutPages } = await import("/src/ui/services/source-layout-render.tsx");
      const background = color => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="794" height="1123"><rect width="794" height="1123" fill="${color}"/></svg>`)}`;
      const layout = { version: 1, pages: [{ width: 794, height: 1123, background: background("white") }, { width: 794, height: 1123, background: background("#e0e0e0") }],
        boxes: [{ id: "first", page: 1, x: 50, y: 60, width: 200, height: 35, text: "Before", fontSize: 24, lineHeight: 30,
          fontFamily: "Arial", fontWeight: "400", fontStyle: "normal", color: "#000", background: "#fff", align: "left" }], extractedChars: 6, warnings: [] };
      const original = await renderSourceLayoutPages(layout, {});
      const edited = await renderSourceLayoutPages(layout, { first: "After" });
      const lowerDpi = await renderSourceLayoutPages(layout, { first: "After" }, 144);
      const changing = { first: "After" };
      const pending = renderSourceLayoutPages(layout, changing);
      changing.first = "Changed during rendering";
      const frozen = await pending;
      let invalidRejected = false;
      try { await renderSourceLayoutPages({ ...layout, pages: [{ ...layout.pages[0], background: "data:image/png;base64,invalid" }] }, {}); }
      catch { invalidRejected = true; }
      const pixel = (canvas, x, y) => [...canvas.getContext("2d").getImageData(x, y, 1, 1).data];
      return { count: edited.length, dimensions: edited.map(canvas => [canvas.width, canvas.height]), lowerDpi: [lowerDpi[0].width, lowerDpi[0].height],
        before: original[0].toDataURL(), after: edited[0].toDataURL(), frozen: frozen[0].toDataURL(), invalidRejected, second: pixel(edited[1], 100, 100),
        remaining: document.querySelectorAll("[data-source-layout-export-root]").length };
    });
    assert.equal(result.count, 2);
    assert.deepEqual(result.dimensions, [[1588, 2246], [1588, 2246]]);
    assert.deepEqual(result.lowerDpi, [1191, 1684]);
    assert.notEqual(result.before, result.after);
    assert.equal(result.frozen, result.after);
    assert.equal(result.invalidRejected, true);
    assert.deepEqual(result.second, [224, 224, 224, 255]);
    assert.equal(result.remaining, 0);
  } finally { await browser.close(); await server.close(); }
});

test("source layout PNG artifacts preserve pages, long image and verifiable checksums", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../..")); await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const result = await page.evaluate(async () => {
      const { encodeSourceLayoutPng } = await import("/src/ui/services/source-layout-png.ts");
      const { checkExportOutput } = await import("/src/ui/services/export-output-checks.ts");
      const canvas = color => { const node = document.createElement("canvas"); node.width = 12; node.height = 15;
        const ctx = node.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 12, 15); return node; };
      const output = await encodeSourceLayoutPng([canvas("red"), canvas("blue")]);
      const findings = await checkExportOutput({ cursor: {}, renderKey: "test", data: { ...output, pageCount: 2,
        pdfBase64: "", pdfSha256: "", dpi: 192, product: "png", selectedPages: null,
        textMap: { version: 1, logicalText: "", clusters: [], hitRegions: [], links: [] } } }, "png");
      const image = await createImageBitmap(new Blob([Uint8Array.from(atob(output.longPng.dataBase64), c => c.charCodeAt(0))], { type: "image/png" }));
      const target = document.createElement("canvas"); target.width = image.width; target.height = image.height;
      const context = target.getContext("2d"); context.drawImage(image, 0, 0); image.close();
      return { findings, pages: output.pngPages.map(({ page, width, height }) => [page, width, height]),
        long: [target.width, target.height], top: [...context.getImageData(1, 1, 1, 1).data],
        bottom: [...context.getImageData(1, 20, 1, 1).data] };
    });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.pages, [[1, 12, 15], [2, 12, 15]]);
    assert.deepEqual(result.long, [12, 30]);
    assert.deepEqual(result.top, [255, 0, 0, 255]);
    assert.deepEqual(result.bottom, [0, 0, 255, 255]);
  } finally { await browser.close(); await server.close(); }
});

test("source layout PNG respects page and long-image limits", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../..")); await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const result = await page.evaluate(async () => {
      const { encodeSourceLayoutPng } = await import("/src/ui/services/source-layout-png.ts");
      const narrow = document.createElement("canvas"); narrow.width = 1; narrow.height = 3300;
      const output = await encodeSourceLayoutPng(Array(10).fill(narrow));
      let oversizedRejected = false;
      try { await encodeSourceLayoutPng([{ width: 8001, height: 8001 }]); } catch { oversizedRejected = true; }
      return { limited: output.longImageLimited, long: output.longPng, pages: output.pngPages.length, oversizedRejected };
    });
    assert.deepEqual(result, { limited: true, long: null, pages: 10, oversizedRejected: true });
  } finally { await browser.close(); await server.close(); }
});

test("source layout export binds edits to the saved document and exact template revision", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../..")); await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const result = await page.evaluate(async () => {
      const { freezeSourceLayoutForExport } = await import("/src/ui/services/source-layout-freeze.ts");
      const layout = { version: 1, pages: [{ width: 794, height: 1123, background: "data:image/png;base64,AA==" }],
        boxes: [{ id: "box-1", page: 1, text: "old" }], extractedChars: 3, warnings: [] };
      const template = { id: "source-a", revisionHash: "revision-a", sourceLayout: layout };
      const document = { legacyExtensions: { importedTemplate: { id: "source-a", revisionHash: "revision-a" },
        sourceLayoutEdits: { templateId: "source-a", revisionHash: "revision-a", edits: { "box-1": "new" } } } };
      const frozen = freezeSourceLayoutForExport(document, template);
      document.legacyExtensions.sourceLayoutEdits.edits["box-1"] = "later";
      layout.boxes[0].text = "later";
      const rejects = (doc, item) => { try { freezeSourceLayoutForExport(doc, item); return false; } catch { return true; } };
      const wrongRevision = rejects(document, { ...template, revisionHash: "revision-b" });
      const wrongTemplate = rejects(document, { ...template, id: "source-b" });
      const orphan = rejects({ legacyExtensions: { ...document.legacyExtensions, sourceLayoutEdits: {
        templateId: "source-a", revisionHash: "revision-a", edits: { missing: "data" } } } }, template);
      return { text: frozen.layout.boxes[0].text, edit: frozen.edits["box-1"], wrongRevision, wrongTemplate, orphan };
    });
    assert.deepEqual(result, { text: "old", edit: "new", wrongRevision: true, wrongTemplate: true, orphan: true });
  } finally { await browser.close(); await server.close(); }
});

