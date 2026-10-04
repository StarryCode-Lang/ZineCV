import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("DOCX preview sandbox blocks script execution and network resources", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const server = await createBrowserTestServer(root);
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const page = await context.newPage();
    const forbiddenRequests = [];
    const forbiddenFailures = [];
    const forbiddenFinished = [];
    page.on("request", (request) => {
      if (request.url().includes("/import-preview-network-probe"))
        forbiddenRequests.push(request.url());
    });
    page.on("requestfailed", (request) => {
      if (request.url().includes("/import-preview-network-probe"))
        forbiddenFailures.push(request.failure()?.errorText ?? "unknown");
    });
    page.on("requestfinished", (request) => {
      if (request.url().includes("/import-preview-network-probe"))
        forbiddenFinished.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${address.port}/__zinecv_browser_test_page.html`, { waitUntil: "commit" });

    const result = await page.evaluate(async (port) => {
      const { createIsolatedImportPreview } = await import(
        "/src/ui/services/import-preview-sandbox.ts"
      );
      const [cmapResponse, standardFontResponse, cmapLicenseResponse] = await Promise.all([
        fetch("/pdfjs/cmaps/78-EUC-H.bcmap"),
        fetch("/pdfjs/standard_fonts/LiberationSans-Regular.ttf"),
        fetch("/pdfjs/cmaps/LICENSE"),
      ]);
      const preview = await createIsolatedImportPreview();
      try {
        const sandbox = preview.frame.getAttribute("sandbox");
        const csp = preview.document.querySelector(
          'meta[http-equiv="Content-Security-Policy"]',
        )?.getAttribute("content");
        window.__importPreviewScriptRan = false;
        const script = preview.document.createElement("script");
        script.textContent = "parent.__importPreviewScriptRan = true";
        preview.host.append(script);

        const blockedResource = await new Promise((resolve) => {
          const image = preview.document.createElement("img");
          const timeout = setTimeout(() => resolve(false), 1_000);
          image.addEventListener("error", () => {
            clearTimeout(timeout);
            resolve(true);
          }, { once: true });
          image.src = `http://127.0.0.1:${port}/import-preview-network-probe`;
          preview.host.append(image);
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          localCMap: [cmapResponse.status, (await cmapResponse.arrayBuffer()).byteLength],
          localStandardFont: [standardFontResponse.status, (await standardFontResponse.arrayBuffer()).byteLength],
          license: [cmapLicenseResponse.status, (await cmapLicenseResponse.text()).length],
          sandbox,
          csp,
          scriptRan: window.__importPreviewScriptRan,
          blockedResource,
        };
      } finally {
        preview.dispose();
      }
    }, address.port);

    assert.equal(result.sandbox, "allow-same-origin");
    assert.equal(result.localCMap[0], 200);
    assert.ok(result.localCMap[1] > 0);
    assert.equal(result.localStandardFont[0], 200);
    assert.ok(result.localStandardFont[1] > 0);
    assert.equal(result.license[0], 200);
    assert.ok(result.license[1] > 0);
    assert.match(result.csp, /default-src 'none'/);
    assert.match(result.csp, /connect-src 'none'/);
    assert.match(result.csp, /script-src 'none'/);
    assert.equal(result.scriptRan, false);
    assert.equal(result.blockedResource, true);
    assert.equal(forbiddenRequests.length, 1);
    assert.deepEqual(forbiddenFinished, []);
    assert.equal(forbiddenFailures[0], "csp");
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
