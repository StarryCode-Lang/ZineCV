import { matchSection } from "./resume-content-recognition";
import type { ImageTextLine } from "./pdf-reading-order";

export type HeaderReviewRegion = { kind: "name" | "email"; indexes: number[]; x: number; y: number; width: number; height: number; confidence: number };
type HeaderLine = ImageTextLine & { confidence: number };

export function headerReviewRegions(lines: HeaderLine[]): HeaderReviewRegion[] {
  const ordered = lines.map((line, index) => ({ ...line, index })).sort((a, b) => a.y - b.y || a.x - b.x);
  const section = ordered.find(line => matchSection(line.text.trim()));
  const header = ordered.filter(line => !section || line.y < section.y);
  const regions: HeaderReviewRegion[] = [];
  const first = header[0];
  if (first && first.confidence < 60 && /^[\p{L} .'-]{2,40}$/u.test(first.text.trim())) {
    const fragments = header.filter(line => line.confidence < 60 && line.y <= first.y + first.height * 2
      && line.x < first.x + first.width && line.x + line.width > first.x);
    const x = Math.min(...fragments.map(line => line.x)), y = Math.min(...fragments.map(line => line.y));
    regions.push({ kind: "name", indexes: fragments.map(line => line.index), x, y,
      width: Math.max(...fragments.map(line => line.x + line.width)) - x,
      height: Math.max(...fragments.map(line => line.y + line.height)) - y,
      confidence: Math.max(...fragments.map(line => line.confidence)) });
  }
  const email = header.find(line => line.confidence < 80 && /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/u.test(line.text.trim()));
  if (email) regions.push({ kind: "email", indexes: [email.index], x: email.x, y: email.y,
    width: email.width, height: email.height, confidence: email.confidence });
  return regions.slice(0, 2);
}

export function acceptHeaderReview(region: HeaderReviewRegion, text: string, confidence: number) {
  const value = text.trim();
  return confidence >= 80 && confidence >= region.confidence + 10 && (region.kind === "email"
    ? /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/u.test(value)
    : /^[\p{L} .'-]{2,40}$/u.test(value)) ? value : null;
}

// Remove only long, thin, pale neutral rules from the OCR copy. Dark text,
// short strokes and filled panels are preserved; the source preview is untouched.
export function clearLightRuling(data: Uint8ClampedArray, width: number, height: number) {
  const pale = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const i = (y * width + x) * 4;
    const low = Math.min(data[i], data[i + 1], data[i + 2]);
    return low >= 205 && Math.max(data[i], data[i + 1], data[i + 2]) <= Math.min(235, low + 6);
  };
  const white = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const i = (y * width + x) * 4;
    return data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245;
  };
  // 深色细规则线（2px 级分隔横线，灰度可低至纯黑）同样会把 tesseract 的
  // 标题行吞掉。判定：单行连续深色段 ≥12% 宽，且上下 2-3px 处不再是深色
  // （细线两侧是纸面）。深色文字行的词段远短于 12%，填充面板内部上下皆深，
  // 两者都不会命中。
  const dark = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const i = (y * width + x) * 4;
    return Math.min(data[i], data[i + 1], data[i + 2]) < 165;
  };
  let removed = 0;
  for (const horizontal of [true, false]) {
    const length = horizontal ? width : height, count = horizontal ? height : width;
    const minimum = Math.max(80, length * .12);
    for (let axis = 0; axis < count; axis++) {
      let start = 0;
      while (start < length) {
        const isPale = (position: number) => horizontal ? pale(position, axis) : pale(axis, position);
        const isDark = (position: number) => horizontal ? dark(position, axis) : dark(axis, position);
        if (!isPale(start) && !isDark(start)) { start++; continue; }
        const darkRun = isDark(start);
        let end = start + 1;
        while (end < length && (darkRun ? isDark(end) : isPale(end))) end++;
        if (end - start >= minimum) for (let position = start; position < end; position++) {
          const x = horizontal ? position : axis, y = horizontal ? axis : position;
          const neighborsClear = horizontal
            ? !dark(x, y - 5) && !dark(x, y - 4) && !dark(x, y - 3) && !dark(x, y - 2)
              && !dark(x, y + 2) && !dark(x, y + 3) && !dark(x, y + 4) && !dark(x, y + 5)
            : !dark(x - 5, y) && !dark(x - 4, y) && !dark(x - 3, y) && !dark(x - 2, y)
              && !dark(x + 2, y) && !dark(x + 3, y) && !dark(x + 4, y) && !dark(x + 5, y);
          const whiteNeighbors = horizontal
            ? white(x, y - 3) && white(x, y + 3)
            : white(x - 3, y) && white(x + 3, y);
          if (darkRun ? !neighborsClear : !whiteNeighbors) continue;
          const index = (y * width + x) * 4;
          data[index] = data[index + 1] = data[index + 2] = 255;
          removed++;
        }
        start = end;
      }
    }
  }
  return removed;
}
