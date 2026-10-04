import type { Inline } from "../../src-tauri/src/domain/bindings/Inline";
import type { InlineMark } from "../../src-tauri/src/domain/bindings/InlineMark";
import type { RichBlock } from "../../src-tauri/src/domain/bindings/RichBlock";

export type RichTextIssue = {
  issueCode: "unsupportedTag" | "unsupportedAttribute" | "invalidLink" | "invalidListStart" | "comment" | "orphanWhitespace" | "resourceLimit";
  path: string;
  name?: string;
};

export type ParsedLegacyRichText = {
  rawHtml: string;
  blocks: RichBlock[];
  issues: RichTextIssue[];
  complete: boolean;
};

const maxHtmlLength = 1_000_000;
const maxDepth = 8;
const markByTag: Record<string, InlineMark> = {
  B: "bold", STRONG: "bold", I: "italic", EM: "italic",
  U: "underline", S: "strike", STRIKE: "strike",
};
const markOrder: InlineMark[] = ["bold", "italic", "underline", "strike"];
const discardedTags = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "META", "LINK"]);

export function parseLegacyRichHtml(rawHtml: string): ParsedLegacyRichText {
  const issues: RichTextIssue[] = [];
  if (rawHtml.length > maxHtmlLength) {
    return { rawHtml, blocks: [], issues: [{ issueCode: "resourceLimit", path: "body" }], complete: false };
  }
  if (rawHtml.length > 0 && rawHtml.trim() === "") {
    return {
      rawHtml,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: rawHtml, marks: [] }] }],
      issues: [{ issueCode: "orphanWhitespace", path: "body" }],
      complete: false,
    };
  }
  const parsed = new DOMParser().parseFromString(rawHtml, "text/html");

  function checkAttributes(element: Element, allowed: ReadonlySet<string>, path: string): void {
    for (const attribute of element.attributes) {
      if (!allowed.has(attribute.name.toLowerCase())) {
        issues.push({ issueCode: "unsupportedAttribute", path, name: attribute.name });
      }
    }
  }

  function childrenOf(element: Node, path: string): Array<{ node: Node; path: string }> {
    return Array.from(element.childNodes, (node, index) => ({ node, path: `${path}/${index}` }));
  }

  function parseInlineChildren(parent: Node, marks: InlineMark[], path: string, depth: number): Inline[] {
    const result: Inline[] = [];
    for (const child of childrenOf(parent, path)) {
      result.push(...parseInlines(child.node, marks, child.path, depth));
    }
    return result;
  }

  function parseInlines(node: Node, marks: InlineMark[], path: string, depth: number): Inline[] {
    if (depth > maxDepth) {
      issues.push({ issueCode: "resourceLimit", path });
      return [];
    }
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent ? [{ type: "text", text: node.textContent, marks }] : [];
    }
    if (node.nodeType === Node.COMMENT_NODE) {
      issues.push({ issueCode: "comment", path });
      return [];
    }
    if (!(node instanceof Element)) return [];
    const tag = node.tagName;
    if (discardedTags.has(tag)) {
      issues.push({ issueCode: "unsupportedTag", path, name: tag.toLowerCase() });
      return [];
    }
    if (tag === "BR") {
      checkAttributes(node, new Set(), path);
      return [{ type: "break" }];
    }
    if (tag === "A") {
      checkAttributes(node, new Set(["href"]), path);
      const href = node.getAttribute("href") ?? "";
      const normalized = href.replace(/^(https?|mailto):/i, (scheme) => scheme.toLowerCase());
      const children = parseInlineChildren(node, marks, path, depth + 1);
      if (href !== href.trim() || /[\u0000-\u001f\u007f]/.test(href) ||
          !/^(https?:\/\/|mailto:)/.test(normalized)) {
        issues.push({ issueCode: "invalidLink", path });
        return children;
      }
      return [{ type: "link", href: normalized, children }];
    }
    const mark = markByTag[tag];
    if (mark || tag === "SPAN") {
      checkAttributes(node, new Set(), path);
      const nextMarks = mark
        ? markOrder.filter((candidate) => candidate === mark || marks.includes(candidate))
        : marks;
      return parseInlineChildren(node, nextMarks, path, depth + 1);
    }
    issues.push({ issueCode: "unsupportedTag", path, name: tag.toLowerCase() });
    checkAttributes(node, new Set(), path);
    return parseInlineChildren(node, marks, path, depth + 1);
  }

  function parseList(element: Element, path: string, depth: number): RichBlock {
    const ordered = element.tagName === "OL";
    checkAttributes(element, ordered ? new Set(["start"]) : new Set(), path);
    let start: number | null = null;
    if (ordered && element.hasAttribute("start")) {
      const rawStart = element.getAttribute("start") ?? "";
      const value = Number(rawStart);
      if (!/^\d+$/.test(rawStart) || !Number.isSafeInteger(value) || value > 4_294_967_295) {
        issues.push({ issueCode: "invalidListStart", path });
      } else start = value;
    }
    const items: RichBlock[][] = [];
    for (const { node, path: childPath } of childrenOf(element, path)) {
      if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) {
        issues.push({ issueCode: "orphanWhitespace", path: childPath });
        continue;
      }
      if (node instanceof Element && node.tagName === "LI") {
        checkAttributes(node, new Set(), childPath);
        const blocks = parseBlocks(node, childPath, depth + 1);
        items.push(blocks.length ? blocks : [{ type: "paragraph", children: [] }]);
      } else {
        issues.push({ issueCode: "unsupportedTag", path: childPath, name: node instanceof Element ? node.tagName.toLowerCase() : "text" });
      }
    }
    return { type: "list", ordered, start, items };
  }

  function parseBlocks(parent: Node, path: string, depth: number): RichBlock[] {
    if (depth > maxDepth) {
      issues.push({ issueCode: "resourceLimit", path });
      return [];
    }
    const blocks: RichBlock[] = [];
    let pending: Inline[] = [];
    const flush = () => {
      if (pending.length) blocks.push({ type: "paragraph", children: pending });
      pending = [];
    };
    for (const { node, path: childPath } of childrenOf(parent, path)) {
      if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim() && !pending.length) {
        issues.push({ issueCode: "orphanWhitespace", path: childPath });
      }
      if (node instanceof Element) {
        const tag = node.tagName;
        if (tag === "P") {
          flush();
          checkAttributes(node, new Set(), childPath);
          const children = parseInlineChildren(node, [], childPath, depth + 1);
          blocks.push({ type: "paragraph", children });
          continue;
        }
        if (tag === "DIV") {
          flush();
          checkAttributes(node, new Set(), childPath);
          const children = parseBlocks(node, childPath, depth + 1);
          blocks.push(...(children.length ? children : [{ type: "paragraph", children: [] } as RichBlock]));
          continue;
        }
        if (tag === "UL" || tag === "OL") {
          flush();
          blocks.push(parseList(node, childPath, depth + 1));
          continue;
        }
      }
      pending.push(...parseInlines(node, [], childPath, depth + 1));
    }
    flush();
    return blocks;
  }

  for (const { node, path } of childrenOf(parsed.head, "head")) {
    if (node instanceof Element) {
      issues.push({ issueCode: "unsupportedTag", path, name: node.tagName.toLowerCase() });
      checkAttributes(node, new Set(), path);
    } else if (node.nodeType === Node.COMMENT_NODE) {
      issues.push({ issueCode: "comment", path });
    } else if (node.textContent) {
      issues.push({ issueCode: "unsupportedTag", path, name: "text" });
    }
  }
  if (parsed.doctype) {
    issues.push({ issueCode: "unsupportedTag", path: "doctype", name: "doctype" });
  }
  const blocks = parseBlocks(parsed.body, "body", 0);
  return { rawHtml, blocks, issues, complete: issues.length === 0 };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderInline(inline: Inline): string {
  if (inline.type === "break") return "<br>";
  if (inline.type === "link") {
    if (!/^(https?:\/\/|mailto:)/.test(inline.href) || /[\u0000-\u001f\u007f]/.test(inline.href)) {
      throw new Error("Rich text contains an unsupported link");
    }
    return `<a href="${escapeHtml(inline.href)}">${inline.children.map(renderInline).join("")}</a>`;
  }
  const marks = new Set(inline.marks);
  if (marks.size !== inline.marks.length || inline.marks.some((mark) => !markOrder.includes(mark))) {
    throw new Error("Rich text contains unsupported marks");
  }
  let html = escapeHtml(inline.text);
  for (const [mark, tag] of [["strike", "s"], ["underline", "u"], ["italic", "i"], ["bold", "b"]] as const) {
    if (marks.has(mark)) html = `<${tag}>${html}</${tag}>`;
  }
  return html;
}

function renderBlock(block: RichBlock): string {
  if (block.type === "paragraph") return `<p>${block.children.map(renderInline).join("")}</p>`;
  const tag = block.ordered ? "ol" : "ul";
  if (block.start !== null && (!block.ordered || !Number.isInteger(block.start) || block.start < 0 || block.start > 4_294_967_295)) {
    throw new Error("Rich text contains an invalid list start");
  }
  const start = block.start === null ? "" : ` start="${block.start}"`;
  const items = block.items.map((item) => `<li>${item.map(renderBlock).join("")}</li>`).join("");
  return `<${tag}${start}>${items}</${tag}>`;
}

export function richBlocksToLegacyHtml(blocks: RichBlock[]): string {
  return blocks.map(renderBlock).join("");
}
