import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

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
