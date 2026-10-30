import { dateRangePatternSource, matchSection, type RecognizedLine } from "./resume-content-recognition";
export type PdfTextLine = RecognizedLine & { width: number; layoutText?: string };

// Infer a persistent empty gutter between repeated text rows. A large
// indentation alone is not enough: both sides need distinct rows and
// overlapping vertical extents, and text crossing the cut counts as a band
// boundary instead of column content. Full-width lines divide independent bands.
// A page-level split requires three rows of evidence on every side so that
// entry-internal meta gaps (title beside dates) never register as columns;
// once a column is established, deeper splits inside it may rely on two.

export type GutterItem = { x?: number; y?: number; width: number; text?: string; lineX?: number; layoutText?: string };

export type GutterOptions = {
  /** Override the per-side row evidence floor. */
  minimumRows?: number;
  /** Independent floor for the right side; a rail may be one row but a
   * second column needs sustained evidence, otherwise a wrapped URL tail or
   * date fragment reads as a column and amputates the line. */
  rightMinimumRows?: number;
  /** Rows on the right whose own line starts at or right of the cut. Words
   * continuing a line from the left (wrapped URL tails, date fragments) do
   * not prove a column; a real column's lines begin inside it. */
  minimumGenuineRightRows?: number;
  /** Reject layouts where every left row pairs with a same-baseline right row
   * that is nothing but a date range: that is an entry heading beside its own
   * dates, not two columns. Used where one side may legitimately be a short
   * rail, so row-count symmetry cannot decide. */
  rejectPairedDateRows?: boolean;
};

const pairedDateRange = new RegExp(dateRangePatternSource, "i");
// Bare years and year-month fragments ("2024", "2024-06") are date meta too.
const pairedDateFragment = /^(?:(?:19|20)\d{2}(?:[./年-]\d{1,2})?月?|至今|现在|present)$/i;

function inferGutter(lines: GutterItem[], pageWidth: number, options: GutterOptions = {}) {
  if (lines.length < 4) return null;
  const minimumRowsPerSide = options.minimumRows ?? 2;
  const rightMinimumRows = options.rightMinimumRows ?? minimumRowsPerSide;
  const xs = [...new Set(lines.map(line => Math.round((line.x ?? 0) / 3) * 3))].sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, index) => ({ cut: (x + xs[index]) / 2, gap: x - xs[index] }))
    .filter(candidate => candidate.gap >= Math.max(10, pageWidth * .025))
    .sort((a, b) => b.gap - a.gap).slice(0, 8);
  for (const { cut } of gaps) {
    const right = lines.filter(line => (line.x ?? 0) >= cut);
    if (right.length < rightMinimumRows) continue;
    const rightStart = Math.min(...right.map(line => line.x ?? 0));
    const left = lines.filter(line => (line.x ?? 0) < cut);
    const regular = left.filter(line => (line.x ?? 0) + line.width <= rightStart - Math.max(8, pageWidth * .02));
    const leftRows = new Set(regular.map(line => Math.round((line.y ?? 0) / 3))).size;
    const rightRows = new Set(right.map(line => Math.round((line.y ?? 0) / 3))).size;
    if (leftRows < minimumRowsPerSide || rightRows < rightMinimumRows) continue;
    // Entry headings beside their own dates must not register as columns:
    // count only left rows that actually have a same-baseline right partner,
    // and reject when two or more such pairs are all pure date ranges. Body
    // rows between the dated rows have no partner and must not defeat this.
    const rightRowTexts = new Map<number, string[]>();
    for (const line of right) {
      const row = Math.round((line.y ?? 0) / 3);
      rightRowTexts.set(row, [...(rightRowTexts.get(row) ?? []), line.layoutText ?? line.text ?? ""]);
    }
    let pairedDateRows = 0;
    for (const row of new Set(regular.map(line => Math.round((line.y ?? 0) / 3)))) {
      const partner = rightRowTexts.get(row)?.join(" ").trim();
      if (!partner) continue;
      const withoutDate = partner.replace(new RegExp(pairedDateRange.source, "gi"), " ")
        .replace(pairedDateFragment, " ")
        .replace(/[\s|｜,，:：]/g, "");
      if (withoutDate) continue;
      pairedDateRows += 1;
    }
    if (pairedDateRows >= 2 && options.rejectPairedDateRows !== false) continue;
    if (options.minimumGenuineRightRows !== undefined) {
      const genuine = new Set(right.filter(line => (line.lineX ?? line.x ?? 0) >= cut)
        .map(line => Math.round((line.y ?? 0) / 3))).size;
      // A lone genuine right row plus lines amputated by the cut is a wrapped
      // fragment (a squeezed name or URL), not a column; real columns keep at
      // least two lines that start inside them.
      const splitLeftRows = new Set(right.filter(line => (line.lineX ?? line.x ?? 0) < cut)
        .map(line => Math.round((line.y ?? 0) / 3)));
      if (genuine < 2 && splitLeftRows.size >= 1) continue;
      if (genuine < options.minimumGenuineRightRows) continue;
    }
    const low = Math.min(...right.map(line => line.y ?? 0));
    const high = Math.max(...right.map(line => line.y ?? 0));
    // A left column whose in-band rows are all bare section headings is a
    // label rail (hanging labels, ledger headings): rows already read in the
    // right order and the heading text is split from its row at text level.
    // The band allows one row pitch of padding so a short padded aside still
    // overlaps the main column it sits beside.
    const bandRows = [...new Set(regular.filter(line => (line.y ?? 0) >= low - 14 && (line.y ?? 0) <= high + 14)
      .map(line => Math.round((line.y ?? 0) / 3)))];
    if (bandRows.length >= 2 || bandRows.length === 1 && options.minimumRows === 1) {
      const labelRows = bandRows.filter(row => matchSection(regular
        .filter(line => Math.round((line.y ?? 0) / 3) === row)
        .map(line => line.layoutText ?? line.text ?? "").join(" ").trim())).length;
      if (labelRows === bandRows.length) continue;
    }
    if (regular.filter(line => (line.y ?? 0) >= low - 14 && (line.y ?? 0) <= high + 14).length < minimumRowsPerSide) continue;
    return { cut, wide: new Set(left.filter(line => !regular.includes(line))) };
  }
  return null;
}

function layoutGroups(lines: PdfTextLine[], pageWidth: number, options: GutterOptions = {}): PdfTextLine[][] {
  const split = inferGutter(lines, pageWidth, options);
  if (!split) return lines.length ? [lines] : [];
  const boundaries = [...new Set([...split.wide].map(line => Math.round((line.y ?? 0) / 3) * 3))].sort((a, b) => b - a);
  const groups: PdfTextLine[][] = [];
  let upper = Infinity;
  const addBand = (lower: number) => {
    const band = lines.filter(line => (line.y ?? 0) < upper - 1.5 && (line.y ?? 0) > lower + 1.5);
    // Each band can itself contain further columns; the boundary rows stay
    // whole because they span the cut by definition. When the two sides'
    // contents do not overlap vertically, the higher column reads first
    // (a header block inside one rail); otherwise left precedes right. PDF
    // page space is y-up, so a column's top is its largest y.
    const left = band.filter(line => (line.x ?? 0) < split.cut);
    const right = band.filter(line => (line.x ?? 0) >= split.cut);
    const leftTop = left.length ? Math.max(...left.map(line => line.y ?? 0)) : -Infinity;
    const rightTop = right.length ? Math.max(...right.map(line => line.y ?? 0)) : -Infinity;
    const columns = leftTop + 14 >= rightTop
      ? [layoutGroups(left, pageWidth, options), layoutGroups(right, pageWidth, options)]
      : [layoutGroups(right, pageWidth, options), layoutGroups(left, pageWidth, options)];
    groups.push(...columns.flat());
  };
  for (const boundary of boundaries) {
    addBand(boundary);
    groups.push(lines.filter(line => Math.abs((line.y ?? 0) - boundary) <= 1.5));
    upper = boundary;
  }
  addBand(-Infinity);
  return groups;
}

export function pdfLines(items: PdfTextLine[], page: number, pageWidth: number, options: GutterOptions = {}) {
  const lines = items.filter(line => line.text.trim());
  const result: RecognizedLine[] = [];
  for (const group of layoutGroups(lines, pageWidth, options)) {
    const rows = new Map<number, PdfTextLine[]>();
    for (const line of group) {
      const y = Math.round((line.y ?? 0) / 3) * 3;
      rows.set(y, [...(rows.get(y) ?? []), line]);
    }
    for (const [, row] of [...rows.entries()].sort((a, b) => b[0] - a[0])) {
      const ordered = row.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
      if (ordered.length) result.push({ ...ordered[0], page,
        width: Math.max(...ordered.map(line => (line.x ?? 0) + line.width)) - (ordered[0].x ?? 0),
        text: ordered.map(line => line.text).join(" ") });
    }
  }
  return result;
}

export type ImageTextWord = { text: string; box: { x: number; y: number; width: number; height: number }; lineX?: number };
export type ImageTextLine = { text: string; x: number; y: number; width: number; height: number; words?: ImageTextWord[] };

// OCR 会把侧栏与主栏同一基线的文字并成一条行记录。检测到持久栏间隙后按词框
// 分段，并按"整宽页眉 → 左栏 → 右栏 → 页脚"输出；无栏间隙的页面保持
// tesseract 原行结构，避免对常规版式引入重新分行误差。
export function orderImageLines(lines: ImageTextLine[], pageWidth: number): ImageTextLine[] {
  // Gutter evidence is word-level: merged OCR rows contain both columns, and
  // their line boxes would all read as band boundaries, erasing the left
  // column. Words stay on one side, so the rail keeps its own rows. A short
  // rail is legitimate, so sides may be asymmetric but must not be symmetric.
  const wordItems = lines.flatMap(line => (line.words?.length ? line.words
    : [{ text: line.text, box: line }])).filter(word => word.text.trim());
  let gutter = inferGutter(wordItems.map(word => ({ ...word.box, text: word.text, lineX: word.lineX })), pageWidth,
    { minimumRows: 1, rightMinimumRows: 3, minimumGenuineRightRows: 1, rejectPairedDateRows: true });
  if (gutter) {
    // A label rail belongs to successive content bands, not a separate column.
    // Use complete OCR lines here: CJK word boxes have different top bearings
    // and must not turn one heading into several unrelated geometric rows.
    const cut = gutter.cut;
    const left = lines.filter(line => line.x < cut && line.x + line.width <= cut);
    const labels = left.filter(line => matchSection(line.text.trim()));
    const bodies = lines.filter(line => line.x >= cut);
    if (labels.length >= 2 && bodies.length && labels.every(label => bodies.some(body => body.y >= label.y))) {
      const firstLabelY = Math.min(...labels.map(line => line.y));
      const rail = left.filter(line => line.y >= firstLabelY);
      if (rail.every(line => matchSection(line.text.trim()))) gutter = null;
    }
  }
  // 无栏间隙时按"行桶 → x"行主序输出：tesseract 的块序对标签栏（悬挂标签、
  // 账本标题列）与同排标题会输出反序；几何行主序与文本路径的行序一致。
  if (!gutter) {
    return [...lines].sort((a, b) => (Math.round(a.y / 3) - Math.round(b.y / 3)) || (a.x - b.x));
  }
  const segments: Array<ImageTextLine & { side: 0 | 1 }> = [];
  for (const line of lines) {
    const usable = line.words?.length ? line.words : [{ text: line.text, box: line }];
    const left = usable.filter(word => word.box.x < gutter.cut);
    const right = usable.filter(word => word.box.x >= gutter.cut);
    // Rebuild each side from the original line text so tesseract's own CJK
    // spacing survives; joining word texts would insert spurious spaces.
    const slice = (words: ImageTextWord[]) => {
      if (!words.length) return "";
      if (words.length === 1) return words[0].text;
      let cursor = 0, matched = true;
      const spans = words.map(word => {
        if (!matched) return [0, 0] as const;
        const start = line.text.indexOf(word.text, cursor);
        if (start < 0) { matched = false; return [0, 0] as const; }
        cursor = start + word.text.length;
        return [start, cursor] as const;
      });
      return matched ? line.text.slice(spans[0][0], spans[spans.length - 1][1]) : words.map(word => word.text).join(" ");
    };
    const build = (words: ImageTextWord[], side: 0 | 1): (ImageTextLine & { side: 0 | 1 }) | null => {
      if (!words.length) return null;
      const x = Math.min(...words.map(word => word.box.x));
      const end = Math.max(...words.map(word => word.box.x + word.box.width));
      const text = slice(words).trim();
      // A word starting left of the cut may still cross it (a long URL);
      // keep such lines whole instead of inventing a split inside a token.
      if (!text || (side === 1 && x < gutter.cut)) return null;
      return { ...line, text, x, width: Math.max(end - x, line.width && end <= x ? line.width : end - x), side };
    };
    const first = build(left, 0);
    if (first) segments.push(first);
    else if (!line.words?.length || !right.length) segments.push({ ...line, side: 0 });
    const second = build(right, 1);
    if (second) segments.push(second);
    else if (left.length && right.length) segments.push({ ...line, side: 0 });
  }
  const rightSegments = segments.filter(segment => segment.side === 1);
  const byRow = (a: ImageTextLine, b: ImageTextLine) => (Math.round(a.y / 3) - Math.round(b.y / 3)) || (a.x - b.x);
  if (!rightSegments.length) return [...lines].sort(byRow);
  // Columns read in the order of their topmost row (canvas y grows downward);
  // ties keep the left column first. A header block inside one rail therefore
  // pulls that rail ahead, while side-by-side section starts stay left-first.
  const leftSegments = segments.filter(segment => segment.side === 0).sort(byRow);
  const rightColumn = [...rightSegments].sort(byRow);
  const leftTop = Math.min(...leftSegments.map(segment => segment.y));
  const rightTop = Math.min(...rightSegments.map(segment => segment.y));
  const ordered = rightTop + 3 < leftTop ? [...rightColumn, ...leftSegments] : [...leftSegments, ...rightColumn];
  return ordered.map(({ side: _side, ...segment }) => segment);
}
