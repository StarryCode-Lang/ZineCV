import { useEffect, type RefObject } from "react";
import type { ModuleKey, PreviewPageLayout } from "../../domain/resume-model";

export type PreviewOverflowFinding = {
  pageIndex: number;
  blockKey: "header" | "summary" | ModuleKey;
  entryId: string | null;
  overflowPx: number;
};

type PreviewOverflowGuardProps = {
  pages: PreviewPageLayout[];
  pagesRef: RefObject<HTMLDivElement | null>;
  measurementRef: RefObject<HTMLDivElement | null>;
  onChange: (finding: PreviewOverflowFinding | null) => void;
};

function readOverflow(
  pagesRef: RefObject<HTMLDivElement | null>,
  measurementRef: RefObject<HTMLDivElement | null>,
): PreviewOverflowFinding | null {
  const pagesRoot = pagesRef.current;
  const measurement = measurementRef.current;
  if (!pagesRoot || !measurement || !measurement.isConnected) return null;

  const papers = Array.from(
    pagesRoot.querySelectorAll<HTMLElement>(".paper:not(.layout-measure)"),
  );
  for (const [pageIndex, paper] of papers.entries()) {
    const paperRect = paper.getBoundingClientRect();
    if (paperRect.width <= 0 || paperRect.height <= 0) continue;
    const computed = window.getComputedStyle(paper);
    const scale = paper.offsetHeight
      ? paperRect.height / paper.offsetHeight
      : 1;
    const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
    const usableBottom = paperRect.bottom - paddingBottom * scale;
    const content = paper.querySelector<HTMLElement>(".paper-content");
    if (!content) continue;

    const contentOverflow =
      content.getBoundingClientRect().bottom - usableBottom;
    if (contentOverflow <= 1.5) continue;

    const blocks = Array.from(
      content.querySelectorAll<HTMLElement>(":scope > .preview-block"),
    );
    const block = blocks.find(
      (candidate) =>
        candidate.getBoundingClientRect().bottom > usableBottom + 1.5,
    );
    const entry = block
      ? Array.from(
          block.querySelectorAll<HTMLElement>("[data-preview-entry-id]"),
        ).find(
          (candidate) =>
            candidate.getBoundingClientRect().bottom > usableBottom + 1.5,
        )
      : null;
    const blockKey = block?.dataset.layoutBlock;
    if (blockKey !== "header" && blockKey !== "summary" && !blockKey) continue;

    return {
      pageIndex,
      blockKey: blockKey as PreviewOverflowFinding["blockKey"],
      entryId: entry?.dataset.previewEntryId ?? null,
      overflowPx: Math.round(contentOverflow * 10) / 10,
    };
  }
  return null;
}

// 只读检测可见 A4 的实际内容底部；不改变分页、字号、页距或纸张 DOM。
export function PreviewOverflowGuard({
  pages,
  pagesRef,
  measurementRef,
  onChange,
}: PreviewOverflowGuardProps) {
  useEffect(() => {
    let active = true;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (active) onChange(readOverflow(pagesRef, measurementRef));
    };
    const schedule = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(measure);
      });
    };
    const pagesRoot = pagesRef.current;
    const measurement = measurementRef.current;
    const resizeObserver = new ResizeObserver(schedule);
    if (pagesRoot) resizeObserver.observe(pagesRoot);
    if (measurement) resizeObserver.observe(measurement);
    const mutationObserver = pagesRoot ? new MutationObserver(schedule) : null;
    if (mutationObserver && pagesRoot)
      mutationObserver.observe(pagesRoot, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    schedule();
    return () => {
      active = false;
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [measurementRef, onChange, pages, pagesRef]);

  return null;
}
