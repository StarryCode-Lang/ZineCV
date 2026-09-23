import { useLayoutEffect } from "react";
import { hover, press } from "motion";
import { animate } from "motion/mini";
import {
  enterPresets,
  hoverTargets,
  motionTargets,
  pressTargets,
} from "./catalog";
import { motionTransitions } from "../motion/primitives";

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
 * gesture recognition, including descendant hover rules and dynamic portals.
 * No wrapper nodes, React state, persistence, or document styles are involved.
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

    function discover() {
      for (const element of document.querySelectorAll(
        `${motionTargets},${hoverTargets},${pressTargets}`,
      )) {
        if (!allowed(element) || entries.has(element)) continue;
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
            press(element, () => {
              gesture(element, "data-motion-press", true);
              return () => gesture(element, "data-motion-press", false);
            }),
          );
        }
        enter(element, entry, name);
      }
    }

    discover();
    const observer = new MutationObserver(() => {
      discover();
      sync();
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
    const focus = () => sync();
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", focus);
    // Native buttons activate on Space as well as Enter. Motion press handles
    // Enter; Space here only supplies the visual state, never another click.
    const space = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        !(event.target instanceof HTMLButtonElement)
      )
        return;
      if (entries.has(event.target) && event.target.matches(pressTargets))
        gesture(event.target, "data-motion-press", event.type === "keydown");
    };
    const blur = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.hasAttribute("data-motion-press")
      )
        gesture(event.target, "data-motion-press", false);
    };
    document.addEventListener("keydown", space);
    document.addEventListener("keyup", space);
    document.addEventListener("focusout", blur);
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
      observer.disconnect();
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", focus);
      document.removeEventListener("keydown", space);
      document.removeEventListener("keyup", space);
      document.removeEventListener("focusout", blur);
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
