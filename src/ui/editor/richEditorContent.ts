import type { Inline } from "../../../src-tauri/src/domain/bindings/Inline";
import type { RichBlock } from "../../../src-tauri/src/domain/bindings/RichBlock";
import { parseLegacyRichHtml, richBlocksToLegacyHtml } from "../../platform/legacyRichText";
import { sanitizeRichHtml } from "../utils/resume";

export const EMPTY_RICH_HTML = "<p><br></p>";

export function isAllowedRichLink(href: string): boolean {
  if (href !== href.trim() || /[\u0000-\u001f\u007f]/.test(href)) return false;
  if (/^https?:\/\//i.test(href)) {
    try {
      return Boolean(new URL(href).hostname);
    } catch {
      return false;
    }
  }
  if (/^mailto:/i.test(href)) {
    try {
      return Boolean(new URL(href).pathname);
    } catch {
      return false;
    }
  }
  return false;
}

function safeInlines(inlines: Inline[]): Inline[] {
  return inlines.flatMap((inline): Inline[] => {
    if (inline.type !== "link") return [inline];
    const children = safeInlines(inline.children);
    return isAllowedRichLink(inline.href)
      ? [{ ...inline, children }]
      : children;
  });
}

function safeBlocks(blocks: RichBlock[]): RichBlock[] {
  return blocks.map((block): RichBlock =>
    block.type === "paragraph"
      ? { ...block, children: safeInlines(block.children) }
      : { ...block, items: block.items.map(safeBlocks) },
  );
}

export function normalizeRichEditorHtml(rawHtml: string): string {
  const parsed = parseLegacyRichHtml(rawHtml);
  if (parsed.issues.some((issue) => issue.issueCode === "resourceLimit")) {
    return sanitizeRichHtml(rawHtml) || EMPTY_RICH_HTML;
  }
  const normalized = richBlocksToLegacyHtml(safeBlocks(parsed.blocks));
  return normalized === "" || normalized === "<p></p>"
    ? EMPTY_RICH_HTML
    : normalized;
}

export function safePasteHtml(html: string, plainText: string): string {
  const source = html || plainText
    .replace(/\r\n?/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  return normalizeRichEditorHtml(source);
}

export function normalizeLinkUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed.replace(/^\/+/, "")}`;
  const normalized = candidate.replace(/^(https?|mailto):/i, (scheme) => scheme.toLowerCase());
  return isAllowedRichLink(normalized) ? normalized : null;
}
