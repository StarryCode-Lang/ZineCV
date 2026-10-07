// AgentOverlay 的纯工具函数：无 React 依赖，供悬浮层几何、消息清洗、
// 引用标注与模型地址判断共用。
import { plainText } from "./context";
import type { AgentReference, AgentView } from "./types";
import type { AgentModeSetting, AgentSizeSetting } from "../../platform/settings";

export type FixedRect = { left: number; top: number; width: number; height: number };
export type AgentAnchor = { right: number; bottom: number };

export function nodeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function sanitizeRichHtml(value: unknown) {
  if (typeof value !== "string") return "";
  const parser = new DOMParser().parseFromString(value, "text/html");
  const allowed = new Set([
    "P",
    "BR",
    "STRONG",
    "B",
    "EM",
    "I",
    "UL",
    "OL",
    "LI",
  ]);
  const clean = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE)
      return escapeHtml(node.textContent ?? "");
    if (!(node instanceof HTMLElement)) return "";
    const contents = [...node.childNodes].map(clean).join("");
    if (!allowed.has(node.tagName)) return contents;
    if (node.tagName === "BR") return "<br>";
    return `<${node.tagName.toLowerCase()}>${contents}</${node.tagName.toLowerCase()}>`;
  };
  const result = [...parser.body.childNodes].map(clean).join("").trim();
  return result || `<p>${escapeHtml(plainText(value))}</p>`;
}

export function safeMessage(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, 6000);
}

export function signature(value: unknown) {
  const serialized = JSON.stringify(value) ?? "undefined";
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${serialized.length}:${first >>> 0}:${second >>> 0}`;
}

export function referenceKindLabel(reference: AgentReference) {
  if (reference.kind === "feature") return "页面功能";
  if (reference.kind === "basic-field") return "基本信息";
  if (reference.kind === "entry" || reference.kind === "module")
    return "简历内容";
  if (reference.kind === "summary") return "自我评价";
  if (reference.kind === "template") return "模板";
  if (reference.kind === "version") return "版本";
  if (reference.kind === "branch") return "分支";
  return "草稿";
}

export function measureOverlay(
  mode: AgentModeSetting,
  anchor: AgentAnchor | null,
  sizes: AgentSizeSetting,
): FixedRect {
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const viewportLeft = window.visualViewport?.offsetLeft ?? 0;
  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  const mobile = viewportWidth < 760;
  const dimensions =
    mode === "bot"
      ? { width: 56, height: 56 }
      : mobile
        ? {
            width: Math.max(0, viewportWidth - 20),
            height: Math.min(mode === "chat" ? 580 : 210, viewportHeight - 20),
          }
        : mode === "chat"
          ? {
              width: Math.min(
                Math.max(340, sizes.chat.width),
                viewportWidth - 24,
              ),
              height: Math.min(
                Math.max(350, sizes.chat.height),
                viewportHeight - 28,
              ),
            }
          : {
              width: Math.min(
                Math.max(340, sizes.composer.width),
                viewportWidth - 24,
              ),
              height: Math.min(
                Math.max(194, sizes.composer.height),
                viewportHeight - 28,
              ),
            };
  const defaultRight = mobile
    ? viewportLeft + viewportWidth - 10
    : Math.min(viewportLeft + viewportWidth - 12, viewportLeft + 712);
  const defaultBottom = viewportTop + viewportHeight - 16;
  const right = anchor?.right ?? defaultRight;
  const bottom = anchor?.bottom ?? defaultBottom;
  const leftMin = viewportLeft + 8;
  const leftMax = viewportLeft + viewportWidth - dimensions.width - 8;
  const topMin = viewportTop + 8;
  const topMax = viewportTop + viewportHeight - dimensions.height - 8;
  return {
    left: Math.max(leftMin, Math.min(right - dimensions.width, leftMax)),
    top: Math.max(topMin, Math.min(bottom - dimensions.height, topMax)),
    ...dimensions,
  };
}

export function findCompletionToken(text: string, caret: number, kind: "@" | "/") {
  const before = text.slice(0, caret);
  const match =
    kind === "@"
      ? before.match(/(^|[\s([{])@([^@\s]*)$/)
      : before.match(/(^|\s)\/([^/\s]*)$/);
  if (!match) return null;
  const tokenStart = before.length - match[0].length + match[1].length;
  return {
    start: tokenStart,
    end: caret,
    query: match[2],
  };
}

export function sectionContextLabel(view: AgentView) {
  return view === "editor"
    ? "编辑简历"
    : view === "templates"
      ? "模板库"
      : "版本管理";
}

export function isLocalModelUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function comparableProviderBaseUrl(value: string) {
  try {
    const url = new URL(value);
    url.pathname = url.pathname
      .replace(/\/+$/, "")
      .replace(/\/(?:chat\/completions|models)$/i, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}
