import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { writeStoredString } from "../utils/resume";
const DEFAULT_EDITOR_PANE_WIDTH = 560;
const MIN_EDITOR_PANE_WIDTH = 360;
const MIN_PREVIEW_PANE_WIDTH = 360;
const SPLITTER_WIDTH = 12;

function getPaneWidthBounds(workspace: HTMLElement) {
  const workspaceWidth = workspace.getBoundingClientRect().width;
  const railWidth =
    workspace.querySelector<HTMLElement>(".rail")?.getBoundingClientRect()
      .width ?? 92;
  const maxEditorWidth = Math.max(
    MIN_EDITOR_PANE_WIDTH,
    workspaceWidth - railWidth - SPLITTER_WIDTH - MIN_PREVIEW_PANE_WIDTH,
  );
  return {
    min: MIN_EDITOR_PANE_WIDTH,
    max: maxEditorWidth,
  };
}

function clampPaneWidth(value: number, bounds: { min: number; max: number }) {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

export function usePaneResize() {
  const workspaceRef = useRef<HTMLElement>(null);
  const resizeSessionRef = useRef({
    startX: 0,
    startWidth: DEFAULT_EDITOR_PANE_WIDTH,
    bounds: {
      min: MIN_EDITOR_PANE_WIDTH,
      max: DEFAULT_EDITOR_PANE_WIDTH,
    },
  });
  const pendingPointerXRef = useRef<number | null>(null);
  const dragWidthRef = useRef(DEFAULT_EDITOR_PANE_WIDTH);
  const dragFrameRef = useRef(0);
  const [editorPaneWidth, setEditorPaneWidth] = useState(() => {
    const stored = Number(
      window.localStorage.getItem("resume-diy-editor-pane-width"),
    );
    return Number.isFinite(stored) && stored > 0
      ? stored
      : DEFAULT_EDITOR_PANE_WIDTH;
  });
  const [paneBounds, setPaneBounds] = useState({
    min: MIN_EDITOR_PANE_WIDTH,
    max: DEFAULT_EDITOR_PANE_WIDTH,
  });
  const [isResizingPanes, setIsResizingPanes] = useState(false);
  // 分割条随窗口变化重新计算上下限，保证编辑器和预览都保留可用空间。
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const refreshBounds = () => {
      const bounds = getPaneWidthBounds(workspace);
      setPaneBounds(bounds);
      setEditorPaneWidth((current) => clampPaneWidth(current, bounds));
    };
    refreshBounds();
    const observer = new ResizeObserver(refreshBounds);
    observer.observe(workspace);
    window.addEventListener("resize", refreshBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refreshBounds);
    };
  }, []);

  useEffect(() => {
    writeStoredString(
      "resume-diy-editor-pane-width",
      String(Math.round(editorPaneWidth)),
    );
  }, [editorPaneWidth]);

  useEffect(() => {
    if (!isResizingPanes) return;
    const applyDragWidth = () => {
      dragFrameRef.current = 0;
      const pointerX = pendingPointerXRef.current;
      const workspace = workspaceRef.current;
      if (pointerX === null || !workspace) return;
      const nextWidth = clampPaneWidth(
        resizeSessionRef.current.startWidth +
          pointerX -
          resizeSessionRef.current.startX,
        resizeSessionRef.current.bounds,
      );
      dragWidthRef.current = nextWidth;
      const editorPane = workspace.querySelector<HTMLElement>(".editor-pane");
      if (!editorPane) return;
      const width = `${nextWidth}px`;
      editorPane.style.width = width;
      editorPane.style.minWidth = width;
      editorPane.style.flex = `0 0 ${width}`;
    };
    const handlePointerMove = (event: PointerEvent) => {
      pendingPointerXRef.current = event.clientX;
      if (dragFrameRef.current) return;
      dragFrameRef.current = window.requestAnimationFrame(applyDragWidth);
    };
    const stopResizing = () => {
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
        applyDragWidth();
      }
      setEditorPaneWidth(dragWidthRef.current);
      setIsResizingPanes(false);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing, { once: true });
    window.addEventListener("pointercancel", stopResizing, { once: true });
    return () => {
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = 0;
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, [isResizingPanes]);

  const beginPaneResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const workspace = workspaceRef.current;
    if (!workspace) return;
    resizeSessionRef.current = {
      startX: event.clientX,
      startWidth: editorPaneWidth,
      bounds: getPaneWidthBounds(workspace),
    };
    pendingPointerXRef.current = event.clientX;
    dragWidthRef.current = editorPaneWidth;
    setIsResizingPanes(true);
  };

  const handlePaneSplitterKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    const nextWidth =
      event.key === "Home"
        ? paneBounds.min
        : event.key === "End"
          ? paneBounds.max
          : editorPaneWidth + (event.key === "ArrowRight" ? 16 : -16);
    setEditorPaneWidth(clampPaneWidth(nextWidth, paneBounds));
  };

  const resetPaneWidth = () => {
    setEditorPaneWidth(clampPaneWidth(DEFAULT_EDITOR_PANE_WIDTH, paneBounds));
  };

  return {
    workspaceRef,
    editorPaneWidth,
    paneBounds,
    isResizingPanes,
    beginPaneResize,
    handlePaneSplitterKeyDown,
    resetPaneWidth,
  };
}
