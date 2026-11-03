import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { composePdf } from "../../fixtures/import-quality/materialize.mjs";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

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
