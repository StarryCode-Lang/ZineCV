import { test } from "node:test";
import { strict as assert } from "node:assert";
import { syntheticDocx, syntheticComplexDocx } from "./fixtures/synthetic-docx.mjs";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";


test("synthetic DOCX parses in a worker and renders only inside the sandboxed preview", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const server = await createBrowserTestServer(root);
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await context.newPage();
    const externalRequests = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(origin)) externalRequests.push(request.url());
    });
    await page.goto(`${origin}/__zinecv_browser_test_page.html`, { waitUntil: "commit" });
    const encodedDocx = syntheticDocx().toString("base64");
    const result = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const file = new File([bytes], "synthetic-resume.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      const { recognizeTemplate } = await import(
        "/src/ui/services/template-import.ts"
      );
      const createdFrames = [];
      const originalCreateElement = document.createElement.bind(document);
      document.createElement = (tagName, options) => {
        const element = originalCreateElement(tagName, options);
        if (tagName.toLowerCase() === "iframe") {
          const evidence = { element, csp: undefined };
          element.addEventListener("load", () => {
            evidence.csp = element.contentDocument?.querySelector(
              'meta[http-equiv="Content-Security-Policy"]',
            )?.getAttribute("content");
          }, { once: true });
          createdFrames.push(evidence);
        }
        return element;
      };
      let template;
      try {
        template = await recognizeTemplate(file);
      } finally {
        document.createElement = originalCreateElement;
      }
      return {
        template,
        frames: createdFrames.map(({ element, csp }) => ({
          sandbox: element.getAttribute("sandbox"),
          csp,
          disposed: !element.isConnected,
        })),
      };
    }, encodedDocx);
    assert.match(result.template.extractedText, /Synthetic Resume/);
    assert.match(result.template.extractedText, /Experience candidate text 2020/);
    assert.match(result.template.previewDataUrl, /^data:image\/jpeg;base64,/);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].sandbox, "allow-same-origin");
    assert.match(result.frames[0].csp, /default-src 'none'/);
    assert.equal(result.frames[0].disposed, true);
    assert.deepEqual(externalRequests, []);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});

test("complex owned DOCX preserves table/list/textbox text without duplicates and renders header/footer/image", async () => {
  const docx = syntheticComplexDocx();
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server); const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await page.goto(`${origin}/__zinecv_browser_test_page.html`);
    const result = await page.evaluate(async base64 => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const captured = { text: "", imageCount: 0 }; const create = document.createElement.bind(document);
      document.createElement = (tag, options) => {
        const element = create(tag, options);
        if (tag.toLowerCase() === "iframe") element.addEventListener("load", () => {
          const capture = () => { captured.text = element.contentDocument.body.textContent; captured.imageCount = element.contentDocument.querySelectorAll("img,image").length; captured.images = Array.from(element.contentDocument.querySelectorAll("svg")).map(image => ({ html: image.outerHTML, bounds: image.getBoundingClientRect().toJSON() })); };
          new MutationObserver(capture).observe(element.contentDocument, { childList: true, subtree: true, attributes: true });
        }, { once: true });
        return element;
      };
      try {
        const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
        const template = await recognizeTemplate(new File([bytes], "owned-complex.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
        return { text: template.extractedText, preview: template.previewDataUrl, captured };
      } finally { document.createElement = create; }
    }, docx.toString("base64"));
    for (const text of ["OWNED DOCX OWNER", "OWNED LIST ITEM", "TABLE LEFT", "TABLE RIGHT", "OWNED TEXTBOX"]) assert.equal(result.text.split(text).length - 1, 1, `${text} retained once`);
    assert.match(result.preview, /^data:image/);
    assert.match(result.captured.text, /OWNED HEADER/); assert.match(result.captured.text, /OWNED FOOTER/);
    assert.ok(result.captured.imageCount > 0);
    const evidenceRoot = resolve(".artifacts/runtime-tmp/test-evidence/finalization-20261005");
    await mkdir(evidenceRoot, { recursive: true });
    const previewBytes = Buffer.from(result.preview.split(",")[1], "base64");
    const markerPixels = await page.evaluate(async (preview) => {
      const image = new Image(); image.src = preview; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) if (pixels[index] > 150 && pixels[index + 1] < 60 && pixels[index + 2] < 80) count++;
      return count;
    }, result.preview);
    await writeFile(resolve(evidenceRoot, "docx-complex-preview.jpg"), previewBytes);
    await writeFile(resolve(evidenceRoot, "docx-complex-image-diagnostic.json"), JSON.stringify({ markerPixels, captured: result.captured }, null, 2));
    assert.ok(markerPixels > 100, "Owned floating image must actually paint into preview pixels");
    await writeFile(resolve(evidenceRoot, "docx-complex-current.json"), JSON.stringify({
      passed: true, scope: "Owned complex DOCX real sandbox preview and actual worker extraction", viewport: page.viewportSize(),
      extractedText: result.text, previewText: result.captured.text, previewImageCount: result.captured.imageCount,
      markerPixels, previewSha256: createHash("sha256").update(previewBytes).digest("hex"), fixtureSha256: createHash("sha256").update(docx).digest("hex"),
    }, null, 2));
  } finally { await browser.close(); await server.close(); }
});
