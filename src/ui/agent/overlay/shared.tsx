import type {
  AgentAnchorSetting,
  AgentModeSetting,
  AgentSizeSetting,
} from "../../../platform/settings";
import type { ImportedTemplate } from "../../domain/imported-template";
import type { JobTailoringSelection } from "../../app/workspace/JobWorkspace";
import type { DocumentTransition } from "../../app/DocumentWorkspace";
import {
  moduleTitles,
  type BasicInfo,
  type Entry,
  type ModuleKey,
} from "../../domain/resume-model";
import type {
  ResumeVersionSnapshot,
  ResumeVersionStore,
} from "../../domain/version-model";
import {
  signature
} from "../agentOverlayUtils";
import type { resolveReferencePayload } from "../context";
import {
  basicFieldLabels
} from "../context";
import type {
  AgentEditPatch,
  AgentEditTarget,
  AgentReference,
  AgentView
} from "../types";
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

export type AgentOverlayProps = {
  onDocumentTransition?: DocumentTransition;
  jobTailoringRequest?: JobTailoringSelection | null;
  interactionDisabled?: boolean;
  activeView: AgentView;
  resume: ResumeVersionSnapshot["resume"];
  moduleOrder: ResumeVersionSnapshot["moduleOrder"];
  moduleNames: ResumeVersionSnapshot["moduleNames"];
  summaryTitle: string;
  resumeTitle: string;
  activeTemplateId: string | null;
  templates: ImportedTemplate[];
  versionStore: ResumeVersionStore;
  workingSnapshot: ResumeVersionSnapshot;
  hasUncommittedChanges: boolean;
  layoutPreferences: {
    mode: AgentModeSetting;
    anchor: AgentAnchorSetting;
    sizes: AgentSizeSetting;
  };
  onLayoutPreferenceChange: (
    key: "agentMode" | "agentPosition" | "agentSizes",
    value: AgentModeSetting | AgentAnchorSetting | AgentSizeSetting,
  ) => void;
  onApplyEdit: (change: {
    target: AgentEditTarget;
    patch: AgentEditPatch;
    expectedValue: unknown;
  }) => boolean;
  onUndoEdit: (change: {
    target: AgentEditTarget;
    originalValue: unknown;
    expectedValue: unknown;
  }) => boolean;
  onDeleteEntry: (
    module: ModuleKey,
    id: string,
    expectedValue: Entry,
  ) => boolean;
  onApplyTemplate: (template: ImportedTemplate) => Promise<boolean>;
  onCommitVersion: (message: string) => Promise<boolean>;
  onNavigateToReference: (reference: AgentReference) => void;
  onNativeWorkspaceReload: (snapshot: ResumeVersionSnapshot) => void;
};

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

export const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : fallback;

export type CatalogAgentReference = AgentReference & { view: AgentView };

export const conversationLimit = 8;

export const softContextCharacterLimit = 36_000;

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

export function currentBranchOf(store: ResumeVersionStore) {
  return store.branches.find(
    (branch) => branch.id === store.currentBranchId,
  ) ?? null;
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
export type TailParameters<F extends (...args: never[]) => unknown> = Parameters<F> extends [unknown, ...infer R] ? R : never;

export type AgentContextObjects = (NonNullable<ReturnType<typeof resolveReferencePayload>> & { sourceView: AgentView })[];
