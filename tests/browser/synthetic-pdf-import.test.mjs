import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

function syntheticPdf() {
  const stream = "BT /F1 32 Tf 72 720 Td (Synthetic PDF Resume) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
  ];
  const parts = ["%PDF-1.7\n"];
  const offsets = [0];
  let length = Buffer.byteLength(parts[0], "ascii");
  for (const [index, body] of objects.entries()) {
    offsets.push(length);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(object);
    length += Buffer.byteLength(object, "ascii");
  }
  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
  ].join("");
  parts.push(xref);
  parts.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(parts.join(""), "ascii");
}

test("synthetic PDF text extraction and first-page preview use local PDF.js assets", async () => {
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
    const localResourceRequests = [];
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith(origin)) externalRequests.push(url);
      if (url.startsWith(`${origin}/pdfjs/`)) localResourceRequests.push(url);
    });
    await page.goto(`${origin}/__zinecv_browser_test_page.html`, { waitUntil: "commit" });
    const encodedPdf = syntheticPdf().toString("base64");
    const result = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const file = new File([bytes], "synthetic-resume.pdf", { type: "application/pdf" });
      const { recognizeTemplate } = await import(
        "/src/ui/services/template-import.ts"
      );
      return recognizeTemplate(file);
    }, encodedPdf);
    const localPdfJsAssets = await page.evaluate(async () => {
      const { localPdfJsResourceOptions } = await import(
        "/src/ui/services/pdfjs-resources.ts"
      );
      const options = localPdfJsResourceOptions(window.location.href);
      const [icc, wasm] = await Promise.all([
        fetch(new URL("CGATS001Compat-v2-micro.icc", options.iccUrl)),
        fetch(new URL("qcms_bg.wasm", options.wasmUrl)),
      ]);
      return { iccStatus: icc.status, wasmStatus: wasm.status };
    });
    assert.match(result.extractedText, /Synthetic PDF Resume/);
    assert.match(result.previewDataUrl, /^data:image\/png;base64,/);
    assert.deepEqual(localPdfJsAssets, { iccStatus: 200, wasmStatus: 200 });
    assert.deepEqual(externalRequests, []);
    assert.ok(localResourceRequests.every((url) => new URL(url).pathname.startsWith("/pdfjs/")));
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
