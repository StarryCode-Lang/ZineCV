import { motion } from "../../motion/primitives";
import { useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { ModuleKey, PreviewPageLayout } from "../../domain/resume-model";
import type { EditorNavigationTarget } from "../../app/useEditorNavigation";

type PreviewInteractionLayerProps = {
  pages: PreviewPageLayout[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  previewPaneRef: RefObject<HTMLElement | null>;
  pagesRef: RefObject<HTMLDivElement | null>;
  onNavigateToEditor: (target: EditorNavigationTarget) => void;
};

type PreviewFragment = {
  key: string;
  pageIndex: number;
  blockIndex: number;
  label: string;
  target: EditorNavigationTarget;
};

type PointerStart = {
  x: number;
  y: number;
} | null;

type OutlineRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function buildFragments(
  pages: PreviewPageLayout[],
  moduleNames: Record<ModuleKey, string>,
  summaryTitle: string,
): PreviewFragment[] {
  return pages.flatMap((page, pageIndex): PreviewFragment[] =>
    page.blocks.flatMap((block, blockIndex): PreviewFragment[] => {
      const key = `${pageIndex}:${blockIndex}`;
      if (block.kind === "header")
        return [
          {
            key,
            pageIndex,
            blockIndex,
            label: `编辑第 ${pageIndex + 1} 页个人信息`,
            target: { kind: "basic" },
          },
        ];
      if (block.kind === "summary")
        return [
          {
            key,
            pageIndex,
            blockIndex,
            label: `编辑第 ${pageIndex + 1} 页${summaryTitle || "自我评价"}`,
            target: { kind: "summary" },
          },
        ];
      return [
        {
          key,
          pageIndex,
          blockIndex,
          label: `编辑第 ${pageIndex + 1} 页${moduleNames[block.module] || block.module}`,
          target: {
            kind: "module",
            module: block.module,
            entryIds: block.entryIds,
          },
        },
      ];
    }),
  );
}

function fragmentElement(
  pagesRef: RefObject<HTMLDivElement | null>,
  fragment: PreviewFragment,
) {
  const pagesRoot = pagesRef.current;
  if (!pagesRoot) return null;
  const paper = pagesRoot.querySelectorAll<HTMLElement>(
    ".paper:not(.layout-measure)",
  )[fragment.pageIndex];
  return paper?.querySelectorAll<HTMLElement>(
    ".paper-content > .preview-block",
  )[fragment.blockIndex];
}

function unionRect(elements: Element[]) {
  const rects = elements
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

function fragmentAtTarget(
  pagesRef: RefObject<HTMLDivElement | null>,
  fragmentsByKey: Map<string, PreviewFragment>,
  eventTarget: EventTarget | null,
) {
  const element = eventTarget instanceof Element ? eventTarget : null;
  const block = element?.closest<HTMLElement>(".preview-block");
  const paper = block?.closest<HTMLElement>(".paper:not(.layout-measure)");
  const pagesRoot = pagesRef.current;
  if (!block || !paper || !pagesRoot || !pagesRoot.contains(block)) return null;
  const paperIndex = Array.from(
    pagesRoot.querySelectorAll<HTMLElement>(".paper:not(.layout-measure)"),
  ).indexOf(paper);
  const blockIndex = Array.from(
    paper.querySelectorAll<HTMLElement>(".paper-content > .preview-block"),
  ).indexOf(block);
  if (paperIndex < 0 || blockIndex < 0) return null;
  const fragment = fragmentsByKey.get(`${paperIndex}:${blockIndex}`);
  if (!fragment) return null;
  const entry = element?.closest<HTMLElement>("[data-preview-entry-id]");
  if (!entry || !block.contains(entry) || fragment.target.kind !== "module")
    return fragment;
  if (fragment.target.kind !== "module") return fragment;
  return {
    ...fragment,
    target: {
      kind: "module" as const,
      module: fragment.target.module,
      entryId: entry.dataset.previewEntryId,
    },
  };
}

function revealFragment(
  pagesRef: RefObject<HTMLDivElement | null>,
  previewPaneRef: RefObject<HTMLElement | null>,
  fragment: PreviewFragment,
) {
  const element = fragmentElement(pagesRef, fragment);
  const pane = previewPaneRef.current;
  if (!element || !pane) return;
  const elementRect = element.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  const stickyHeaderBottom =
    pane
      .querySelector<HTMLElement>(".preview-workspace-header")
      ?.getBoundingClientRect().bottom ?? paneRect.top;
  const visibleTop = Math.max(paneRect.top, stickyHeaderBottom);
  let nextScrollTop = pane.scrollTop;
  if (elementRect.top < visibleTop)
    nextScrollTop += elementRect.top - visibleTop - 16;
  else if (elementRect.bottom > paneRect.bottom)
    nextScrollTop += elementRect.bottom - paneRect.bottom + 16;
  if (nextScrollTop === pane.scrollTop) return;
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  pane.scrollTo({
    top: Math.max(0, nextScrollTop),
    behavior: reducedMotion ? "auto" : "smooth",
  });
}

export function PreviewInteractionLayer({
  pages,
  moduleNames,
  summaryTitle,
  previewPaneRef,
  pagesRef,
  onNavigateToEditor,
}: PreviewInteractionLayerProps) {
  const reducedMotion = useReducedMotion();
  const fragments = useMemo(
    () => buildFragments(pages, moduleNames, summaryTitle),
    [moduleNames, pages, summaryTitle],
  );
  const fragmentsByKey = useMemo(
    () => new Map(fragments.map((fragment) => [fragment.key, fragment])),
    [fragments],
  );
  const pointerStartRef = useRef<PointerStart>(null);
  const hoverKeyRef = useRef<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const activeKey = hoverKey ?? selectedKey;
  const [outlineRect, setOutlineRect] = useState<OutlineRect | null>(null);
  const publishHover = useCallback((fragment: PreviewFragment | null) => {
    const nextKey = fragment?.key ?? null;
    if (hoverKeyRef.current === nextKey) return;
    hoverKeyRef.current = nextKey;
    setHoverKey(nextKey);
  }, []);

  useEffect(() => {
    if (!activeKey) {
      setOutlineRect(null);
      return;
    }
    const fragment = fragmentsByKey.get(activeKey);
    const pane = previewPaneRef.current;
    const pagesRoot = pagesRef.current;
    if (!fragment || !pane || !pagesRoot) {
      setOutlineRect(null);
      return;
    }
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const element = fragmentElement(pagesRef, fragment);
      const paper = element?.closest<HTMLElement>(
        ".paper:not(.layout-measure)",
      );
      if (!element || !paper) {
        setOutlineRect(null);
        return;
      }
      const visualElement =
        element.querySelector<HTMLElement>(":scope > .preview-section") ??
        element;
      const elementRect = visualElement.getBoundingClientRect();
      const title = visualElement.querySelector<HTMLElement>(
        ":scope > .preview-title",
      );
      const contentRect = title
        ? (unionRect(
            Array.from(visualElement.children).filter(
              (child) => child !== title,
            ),
          ) ?? elementRect)
        : elementRect;
      const nextBlock = element.nextElementSibling as HTMLElement | null;
      const nextVisual =
        nextBlock?.querySelector<HTMLElement>(":scope > .preview-section") ??
        nextBlock;
      const nextRect = nextVisual?.getBoundingClientRect();
      const paperRect = paper.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      const stickyHeaderBottom =
        pane
          .querySelector<HTMLElement>(".preview-workspace-header")
          ?.getBoundingClientRect().bottom ?? paneRect.top;
      // The outline is rendered through a body portal so it can track scaled
      // paper geometry. Clamp it below the sticky preview toolbar; otherwise a
      // scrolled or enlarged first page can paint above the visible paper area.
      const visibleTop = Math.max(paneRect.top + 1, stickyHeaderBottom + 1);
      const left = Math.max(
        contentRect.left - 4,
        paperRect.left + 1,
        paneRect.left + 1,
      );
      const top = Math.max(
        contentRect.top - 3,
        title ? title.getBoundingClientRect().bottom + 1 : -Infinity,
        paperRect.top + 1,
        visibleTop,
      );
      const right = Math.min(
        contentRect.right + 4,
        paperRect.right - 1,
        paneRect.right - 1,
      );
      const bottom = Math.min(
        contentRect.bottom + 3,
        nextRect ? nextRect.top - 1 : Infinity,
        paperRect.bottom - 1,
        paneRect.bottom - 1,
      );
      setOutlineRect(
        right > left && bottom > top
          ? { left, top, width: right - left, height: bottom - top }
          : null,
      );
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(update);
    };
    schedule();
    pane.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(pagesRoot);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      pane.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
      observer.disconnect();
    };
  }, [activeKey, fragmentsByKey, pagesRef, previewPaneRef]);

  useEffect(() => {
    const pagesRoot = pagesRef.current;
    if (!pagesRoot) return;
    const onPointerMove = (event: PointerEvent) => {
      const fragment = fragmentAtTarget(pagesRef, fragmentsByKey, event.target);
      publishHover(fragment);
    };
    const onPointerLeave = () => {
      pointerStartRef.current = null;
      publishHover(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0)
        pointerStartRef.current = { x: event.clientX, y: event.clientY };
    };
    const onClick = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      if (
        event.button !== 0 ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        element?.closest("a")
      ) {
        pointerStartRef.current = null;
        return;
      }
      const pointerStart = pointerStartRef.current;
      pointerStartRef.current = null;
      if (
        pointerStart &&
        Math.hypot(
          event.clientX - pointerStart.x,
          event.clientY - pointerStart.y,
        ) > 5
      )
        return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const fragment = fragmentAtTarget(pagesRef, fragmentsByKey, event.target);
      if (fragment) {
        setSelectedKey(fragment.key);
        onNavigateToEditor(fragment.target);
      }
    };
    pagesRoot.addEventListener("pointermove", onPointerMove);
    pagesRoot.addEventListener("pointerleave", onPointerLeave);
    pagesRoot.addEventListener("pointerdown", onPointerDown);
    pagesRoot.addEventListener("click", onClick);
    return () => {
      pagesRoot.removeEventListener("pointermove", onPointerMove);
      pagesRoot.removeEventListener("pointerleave", onPointerLeave);
      pagesRoot.removeEventListener("pointerdown", onPointerDown);
      pagesRoot.removeEventListener("click", onClick);
    };
  }, [fragmentsByKey, onNavigateToEditor, pagesRef, publishHover]);

  return (
    <>
      <div className="preview-interaction-layer" aria-label="预览编辑定位">
        <div className="preview-interaction-controls">
          {fragments.map((fragment) => (
            <button
              className="preview-interaction-button"
              key={fragment.key}
              type="button"
              aria-label={fragment.label}
              onFocus={() => {
                publishHover(fragment);
                revealFragment(pagesRef, previewPaneRef, fragment);
              }}
              onBlur={() => {
                if (hoverKeyRef.current === fragment.key) publishHover(null);
              }}
              onClick={() => {
                setSelectedKey(fragment.key);
                onNavigateToEditor(fragment.target);
              }}
            >
              {fragment.label}
            </button>
          ))}
        </div>
      </div>
      {outlineRect
        ? createPortal(
            <motion.div
              initial={{ ...outlineRect, opacity: reducedMotion ? 1 : 0 }}
              transition={{ duration: reducedMotion ? 0 : 0.14 }}
              className={`preview-interaction-outline ${!hoverKey && selectedKey ? "selected" : ""}`}
              aria-hidden="true"
              animate={{
                opacity: 1,
                left: outlineRect.left,
                top: outlineRect.top,
                width: outlineRect.width,
                height: outlineRect.height,
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}
