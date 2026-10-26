import type * as React from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  AgentAnchorSetting,
  AgentModeSetting,
  AgentSizeSetting,
} from "../../../platform/settings";
import {
  measureOverlay,
  type AgentAnchor,
  type FixedRect
} from "../agentOverlayUtils";
import type {
  AgentView
} from "../types";
import { AgentMode } from './shared';
export function runSyncPointerPosition2(context: {
  pointerPosition: RefObject<{ x: number; y: number; }>;
  lastAltRelease: RefObject<number>;
  summonedAnchor: RefObject<AgentAnchor | null>;
  anchorRef: RefObject<AgentAnchor | null>;
  panelSizes: AgentSizeSetting;
  positionRef: RefObject<FixedRect | null>;
  setPosition: Dispatch<SetStateAction<FixedRect>>;
  setModeRef: RefObject<(next: AgentMode) => void>;
}): () => void {
  const {
    pointerPosition, lastAltRelease, summonedAnchor, anchorRef, panelSizes, positionRef, setPosition,
    setModeRef,
  } = context;

  const onPointer = (event: globalThis.PointerEvent) => {
    pointerPosition.current = { x: event.clientX, y: event.clientY };
  };
  const onKeyUp = (event: globalThis.KeyboardEvent) => {
    if (
      event.key !== "Alt" ||
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const now = performance.now();
    if (lastAltRelease.current === 0 || now - lastAltRelease.current > 450) {
      lastAltRelease.current = now;
      return;
    }
    lastAltRelease.current = 0;
    if (summonedAnchor.current) {
      anchorRef.current = summonedAnchor.current;
      summonedAnchor.current = null;
      const next = measureOverlay("bot", anchorRef.current, panelSizes);
      positionRef.current = next;
      setPosition(next);
      setModeRef.current("bot");
    } else {
      const rect = positionRef.current;
      summonedAnchor.current =
        anchorRef.current ??
        (rect
          ? {
            right: rect.left + rect.width,
            bottom: rect.top + rect.height,
          }
          : null);
      anchorRef.current = {
        right: pointerPosition.current.x + 28,
        bottom: pointerPosition.current.y + 28,
      };
      const next = measureOverlay("chat", anchorRef.current, panelSizes);
      positionRef.current = next;
      setPosition(next);
      setModeRef.current("chat");
    }
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("keyup", onKeyUp);
  return () => {
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("keyup", onKeyUp);
  };

}

export function runSyncDragRef4(context: {
  dragRef: RefObject<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean; } | null>;
  freezeDockUntil: RefObject<number>;
  modeValue: AgentMode;
  anchorRef: RefObject<AgentAnchor | null>;
  panelSizes: AgentSizeSetting;
  positionRef: RefObject<FixedRect | null>;
  setPosition: Dispatch<SetStateAction<FixedRect>>;
  activeView: AgentView;
}): () => void {
  const { dragRef, freezeDockUntil, modeValue, anchorRef, panelSizes, positionRef, setPosition, activeView } = context;

  let raf = 0;
  const schedule = () => {
    if (
      dragRef.current ||
      (performance.now() < freezeDockUntil.current &&
        !document.querySelector(".template-library-rename-form"))
    )
      return;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(scheduleDock);
  };
  const scheduleDock = () => {
    raf = 0;
    const next = measureOverlay(modeValue, anchorRef.current, panelSizes);
    const renameForm = document.querySelector(".template-library-rename-form");
    if (renameForm && modeValue !== "bot") {
      const form = renameForm.getBoundingClientRect();
      const overlaps = (rect: FixedRect) =>
        rect.left < form.right + 8 &&
        rect.left + rect.width > form.left - 8 &&
        rect.top < form.bottom + 8 &&
        rect.top + rect.height > form.top - 8;
      if (overlaps(next)) {
        const viewportRight =
          (window.visualViewport?.offsetLeft ?? 0) +
          (window.visualViewport?.width ?? window.innerWidth);
        const besideForm = { ...next, left: viewportRight - next.width - 8 };
        if (!overlaps(besideForm)) next.left = besideForm.left;
      }
    }
    const current = positionRef.current;
    if (
      current &&
      current.left === next.left &&
      current.top === next.top &&
      current.width === next.width &&
      current.height === next.height
    )
      return;
    positionRef.current = next;
    setPosition(next);
  };
  window.addEventListener("resize", schedule);
  const formObserver = activeView === "templates" ? new MutationObserver(schedule) : null;
  formObserver?.observe(document.body, { childList: true, subtree: true });
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule, {
    passive: true,
  });
  scheduleDock();
  return () => {
    if (raf) cancelAnimationFrame(raf);
    formObserver?.disconnect();
    window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
  };

}

export function runBeginDrag(context: {
  positionRef: RefObject<FixedRect | null>;
  modeValue: AgentMode;
  dragRef: RefObject<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean; } | null>;
}, event: React.PointerEvent<HTMLElement>): void {
  const { positionRef, modeValue, dragRef } = context;

  if (event.button !== 0 || !positionRef.current) return;
  const target = event.target as Element;
  if (modeValue === "bot") {
    if (!target.closest(".agent-bot-button")) return;
  } else if (!target.closest(".agent-header") || target.closest("button")) {
    return;
  }
  const rect = positionRef.current;
  dragRef.current = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    left: rect.left,
    top: rect.top,
    moved: false,
  };
  document.body.classList.add("agent-is-dragging");
  if (modeValue !== "bot") event.preventDefault();

}

export function runMoveDrag(context: {
  dragRef: RefObject<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean; } | null>;
  positionRef: RefObject<FixedRect | null>;
  setPosition: Dispatch<SetStateAction<FixedRect>>;
}, event: React.PointerEvent<HTMLElement>): void {
  const { dragRef, positionRef, setPosition } = context;

  const drag = dragRef.current;
  if (!drag || drag.pointerId !== event.pointerId || !positionRef.current)
    return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) event.currentTarget.setPointerCapture(event.pointerId);
  drag.moved = true;
  const viewport = window.visualViewport;
  const leftMin = (viewport?.offsetLeft ?? 0) + 8;
  const topMin = (viewport?.offsetTop ?? 0) + 8;
  const leftMax =
    leftMin +
    (viewport?.width ?? window.innerWidth) -
    positionRef.current.width -
    16;
  const topMax =
    topMin +
    (viewport?.height ?? window.innerHeight) -
    positionRef.current.height -
    16;
  const next = {
    ...positionRef.current,
    left: Math.max(leftMin, Math.min(drag.left + dx, leftMax)),
    top: Math.max(topMin, Math.min(drag.top + dy, topMax)),
  };
  positionRef.current = next;
  setPosition(next);

}

export function runEndDrag(context: {
  dragRef: RefObject<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean; } | null>;
  positionRef: RefObject<FixedRect | null>;
  modeValue: AgentMode;
  suppressBotClick: RefObject<boolean>;
  anchorRef: RefObject<AgentAnchor | null>;
  onLayoutPreferenceChange: (key: "agentMode" | "agentPosition" | "agentSizes", value: AgentAnchorSetting | AgentSizeSetting | AgentModeSetting) => void;
}, event: React.PointerEvent<HTMLElement>): void {
  const { dragRef, positionRef, modeValue, suppressBotClick, anchorRef, onLayoutPreferenceChange } = context;

  const drag = dragRef.current;
  if (!drag || drag.pointerId !== event.pointerId) return;
  dragRef.current = null;
  document.body.classList.remove("agent-is-dragging");
  if (!drag.moved || !positionRef.current) return;
  if (modeValue === "bot") {
    suppressBotClick.current = true;
    window.setTimeout(() => {
      suppressBotClick.current = false;
    }, 0);
  }
  const rect = positionRef.current;
  const anchor = {
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  };
  anchorRef.current = anchor;
  onLayoutPreferenceChange("agentPosition", anchor);

}

export function runBeginResize(context: {
  positionRef: RefObject<FixedRect | null>;
  modeValue: AgentMode;
  resizeRef: RefObject<{ pointerId: number; x: number; y: number; width: number; height: number; } | null>;
}, event: React.PointerEvent<HTMLButtonElement>): void {
  const { positionRef, modeValue, resizeRef } = context;

  if (event.button !== 0 || !positionRef.current || modeValue !== "chat")
    return;
  event.stopPropagation();
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  resizeRef.current = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    width: positionRef.current.width,
    height: positionRef.current.height,
  };

}

export function runMoveResize(context: {
  resizeRef: RefObject<{ pointerId: number; x: number; y: number; width: number; height: number; } | null>;
  positionRef: RefObject<FixedRect | null>;
  modeValue: AgentMode;
  setPosition: Dispatch<SetStateAction<FixedRect>>;
}, event: React.PointerEvent<HTMLButtonElement>): void {
  const { resizeRef, positionRef, modeValue, setPosition } = context;

  const resize = resizeRef.current;
  const rect = positionRef.current;
  if (!resize || !rect || resize.pointerId !== event.pointerId) return;
  const width = Math.min(
    Math.max(340, resize.width + event.clientX - resize.x),
    window.innerWidth - rect.left - 8,
  );
  const height = Math.min(
    Math.max(
      modeValue === "chat" ? 350 : 194,
      resize.height + event.clientY - resize.y,
    ),
    window.innerHeight - rect.top - 8,
  );
  const next = { ...rect, width, height };
  positionRef.current = next;
  setPosition(next);

}

export function runEndResize(context: {
  resizeRef: RefObject<{ pointerId: number; x: number; y: number; width: number; height: number; } | null>;
  positionRef: RefObject<FixedRect | null>;
  panelSizes: AgentSizeSetting;
  modeValue: AgentMode;
  setPanelSizes: Dispatch<SetStateAction<AgentSizeSetting>>;
  anchorRef: RefObject<AgentAnchor | null>;
  onLayoutPreferenceChange: (key: "agentMode" | "agentPosition" | "agentSizes", value: AgentAnchorSetting | AgentSizeSetting | AgentModeSetting) => void;
}, event: React.PointerEvent<HTMLButtonElement>): void {
  const {
    resizeRef, positionRef, panelSizes, modeValue, setPanelSizes, anchorRef, onLayoutPreferenceChange,
  } = context;

  if (
    resizeRef.current?.pointerId !== event.pointerId ||
    !positionRef.current
  )
    return;
  resizeRef.current = null;
  const rect = positionRef.current;
  const sizes = {
    ...panelSizes,
    [modeValue]: { width: rect.width, height: rect.height },
  };
  setPanelSizes(sizes);
  anchorRef.current = {
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  };
  onLayoutPreferenceChange("agentSizes", sizes);
  onLayoutPreferenceChange("agentPosition", anchorRef.current);

}
