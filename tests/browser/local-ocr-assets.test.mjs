import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("OCR worker, WASM core, and both language models load from local assets", async () => {
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
    const result = await page.evaluate(async () => {
      const { createLocalOcrWorker } = await import(
        "/src/ui/services/template-import.ts"
      );
      const progress = [];
      const worker = await createLocalOcrWorker((event) => progress.push(event.status));
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 720;
        canvas.height = 150;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Synthetic OCR canvas unavailable");
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "black";
        context.font = "bold 64px Arial";
        context.fillText("ZINECV 2026", 24, 104);
        const recognized = await worker.recognize(canvas, {}, { text: true });
        return { text: recognized.data.text, progress };
      } finally {
        await worker.terminate();
      }
    });
    assert.match(result.text, /ZINECV/);
    assert.ok(result.progress.includes("loading tesseract core"));
    assert.ok(result.progress.includes("loading language traineddata"));
    assert.deepEqual(externalRequests, []);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
