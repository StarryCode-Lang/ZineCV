import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { syntheticDocx, syntheticComplexDocx } from "./fixtures/synthetic-docx.mjs";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

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
