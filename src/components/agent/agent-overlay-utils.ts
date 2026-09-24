import type { BasicInfo, Entry, ModuleKey } from "../../domain/resume-model";
import { moduleTitles } from "../../domain/resume-model";
import type { ImportedTemplate } from "../../domain/imported-template";
import type { ResumeVersionSnapshot } from "../../domain/version-model";
import { basicFieldLabels, plainText } from "../../agent/context";
import type { AgentReference, AgentView } from "../../agent/types";

export type AgentMode = "bot" | "composer" | "chat";
export type CompletionMenu =
  | { kind: "reference"; query: string; start: number; end: number }
  | { kind: "skill"; query: string; start: number; end: number }
  | null;
export type ProviderDraft = {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};
export type DiscoveredModel = { id: string; name: string };
export type FixedRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export type AgentAnchor = { right: number; bottom: number };
export type CatalogAgentReference = AgentReference & { view: AgentView };

export const conversationLimit = 8;
export const softContextCharacterLimit = 36_000;
export const agentPositionKey = "resume-diy-agent-position-v1";
export const agentModeKey = "resume-diy-agent-mode-v1";
export const agentSizeKey = "resume-diy-agent-size-v1";

export const readToolNames = [
  "context_list_resources",
  "resume_read",
  "templates_list",
  "templates_read",
  "versions_list",
  "versions_read",
  "versions_diff",
  "ui_locate",
] as const;

export const readToolDefinitions = readToolNames.map((name) => ({
  type: "function",
  function: {
    name,
    description: `Read-only host tool ${name}. Only explicitly selected references may be read. Never assume a missing reference is authorized.`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        leftId: { type: "string" },
        rightId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
}));

export const basicTargets = new Set<keyof BasicInfo>([
  "name",
  "phone",
  "email",
  "city",
  "wechat",
  "birth",
  "ageMode",
  "website",
  "linkedin",
  "gender",
  "height",
  "weight",
  "ethnicity",
  "birthplace",
  "politicalStatus",
  "maritalStatus",
  "zodiac",
  "mbti",
]);

export const entryTargets = new Set<keyof Omit<Entry, "id">>([
  "title",
  "role",
  "department",
  "city",
  "start",
  "end",
  "html",
  "college",
  "mode",
]);

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

export function readAgentAnchor(): AgentAnchor | null {
  try {
    const value = JSON.parse(localStorage.getItem(agentPositionKey) ?? "null");
    return value &&
      Number.isFinite(value.right) &&
      Number.isFinite(value.bottom)
      ? { right: value.right, bottom: value.bottom }
      : null;
  } catch {
    return null;
  }
}

export function readAgentMode(): AgentMode {
  try {
    const value = localStorage.getItem(agentModeKey);
    if (value === "bot" || value === "composer" || value === "chat")
      return value;
  } catch {
    // Keep the local default when storage is unavailable.
  }
  return window.innerWidth < 760 ? "bot" : "composer";
}

export function readAgentSize(): Record<
  "chat" | "composer",
  { width: number; height: number }
> {
  try {
    const saved = JSON.parse(localStorage.getItem(agentSizeKey) ?? "null");
    if (
      saved?.chat &&
      saved?.composer &&
      [
        saved.chat.width,
        saved.chat.height,
        saved.composer.width,
        saved.composer.height,
      ].every((value) => Number.isFinite(value) && value >= 0 && value <= 4000)
    )
      return saved;
  } catch {
    // Use the default size when storage is unavailable.
  }
  return {
    chat: { width: 460, height: 540 },
    composer: { width: 460, height: 194 },
  };
}

export function measureOverlay(
  mode: AgentMode,
  anchor: AgentAnchor | null,
  sizes = readAgentSize(),
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

export function findCompletionToken(
  text: string,
  caret: number,
  kind: "@" | "/",
) {
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

export function describeTemplateEffects(
  template: ImportedTemplate,
  snapshot: ResumeVersionSnapshot,
  activeTemplateId: string | null,
) {
  const effects: string[] = [];
  const describeFields = (label: string, before: object, after: object) => {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const previous = (before as Record<string, unknown>)[key];
      const next = (after as Record<string, unknown>)[key];
      if (signature(previous) !== signature(next))
        effects.push(
          `${label}.${key}：${JSON.stringify(previous) ?? "未设置"} → ${JSON.stringify(next) ?? "未设置"}。`,
        );
    }
  };
  if (template.resume) {
    effects.push("正文与基本信息：将以所选模板的识别结果整体替换当前内容。");
    const changedBasic = (
      Object.keys(template.resume.basic) as Array<keyof BasicInfo>
    )
      .filter(
        (key) =>
          JSON.stringify(template.resume?.basic[key]) !==
          JSON.stringify(snapshot.resume.basic[key]),
      )
      .map((key) => basicFieldLabels[key]);
    if (changedBasic.length)
      effects.push(`基本信息变化：${changedBasic.join("、")}（值不展示）。`);
    for (const module of Object.keys(moduleTitles) as ModuleKey[]) {
      const before = snapshot.resume[module] ?? [];
      const after = template.resume[module] ?? [];
      if (signature(before) !== signature(after))
        effects.push(
          `${snapshot.moduleNames[module] ?? moduleTitles[module]}：当前 ${before.length} 条（${before.map((entry) => entry.title || "未命名").join("、") || "空"}）→ 模板 ${after.length} 条（${after.map((entry) => entry.title || "未命名").join("、") || "空"}）。`,
        );
    }
    if (snapshot.resume.summary !== template.resume.summary)
      effects.push("自我评价正文：将替换为模板识别内容。");
  }
  if (template.moduleOrder)
    effects.push(
      `模块顺序：${snapshot.moduleOrder.join("、")} → ${template.moduleOrder.join("、")}。`,
    );
  if (template.moduleNames || template.summaryTitle)
    effects.push("模块名称与自我评价标题：将采用模板设置。");
  if (template.resumeLayout)
    describeFields("简历布局", snapshot.layout, template.resumeLayout);
  if (template.presentation)
    describeFields(
      "显示样式",
      snapshot.presentation ?? {},
      template.presentation,
    );
  else effects.push(`显示样式：将应用格式 ${template.formatId} 与模板主色。`);
  if (template.detectedFont)
    effects.push(`字体：将切换为 ${template.detectedFont}。`);
  effects.push(
    `模板身份：${activeTemplateId ?? "未选模板"} → ${template.name}。`,
  );
  if (template.sourceType === "pdf" && template.previewDataUrl)
    effects.push(
      "初次应用时，右侧先显示源 PDF 第一页；开始编辑后显示实时预览。",
    );
  return effects;
}

export const resumeEditTool = {
  type: "function",
  function: {
    name: "propose_resume_patch",
    description:
      "提出一个仅针对当前用户明确引用的基本字段、自我评价或单条经历的修改提议。不会执行写入。",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["basic", "summary", "entry"] },
            key: { type: "string" },
            module: {
              type: "string",
              enum: [
                "education",
                "skills",
                "work",
                "projects",
                "orgs",
                "research",
                "awards",
                "other",
                "portfolio",
                "custom",
              ],
            },
            id: { type: "string" },
          },
          required: ["kind"],
          additionalProperties: false,
        },
        patch: { type: "object", additionalProperties: { type: "string" } },
        explanation: { type: "string" },
      },
      required: ["target", "patch", "explanation"],
      additionalProperties: false,
    },
  },
};

export const resumeDeleteTool = {
  type: "function",
  function: {
    name: "propose_resume_entry_delete",
    description:
      "只为用户明确引用的模块或经历提出删除某一条经历的待确认提议；必须使用给定的准确经历 ID，不会直接删除。",
    parameters: {
      type: "object",
      properties: {
        module: { type: "string" },
        id: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["module", "id", "explanation"],
      additionalProperties: false,
    },
  },
};

export const templateApplyTool = {
  type: "function",
  function: {
    name: "propose_template_application",
    description:
      "为用户明确引用的真实本地模板提出完整的应用提议，不会直接应用。",
    parameters: {
      type: "object",
      properties: {
        templateId: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["templateId", "explanation"],
      additionalProperties: false,
    },
  },
};

export const versionSaveTool = {
  type: "function",
  function: {
    name: "propose_version_save",
    description:
      "为当前草稿和用户已确认的分支提出保存版本的待确认提议，不会直接写入。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
        explanation: { type: "string" },
      },
      required: ["message", "explanation"],
      additionalProperties: false,
    },
  },
};
