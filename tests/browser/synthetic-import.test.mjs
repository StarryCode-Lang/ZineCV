/* 由 3 个同组测试文件合并；断言来源不同，各成员导入块内作用域化，行为与合并前一致。 */
{
const { test } = await import("node:test");
const { strict: assert } = await import("node:assert");
const { resolve } = await import("node:path");
const { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } = await import("./fixtures/browser-test-server.mjs");

/* ==== 原 synthetic-pdf-import.test.mjs ==== */

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
}

/* ==== 原 synthetic-docx-import.test.mjs ====（断言来源不同，导入块内作用域化） */
{
const { test } = await import("node:test");
const { strict: assert } = await import("node:assert");
const { syntheticDocx, syntheticComplexDocx } = await import("./fixtures/synthetic-docx.mjs");
const { resolve } = await import("node:path");
const { mkdir, writeFile } = await import("node:fs/promises");
const { createHash } = await import("node:crypto");
const { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } = await import("./fixtures/browser-test-server.mjs");

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
}

/* ==== 原 pdf-column-import.test.mjs ====（断言来源不同，导入块内作用域化） */
{
const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const { mkdir, writeFile } = await import("node:fs/promises");
const { resolve } = await import("node:path");
const { syntheticTwoColumnPdf } = await import("./fixtures/synthetic-two-column-pdf.mjs");
const { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } = await import("./fixtures/browser-test-server.mjs");
const root=resolve(import.meta.dirname,"../.."),directory=resolve(root,".artifacts/runtime-tmp/test-evidence/closure-optimization-20261008/pdf-columns");
test("real local PDF worker preserves short two-column paragraphs without ToUnicode",{timeout:90_000},async()=>{
 const server=await createBrowserTestServer(root);await listenForBrowserTestServer(server);const browser=await launchBrowserTestChromium({headless:true});const report={passed:false};try{
  const page=await browser.newPage();const origin="http://127.0.0.1:"+server.httpServer.address().port;const external=[];
  page.on("request",request=>{if(!request.url().startsWith(origin)&&!request.url().startsWith("data:")&&!request.url().startsWith("blob:"))external.push(request.url());});
  await page.goto(origin+"/__zinecv_browser_test_page.html");
  const result=await page.evaluate(async encoded=>{
   const {recognizeTemplate}=await import("/src/ui/services/template-import.ts");
   const bytes=Uint8Array.from(atob(encoded),character=>character.charCodeAt(0));
   return recognizeTemplate(new File([bytes],"owned-two-column.pdf",{type:"application/pdf"}));
  },syntheticTwoColumnPdf().toString("base64"));
  const expected=["OWNED TWO COLUMN READING ORDER FIXTURE","Education","Example University","Bachelor 2020 to 2024","LEFT COLUMN END","Skills","Python","JavaScript","RIGHT COLUMN END"];
  let last=-1;for(const text of expected){const position=result.extractedText.indexOf(text);assert.ok(position>last,"reading order: "+text);last=position;}
  assert.deepEqual(external,[]);assert.match(result.previewDataUrl,/^data:image\/png;base64,/);
  report.extractedText=result.extractedText;report.warnings=result.recognitionWarnings;report.noExternalRequests=true;report.passed=true;
 }catch(error){report.error=String(error.stack);throw error;}finally{await browser.close();await server.close();await mkdir(directory,{recursive:true});await writeFile(resolve(directory,"columns.json"),JSON.stringify(report,null,2));}
});
}

