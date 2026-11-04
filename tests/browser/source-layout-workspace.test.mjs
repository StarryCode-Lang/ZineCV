import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

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
