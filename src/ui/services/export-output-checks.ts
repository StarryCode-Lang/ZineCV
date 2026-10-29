import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ExportResult } from "../../../src-tauri/src/domain/bindings/ExportResult";
import type { ExportPng } from "../../../src-tauri/src/domain/bindings/ExportPng";
import type { TextMap } from "../../../src-tauri/src/domain/bindings/TextMap";
import type { ExportFinding } from "./export-checks";
import { localPdfJsResourceOptions } from "./pdfjs-resources";

const decode = (base64: string) => Uint8Array.from(atob(base64), value => value.charCodeAt(0));
const hash = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map(value => value.toString(16).padStart(2, "0")).join("");

// Ignore layout whitespace, discretionary hyphens and bidi formatting controls;
// preserve letters, digits, punctuation, ZWJ/ZWNJ and their logical order.
const normalizedText = (value: string) => value.normalize("NFC").replace(/[\s\u00ad\u200b\u202a-\u202e\u2066-\u2069]/g, "");
const normalizedHref = (href: string) => { try { return new URL(href).href; } catch { return href; } };

export function expectedPageText(map: TextMap, page: number): string {
  const covered = new Set<number>();
  const parts: string[] = [];
  for (const cluster of map.clusters.filter(item => item.page === page).sort((a, b) => a.logicalOrder - b.logicalOrder)) {
    for (let index = cluster.startUtf16; index < cluster.endUtf16; index++) {
      if (covered.has(index)) continue;
      covered.add(index); parts.push(map.logicalText[index] ?? "");
    }
  }
  return parts.join("");
}

export async function checkExportOutput(result: ExportResult, format: "pdf" | "png"): Promise<ExportFinding[]> {
  const findings: ExportFinding[] = [];
  const error = (id: string, message: string, field: string) => findings.push({ id, severity: "error", message, field });
  const data = result.data;
  if (!Number.isSafeInteger(data.pageCount) || data.pageCount < 1) {
    error("output-page-count", "冻结输出的页数无效，已阻止保存。", "output.pages"); return findings;
  }
  if (format === "png") {
    if (data.pngPages.length !== data.pageCount || data.pngPages.some((page, index) => page.page !== index + 1)) {
      error("output-png-order", "PNG 页数或页序不完整，已阻止保存。", "output.pngPages");
    }
    const inspectPng = async (png: ExportPng, id: string) => {
      try {
        const bytes = decode(png.dataBase64);
        if (await hash(bytes) !== png.sha256) { error(`${id}-hash`, "PNG 文件摘要不一致，已阻止保存。", id); return; }
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        try {
          if (bitmap.width !== png.width || bitmap.height !== png.height || png.width < 1 || png.height < 1) error(`${id}-size`, "PNG 的实际像素尺寸与冻结输出不一致。", id);
        } finally { bitmap.close(); }
      } catch { error(`${id}-decode`, "PNG 字节无法完整解码，已阻止保存。", id); }
    };
    // Inspect one image at a time, never retain a second full raster set.
    for (const png of data.pngPages) await inspectPng(png, `output.png:${png.page}`);
    if (data.longPng && !data.longImageLimited) await inspectPng(data.longPng, "output.png:long");
    return findings;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decode(data.pdfBase64);
    if (await hash(bytes) !== data.pdfSha256) { error("output-pdf-hash", "PDF 文件摘要不一致，已阻止保存。", "output.pdf"); return findings; }
  } catch { error("output-pdf-bytes", "PDF 字节无效，已阻止保存。", "output.pdf"); return findings; }
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loading = pdfjs.getDocument({ data: bytes, ...localPdfJsResourceOptions(window.location.href),
    stopAtErrors: true, enableXfa: false, disableFontFace: true, useSystemFonts: false });
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; void loading.destroy(); }, 30_000);
  try {
    const pdf = await loading.promise;
    const pages = data.selectedPages?.length ? data.selectedPages : Array.from({ length: data.pageCount }, (_, index) => index + 1);
    if (pdf.numPages !== pages.length) error("output-pdf-pages", "PDF 的实际页数与本次选择不一致。", "output.pages");
    for (let index = 0; index < pdf.numPages; index++) {
      const page = await pdf.getPage(index + 1);
      try {
        const sourcePage = pages[index];
        const content = await page.getTextContent({ disableNormalization: true });
        // Resolve the embedded font identities before excluding decoration.
        // TextMap excludes the dedicated icon font; PUA in ordinary text remains
        // semantic and must still match exactly. Never strip all PUA characters.
        // The font ships as "iconfont" in historical fixtures and as
        // "ZineCVSymbols" since the 2026-10 rename; subset prefixes vary.
        await page.getOperatorList();
        const actual = content.items.map(item => {
          if (!("str" in item)) return "";
          const font = page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : null;
          if (typeof font?.name === "string" && /^(?:[A-Z]{6}\+)?(?:iconfont|zinecvsymbols)$/i.test(font.name)
            && /^[\s\uE000-\uF8FF]+$/u.test(item.str)) return "";
          return item.str;
        }).join("");
        const expected = sourcePage === undefined ? "" : expectedPageText(data.textMap, sourcePage);
        if (!normalizedText(actual)) error(`output-pdf-empty-${index}`, `PDF 第 ${index + 1} 页没有可提取文字，请核对空白页或文字输出。`, `output.page:${index + 1}`);
        else if (normalizedText(actual) !== normalizedText(expected)) error(`output-pdf-text-${index}`, `PDF 第 ${index + 1} 页的文字或阅读顺序与冻结排版记录不一致。`, `output.page:${index + 1}`);
        const expectedLinks = new Set(data.textMap.links.filter(link => data.textMap.clusters.some(cluster => cluster.page === sourcePage
          && cluster.startUtf16 < link.endUtf16 && cluster.endUtf16 > link.startUtf16)).map(link => normalizedHref(link.href)));
        const annotations = await page.getAnnotations();
        const actualLinks = new Set(annotations.flatMap(annotation => annotation.subtype === "Link" && typeof annotation.url === "string" ? [normalizedHref(annotation.url)] : []));
        if ([...expectedLinks].some(href => !actualLinks.has(href)) || [...actualLinks].some(href => !expectedLinks.has(href))) error(`output-pdf-links-${index}`, `PDF 第 ${index + 1} 页的链接目标与冻结记录不一致。`, `output.page:${index + 1}/links`);
      } finally { page.cleanup(); }
    }
  } catch {
    error("output-pdf-parse", timedOut ? "实际 PDF 检查超过 30 秒，已停止检查；请重试。" : "实际 PDF 无法完整解析，已阻止保存。", "output.pdf");
  } finally { window.clearTimeout(timeout); await loading.destroy(); }
  return findings;
}
