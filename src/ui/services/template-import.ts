import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  ImportedTemplate,
  ImportedTemplateSource,
} from "../domain/imported-template";
import {
  structureRecognizedLines,
  type RecognizedLine,
  type RecognizedFieldProvenance,
  type RecognizedResumeContent,
} from "./resume-content-recognition";
import { createEntityId } from "../utils/resume";
import { IMPORT_LIMITS } from "./import-limits";
import { createIsolatedImportPreview } from "./import-preview-sandbox";
import { localPdfJsResourceOptions } from "./pdfjs-resources";

type OcrProgress = { status: string; progress: number };
type OcrWorker = Awaited<ReturnType<typeof createLocalOcrWorker>>;

// 一次导入会话共享一个 tesseract worker：chi_sim+eng 模型加载最重，逐页
// 重建会把多页扫描导入的耗时放大页数倍。worker 生命周期归会话所有；abort
// 立即终止（原单页 abort 语义），页内 recognize 仍以 waitWithAbort 兜底
// terminate 后 promise 永不 settle 的已知问题。
type OcrSession = {
  acquire: () => Promise<OcrWorker>;
  setProgress: (sink?: (message: string) => void) => void;
  release: () => void;
};

function createOcrSession(signal?: AbortSignal): OcrSession {
  let workerPromise: Promise<OcrWorker> | null = null;
  let progressSink: ((message: string) => void) | null = null;
  const terminate = () => {
    const promise = workerPromise;
    workerPromise = null;
    void promise?.then((worker) => worker.terminate(), () => undefined);
  };
  const onAbort = () => terminate();
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    acquire: () => {
      workerPromise ??= createLocalOcrWorker((event) => {
        if (event.status === "recognizing text")
          progressSink?.(`正在识别文字 ${Math.round(event.progress * 100)}%`);
      });
      return workerPromise;
    },
    setProgress: (sink) => {
      progressSink = sink ?? null;
    },
    release: () => {
      signal?.removeEventListener("abort", onAbort);
      terminate();
    },
  };
}

export async function createLocalOcrWorker(onProgress?: (event: OcrProgress) => void) {
  const { createWorker } = await import("tesseract.js");
  const root = new URL("/ocr/", window.location.href);
  return createWorker(["chi_sim", "eng"], undefined, {
    workerPath: new URL("worker.min.js", root).href,
    corePath: new URL("tesseract-core-lstm.wasm.js", root).href,
    langPath: new URL("lang/", root).href,
    workerBlobURL: false,
    gzip: false,
    logger: onProgress,
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("导入已取消", "AbortError");
}

function waitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted)
    return Promise.reject(new DOMException("导入已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new DOMException("导入已取消", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function inspectDocxArchive(view: DataView) {
  const scanStart = Math.max(0, view.byteLength - 65_557);
  let endRecord = -1;
  for (let offset = view.byteLength - 22; offset >= scanStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endRecord = offset;
      break;
    }
  }
  if (endRecord < 0) throw new Error("DOCX 文件结构损坏或 ZIP64 格式暂不支持");
  const entries = view.getUint16(endRecord + 10, true);
  const directoryBytes = view.getUint32(endRecord + 12, true);
  const directoryOffset = view.getUint32(endRecord + 16, true);
  if (
    entries === 0xffff || directoryBytes === 0xffffffff ||
    directoryOffset === 0xffffffff || entries > IMPORT_LIMITS.docxEntries ||
    directoryOffset + directoryBytes > view.byteLength
  ) throw new Error("DOCX ZIP 目录超出允许范围或使用暂不支持的 ZIP64 格式");
  let cursor = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error("DOCX ZIP 目录损坏");
    const compressedBytes = view.getUint32(cursor + 20, true);
    const uncompressedBytes = view.getUint32(cursor + 24, true);
    const nameBytes = view.getUint16(cursor + 28, true);
    const extraBytes = view.getUint16(cursor + 30, true);
    const commentBytes = view.getUint16(cursor + 32, true);
    expandedBytes += uncompressedBytes;
    if (
      expandedBytes > IMPORT_LIMITS.docxExpandedBytes ||
      (uncompressedBytes > 0 && uncompressedBytes / Math.max(1, compressedBytes) > IMPORT_LIMITS.docxCompressionRatio)
    ) throw new Error("DOCX 解压体积或压缩比超出导入限额");
    cursor += 46 + nameBytes + extraBytes + commentBytes;
  }
  if (cursor > directoryOffset + directoryBytes)
    throw new Error("DOCX ZIP 目录长度不一致");
  if (expandedBytes / Math.max(1, view.byteLength) > IMPORT_LIMITS.docxCompressionRatio)
    throw new Error("DOCX 总压缩比超出导入限额");
}

function recognitionWorker(
  lines: RecognizedLine[],
  source: "pdf" | "word" | "image",
  signal?: AbortSignal,
): Promise<RecognizedResumeContent> {
  if (typeof Worker === "undefined") return Promise.resolve(structureRecognizedLines(lines, source));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./resume-recognition.worker.ts", import.meta.url), {
      type: "module",
    });
    const id = Date.now() + Math.floor(Math.random() * 1_000_000);
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("导入已取消", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener("message", (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      cleanup();
      if (event.data.ok) resolve(event.data.result as RecognizedResumeContent);
      else reject(new Error(String(event.data.error ?? "简历内容映射失败")));
    });
    worker.addEventListener("error", (event) => {
      cleanup();
      reject(new Error(event.message || "导入解析工作线程异常退出"));
    });
    worker.postMessage({ id, source, lines });
  });
}

let fileParserSequence = 0;

function parseFileInWorker<T>(
  kind: "pdf" | "docx",
  buffer: ArrayBuffer,
  signal?: AbortSignal,
): Promise<T> {
  if (typeof Worker === "undefined")
    return Promise.reject(new Error("当前运行环境不支持隔离文件解析工作线程"));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./template-file-parser.worker.ts", import.meta.url), {
      type: "module",
    });
    const id = ++fileParserSequence;
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("导入已取消", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.addEventListener("message", (event: MessageEvent) => {
      if (event.data?.id !== id) return;
      cleanup();
      if (event.data.ok) resolve(event.data.result as T);
      else reject(new Error(String(event.data.error ?? "文件解析工作线程失败")));
    });
    worker.addEventListener("error", (event) => {
      cleanup();
      reject(new Error(event.message || "文件解析工作线程异常退出"));
    });
    const transferred = buffer.slice(0);
    worker.postMessage({ id, kind, buffer: transferred }, [transferred]);
  });
}

function sourceType(file: File): ImportedTemplateSource {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (file.type.startsWith("image/")) return "image";
  if (extension === "pdf" || file.type === "application/pdf") return "pdf";
  if (extension === "docx") return "word";
  throw new Error("仅支持图片、PDF 或 DOCX 格式的简历");
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = url;
  });
}

function fileAsDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("文件读取失败"));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function compactCanvas(source: HTMLCanvasElement | HTMLImageElement) {
  const maximumWidth = 560;
  const maximumHeight = 760;
  const sourceWidth =
    source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
  const sourceHeight =
    source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;
  const scale = Math.min(
    1,
    maximumWidth / sourceWidth,
    maximumHeight / sourceHeight,
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function renderImage(file: File, signal?: AbortSignal) {
  throwIfAborted(signal);
  const sourceUrl = await fileAsDataUrl(file);
  const image = await loadImage(sourceUrl);
  throwIfAborted(signal);
  if (image.naturalWidth * image.naturalHeight > IMPORT_LIMITS.imagePixels)
    throw new Error("图片像素数超过 4000 万的导入上限");
  return compactCanvas(image);
}

async function renderPdf(file: File, signal?: AbortSignal, onProgress?: (message: string) => void) {
  const pdfjs = await import("pdfjs-dist");
  throwIfAborted(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({
    data: await file.arrayBuffer(),
    ...localPdfJsResourceOptions(window.location.href),
  });
  let renderTask: { cancel(): void } | undefined;
  let destroyPromise: Promise<void> | undefined;
  const destroyDocument = () => {
    destroyPromise ??= loadingTask.destroy();
    return destroyPromise;
  };
  const abortDocument = () => {
    try {
      renderTask?.cancel();
    } catch {
      // A completed PDF render task may reject a late cancellation.
    }
    void destroyDocument();
  };
  signal?.addEventListener("abort", abortDocument, { once: true });
  try {
    const pdfDocument = await waitWithAbort(loadingTask.promise, signal);
    if (pdfDocument.numPages < 1 || pdfDocument.numPages > IMPORT_LIMITS.pages)
      throw new Error("PDF 页数必须在 1–50 页以内");
    const contentPromise = parseFileInWorker<RecognizedResumeContent>(
      "pdf",
      await file.arrayBuffer(),
      signal,
    );
    void contentPromise.catch(() => undefined);
    const firstPage = await waitWithAbort(pdfDocument.getPage(1), signal);
    const baseViewport = firstPage.getViewport({ scale: 1 });
    const desiredScale = Math.min(2.4, Math.max(1.35, window.devicePixelRatio * 1.35));
    const pixelBoundScale = Math.sqrt(20_000_000 / Math.max(1, baseViewport.width * baseViewport.height));
    const viewport = firstPage.getViewport({ scale: Math.min(desiredScale, pixelBoundScale) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建 PDF 预览");
    const task = firstPage.render({ canvas, canvasContext: context, viewport });
    renderTask = task;
    await waitWithAbort(task.promise, signal);
    renderTask = undefined;
    let content = await waitWithAbort(contentPromise, signal);
    throwIfAborted(signal);
    if (!content.extractedText.trim()) {
      const scannedLines: RecognizedLine[] = [];
      const ocrSession = createOcrSession(signal);
      try {
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        throwIfAborted(signal);
        onProgress?.(`正在识别扫描 PDF 第 ${pageNumber}/${pdfDocument.numPages} 页…`);
        let scannedCanvas = canvas;
        if (pageNumber !== 1) {
          const page = await waitWithAbort(pdfDocument.getPage(pageNumber), signal);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(desiredScale, Math.sqrt(20_000_000 / Math.max(1, base.width * base.height)));
          const pageViewport = page.getViewport({ scale });
          scannedCanvas = document.createElement("canvas");
          scannedCanvas.width = Math.ceil(pageViewport.width);
          scannedCanvas.height = Math.ceil(pageViewport.height);
          const pageContext = scannedCanvas.getContext("2d");
          if (!pageContext) throw new Error("无法创建扫描 PDF 页面");
          const pageTask = page.render({ canvas: scannedCanvas, canvasContext: pageContext, viewport: pageViewport });
          renderTask = pageTask;
          await waitWithAbort(pageTask.promise, signal);
          renderTask = undefined;
        }
        try {
          const pageLines = await recognizeImageText(scannedCanvas, onProgress, signal, ocrSession);
          scannedLines.push(...pageLines.map(line => ({ ...line, page: pageNumber })));
        } finally {
          if (scannedCanvas !== canvas) { scannedCanvas.width = 0; scannedCanvas.height = 0; }
        }
      }
      } finally {
        ocrSession.release();
      }
      content = await recognitionWorker(scannedLines, "pdf", signal);
      content.warnings.push("扫描 PDF 已逐页 OCR；请核对文字、页序和字段识别结果。");
    }
    if (!content.extractedText.trim())
      throw new Error("没有识别到可编辑文字，请尝试更清晰的文件或图片");
    return { canvas, content };
  } finally {
    signal?.removeEventListener("abort", abortDocument);
    await destroyDocument();
  }
}

async function renderWord(file: File, signal?: AbortSignal) {
  const [{ renderAsync }, { default: html2canvas }] = await Promise.all([
    import("docx-preview"),
    import("html2canvas"),
  ]);
  const buffer = await file.arrayBuffer();
  throwIfAborted(signal);
  inspectDocxArchive(new DataView(buffer));
  const convertedHtml = await parseFileInWorker<string>("docx", buffer, signal);
  throwIfAborted(signal);
  const isolatedPreview = await createIsolatedImportPreview(signal);
  try {
    await waitWithAbort(renderAsync(buffer, isolatedPreview.host, undefined, {
      inWrapper: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: false,
      // The renderer creates object URLs in the parent window and exposes no
      // disposer. Data URLs keep these temporary assets owned by the iframe.
      useBase64URL: true,
    }), signal);
    throwIfAborted(signal);
    const page =
      isolatedPreview.host.querySelector<HTMLElement>(".docx-wrapper > section") ?? isolatedPreview.host;
    // SVG snapshots cannot resolve the renderer's temporary blob URLs after
    // serialization. Embed only locally generated image resources beforehand.
    for (const image of page.querySelectorAll<SVGImageElement>("svg image")) {
      const href = image.getAttribute("href");
      if (!href || (!href.startsWith(`blob:${location.origin}/`) && !href.startsWith("data:image/"))) continue;
      const embedded = href.startsWith("data:image/") ? href : await waitWithAbort(
        fetch(href).then(response => response.blob()).then(fileAsDataUrl), signal,
      );
      image.setAttribute("href", embedded);
      image.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", embedded);
      const svg = image.closest("svg");
      if (svg && svg.children.length === 1 && svg.firstElementChild === image) {
        const raster = isolatedPreview.document.createElement("img");
        raster.src = embedded;
        raster.style.cssText = svg.style.cssText;
        svg.replaceWith(raster);
        await waitWithAbort(raster.decode(), signal);
      }
    }
    const canvas = await waitWithAbort(html2canvas(page, {
      backgroundColor: "#ffffff",
      scale: 1,
      logging: false,
      useCORS: false,
      allowTaint: false,
    }), signal);
    const documentRoot = new DOMParser().parseFromString(
      convertedHtml,
      "text/html",
    );
    const blockSelector = "h1,h2,h3,h4,h5,h6,p,li,tr";
    const blocks = Array.from(documentRoot.body.querySelectorAll(blockSelector))
      .filter(element => !element.parentElement?.closest(blockSelector));
    const lines = (blocks.length ? blocks : [documentRoot.body])
      .map((element) => element.tagName === "TR"
        ? Array.from(element.children).map(cell => cell.textContent?.trim() ?? "").join(" ")
        : element.textContent?.trim() ?? "")
      .filter(Boolean)
      .map((text) => ({ text }));
    const textElement =
      page.querySelector<HTMLElement>("span,p,h1,h2,h3,h4,h5,h6") ?? page;
    const detectedFont = isolatedPreview.document.defaultView
      ?.getComputedStyle(textElement).fontFamily;
    return {
      canvas: compactCanvas(canvas),
      lines: lines.map((line) => ({ ...line, fontName: detectedFont })),
    };
  } finally {
    isolatedPreview.dispose();
  }
}

async function recognizeImageText(
  canvas: HTMLCanvasElement,
  onProgress: ((message: string) => void) | undefined,
  signal: AbortSignal | undefined,
  session: OcrSession,
) {
  const probe = document.createElement("canvas");
  probe.width = 120;
  probe.height = Math.max(1, Math.round((canvas.height / canvas.width) * 120));
  const probeContext = probe.getContext("2d", { willReadFrequently: true });
  probeContext?.drawImage(canvas, 0, 0, probe.width, probe.height);
  const pixels = probeContext?.getImageData(
    0,
    0,
    probe.width,
    probe.height,
  ).data;
  let detailEdges = 0;
  let rowEdges = 0;
  let textRows = 0;
  if (pixels) {
    for (let index = 4; index < pixels.length; index += 4) {
      if ((index / 4) % probe.width === 0) {
        if (rowEdges >= 6) textRows += 1;
        rowEdges = 0;
        continue;
      }
      const current = pixels[index] + pixels[index + 1] + pixels[index + 2];
      const previous =
        pixels[index - 4] + pixels[index - 3] + pixels[index - 2];
      if (Math.abs(current - previous) > 90) {
        detailEdges += 1;
        rowEdges += 1;
      }
    }
    if (rowEdges >= 6) textRows += 1;
  }
  // Flat color bands and divider rules have no editable text. Skipping OCR here
  // keeps visual-only image templates instant while real document images still
  // enter the full OCR path.
  if (textRows < 3 && detailEdges / Math.max(1, probe.width * probe.height) < 0.05) return [];
  throwIfAborted(signal);
  onProgress?.("正在加载中英文 OCR 模型…");
  session.setProgress(onProgress);
  const worker = await waitWithAbort(session.acquire(), signal);
  try {
    throwIfAborted(signal);
    // tesseract 的 recognize 在底层 worker 被 terminate 后 promise 可能永不
    // settle，必须用 waitWithAbort 保证 abort 立即返回，让 activeRecognitions
    // 计数随上层 finally 释放，否则后续导入会被并发限额永久拒绝。
    let result = await waitWithAbort(
      worker.recognize(canvas, {}, { text: true, blocks: true }),
      signal,
    );
    let rotation = 0;
    // Sparse pages and sideways scans can pass the image probe yet have poor
    // recognition. Reuse the same worker and keep the retry budget bounded.
    if (result.data.confidence < 60) {
      let score = result.data.confidence * Math.min(result.data.text.replace(/\s/g, "").length, 40);
      for (const turn of [1, 2, 3]) {
        throwIfAborted(signal);
        const rotated = document.createElement("canvas");
        rotated.width = turn % 2 ? canvas.height : canvas.width;
        rotated.height = turn % 2 ? canvas.width : canvas.height;
        const context = rotated.getContext("2d");
        if (!context) continue;
        context.translate(rotated.width / 2, rotated.height / 2);
        context.rotate(turn * Math.PI / 2);
        context.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
        try {
          const candidate = await waitWithAbort(
            worker.recognize(rotated, {}, { text: true, blocks: true }), signal,
          );
          const candidateScore = candidate.data.confidence * Math.min(candidate.data.text.replace(/\s/g, "").length, 40);
          if (candidateScore > score) {
            result = candidate;
            rotation = turn;
            score = candidateScore;
          }
        } finally {
          rotated.width = 0;
          rotated.height = 0;
        }
      }
    }
    throwIfAborted(signal);
    const blockLines = result.data.blocks?.flatMap((block) =>
      block.paragraphs.flatMap((paragraph) =>
        paragraph.lines.map((line) => ({
          text: line.text,
          x: rotation === 1 ? line.bbox.y0 : rotation === 2 ? canvas.width - line.bbox.x1 : rotation === 3 ? canvas.width - line.bbox.y1 : line.bbox.x0,
          y: rotation === 1 ? canvas.height - line.bbox.x1 : rotation === 2 ? canvas.height - line.bbox.y1 : rotation === 3 ? line.bbox.x0 : line.bbox.y0,
        })),
      ),
    );
    return blockLines?.length
      ? blockLines
      : result.data.text.split(/\r?\n/).map((text) => ({ text }));
  } finally {
    // worker 生命周期归会话所有；本页结束不终止，多页扫描在页间复用。
  }
}

function analyzeCanvas(canvas: HTMLCanvasElement) {
  const sample = document.createElement("canvas");
  sample.width = 72;
  sample.height = 96;
  const context = sample.getContext("2d", { willReadFrequently: true });
  if (!context)
    return {
      accent: "#000000",
      formatId: "legacy-v1" as const,
      layout: "single-column" as const,
      analysis: "已识别为经典单栏结构",
    };
  context.drawImage(canvas, 0, 0, sample.width, sample.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  const colors = new Map<string, number>();
  const panelSamples: number[][] = [];
  const pageSamples: number[][] = [];
  for (let y = 29; y < 87; y += 3) {
    for (const [x, target] of [
      [11, panelSamples],
      [38, pageSamples],
    ] as const) {
      const offset = (y * sample.width + x) * 4;
      target.push([pixels[offset], pixels[offset + 1], pixels[offset + 2]]);
    }
  }
  const medianColor = (samples: number[][]) =>
    [0, 1, 2].map(
      (channel) =>
        samples.map((item) => item[channel]).sort((a, b) => a - b)[
          Math.floor(samples.length / 2)
        ],
    );
  const panelColor = medianColor(panelSamples);
  const pageColor = medianColor(pageSamples);
  const sideBandBackground = `#${panelColor
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
  const sideBandForeground =
    panelColor[0] * 0.2126 + panelColor[1] * 0.7152 + panelColor[2] * 0.0722 >
    150
      ? "#252a2f"
      : "#ffffff";
  const panelContrast = Math.hypot(
    ...panelColor.map((value, index) => value - pageColor[index]),
  );
  const coloredSideBand =
    panelContrast > 24 &&
    Math.max(...panelColor) - Math.min(...panelColor) > 10;
  let ink = 0;
  let leftInk = 0;
  let leftSamples = 0;
  for (let y = 0; y < sample.height; y += 1) {
    for (let x = 0; x < sample.width; x += 1) {
      const offset = (y * sample.width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const brightness = (red + green + blue) / 3;
      const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
      if (brightness < 210) ink += 1;
      if (x < sample.width * 0.28) {
        leftSamples += 1;
        if (brightness < 150) leftInk += 1;
      }
      if (saturation > 0.25 && brightness > 45 && brightness < 215) {
        const key = [red, green, blue]
          .map((value) => Math.round(value / 32) * 32)
          .join(",");
        colors.set(key, (colors.get(key) ?? 0) + 1);
      }
    }
  }
  const dominant = [...colors.entries()].sort((a, b) => b[1] - a[1])[0];
  const rgb = dominant?.[0].split(",").map(Number) ?? [0, 0, 0];
  const accentRgb = coloredSideBand
    ? panelColor.map((value) => Math.max(0, value - 66))
    : rgb;
  const accent = `#${accentRgb
    .map((value) => Math.min(255, value).toString(16).padStart(2, "0"))
    .join("")}`;
  const inkDensity = ink / (sample.width * sample.height);
  const hasSideBand =
    leftInk / Math.max(1, leftSamples) > 0.28 || coloredSideBand;
  const formatId = hasSideBand
    ? ("clear-single-v1" as const)
    : inkDensity > 0.22
      ? ("compact-single-v1" as const)
      : ("clear-single-v1" as const);
  const structure = hasSideBand
    ? "侧栏强调型"
    : inkDensity > 0.22
      ? "高密度单栏"
      : "留白单栏";
  return {
    accent,
    formatId,
    layout: hasSideBand ? ("side-band" as const) : ("single-column" as const),
    sideBandBackground: hasSideBand ? sideBandBackground : undefined,
    sideBandForeground: hasSideBand ? sideBandForeground : undefined,
    analysis: `已识别为${structure}；提取主色 ${accent}`,
  };
}

function extractPdfAvatar(canvas: HTMLCanvasElement) {
  const x = Math.round(canvas.width * 0.66);
  const y = Math.round(canvas.height * 0.04);
  const width = Math.round(canvas.width * 0.29);
  const height = Math.round(canvas.height * 0.22);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  const pixels = context.getImageData(x, y, width, height).data;
  let dark = 0;
  let light = 0;
  let sampled = 0;
  for (let index = 0; index < pixels.length; index += 40) {
    const brightness =
      (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
    if (brightness < 140) dark += 1;
    if (brightness > 200) light += 1;
    sampled += 1;
  }
  if (dark / sampled < 0.08 || light / sampled < 0.08) return undefined;
  const portrait = document.createElement("canvas");
  portrait.width = width;
  portrait.height = height;
  portrait
    .getContext("2d")
    ?.drawImage(canvas, x, y, width, height, 0, 0, width, height);
  return portrait.toDataURL("image/jpeg", 0.8);
}

// 字段页码 provenance 的识别会话内侧信道：ImportedTemplate 必须保持可序列化的
// 持久化形状，页码证据只在本次识别→审阅链路内消费，因此用 WeakMap 挂载，
// 不进入 ImportedTemplate，也不写入模板目录。
const templateFieldProvenance = new WeakMap<
  ImportedTemplate,
  RecognizedFieldProvenance
>();

export function importedTemplateFieldProvenance(
  template: ImportedTemplate,
): RecognizedFieldProvenance {
  return templateFieldProvenance.get(template) ?? {};
}

async function recognizeTemplateImpl(
  file: File,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<ImportedTemplate> {
  if (file.size > IMPORT_LIMITS.fileBytes) throw new Error("文件不能超过 18MB");
  throwIfAborted(signal);
  const type = sourceType(file);
  onProgress?.("正在读取版式与正文…");
  let canvas: HTMLCanvasElement;
  let lines: RecognizedLine[] = [];
  let content: RecognizedResumeContent;
  if (type === "image") {
    canvas = await renderImage(file, signal);
    const ocrSession = createOcrSession(signal);
    try {
      lines = await recognizeImageText(canvas, onProgress, signal, ocrSession);
    } finally {
      ocrSession.release();
    }
    content = await recognitionWorker(lines, type, signal);
  } else if (type === "pdf") {
    const parsed = await renderPdf(file, signal, onProgress);
    canvas = parsed.canvas;
    content = parsed.content;
  } else {
    const parsed = await renderWord(file, signal);
    canvas = parsed.canvas;
    lines = parsed.lines;
    content = await recognitionWorker(lines, type, signal);
  }
  throwIfAborted(signal);
  if (type !== "image" && !content.extractedText.trim())
    throw new Error("没有识别到可编辑文字，请尝试更清晰的文件或图片");
  onProgress?.("正在映射可编辑模块…");
  const recognized = analyzeCanvas(canvas);
  const hasText = content.extractedText.trim().length > 0;
  if (type === "pdf") {
    const avatar = extractPdfAvatar(canvas);
    if (avatar) {
      content.resume.basic.avatar = avatar;
      content.warnings.push("已提取顶部图像作为头像，请在编辑页核对裁切范围。");
    }
  }
  if (type === "image" && !lines.length)
    content.warnings.push("图片中未检测到文字，已仅保存视觉模板。 ");
  const template: ImportedTemplate = {
    id: createEntityId("imported"),
    name: file.name.replace(/\.[^.]+$/, "") || "导入模板",
    sourceName: file.name,
    sourceType: type,
    createdAt: new Date().toISOString(),
    previewDataUrl:
      type === "pdf"
        ? canvas.toDataURL("image/png")
        : canvas.toDataURL("image/jpeg", 0.9),
    ...recognized,
    resume: hasText ? content.resume : undefined,
    moduleOrder: hasText ? content.moduleOrder : undefined,
    moduleNames: hasText ? content.moduleNames : undefined,
    summaryTitle: hasText ? content.summaryTitle : undefined,
    detectedFont: hasText ? content.detectedFont : undefined,
    extractedText: content.extractedText,
    recognitionConfidence: content.confidence,
    recognitionWarnings: content.warnings,
    analysis: hasText
      ? `${recognized.analysis}；已识别 ${content.extractedText.length} 个字符并映射为可编辑模块`
      : `${recognized.analysis}；未检测到文字，仅保存视觉模板`,
  };
  templateFieldProvenance.set(template, content.fieldProvenance);
  return template;
}

let activeRecognitions = 0;

export async function recognizeTemplate(
  file: File,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<ImportedTemplate> {
  if (activeRecognitions >= IMPORT_LIMITS.concurrentParsers)
    throw new Error("当前已有导入任务运行，请等待或取消后重试");
  activeRecognitions += 1;
  try {
    return await recognizeTemplateImpl(file, onProgress, signal);
  } finally {
    activeRecognitions -= 1;
  }
}
