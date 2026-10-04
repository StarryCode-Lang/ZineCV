import { useEffect, useMemo, useRef, useState } from "react";
import type { PreviewResult } from "../../src-tauri/src/domain/bindings/PreviewResult";
import { EnginePageCache, type PageLease } from "./enginePreview";
import { hitRegionAtPoint, linkAtPoint, offsetAtPoint, regionText, selectedClusters, selectedText, type LogicalSelection } from "./textSelection";

/** Rollout consumer: callers supply a verified, current frozen preview frame. */
export function EngineSvgPages({ result, zoomPercent = 100, onLocate, onOpenLink }: { result: PreviewResult; zoomPercent?: number; onLocate?: (sourceNodeId: string) => void; onOpenLink?: (href: string) => void }) {
  const cache = useMemo(() => new EnginePageCache(), []);
  const heldPages = useRef<PageLease[]>([]);
  const [frame, setFrame] = useState<{ result: PreviewResult | null; pages: PageLease[] }>({ result: null, pages: [] });
  const pages = frame.pages;
  const [selection, setSelection] = useState<LogicalSelection | null>(null);
  const [activeRegion, setActiveRegion] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const map = (frame.result ?? result).data.textMap;
  const highlights = useMemo(() => {
    const byPage = new Map<number, ReturnType<typeof selectedClusters>>();
    if (selection) for (const cluster of selectedClusters(map, selection)) {
      const fragments = byPage.get(cluster.page) ?? [];
      fragments.push(cluster); byPage.set(cluster.page, fragments);
    }
    return byPage;
  }, [map, selection]);
  const scale = Math.min(200, Math.max(20, zoomPercent)) / 100;
  useEffect(() => {
    const leases: PageLease[] = [];
    try {
      for (const page of result.data.pages) leases.push(cache.acquire(page));
      const previous = heldPages.current;
      heldPages.current = leases;
      setFrame({ result, pages: leases });
      for (const lease of previous) lease.release();
    } catch (error) {
      for (const lease of leases) lease.release();
      throw error;
    }
  }, [cache, result]);
  useEffect(() => () => { for (const lease of heldPages.current) lease.release(); heldPages.current = []; cache.dispose(); }, [cache]);
  useEffect(() => { setSelection(null); setActiveRegion(null); dragging.current = null; }, [result.renderKey]);
  const pointAtClient = (x: number, y: number) => {
    if (frame.result?.renderKey !== result.renderKey) return null;
    let best: { page: number; rect: DOMRect } | undefined;
    let distance = Infinity;
    for (const element of root.current?.querySelectorAll<HTMLElement>("[data-page-number]") ?? []) {
      const rect = element.getBoundingClientRect();
      const dx = Math.max(rect.left - x, 0, x - rect.right);
      const dy = Math.max(rect.top - y, 0, y - rect.bottom);
      if (dx * dx + dy * dy < distance) { distance = dx * dx + dy * dy; best = { page: Number(element.dataset.pageNumber), rect }; }
    }
    return best ? { page: best.page, x: (x - best.rect.left) / (4 / 3 * scale), y: (y - best.rect.top) / (4 / 3 * scale) } : null;
  };
  const offsetAtClient = (x: number, y: number) => { const point = pointAtClient(x, y); return point && offsetAtPoint(map, point.page, point.x, point.y); };
  const extendAfterScroll = useRef<() => void>(() => {});
  extendAfterScroll.current = () => {
    if (dragging.current === null || !pointer.current) return;
    const offset = offsetAtClient(pointer.current.x, pointer.current.y);
    if (offset !== null) setSelection((current) => current && { ...current, focus: offset });
  };
  useEffect(() => {
    const extend = () => extendAfterScroll.current();
    document.addEventListener("scroll", extend, true);
    return () => document.removeEventListener("scroll", extend, true);
  }, []);
  const openLink = (href: string) => { if (onOpenLink) onOpenLink(href); else window.open(href, "_blank", "noopener,noreferrer"); };
  return (
    <div ref={root} className="engine-preview-pages" data-render-key={frame.result?.renderKey ?? ""} tabIndex={0}
      aria-busy={frame.result?.renderKey !== result.renderKey}
      aria-label={`简历预览，共 ${result.data.pages.length} 页`}
      onPointerDown={(event) => {
        if (event.button !== 0 || !(event.target as HTMLElement).closest("[data-page-number]")) return;
        const offset = offsetAtClient(event.clientX, event.clientY);
        if (offset === null) return;
        previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        pointer.current = { x: event.clientX, y: event.clientY };
        dragging.current = event.pointerId; setSelection({ anchor: offset, focus: offset });
        event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (dragging.current === event.pointerId) { pointer.current = { x: event.clientX, y: event.clientY }; const offset = offsetAtClient(event.clientX, event.clientY); if (offset !== null) setSelection((current) => current && { ...current, focus: offset }); }
        else { const point = pointAtClient(event.clientX, event.clientY); setActiveRegion(point ? hitRegionAtPoint(map, point.page, point.x, point.y)?.sourceNodeId ?? null : null); }
      }}
      onPointerLeave={() => { if (dragging.current === null) setActiveRegion(null); }}
      onPointerUp={(event) => {
        if (dragging.current === event.pointerId && selection?.anchor === selection?.focus) {
          const point = pointAtClient(event.clientX, event.clientY);
          if (point) { const link = linkAtPoint(map, point.page, point.x, point.y); if (link) openLink(link.href); else { const region = hitRegionAtPoint(map, point.page, point.x, point.y); if (region) onLocate?.(region.sourceNodeId); } }
        }
        dragging.current = null;
        pointer.current = null;
      }}
      onPointerCancel={() => { dragging.current = null; pointer.current = null; }}
      onCopy={(event) => { if (selection && selection.anchor !== selection.focus) { event.clipboardData.setData("text/plain", selectedText(map, selection)); event.preventDefault(); } }}
      onKeyDown={(event) => { if (event.key === "Escape") { setSelection(null); setActiveRegion(null); dragging.current = null; (previousFocus.current?.isConnected ? previousFocus.current : root.current)?.focus({ preventScroll: true }); event.preventDefault(); } }}
      style={{ display: "grid", gap: 16, justifyItems: "center" }}>
      {pages.map(({ page, url }, index) => (
        <div key={`${index}:${page.pageHash}`} data-page-hash={page.pageHash} data-page-number={index + 1}
          style={{ position: "relative", width: page.widthPt * 4 / 3 * scale, height: page.heightPt * 4 / 3 * scale, background: "white" }}>
          <img src={url} alt={`简历第 ${index + 1} 页`} draggable={false}
            style={{ display: "block", width: "100%", height: "100%", userSelect: "none" }} />
          {(highlights.get(index + 1) ?? []).map((cluster) => (
            <span key={`${cluster.logicalOrder}:${cluster.startUtf16}`} aria-hidden="true" data-selection-fragment="true"
              style={{ position: "absolute", pointerEvents: "none", background: "rgba(70,130,220,.3)", left: cluster.xPt * 4 / 3 * scale, top: cluster.yPt * 4 / 3 * scale, width: cluster.widthPt * 4 / 3 * scale, height: cluster.heightPt * 4 / 3 * scale }} />
          ))}
          {map.hitRegions.find((region) => region.sourceNodeId === activeRegion)?.fragments.filter((fragment) => fragment.page === index + 1).map((fragment, fragmentIndex) => (
            <span key={fragmentIndex} aria-hidden="true" data-hit-source={activeRegion}
              style={{ position: "absolute", pointerEvents: "none", boxSizing: "border-box", border: "1px solid #2563eb", left: fragment.xPt * 4 / 3 * scale, top: fragment.yPt * 4 / 3 * scale, width: fragment.widthPt * 4 / 3 * scale, height: fragment.heightPt * 4 / 3 * scale }} />
          ))}
        </div>
      ))}
      <details style={{ justifySelf: "stretch" }}><summary>按内容定位</summary>
      <nav aria-label="简历内容定位" style={{ display: "grid", gap: 8 }}>
        {[...map.hitRegions].sort((a, b) => a.semanticOrder - b.semanticOrder).map((region) => (
          <button key={region.sourceNodeId} type="button" data-source-node-id={region.sourceNodeId}
            onFocus={(event) => { setActiveRegion(region.sourceNodeId); if (!root.current?.contains(event.relatedTarget as Node)) previousFocus.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null; }}
            onBlur={() => setActiveRegion(null)}
            onClick={() => { if (frame.result?.renderKey !== result.renderKey) return; const fragment = region.fragments[0]; root.current?.querySelector(`[data-page-number="${fragment?.page}"]`)?.scrollIntoView({ block: "nearest" }); onLocate?.(region.sourceNodeId); }}>
            {regionText(map, region.sourceNodeId)}
          </button>
        ))}
        {(map.links ?? []).map((link) => <a key={`${link.sourceNodeId}:${link.startUtf16}`} href={link.href} target="_blank" rel="noopener noreferrer"
          onClick={(event) => { event.preventDefault(); openLink(link.href); }}>{map.logicalText.slice(link.startUtf16, link.endUtf16)}</a>)}
      </nav></details>
    </div>
  );
}
