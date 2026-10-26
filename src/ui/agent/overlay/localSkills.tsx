import type { Dispatch, SetStateAction } from "react";
import type { ImportedTemplate } from "../../domain/imported-template";
import {
  moduleTitles,
  type BasicInfo
} from "../../domain/resume-model";
import type {
  ResumeVersionSnapshot,
  ResumeVersionStore,
} from "../../domain/version-model";
import {
  nodeId,
  safeMessage,
  signature
} from "../agentOverlayUtils";
import {
  basicFieldLabels,
  compareVersionSnapshots
} from "../context";
import type {
  AgentProposal,
  AgentView
} from "../types";
import type { AgentContextObjects } from "./shared";
import { AgentMode, CatalogAgentReference, currentBranchOf, describeTemplateEffects } from './shared';
export async function runHandleLocalSkill(context: {
  contextObjects: AgentContextObjects;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  referenceCatalog: CatalogAgentReference[];
  showLocalResult: (text: string, sourceView: AgentView, sourceRefs: string[]) => void;
  templates: ImportedTemplate[];
  selectedTemplate: (refIds: string[]) => ImportedTemplate | null;
  workingSnapshot: ResumeVersionSnapshot;
  activeTemplateId: string | null;
  setProposals: (update: SetStateAction<AgentProposal[]>) => void;
  versionStore: ResumeVersionStore;
  setMode: (next: AgentMode) => void;
  hasUncommittedChanges: boolean;
  resumeTitle: string;
  resolvedReferences: (CatalogAgentReference | null)[];
}, skillId: string, userText: string, sourceView: AgentView, sourceRefs: string[], selectedVersions: ResumeVersionStore, selectedPayloads: typeof context.contextObjects): Promise<boolean> {
  const {
    contextObjects, setSettingsOpen, referenceCatalog, showLocalResult, templates, selectedTemplate,
    workingSnapshot, activeTemplateId, setProposals, versionStore, setMode, hasUncommittedChanges, resumeTitle,
    resolvedReferences,
  } = context;

  if (skillId === "settings") {
    setSettingsOpen(true);
    return true;
  }
  if (skillId === "check-import") {
    const refs = sourceRefs
      .map((id) => referenceCatalog.find((item) => item.id === id))
      .filter((item) => item?.kind === "template");
    if (refs.length !== 1) {
      showLocalResult(
        "请先用 @ 选择一份已识别模板；我只会读取本机保存的识别结果，不会上传原文件。",
        sourceView,
        sourceRefs,
      );
      return true;
    }
    const template = templates.find(
      (item) => item.id === refs[0]?.templateId,
    );
    if (!template?.resume) {
      showLocalResult(
        "这份模板只有视觉预览，没有可编辑的文本识别结果。",
        sourceView,
        sourceRefs,
      );
      return true;
    }
    const moduleCount = template.moduleOrder?.length ?? 0;
    const entries = (template.moduleOrder ?? []).flatMap((key) =>
      key === "summary" ? [] : (template.resume?.[key] ?? []),
    );
    const populatedBasic = Object.entries(template.resume.basic)
      .filter(
        ([key, value]) =>
          key !== "ageMode" &&
          key !== "avatar" &&
          typeof value === "string" &&
          value.trim(),
      )
      .map(([key]) => basicFieldLabels[key as keyof BasicInfo]);
    const warnings = template.recognitionWarnings?.length
      ? template.recognitionWarnings.join("；")
      : "没有识别警告";
    showLocalResult(
      `本地导入检查：${template.name}\n识别模块：${moduleCount} 个；条目：${entries.length} 段；基本信息字段：${populatedBasic.join("、") || "无"}；正文字符：${template.extractedText?.length ?? 0}。\n${warnings}`,
      sourceView,
      sourceRefs,
    );
    return true;
  }
  if (skillId === "explain-template") {
    const template = selectedTemplate(sourceRefs);
    if (!template) {
      showLocalResult(
        "请用 @ 选择一份真实模板后再解释。",
        sourceView,
        sourceRefs,
      );
      return true;
    }
    showLocalResult(
      `${template.name}：${template.analysis}\n识别置信度：${template.recognitionConfidence ?? "未记录"}；模块：${(template.moduleOrder ?? []).map((key) => (key === "summary" ? (template.summaryTitle ?? "自我评价") : (template.moduleNames?.[key] ?? moduleTitles[key]))).join("、") || "无"}。\n应用会更新：${[template.resume ? "简历正文" : "无正文", template.moduleOrder ? "模块顺序" : "无模块顺序变更", template.resumeLayout || template.presentation ? "排版设置" : "版式预设"].join("、")}。`,
      sourceView,
      sourceRefs,
    );
    return true;
  }
  if (skillId === "apply-template") {
    const template = selectedTemplate(sourceRefs);
    if (!template) {
      showLocalResult(
        "请用 @ 明确选择一份模板；没有选择时不会替你猜。",
        sourceView,
        sourceRefs,
      );
      return true;
    }
    const effects = describeTemplateEffects(
      template,
      workingSnapshot,
      activeTemplateId,
    );
    setProposals((current) => [
      {
        id: nodeId("proposal"),
        kind: "apply-template",
        title: `应用模板：${template.name}`,
        explanation: "请核对全部影响后确认。",
        templateId: template.id,
        effects,
        expectedSnapshotSignature: signature(workingSnapshot),
        expectedTemplateSignature: signature(template),
        expectedBranchId: versionStore.currentBranchId,
        expectedHeadId: currentBranchOf(versionStore)?.headCommitId ?? null,
        sourceView,
        sourceRefs,
      },
      ...current,
    ]);
    setMode("chat");
    return true;
  }
  if (skillId === "save-version") {
    const branch = currentBranchOf(versionStore);
    if (!branch) {
      showLocalResult(
        "当前分支不可用，暂时不能保存版本。",
        sourceView,
        sourceRefs,
      );
      return true;
    }
    setProposals((current) => [
      {
        id: nodeId("proposal"),
        kind: "save-version",
        title: "保存当前版本",
        explanation: hasUncommittedChanges
          ? "当前工作区存在未提交修改。"
          : "当前工作区与分支 HEAD 相同。",
        message: safeMessage(userText) || `更新：${resumeTitle}`,
        branchId: branch.id,
        expectedHeadId: branch.headCommitId,
        expectedSnapshotSignature: signature(workingSnapshot),
        sourceView,
        sourceRefs: ["draft:current"],
      },
      ...current,
    ]);
    setMode("chat");
    return true;
  }
  if (skillId === "check") {
    const payloads = selectedPayloads;
    if (!payloads.length) {
      showLocalResult(
        "请用 @ 选择要检查的模块或经历；本地检查只覆盖已选范围。",
        sourceView,
        sourceRefs,
      );
      return true;
    }
    const serialized = JSON.stringify(payloads);
    const details = [
      `本地选中范围：${resolvedReferences.flatMap((item) => (item ? [item.label] : [])).join("、")}`,
      serialized.includes('"":""')
        ? "部分字段可能为空。"
        : "已引用数据结构完整。",
      "本地检查不会判断招聘概率；需要语言建议时可配置模型后再问。",
    ];
    showLocalResult(details.join("\n"), sourceView, sourceRefs);
    return true;
  }
  if (skillId === "compare-versions") {
    const versionRefs = sourceRefs
      .map((id) => referenceCatalog.find((item) => item.id === id))
      .filter(
        (item): item is CatalogAgentReference =>
          item?.kind === "version" || item?.kind === "draft",
      );
    if (versionRefs.length !== 2) {
      showLocalResult(
        "请用 @ 明确选择两个快照，例如“当前草稿”和一个版本。",
        sourceView,
        sourceRefs,
      );
      return true;
    }
    const snapshots = versionRefs.map((reference) =>
      reference.kind === "draft"
        ? workingSnapshot
        : selectedVersions.commits.find(
          (commit) => commit.id === reference.versionId,
        )?.snapshot,
    );
    if (!snapshots[0] || !snapshots[1]) {
      showLocalResult("所选版本已失效，请重新选择。", sourceView, sourceRefs);
      return true;
    }
    const changes = compareVersionSnapshots(snapshots[0], snapshots[1]);
    showLocalResult(
      !changes.length
        ? "两个已选快照的可比较内容相同。"
        : `本地确定性字段差异（不修改当前草稿）：\n左侧：${versionRefs[0].label}\n右侧：${versionRefs[1].label}\n${changes.map((change) => `- ${change}`).join("\n")}`,
      sourceView,
      sourceRefs,
    );
    return true;
  }
  return false;

}
