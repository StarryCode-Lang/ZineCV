import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import "../../styles/imported-source-preview.css";

type SourcePreviewRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function ImportedSourcePreviewOverlay({ src }: { src: string | null }) {
  const [rect, setRect] = useState<SourcePreviewRect | null>(null);
  const [fullscreenRoot, setFullscreenRoot] = useState<Element | null>(null);

  useLayoutEffect(() => {
    const updateFullscreenRoot = () =>
      setFullscreenRoot(document.fullscreenElement);
    document.addEventListener("fullscreenchange", updateFullscreenRoot);
    updateFullscreenRoot();
    return () =>
      document.removeEventListener("fullscreenchange", updateFullscreenRoot);
  }, []);

  useLayoutEffect(() => {
    if (!src) {
      setRect(null);
      return;
    }
    const pane = document.querySelector<HTMLElement>(".preview-pane");
    const pages = pane?.querySelector<HTMLElement>(".resume-pages");
    if (!pane || !pages) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const paper = pages.querySelector<HTMLElement>(".paper-frame .paper");
      if (!paper) return;
      const bounds = paper.getBoundingClientRect();
      const next = {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
      setRect((current) =>
        current &&
        current.left === next.left &&
        current.top === next.top &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(pane);
    resizeObserver.observe(pages);
    const firstFrame = pages.querySelector<HTMLElement>(".paper-frame");
    if (firstFrame) resizeObserver.observe(firstFrame);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(pages, {
      attributes: true,
      attributeFilter: ["style"],
    });
    pane.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("fullscreenchange", schedule);
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      pane.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("fullscreenchange", schedule);
    };
  }, [src]);

  if (!src || !rect || rect.width <= 0 || rect.height <= 0) return null;
  return createPortal(
    <img
      className="imported-source-preview"
      data-imported-source-preview
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={rect}
    />,
    fullscreenRoot ?? document.body,
  );
}
