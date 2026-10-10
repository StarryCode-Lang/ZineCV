import type { RecognizedLine } from "./resume-content-recognition";
export type PdfTextLine = RecognizedLine & { width: number };

// Infer only a persistent empty gutter between repeated text rows. A large
// indentation alone is not enough: both columns need three distinct rows and
// overlapping vertical extents. Full-width lines divide independent bands.
export function pdfLines(items: PdfTextLine[], page: number, pageWidth: number) {
  const lines = items.filter(line => line.text.trim());
  const xs = [...new Set(lines.map(line => Math.round((line.x ?? 0) / 3) * 3))].sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, index) => ({ cut: (x + xs[index]) / 2, gap: x - xs[index] }))
    .filter(candidate => candidate.gap >= pageWidth * .1)
    .sort((a, b) => b.gap - a.gap).slice(0, 8);
  let split: { cut: number; wide: Set<PdfTextLine> } | null = null;
  for (const { cut } of gaps) {
    const right = lines.filter(line => (line.x ?? 0) >= cut);
    if (right.length < 3) continue;
    const rightStart = Math.min(...right.map(line => line.x ?? 0));
    const left = lines.filter(line => (line.x ?? 0) < cut);
    const regular = left.filter(line => (line.x ?? 0) + line.width <= rightStart - Math.max(8, pageWidth * .02));
    if (new Set(regular.map(line => Math.round((line.y ?? 0) / 3))).size < 3
      || new Set(right.map(line => Math.round((line.y ?? 0) / 3))).size < 3) continue;
    const low = Math.min(...right.map(line => line.y ?? 0));
    const high = Math.max(...right.map(line => line.y ?? 0));
    if (regular.filter(line => (line.y ?? 0) >= low - 3 && (line.y ?? 0) <= high + 3).length < 3) continue;
    split = { cut, wide: new Set(left.filter(line => !regular.includes(line))) };
    break;
  }
  const groups: PdfTextLine[][] = [];
  if (split) {
    const boundaries = [...new Set([...split.wide].map(line => Math.round((line.y ?? 0) / 3) * 3))].sort((a, b) => b - a);
    let upper = Infinity;
    const addBand = (lower: number) => {
      const band = lines.filter(line => (line.y ?? 0) < upper - 1.5 && (line.y ?? 0) > lower + 1.5);
      groups.push(band.filter(line => (line.x ?? 0) < split!.cut), band.filter(line => (line.x ?? 0) >= split!.cut));
    };
    for (const boundary of boundaries) {
      addBand(boundary);
      groups.push(lines.filter(line => Math.abs((line.y ?? 0) - boundary) <= 1.5));
      upper = boundary;
    }
    addBand(-Infinity);
  } else groups.push(lines);
  const result: RecognizedLine[] = [];
  for (const group of groups) {
    const rows = new Map<number, PdfTextLine[]>();
    for (const line of group) {
      const y = Math.round((line.y ?? 0) / 3) * 3;
      rows.set(y, [...(rows.get(y) ?? []), line]);
    }
    for (const [, row] of [...rows.entries()].sort((a, b) => b[0] - a[0])) {
      const ordered = row.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
      if (ordered.length) result.push({ ...ordered[0], page, text: ordered.map(line => line.text).join(" ") });
    }
  }
  return result;
}

