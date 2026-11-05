import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

// Two synthetic pages: a text link, a link on an otherwise empty region,
// a rejected javascript action and a link on a rotated page.
function linkedPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R 10 0 R] /Count 2 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length 42 >>\nstream\nBT /F1 14 Tf 36 756 Td (FIRST) Tj ET\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R /Annots [6 0 R 7 0 R 8 0 R] >>",
    "<< /Type /Annot /Subtype /Link /Rect [36 742 140 760] /Border [0 0 0] /A << /S /URI /URI (https://example.org/text) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [250 200 320 240] /Border [0 0 0] /A << /S /URI /URI (mailto:hello@example.org) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [180 200 200 220] /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>",
    "<< /Length 43 >>\nstream\nBT /F1 14 Tf 36 756 Td (SECOND) Tj ET\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Resources << /Font << /F1 3 0 R >> >> /Contents 9 0 R /Annots [11 0 R] >>",
    "<< /Type /Annot /Subtype /Link /Rect [36 742 140 760] /Border [0 0 0] /A << /S /URI /URI (https://example.org/rotated) >> >>",
  ];
  const parts = [Buffer.from("%PDF-1.7\n")], offsets = [0];
  let length = parts[0].length;
  for (const [i, object] of objects.entries()) {
    offsets.push(length);
    const block = Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`);
    parts.push(block); length += block.length;
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(x => `${String(x).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  return Buffer.concat(parts);
}

test("source PDF records external links with rotated geometry and reports unsupported actions", { timeout: 90_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../..")); await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const layout = await page.evaluate(async (encoded) => {
      const { extractPdfSourceLayout } = await import("/src/ui/services/source-layout-pdf.ts");
      const data = Uint8Array.from(atob(encoded), x => x.charCodeAt(0));
      return extractPdfSourceLayout(new File([data], "linked.pdf", { type: "application/pdf" }));
    }, linkedPdf().toString("base64"));
    assert.equal(layout.linkStatus, "incomplete");
    assert.equal(layout.sourceLinks.length, 3);
    assert.deepEqual(layout.sourceLinks.map(link => [link.page, link.href]), [
      [1, "https://example.org/text"], [1, "mailto:hello@example.org"], [2, "https://example.org/rotated"],
    ]);
    for (const link of layout.sourceLinks) {
      const pageSize = layout.pages[link.page - 1];
      assert.ok(link.x >= 0 && link.y >= 0 && link.width > 0 && link.height > 0);
      assert.ok(link.x + link.width <= pageSize.width && link.y + link.height <= pageSize.height);
    }
    for (const [link, expected] of layout.sourceLinks.map((link, index) => [link, [[86.4, 76.8, 249.6, 43.2], [600, 1324.8, 168, 96], [1780.8, 86.4, 43.2, 249.6]][index]])) {
      for (const [i, value] of [link.x, link.y, link.width, link.height].entries()) assert.ok(Math.abs(value - expected[i]) < 0.1);
    }
    assert.ok(layout.warnings.some(warning => warning.includes("链接")));
  } finally { await browser.close(); await server.close(); }
});

test("source print creates clickable text and non-text annotations in the correct regions", { timeout: 90_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../..")); await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(async () => {
      const { prepareSourceLayoutPrint } = await import("/src/ui/services/source-layout-print.tsx");
      const background = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="794" height="1123"><rect width="794" height="1123" fill="white"/></svg>')}`;
      const box = { id: "one", page: 1, x: 40, y: 50, width: 200, height: 30, text: "Editable text", fontSize: 18, lineHeight: 22,
        fontFamily: "Arial", fontWeight: "400", fontStyle: "normal", color: "#000", background: "#fff", align: "left" };
      window.disposeSourcePrint = await prepareSourceLayoutPrint({ version: 1, pages: [{ width: 794, height: 1123, background }], boxes: [box],
        extractedChars: 13, warnings: [], linkStatus: "complete", sourceLinks: [
          { page: 1, x: 40, y: 50, width: 200, height: 30, href: "https://example.org/text" },
          { page: 1, x: 300, y: 400, width: 80, height: 40, href: "mailto:hello@example.org" },
        ] }, {});
    });
    const bytes = await page.pdf({ format: "A4", printBackground: true });
    const loading = pdfjs.getDocument({ data: new Uint8Array(bytes) });
    try {
      const pdf = await loading.promise, pdfPage = await pdf.getPage(1);
      const viewport = pdfPage.getViewport({ scale: 1 });
      const links = (await pdfPage.getAnnotations()).filter(item => item.subtype === "Link");
      assert.equal(links.length, 2);
      for (const [href, expected] of [["https://example.org/text", [40, 50, 200, 30]], ["mailto:hello@example.org", [300, 400, 80, 40]]]) {
        const link = links.find(item => item.url === href); assert.ok(link);
        const [x1, y1] = viewport.convertToViewportPoint(link.rect[0], link.rect[1]);
        const [x2, y2] = viewport.convertToViewportPoint(link.rect[2], link.rect[3]);
        const actual = [Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1)];
        for (let i = 0; i < 4; i++) assert.ok(Math.abs(actual[i] - expected[i] * 0.75) < 2);
      }
      assert.match((await pdfPage.getTextContent()).items.map(item => item.str ?? "").join(""), /Editable text/);
    } finally { await loading.destroy(); }
    await page.evaluate(() => window.disposeSourcePrint());
  } finally { await browser.close(); await server.close(); }
});

test("source print refuses to silently discard unsupported links", { timeout: 90_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../..")); await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const result = await page.evaluate(async () => {
      const { prepareSourceLayoutPrint } = await import("/src/ui/services/source-layout-print.tsx");
      const layout = { version: 1, pages: [{ width: 794, height: 1123, background: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" }],
        boxes: [{ id: "a", page: 1, text: "Text" }], extractedChars: 4, warnings: [], sourceLinks: [], linkStatus: "incomplete" };
      try { const dispose = await prepareSourceLayoutPrint(layout, {}); dispose(); return false; }
      catch (error) { return String(error).includes("链接"); }
    });
    assert.equal(result, true);
  } finally { await browser.close(); await server.close(); }
});

test("frozen PDF verification checks page-link destinations, multiplicity and geometry", { timeout: 90_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../..")); await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.setContent('<style>@page{size:A4;margin:0}body{margin:0} a{position:absolute;display:block;left:40px;top:50px;width:200px;height:30px}</style><div>Editable text</div><a href="https://example.org/text"></a>');
    const bytes = await page.pdf({ format: "A4", printBackground: true });
    const result = await page.evaluate(async (encoded) => {
      const { checkExportOutput } = await import("/src/ui/services/export-output-checks.ts");
      const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
      const link = { page: 1, xPt: 30, yPt: 37.5, widthPt: 150, heightPt: 22.5, href: "https://example.org/text" };
      const data = { pageCount: 1, pdfBase64: encoded, pdfSha256: hash, selectedPages: null,
        textMap: { version: 1, logicalText: "Editable text", hitRegions: [], links: [],
          clusters: [{ page: 1, logicalOrder: 0, startUtf16: 0, endUtf16: 13 }], pageLinks: [link] } };
      const check = () => checkExportOutput({ cursor: {}, renderKey: "test", data }, "pdf");
      const valid = await check();
      data.textMap.pageLinks = [{ ...link, xPt: 70 }]; const wrongGeometry = await check();
      data.textMap.pageLinks = [link, link]; const missingDuplicate = await check();
      data.textMap.pageLinks = []; const unexpected = await check();
      return { valid, wrongGeometry, missingDuplicate, unexpected };
    }, bytes.toString("base64"));
    assert.deepEqual(result.valid, []);
    for (const key of ["wrongGeometry", "missingDuplicate", "unexpected"]) {
      assert.ok(result[key].some(finding => finding.id.includes("links")), `${key} must be rejected`);
    }
  } finally { await browser.close(); await server.close(); }
});
