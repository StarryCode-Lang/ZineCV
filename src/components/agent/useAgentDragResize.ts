import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { PointerEvent } from "react";
import {
  measureOverlay,
  type AgentAnchor,
  type AgentMode,
  type FixedRect,
} from "./agent-overlay-utils";

export function useAgentDragResize(
  _initialMode: AgentMode,
  initialSizes: Record<"chat" | "composer", { width: number; height: number }>,
  agentPositionKey: string,
  agentSizeKey: string,
  agentModeKey: string,
  readAgentAnchor: () => AgentAnchor | null,
  readAgentMode: () => AgentMode,
  _readAgentSize: () => Record<
    "chat" | "composer",
    { width: number; height: number }
  >,
) {
  const [modeValue, setModeValue] = useState<AgentMode>(readAgentMode);
  const [panelSizes, setPanelSizes] = useState(initialSizes);
  const [position, setPosition] = useState<FixedRect>(() =>
    measureOverlay(readAgentMode(), readAgentAnchor(), initialSizes),
  );

  const positionRef = useRef<FixedRect | null>(position);
  const anchorRef = useRef<AgentAnchor | null>(readAgentAnchor());
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const suppressBotClick = useRef(false);
  const expandedMode = useRef<AgentMode>("composer");
  const freezeDockUntil = useRef(0);
  const lastAltRelease = useRef(0);
  const pointerPosition = useRef({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  });
  const summonedAnchor = useRef<AgentAnchor | null>(null);

  const setMode = useCallback(
    (
      next: AgentMode,
      _draftLength?: number,
      _textareaSelection?: number,
      _onSetMenu?: (menu: unknown) => void,
    ) => {
      if (next !== "bot") expandedMode.current = next;
      const nextRect = measureOverlay(next, anchorRef.current, panelSizes);
      positionRef.current = nextRect;
      setPosition(nextRect);
      setModeValue(next);
      try {
        localStorage.setItem(agentModeKey, next);
      } catch {
        // Ignore storage access error
      }
    },
    [panelSizes, agentModeKey],
  );

  useEffect(() => {
    const onPointer = (event: globalThis.PointerEvent) => {
      pointerPosition.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    return () => window.removeEventListener("pointermove", onPointer);
  }, []);

  useLayoutEffect(() => {
    let raf = 0;
    const schedule = () => {
      if (performance.now() < freezeDockUntil.current || dragRef.current)
        return;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(scheduleDock);
    };
    const scheduleDock = () => {
      raf = 0;
      const next = measureOverlay(modeValue, anchorRef.current, panelSizes);
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
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule, {
      passive: true,
    });
    scheduleDock();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [modeValue, panelSizes]);

  useEffect(
    () => () => document.body.classList.remove("agent-is-dragging"),
    [],
  );

  const beginDrag = (event: PointerEvent<HTMLElement>) => {
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
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
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
  };

  const endDrag = (event: PointerEvent<HTMLElement>) => {
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
    try {
      localStorage.setItem(agentPositionKey, JSON.stringify(anchor));
    } catch {
      // Ignore storage access error
    }
  };

  const beginResize = (event: PointerEvent<HTMLButtonElement>) => {
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
  };

  const moveResize = (event: PointerEvent<HTMLButtonElement>) => {
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
  };

  const endResize = (event: PointerEvent<HTMLButtonElement>) => {
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
    try {
      localStorage.setItem(agentSizeKey, JSON.stringify(sizes));
      localStorage.setItem(agentPositionKey, JSON.stringify(anchorRef.current));
    } catch {
      // Ignore storage access error
    }
  };

  return {
    modeValue,
    setModeValue,
    panelSizes,
    position,
    setPosition,
    positionRef,
    anchorRef,
    dragRef,
    resizeRef,
    suppressBotClick,
    expandedMode,
    freezeDockUntil,
    lastAltRelease,
    pointerPosition,
    summonedAnchor,
    setMode,
    beginDrag,
    moveDrag,
    endDrag,
    beginResize,
    moveResize,
    endResize,
  };
}
