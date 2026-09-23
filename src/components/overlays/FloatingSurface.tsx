import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Popovers follow their trigger and stay inside the visible viewport, including zoom.
export function FloatingSurface({
  anchor,
  onClose,
  children,
  matchWidth = false,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  matchWidth?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
      anchor?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [anchor]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const viewport = window.visualViewport;
    let frame = 0;
    const position = () => {
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const offsetX = viewport?.offsetLeft ?? 0;
      const offsetY = viewport?.offsetTop ?? 0;
      const edge = 8;
      const rect = anchor?.getBoundingClientRect();
      const clip = anchor
        ?.closest(".editor-scroll, .toolbar")
        ?.getBoundingClientRect();
      if (
        rect &&
        (rect.bottom <= offsetY ||
          rect.top >= offsetY + height ||
          (clip &&
            (rect.bottom <= clip.top ||
              rect.top >= clip.bottom ||
              rect.right <= clip.left ||
              rect.left >= clip.right)))
      ) {
        closeRef.current();
        return;
      }
      host.style.maxWidth = `${Math.max(0, width - edge * 2)}px`;
      if (matchWidth && rect)
        host.style.width = `${Math.min(rect.width, width - edge * 2)}px`;
      const below = rect
        ? height + offsetY - rect.bottom - edge * 2
        : height - edge * 2;
      const above = rect ? rect.top - offsetY - edge * 2 : 0;
      const naturalHeight = host.scrollHeight;
      const useAbove = below < Math.min(naturalHeight, 240) && above > below;
      const available = Math.max(80, useAbove ? above : below);
      host.style.maxHeight = `${Math.min(height - edge * 2, available)}px`;
      const box = host.getBoundingClientRect();
      const left = Math.max(
        offsetX + edge,
        Math.min(rect?.left ?? edge, offsetX + width - box.width - edge),
      );
      const proposedTop = rect
        ? useAbove
          ? rect.top - box.height - edge
          : rect.bottom + edge
        : offsetY + edge;
      const top = Math.max(
        offsetY + edge,
        Math.min(proposedTop, offsetY + height - box.height - edge),
      );
      host.style.left = `${left}px`;
      host.style.top = `${top}px`;
      host.dataset.placement = useAbove ? "above" : "below";
      host.style.visibility = "visible";
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    position();
    if (!host.contains(document.activeElement)) {
      const first =
        host.querySelector<HTMLElement>(
          '[aria-selected="true"], button.active',
        ) ??
        host.querySelector<HTMLElement>(
          'input:not([type="hidden"]), select, button:not(:disabled)',
        );
      first?.focus({ preventScroll: true });
    }
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    if (anchor) {
      observer.observe(anchor);
      const pane = anchor.closest(".editor-pane, .topbar");
      if (pane) observer.observe(pane);
    }
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    const outside = (event: PointerEvent) => {
      if (
        !host.contains(event.target as Node) &&
        !anchor?.contains(event.target as Node)
      )
        closeRef.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      document.removeEventListener("pointerdown", outside);
    };
  }, [anchor, matchWidth]);
  return createPortal(
    <div
      ref={hostRef}
      className="floating-host"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeRef.current();
          anchor?.focus({ preventScroll: true });
        }
        const menu = (event.target as HTMLElement).closest('[role="menu"]');
        if (
          menu &&
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          const controls = Array.from(
            menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          );
          const index = controls.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? controls.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    controls.length) %
                  controls.length;
          controls[next]?.focus();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
