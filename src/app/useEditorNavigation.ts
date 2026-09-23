import { useLayoutEffect, type RefObject } from "react";
import type { ModuleKey } from "../domain/resume-model";

export type EditorNavigationTarget =
  | { kind: "basic" }
  | { kind: "summary" }
  | {
      kind: "module";
      module: ModuleKey;
      entryId?: string;
      entryIds?: string[];
    };

type EditorNavigationOptions = {
  active: boolean;
  target: EditorNavigationTarget | null;
  editorScrollRef: RefObject<HTMLDivElement | null>;
  onSettled: () => void;
};

type NavigationNode = HTMLElement & {
  focus: (options?: FocusOptions) => void;
};

function findNavigationNode(
  root: HTMLElement,
  target: EditorNavigationTarget,
): { scrollNode: NavigationNode; focusNode: NavigationNode } | null {
  if (target.kind === "basic") {
    const card = root.querySelector<NavigationNode>(
      '[data-editor-target="basic"]',
    );
    const focusNode =
      card?.querySelector<NavigationNode>("[data-editor-focus]") ?? card;
    return card && focusNode ? { scrollNode: card, focusNode } : null;
  }

  const moduleKey = target.kind === "summary" ? "summary" : target.module;
  const moduleNode = Array.from(
    root.querySelectorAll<NavigationNode>("[data-editor-module]"),
  ).find((node) => node.dataset.editorModule === moduleKey);
  if (!moduleNode) return null;

  if (target.kind === "summary") {
    const focusNode =
      moduleNode.querySelector<NavigationNode>("[data-editor-focus]") ??
      moduleNode;
    return { scrollNode: moduleNode, focusNode };
  }

  const requestedIds = target.entryId
    ? [target.entryId]
    : target.entryIds?.length
      ? target.entryIds
      : [];
  const entryNode = requestedIds.length
    ? Array.from(
        moduleNode.querySelectorAll<NavigationNode>("[data-editor-entry-id]"),
      ).find((node) => requestedIds.includes(node.dataset.editorEntryId ?? ""))
    : null;
  const scrollNode = entryNode ?? moduleNode;
  const focusNode =
    scrollNode.querySelector<NavigationNode>("[data-editor-focus]") ??
    scrollNode;
  return { scrollNode, focusNode };
}

function rectSignature(node: HTMLElement) {
  const rect = node.getBoundingClientRect();
  return [rect.top, rect.left, rect.width, rect.height].join(":");
}

function pulseNavigationTarget(node: HTMLElement) {
  document
    .querySelectorAll<HTMLElement>(".editor-navigation-target-active")
    .forEach((current) =>
      current.classList.remove("editor-navigation-target-active"),
    );
  node.classList.remove("editor-navigation-target-active");
  void node.offsetWidth;
  node.classList.add("editor-navigation-target-active");
  window.setTimeout(() => {
    node.classList.remove("editor-navigation-target-active");
  }, 1400);
}

// 预览点击后的左侧定位只作用于编辑滚动容器，不把右侧纸张带入滚动。
export function useEditorNavigation({
  active,
  target,
  editorScrollRef,
  onSettled,
}: EditorNavigationOptions) {
  useLayoutEffect(() => {
    if (!active || !target) return;
    const root = editorScrollRef.current;
    if (!root) {
      onSettled();
      return;
    }

    let cancelled = false;
    let frame = 0;
    let previousSignature = "";
    let stableFrames = 0;

    const finish = () => {
      if (cancelled) return;
      const resolved = findNavigationNode(root, target);
      if (resolved) {
        const rootRect = root.getBoundingClientRect();
        const nodeRect = resolved.scrollNode.getBoundingClientRect();
        const nextScrollTop = Math.max(
          0,
          root.scrollTop + nodeRect.top - rootRect.top - 24,
        );
        const reducedMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        root.scrollTo({
          top: nextScrollTop,
          behavior: reducedMotion ? "auto" : "smooth",
        });
        resolved.focusNode.focus({ preventScroll: true });
        pulseNavigationTarget(resolved.scrollNode);
      }
      onSettled();
    };

    const waitForStableGeometry = () => {
      if (cancelled) return;
      const resolved = findNavigationNode(root, target);
      if (!resolved) {
        if (frame >= 90) finish();
        else {
          frame += 1;
          window.requestAnimationFrame(waitForStableGeometry);
        }
        return;
      }
      const signature = rectSignature(resolved.scrollNode);
      stableFrames = signature === previousSignature ? stableFrames + 1 : 0;
      previousSignature = signature;
      if (stableFrames >= 2 || frame >= 90) finish();
      else {
        frame += 1;
        window.requestAnimationFrame(waitForStableGeometry);
      }
    };

    window.requestAnimationFrame(waitForStableGeometry);
    return () => {
      cancelled = true;
    };
  }, [active, editorScrollRef, onSettled, target]);
}
