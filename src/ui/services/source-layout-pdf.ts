import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ImportedSourceLayout } from "../domain/imported-layout";
import { buildSourceLayout, type LayoutLine } from "./imported-layout";
import { IMPORT_LIMITS } from "./import-limits";
import { localPdfJsResourceOptions } from "./pdfjs-resources";
// 行框的墨迹度量（相对 em 的比例）。
//
// 为什么不用 pdf.js 的 styles[font].ascent/descent 直接当行框：
// 那两个值是**字体盒**（上伸线 → 下伸线），不是字形墨迹范围。
// 字体盒比墨迹盒高 0.2~0.5em（T1 实测：正文字体 1.024/-0.4 对应墨迹 0.744/0.232），
// 拿它当行框，同一段的相邻两行框会**互相重叠**（行距 1.217em < 字体盒 1.424em）：
// 覆盖层不是啃掉下一行的字，就是切掉本行的降部，两个口径都差 1~3 源栅格 px。
//
// 所以行框取**实测墨迹带**（在页面栅格上按行扫描），
// 字体度量只用来给测量结果定上界；扫不出来时用下面的经验值兜底：
// 常见字体的 cap/ascender 高度约 0.75em、降部约 0.25em（与 T1 实测一致）。
const FALLBACK_INK_ASCENT = 0.75;
const FALLBACK_INK_DESCENT = 0.25;

// pdf.js 的字体度量。返回 null 表示 styles 里没有这一项（或数值异常）。
function readFontMetrics(
  styles: Record<string, { ascent?: number; descent?: number }>,
  fontName: string,
) {
  const style = styles[fontName];
  const ascent = style?.ascent;
  const descent = style?.descent;
  if (
    typeof ascent !== "number" ||
    typeof descent !== "number" ||
    !Number.isFinite(ascent) ||
    !Number.isFinite(descent) ||
    ascent <= 0 ||
    ascent >= 2 ||
    descent >= 0 ||
    descent <= -1
  )
    return null;
  return { ascent, descent };
}

// 一行文字在页面栅格上的真实墨迹带（源栅格 px）。
// 找不到可靠的连续墨迹段时返回 null，由调用方兜底。
function measureInkBand(
  canvas: HTMLCanvasElement,
  x0: number,
  x1: number,
  baseline: number,
  fontSize: number,
) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(canvas.width, Math.ceil(x1));
  const top = Math.max(0, Math.floor(baseline - 1.35 * fontSize));
  const bottom = Math.min(canvas.height, Math.ceil(baseline + 0.85 * fontSize));
  const width = right - left;
  const height = bottom - top;
  if (width < 4 || height < 4) return null;
  const data = context.getImageData(left, top, width, height).data;
  // 底色取众数：白底简历的正文区几乎全是纸色。
  const buckets = new Map<string, number>();
  for (let index = 0; index < data.length; index += 4) {
    const key = `${Math.round(data[index] / 16) * 16},${
      Math.round(data[index + 1] / 16) * 16
    },${Math.round(data[index + 2] / 16) * 16}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let modal = [255, 255, 255];
  let best = -1;
  for (const [key, count] of buckets) {
    if (count > best) {
      best = count;
      modal = key.split(",").map(Number);
    }
  }
  // 逐行是否有墨迹。
  const inked: boolean[] = [];
  for (let y = 0; y < height; y += 1) {
    let ink = false;
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (
        Math.max(
          Math.abs(data[index] - modal[0]),
          Math.abs(data[index + 1] - modal[1]),
          Math.abs(data[index + 2] - modal[2]),
        ) > 40
      ) {
        ink = true;
        break;
      }
    }
    inked.push(ink);
  }
  // 锚点：最靠近基线的那一行有墨迹的像素。
  const baselineRow = baseline - top;
  let anchor = -1;
  for (let offset = 0; offset <= 2; offset += 1) {
    for (const row of [baselineRow - offset, baselineRow + offset]) {
      if (row >= 0 && row < height && inked[row]) {
        anchor = row;
        break;
      }
    }
    if (anchor >= 0) break;
  }
  if (anchor < 0) return null;
  // 贴着锚点的连续墨迹段（允许 1px 的抗锯齿断层）。
  const walk = (step: number) => {
    let edge = anchor;
    let gap = 0;
    for (let row = anchor + step; row >= 0 && row < height; row += step) {
      if (inked[row]) {
        edge = row;
        gap = 0;
        continue;
      }
      gap += 1;
      if (gap > 1) break;
    }
    return edge;
  };
  const inkTop = top + walk(-1);
  const inkBottom = top + walk(1);
  if (inkBottom - inkTop < fontSize * 0.25) return null;
  return { top: inkTop, bottom: inkBottom };
}

// 行框横向墨迹范围：与 measureInkBand 同思路，逐列判定是否有墨迹，
// 返回 [最左墨迹列, 最右墨迹列]（绝对栅格 px）。行尾不可见的空白文本项
// （pdf.js 偶发的大 width 占位）会把 maxX 撑到页外，导致补丁横向凸出。
function measureInkColumns(
  canvas: HTMLCanvasElement,
  x0: number,
  x1: number,
  baseline: number,
  fontSize: number,
) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(canvas.width, Math.ceil(x1));
  const top = Math.max(0, Math.floor(baseline - 1.35 * fontSize));
  const bottom = Math.min(canvas.height, Math.ceil(baseline + 0.85 * fontSize));
  const width = right - left;
  const height = bottom - top;
  if (width < 4 || height < 4) return null;
  const data = context.getImageData(left, top, width, height).data;
  const buckets = new Map<string, number>();
  for (let index = 0; index < data.length; index += 4) {
    const key = `${Math.round(data[index] / 16) * 16},${
      Math.round(data[index + 1] / 16) * 16
    },${Math.round(data[index + 2] / 16) * 16}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let modal = [255, 255, 255];
  let best = -1;
  for (const [key, count] of buckets) {
    if (count > best) {
      best = count;
      modal = key.split(",").map(Number);
    }
  }
  const inked: boolean[] = [];
  for (let x = 0; x < width; x += 1) {
    let ink = false;
    for (let y = 0; y < height; y += 1) {
      const index = (y * width + x) * 4;
      if (
        Math.max(
          Math.abs(data[index] - modal[0]),
          Math.abs(data[index + 1] - modal[1]),
          Math.abs(data[index + 2] - modal[2]),
        ) > 40
      ) {
        ink = true;
        break;
      }
    }
    inked.push(ink);
  }
  let minX = -1;
  let maxX = -1;
  for (let x = 0; x < width; x += 1) {
    if (inked[x]) {
      if (minX < 0) minX = x;
      maxX = x;
    }
  }
  if (minX < 0) return null;
  return { left: left + minX, right: left + maxX + 1 };
}

// PDF 字体族 → 版式层（补丁）用的字体名。
//
// pdf.js 认不出名字的字体一律报 "sans-serif"/"serif"。
// guessFontFamily 里 "sans-serif" 会命中 "serif" 分支落到宋体 —— 宋体是中文
// 衬线体，拉丁字宽比无衬线体宽 10% 以上。补丁拿它渲染会同时坏两件事：
//   1) 触发 fitFontSize 的"超宽就缩字号"，新字比原字小一截（T1 实测缩到 90%）；
//   2) 文字换行，第二行直接压到下一行上（框外差异 675~1628px）。
// 所以把通用族名显式映射到对应的拉丁字体栈。
// 只改**版式层补丁**的字体名；识别用的 fontName 保持原样，
// 模板的字体识别结果（resumeLayout.font）不受影响。
function layoutFontName(fontFamily: string | undefined, fallback: string) {
  const value = (fontFamily ?? "").toLowerCase().trim();
  if (value === "sans-serif" || value === "sans serif") return "Arial";
  if (value === "serif") return "Times New Roman";
  if (value === "monospace" || value === "courier") return "Courier New";
  return fallback;
}

// PDF 行框的字号是**源栅格像素**（PDF 的 pt 字号 × 渲染倍率），
// buildSourceLayout 里"字号 ≥ 18 → 600"的字重启发式对 PDF 完全失效：
// PDF 里几乎每一行的字号都 ≥ 18px，补丁会把源文件里的常规体统统渲染成粗体。
// 粗体的字宽比常规体宽 15~25%，于是 fitFontSize 的"超宽就缩字号"
// 把新字缩掉 10~20% —— 新旧两行的字号就对不上了
// （T1 实测：标题缩到 90%，"Seoul, S.Korea" 缩到 78%）。
//
// 这里按**行宽**反推字重：量出替代字体在 400/600 下的文本宽度，
// 取更接近源文件行宽的那个。源文件本身的字重不可知，但行宽可量。
function inferBoxFontWeights(layout: ImportedSourceLayout) {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  const cache = new Map<string, number>();
  const measure = (
    text: string,
    family: string,
    size: number,
    weight: string,
  ) => {
    const key = `${weight}|${size}|${family}|${text}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    context.font = `${weight} ${size}px ${family}`;
    const width = context.measureText(text).width;
    cache.set(key, width);
    return width;
  };
  layout.boxes.forEach((box) => {
    if (!box.text || !box.width || !box.fontSize) return;
    // 中文是等宽 advance 字体：粗体与常规体的 measureText 宽度几乎相同，
    // 行宽启发式对中文必然打平 → 永远落在 "400"。中文行的字重已由
    // buildSourceLayout 按栅格墨迹密度判定，这里不要覆盖它。
    if (/[\u4e00-\u9fa5]/.test(box.text)) return;
    const regular = measure(box.text, box.fontFamily, box.fontSize, "400");
    const bold = measure(box.text, box.fontFamily, box.fontSize, "600");
    if (!regular || !bold) return;
    const distance = Math.abs(regular - box.width) - Math.abs(bold - box.width);
    box.fontWeight = distance <= 0 ? "400" : "600";
  });
}

/** Extract source-page backgrounds and editable text without changing the
 * existing OCR/structured import path. A page is processed and released before
 * the next page so a long document does not retain every full-size canvas. */
export async function extractPdfSourceLayout(file: File, signal?: AbortSignal): Promise<ImportedSourceLayout | undefined> {
  if (file.size > IMPORT_LIMITS.fileBytes) throw new Error("文件不能超过 18MB");
  const ensureActive = () => { if (signal?.aborted) throw new DOMException("导入已取消", "AbortError"); };
  ensureActive();
  const pdfjs = await import("pdfjs-dist");
  ensureActive();
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer(), ...localPdfJsResourceOptions(window.location.href) });
  let renderTask: { cancel(): void } | undefined;
  let destroyPromise: Promise<void> | undefined;
  const destroy = () => destroyPromise ??= loadingTask.destroy();
  const abort = () => { try { renderTask?.cancel(); } catch { /* already finished */ } void destroy(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    ensureActive();
    const pdf = await loadingTask.promise;
    ensureActive();
    if (pdf.numPages < 1 || pdf.numPages > IMPORT_LIMITS.pages) throw new Error("PDF 页数必须在 1–50 页以内");
    const layout: ImportedSourceLayout = { version: 1, pages: [], boxes: [], extractedChars: 0, warnings: [] };
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      ensureActive();
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2.4, Math.sqrt(20_000_000 / Math.max(1, base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      try {
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建 PDF 预览");
        const task = page.render({ canvas, canvasContext: context, viewport });
        renderTask = task;
        await task.promise;
        renderTask = undefined;
        ensureActive();
        const content = await page.getTextContent();
        ensureActive();
        type Item = { text: string; x: number; width: number; emTop: number; baseline: number;
          fontSize: number; fontName: string; fontAscent: number; fontDescent: number };
        const items: Item[] = [];
        for (const item of content.items) {
          if (!("str" in item) || !item.str.trim()) continue;
          const fontSize = Math.hypot(item.transform[0], item.transform[1]);
          const metrics = readFontMetrics(content.styles, item.fontName);
          const [x, baseline] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
          items.push({ text: item.str, x, width: item.width * scale,
            emTop: baseline - (item.height || fontSize) * scale, baseline,
            fontSize: fontSize * scale, fontName: content.styles[item.fontName]?.fontFamily ?? item.fontName,
            fontAscent: (metrics?.ascent ?? FALLBACK_INK_ASCENT) * fontSize * scale,
            fontDescent: (metrics ? -metrics.descent : FALLBACK_INK_DESCENT) * fontSize * scale });
        }
        const pageWidth = page.view[2] - page.view[0], pageHeight = page.view[3] - page.view[1];
        const body = items.filter((item) => item.emTop / scale < pageHeight * 0.7);
        const twoColumns = body.filter((item) => item.x / scale < pageWidth * 0.31).length >= 12 &&
          body.filter((item) => item.x / scale >= pageWidth * 0.34 && item.x / scale < pageWidth * 0.55).length >= 12;
        const groups = twoColumns ? [items.filter((item) => item.emTop / scale >= pageHeight * 0.7),
          body.filter((item) => item.x / scale < pageWidth * 0.34),
          body.filter((item) => item.x / scale >= pageWidth * 0.34)] : [items];
        const lines: LayoutLine[] = [], baselines: number[] = [];
        for (const group of groups) {
          const rows = new Map<number, Item[]>();
          for (const item of group) { const y = Math.round(item.emTop / 3) * 3; rows.set(y, [...(rows.get(y) ?? []), item]); }
          for (const [, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
            const ordered = row.sort((a, b) => a.x - b.x);
            let minX = Math.min(...ordered.map((item) => item.x));
            let maxX = Math.max(...ordered.map((item) => item.x + item.width));
            const main = ordered.reduce((best, item) => item.fontSize > best.fontSize ? item : best);
            const band = measureInkBand(canvas, minX, maxX, main.baseline, main.fontSize);
            const columns = measureInkColumns(canvas, minX, maxX, main.baseline, main.fontSize);
            if (columns) { minX = Math.max(minX, columns.left - 1); maxX = Math.min(maxX, columns.right + 1); }
            const ascent = band ? main.baseline - band.top : 0, descent = band ? band.bottom - main.baseline : 0;
            const usable = band !== null && ascent <= main.fontAscent + 1 && descent <= main.fontDescent + 1;
            const inkAscent = usable ? ascent : FALLBACK_INK_ASCENT * main.fontSize;
            const inkDescent = usable ? descent : FALLBACK_INK_DESCENT * main.fontSize;
            lines.push({ text: ordered.map((item) => item.text).join(" "), page: pageNumber, x: minX,
              y: main.baseline - inkAscent, width: Math.max(1, maxX - minX), height: Math.max(1, inkAscent + inkDescent),
              fontSize: main.fontSize, fontName: layoutFontName(ordered[0].fontName, ordered[0].fontName), pageWidth: viewport.width });
            baselines.push(main.baseline);
          }
        }
        const result = buildSourceLayout([{ canvas, lines }]);
        if (!result) {
          const thumb = document.createElement("canvas");
          const factor = Math.min(1, 1400 / canvas.width);
          thumb.width = Math.max(1, Math.round(canvas.width * factor)); thumb.height = Math.max(1, Math.round(canvas.height * factor));
          thumb.getContext("2d")?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
          layout.pages.push({ width: canvas.width, height: canvas.height, background: thumb.toDataURL("image/jpeg", 0.78) });
          layout.warnings.push(`第 ${pageNumber} 页没有可编辑文字层，保留原页面。`);
        } else {
          layout.pages.push(result.pages[0]);
          result.boxes.forEach((box, index) => {
            box.page = pageNumber; box.id = `p${pageNumber}-b${index + 1}`;
            (box as typeof box & { baseline?: number }).baseline = baselines[index];
            layout.boxes.push(box);
          });
          layout.extractedChars += result.extractedChars;
        }
      } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
    }
    if (!layout.boxes.length) return undefined;
    inferBoxFontWeights(layout);
    return layout;
  } catch (error) {
    ensureActive();
    throw error;
  } finally { signal?.removeEventListener("abort", abort); await destroy(); }
}

