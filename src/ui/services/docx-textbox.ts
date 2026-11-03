// 把 Word 文本框（w:txbxContent）按原坐标画回 docx-preview 渲染出来的页面上。
//
// docx-preview 把浮动文本框渲染成 <svg><image><foreignObject>：
// foreignObject 里的文字既不能被 html2canvas 光栅化（截图只会得到一张空白纸），
// 也没法按坐标编辑，所以这里按 OOXML 坐标把文本框改画成真正的 HTML 文本框，
// 背景快照负责承载底图，改字时只重画被改过的那一个框。
type RunStyle = {
  bold: boolean;
  italic: boolean;
  color: string;
  sizePx: number;
  fontFamily: string;
};

const EMU_PER_PX = 9525;
const TWIPS_PER_PX = 15;

function local(element: Element | null) {
  return element?.localName ?? "";
}

function childrenOf(element: Element, name: string) {
  return Array.from(element.children).filter((child) => local(child) === name);
}

function firstOf(
  element: Element | null | undefined,
  ...names: string[]
): Element | null {
  if (!element) return null;
  for (const name of names) {
    const hit = Array.from(element.children).find(
      (child) => local(child) === name,
    );
    if (hit) return hit;
  }
  return null;
}

function descendants(root: Element, name: string) {
  return Array.from(root.getElementsByTagName("*")).filter(
    (element) => local(element) === name,
  );
}

function findAncestor(element: Element, names: string[]) {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (names.includes(local(node))) return node;
  }
  return null;
}

// VML 备用图形（w:pict/v:rect）没有 wp:anchor，只在 style 里写位置。
function findVmlShape(element: Element) {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = node.getAttribute("style") ?? "";
    if (/position\s*:\s*absolute/i.test(style) && /left\s*:/.test(style))
      return node;
  }
  return null;
}

function vmlLength(style: string, name: string) {
  const match = style.match(
    new RegExp(`${name}\\s*:\\s*(-?[\\d.]+)(pt|px|mm|cm|in)?`, "i"),
  );
  if (!match) return null;
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  if (unit === "px") return value;
  if (unit === "pt") return value * (96 / 72);
  if (unit === "mm") return value * (96 / 25.4);
  if (unit === "cm") return value * (96 / 2.54);
  if (unit === "in") return value * 96;
  // 没有单位的数值是 Word 写 VML 时的 EMU（1pt = 12700 EMU），按像素当会画成巨块。
  return (value / 12700) * (96 / 72);
}

const VML_NS = "urn:schemas-microsoft-com:vml";
const VML_SHAPE_NAMES = ["rect", "shape", "roundrect", "oval"];

// VML 形状的填充色（只认十六进制色；颜色名不认，免得画出错色块）。
function vmlFillColor(element: Element) {
  if ((element.getAttribute("filled") ?? "").toLowerCase() === "f") return "";
  const childFill =
    descendants(element, "fill")[0]?.getAttribute("color") ?? "";
  const value = (childFill || element.getAttribute("fillcolor") || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  if (/^#[0-9a-fA-F]{3}$/.test(value))
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  return "";
}

/*
 * VML 纯色形状（v:rect / v:shape / v:roundrect / v:oval）。
 *
 * WPS 模板把左栏底板、标题色块做成 VML 形状；docx-preview 画成 <svg>，
 * 而 html2canvas 光栅化 svg 画不出来 —— 压在底板上的白字就落在白底上，
 * 导入后整行看不见（实测 T4 的 8 个白字框在纸面上没有任何墨迹）。
 * 这里按与浮动文本框同一套坐标换算，把纯色形状画成普通 div，文字才有底可依。
 */
function vmlFillShapes(
  documentRoot: Document,
  geometry: {
    margins: { left: number; top: number };
    width: number;
    height: number;
  },
) {
  const shapes: {
    left: number;
    marginTop: number;
    pageRelativeV: boolean;
    width: number;
    height: number;
    color: string;
    host: Element | null;
  }[] = [];
  VML_SHAPE_NAMES.forEach((name) => {
    descendants(documentRoot.documentElement, name).forEach((element) => {
      if (element.namespaceURI !== VML_NS) return;
      const color = vmlFillColor(element);
      if (!color) return;
      const style = element.getAttribute("style") ?? "";
      const width = vmlLength(style, "width") ?? 0;
      const height = vmlLength(style, "height") ?? 0;
      if (width < 4 || height < 4) return;
      // 尺寸明显超出页面的形状不是底板（多半是坐标没换算对的容器），跳过。
      if (width > geometry.width * 1.5 || height > geometry.height * 1.5)
        return;
      const pageRelativeH = /mso-position-horizontal-relative\s*:\s*page/i.test(
        style,
      );
      const pageRelativeV = /mso-position-vertical-relative\s*:\s*page/i.test(
        style,
      );
      // 只画“页面级”的底板：坐标相对页面的纯色块（左栏底板、标题色条）。
      // 相对锚点段落的形状位置换算不可靠，画出来反而错位。
      if (!pageRelativeH && !pageRelativeV) return;
      const marginLeft = vmlLength(style, "margin-left") ?? 0;
      const marginTop = vmlLength(style, "margin-top") ?? 0;
      const left = pageRelativeH
        ? marginLeft
        : geometry.margins.left + marginLeft + (vmlLength(style, "left") ?? 0);
      shapes.push({
        left,
        marginTop,
        pageRelativeV,
        width,
        height,
        color,
        host: findAncestor(element, ["p"]),
      });
    });
  });
  return shapes;
}

function numberAttr(element: Element | null, name: string) {
  const value = element?.getAttribute(name);
  return value ? Number(value) : null;
}

// 归一化文本：去空白、全角折半角、去标点。
// 序列对齐与文本框配对都靠它，避免 “／／” 与 “//”、全角空格之类的差异错配。
export function normalizeDocxText(value: string) {
  return value
    .replace(/[\s\u3000]+/g, "")
    .replace(/[\uff01-\uff5e]/g, (char) =>
      String.fromCharCode(char.charCodeAt(0) - 0xfee0),
    )
    .replace(/[\u3000-\u303f\uff00-\uffef\u2010-\u203a\u00a1-\u00ff]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

// 段落自身文字：排除 txbxContent（文本框）里的字。
function ownXmlParagraphText(paragraph: Element) {
  const parts: string[] = [];
  const walk = (node: Element) => {
    Array.from(node.children).forEach((child) => {
      const name = local(child);
      if (name === "txbxContent") return;
      if (name === "t") {
        parts.push(child.textContent ?? "");
        return;
      }
      if (name === "instrText") return;
      walk(child);
    });
  };
  walk(paragraph);
  return parts.join("");
}

// 渲染节点自身文字：排除 svg/foreignObject（docx-preview 的文本框）与我们补画的文本框。
function ownRenderedText(element: Element) {
  const clone = element.cloneNode(true) as Element;
  clone
    .querySelectorAll("svg, foreignObject, [data-docx-textbox]")
    .forEach((node) => node.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

function parseRunStyle(rPr: Element | null, inheritedColor = ""): RunStyle {
  const fonts = firstOf(rPr, "rFonts");
  const size = numberAttr(firstOf(rPr, "sz"), "w:val");
  const colorVal = firstOf(rPr, "color")?.getAttribute("w:val") ?? "";
  return {
    bold:
      Boolean(firstOf(rPr, "b")) &&
      firstOf(rPr, "b")?.getAttribute("w:val") !== "0",
    italic:
      Boolean(firstOf(rPr, "i")) &&
      firstOf(rPr, "i")?.getAttribute("w:val") !== "0",
    color: /^[0-9a-fA-F]{6}$/.test(colorVal)
      ? `#${colorVal}`
      : inheritedColor || "#222222",
    sizePx: size ? (size * 2) / 3 : 14,
    fontFamily:
      fonts?.getAttribute("w:eastAsia") ||
      fonts?.getAttribute("w:ascii") ||
      '"宋体", SimSun, serif',
  };
}

// run 里的字色（<w:rPr><w:color w:val="..."/>）。
function readRunColor(rPr: Element | null) {
  const value = firstOf(rPr, "color")?.getAttribute("w:val") ?? "";
  return /^[0-9a-fA-F]{6}$/.test(value) ? `#${value}` : "";
}

// WPS 偶尔把段落颜色直接挂在 <w:p> 下（不在 rPr 里），白字就是这么写的。
function readParagraphColor(paragraph: Element) {
  const color = Array.from(paragraph.children).find(
    (child) => local(child) === "color",
  );
  const value = color?.getAttribute("w:val") ?? "";
  return /^[0-9a-fA-F]{6}$/.test(value) ? `#${value}` : "";
}

function paragraphHtml(paragraph: Element) {
  const pPr = firstOf(paragraph, "pPr");
  const alignVal = firstOf(pPr, "jc")?.getAttribute("w:val") ?? "";
  const align =
    alignVal === "center" ? "center" : alignVal === "right" ? "right" : "left";
  // 段落级颜色（pPr/rPr 或直接挂在 w:p 下）作为 run 的兜底：
  // 底板上的白字只在段落上标了色，run 自己没有颜色，
  // 不继承就会把白字兜底成深灰（深蓝底板上变成深灰，也看不见）。
  const paragraphColor =
    readRunColor(firstOf(pPr, "rPr")) || readParagraphColor(paragraph);
  const parts: string[] = [];
  Array.from(paragraph.children).forEach((child) => {
    if (local(child) === "r") {
      const style = parseRunStyle(firstOf(child, "rPr"), paragraphColor);
      const fontFamily = style.fontFamily.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      Array.from(child.children).forEach((piece) => {
        if (local(piece) === "t") {
          const text = (piece.textContent ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
          if (!text) return;
          parts.push(
            `<span style="font-size:${style.sizePx.toFixed(2)}px;color:${style.color};font-weight:${style.bold ? 700 : 400};font-style:${style.italic ? "italic" : "normal"};font-family:${fontFamily}">${text}</span>`,
          );
        } else if (local(piece) === "br") {
          parts.push("<br/>");
        }
      });
    }
  });
  // 套了 hyperlink/ins/smartTag 等包装层的段落：按整段兜底，不能把字丢掉。
  if (!parts.length) {
    const raw = (paragraph.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return "";
    parts.push(
      raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    );
  }
  if (!parts.length) return "";
  return `<p style="margin:0;text-align:${align};line-height:1.25;white-space:pre-wrap">${parts.join("")}</p>`;
}

function resolveOffset(
  anchor: Element,
  axis: "H" | "V",
  pageSize: { width: number; height: number },
  margins: { left: number; top: number },
  anchorTop = 0,
  anchorLeft = 0,
) {
  const node = firstOf(anchor, `position${axis}`);
  if (!node) return 0;
  const relative = node.getAttribute("relativeFrom") ?? "page";
  const offsetEl = firstOf(node, "posOffset");
  const offsetPx = offsetEl
    ? Number((offsetEl.textContent ?? "0").trim()) / EMU_PER_PX
    : 0;
  const alignEl = firstOf(node, "align");
  const align = alignEl?.textContent?.trim() ?? "";
  const extent = firstOf(anchor, "extent");
  const sizePx =
    axis === "H"
      ? (numberAttr(extent, "cx") ?? 0) / EMU_PER_PX
      : (numberAttr(extent, "cy") ?? 0) / EMU_PER_PX;
  if (align) {
    const span = axis === "H" ? pageSize.width : pageSize.height;
    if (align === "center") return (span - sizePx) / 2;
    if (align === "right" || align === "bottom") return span - sizePx;
    return 0;
  }
  if (relative === "page") return offsetPx;
  if (axis === "V" && ["paragraph", "line", "text"].includes(relative))
    return anchorTop + offsetPx;
  if (axis === "H" && relative === "paragraph") return anchorLeft + offsetPx;
  const base = axis === "H" ? margins.left : margins.top;
  // margin / column：从页边距起算，与 Word 首栏位置一致。
  return base + offsetPx;
}

function readSectionGeometry(documentRoot: Document) {
  const sectPr = descendants(documentRoot.documentElement, "sectPr")[0];
  const pgSz = firstOf(sectPr, "pgSz");
  const pgMar = firstOf(sectPr, "pgMar");
  return {
    width: (numberAttr(pgSz, "w:w") ?? 794 * TWIPS_PER_PX) / TWIPS_PER_PX,
    height: (numberAttr(pgSz, "w:h") ?? 1123 * TWIPS_PER_PX) / TWIPS_PER_PX,
    margins: {
      left: (numberAttr(pgMar, "w:left") ?? 1134) / TWIPS_PER_PX,
      top: (numberAttr(pgMar, "w:top") ?? 1134) / TWIPS_PER_PX,
    },
  };
}

// ── 序列对齐（XML 正文段落 ↔ 渲染段落） ────────────────────────────────
//
// 下标硬配在表格/双栏版式里必然错位（表格单元格里也是段落）。
// 这里用归一化文本做最长公共子序列（LCS）对齐，得到 XML 段落 → 渲染元素的映射；
// 对不上的段落按前后命中点线性插值估算顶边。

function lcsPairs(left: string[], right: string[]) {
  const n = left.length;
  const m = right.length;
  if (!n || !m) return [] as [number, number][];
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        left[i] === right[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

type RenderedParagraph = {
  element: HTMLElement;
  text: string;
  top: number;
  left: number;
};

// 渲染页里的“正文段落”：排除 foreignObject 里的文本框内容、隐藏元素和我们补画的文本框。
function renderedParagraphs(page: HTMLElement, pageRect: DOMRect) {
  return Array.from(page.querySelectorAll<HTMLElement>("p"))
    .filter((element) => {
      if (element.closest("foreignObject")) return false;
      if (element.closest("[data-docx-textbox]")) return false;
      if (getComputedStyle(element).display === "none") return false;
      const rect = element.getBoundingClientRect();
      return rect.width >= 1 && rect.height >= 1;
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        element,
        text: ownRenderedText(element),
        top: rect.top - pageRect.top,
        left: rect.left - pageRect.left,
      } satisfies RenderedParagraph;
    });
}

// XML 正文段落（排除 txbxContent 里的段落；表格单元格的段落同样算正文段落）。
function bodyParagraphs(documentRoot: Document) {
  return descendants(documentRoot.documentElement, "p").filter(
    (paragraph) => !findAncestor(paragraph, ["txbxContent"]),
  );
}

// 与渲染共用 OOXML 正文，避免再引入一套 DOCX → HTML 解析器。
export function extractDocxParagraphs(documentXml: string) {
  const root = new DOMParser().parseFromString(documentXml, "application/xml");
  if (root.querySelector("parsererror")) return [];
  return descendants(root.documentElement, "p")
    .filter((paragraph) => !findAncestor(paragraph, ["Fallback"]))
    .map((paragraph) => ownXmlParagraphText(paragraph).trim())
    .filter(Boolean);
}

// 用文本序列对齐建立 XML 段落 → 渲染段落的映射，并给出未命中段落的插值顶边。
function buildParagraphAnchors(
  xmlParagraphs: Element[],
  rendered: RenderedParagraph[],
) {
  const xmlTexts = xmlParagraphs.map((paragraph) =>
    normalizeDocxText(ownXmlParagraphText(paragraph)),
  );
  const renderedTexts = rendered.map((item) => normalizeDocxText(item.text));
  const xmlIndexes: number[] = [];
  const renderedIndexes: number[] = [];
  xmlTexts.forEach((text, index) => {
    if (text) xmlIndexes.push(index);
  });
  renderedTexts.forEach((text, index) => {
    if (text) renderedIndexes.push(index);
  });
  const pairs = lcsPairs(
    xmlIndexes.map((index) => xmlTexts[index]),
    renderedIndexes.map((index) => renderedTexts[index]),
  );
  // xmlIndex → renderedIndex
  const exact = new Map<number, number>();
  pairs.forEach(([left, right]) => {
    exact.set(xmlIndexes[left], renderedIndexes[right]);
  });
  const anchorOf = (xmlIndex: number) => {
    const hit = exact.get(xmlIndex);
    if (hit !== undefined) return rendered[hit].top;
    // 未命中：按前后命中点线性插值；没有命中点时返回 0。
    let before: number | null = null;
    let after: number | null = null;
    for (const [key] of exact) {
      if (key < xmlIndex && (before === null || key > before)) before = key;
      if (key > xmlIndex && (after === null || key < after)) after = key;
    }
    if (before !== null && after !== null) {
      const from = exact.get(before)!;
      const to = exact.get(after)!;
      const ratio = (xmlIndex - before) / Math.max(1, after - before);
      return (
        rendered[from].top + (rendered[to].top - rendered[from].top) * ratio
      );
    }
    if (before !== null) return rendered[exact.get(before)!].top;
    if (after !== null) return rendered[exact.get(after)!].top;
    return 0;
  };
  return { anchorOf, matched: exact.size };
}

// ── docx-preview 渲染出的文本框（svg > image > foreignObject） ──────────

function isForeignObject(node: Element) {
  return node.localName.toLowerCase() === "foreignobject";
}

type RenderedTextBox = {
  element: SVGSVGElement;
  host: HTMLElement | null;
  text: string;
};

function renderedTextBoxes(page: HTMLElement): RenderedTextBox[] {
  const boxes: RenderedTextBox[] = [];
  Array.from(page.querySelectorAll<SVGSVGElement>("svg")).forEach((svg) => {
    const foreign = Array.from(svg.querySelectorAll("*")).find(isForeignObject);
    if (!foreign) return;
    const text = (foreign.textContent ?? "").replace(/\s+/g, " ").trim();
    const hostElement = svg.closest("p, li, td, h1, h2, h3, h4, h5, h6");
    boxes.push({
      element: svg,
      host:
        hostElement && page.contains(hostElement)
          ? (hostElement as HTMLElement)
          : null,
      text,
    });
  });
  return boxes;
}

// docx-preview 把文本框内容放在 foreignObject 里：浏览器无法光栅化，
// 抽完文字后把它摘掉，避免截图与取字时被重复计入。
function stripForeignObjects(page: HTMLElement) {
  Array.from(page.querySelectorAll("*"))
    .filter(isForeignObject)
    .forEach((node) => node.remove());
}

// ── DrawingML 形状几何 ────────────────────────────────────────────────
//
// WPS 生成的简历模板把“章节标题”做成组形状（wpg:grpSp）里的子形状，
// 锚点 wp:positionV 落在整组上，子形状自己的 a:off 才是相对锚点的偏移。
// 不用这层映射，标题和正文就会画在同一位置（实测 100% 重叠）。

type Xfrm = {
  offX: number;
  offY: number;
  extCx: number;
  extCy: number;
  chOffX: number;
  chOffY: number;
  chExtCx: number;
  chExtCy: number;
};

function readXfrm(container: Element): Xfrm | null {
  // 组形状的子节点顺序是 cNvGrpSpPr、grpSpPr。前者没有 a:xfrm，
  // 不能取第一个名字匹配的子节点，否则组变换被跳过，白字标题只剩 0.1px。
  const props = Array.from(container.children).find((child) => {
    if (!["grpSpPr", "spPr", "cNvGrpSpPr"].includes(local(child))) return false;
    return Array.from(child.children).some((kid) => local(kid) === "xfrm");
  });
  const xfrm = props
    ? Array.from(props.children).find((child) => local(child) === "xfrm")
    : null;
  if (!xfrm) return null;
  const kid = (name: string) =>
    Array.from(xfrm.children).find((child) => local(child) === name);
  const num = (element: Element | undefined, attribute: string) =>
    Number(element?.getAttribute(attribute) ?? 0) / EMU_PER_PX;
  const off = kid("off");
  const ext = kid("ext");
  const chOff = kid("chOff");
  const chExt = kid("chExt");
  return {
    offX: num(off, "x"),
    offY: num(off, "y"),
    extCx: num(ext, "cx"),
    extCy: num(ext, "cy"),
    chOffX: num(chOff, "x"),
    chOffY: num(chOff, "y"),
    chExtCx: num(chExt, "cx"),
    chExtCy: num(chExt, "cy"),
  };
}

// 形状在锚点坐标系里的偏移与尺寸（自内向外逐层按 ext/chExt 映射）。
function shapeInAnchorSpace(content: Element) {
  let leaf: Element | null = null;
  for (let node: Element | null = content; node; node = node.parentElement) {
    if (local(node) === "wsp") {
      leaf = node;
      break;
    }
  }
  if (!leaf) return null;
  const leafFrame = readXfrm(leaf);
  if (!leafFrame) return null;
  let x = leafFrame.offX;
  let y = leafFrame.offY;
  let width = leafFrame.extCx;
  let height = leafFrame.extCy;
  const groups: Element[] = [];
  for (
    let node: Element | null = leaf.parentElement;
    node;
    node = node.parentElement
  ) {
    if (["grpSp", "wgp"].includes(local(node))) groups.push(node);
    if (local(node) === "anchor") break;
  }
  groups.forEach((group) => {
    const frame = readXfrm(group);
    if (!frame) return;
    const scaleX = frame.chExtCx > 0 ? frame.extCx / frame.chExtCx : 1;
    const scaleY = frame.chExtCy > 0 ? frame.extCy / frame.chExtCy : 1;
    x = frame.offX + (x - frame.chOffX) * scaleX;
    y = frame.offY + (y - frame.chOffY) * scaleY;
    width *= scaleX;
    height *= scaleY;
  });
  return { x, y, width, height, grouped: groups.length > 0 };
}

// 同一份模板里复制出来的形状（章节标题）会共用同一个 a:off，
// 这类形状的纵向要回到段落锚点上算，否则几个标题会叠在同一处。
function geometryKey(
  shape: { x: number; y: number; width: number; height: number } | null,
) {
  if (!shape) return "";
  return [shape.x, shape.y, shape.width, shape.height]
    .map((value) => Math.round(value * 10) / 10)
    .join(",");
}

export type DocxTextBoxOptions = {
  /** docx-preview 渲染出的每一页（每页一个 section.docx）；不传时只处理 page。 */
  pages?: HTMLElement[];
  /** 诊断用：文本框命中宿主段落 / 回落到序列对齐的数量。 */
  stats?: { hostMatched: number; sequenceMatched: number; textboxes: number };
};

// 返回补进去的文本框数量；渲染成普通段落，后面的 DOM 采样器可以直接收集。
export function renderDocxTextBoxes(
  documentXml: string,
  page: HTMLElement,
  options: DocxTextBoxOptions = {},
): number {
  const documentRoot = new DOMParser().parseFromString(
    documentXml,
    "application/xml",
  );
  if (documentRoot.querySelector("parsererror")) return 0;
  const stats = options.stats;
  if (stats) {
    stats.hostMatched = 0;
    stats.sequenceMatched = 0;
    stats.textboxes = 0;
  }
  const geometry = readSectionGeometry(documentRoot);
  const pages = options.pages?.length ? options.pages : [page];
  const contents = descendants(
    documentRoot.documentElement,
    "txbxContent",
  ).filter((content) => {
    // VML 备用方案里的同名内容跳过，避免同一段文字画两遍。
    for (let node: Element | null = content; node; node = node.parentElement) {
      if (local(node) === "Fallback") return false;
    }
    return true;
  });

  let inserted = 0;

  const xmlParagraphs = bodyParagraphs(documentRoot);

  pages.forEach((pageElement, pageIndex) => {
    if (!pageElement.isConnected) return;
    pageElement.style.position = "relative";
    const pageRect = pageElement.getBoundingClientRect();
    if (!pageRect.width || !pageRect.height) return;
    const rendered = renderedParagraphs(pageElement, pageRect);
    const anchors = buildParagraphAnchors(xmlParagraphs, rendered);
    const renderedBoxes = renderedTextBoxes(pageElement);
    const usedRendered = new Set<RenderedTextBox>();

    const contentsOfPage = contents.filter((content) => {
      const host = findAncestor(content, ["p"]);
      // 分节归属：文本框跟着它的宿主段落走。
      const section = sectionIndexOf(documentRoot, host);
      return section === pageIndex || (pages.length === 1 && pageIndex === 0);
    });

    const seenKeys = new Set<string>();
    // VML 纯色底板：先画，文本框再压在上面（z-index 更大）。
    const fillShapes = vmlFillShapes(documentRoot, geometry).filter((shape) => {
      const section = sectionIndexOf(documentRoot, shape.host);
      return section === pageIndex || (pages.length === 1 && pageIndex === 0);
    });
    fillShapes.forEach((shape, shapeIndex) => {
      let top = shape.marginTop;
      if (!shape.pageRelativeV && shape.host) {
        const hostIndex = xmlParagraphs.indexOf(shape.host);
        const anchorTop = hostIndex >= 0 ? anchors.anchorOf(hostIndex) : 0;
        top = anchorTop + shape.marginTop;
      }
      const div = document.createElement("div");
      div.setAttribute("data-docx-vml-shape", String(shapeIndex + 1));
      Object.assign(div.style, {
        position: "absolute",
        left: `${shape.left}px`,
        top: `${top}px`,
        width: `${shape.width}px`,
        height: `${shape.height}px`,
        background: shape.color,
        zIndex: "0",
        pointerEvents: "none",
      });
      pageElement.append(div);
    });
    // 先统计形状几何：同一组几何被多个文本框共用时说明是复制出来的标题。
    const geometryCounts = new Map<string, number>();
    contentsOfPage.forEach((content) => {
      const key = geometryKey(shapeInAnchorSpace(content));
      if (!key) return;
      geometryCounts.set(key, (geometryCounts.get(key) ?? 0) + 1);
    });
    const staleGeometry = new Set(
      [...geometryCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([key]) => key),
    );
    contentsOfPage.forEach((content, index) => {
      const anchor = findAncestor(content, ["anchor", "inline"]);
      const vmlShape = anchor
        ? null
        : findVmlShape(content.parentElement ?? content);
      if (!anchor && !vmlShape) return;
      const plain = normalizeDocxText(content.textContent ?? "");
      // 同一段文字在 wps 版本和 VML 备用版本里各有一份，只画一次。
      if (plain && seenKeys.has(plain)) return;

      // 宿主段落：优先用 docx-preview 自己渲染出来的同名文本框（结构对齐，最可靠），
      // 找不到时退回 XML 段落与渲染段落的文本序列对齐。
      const renderedBox = renderedBoxes.find(
        (candidate) =>
          !usedRendered.has(candidate) &&
          normalizeDocxText(candidate.text) === plain,
      );
      let anchorTop = 0;
      let anchorLeft = 0;
      if (renderedBox) {
        usedRendered.add(renderedBox);
        if (renderedBox.host) {
          const rect = renderedBox.host.getBoundingClientRect();
          anchorTop = rect.top - pageRect.top;
          anchorLeft = rect.left - pageRect.left;
          if (stats) stats.hostMatched += 1;
        }
      }
      if (!renderedBox) {
        const anchorParagraph = findAncestor(content, ["p"]);
        const index2 = anchorParagraph
          ? xmlParagraphs.indexOf(anchorParagraph)
          : -1;
        if (index2 >= 0) {
          anchorTop = anchors.anchorOf(index2);
          if (stats) stats.sequenceMatched += 1;
        }
      }

      let left = 0;
      let top = 0;
      let width = 0;
      let height = 0;
      if (anchor) {
        const shape = shapeInAnchorSpace(content);
        const extent = firstOf(anchor, "extent");
        width = shape?.width || (numberAttr(extent, "cx") ?? 0) / EMU_PER_PX;
        height = shape?.height || (numberAttr(extent, "cy") ?? 0) / EMU_PER_PX;
        const anchorX = resolveOffset(
          anchor,
          "H",
          geometry,
          geometry.margins,
          anchorTop,
          anchorLeft,
        );
        const anchorY = resolveOffset(
          anchor,
          "V",
          geometry,
          geometry.margins,
          anchorTop,
          anchorLeft,
        );
        // a:off 的写法随锚点而变：
        //  · 锚点是页坐标（page/margin/column）—— a:off 是相对锚点的偏移，
        //    组形状里的子形状还要先按 ext/chExt 映射（章节标题就靠这层错开）。
        //  · 锚点是正文流位置（paragraph/line/text）—— WPS 直接把页坐标写进 a:off。
        //  · 模板里复制出来的形状（几个章节标题共用同一个 a:off）纵向要回到段落锚点，
        //    否则几个标题会叠在同一处。
        const verticalReference =
          firstOf(anchor, "positionV")?.getAttribute("relativeFrom") ?? "page";
        const flowAnchor = ["paragraph", "line", "text"].includes(
          verticalReference,
        );
        const relative = {
          x: anchorX + (shape?.x ?? 0),
          y: anchorY + (shape?.y ?? 0),
        };
        const absolute = { x: shape?.x ?? 0, y: shape?.y ?? 0 };
        const stale = staleGeometry.has(geometryKey(shape));
        const picked = !flowAnchor
          ? relative
          : stale
            ? { x: absolute.x, y: relative.y }
            : absolute;
        left = picked.x;
        top = picked.y;
      } else if (vmlShape) {
        const style = vmlShape.getAttribute("style") ?? "";
        const marginLeft = vmlLength(style, "margin-left") ?? 0;
        const marginTop = vmlLength(style, "margin-top") ?? 0;
        left =
          geometry.margins.left + marginLeft + (vmlLength(style, "left") ?? 0);
        top = anchorTop + marginTop;
        width = vmlLength(style, "width") ?? 0;
        height = vmlLength(style, "height") ?? 0;
      }
      if (width < 8 || height < 8) return;
      const paragraphs = childrenOf(content, "p")
        .map(paragraphHtml)
        .filter(Boolean)
        .join("");
      if (!paragraphs.trim()) return;
      if (plain) seenKeys.add(plain);
      const bodyPr = descendants(
        findAncestor(content, ["wsp"]) ?? content,
        "bodyPr",
      )[0];
      const inset = (name: string, fallback: number) =>
        (numberAttr(bodyPr, name) ?? fallback) / EMU_PER_PX;
      const box = document.createElement("div");
      box.setAttribute("data-docx-textbox", String(index + 1));
      Object.assign(box.style, {
        position: "absolute",
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        minHeight: `${height}px`,
        padding: `${inset("tIns", 23000)}px ${inset("rIns", 46000)}px ${inset("bIns", 23000)}px ${inset("lIns", 46000)}px`,
        boxSizing: "border-box",
        overflow: "hidden",
        whiteSpace: "pre-wrap",
        zIndex: String(index + 1),
      });
      box.innerHTML = paragraphs;
      pageElement.append(box);
      inserted += 1;
      if (stats) stats.textboxes += 1;
    });

    // foreignObject 里的文字已经在上面按坐标重画过，摘掉以免截图与取字时重复。
    stripForeignObjects(pageElement);

    // docx-preview 偶尔会把文本框内容同时渲染成普通块，这里把重复的正文块隐藏掉。
    // 只看元素自身文字（排除 svg），避免误伤真正独立的段落。
    const textSet = new Set(
      contents
        .map((content) => normalizeDocxText(content.textContent ?? ""))
        .filter(Boolean),
    );
    if (textSet.size) {
      Array.from(pageElement.querySelectorAll("p, div, span, td, li")).forEach(
        (element) => {
          if (element.closest("[data-docx-textbox]")) return;
          const own = normalizeDocxText(ownRenderedText(element));
          if (!own || !textSet.has(own)) return;
          const parent = element.parentElement;
          if (parent && normalizeDocxText(ownRenderedText(parent)) === own)
            return;
          (element as HTMLElement).style.display = "none";
        },
      );
    }
  });
  return inserted;
}

// 段落所属的分节（w:sectPr 出现一次就换一节）。
function sectionIndexOf(documentRoot: Document, paragraph: Element | null) {
  if (!paragraph) return 0;
  const all = descendants(documentRoot.documentElement, "p");
  const target = all.indexOf(paragraph);
  if (target < 0) return 0;
  let section = 0;
  for (let index = 0; index <= target; index += 1) {
    const pPr = firstOf(all[index], "pPr");
    if (pPr && firstOf(pPr, "sectPr")) section += 1;
  }
  return section;
}
