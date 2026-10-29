import { syntheticDocx } from "../../tests/browser/fixtures/synthetic-docx.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const escapeHtml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const escapePdf = value => value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");

// A minimal independent PDF writer, supporting both text and JPEG pages.
export function composePdf(pages) {
  const objects = [];
  const add = body => (objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body)), objects.length);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  // A predefined UCS2 CMap preserves CJK text without replacing it with an
  // English header. Rendering uses the local PDF.js CMap/font fallback assets.
  const cidFont = add("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>");
  const cjkFont = add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cidFont} 0 R] >>`);
  const pageIds = [];
  for (const page of pages) {
    let imageId;
    if (page.image) {
      imageId = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.image.length} >>\nstream\n`), page.image, Buffer.from("\nendstream")]));
    }
    const operations = [imageId ? "q 612 0 0 792 0 0 cm /Im Do Q" : "",
      ...(page.lines ?? []).map((line, index) => {
        const cjk = /[^\x00-\x7f]/.test(line);
        const encoded = cjk ? `<${Buffer.from(line, "utf16le").swap16().toString("hex")}>` : `(${escapePdf(line)})`;
        return `BT /${cjk ? "F2" : "F1"} 14 Tf 36 ${756 - index * 28} Td ${encoded} Tj ET`;
      })].join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(operations)} >>\nstream\n${operations}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R /F2 ${cjkFont} 0 R >> ${imageId ? `/XObject << /Im ${imageId} 0 R >>` : ""} >> /Contents ${content} 0 R >>`));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  const parts = [Buffer.from("%PDF-1.7\n")], offsets = [0];
  let length = parts[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const block = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(block);
    length += block.length;
  }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  return Buffer.concat(parts);
}

function docx(sample) {
  const paragraphs = sample.truth.paragraphs.map(escapeHtml);
  const paragraph = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  let body;
  const layout = sample.recipe.layout;
  if (layout === "paragraphs" || layout === "two-columns") {
    body = paragraphs.map((text, index) => `${index > 0 && sample.truth.paragraphPages[index] !== sample.truth.paragraphPages[index - 1] ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ""}${paragraph(text)}`).join("");
  } else if (layout === "table") {
    body = paragraphs.slice(0, 4).map(paragraph).join("") + '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3600"/><w:gridCol w:w="5400"/></w:tblGrid><w:tr>'
      + `<w:tc>${paragraphs.slice(4, 7).map(paragraph).join("")}</w:tc><w:tc>${paragraphs.slice(7).map(paragraph).join("")}</w:tc></w:tr></w:tbl>`;
  } else {
    // A real floating textbox, separate from the held-out two-column section.
    body = paragraphs.slice(0, 4).map(paragraph).join("") + `<w:p><w:r><w:pict><v:shape style="width:450pt;height:450pt"><v:textbox><w:txbxContent>${paragraphs.slice(4).map(paragraph).join("")}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`;
  }
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:v="urn:schemas-microsoft-com:vml"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/>${layout === "two-columns" ? '<w:cols w:num="2" w:space="720"/>' : ""}</w:sectPr></w:body></w:document>`;
  return syntheticDocx([], { "word/document.xml": xml });
}

async function raster(page, sample, lines, { huge = false, omitFirst = false } = {}) {
  return Buffer.from(await page.evaluate(async ({ sample, lines, huge, omitFirst }) => {
    const width = huge ? 6400 : 1440;
    const height = huge ? 6400 : sample.recipe.longImage ? 4400 : 1864;
    const fontSize = sample.recipe.smallText ? 22 : sample.recipe.layout === "siderail" || sample.recipe.layout === "right-rail" ? 28 : 40;
    const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const lineSpacing = sample.recipe.longImage ? 280 : sample.recipe.smallText ? 70 : 110;
    const background = sample.recipe.transparent ? "" : `<rect width="100%" height="100%" fill="white"/>`;
    const sectionIndices = [4, 7, sample.truth.paragraphs.length - 2];
    const rowsBySection = new Map();
    let bannerRow = 0;
    const positioned = lines.map((line, index) => {
      const original = sample.truth.paragraphs.indexOf(line);
      const section = original < 4 ? -1 : original < sectionIndices[1] ? 0 : original < sectionIndices[2] ? 1 : 2;
      const row = rowsBySection.get(section) ?? 0;
      rowsBySection.set(section, row + 1);
      let x = 70, y = 100 + index * lineSpacing, available = width - 140;
      if (sample.recipe.layout === "siderail") {
        if (section < 0) y = 100 + row * 65;
        else if (section === 0) { x = 70; y = 420 + row * 85; available = 440; }
        else { x = 600; y = 420 + (section === 2 ? (rowsBySection.get(1) ?? 0) + 1 : 0) * 85 + row * 85; available = 770; }
      } else if (sample.recipe.layout === "right-rail") {
        if (section < 0) { x = 940; y = 100 + row * 65; available = 440; }
        else if (section === 0) { x = 940; y = 420 + row * 85; available = 440; }
        else { x = 70; y = 420 + (section === 2 ? (rowsBySection.get(1) ?? 0) + 1 : 0) * 85 + row * 85; available = 770; }
      } else if (sample.recipe.layout === "banner") {
        if (section < 0) { x = 260; y = 70 + row * 62; }
        else { x = 70; y = 430 + bannerRow++ * 85; }
      } else if (sample.recipe.layout === "two-band") {
        if (section < 0) { x = 520; y = 70 + row * 62; }
        else { x = 70; y = 440 + (section === 2 ? (rowsBySection.get(1) ?? 0) + 1 : 0) * 95 + row * 95; }
      } else if (sample.recipe.layout === "ledger") {
        if (section < 0) { x = 200; y = 100 + row * 75; available = 1170; }
        else {
          const prior = [...rowsBySection.entries()].filter(([key]) => key >= 0 && key < section).reduce((sum, [, count]) => sum + count + 1, 0);
          x = original === sectionIndices[section] ? 70 : 390;
          y = 470 + (prior + row) * 85;
          available = width - x - 70;
        }
      }
      const natural = [...line].reduce((sum, character) => sum + (/[^\x00-\x7f]/.test(character) ? 1 : 0.58), 0) * fontSize;
      const fitted = natural > available ? ` textLength="${available}" lengthAdjust="spacingAndGlyphs"` : "";
      return omitFirst && index === 0 ? "" : `<text x="${x}" y="${y}"${fitted}>${escape(line)}</text>`;
    }).join("");
    const decoration = sample.recipe.layout === "siderail" ? '<rect x="35" y="370" width="485" height="1350" fill="#eeeeee"/>'
      : sample.recipe.layout === "right-rail" ? '<rect x="905" y="370" width="500" height="1350" fill="#eeeeee"/>'
      : sample.recipe.layout === "banner" ? '<rect x="0" y="0" width="1440" height="330" fill="#e4e4e4"/>'
      : sample.recipe.layout === "two-band" ? '<rect x="40" y="368" width="1360" height="7" fill="#888888"/>'
      : sample.recipe.layout === "ledger" ? '<path d="M340 400V1790" stroke="#777" stroke-width="3"/>' : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${background}${decoration}<g font-family="Arial, Microsoft YaHei, sans-serif" font-size="${fontSize}" fill="${sample.recipe.lowContrast ? "#a0a0a0" : "#111"}">${positioned}</g></svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const image = new Image();
    try {
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = sample.recipe.rotated ? height : width;
      canvas.height = sample.recipe.rotated ? width : height;
      const context = canvas.getContext("2d");
      // JPEG needs an explicit white background; transparent PNG retains alpha.
      if (sample.extension !== "png" || !sample.recipe.transparent) {
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      if (sample.recipe.rotated) { context.translate(canvas.width, 0); context.rotate(Math.PI / 2); }
      context.drawImage(image, 0, 0);
      const encoded = canvas.toDataURL(sample.extension === "png" ? "image/png" : "image/jpeg", 0.94);
      const bytes = Array.from(Uint8Array.from(atob(encoded.split(",")[1]), char => char.charCodeAt(0)));
      canvas.width = 0; canvas.height = 0;
      return bytes;
    } finally { URL.revokeObjectURL(url); }
  }, { sample, lines, huge, omitFirst }));
}

export async function materializeSample(sample, page) {
  if (sample.group === "builtin") {
    const directory = resolve(process.env.ZINECV_IMPORT_BUILTIN_DIR ?? ".artifacts/import-quality/builtin-alpha2");
    try {
      const hash = value => createHash("sha256").update(value).digest("hex");
      const manifestBytes = await readFile(resolve(directory, "manifest.json"));
      const manifest = JSON.parse(manifestBytes);
      const entry = manifest.generated.find(row => row.id === sample.id);
      if (!manifest.completed || !entry || entry.fixtureTruthSha256 !== hash(JSON.stringify(sample.truth))) throw new Error("Missing or stale frozen input");
      if (manifest.generator.executableSha256 !== "58e62da1c85bd33bb364c5ff29bdc8d943c55d783243111b118b9f9062990d35") throw new Error("Unknown source engine");
      const bytes = await readFile(resolve(directory, `${sample.id}.pdf`));
      if (hash(bytes) !== entry.pdfSha256) throw new Error("PDF digest mismatch");
      return { bytes, type: "application/pdf", generation: { generator: manifest.generator,
        manifestSha256: hash(manifestBytes), pdfSha256: entry.pdfSha256,
        cursor: entry.cursor, renderKey: entry.renderKey, pageCount: entry.pageCount,
        independentPageAnnotations: entry.independentPageAnnotations } };
    } catch (error) {
      return { pending: `Requires verified real template export: ${error.message}; run tools/generate-import-builtin.mjs` };
    }
  }
  if (sample.extension === "docx") return { bytes: docx(sample), type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  if (sample.extension === "png") return { bytes: await raster(page, sample, sample.truth.paragraphs), type: "image/png" };
  const pages = Array.from({ length: sample.pageCount }, (_, index) => sample.truth.paragraphs.filter((_, row) => sample.truth.paragraphPages[row] === index + 1));
  if (sample.group === "scan" || sample.group === "mixed") {
    const imagePages = [];
    for (const [index, lines] of pages.entries()) {
      const kind = sample.recipe.pdfPageKinds[index];
      if (kind === "text") {
        imagePages.push({ lines });
      } else {
        // Use an actual source paragraph as the text header and omit its raster
        // duplicate. There is no invented HEADER outside the independent truth.
        const headerOnly = kind === "image-with-text-header";
        imagePages.push({ image: await raster(page, sample, lines, { omitFirst: headerOnly }), width: sample.recipe.rotated ? 1864 : 1440,
          height: sample.recipe.rotated ? 1440 : 1864, lines: headerOnly ? [lines[0]] : [] });
      }
    }
    return { bytes: composePdf(imagePages), type: "application/pdf" };
  }
  const layout = sample.recipe.layout;
  const html = `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:14mm}body{margin:0;font:12px Arial,'Microsoft YaHei',sans-serif;color:#111}.page{break-after:page}.page:last-child{break-after:auto}header{margin-bottom:25px}p{margin:0 0 12px}h2{font:inherit;font-weight:bold;margin:0 0 12px}.block{min-width:0;overflow-wrap:anywhere;margin-bottom:20px}.grid{display:grid;gap:24px}.identity-row header{display:flex;gap:20px;flex-wrap:wrap}.identity-row header p:first-child{flex-basis:100%;font-size:24px}.hanging-labels .block{display:grid;grid-template-columns:25% 1fr;gap:22px}.hanging-labels .block h2{grid-row:1/20}.equal-columns .grid{grid-template-columns:1fr 1fr}.sidebar .grid{grid-template-columns:28% 1fr}.sidebar aside{background:#eee;padding:18px}.cross-column .grid{grid-template-columns:1fr 1fr}.three-panels .grid{grid-template-columns:repeat(3,1fr)}.time-axis .grid{display:block;border-left:3px solid #666;padding-left:22px}.time-axis .block{width:70%;border:1px solid #bbb;padding:12px}.time-axis .block:nth-child(2n){margin-left:auto}.dashboard .grid{grid-template-columns:70% 1fr}.dashboard aside{border:1px solid #666;padding:12px}.banner .block{background:#e4e4e4;padding:14px}.right-rail .grid{grid-template-columns:1fr 28%}.right-rail aside{background:#eee;padding:18px}.right-rail header{width:28%;margin-left:auto}.footer-nav{border-top:2px solid #555;margin-top:18px;padding-top:10px}footer.footer-nav .block{display:flex;gap:44px;align-items:baseline}footer.footer-nav .block h2{margin-bottom:0}</style>${pages.map(lines => {
    const full = sample.truth.paragraphs;
    const head = lines.filter(line => full.indexOf(line) < 4);
    const ranges = [[4, 7], [7, full.length - 2], [full.length - 2, full.length]];
    const blocks = ranges.map(([start, end]) => lines.filter(line => full.indexOf(line) >= start && full.indexOf(line) < end))
      .map(block => block.length ? `<div class="block">${block.map((line, index) => index === 0 ? `<h2>${escapeHtml(line)}</h2>` : `<p>${escapeHtml(line)}</p>`).join("")}</div>` : "");
    let content;
    if (layout === "equal-columns" || layout === "sidebar") content = `<section class="grid"><aside>${blocks[0]}</aside><main>${blocks.slice(1).join("")}</main></section>`;
    else if (layout === "right-rail") content = `<section class="grid"><main>${blocks.slice(1).join("")}</main><aside>${blocks[0]}</aside></section>`;
    else if (layout === "cross-column") content = `${blocks[0]}<section class="grid">${blocks.slice(1).join("")}</section>`;
    else if (layout === "dashboard") content = `<section class="grid"><main>${blocks.slice(0, 2).join("")}</main><aside>${blocks[2]}</aside></section>`;
    else if (layout === "banner") content = `${blocks[0]}<section class="stack">${blocks.slice(1).join("")}</section>`;
    else if (layout === "footer-nav") content = `<section class="stack">${blocks.slice(0, 2).join("")}</section><footer class="footer-nav">${blocks[2]}</footer>`;
    else content = `<section class="${layout === "three-panels" || layout === "time-axis" ? "grid" : "stack"}">${blocks.join("")}</section>`;
    return `<article class="page ${layout}"><header>${head.map(line => `<p>${escapeHtml(line)}</p>`).join("")}</header>${content}</article>`;
  }).join("")}`;
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  return { bytes, type: "application/pdf" };
}

export async function materializeBoundary(row, page, prototype) {
  const base = composePdf([{ lines: ["Alex Sample", "Education", "Sample University"] }]);
  const file = (bytes, extension = "pdf", type = "application/pdf") => ({ bytes, extension, type });
  switch (row.kind) {
    case "empty": return file(Buffer.alloc(0));
    case "corrupt": return file(base.subarray(0, Math.floor(base.length * 0.35)));
    case "encrypted": {
      try {
        const encrypted = execFileSync(process.env.ZINECV_PDF_PYTHON ?? "python", [fileURLToPath(new URL("./encrypt-pdf.py", import.meta.url))],
          { input: base, timeout: 15000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        return file(encrypted);
      } catch {
        return { pending: "Valid password fixture requires Python with pypdf; set ZINECV_PDF_PYTHON to that development runtime" };
      }
    }
    case "mismatch": return file(await raster(page, { ...prototype, extension: "png" }, ["Alex Sample"]));
    case "zip-ratio": return file(syntheticDocx([], { "word/bomb.xml": "a".repeat(200000) }), "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    case "size": return file(Buffer.alloc(18 * 1024 * 1024 + 1));
    case "pages": return file(composePdf(Array.from({ length: 51 }, () => ({ lines: ["Page"] }))));
    case "pixels": return file(await raster(page, { ...prototype, extension: "png" }, ["Alex Sample"], { huge: true }), "png", "image/png");
    // Operation scenarios receive real operation inputs instead of a pending
    // marker. `probe`/`valid` is a legal text PDF whose recognition completes
    // quickly; it is used after abort/timeout/failure to prove the concurrency
    // slot and OCR session were released by the same live page.
    case "timeout":
    case "cancel":
      return { operation: row.kind, ...file(await raster(page, prototype, prototype.truth.paragraphs), "png", "image/png"),
        probe: file(base) };
    case "retry":
      return { operation: "retry", corrupt: file(base.subarray(0, Math.floor(base.length * 0.35))), valid: file(base) };
    case "target":
      return { operation: "target" };
    default: return { pending: "Operation scenario; not satisfied by file rejection" };
  }
}
