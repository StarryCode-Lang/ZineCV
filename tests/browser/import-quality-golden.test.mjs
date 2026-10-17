import { test } from "node:test";
import { strict as assert } from "node:assert";
import { syntheticDocx } from "./fixtures/synthetic-docx.mjs";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

// R17 golden 语料：全部合成、文本已知。报告保留率/顺序/字段映射/诊断，
// 不用单一置信分数代替质量评估；真实语料的人工校正仍留在人工验收。
// PDF 语料使用 Helvetica/WinAnsi，因此为 ASCII 行；中文经 DOCX 路径覆盖，
// CJK 嵌入字体 PDF 需要真实字体文件，留在原生安装验收（R30/R31）。
const GOLDEN_LINES = [
  "Synthetic Resume",
  "Phone 13800000000",
  "Self review: golden corpus line for import quality regression.",
  "Work Experience Synthetic Tech Senior Engineer 2020 to 2024",
  "Owned the typography pipeline and the PDF text layer extraction path.",
];

function escapePdfText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function syntheticPdf(lines) {
  const streamOps = lines
    .map((line, index) => `BT /F1 14 Tf 72 ${720 - index * 24} Td (${escapePdfText(line)}) Tj ET`)
    .join("\n");
  const stream = `BT /F1 24 Tf 72 760 Td (${escapePdfText(lines[0])}) Tj ET\n${streamOps}`;
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

function corruptPdf() {
  const pdf = syntheticPdf(["corrupted document"]);
  // 截断到文件中段：xref/trailer 与后半部分对象全部缺失。
  // 仅破坏 xref 表会被 PDF.js 的恢复解析重建，不构成不可读文件。
  const bytes = Buffer.from(pdf);
  return bytes.subarray(0, Math.floor(bytes.length * 0.4));
}

function encryptedPdf() {
  const pdf = syntheticPdf(["encrypted document"]);
  const pad = "01234567890123456789012345678901";
  const text = pdf
    .toString("latin1")
    .replace("/Root 1 0 R >>", "/Root 1 0 R /Encrypt 6 0 R >>")
    .replace(
      "%%EOF",
      `6 0 obj\n<< /Filter /Standard /V 1 /R 2 /O (${pad}) /U (${pad}) /P -1 >>\nendobj\ntrailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R >>\nstartxref\n0\n%%EOF`,
    );
  return Buffer.from(text, "latin1");
}


function characterRetention(extracted, golden) {
  const normalized = extracted.replace(/\s+/g, "");
  const target = golden.replace(/\s+/g, "");
  if (!target) return 1;
  let hits = 0;
  const pool = [...normalized];
  for (const character of target) {
    const index = pool.indexOf(character);
    if (index >= 0) {
      hits += 1;
      pool.splice(index, 1);
    }
  }
  return hits / target.length;
}

test("PDF golden corpus preserves synthetic text with order and field mapping", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const server = await createBrowserTestServer(root);
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await context.newPage();
    await page.goto(`${origin}/__zinecv_browser_test_page.html`, { waitUntil: "commit" });
    const report = await page.evaluate(async (lines) => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const bytes = Uint8Array.from(atob(lines.base64), (character) => character.charCodeAt(0));
      const file = new File([bytes], "golden-resume.pdf", { type: "application/pdf" });
      const template = await recognizeTemplate(file);
      return {
        extractedText: template.extractedText,
        sourceType: template.sourceType,
        recognitionConfidence: template.recognitionConfidence,
        warnings: template.recognitionWarnings,
        mappedName: template.resume?.basic?.name ?? null,
        moduleOrder: template.moduleOrder ?? null,
        previewIsPng: typeof template.previewDataUrl === "string" && template.previewDataUrl.startsWith("data:image/png;base64,"),
      };
    }, { base64: syntheticPdf(GOLDEN_LINES).toString("base64") });

    const quality = {
      corpus: "synthetic-pdf-golden-v1",
      goldenLines: GOLDEN_LINES,
      sourceType: report.sourceType,
      lineRetention: GOLDEN_LINES.map((line) => ({
        line,
        retention: characterRetention(report.extractedText, line),
        present: report.extractedText.replace(/\s+/g, "").includes(line.replace(/\s+/g, "")),
      })),
      nameMapped: report.mappedName,
      moduleOrder: report.moduleOrder,
      previewIsPng: report.previewIsPng,
      warnings: report.warnings,
    };
    for (const entry of quality.lineRetention) {
      assert.ok(entry.retention >= 0.95, `golden line retention below 0.95: ${entry.line} → ${entry.retention}`);
    }
    assert.ok(quality.previewIsPng, "first-page preview must render");
    mkdirSync(resolve(root, ".artifacts/runtime-tmp/test-evidence/R17"), { recursive: true });
    writeFileSync(
      resolve(root, ".artifacts/runtime-tmp/test-evidence/R17/pdf-golden-report.json"),
      JSON.stringify(quality, null, 2),
    );

    // 损坏 PDF：必须给出可解释错误，不允许空白成功。
    const corruptError = await page.evaluate(async (base64) => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      try {
        await recognizeTemplate(new File([bytes], "corrupt.pdf", { type: "application/pdf" }));
        return null;
      } catch (error) {
        return String(error && error.message || error);
      }
    }, corruptPdf().toString("base64"));
    assert.ok(corruptError && corruptError.length > 0, "corrupt PDF must fail with a message");

    // 加密 PDF：必须明确失败（提示密码/不支持），不能当作空文本成功。
    const encryptedError = await page.evaluate(async (base64) => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      try {
        await recognizeTemplate(new File([bytes], "encrypted.pdf", { type: "application/pdf" }));
        return null;
      } catch (error) {
        return String(error && error.message || error);
      }
    }, encryptedPdf().toString("base64"));
    assert.ok(encryptedError && encryptedError.length > 0, "encrypted PDF must not import silently");
    writeFileSync(
      resolve(root, ".artifacts/runtime-tmp/test-evidence/R17/pdf-negative-diagnoses.json"),
      JSON.stringify({ corrupt: corruptError, encrypted: encryptedError }, null, 2),
    );
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});

test("DOCX golden corpus preserves paragraph order through mammoth", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const server = await createBrowserTestServer(root);
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await context.newPage();
    await page.goto(`${origin}/__zinecv_browser_test_page.html`, { waitUntil: "commit" });
    const docxParagraphs = [
      "李合成",
      "自我评价：DOCX golden 语料第二行。",
      "教育经历 合成大学 计算机科学 2016 至 2020",
    ];
    const report = await page.evaluate(async (base64) => {
      const { recognizeTemplate } = await import("/src/ui/services/template-import.ts");
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const template = await recognizeTemplate(new File([bytes], "golden-resume.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
      return {
        extractedText: template.extractedText,
        sourceType: template.sourceType,
        mappedName: template.resume?.basic?.name ?? null,
        moduleOrder: template.moduleOrder ?? null,
      };
    }, syntheticDocx(docxParagraphs).toString("base64"));
    const quality = {
      corpus: "synthetic-docx-golden-v1",
      goldenLines: docxParagraphs,
      sourceType: report.sourceType,
      lineRetention: docxParagraphs.map((line) => ({
        line,
        retention: characterRetention(report.extractedText, line),
      })),
      nameMapped: report.mappedName,
      moduleOrder: report.moduleOrder,
    };
    for (const entry of quality.lineRetention) {
      assert.ok(entry.retention >= 0.95, `DOCX golden retention below 0.95: ${entry.line}`);
    }
    mkdirSync(resolve(root, ".artifacts/runtime-tmp/test-evidence/R17"), { recursive: true });
    writeFileSync(
      resolve(root, ".artifacts/runtime-tmp/test-evidence/R17/docx-golden-report.json"),
      JSON.stringify(quality, null, 2),
    );
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
