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

test("sparse Chinese and sideways image imports reach real OCR; cancellation and flat templates remain safe", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const page = await browser.newPage();
    const externalRequests = [];
    page.on("request", request => {
      if (!request.url().startsWith(origin) && !request.url().startsWith("blob:") && !request.url().startsWith("data:")) externalRequests.push(request.url());
    });
    await page.goto(`${origin}/__zinecv_browser_test_page.html`);
    const results = await page.evaluate(async () => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const cases = [];
      for (const mode of ["chinese", "rotated", "flat", "cancel", "after-cancel"]) {
        const canvas = document.createElement("canvas");
        canvas.width = 900; canvas.height = 500;
        const context = canvas.getContext("2d");
        context.fillStyle = "white"; context.fillRect(0, 0, 900, 500);
        context.fillStyle = "black"; context.font = "38px Arial";
        if (mode === "rotated") { context.translate(900, 0); context.rotate(Math.PI / 2); }
        if (mode === "flat") { context.fillStyle = "#4183ff"; context.fillRect(0, 0, 900, 80); }
        else {
          const lines = mode === "chinese" ? ["张三", "教育经历", "测试大学 计算机科学", "专业技能", "JavaScript Python"] : ["OWNED OCR FIXTURE", "Education", "Example University", "Skills", "JavaScript Python"];
          lines.forEach((line, index) => context.fillText(line, 40, 80 + index * 65));
        }
        const blob = await new Promise(done => canvas.toBlob(done, "image/png"));
        const controller = new AbortController();
        const progress = [];
        try {
          const result = await recognizeTemplate(new File([blob], `${mode}.png`, { type: "image/png" }), message => {
            progress.push(message);
            if (mode === "cancel" && message.startsWith("正在识别文字")) controller.abort();
          }, controller.signal);
          cases.push({ mode, text: result.extractedText, warnings: result.recognitionWarnings, progress });
        } catch (error) { cases.push({ mode, errorName: error.name, progress }); }
      }
      // A real two-page PDF containing JPEGs only: no text operators or fonts.
      const images = [];
      for (const lines of [["SCANNED OWNER", "Education", "Example University"], ["Skills", "SECOND PAGE Python", "fixture@example.invalid"]]) {
        const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 500;
        const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 900, 500);
        context.fillStyle = "black"; context.font = "38px Arial";
        lines.forEach((line, index) => context.fillText(line, 40, 80 + index * 65));
        images.push(Uint8Array.from(atob(canvas.toDataURL("image/jpeg", 0.95).split(",")[1]), character => character.charCodeAt(0)));
      }
      const encode = text => new TextEncoder().encode(text);
      const stream = "q 900 0 0 500 0 0 cm /Im Do Q";
      const objects = [
        [encode("<< /Type /Catalog /Pages 2 0 R >>")],
        [encode("<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>")],
        [encode("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 500] /Resources << /XObject << /Im 7 0 R >> >> /Contents 5 0 R >>")],
        [encode("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 500] /Resources << /XObject << /Im 8 0 R >> >> /Contents 6 0 R >>")],
        [encode(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)],
        [encode(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)],
        ...images.map(image => [encode(`<< /Type /XObject /Subtype /Image /Width 900 /Height 500 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, encode("\nendstream")]),
      ];
      const parts = [encode("%PDF-1.7\n")]; const offsets = [0]; let length = parts[0].length;
      for (let index = 0; index < objects.length; index++) {
        offsets.push(length); const objectParts = [encode(`${index + 1} 0 obj\n`), ...objects[index], encode("\nendobj\n")];
        parts.push(...objectParts); length += objectParts.reduce((total, part) => total + part.length, 0);
      }
      const xrefOffset = length;
      parts.push(encode(`xref\n0 9\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`));
      const pdf = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let position = 0;
      for (const part of parts) { pdf.set(part, position); position += part.length; }
      const progress = [];
      const scanned = await recognizeTemplate(new File([pdf], "owned-scan.pdf", { type: "application/pdf" }), message => progress.push(message));
      const { importedTemplateFieldProvenance } = await import("/src/ui/services/template-import.ts");
      cases.push({ mode: "scanned-pdf", text: scanned.extractedText, warnings: scanned.recognitionWarnings, provenance: importedTemplateFieldProvenance(scanned), progress });
      return cases;
    });
    assert.match(results.find(item => item.mode === "chinese").text, /张三[\s\S]*测试大学[\s\S]*Python/);
    assert.match(results.find(item => item.mode === "rotated").text, /OWNED OCR FIXTURE[\s\S]*Example University[\s\S]*JavaScript Python/);
    const flat = results.find(item => item.mode === "flat");
    assert.equal(flat.text, "");
    assert.ok(!flat.progress.some(message => message.includes("OCR") || message.startsWith("正在识别文字")));
    assert.equal(results.find(item => item.mode === "cancel").errorName, "AbortError");
    assert.match(results.find(item => item.mode === "after-cancel").text, /JavaScript Python/);
    const scanned = results.find(item => item.mode === "scanned-pdf");
    assert.match(scanned.text, /SCANNED OWNER[\s\S]*SECOND PAGE Python/);
    assert.equal(scanned.provenance["basic:email"].page, 2);
    assert.ok(scanned.warnings.some(message => message.includes("逐页 OCR")));
    assert.deepEqual(externalRequests, []);
  } finally { await browser.close(); await server.close(); }
});
