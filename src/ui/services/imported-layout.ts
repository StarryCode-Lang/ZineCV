import type {
  ImportedLayoutBox,
  ImportedLayoutPage,
  ImportedSourceLayout,
} from "../domain/imported-layout";

export type LayoutLine = {
  text: string;
  page?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fontSize?: number;
  fontName?: string;
  // 页宽只用于判断标题是否水平居中，必须与 x/width 同一尺度。
  pageWidth?: number;
};

export type LayoutPageSource = {
  canvas: HTMLCanvasElement;
  lines: LayoutLine[];
};

// 背景图上限：太大塞不进 localStorage，太小会在纸张上发虚。
const MAX_BACKGROUND_WIDTH = 1400;
const BACKGROUND_QUALITY = 0.78;

// 降采样只改分辨率，不改坐标系。
// pages[].width/height 与 boxes[].x/y/width/height 仍然是**原始栅格**尺寸，
// 而背景 dataURL 的自然像素尺寸已经变窄（PDF 约差 2%，Word 约差 12%）。
// 渲染侧把 <img> 拉伸回按原始栅格算出的页面矩形，这个系数会精确抵消，
// 所以降采样只损失清晰度，不会让补丁与背景错位。
// 但任何直接按背景像素取样/裁剪的代码（验收度量、取证脚本）必须先换算：
//   scale = 背景自然尺寸 / {page.width, page.height}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function colorDistance(a: number[], b: number[]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function toHex(color: number[]) {
  return `#${color
    .map((value) =>
      clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0"),
    )
    .join("")}`;
}

// 背景色取文本框四周的环，避开文字笔画；前景色取框内离背景最远的颜色。
// 顺带量出墨迹密度（离背景足够远的像素占比）——中文等宽字体无法靠行宽
// 区分粗细，墨迹密度是栅格上唯一可靠的黑体信号，见 buildSourceLayout。
function sampleBoxColors(
  canvas: HTMLCanvasElement,
  box: { x: number; y: number; width: number; height: number },
) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context)
    return {
      background: "#ffffff",
      color: "#111111",
      inkRatio: 0,
      strokeRun: 0,
    };
  const left = clamp(Math.floor(box.x), 0, canvas.width - 1);
  const top = clamp(Math.floor(box.y), 0, canvas.height - 1);
  const width = clamp(Math.ceil(box.width), 1, canvas.width - left);
  const height = clamp(Math.ceil(box.height), 1, canvas.height - top);
  const data = context.getImageData(left, top, width, height).data;
  const ring: number[][] = [];
  const corners: number[][] = [];
  const inner: number[][] = [];
  const cornerSize = 6;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index + 3] < 40) continue;
      const pixel = [data[index], data[index + 1], data[index + 2]];
      const inCorner =
        (x < cornerSize || x >= width - cornerSize) &&
        (y < cornerSize || y >= height - cornerSize);
      const isEdge = x <= 1 || y <= 1 || x >= width - 2 || y >= height - 2;
      if (inCorner) corners.push(pixel);
      else if (isEdge) ring.push(pixel);
      else inner.push(pixel);
    }
  }
  const pickMode = (pixels: number[][]) => {
    if (!pixels.length) return [255, 255, 255];
    const counts = new Map<string, { color: number[]; count: number }>();
    pixels.forEach((pixel) => {
      const bucket = pixel
        .map((value) => Math.round(value / 16) * 16)
        .join(",");
      const entry = counts.get(bucket);
      if (entry) entry.count += 1;
      else counts.set(bucket, { color: pixel, count: 1 });
    });
    const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    return best.color;
  };
  // 四角/边环的众数才是“这一行背后的纸色”；中位数容易被相邻图标/头像带偏。
  const background = pickMode(corners.length >= 12 ? corners : ring);
  let ink: number[] | null = null;
  let best = 0;
  let inkCount = 0;
  // 第二遍：以 background 为基准逐行扫墨迹，统计密度与笔画水平 run 长度。
  // run 触到框左右边界时丢弃（框截断的 run 不代表笔画粗细）。
  const runs: number[] = [];
  let runLength = 0;
  const flushRun = () => {
    if (runLength) runs.push(runLength);
    runLength = 0;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const isInk =
        data[index + 3] >= 40 &&
        colorDistance(
          [data[index], data[index + 1], data[index + 2]],
          background,
        ) > 60;
      if (isInk) {
        inkCount += 1;
        runLength += 1;
      } else {
        flushRun();
      }
    }
    flushRun();
  }
  inner.forEach((pixel) => {
    const distance = colorDistance(pixel, background);
    if (distance > best) {
      best = distance;
      ink = pixel;
    }
  });
  return {
    background: toHex(background),
    color: ink && best > 36 ? toHex(ink) : "#111111",
    inkRatio: inner.length ? inkCount / inner.length : 0,
    strokeRun: runs.length
      ? runs.reduce((sum, value) => sum + value, 0) / runs.length
      : 0,
  };
}

function encodeBackground(canvas: HTMLCanvasElement) {
  const scale = Math.min(1, MAX_BACKGROUND_WIDTH / canvas.width);
  if (scale >= 1) return canvas.toDataURL("image/jpeg", BACKGROUND_QUALITY);
  const scaled = document.createElement("canvas");
  scaled.width = Math.round(canvas.width * scale);
  scaled.height = Math.round(canvas.height * scale);
  const context = scaled.getContext("2d");
  if (!context) return canvas.toDataURL("image/jpeg", BACKGROUND_QUALITY);
  context.drawImage(canvas, 0, 0, scaled.width, scaled.height);
  return scaled.toDataURL("image/jpeg", BACKGROUND_QUALITY);
}

function guessFontFamily(fontName: string | undefined, text: string) {
  const value = (fontName ?? "").toLowerCase();
  if (/kai|楷/.test(value)) return '"楷体", KaiTi, serif';
  if (/fang|仿宋/.test(value)) return '"仿宋", FangSong, serif';
  if (/song|simsun|serif|宋/.test(value)) return '"宋体", SimSun, serif';
  // 无衬线栈必须带上中文黑体回退：pdf.js 认不出的内嵌字体一律报
  // "sans-serif"，经 layoutFontName 映射成 Arial；Arial 没有中文字形，
  // 不显式列出中文黑体时，补丁里的中文会落到浏览器默认字体，
  // 与源文件的现代黑体（思源黑体/苹方类）观感相差明显。
  if (/hei|yahei|黑|sans/.test(value))
    return '"Source Han Sans CN", "Noto Sans SC", "Microsoft YaHei", Arial, sans-serif';
  if (/times|georgia|garamond|palatino/.test(value))
    return '"Times New Roman", Georgia, serif';
  if (/arial|helvetica|calibri/.test(value))
    return "Arial, 'Source Han Sans CN', 'Noto Sans SC', 'Microsoft YaHei', sans-serif";
  return /[\u4e00-\u9fa5]/.test(text)
    ? '"宋体", SimSun, serif'
    : "Arial, Helvetica, sans-serif";
}

// 参考墨迹密度：同字体同字号下渲染 400/600 两份文本，量各自的墨迹占比。
// 源栅格与参考渲染出自同一条光栅化管线（抗锯齿特性一致），
// 所以“源密度更接近哪一份参考”就是可靠的字重判据——
// 笔画 run 长度阈值会被 Medium 字重与长横笔画骗过去（实测“张小可”误判 600）。
const referenceInkRatioCache = new Map<string, number>();
function referenceInkRatio(
  text: string,
  family: string,
  size: number,
  weight: string,
  color: string,
  background: string,
) {
  const key = [text, family, size, weight, color, background].join("|");
  const cached = referenceInkRatioCache.get(key);
  if (cached !== undefined) return cached;
  let ratio = -1;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (context) {
      context.font = `${weight} ${size}px ${family}`;
      const width = Math.max(4, Math.ceil(context.measureText(text).width) + 8);
      const height = Math.max(4, Math.ceil(size * 1.6));
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = background;
      context.fillRect(0, 0, width, height);
      context.fillStyle = color;
      context.font = `${weight} ${size}px ${family}`;
      context.textBaseline = "alphabetic";
      context.fillText(text, 4, size * 1.15);
      const data = context.getImageData(0, 0, width, height).data;
      let ink = 0;
      let total = 0;
      for (let index = 0; index < data.length; index += 4) {
        total += 1;
        if (
          Math.hypot(
            data[index] - 255,
            data[index + 1] - 255,
            data[index + 2] - 255,
          ) > 60
        )
          ink += 1;
      }
      ratio = total ? ink / total : -1;
    }
  } catch {
    ratio = -1;
  }
  referenceInkRatioCache.set(key, ratio);
  return ratio;
}

// 一行一个可编辑框：行内文字原样保留，坐标就是源文件的坐标。
// 未编辑的框不参与绘制，所以导入后看到的就是源文件本身。
export function buildSourceLayout(
  sources: LayoutPageSource[],
  options: { fontHint?: string; warnings?: string[] } = {},
): ImportedSourceLayout | undefined {
  const pages: ImportedLayoutPage[] = [];
  const boxes: ImportedLayoutBox[] = [];
  let extractedChars = 0;

  sources.forEach((source, pageIndex) => {
    const { canvas } = source;
    if (!canvas.width || !canvas.height) return;
    pages.push({
      width: canvas.width,
      height: canvas.height,
      background: encodeBackground(canvas),
    });
    source.lines.forEach((line, lineIndex) => {
      const text = line.text.replace(/\s+/g, " ").trim();
      if (!text) return;
      const fontSize = Math.max(
        6,
        line.fontSize ?? (line.height ? line.height * 0.82 : 12),
      );
      const width = Math.max(
        fontSize * 1.6,
        line.width ?? text.length * fontSize,
      );
      const height = Math.max(fontSize, line.height ?? fontSize * 1.3);
      const x = clamp(line.x ?? 0, 0, Math.max(0, canvas.width - 4));
      const y = clamp(line.y ?? 0, 0, Math.max(0, canvas.height - 4));
      const clippedWidth = Math.min(width, canvas.width - x);
      const clippedHeight = Math.min(height * 1.15, canvas.height - y);
      const colors = sampleBoxColors(canvas, {
        x,
        y,
        width: clippedWidth,
        height: clippedHeight,
      });
      const fontFamilyGuess = guessFontFamily(
        line.fontName ?? options.fontHint,
        text,
      );
      const refRegular = referenceInkRatio(
        text,
        fontFamilyGuess,
        fontSize,
        "400",
        colors.color,
        colors.background,
      );
      const refBold = referenceInkRatio(
        text,
        fontFamilyGuess,
        fontSize,
        "600",
        colors.color,
        colors.background,
      );
      // 字重 = 源墨迹密度与 400/600 参考密度最近匹配（相对比较对任何字体成立）。
      const fontWeightMatched =
        refRegular < 0 || refBold < 0
          ? "400"
          : Math.abs(colors.inkRatio - refRegular) <=
              Math.abs(colors.inkRatio - refBold)
            ? "400"
            : "600";
      boxes.push({
        id: `p${pageIndex + 1}-b${lineIndex + 1}`,
        page: pageIndex + 1,
        x: Number(x.toFixed(2)),
        y: Number(y.toFixed(2)),
        width: Number(clippedWidth.toFixed(2)),
        height: Number(clippedHeight.toFixed(2)),
        text,
        fontSize: Number(fontSize.toFixed(2)),
        lineHeight: Number((height * 1.05).toFixed(2)),
        fontFamily: fontFamilyGuess,
        // 中文字体是等宽_advance_：粗体与常规体的行宽几乎相同，行宽法失效。
        // 笔画水平 run 长度按字号归一后对框的松紧也不敏感，是栅格上
        // 唯一可靠的粗体信号；阈值由真实简历实测校准（正文 ≈0.06-0.08，
        // 粗体 ≈0.11+，单位：run px / 字号 px）。
        fontWeight: fontWeightMatched,
        fontStyle: "normal",
        color: colors.color,
        background: colors.background,
        align: "left",
      });
      extractedChars += text.length;
    });
  });

  if (!pages.length || !boxes.length) return undefined;
  return {
    version: 1,
    pages,
    boxes,
    extractedChars,
    warnings: options.warnings ?? [],
  };
}

// 版式层自检：文本框互相压盖说明坐标还原不可信，宁可退回内容识别。
//
// 语义（2026-10-30 改）：返回“被其它文本框严重覆盖的文本框占比”，0–1。
// 对每个文本框，计算它与其它文本框的重叠面积之和（不做并集）占自身面积的比例，
// 比例 > 60% 记为“被严重覆盖”。理由：文本框压在背景正文段上属于正常情况，
// 旧口径（重叠面积 / 总面积）会把这种正常压盖误判成不可信；
// 而坐标全部堆在页顶时，几乎每个框都会被别的框盖满，占比趋近 1，依旧显著大于 0.2。
export function layoutOverlapRatio(layout: ImportedSourceLayout) {
  const boxes = layout.boxes;
  if (boxes.length < 2) return 0;
  let severe = 0;
  boxes.forEach((box, index) => {
    const area = Math.max(1, box.width * box.height);
    let covered = 0;
    boxes.forEach((other, otherIndex) => {
      if (otherIndex === index || other.page !== box.page) return;
      const otherArea = Math.max(1, other.width * other.height);
      // 小标题落在大底板里会被算成 100% 覆盖，但那不是坐标堆在页顶。
      // 只统计尺寸相近的压盖；真正叠在一起的框面积接近，仍然会超阈值。
      if (otherArea / area > 4) return;
      const width = Math.max(
        0,
        Math.min(box.x + box.width, other.x + other.width) -
          Math.max(box.x, other.x),
      );
      const height = Math.max(
        0,
        Math.min(box.y + box.height, other.y + other.height) -
          Math.max(box.y, other.y),
      );
      covered += width * height;
    });
    if (covered / area > 0.6) severe += 1;
  });
  return severe / boxes.length;
}

// Word：docx-preview 已经把版式渲染成 DOM，直接按段落取矩形，
// 背景另用同一棵 DOM 截图，两者天然对齐。
export type DomLayoutSource = {
  page: HTMLElement;
  background: HTMLCanvasElement;
};

const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote";

// 只保留最内层文本块：外层容器（表格单元、div）不再单独出框，
// 否则父子框互相压盖会把重叠率算爆。
function isLeafBlock(element: Element) {
  return !element.querySelector(BLOCK_SELECTOR);
}

// 文本块里真正带字的那一层：字号/字色要看它，不能看外层容器。
function textCarrier(element: Element) {
  let current: Element = element;
  for (;;) {
    const next = Array.from(current.children).find(
      (child) => (child.textContent || "").trim().length > 0,
    );
    if (!next) return current;
    current = next;
  }
}

function collectPageBoxes(
  page: HTMLElement,
  background: HTMLCanvasElement,
  pageIndex: number,
) {
  const pageRect = page.getBoundingClientRect();
  if (!pageRect.width || !pageRect.height) return [];
  const scale = background.width / pageRect.width;
  const boxes: ImportedLayoutBox[] = [];
  const blocks = Array.from(page.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  const seen = new Set<string>();
  blocks.forEach((element, index) => {
    if (!isLeafBlock(element)) return;
    // textContent 比 innerText 稳：被裁剪/变换的文本框里 innerText 会悄悄丢字。
    const text = (element.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) return;
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${text.slice(0, 12)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const style = getComputedStyle(element);
    const carrierStyle = getComputedStyle(textCarrier(element));
    const fontSize = Number.parseFloat(carrierStyle.fontSize) || 12;
    const x = (rect.left - pageRect.left) * scale;
    const y = (rect.top - pageRect.top) * scale;
    const width = rect.width * scale;
    const height = rect.height * scale;
    const colors = sampleBoxColors(background, { x, y, width, height });
    // 字色必须看“真正带字的那一层”（run 的 <span>）：
    // 块级元素（<p>）的颜色是从容器继承来的默认值 —— docx-preview 的
    // .docx-wrapper{color:black}，我们补画的文本框 <p> 也没写颜色。
    // 直接读块级颜色会把源 run 的颜色丢掉，补丁文字变黑，和原简历正文色对不上。
    const runColor =
      carrierStyle.color && carrierStyle.color !== "rgba(0, 0, 0, 0)"
        ? carrierStyle.color
        : style.color && style.color !== "rgba(0, 0, 0, 0)"
          ? style.color
          : colors.color;
    boxes.push({
      id: `p${pageIndex + 1}-b${index + 1}`,
      page: pageIndex + 1,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      width: Number(width.toFixed(2)),
      height: Number(height.toFixed(2)),
      text,
      fontSize: Number((fontSize * scale).toFixed(2)),
      lineHeight: Number(
        (
          (Number.parseFloat(style.lineHeight) || fontSize * 1.4) * scale
        ).toFixed(2),
      ),
      fontFamily: style.fontFamily || '"宋体", SimSun, serif',
      fontWeight: style.fontWeight || "400",
      fontStyle: style.fontStyle || "normal",
      color: runColor,
      background: colors.background,
      align:
        style.textAlign === "center"
          ? "center"
          : style.textAlign === "right"
            ? "right"
            : "left",
    });
  });
  return boxes;
}

// 识别输入用的 DOM 文本行：坐标是相对 page 元素的 CSS 像素，
// pageWidth 用同一口径（page.getBoundingClientRect().width），两者同尺度。
export function collectDomTextLines(
  sources: { page: HTMLElement }[],
): LayoutLine[] {
  const lines: LayoutLine[] = [];
  sources.forEach((source, pageIndex) => {
    const pageRect = source.page.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) return;
    const blocks = Array.from(
      source.page.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
    );
    const pageLines: LayoutLine[] = [];
    blocks.forEach((element) => {
      if (!isLeafBlock(element)) return;
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      const rect = element.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      const carrierStyle = getComputedStyle(textCarrier(element));
      pageLines.push({
        text,
        page: pageIndex + 1,
        x: Number((rect.left - pageRect.left).toFixed(2)),
        y: Number((rect.top - pageRect.top).toFixed(2)),
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
        fontSize: Number.parseFloat(carrierStyle.fontSize) || 12,
        fontName: carrierStyle.fontFamily,
        pageWidth: Number(pageRect.width.toFixed(2)),
      });
    });
    // Word 的 XML 顺序是锚点顺序，不是阅读顺序；
    // 识别层靠“章节标题之前的行”找姓名，所以这里必须按纸面位置排序。
    const band = (value: number) => Math.round(value / 16);
    pageLines.sort(
      (a, b) => band(a.y ?? 0) - band(b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0),
    );
    lines.push(...pageLines);
  });
  return lines;
}

// 多页 Word：docx-preview 每页渲染一个 section.docx，
// 背景栅格与文本框坐标必须同页对齐（各自的 pageRect 与 scale）。
export function collectDomLayouts(
  sources: DomLayoutSource[],
  warnings: string[] = [],
): ImportedSourceLayout | undefined {
  const pages: ImportedLayoutPage[] = [];
  const boxes: ImportedLayoutBox[] = [];
  sources.forEach((source) => {
    const { background } = source;
    if (!background.width || !background.height) return;
    const pageBoxes = collectPageBoxes(source.page, background, pages.length);
    if (!pageBoxes.length) return;
    pages.push({
      width: background.width,
      height: background.height,
      background: encodeBackground(background),
    });
    boxes.push(...pageBoxes);
  });
  if (!pages.length || !boxes.length) return undefined;
  const extractedChars = boxes.reduce(
    (total, box) => total + box.text.length,
    0,
  );
  return {
    version: 1,
    pages,
    boxes,
    extractedChars,
    warnings,
  };
}
