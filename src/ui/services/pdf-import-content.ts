import type { RecognizedLine } from "./resume-content-recognition";
import { orderImageLines, pdfLines } from "./pdf-reading-order";

export { orderImageLines };

export type PdfMergeLine = RecognizedLine & { width?: number; height?: number };

export type PdfMergeGeometry = {
  /** Displayed page dimensions in PDF points, before applying scale. */
  width: number;
  height: number;
  scale: number;
  /** PDF.js viewport transform, including crop origin and page rotation. */
  transform?: readonly [number, number, number, number, number, number];
};

// Internal worker protocol; page completeness must survive text extraction.
export type PdfPageContent = {
  page: number;
  lines: PdfMergeLine[];
  hasRasterImage: boolean;
  textCharacters: number;
};

export type PdfImportContent = { pages: PdfPageContent[] };

type Box = { x: number; y: number; width: number; height: number };
type PositionedLine = { line: PdfMergeLine; box: Box; nativeIndex: number | null };

function finitePositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function canvasBox(line: PdfMergeLine, geometry: PdfMergeGeometry, native: boolean): Box | null {
  if (!Number.isFinite(line.x) || !Number.isFinite(line.y)) return null;
  const height = native ? line.fontSize : line.height ?? line.fontSize;
  if (!finitePositive(height) || !finitePositive(line.width)) return null;
  if (!native) return { x: line.x!, y: line.y!, width: line.width, height };
  const matrix = geometry.transform ?? [geometry.scale, 0, 0, -geometry.scale, 0, geometry.height * geometry.scale];
  const point = (x: number, y: number) => ({ x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5] });
  const corners = [point(line.x!, line.y!), point(line.x! + line.width, line.y!),
    point(line.x!, line.y! + height), point(line.x! + line.width, line.y! + height)];
  const xs = corners.map(corner => corner.x), ys = corners.map(corner => corner.y);
  return { x: Math.min(...xs), y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function overlap(left: Box, right: Box) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return { horizontal: width / Math.min(left.width, right.width), vertical: height / Math.min(left.height, right.height),
    widthRatio: Math.max(left.width, right.width) / Math.min(left.width, right.width) };
}

/** Merge evidence by physical location; equal text at different locations is
 * deliberately retained. Native input already has the PDF reading order. */
export function mergePdfPageLines(
  nativeLines: PdfMergeLine[],
  ocrLines: PdfMergeLine[],
  geometry: PdfMergeGeometry,
): { lines: PdfMergeLine[]; warnings: string[]; uncertain: boolean } {
  const native = nativeLines.filter(line => line.text.trim());
  const scanned = ocrLines.filter(line => line.text.trim());
  const warnings = new Set<string>();
  if (!finitePositive(geometry.width) || !finitePositive(geometry.height) || !finitePositive(geometry.scale) ||
      geometry.transform?.some(value => !Number.isFinite(value))) {
    return { lines: [...native, ...scanned], warnings: ["页面几何信息无效；已保留原文与 OCR，无法确定顺序，请人工核对。"], uncertain: true };
  }
  if (!scanned.length) return { lines: native, warnings: [], uncertain: false };
  // OCR already established reading order in its upright coordinate system.
  // Mapping its boxes back to a sideways source must not re-sort the text on
  // the source's rotated axes when there is no native text stream to merge.
  if (!native.length) return { lines: scanned, warnings: [], uncertain: false };
  const positioned: PositionedLine[] = [];
  const unpositioned: PdfMergeLine[] = [];
  for (const [nativeIndex, line] of native.entries()) {
    const box = canvasBox(line, geometry, true);
    if (box) positioned.push({ line, box, nativeIndex });
    else unpositioned.push(line);
  }
  const positionedNative = [...positioned];
  for (const line of scanned) {
    const box = canvasBox(line, geometry, false);
    if (!box) { unpositioned.push(line); continue; }
    const overlappingNative = positionedNative.map(item => ({ item, overlap: overlap(item.box, box) }))
      .filter(value => value.overlap.horizontal >= 0.6 && value.overlap.vertical >= 0.35);
    // Replace an entire OCR line only when one native line describes the same
    // physical region. Replacing a larger OCR region with a tiny native label
    // could otherwise silently discard adjacent image-only words.
    const aligned = overlappingNative.filter(value => value.overlap.widthRatio <= 1.8);
    if (aligned.length === 1 && overlappingNative.length === 1) continue;
    // A rendered text header is re-read by OCR, often re-wrapped; an OCR line
    // fully contained in its native text at the same spot is that duplicate.
    const duplicate = overlappingNative.length === 1 && aligned.length <= 1
      && overlappingNative.some(value => {
        const native = value.item.line.text.replace(/\s+/g, " ").trim();
        const scannedText = line.text.replace(/\s+/g, " ").trim();
        return scannedText.length >= 3 && native.includes(scannedText);
      });
    if (duplicate) continue;
    if (overlappingNative.length) warnings.add("文字层与 OCR 有局部重叠或多个位置候选，已保留全部原文，请核对重复与字段归属。");
    positioned.push({ line, box, nativeIndex: null });
  }
  if (unpositioned.length) {
    // Without coordinates there is no truthful insertion point. Return both
    // streams as review evidence, explicitly preventing a reliable merge claim.
    return { lines: [...native, ...scanned], warnings: ["部分来源片段缺少完整坐标，无法合并阅读顺序；已保留文字层与 OCR，请人工核对。"], uncertain: true };
  }

  // Reuse the existing gutter/band algorithm for ordering only. Unique numeric
  // markers let a row contain several independent lines without concatenating
  // or deduplicating their actual evidence text (including same-name entries).
  // A text header against a scanned rail may leave one row on the near side;
  // the asymmetric rule keeps that split while symmetric title/date rows stay
  // whole.
  const pageHeight = geometry.height * geometry.scale;
  const orderedRows = pdfLines(positioned.map((item, index) => ({ text: String(index), layoutText: item.line.text,
    x: item.box.x / geometry.scale,
    y: (pageHeight - item.box.y - item.box.height) / geometry.scale,
    width: item.box.width / geometry.scale,
  })), 1, geometry.width, { minimumRows: 1, rejectPairedDateRows: true });
  let order = orderedRows.flatMap(row => row.text.split(" ").map(Number));
  const expectedNativeOrder = positionedNative.map(item => item.nativeIndex!);
  const foundNativeOrder = order.map(index => positioned[index].nativeIndex).filter(index => index !== null);
  if (foundNativeOrder.some((index, offset) => index !== expectedNativeOrder[offset])) {
    warnings.add("混合片段的几何排序与原文字层栏序冲突；已保持文字层原顺序，请核对 OCR 片段的归属。");
    // Never override the parser's known native ordering with weaker geometry.
    const nativePositions = positioned.map((item, index) => ({ item, index })).filter(value => value.item.nativeIndex !== null);
    let nextNative = 0;
    order = order.map(index => positioned[index].nativeIndex === null ? index : nativePositions[nextNative++].index);
  }
  // A row with far-separated line boxes needs enough repeated column evidence
  // for pdfLines to infer the gutter. Sparse rows cannot establish that claim.
  const sideBySideRows = orderedRows.filter(row => {
    const indexes = row.text.split(" ").map(Number);
    return indexes.length > 1 && indexes.some((index, offset) => offset > 0 &&
      positioned[index].box.x - (positioned[indexes[offset - 1]].box.x + positioned[indexes[offset - 1]].box.width)
        >= geometry.width * geometry.scale * 0.1);
  });
  if (sideBySideRows.length) warnings.add("存在缺少足够栏序锚点的并排片段，已保留内容，请核对多栏阅读顺序。");
  return { lines: order.map(index => positioned[index].line), warnings: [...warnings], uncertain: warnings.size > 0 };
}
