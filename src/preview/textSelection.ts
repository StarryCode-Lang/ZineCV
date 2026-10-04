import type { TextMap } from "../../src-tauri/src/domain/bindings/TextMap";

export type LogicalSelection = { anchor: number; focus: number };

/** Coordinates are page-local points; cluster boundaries preserve shaping/UTF-16 units. */
export function offsetAtPoint(map: TextMap, page: number, x: number, y: number): number | null {
  let nearest: TextMap["clusters"][number] | undefined;
  let distance = Infinity;
  for (const cluster of map.clusters) {
    if (cluster.page !== page) continue;
    const dx = Math.max(cluster.xPt - x, 0, x - cluster.xPt - cluster.widthPt);
    const dy = Math.max(cluster.yPt - y, 0, y - cluster.yPt - cluster.heightPt);
    const candidate = dx * dx + dy * dy;
    if (candidate < distance) { distance = candidate; nearest = cluster; }
  }
  if (!nearest) return null;
  const leftHalf = x < nearest.xPt + nearest.widthPt / 2;
  return leftHalf !== !!nearest.rtl ? nearest.startUtf16 : nearest.endUtf16;
}

export function selectedText(map: TextMap, selection: LogicalSelection): string {
  return map.logicalText.slice(Math.min(selection.anchor, selection.focus), Math.max(selection.anchor, selection.focus));
}

export function selectedClusters(map: TextMap, selection: LogicalSelection) {
  const start = Math.min(selection.anchor, selection.focus);
  const end = Math.max(selection.anchor, selection.focus);
  return map.clusters.filter((cluster) => cluster.startUtf16 < end && cluster.endUtf16 > start);
}

export function regionText(map: TextMap, sourceNodeId: string): string {
  const region = map.hitRegions.find((item) => item.sourceNodeId === sourceNodeId);
  if (!region?.fragments.length) return "";
  const start = region.fragments.reduce((minimum, fragment) => Math.min(minimum, fragment.startUtf16), Infinity);
  const end = region.fragments.reduce((maximum, fragment) => Math.max(maximum, fragment.endUtf16), 0);
  return map.logicalText.slice(start, end);
}

export function hitRegionAtPoint(map: TextMap, page: number, x: number, y: number) {
  return map.hitRegions.find((region) => region.fragments.some((fragment) => fragment.page === page
    && x >= fragment.xPt && x <= fragment.xPt + fragment.widthPt
    && y >= fragment.yPt && y <= fragment.yPt + fragment.heightPt));
}

export function linkAtPoint(map: TextMap, page: number, x: number, y: number) {
  const cluster = map.clusters.find((cluster) => cluster.page === page
    && x >= cluster.xPt && x <= cluster.xPt + cluster.widthPt
    && y >= cluster.yPt && y <= cluster.yPt + cluster.heightPt);
  return cluster && (map.links ?? []).find((link) => link.sourceNodeId === cluster.sourceNodeId
    && link.startUtf16 <= cluster.startUtf16 && link.endUtf16 >= cluster.endUtf16);
}
