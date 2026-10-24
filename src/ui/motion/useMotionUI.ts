import { useLayoutEffect } from "react";
import { hover } from "motion";
import { bindButtonPress } from "./buttonPress";
import { animate } from "motion/mini";
import {
  enterPresets,
  hoverTargets,
  motionTargets,
  pressTargets,
} from "./catalog";
import { motionTransitions } from "./primitives";

const properties = [
  "color",
  "backgroundColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "boxShadow",
  "opacity",
  "transform",
  "width",
] as const;
type Property = (typeof properties)[number];
type Snapshot = Record<Property, string>;
type ElementWithStyle = HTMLElement | SVGElement;
type Preset = {
  times: number[];
  keyframes: Record<string, (string | null)[]>;
  duration?: number;
  repeat?: string;
};
const presets: Record<string, Preset> = enterPresets;
const protectedContent =
  ".paper, .layout-measure, .paper-frame, .resume-pages, .preview-interaction-layer, .preview-interaction-outline";
const allTargetsSelector = `${motionTargets},${hoverTargets},${pressTargets}`;
const cssName = (name: string) =>
  name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const read = (element: Element) => {
  const style = getComputedStyle(element);
  return Object.fromEntries(
    properties.map((key) => [key, style[key]]),
  ) as Snapshot;
};

/**
 * CSS remains the source of final visual states. Motion owns interpolation and
 * hover recognition; button press feedback uses bounded native listeners.
 * Descendant hover rules and dynamic portals remain supported.
 * No wrapper nodes, React state, persistence, or document styles are involved.
 *
 * Scheduling note: DOM mutations are coalesced per animation frame and audit
 * work is scoped to the mutated subtree. The catalog contains no
 * sibling-combinator selectors, so a class/attribute change can only affect
 * the changed element and its descendants — scoping sync to that subtree
 * preserves the previous full-document semantics at a fraction of the cost.
 * Keystroke-level childList churn in the preview therefore no longer triggers
 * a whole-document style audit.
 */
export function useMotionUI() {
  useLayoutEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    type Entry = {
      snapshot: Snapshot;
      preset: string;
      animations: Map<string, () => void>;
      dispose: (() => void)[];
    };
    const entries = new Map<ElementWithStyle, Entry>();
    let disposed = false;
    const allowed = (element: Element): element is ElementWithStyle =>
      (element instanceof HTMLElement || element instanceof SVGElement) &&
      !element.closest(protectedContent);

    function play(
      element: ElementWithStyle,
      entry: Entry,
      property: string,
      values: (string | number | null)[],
      options: { duration: number; repeat?: number; times?: number[] },
    ) {
      entry.animations.get(property)?.();
      if (preference.matches || disposed) return;
      const key = cssName(property);
      const original = element.style.getPropertyValue(key);
      const priority = element.style.getPropertyPriority(key);
      const restore = () => {
        if (original) element.style.setProperty(key, original, priority);
        else element.style.removeProperty(key);
      };
      const animation = animate(
        element,
        { [property]: values },
        {
          ...options,
          ease: options.repeat ? "linear" : motionTransitions.standard.ease,
          onComplete: () => {
            if (entry.animations.get(property) !== cancel) return;
            restore();
            entry.animations.delete(property);
          },
        },
      );
      const cancel = () => {
        animation.cancel();
        restore();
        entry.animations.delete(property);
      };
      entry.animations.set(property, cancel);
    }

    function enter(element: ElementWithStyle, entry: Entry, name: string) {
      const preset = presets[name];
      if (!preset || preference.matches) return;
      for (const [property, values] of Object.entries(preset.keyframes)) {
        const target = getComputedStyle(element).getPropertyValue(
          cssName(property),
        );
        play(
          element,
          entry,
          property,
          values.map((value) => value ?? target),
          {
            duration: preset.duration ?? motionTransitions.standard.duration,
            times: preset.times,
            repeat: preset.repeat ? Infinity : 0,
          },
        );
      }
    }

    function sync(scope?: Element) {
      if (disposed) return;
      for (const [element, entry] of entries) {
        if (!element.isConnected) {
          entry.dispose.forEach((dispose) => dispose());
          [...entry.animations.values()].forEach((cancel) => cancel());
          entries.delete(element);
          continue;
        }
        if (scope && element !== scope && !scope.contains(element)) continue;
        if (element.matches(":disabled, [aria-disabled='true']")) {
          element.removeAttribute("data-motion-hover");
          element.removeAttribute("data-motion-press");
        }
        // Sample in-flight values before removing fills, then resolve the CSS
        // endpoint. Rapid reversal starts from the visible frame, not zero.
        const current = read(element);
        const running = new Set(entry.animations.keys());
        const name = getComputedStyle(element)
          .getPropertyValue("--motion-enter")
          .trim();
        // Only temporarily cancel transition properties; a live entry/spinner
        // is independent of unrelated hover or class updates.
        const changedPreset = name !== entry.preset;
        if (changedPreset)
          [...entry.animations.values()].forEach((cancel) => cancel());
        const desired: Snapshot = { ...current };
        if (running.size && !changedPreset) {
          // CSS endpoints are evaluated without Motion's effects. Keep the
          // animation objects and playback time intact across this read.
          const animations = element.getAnimations();
          const effects = animations.map((a) => [a, a.effect] as const);
          effects.forEach(([a]) => {
            a.effect = null;
          });
          Object.assign(desired, read(element));
          effects.forEach(([a, effect]) => {
            a.effect = effect;
          });
        } else Object.assign(desired, read(element));
        for (const property of properties) {
          if (
            property === "width" &&
            !element.matches(".workspace-splitter span")
          )
            continue;
          if (property === "transform" && element.matches(".module-card"))
            continue;
          if (desired[property] === entry.snapshot[property]) continue;
          play(
            element,
            entry,
            property,
            [
              running.has(property)
                ? current[property]
                : entry.snapshot[property],
              desired[property],
            ],
            { duration: motionTransitions.interaction.duration },
          );
        }
        entry.snapshot = desired;
        if (changedPreset) {
          entry.preset = name;
          enter(element, entry, name);
        }
      }
    }

    function gesture(
      element: ElementWithStyle,
      attribute: string,
      active: boolean,
    ) {
      if (active && element.matches(":disabled, [aria-disabled='true']"))
        return;
      element.toggleAttribute(attribute, active);
      sync(element);
    }

    function register(element: ElementWithStyle) {
      const name = getComputedStyle(element)
        .getPropertyValue("--motion-enter")
        .trim();
      const entry: Entry = {
        snapshot: read(element),
        preset: name,
        animations: new Map(),
        dispose: [],
      };
      entries.set(element, entry);
      if (element.matches(hoverTargets))
        entry.dispose.push(
          hover(element, () => {
            gesture(element, "data-motion-hover", true);
            return () => gesture(element, "data-motion-hover", false);
          }),
        );
      if (
        element.matches(pressTargets) &&
        element instanceof HTMLButtonElement
      ) {
        entry.dispose.push(
          bindButtonPress(element, (active) =>
            gesture(element, "data-motion-press", active),
          ),
        );
      }
      enter(element, entry, name);
    }

    function discoverIn(root: Element) {
      if (!root.isConnected) return;
      if (
        allowed(root) &&
        root.matches(allTargetsSelector) &&
        !entries.has(root as ElementWithStyle)
      ) {
        register(root as ElementWithStyle);
      }
      for (const element of root.querySelectorAll(allTargetsSelector)) {
        if (!allowed(element) || entries.has(element as ElementWithStyle))
          continue;
        register(element as ElementWithStyle);
      }
    }

    // rAF 合批调度：null 表示需要全量审计；否则只审计给定子树。结构删除
    // 追加 prune，避免离屏元素的 entry 在增量模式下长期滞留。
    let frame: number | null = null;
    let pendingScopes: (Element | null)[] = [];
    let pendingDiscover: Element[] = [];
    let pendingPrune = false;
    const flush = () => {
      frame = null;
      const scopes = pendingScopes;
      const discovered = pendingDiscover;
      const prune = pendingPrune;
      pendingScopes = [];
      pendingDiscover = [];
      pendingPrune = false;
      if (disposed) return;
      for (const node of discovered) discoverIn(node);
      if (scopes.includes(null)) {
        sync();
        return;
      }
      if (prune) {
        for (const [element, entry] of entries) {
          if (element.isConnected) continue;
          entry.dispose.forEach((dispose) => dispose());
          [...entry.animations.values()].forEach((cancel) => cancel());
          entries.delete(element);
        }
      }
      // 大子树吸收被包含的小子树，同一帧内不重复审计。
      const unique = [...new Set(scopes)].filter(
        (scope) => scope !== null && scope.isConnected,
      ) as Element[];
      const minimal = unique.filter(
        (scope) => !unique.some((other) => other !== scope && other.contains(scope)),
      );
      for (const scope of minimal) {
        discoverIn(scope);
        sync(scope);
      }
    };
    const schedule = (scope: Element | null) => {
      pendingScopes.push(scope);
      if (frame === null) frame = requestAnimationFrame(flush);
    };

    discoverIn(document.body);
    sync();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          schedule(record.target instanceof Element ? record.target : null);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) pendingDiscover.push(node);
        }
        if (record.removedNodes.length) pendingPrune = true;
        schedule(record.target instanceof Element ? record.target : null);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "aria-expanded",
        "aria-selected",
        "disabled",
        "aria-disabled",
      ],
    });
    // 焦点变化影响目标元素自身（:focus-visible）与祖先链（:focus-within），
    // 收窄到这条路径而不是全量审计。
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) {
        schedule(null);
        return;
      }
      schedule(event.target);
      for (
        let ancestor = event.target.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        schedule(ancestor);
      }
    };
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", focus);
    const reduce = () => {
      for (const [element, entry] of entries) {
        [...entry.animations.values()].forEach((cancel) => cancel());
        entry.snapshot = read(element);
        entry.preset = getComputedStyle(element)
          .getPropertyValue("--motion-enter")
          .trim();
        if (!preference.matches && presets[entry.preset]?.repeat)
          enter(element, entry, entry.preset);
      }
    };
    preference.addEventListener("change", reduce);
    return () => {
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", focus);
      preference.removeEventListener("change", reduce);
      for (const [element, entry] of entries) {
        entry.dispose.forEach((dispose) => dispose());
        [...entry.animations.values()].forEach((cancel) => cancel());
        element.removeAttribute("data-motion-hover");
        element.removeAttribute("data-motion-press");
      }
      entries.clear();
    };
  }, []);
}
