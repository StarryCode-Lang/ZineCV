import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as mammoth from "mammoth";
import type { PdfImportContent } from "./pdf-import-content";
import { IMPORT_LIMITS } from "./import-limits";
import { localPdfJsResourceOptions } from "./pdfjs-resources";
import { pdfLines, type PdfTextLine } from "./pdf-reading-order";

type Request = {
  id: number;
  kind: "pdf" | "docx";
  buffer: ArrayBuffer;
};

async function parsePdf(buffer: ArrayBuffer): Promise<PdfImportContent> {
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  // pdfjs v6 默认 useWorkerFetch 会读取 document.baseURI 判断可否 fetch，
  // 本文件运行在 Worker 中没有 document，必须显式交给内层 pdf.worker 自取资源。
  const loadingTask = pdfjs.getDocument({
    data: buffer,
    useWorkerFetch: true,
    ...localPdfJsResourceOptions(self.location.href),
  });
  const document = await loadingTask.promise;
  try {
    if (document.numPages < 1 || document.numPages > IMPORT_LIMITS.pages)
      throw new Error("PDF 页数必须在 1–50 页以内");
    const pages: PdfImportContent["pages"] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageWidth = page.view[2] - page.view[0];

      const items: PdfTextLine[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        items.push({
          text: item.str,
          page: pageNumber,
          x: item.transform[4],
          width: Math.max(0, item.width),
          y: item.transform[5],
          fontSize: Math.hypot(item.transform[0], item.transform[1]),
          fontName: content.styles[item.fontName]?.fontFamily ?? item.fontName,
        });
      }
      const operators = await page.getOperatorList();
      const imageOperators = new Set([
        pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject,
        pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintImageMaskXObject,
        pdfjs.OPS.paintImageMaskXObjectGroup, pdfjs.OPS.paintInlineImageXObjectGroup,
        pdfjs.OPS.paintImageMaskXObjectRepeat,
      ]);
      pages.push({ page: pageNumber, lines: pdfLines(items, pageNumber, pageWidth),
        hasRasterImage: operators.fnArray.some(operator => imageOperators.has(operator)),
        textCharacters: items.reduce((sum, item) => sum + item.text.trim().length, 0) });
      page.cleanup();
    }
    return { pages };
  } finally {
    await loadingTask.destroy();
  }
}

self.addEventListener("message", (event: MessageEvent<Request>) => {
  const { id, kind, buffer } = event.data;
  void (async () => {
    try {
      if (kind === "pdf") {
        self.postMessage({ id, ok: true, result: await parsePdf(buffer) });
      } else {
        const converted = await mammoth.convertToHtml(
          { arrayBuffer: buffer },
          { includeDefaultStyleMap: true },
        );
        self.postMessage({ id, ok: true, result: converted.value });
      }
    } catch (error) {
      self.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : "文件解析工作线程失败",
      });
    }
  })();
});
