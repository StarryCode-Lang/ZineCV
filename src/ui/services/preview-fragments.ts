type Point = { node: Node; offset: number };
export type HtmlFragment = { html: string; height: number };
type Result = { fragments: HtmlFragment[]; freshPage: boolean };
const cache = new WeakMap<HTMLElement, { key: string; result: Result | null }>();

// Input is already rendered, sanitized preview DOM. Clone it without modifying
// the resume or measurement, and cut only at complete grapheme boundaries.
export function fragmentPreviewElement(element: HTMLElement, firstHeight: number, fullHeight: number, freshFirstHeight = fullHeight): Result | null {
  const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
  const key = JSON.stringify([element.innerHTML, bounds.width, bounds.height, style.font, style.letterSpacing, firstHeight, fullHeight, freshFirstHeight]);
  const prior = cache.get(element);
  if (prior?.key === key) return prior.result;
  const rich = element.matches(".preview-rich") ? element : element.querySelector(".preview-rich");
  if (!rich || !element.parentElement || fullHeight <= 0) return null;
  const points: Point[] = [];
  const walker = document.createTreeWalker(rich, NodeFilter.SHOW_TEXT);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    for (const segment of segmenter.segment(text.textContent ?? "")) {
      points.push({ node: text, offset: segment.index + segment.segment.length });
    }
  }
  if (!points.length) return null;
  points.push({ node: element, offset: element.childNodes.length });
  const scratch = element.cloneNode(false) as HTMLElement;
  Object.assign(scratch.style, { position: "absolute", visibility: "hidden", pointerEvents: "none", width: `${bounds.width}px`, height: "auto", top: "0", margin: "0" });
  element.parentElement.append(scratch);
  let start: Point = { node: element, offset: 0 }, cursor = 0, freshPage = false;
  const fragments: HtmlFragment[] = [];
  const build = (end: Point) => {
    const range = document.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    let content: Node = range.cloneContents();
    let ancestor = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement : range.commonAncestorContainer as HTMLElement;
    while (ancestor && ancestor !== element) {
      const wrapper = ancestor.cloneNode(false); wrapper.appendChild(content); content = wrapper; ancestor = ancestor.parentElement;
    }
    scratch.replaceChildren(content);
    // A range beginning at the end of a paragraph can clone an empty tail.
    // Remove only empty leading wrappers; intentional <br> lines stay intact.
    for (const selector of [".preview-entry-head", ".preview-entry-left", ".preview-meta", "p", "li"]) {
      const ancestor = start.node.parentElement?.closest(selector);
      const empty = scratch.querySelector(selector);
      if (ancestor && start.node.nodeType === Node.TEXT_NODE && start.offset === start.node.textContent?.length
        && empty && !empty.textContent && !empty.querySelector("br,img,svg")) empty.remove();
    }
    const sourceLi = start.node.parentElement?.closest("li");
    const sourceOl = sourceLi?.parentElement;
    const clonedOl = scratch.querySelector("ol");
    if (sourceLi && sourceOl?.tagName === "OL" && clonedOl) {
      const tail = document.createRange(); tail.selectNodeContents(sourceLi); tail.setStart(start.node, start.offset);
      const ordinal = [...sourceOl.children].indexOf(sourceLi) + ((sourceOl as HTMLOListElement).start || 1);
      clonedOl.start = ordinal + (tail.toString() ? 0 : 1);
    }
    return { html: scratch.innerHTML, height: scratch.getBoundingClientRect().height };
  };
  let result: Result | null = null;
  try {
    while (cursor < points.length && fragments.length < 256) {
      const available = fragments.length ? fullHeight : freshPage ? freshFirstHeight : firstHeight;
      let low = cursor, high = points.length - 1, best = -1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        if (build(points[middle]).height <= available + .1) { best = middle; low = middle + 1; }
        else high = middle - 1;
      }
      if (best < cursor) {
        if (!fragments.length && !freshPage && firstHeight < freshFirstHeight) { freshPage = true; continue; }
        return null; // Unbreakable content keeps the existing overflow warning.
      }
      fragments.push(build(points[best])); start = points[best]; cursor = best + 1;
    }
    if (cursor === points.length) result = { fragments, freshPage };
    return result;
  } finally { scratch.remove(); cache.set(element, { key, result }); }
}
