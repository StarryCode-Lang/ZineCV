import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as mammoth from "mammoth";
import {
  structureRecognizedLines,
  type RecognizedLine,
} from "./resume-content-recognition";
import { IMPORT_LIMITS } from "./import-limits";
import { localPdfJsResourceOptions } from "./pdfjs-resources";

type Request = {
  id: number;
  kind: "pdf" | "docx";
  buffer: ArrayBuffer;
};

function pdfLines(items: RecognizedLine[], page: number, pageWidth: number, pageHeight: number) {
  const pageItems = items.filter((line) => line.text.trim());
  const body = pageItems.filter((line) => (line.y ?? 0) < pageHeight * 0.7);
  const left = body.filter((line) => (line.x ?? 0) < pageWidth * 0.31);
  const right = body.filter(
    (line) => (line.x ?? 0) >= pageWidth * 0.34 && (line.x ?? 0) < pageWidth * 0.55,
  );
  const groups = left.length >= 12 && right.length >= 12
    ? [
        pageItems.filter((line) => (line.y ?? 0) >= pageHeight * 0.7),
        body.filter((line) => (line.x ?? 0) < pageWidth * 0.34),
        body.filter((line) => (line.x ?? 0) >= pageWidth * 0.34),
      ]
    : [pageItems];
  const result: RecognizedLine[] = [];
  for (const group of groups) {
    const rows = new Map<number, RecognizedLine[]>();
    for (const item of group) {
      const y = Math.round((item.y ?? 0) / 3) * 3;
      rows.set(y, [...(rows.get(y) ?? []), item]);
    }
    for (const [, row] of [...rows.entries()].sort((a, b) => b[0] - a[0])) {
      const ordered = row.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
      if (ordered.length) {
        result.push({
          ...ordered[0],
          page,
          text: ordered.map((item) => item.text).join(" "),
        });
      }
    }
  }
  return result;
}

async function parsePdf(buffer: ArrayBuffer) {
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
    const lines: RecognizedLine[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageWidth = page.view[2] - page.view[0];
      const pageHeight = page.view[3] - page.view[1];
      const items: RecognizedLine[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        items.push({
          text: item.str,
          page: pageNumber,
          x: item.transform[4],
          y: item.transform[5],
          fontSize: Math.hypot(item.transform[0], item.transform[1]),
          fontName: content.styles[item.fontName]?.fontFamily ?? item.fontName,
        });
      }
      lines.push(...pdfLines(items, pageNumber, pageWidth, pageHeight));
    }
    return structureRecognizedLines(lines, "pdf");
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
