import { Fragment, useMemo } from "react";
import type { CSSProperties } from "react";
import {
  effectiveBoxText,
  isBoxEdited,
  type ImportedLayoutBox,
  type ImportedSourceLayout,
} from "../domain/imported-layout";
import "../styles/imported-layout.css";

type ImportedLayoutPaperProps = {
  layout: ImportedSourceLayout;
  pageIndex: number;
  edits: Record<string, string>;
};

// 单行文本框按可用宽度收紧字号，避免编辑后的文字压到别的组件上。
// "单行"的判定不能只看框高：PDF 的墨迹带可能被相邻边框/邻行污染而虚高
// （实测张小可一行框高 68px、字只有 36px），按框高会把单行误判成多行，
// 新字直接换行压到下一行上。原文量出来放得进框宽，就是单行。
// 返回 nowrap 标记：单行补丁禁止换行——缩字有下限，放不下时宁可溢出框右，
// 也不能折到第二行把下面的内容盖掉（那是"排版变了"）。
// 量测画布模块级复用：fitFontSize 在每次按键的渲染路径上逐框调用，
// 每次新建 canvas 会带来无谓的分配与 GC 压力（同一时刻只量一个字符串）。
let sharedMeasureContext: CanvasRenderingContext2D | null = null;
function sharedMeasureCanvas(): CanvasRenderingContext2D | null {
  if (sharedMeasureContext) return sharedMeasureContext;
  try {
    sharedMeasureContext = document.createElement("canvas").getContext("2d");
  } catch {
    sharedMeasureContext = null;
  }
  return sharedMeasureContext;
}

function fitFontSize(
  box: ImportedLayoutBox,
  text: string,
): { fontSize: number; nowrap: boolean } {
  if (!text) return { fontSize: box.fontSize, nowrap: false };
  try {
    const context = sharedMeasureCanvas();
    if (!context) return { fontSize: box.fontSize, nowrap: false };
    const measure = (value: string) => {
      context.font = `${box.fontWeight} ${box.fontSize}px ${box.fontFamily}`;
      return context.measureText(value).width;
    };
    const originalFits = measure(box.text) <= box.width * 1.2;
    const singleLine =
      box.height <= box.fontSize * 1.45 ||
      (originalFits && !box.text.includes("\n"));
    if (!singleLine) return { fontSize: box.fontSize, nowrap: false };
    const width = measure(text);
    if (width <= box.width) return { fontSize: box.fontSize, nowrap: true };
    return {
      fontSize: Math.max(
        box.fontSize * 0.5,
        (box.fontSize * box.width) / width,
      ),
      nowrap: true,
    };
  } catch {
    return { fontSize: box.fontSize, nowrap: false };
  }
}

// 导出栅格 = A4 @ 2x，跟 src/services/resume-export.ts 里 html2canvas 的 scale: 2 一致。
// 背景落位要按这个栅格取整，导出与预览才会逐像素一致。
const EXPORT_SCALE = 2;

// 补丁底色的外扩量（单位：源栅格 px，与 box.x/y/width/height/fontSize 同尺度）。
//
// 源文件的行框并不等于字形的墨迹范围：
//   · 字形的抗锯齿描边会落在行框外 1~2px；
//   · 行框下沿之外还可能有一点降部笔画。
// 补丁本身只比原框大 1px，底图原字就会在补丁边缘留下一条灰边（导出 PNG 里看得见）。
// 所以在补丁下面再铺一层同底色的"外扩底色"。
const COVER = 3;
// 外扩底色与下方文本框上沿之间的安全距离（源栅格 px）。
//
// 外扩底色**不能无限往下长**：下一行的字就在下面，
// 盖住它就是"排版变了"——导出的图与没改之前逐像素不同。
// 界限取"下方最近、且横向与之重叠的文本框的上沿"再留 1px：
// 文本框的上沿就是那行字的墨迹顶，字形墨迹必然在它下面，
// 所以这条界限对拉丁字母与中日韩字形都安全。
const COVER_GAP = 1;

// 源文件里这一行的**原始基线**（源栅格 px）。
//
// PDF 行框带这个字段（导入时从 PDF 的 text item 算出来）：补丁必须按它
// 定位新文字，新文字才会和原字坐在同一条基线上。
// ImportedLayoutBox 的形状是冻结的，没有字段能表达基线，
// 所以这里以可选的运行时字段读它；Word（DOM 行盒口径）与旧数据没有，
// 补丁回退到原来的定位方式。
type BoxWithBaseline = ImportedLayoutBox & { baseline?: number };

function boxBaseline(box: ImportedLayoutBox) {
  const value = (box as BoxWithBaseline).baseline;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// 浏览器把一段文字的首行基线放在：内容顶 + 半行距 + ascent，
// 半行距 = (lineHeight − (ascent + descent)) / 2。
// canvas 的 fontBoundingBox 与浏览器排版实际用的 ascent/descent 有零点几像素差，
// 所以这里直接量：一个零尺寸 inline-block 标记放在文字前面，
// 它的下边缘就落在首行基线上（html2canvas 量基线用的也是同一招，
// 导出与预览才对得上）。量到的偏移按字体+字号缓存。
const baselineOffsetCache = new Map<string, number>();

function measureBaselineOffset(
  family: string,
  weight: string,
  fontStyle: string,
  size: number,
  lineHeight: number,
) {
  const key = `${fontStyle}|${weight}|${size}|${lineHeight}|${family}`;
  const cached = baselineOffsetCache.get(key);
  if (cached !== undefined) return cached;
  // 兜底：经验上首行基线在内容顶下方约 0.8em。
  let offset = size * 0.8;
  try {
    const probe = document.createElement("div");
    probe.style.cssText = [
      "position:fixed",
      "left:-10000px",
      "top:0",
      "visibility:hidden",
      "white-space:nowrap",
      "margin:0",
      "padding:0",
      "border:0",
      `font:${fontStyle} ${weight} ${size}px ${family}`,
      `line-height:${lineHeight}px`,
      "letter-spacing:0",
      "text-indent:0",
    ].join(";");
    const marker = document.createElement("span");
    marker.style.cssText =
      "display:inline-block;width:0;height:0;vertical-align:baseline";
    const probeText = document.createElement("span");
    probeText.textContent = "Hxg";
    probe.append(marker, probeText);
    document.body.append(probe);
    offset =
      marker.getBoundingClientRect().top - probe.getBoundingClientRect().top;
    probe.remove();
  } catch {
    /* 量不到就用兜底值 */
  }
  baselineOffsetCache.set(key, offset);
  return offset;
}

// 下方最近、横向与之重叠的文本框的上沿；没有则返回 Infinity。
function nextBoxTop(box: ImportedLayoutBox, siblings: ImportedLayoutBox[]) {
  const left = box.x - COVER;
  const right = box.x + box.width + COVER;
  const bottom = box.y + box.height;
  let limit = Infinity;
  siblings.forEach((other) => {
    if (other.id === box.id) return;
    // 横向不重叠 = 不在同一列，盖不到对方。
    if (other.x + other.width < left || other.x > right) return;
    // 只看严格在下方、且不与本框竖直重叠的文本框。
    if (other.y <= bottom) return;
    if (other.y < limit) limit = other.y;
  });
  return limit;
}

// 版式层只画“被改过的”文本框：没改过的位置直接透出源文件背景，
// 所以导入后、以及只改一个字之后，看到的仍然是原简历本身。
export function ImportedLayoutPaper({
  layout,
  pageIndex,
  edits,
}: ImportedLayoutPaperProps) {
  const page = layout.pages[pageIndex];
  const boxes = useMemo(
    () => layout.boxes.filter((box) => box.page === pageIndex + 1),
    [layout.boxes, pageIndex],
  );
  const A4_WIDTH = 794;
  const A4_HEIGHT = 1123;
  const scale = Math.min(A4_WIDTH / page.width, A4_HEIGHT / page.height);
  const offsetX = (A4_WIDTH - page.width * scale) / 2;
  const offsetY = (A4_HEIGHT - page.height * scale) / 2;

  // 背景的落位框：在导出栅格里做 contain 适配，再取整到整设备像素。
  // 浏览器合成器与 html2canvas 的画布路径用的是两套重采样，
  // 只要落位框差半个像素，两边对同一张背景图采样的像素就会错开，
  // 表现为每个字形边缘都差一点（导出比预览糊）。
  const deviceWidth = A4_WIDTH * EXPORT_SCALE;
  const deviceHeight = A4_HEIGHT * EXPORT_SCALE;
  const deviceScale = Math.min(
    deviceWidth / page.width,
    deviceHeight / page.height,
  );
  const fitWidth = Math.round(page.width * deviceScale);
  const fitHeight = Math.round(page.height * deviceScale);
  const fitLeft = Math.round((deviceWidth - fitWidth) / 2);
  const fitTop = Math.round((deviceHeight - fitHeight) / 2);
  const backgroundStyle: CSSProperties = {
    position: "absolute",
    left: fitLeft / EXPORT_SCALE,
    top: fitTop / EXPORT_SCALE,
    right: "auto",
    bottom: "auto",
    width: fitWidth / EXPORT_SCALE,
    height: fitHeight / EXPORT_SCALE,
  };

  return (
    <>
      {/* 背景必须直接挂在纸面下。放进 .imported-layout-page 会被它的 transform
          带进一条独立合成层，栅格比例被吸附后与导出画布对不上。 */}
      <img
        className="imported-layout-background"
        src={page.background}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={backgroundStyle}
      />
      <div
        className="imported-layout-page"
        data-imported-layout-page={pageIndex + 1}
        style={{
          position: "absolute",
          left: offsetX,
          top: offsetY,
          width: page.width,
          height: page.height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {boxes
          .filter((box) => isBoxEdited(box, edits))
          .map((box) => {
            const text = effectiveBoxText(box, edits);
            // 清空也要渲染：遮盖块必须盖住底图原字，否则清掉的文字还显示。
            const { fontSize, nowrap } = fitFontSize(box, text);
            const lineHeight = Math.max(
              fontSize * 1.05,
              Math.min(box.lineHeight, fontSize * 1.55),
            );
            // 新文字的首行基线必须落在原字的基线上。
            // 行框的上下沿只描述墨迹范围（PDF 行框 = 实测墨迹带），
            // 基线要单独给：PDF 行框带 baseline 字段，Word 没有就保持原样。
            const baseline = boxBaseline(box);
            const shift =
              baseline === undefined
                ? 0
                : baseline -
                  (box.y -
                    1 +
                    measureBaselineOffset(
                      box.fontFamily,
                      box.fontWeight,
                      box.fontStyle,
                      fontSize,
                      lineHeight,
                    ));
            // 外扩底色的下沿：既要盖住本行的降部，又不能碰到下一行的字。
            // 行框已经贴着真实墨迹（含降部），所以不再额外补降部；
            // 下沿仍夹在下一行文本框的上沿之前（下一行的上沿就是它的墨迹顶）。
            const coverTop = box.y - COVER;
            const naturalBottom = box.y + box.height + COVER;
            const limit = nextBoxTop(box, boxes) - COVER_GAP;
            const coverBottom = Math.min(naturalBottom, limit);
            const coverStyle: CSSProperties = {
              position: "absolute",
              left: box.x - COVER,
              top: coverTop,
              width: box.width + COVER * 2,
              height: Math.max(0, coverBottom - coverTop),
              background: box.background,
              zIndex: 1,
              pointerEvents: "none",
            };
            const style: CSSProperties = {
              left: box.x - 1,
              top: box.y - 1,
              width: box.width + 2,
              // 单行补丁的高度按“墨迹行高”收口：标题类文本框的 box.height
              // 是 PDF 行框（含行距留白），按它铺白底会把下一行的字盖住。
              minHeight: nowrap
                ? Math.min(box.height + 2, lineHeight + 2)
                : Math.min(box.height + 2, fontSize * 1.55),
              fontSize: `${fontSize}px`,
              lineHeight: `${lineHeight}px`,
              fontFamily: box.fontFamily,
              fontWeight: box.fontWeight,
              fontStyle: box.fontStyle,
              color: box.color,
              background: box.background,
              textAlign: box.align,
              whiteSpace: nowrap ? "nowrap" : undefined,
            };
            return (
              <Fragment key={box.id}>
                <div
                  className="imported-layout-cover"
                  data-imported-layout-cover={box.id}
                  style={coverStyle}
                />
                <div
                  className="imported-layout-patch"
                  data-imported-layout-patch={box.id}
                  style={style}
                >
                  {/* 文字整体挪动到原字基线上：相对定位不影响行盒，
                      补丁自己的底色与外扩底色的范围保持原样。 */}
                  <span
                    style={
                      shift
                        ? { position: "relative", top: `${shift}px` }
                        : undefined
                    }
                  >
                    {text}
                  </span>
                </div>
              </Fragment>
            );
          })}
      </div>
    </>
  );
}
