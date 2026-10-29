import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { composePdf } from "../../fixtures/import-quality/materialize.mjs";
import { materializeSample } from "../../fixtures/import-quality/materialize.mjs";
import { samples } from "../../fixtures/import-quality/corpus.mjs";
import { syntheticDocx } from "./fixtures/synthetic-docx.mjs";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

test("mixed PDFs OCR image pages even when a cover or scan header has text", { timeout: 90000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  let browser;
  try {
    await listenForBrowserTestServer(server);
    browser = await launchBrowserTestChromium({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const image = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1200; canvas.height = 1600;
      const context = canvas.getContext("2d");
      context.fillStyle = "white"; context.fillRect(0, 0, 1200, 1600);
      context.fillStyle = "black"; context.font = "40px Arial";
      ["Work Experience", "Example Labs 2020-07 - 2024-06", "Built offline storage.", "Skills", "Python JavaScript"]
        .forEach((line, index) => context.fillText(line, 60, 200 + index * 130));
      return Array.from(Uint8Array.from(atob(canvas.toDataURL("image/jpeg", 0.95).split(",")[1]), char => char.charCodeAt(0)));
    }));
    for (const header of [false, true]) {
      const pdf = composePdf([
        { lines: ["Alex Sample", "13800000000", "cover@example.invalid", "Education", "Example University 2016-09 - 2020-06"] },
        { image, width: 1200, height: 1600, lines: header ? ["SCAN HEADER"] : [] },
      ]);
      const result = await page.evaluate(async base64 => {
        const { recognizeTemplate, importedTemplateFieldProvenance } = await import("/src/ui/services/template-import.ts");
        const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
        const template = await recognizeTemplate(new File([bytes], "mixed.pdf", { type: "application/pdf" }));
        return { template, provenance: importedTemplateFieldProvenance(template) };
      }, pdf.toString("base64"));
      assert.match(result.template.extractedText, /Built offline storage\./);
      assert.match(result.template.extractedText, /Python JavaScript/);
      assert.equal(result.template.resume.basic.name, "Alex Sample");
      assert.equal(result.template.resume.work.length, 1);
      assert.match(result.template.resume.work[0].html, /Built offline storage/);
      assert.equal(result.provenance["section:work"].page, 2);
      assert.ok(result.template.recognitionWarnings.some(warning => warning.includes("逐页 OCR")));
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("image OCR keeps small text and long-image resolution and composites transparency", { timeout: 90000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  let browser;
  try {
    await listenForBrowserTestServer(server);
    browser = await launchBrowserTestChromium({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const results = await page.evaluate(async () => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const cases = [];
      for (const mode of ["small", "long", "transparent"]) {
        const canvas = document.createElement("canvas");
        canvas.width = 1440; canvas.height = mode === "long" ? 4400 : 1864;
        const context = canvas.getContext("2d");
        if (mode !== "transparent") {
          context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
        }
        context.fillStyle = "black"; context.font = mode === "small" ? "22px Arial" : "40px Arial";
        ["Alex Sample", "13800000000", "Education", "Sample University", "Skills", "Python JavaScript"]
          .forEach((line, index) => context.fillText(line, 60, 100 + index * (mode === "long" ? 650 : 90)));
        const blob = await new Promise(done => canvas.toBlob(done, "image/png"));
        canvas.width = 0; canvas.height = 0;
        const template = await recognizeTemplate(new File([blob], `${mode}.png`, { type: "image/png" }));
        const preview = new Image(); preview.src = template.previewDataUrl; await preview.decode();
        cases.push({ mode, text: template.extractedText, phone: template.resume?.basic.phone,
          previewWidth: preview.naturalWidth, previewHeight: preview.naturalHeight });
      }
      return cases;
    });
    for (const result of results) {
      assert.match(result.text, /Sample University/, result.mode);
      assert.match(result.text, /Python JavaScript/, result.mode);
      assert.equal(result.phone, "13800000000", result.mode);
      assert.ok(result.previewWidth <= 560 && result.previewHeight <= 760, "preview stays compact");
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("direct recognition retains the 120 second deadline and releases a stalled parser slot", async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  let browser;
  try {
    await listenForBrowserTestServer(server);
    browser = await launchBrowserTestChromium({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const pdf = composePdf([{ lines: ["Alex Sample", "13800000000", "Education", "Sample University"] }]);
    const result = await page.evaluate(async base64 => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const original = window.setTimeout;
      const scheduled = [];
      // Virtualize the clock only. The production code must still request its
      // actual 120000 ms budget, and the real abort/slot cleanup runs unchanged.
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 120000) { scheduled.push(delay); return original(callback, 0, ...args); }
        return original(callback, delay, ...args);
      };
      let failure;
      class StalledFile extends File { arrayBuffer() { return new Promise(() => {}); } }
      try {
        await recognizeTemplate(new StalledFile(["%PDF-1.7"], "stalled.pdf", { type: "application/pdf" }));
      } catch (error) { failure = { name: error.name, message: error.message }; }
      finally { window.setTimeout = original; }
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const retry = await recognizeTemplate(new File([bytes], "retry.pdf", { type: "application/pdf" }));
      return { scheduled, failure, retry: retry.extractedText };
    }, pdf.toString("base64"));
    assert.deepEqual(result.scheduled, [120000]);
    assert.equal(result.failure.name, "AbortError");
    assert.match(result.failure.message, /两分钟/);
    assert.match(result.retry, /Sample University/);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("DOCX table cells retain paragraph boundaries and distinct education and work entries", { timeout: 90000 }, async () => {
  const sample = samples.find(value => value.id === "IQ-39");
  const material = await materializeSample(sample, null);
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  let browser;
  try {
    await listenForBrowserTestServer(server);
    browser = await launchBrowserTestChromium({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    const result = await page.evaluate(async ({ base64, type }) => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      return recognizeTemplate(new File([bytes], "table-paragraphs.docx", { type }));
    }, { base64: material.bytes.toString("base64"), type: material.type });
    assert.equal(result.resume.basic.name, sample.truth.fields["basic.name"]);
    assert.equal(result.resume.basic.phone, sample.truth.fields["basic.phone"]);
    assert.equal(result.resume.basic.email, sample.truth.fields["basic.email"]);
    assert.equal(result.resume.education.length, 1);
    assert.equal(result.resume.work.length, 1);
    assert.equal(result.resume.skills.length, 1);
    assert.equal(result.resume.education[0].title, sample.truth.fields["education.0.title"]);
    assert.ok(result.resume.work[0].title.startsWith(sample.truth.fields["work.0.title"]));
    assert.match(result.resume.education[0].html, /计算机科学/);
    assert.match(result.resume.work[0].html, /Maintained offline typography and data backups\./);
    assert.match(result.resume.skills[0].html, /JavaScript Python SQL/);
    assert.deepEqual(result.moduleOrder, sample.truth.sections);
    assert.equal(result.extractedText, sample.truth.paragraphs.join("\n"), "each owned paragraph occurs once in row/cell order");

    const paragraph = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const table = cells => `<w:tbl><w:tblPr/><w:tblGrid>${cells.map(() => '<w:gridCol w:w="4000"/>').join("")}</w:tblGrid><w:tr>${cells.map(cell => `<w:tc>${cell}</w:tc>`).join("")}</w:tr></w:tbl>`;
    const listItem = (text, level) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const nestedLines = ["Table Owner", "13800000000", "table@example.invalid", "Education",
      "Sample University 2016-09 - 2020-06", "Owned degree body", "Nested table marker", "Work Experience",
      "Example Labs 2020-07 - 2024-06", "Parent list marker", "Nested list marker", "Skills", "Python SQL"];
    const left = nestedLines.slice(3, 6).map(paragraph).join("")
      + table([paragraph(nestedLines[6])]) + "<w:p/>";
    const right = nestedLines.slice(7, 9).map(paragraph).join("")
      + listItem(nestedLines[9], 0) + listItem(nestedLines[10], 1)
      + nestedLines.slice(11).map(paragraph).join("");
    const docx = syntheticDocx([], {
      "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${nestedLines.slice(0, 3).map(paragraph).join("")}${table([left, right])}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
      "word/numbering.xml": '<?xml version="1.0"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
      "word/_rels/document.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="numbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
      "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
    });
    const nested = await page.evaluate(async base64 => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      return recognizeTemplate(new File([bytes], "nested-table-list.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    }, docx.toString("base64"));
    assert.equal(nested.extractedText, nestedLines.join("\n"), "nested paragraphs/list items are emitted once, not flattened or repeated");
    assert.equal(nested.resume.education[0].title, "Sample University");
    assert.match(nested.resume.education[0].html, /Owned degree body/);
    assert.match(nested.resume.education[0].html, /Nested table marker/);
    assert.equal(nested.resume.work[0].title, "Example Labs");
    assert.match(nested.resume.work[0].html, /Parent list marker/);
    assert.match(nested.resume.work[0].html, /Nested list marker/);
    assert.match(nested.resume.skills[0].html, /Python SQL/);
  } finally {
    await browser?.close();
    await server.close();
  }
});
