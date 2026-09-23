// 简历显示与本地存储共用的纯工具；这里不维护界面状态。
export const monthLabel = (
  value: string,
  format: "2021年1月" | "2021.01" = "2021.01",
) => {
  if (!value) return "";
  const [year, month] = value.split("-");
  return format === "2021年1月" ? `${year}年${month}月` : `${year}.${month}`;
};
export const metadataLabel = (values: Array<string | undefined>) =>
  values.filter(Boolean).join(" ");

// 基本信息摘要和 A4 预览共用同一套年龄计算，避免两处显示不一致。
export const calculateAge = (birth: string) => {
  if (!/^\d{4}-\d{2}/.test(birth)) return 0;
  const today = new Date();
  const year = Number(birth.slice(0, 4));
  const month = Number(birth.slice(5, 7));
  return Math.max(
    0,
    today.getFullYear() - year - (today.getMonth() + 1 < month ? 1 : 0),
  );
};

// 新增经历使用稳定且低碰撞的 ID，旧浏览器没有 randomUUID 时自动降级。
export const createEntityId = (prefix: string) =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export const stripHtml = (html: string) => {
  const document = new DOMParser().parseFromString(html, "text/html");
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
};

const richHtmlCache = new Map<string, string>();
const allowedRichTags = new Set([
  "A",
  "B",
  "BR",
  "DIV",
  "EM",
  "I",
  "LI",
  "OL",
  "P",
  "S",
  "SPAN",
  "STRIKE",
  "STRONG",
  "U",
  "UL",
]);

// 富文本使用严格白名单，并缓存稳定结果，避免预览重绘时反复解析相同正文。
export const sanitizeRichHtml = (html: string) => {
  const cached = richHtmlCache.get(html);
  if (cached !== undefined) return cached;
  const document = new DOMParser().parseFromString(html, "text/html");
  document
    .querySelectorAll("script, style, iframe, object, embed, form, meta, link")
    .forEach((node) => node.remove());
  document.body.querySelectorAll<HTMLElement>("*").forEach((element) => {
    if (!allowedRichTags.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      return;
    }
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      const safeLink =
        element.tagName === "A" &&
        name === "href" &&
        /^(https?:\/\/|mailto:)/.test(value);
      if (!safeLink) {
        element.removeAttribute(attribute.name);
      }
    });
  });
  const sanitized = document.body.innerHTML;
  richHtmlCache.set(html, sanitized);
  if (richHtmlCache.size > 200) {
    const oldest = richHtmlCache.keys().next().value as string | undefined;
    if (oldest !== undefined) richHtmlCache.delete(oldest);
  }
  return sanitized;
};

// 以下两个函数仅负责读取浏览器本地保存内容；修改存储键时集中改这里。
export const readStoredString = (key: string, fallback: string) => {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
};
export const readStoredPreference = (key: string, fallback: string) => {
  try {
    const saved = window.localStorage.getItem("resume-diy-preferences");
    const parsed = saved ? (JSON.parse(saved) as Record<string, unknown>) : {};
    return typeof parsed[key] === "string" ? (parsed[key] as string) : fallback;
  } catch {
    return fallback;
  }
};

export const writeStoredString = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};
