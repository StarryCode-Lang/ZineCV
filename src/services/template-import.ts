import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type {
  ImportedTemplate,
  ImportedTemplateSource,
} from "../domain/imported-template";
import {
  structureRecognizedLines,
  type RecognizedLine,
} from "./resume-content-recognition";

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

function compactCanvas(source: HTMLCanvasElement) {
  const maximumWidth = 560;
  const maximumHeight = 760;
  const scale = Math.min(
    1,
    maximumWidth / source.width,
    maximumHeight / source.height,
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function renderImage(file: File) {
  const sourceUrl = await fileAsDataUrl(file);
  const image = await loadImage(sourceUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  return compactCanvas(canvas);
}

async function renderPdf(file: File) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const pdfDocument = await pdfjs.getDocument({
    data: await file.arrayBuffer(),
  }).promise;
  const firstPage = await pdfDocument.getPage(1);
  const viewport = firstPage.getViewport({ scale: 1.35 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建 PDF 预览");
  await firstPage.render({ canvas, canvasContext: context, viewport }).promise;
  const lines: RecognizedLine[] = [];
  for (
    let pageNumber = 1;
    pageNumber <= pdfDocument.numPages;
    pageNumber += 1
  ) {
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageWidth = page.view[2] - page.view[0];
    const pageHeight = page.view[3] - page.view[1];
    const items: RecognizedLine[] = [];
    content.items.forEach((item) => {
      if (!("str" in item) || !item.str.trim()) return;
      items.push({
        text: item.str,
        page: pageNumber,
        x: item.transform[4],
        y: item.transform[5],
        fontSize: Math.hypot(item.transform[0], item.transform[1]),
        fontName: content.styles[item.fontName]?.fontFamily ?? item.fontName,
      });
    });
    const body = items.filter((item) => (item.y ?? 0) < pageHeight * 0.7);
    const left = body.filter((item) => (item.x ?? 0) < pageWidth * 0.31);
    const right = body.filter(
      (item) =>
        (item.x ?? 0) >= pageWidth * 0.34 && (item.x ?? 0) < pageWidth * 0.55,
    );
    const twoColumns = left.length >= 12 && right.length >= 12;
    const groups = twoColumns
      ? [
          items.filter((item) => (item.y ?? 0) >= pageHeight * 0.7),
          body.filter((item) => (item.x ?? 0) < pageWidth * 0.34),
          body.filter((item) => (item.x ?? 0) >= pageWidth * 0.34),
        ]
      : [items];
    groups.forEach((group) => {
      const rows = new Map<number, RecognizedLine[]>();
      group.forEach((item) => {
        const y = Math.round((item.y ?? 0) / 3) * 3;
        rows.set(y, [...(rows.get(y) ?? []), item]);
      });
      [...rows.entries()]
        .sort((a, b) => b[0] - a[0])
        .forEach(([, row]) => {
          const ordered = row.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
          lines.push({
            ...ordered[0],
            text: ordered.map((item) => item.text).join(" "),
          });
        });
    });
  }
  return { canvas: compactCanvas(canvas), lines };
}

async function renderWord(file: File) {
  const [{ renderAsync }, { default: html2canvas }, mammoth] =
    await Promise.all([
      import("docx-preview"),
      import("html2canvas"),
      import("mammoth"),
    ]);
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "794px",
    background: "white",
    pointerEvents: "none",
  });
  document.body.append(host);
  try {
    const buffer = await file.arrayBuffer();
    await renderAsync(buffer, host, undefined, {
      inWrapper: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: false,
    });
    const page =
      host.querySelector<HTMLElement>(".docx-wrapper > section") ?? host;
    const canvas = await html2canvas(page, {
      backgroundColor: "#ffffff",
      scale: 1,
      logging: false,
      useCORS: true,
    });
    const converted = await mammoth.convertToHtml(
      { arrayBuffer: buffer },
      { includeDefaultStyleMap: true },
    );
    const documentRoot = new DOMParser().parseFromString(
      converted.value,
      "text/html",
    );
    const blocks = Array.from(
      documentRoot.body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,tr"),
    );
    const lines = (blocks.length ? blocks : [documentRoot.body])
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean)
      .map((text) => ({ text }));
    const textElement =
      page.querySelector<HTMLElement>("span,p,h1,h2,h3,h4,h5,h6") ?? page;
    const detectedFont = getComputedStyle(textElement).fontFamily;
    return {
      canvas: compactCanvas(canvas),
      lines: lines.map((line) => ({ ...line, fontName: detectedFont })),
    };
  } finally {
    host.remove();
  }
}

async function recognizeImageText(
  canvas: HTMLCanvasElement,
  onProgress?: (message: string) => void,
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
  if (pixels) {
    for (let index = 4; index < pixels.length; index += 4) {
      if ((index / 4) % probe.width === 0) continue;
      const current = pixels[index] + pixels[index + 1] + pixels[index + 2];
      const previous =
        pixels[index - 4] + pixels[index - 3] + pixels[index - 2];
      if (Math.abs(current - previous) > 90) detailEdges += 1;
    }
  }
  // Flat color bands and divider rules have no editable text. Skipping OCR here
  // keeps visual-only image templates instant while real document images still
  // enter the full OCR path.
  if (detailEdges / Math.max(1, probe.width * probe.height) < 0.05) return [];
  onProgress?.("正在加载中英文 OCR 模型…");
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(["chi_sim", "eng"], undefined, {
    logger: (event) => {
      if (event.status === "recognizing text")
        onProgress?.(`正在识别文字 ${Math.round(event.progress * 100)}%`);
    },
  });
  try {
    const result = await worker.recognize(
      canvas,
      {},
      { text: true, blocks: true },
    );
    const blockLines = result.data.blocks?.flatMap((block) =>
      block.paragraphs.flatMap((paragraph) =>
        paragraph.lines.map((line) => ({
          text: line.text,
          x: line.bbox.x0,
          y: line.bbox.y0,
        })),
      ),
    );
    return blockLines?.length
      ? blockLines
      : result.data.text.split(/\r?\n/).map((text) => ({ text }));
  } finally {
    await worker.terminate();
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

export async function recognizeTemplate(
  file: File,
  onProgress?: (message: string) => void,
): Promise<ImportedTemplate> {
  if (file.size > 18 * 1024 * 1024) throw new Error("文件不能超过 18MB");
  const type = sourceType(file);
  onProgress?.("正在读取版式与正文…");
  let canvas: HTMLCanvasElement;
  let lines: RecognizedLine[];
  if (type === "image") {
    canvas = await renderImage(file);
    lines = await recognizeImageText(canvas, onProgress);
  } else if (type === "pdf") {
    const parsed = await renderPdf(file);
    canvas = parsed.canvas;
    lines = parsed.lines;
  } else {
    const parsed = await renderWord(file);
    canvas = parsed.canvas;
    lines = parsed.lines;
  }
  if (type !== "image" && !lines.some((line) => line.text.trim()))
    throw new Error("没有识别到可编辑文字，请尝试更清晰的文件或图片");
  onProgress?.("正在映射可编辑模块…");
  const recognized = analyzeCanvas(canvas);
  const content = structureRecognizedLines(lines, type);
  if (type === "pdf") {
    const avatar = extractPdfAvatar(canvas);
    if (avatar) {
      content.resume.basic.avatar = avatar;
      content.warnings.push("已提取顶部图像作为头像，请在编辑页核对裁切范围。");
    }
  }
  if (type === "image" && !lines.length)
    content.warnings.push("图片中未检测到文字，已仅保存视觉模板。 ");
  return {
    id: `imported-${crypto.randomUUID()}`,
    name: file.name.replace(/\.[^.]+$/, "") || "导入模板",
    sourceName: file.name,
    sourceType: type,
    createdAt: new Date().toISOString(),
    previewDataUrl: canvas.toDataURL("image/jpeg", 0.78),
    ...recognized,
    resume: lines.length ? content.resume : undefined,
    moduleOrder: lines.length ? content.moduleOrder : undefined,
    moduleNames: lines.length ? content.moduleNames : undefined,
    summaryTitle: lines.length ? content.summaryTitle : undefined,
    detectedFont: lines.length ? content.detectedFont : undefined,
    extractedText: content.extractedText,
    recognitionConfidence: content.confidence,
    recognitionWarnings: content.warnings,
    analysis: lines.length
      ? `${recognized.analysis}；已识别 ${content.extractedText.length} 个字符并映射为可编辑模块`
      : `${recognized.analysis}；未检测到文字，仅保存视觉模板`,
  };
}
