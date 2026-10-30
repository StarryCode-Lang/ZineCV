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

// Policy 5 has source-defined heading indices and per-page physical sizes.
// Keep this separate so retiring policy-4 samples does not alter their renderer.
async function materializePolicy5(sample, page, geometry) {
  const headings = geometry.headingIndices;
  const identity = geometry.identityIndex;
  const pageSizes = geometry.pageGeometries;
  const pageStyle = pageSizes.map(({ page: number, width, height }) =>
    `@page sheet${number}{size:${width}px ${height}px;margin:0}article[data-page="${number}"]{page:sheet${number};width:${width}px;height:${height}px}`).join("");
  const style = `${pageStyle}*{box-sizing:border-box}html,body{margin:0;padding:0;background:white}article{position:relative;break-after:page;overflow:hidden}article:last-child{break-after:auto}.paragraph{position:absolute;margin:0;white-space:normal;overflow-wrap:anywhere;font:14px/21px Arial,'Microsoft YaHei',sans-serif;color:#111}.heading{font-weight:700}.identity{font-size:24px}.region{position:absolute;border:1px solid #999;pointer-events:none}img{position:absolute;inset:0;width:100%;height:100%}`;
  const paragraphHtml = box => `<div class="paragraph ${headings.includes(box.paragraphIndex) ? "heading" : box.paragraphIndex === identity ? "identity" : ""}" data-index="${box.paragraphIndex}" style="left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px">${escapeHtml(sample.truth.paragraphs[box.paragraphIndex])}</div>`;
  const decorations = number => {
    const { width, height } = pageSizes.find(row => row.page === number);
    const regions = geometry.regions.filter(row => row.page === number).map(({ rect: [x, y, w, h] }) =>
      `<div class="region" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`).join("");
    const paths = geometry.decorationPaths.filter(row => row.page === number).map(row =>
      `<polyline points="${row.points.map(point => point.join(",")).join(" ")}${row.closed ? ` ${row.points[0].join(",")}` : ""}"/>`).join("");
    return `${regions}<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="position:absolute;inset:0;pointer-events:none"><g fill="none" stroke="#999" stroke-width="1">${paths}</g></svg>`;
  };
  const sheets = [], fit = [], rasterMeasurements = [];
  for (const size of pageSizes) {
    const number = size.page;
    const boxes = geometry.paragraphBoxes.filter(box => box.page === number);
    const decorate = decorations(number);
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>${style}</style><article data-page="${number}">${decorate}${boxes.map(paragraphHtml).join("")}</article>`);
    await page.evaluate(() => document.fonts.ready);
    const measured = await page.locator(".paragraph").evaluateAll(nodes => nodes.map(node => ({
      paragraphIndex: Number(node.dataset.index), fits: node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth,
      height: node.clientHeight, contentHeight: node.scrollHeight, width: node.clientWidth, contentWidth: node.scrollWidth,
    })));
    if (measured.some(row => !row.fits)) throw new Error(`Frozen paragraph overflows: ${sample.id}: ${JSON.stringify(measured.filter(row => !row.fits))}`);
    fit.push(...measured.map(row => ({ page: number, ...row })));
    if (geometry.renderer === "html") {
      sheets.push(`<article data-page="${number}">${decorate}${boxes.map(paragraphHtml).join("")}</article>`);
      continue;
    }
    const header = sample.recipe.pdfPageKinds?.[number - 1] === "image-with-text-header" ? boxes[0] : null;
    const raster = await page.evaluate(({ size, geometry, paragraphs, boxes, omitted }) => {
      const canvas = document.createElement("canvas");
      canvas.width = size.width * 2; canvas.height = size.height * 2;
      const context = canvas.getContext("2d"); context.scale(2, 2);
      context.fillStyle = "white"; context.fillRect(0, 0, size.width, size.height);
      context.strokeStyle = "#999"; context.lineWidth = 1;
      for (const region of geometry.regions.filter(row => row.page === size.page)) context.strokeRect(...region.rect);
      for (const path of geometry.decorationPaths.filter(row => row.page === size.page)) {
        context.beginPath(); context.moveTo(...path.points[0]);
        for (const point of path.points.slice(1)) context.lineTo(...point);
        if (path.closed) context.closePath();
        context.stroke();
      }
      context.fillStyle = "#111"; context.textBaseline = "top";
      const measurements = [];
      for (const box of boxes) {
        if (box.paragraphIndex === omitted) continue;
        const size = box.paragraphIndex === geometry.identityIndex ? 24 : 14;
        context.font = `${geometry.headingIndices.includes(box.paragraphIndex) ? "bold " : ""}${size}px Arial, 'Microsoft YaHei', sans-serif`;
        const remaining = [...paragraphs[box.paragraphIndex]], lines = [];
        while (remaining.length) {
          let end = 1;
          while (end <= remaining.length && context.measureText(remaining.slice(0, end).join("")).width <= box.width) end += 1;
          let count = Math.max(1, end - 1);
          if (count < remaining.length) {
            const prefix = remaining.slice(0, count).join("");
            const space = prefix.lastIndexOf(" ");
            if (space > 0 && /[\x00-\x7f]$/.test(prefix)) count = space + 1;
          }
          lines.push(remaining.splice(0, count).join("").trim());
        }
        if (lines.length * 21 > box.height || size > box.height) throw new Error(`Raster text exceeds frozen box ${sample.id}: ${box.paragraphIndex}`);
        lines.forEach((line, index) => context.fillText(line, box.x, box.y + index * 21));
        measurements.push({ paragraphIndex: box.paragraphIndex, page: box.page, lineCount: lines.length, boxHeight: box.height });
      }
      return { png: canvas.toDataURL("image/png"), jpeg: canvas.toDataURL("image/jpeg", 0.96), measurements };
    }, { size, geometry, paragraphs: sample.truth.paragraphs, boxes, omitted: header?.paragraphIndex ?? -1 });
    rasterMeasurements.push(...raster.measurements);
    if (sample.extension === "png") return { bytes: Buffer.from(raster.png.split(",")[1], "base64"), type: "image/png",
      generation: { policyVersion: 5, geometry: geometry.id, pageGeometries: pageSizes, fit, rasterMeasurements } };
    sheets.push(`<article data-page="${number}"><img src="${raster.jpeg}" alt="">${header ? paragraphHtml(header) : ""}</article>`);
  }
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${style}</style>${sheets.join("")}`);
  await page.evaluate(() => document.fonts.ready);
  return { bytes: await page.pdf({ preferCSSPageSize: true, printBackground: true }), type: "application/pdf",
    generation: { policyVersion: 5, geometry: geometry.id, pageGeometries: pageSizes, fit, rasterMeasurements } };
}

// Frozen policy-4 layouts use independently authored paragraph boxes. They must
// never reach the legacy stack fallback or derive text from an import result.
async function materializeFrozenHoldout(sample, page) {
  const versions = await Promise.all([4, 5].map(async version => JSON.parse(await readFile(new URL(`./blind-holdout-policy${version}.json`, import.meta.url), "utf8"))));
  const frozen = versions.find(version => version.samples.some(row => row.id === sample.id));
  if (!frozen) throw new Error(`Unknown frozen holdout: ${sample.id}`);
  const geometry = frozen.families.find(row => row.id === sample.recipe.geometryRef);
  const original = frozen.samples.find(row => row.id === sample.id);
  if (!geometry || !original || sample.family !== geometry.id
    || JSON.stringify(sample.truth) !== JSON.stringify(original.truth)
    || JSON.stringify(sample.recipe) !== JSON.stringify(original.recipe)) throw new Error(`Unknown or changed frozen holdout: ${sample.id}`);
  if (frozen.policyVersion === 5) return materializePolicy5(sample, page, geometry);
  const { pageWidth: width, pageHeight: height } = geometry;
  const style = `@page{size:${width}px ${height}px;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:white}article{position:relative;width:${width}px;height:${height}px;break-after:page;overflow:hidden}article:last-child{break-after:auto}.paragraph{position:absolute;margin:0;white-space:normal;overflow-wrap:anywhere;font:14px/21px Arial,'Microsoft YaHei',sans-serif;color:#111}.heading{font-weight:700}.identity{font-size:24px}.region{position:absolute;border:1px solid #ddd;pointer-events:none}img{position:absolute;inset:0;width:100%;height:100%}`;
  const paragraphHtml = box => `<div class="paragraph ${[4, 7, 13].includes(box.paragraphIndex) ? "heading" : box.paragraphIndex === 0 ? "identity" : ""}" data-index="${box.paragraphIndex}" style="left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px">${escapeHtml(sample.truth.paragraphs[box.paragraphIndex])}</div>`;
  const regions = number => (geometry.regions ?? []).filter(row => (row.page ?? 1) === number)
    .map(({ rect: [x, y, w, h] }) => `<div class="region" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></div>`).join("")
    + (geometry.guides ?? []).filter(row => (row.page ?? 1) === number)
      .map(({ x, y1, y2 }) => `<div class="region" style="left:${x}px;top:${y1}px;width:0;height:${y2 - y1}px;border-width:0 0 0 1px"></div>`).join("");
  const pages = [];
  const fit = [];
  for (let number = 1; number <= sample.pageCount; number += 1) {
    const boxes = geometry.paragraphBoxes.filter(box => box.page === number);
    // Check the real browser font and natural wrapping before producing bytes.
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>${style}</style><article>${regions(number)}${boxes.map(paragraphHtml).join("")}</article>`);
    await page.evaluate(() => document.fonts.ready);
    const measured = await page.locator(".paragraph").evaluateAll(nodes => nodes.map(node => ({
      paragraphIndex: Number(node.dataset.index), fits: node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth,
      height: node.clientHeight, contentHeight: node.scrollHeight, width: node.clientWidth, contentWidth: node.scrollWidth,
    })));
    if (measured.some(row => !row.fits)) throw new Error(`Frozen paragraph overflows: ${sample.id}: ${JSON.stringify(measured.filter(row => !row.fits))}`);
    fit.push(...measured.map(row => ({ page: number, ...row })));
    if (geometry.renderer === "html") {
      pages.push(`<article>${regions(number)}${boxes.map(paragraphHtml).join("")}</article>`);
      continue;
    }
    const kind = sample.recipe.pdfPageKinds?.[number - 1];
    const header = kind === "image-with-text-header" ? boxes[0] : null;
    const raster = await page.evaluate(({ geometry, boxes, paragraphs, omitted }) => {
      const canvas = document.createElement("canvas");
      canvas.width = geometry.pageWidth * 2; canvas.height = geometry.pageHeight * 2;
      const context = canvas.getContext("2d"); context.scale(2, 2);
      context.fillStyle = "white"; context.fillRect(0, 0, geometry.pageWidth, geometry.pageHeight);
      context.strokeStyle = "#ddd"; context.lineWidth = 1;
      for (const region of geometry.regions ?? []) {
        if ((region.page ?? 1) === boxes[0].page) context.strokeRect(...region.rect);
      }
      for (const guide of geometry.guides ?? []) {
        context.beginPath(); context.moveTo(guide.x, guide.y1); context.lineTo(guide.x, guide.y2); context.stroke();
      }
      if (geometry.id === "raster-masonry-tail") {
        context.beginPath(); context.moveTo(30, 436); context.lineTo(774, 436);
        context.lineTo(774, 934); context.lineTo(310, 934); context.lineTo(310, 630);
        context.lineTo(30, 630); context.closePath(); context.stroke();
      }
      context.fillStyle = "#111"; context.textBaseline = "top";
      const measurements = [];
      for (const box of boxes) {
        if (box.paragraphIndex === omitted) continue;
        const size = box.paragraphIndex === 0 ? 24 : 14;
        context.font = `${[4, 7, 13].includes(box.paragraphIndex) ? "bold " : ""}${size}px Arial, 'Microsoft YaHei', sans-serif`;
        const remaining = [...paragraphs[box.paragraphIndex]];
        const lines = [];
        while (remaining.length) {
          let end = 1;
          while (end <= remaining.length && context.measureText(remaining.slice(0, end).join("")).width <= box.width) end += 1;
          let count = Math.max(1, end - 1);
          if (count < remaining.length) {
            // Prefer complete English words; CJK naturally breaks by character.
            const prefix = remaining.slice(0, count).join("");
            const space = prefix.lastIndexOf(" ");
            if (space > 0 && /[A-Za-z]$/.test(prefix)) count = space + 1;
          }
          lines.push(remaining.splice(0, count).join("").trim());
        }
        if (lines.length * 21 > box.height || size > box.height) throw new Error(`Raster text exceeds frozen box ${box.paragraphIndex}`);
        lines.forEach((line, index) => context.fillText(line, box.x, box.y + index * 21));
        measurements.push({ paragraphIndex: box.paragraphIndex, lineCount: lines.length, boxHeight: box.height });
      }
      return { png: canvas.toDataURL("image/png"), jpeg: canvas.toDataURL("image/jpeg", 0.96), measurements };
    }, { geometry, boxes, paragraphs: sample.truth.paragraphs, omitted: header?.paragraphIndex ?? -1 });
    if (sample.extension === "png") return { bytes: Buffer.from(raster.png.split(",")[1], "base64"), type: "image/png", generation: { geometry: geometry.id, fit, rasterMeasurements: raster.measurements } };
    pages.push(`<article><img src="${raster.jpeg}" alt="">${header ? paragraphHtml(header) : ""}</article>`);
  }
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${style}</style>${pages.join("")}`);
  await page.evaluate(() => document.fonts.ready);
  return { bytes: await page.pdf({ preferCSSPageSize: true, printBackground: true }), type: "application/pdf",
    generation: { geometry: geometry.id, pageWidth: width, pageHeight: height, fit } };
}

export async function materializeSample(sample, page) {
  if (sample.recipe.geometryRef) return materializeFrozenHoldout(sample, page);
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
