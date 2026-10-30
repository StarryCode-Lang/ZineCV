import { dateRangePatternSource, matchSection, type RecognizedLine } from "./resume-content-recognition";
export type PdfTextLine = RecognizedLine & { width: number; layoutText?: string };

// Infer a persistent empty gutter between repeated text rows. A large
// indentation alone is not enough: both sides need distinct rows and
// overlapping vertical extents, and text crossing the cut counts as a band
// boundary instead of column content. Full-width lines divide independent bands.
// A page-level split requires three rows of evidence on every side so that
// entry-internal meta gaps (title beside dates) never register as columns;
// once a column is established, deeper splits inside it may rely on two.

export type GutterItem = { x?: number; y?: number; width: number; text?: string; lineX?: number; lineY?: number; layoutText?: string };

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
  /** Section bands recurse with one-row evidence; a right side whose every
   * row shares its baseline with a left row is that row's own metadata
   * (right-aligned dates beside a title), never a column. Real columns keep
   * at least one row that stands alone below the left content. */
  forbidSingleDateRail?: boolean;
  /** Inside an isolated record-table band the records are already split;
   * re-entry would treat a wrapped date fragment as the next record title. */
  forbidRecordTables?: boolean;
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
    if (options.forbidSingleDateRail) {
      const leftRows = new Set(lines.filter(line => (line.x ?? 0) < cut)
        .map(line => Math.round((line.y ?? 0) / 3)));
      const independentRightRow = right.some(line => !leftRows.has(Math.round((line.y ?? 0) / 3)));
      // A right record card keeps its own titled date row even when its rows
      // share baselines with the left card; a rail of bare date tokens does not.
      const rightRowTexts = new Map<number, string[]>();
      for (const line of right) {
        const row = Math.round((line.y ?? 0) / 3);
        rightRowTexts.set(row, [...(rightRowTexts.get(row) ?? []), line.layoutText ?? line.text ?? ""]);
      }
      const rightHasOwnRecord = [...rightRowTexts.values()].some(texts => {
        const text = texts.join(" ");
        const withoutDate = text.replace(new RegExp(pairedDateRange.source, "gi"), " ")
          .replace(pairedDateFragment, " ").replace(/[\s|｜,，:：\-–—]/g, "");
        return Boolean(withoutDate) && pairedDateRange.test(text);
      });
      const allRightRowsPureDates = right.every(line => {
        const text = line.layoutText ?? line.text ?? "";
        const withoutDate = text.replace(new RegExp(pairedDateRange.source, "gi"), " ")
          .replace(pairedDateFragment, " ").replace(/[\s|｜,，:：\-–—]/g, "");
        return !withoutDate;
      });
      if (!independentRightRow && !rightHasOwnRecord && allRightRowsPureDates) continue;
    }
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
    // Merged OCR columns may share a source line. Such a line proves overlap
    // only when its two word groups have a real empty gutter; cutting through
    // a date token beneath an indented header must not invent that overlap.
    const sourceBands = new Map<string, { leftEnd: number; rightStart: number }>();
    if (options.minimumGenuineRightRows !== undefined) for (const word of lines) {
      const key = `${word.lineX}/${word.lineY}`;
      const bounds = sourceBands.get(key) ?? { leftEnd: -Infinity, rightStart: Infinity };
      if ((word.x ?? 0) < cut) bounds.leftEnd = Math.max(bounds.leftEnd, (word.x ?? 0) + word.width);
      else bounds.rightStart = Math.min(bounds.rightStart, word.x ?? 0);
      sourceBands.set(key, bounds);
    }
    const extent = options.minimumGenuineRightRows === undefined ? right
      : right.filter(line => {
        if ((line.lineX ?? line.x ?? 0) >= cut) return true;
        const bounds = sourceBands.get(`${line.lineX}/${line.lineY}`)!;
        return Number.isFinite(bounds.leftEnd) && Number.isFinite(bounds.rightStart)
          && bounds.leftEnd + Math.max(8, pageWidth * .02) <= bounds.rightStart;
      });
    const low = Math.min(...extent.map(line => line.y ?? 0));
    const high = Math.max(...extent.map(line => line.y ?? 0));
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

function sectionBands(lines: PdfTextLine[], pageWidth: number): PdfTextLine[][] | null {
  const textOf = (line: PdfTextLine) => line.layoutText ?? line.text;
  const isDated = (line: PdfTextLine) => pairedDateRange.test(textOf(line))
    || /(?:19|20)\d{2}[./-]\d{1,2}\s*[-–—]\s*$/.test(textOf(line));
  const leftEdge = Math.min(...lines.map(line => line.x ?? 0));
  const headings = lines.filter(line => matchSection(textOf(line).trim()));
  // A full-width section may have a short title. When every section starts at
  // the same left edge, isolate its vertical band before looking for columns
  // inside it. A heading beside another record is a panel, not a full band.
  const fullHeadings = headings.filter(line => !lines.some(other => other !== line
    && Math.abs((other.y ?? 0) - (line.y ?? 0)) <= 1.5
    && (isDated(other) || matchSection(textOf(other).trim()))));
  if (fullHeadings.length >= 2 && headings.every(line => (line.x ?? 0) <= leftEdge + pageWidth * .04)) {
    const ordered = fullHeadings.sort((a, b) => (b.y ?? 0) - (a.y ?? 0));
    const groups = [lines.filter(line => (line.y ?? 0) > (ordered[0].y ?? 0) + 1.5)];
    for (const [index, heading] of ordered.entries()) {
      const lower = ordered[index + 1]?.y ?? -Infinity;
      groups.push(lines.filter(line => (line.y ?? 0) <= (heading.y ?? 0) + 1.5 && (line.y ?? 0) > lower + 1.5));
    }
    return groups.filter(group => group.length);
  }
  return null;
}

function layoutGroups(lines: PdfTextLine[], pageWidth: number, options: GutterOptions = {}): PdfTextLine[][] {
  const sections = sectionBands(lines, pageWidth);
  if (sections) return sections.flatMap(band => layoutGroups(band, pageWidth,
    band.some(line => matchSection((line.layoutText ?? line.text).trim()))
      ? { ...options, minimumRows: 1, rightMinimumRows: 1, forbidSingleDateRail: true } : options));
  const textOf = (line: PdfTextLine) => line.layoutText ?? line.text;
  const isDated = (line: PdfTextLine) => pairedDateRange.test(textOf(line))
    || /(?:19|20)\d{2}[./-]\d{1,2}\s*[-–—]\s*$/.test(textOf(line));
  const leftEdge = Math.min(...lines.map(line => line.x ?? 0));
  const dated = lines.filter(isDated);
  const recordStart = (entry: PdfTextLine) => {
    let start = entry.x ?? 0;
    for (const prefix of lines.filter(line => Math.abs((line.y ?? 0) - (entry.y ?? 0)) <= 1.5
      && (line.x ?? 0) < start).sort((a, b) => (b.x ?? 0) - (a.x ?? 0))) {
      if ((prefix.x ?? 0) + prefix.width + Math.max(6, entry.fontSize ?? 10) < start) break;
      start = prefix.x ?? 0;
    }
    return start;
  };
  // In a record table, successive dated titles occupy one metadata column;
  // their descriptions must be read before the next record's title. Two
  // simultaneous dated titles instead indicate independent side-by-side cards.
  // A section heading inside the right column marks a full-height two-column
  // page (entries left, skills right), not a record table.
  if (!options.forbidRecordTables && dated.length >= 2
    && dated.every(line => recordStart(line) <= leftEdge + pageWidth * .04)
    && new Set(dated.map(line => Math.round((line.y ?? 0) / 3))).size === dated.length
    && lines.some(line => (line.x ?? 0) > leftEdge + pageWidth * .2)
    && !lines.some(line => (line.x ?? 0) > leftEdge + pageWidth * .2
      && matchSection((line.layoutText ?? line.text).trim()))) {
    const ordered = dated.sort((a, b) => (b.y ?? 0) - (a.y ?? 0));
    const groups = layoutGroups(lines.filter(line => (line.y ?? 0) > (ordered[0].y ?? 0) + 1.5), pageWidth,
      { ...options, forbidRecordTables: true });
    for (const [index, entry] of ordered.entries()) {
      const lower = ordered[index + 1]?.y ?? -Infinity;
      const band = lines.filter(line => (line.y ?? 0) <= (entry.y ?? 0) + 1.5 && (line.y ?? 0) > lower + 1.5);
      // A wrapped record title keeps its date fragment in the left column;
      // descriptions sit in their own right column. Read left rows, then right.
      const columnStart = Math.min(...band.filter(line => (line.x ?? 0) > leftEdge + pageWidth * .2)
        .map(line => line.x ?? 0), Infinity);
      const isolated = { ...options, minimumRows: 1, rightMinimumRows: 1, forbidRecordTables: true };
      if (Number.isFinite(columnStart)) {
        groups.push(...layoutGroups(band.filter(line => (line.x ?? 0) < columnStart - 8), pageWidth, isolated));
        groups.push(...layoutGroups(band.filter(line => (line.x ?? 0) >= columnStart - 8), pageWidth, isolated));
      } else {
        groups.push(...layoutGroups(band, pageWidth, isolated));
      }
    }
    return groups;
  }
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
    const leftFirst = left.find(line => (line.y ?? 0) === leftTop);
    const rightFirst = right.find(line => (line.y ?? 0) === rightTop);
    const rightContinues = leftFirst && rightFirst && matchSection(textOf(leftFirst).trim())
      && Math.abs(leftTop - rightTop) <= 14 && pairedDateRange.test(textOf(rightFirst))
      && !right.some(line => matchSection(textOf(line).trim()));
    const columns = leftTop + 14 >= rightTop && !rightContinues
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
  const sections = sectionBands(lines.map((line, index) => ({ text: String(index), layoutText: line.text,
    x: line.x, y: -line.y, width: line.width })), pageWidth);
  if (sections) return sections.flatMap(band => orderImageLines(band.map(line => lines[Number(line.text)]), pageWidth));
  const headings = lines.filter(line => matchSection(line.text.trim()));
  const parallelSections = headings.some(line => headings.some(other => other !== line
    && Math.abs(line.y - other.y) <= 14 && Math.abs(line.x - other.x) > pageWidth * .1))
    || lines.some(line => line.text.trim().split(/\s{2,}/).filter(text => matchSection(text)).length >= 2);
  // 并排卡片：同一基线上两条含日期的记录标题时，水平条带切分会把标题带与
  // 描述带分开逐带读取，两张卡的正文按 y 交错。按卡片栏（词级 gutter）切开，
  // 每列独立递归，读完整张卡再读下一张。
  const datedTitles = lines.filter(line => pairedDateRange.test(line.text.trim()));
  const sideBySideCards = datedTitles.some(title => datedTitles.some(other => other !== title
    && Math.abs(other.y - title.y) <= 14 && Math.abs(other.x - title.x) > pageWidth * .1));
  if (sideBySideCards && !parallelSections) {
    const cardItems = lines.flatMap(line => (line.words?.length ? line.words
      : [{ text: line.text, box: line }]).map(word => ({ ...word, lineX: line.x, lineY: line.y })))
      .filter(word => word.text.trim());
    const cardGutter = inferGutter(cardItems.map(word => ({ ...word.box, text: word.text,
      lineX: word.lineX, lineY: word.lineY })), pageWidth,
      { minimumRows: 1, rightMinimumRows: 3, minimumGenuineRightRows: 1, rejectPairedDateRows: true });
    if (cardGutter) {
      return [lines.filter(line => line.x < cardGutter.cut), lines.filter(line => line.x >= cardGutter.cut)]
        .flatMap(column => column.length ? orderImageLines(column, pageWidth) : []);
    }
  }
  // A page can change its column geometry below a genuinely empty horizontal
  // strip. Establish these independent regions before choosing a word gutter;
  // one page-wide cut would otherwise slice a lower card's sentences in half.
  const vertical = [...lines].sort((a, b) => a.y - b.y);
  let bottom = -Infinity;
  const bands: ImageTextLine[][] = [];
  for (const line of vertical) {
    if (!bands.length || line.y - bottom > Math.max(60, pageWidth * .08)) bands.push([]);
    bands[bands.length - 1].push(line);
    bottom = Math.max(bottom, line.y + line.height);
  }
  if (!parallelSections && bands.length > 1) return bands.flatMap(band => orderImageLines(band, pageWidth));
  const orderSegments = (items: ImageTextLine[]) => layoutGroups(items.map((line, index) => ({
    text: String(index), layoutText: line.text, x: line.x, y: -line.y, width: line.width,
  })), pageWidth, { minimumRows: 1, rightMinimumRows: 1, rejectPairedDateRows: true, forbidSingleDateRail: true })
    .flatMap(group => group.sort((a, b) => (Math.round(-(a.y ?? 0) / 3) - Math.round(-(b.y ?? 0) / 3))
      || ((a.x ?? 0) - (b.x ?? 0))).map(line => items[Number(line.text)]));
  // Gutter evidence is word-level: merged OCR rows contain both columns, and
  // their line boxes would all read as band boundaries, erasing the left
  // column. Words stay on one side, so the rail keeps its own rows. A short
  // rail is legitimate, so sides may be asymmetric but must not be symmetric.
  const wordItems = lines.flatMap(line => (line.words?.length ? line.words
    : [{ text: line.text, box: line }]).map(word => ({ ...word, lineX: line.x, lineY: line.y }))).filter(word => word.text.trim());
  let gutter = inferGutter(wordItems.map(word => ({ ...word.box, text: word.text, lineX: word.lineX, lineY: word.lineY })), pageWidth,
    { minimumRows: 1, rightMinimumRows: 3, minimumGenuineRightRows: 1, rejectPairedDateRows: true });
  if (gutter) {
    // A label rail belongs to successive content bands, not a separate column.
    // Use complete OCR lines here: CJK word boxes have different top bearings
    // and must not turn one heading into several unrelated geometric rows.
    const cut = gutter.cut;
    const bodies = lines.filter(line => line.x >= cut);
    const bodyStart = Math.min(...bodies.map(line => line.x));
    // The word-start cut can fall inside a multiword heading's final word.
    // Its complete line still belongs to the rail when it ends before any
    // content line starts; a URL/body spanning that boundary stays excluded.
    const left = lines.filter(line => line.x < cut && line.x + line.width <= bodyStart);
    const labels = left.filter(line => matchSection(line.text.trim()));
    // A continuation page may have only one new section label. If that rail
    // contains headings only, its bodies still belong to successive row bands;
    // reading the entire content column first would move that label after them.
    if (labels.length >= 1 && bodies.length && labels.every(label => bodies.some(body => body.y >= label.y))) {
      const firstLabelY = Math.min(...labels.map(line => line.y));
      const rail = left.filter(line => line.y >= firstLabelY);
      if (rail.every(line => matchSection(line.text.trim()))) gutter = null;
    }
  }
  // 无栏间隙时按"行桶 → x"行主序输出：tesseract 的块序对标签栏（悬挂标签、
  // 账本标题列）与同排标题会输出反序；几何行主序与文本路径的行序一致。
  if (!gutter) {
    return orderSegments(lines);
  }
  const segments: Array<ImageTextLine & { side: 0 | 1 }> = [];
  for (const line of lines) {
    const usable = line.words?.length ? line.words : [{ text: line.text, box: line }];
    const left = usable.filter(word => word.box.x < gutter.cut);
    const right = usable.filter(word => word.box.x >= gutter.cut);
    let cursor = 0;
    const spans = new Map(usable.map(word => {
      const start = line.text.indexOf(word.text, cursor);
      if (start >= 0) cursor = start + word.text.length;
      return [word, start < 0 ? null : [start, cursor]] as const;
    }));
    // Rebuild each side from the original line text so tesseract's own CJK
    // spacing survives; joining word texts would insert spurious spaces.
    const slice = (words: ImageTextWord[]) => {
      if (!words.length) return "";
      if (words.length === 1) return words[0].text;
      const positions = words.map(word => spans.get(word));
      return positions.every(position => position != null)
        ? line.text.slice(positions[0]![0], positions[positions.length - 1]![1])
        : words.map(word => word.text).join(" ");
    };
    const build = (words: ImageTextWord[], side: 0 | 1): (ImageTextLine & { side: 0 | 1 }) | null => {
      if (!words.length) return null;
      const x = Math.min(...words.map(word => word.box.x));
      const end = Math.max(...words.map(word => word.box.x + word.box.width));
      const text = slice(words).trim();
      // Each token remains whole, even when its box extends across the cut.
      if (!text) return null;
      return { ...line, text, x, width: Math.max(end - x, line.width && end <= x ? line.width : end - x), side };
    };
    const first = build(left, 0);
    if (first) segments.push(first);
    const second = build(right, 1);
    if (second) segments.push(second);
    if (!first && !second) segments.push({ ...line, side: line.x < gutter.cut ? 0 : 1 });
  }
  return orderSegments(segments.map(({ side: _side, ...segment }) => segment));
}
