import type { BasicInfo, ModuleKey } from "../domain/resume-model";
import { moduleTitles } from "../domain/resume-model";
import type { ImportedTemplate } from "../domain/imported-template";
import type {
  ResumeVersionSnapshot,
  ResumeVersionStore,
} from "../domain/version-model";
import { agentSkills } from "./skills";
import type { AgentReference, AgentResumeContext, AgentView } from "./types";

export const basicFieldLabels: Record<keyof BasicInfo, string> = {
  name: "姓名",
  phone: "电话",
  email: "邮箱",
  city: "现居城市",
  wechat: "微信",
  birth: "年龄或生日",
  ageMode: "生日显示方式",
  website: "个人网站 1",
  linkedin: "个人网站 2",
  gender: "性别",
  height: "身高",
  weight: "体重",
  ethnicity: "民族",
  birthplace: "籍贯",
  politicalStatus: "政治面貌",
  maritalStatus: "婚姻状况",
  zodiac: "星座",
  mbti: "MBTI",
  avatar: "头像",
};

const moduleKeys: ModuleKey[] = [
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
];

const featureReferences: Record<AgentView, Array<[string, string, string]>> = {
  editor: [
    [
      "basic-info",
      "基本信息",
      "查看基本信息模块；具体个人字段需单独选择后才会发送给模型。",
    ],
    [
      "section-editing",
      "章节与经历编辑",
      "编辑基本信息、章节正文和各段经历；修改后与右侧预览同步。",
    ],
    ["resume-title", "简历名称", "修改编辑器顶部显示的简历名称。"],
    [
      "module-management",
      "模块管理与顺序",
      "显示、隐藏、改名和排序简历模块及经历条目。",
    ],
    [
      "format-controls",
      "字体与格式设置",
      "调整字体、字号、行高和现有格式预设。",
    ],
    [
      "smart-one-page",
      "智能一页",
      "在可读边界内尝试收紧排版；可能无法压缩至一页。",
    ],
    [
      "live-preview",
      "实时预览与缩放",
      "查看右侧 A4 预览并调整界面缩放；预览排版受固定基线保护。",
    ],
    ["export", "简历导出", "将当前简历导出为 PDF 或 PNG。"],
    ["copy-text", "复制简历文本", "将当前简历内容复制为纯文本。"],
  ],
  templates: [
    [
      "template-browse",
      "模板浏览与筛选",
      "查看内置或本地模板，并按收藏和最近使用筛选。",
    ],
    [
      "template-import",
      "模板导入与识别",
      "本地导入图片、PDF 或 DOCX；确认后识别为可编辑字段。",
    ],
    [
      "template-apply",
      "模板应用",
      "查看应用影响，确认后将所选模板用于当前简历。",
    ],
    [
      "template-organize",
      "模板收藏与整理",
      "收藏、重命名或删除已导入模板；可按最近使用查看。",
    ],
  ],
  versions: [
    ["version-save", "保存当前版本", "将当前草稿连同说明提交到选定分支。"],
    [
      "version-compare",
      "版本比较",
      "比较两个明确选择的版本或当前草稿，不修改内容。",
    ],
    ["version-branch", "版本分支", "查看和切换分支，操作前核对当前草稿。"],
    [
      "version-restore",
      "恢复历史版本",
      "将选定快照恢复到编辑器；属于需要用户确认的操作。",
    ],
    [
      "version-backup",
      "版本备份与导入",
      "导出或导入版本库备份，保留现有版本数据边界。",
    ],
  ],
};

function pageFeatures(view: AgentView): AgentReference[] {
  return featureReferences[view].map(([id, label, description]) => ({
    id: `feature:${view}:${id}`,
    kind: "feature",
    label,
    detail: `页面功能 · ${description}`,
    featureDescription: description,
  }));
}

export function plainText(value: string) {
  const parsed = new DOMParser().parseFromString(value, "text/html");
  return (parsed.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function buildReferenceCatalog({
  view,
  resume,
  moduleOrder,
  moduleNames,
  summaryTitle,
  templates,
  activeTemplateId,
  versions,
}: {
  view: AgentView;
  resume: AgentResumeContext["resume"];
  moduleOrder: AgentResumeContext["moduleOrder"];
  moduleNames: AgentResumeContext["moduleNames"];
  summaryTitle: string;
  templates: ImportedTemplate[];
  activeTemplateId: string | null;
  versions: ResumeVersionStore;
}): AgentReference[] {
  if (view === "editor") {
    const basic: AgentReference[] = (
      Object.keys(basicFieldLabels) as Array<keyof BasicInfo>
    )
      .filter((key) => key !== "avatar")
      .map((key) => ({
        id: `basic:${key}`,
        kind: "basic-field",
        label: basicFieldLabels[key],
        detail: "基本信息 · 单字段引用",
        basicKey: key,
      }));
    const modules = moduleKeys.flatMap((module) => {
      const entries = resume[module];
      const references: AgentReference[] = [
        {
          id: `module:${module}`,
          kind: "module",
          label: moduleNames[module] || moduleTitles[module],
          detail: `${entries.length} 段经历 · ${moduleOrder.includes(module) ? "当前模块" : "隐藏模块"}`,
          module,
        },
      ];
      return references.concat(
        entries.map((entry) => ({
          id: `entry:${module}:${entry.id}`,
          kind: "entry" as const,
          label:
            entry.title ||
            `未命名${moduleNames[module] || moduleTitles[module]}`,
          detail: `${moduleNames[module] || moduleTitles[module]} · ${[entry.role, [entry.start, entry.end].filter(Boolean).join("–")].filter(Boolean).join(" · ") || "未填角色及时间"} · ID ${entry.id.slice(-8)}`,
          module,
          entry,
        })),
      );
    });
    return [
      ...pageFeatures(view),
      ...basic,
      {
        id: "summary",
        kind: "summary",
        label: summaryTitle || "自我评价",
        detail: "自我评价 · 正文内容",
      },
      ...modules,
    ];
  }
  if (view === "templates")
    return [
      ...pageFeatures(view),
      ...templates.map((template): AgentReference => ({
        id: `template:${template.id}`,
        kind: "template",
        label: template.name,
        detail: `${template.sourceType.toUpperCase()} · ${template.id === activeTemplateId ? "当前选中" : "已保存模板"}`,
        templateId: template.id,
      })),
    ];
  const currentBranch = versions.branches.find(
    (branch) => branch.id === versions.currentBranchId,
  );
  return [
    ...pageFeatures(view),
    {
      id: "draft:current",
      kind: "draft",
      label: "当前草稿",
      detail: `${currentBranch?.name ?? "当前分支"} · ${versions.commits.length} 个提交`,
    },
    ...versions.branches.map((branch) => ({
      id: `branch:${branch.id}`,
      kind: "branch" as const,
      label: branch.name,
      detail: branch.id === currentBranch?.id ? "当前分支" : "其他分支",
    })),
    ...[...versions.commits]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((commit) => ({
        id: `version:${commit.id}`,
        kind: "version" as const,
        label: commit.message,
        detail: `${commit.createdAt.slice(0, 10)} · ${commit.id.slice(-8)}`,
        versionId: commit.id,
      })),
  ];
}

function basicFieldValue(
  resume: AgentResumeContext["resume"],
  key: keyof BasicInfo,
) {
  return key === "avatar" ? "" : String(resume.basic[key] ?? "");
}

function versionResumeSummary(snapshot: ResumeVersionSnapshot) {
  return {
    resumeTitle: snapshot.resumeTitle,
    moduleOrder: snapshot.moduleOrder,
    moduleNames: snapshot.moduleNames,
    summaryTitle: snapshot.summaryTitle,
    summary: plainText(snapshot.resume.summary),
    modules: moduleKeys.map((module) => ({
      module,
      name: snapshot.moduleNames[module] ?? moduleTitles[module],
      entries: snapshot.resume[module].map((entry) => ({
        id: entry.id,
        title: entry.title,
        role: entry.role,
        department: entry.department,
        city: entry.city,
        start: entry.start,
        end: entry.end,
        content: plainText(entry.html),
      })),
    })),
    layout: snapshot.layout,
  };
}

export function compareVersionSnapshots(
  before: ResumeVersionSnapshot,
  after: ResumeVersionSnapshot,
) {
  const changes: string[] = [];
  const changed = (left: unknown, right: unknown) =>
    JSON.stringify(left) !== JSON.stringify(right);
  if (changed(before.resumeTitle, after.resumeTitle)) changes.push("简历名称");
  if (changed(before.resume.summary, after.resume.summary))
    changes.push("自我评价正文");
  if (changed(before.summaryTitle, after.summaryTitle))
    changes.push("自我评价标题");
  if (changed(before.moduleOrder, after.moduleOrder)) changes.push("模块顺序");
  if (changed(before.moduleNames, after.moduleNames)) changes.push("模块名称");
  for (const key of Object.keys(after.resume.basic) as Array<keyof BasicInfo>) {
    if (changed(before.resume.basic[key], after.resume.basic[key]))
      changes.push(`基本信息：${basicFieldLabels[key]}（值不展示）`);
  }
  for (const module of moduleKeys) {
    const beforeEntries = new Map(
      before.resume[module].map((entry) => [entry.id, entry]),
    );
    const afterEntries = new Map(
      after.resume[module].map((entry) => [entry.id, entry]),
    );
    const label = after.moduleNames[module] ?? moduleTitles[module];
    for (const [id, entry] of afterEntries) {
      const old = beforeEntries.get(id);
      if (!old) {
        changes.push(`${label}：新增 ${entry.title || id}`);
        continue;
      }
      const fields = Object.keys(entry).filter(
        (field) =>
          field !== "id" &&
          changed(
            old[field as keyof typeof old],
            entry[field as keyof typeof entry],
          ),
      );
      if (fields.length)
        changes.push(
          `${label}：${entry.title || id} 修改 ${fields.join("、")}`,
        );
    }
    for (const [id, entry] of beforeEntries) {
      if (!afterEntries.has(id))
        changes.push(`${label}：移除 ${entry.title || id}`);
    }
  }
  if (changed(before.layout, after.layout)) changes.push("简历布局");
  if (changed(before.presentation, after.presentation))
    changes.push("显示样式");
  if (changed(before.importedTemplate, after.importedTemplate))
    changes.push("模板身份");
  return changes;
}

export function resolveReferencePayload(
  reference: AgentReference,
  context: {
    resume: AgentResumeContext["resume"];
    moduleNames: AgentResumeContext["moduleNames"];
    summaryTitle: string;
    templates: ImportedTemplate[];
    versions: ResumeVersionStore;
    workingSnapshot: ResumeVersionSnapshot;
  },
) {
  if (reference.kind === "feature")
    return {
      kind: "feature",
      id: reference.id,
      name: reference.label,
      description: reference.featureDescription,
      note: "这是界面功能引用，可用于讨论或定位；模型不能直接调用页面函数或修改应用代码。",
    };
  if (reference.kind === "basic-field" && reference.basicKey)
    return {
      kind: reference.kind,
      id: reference.id,
      field: basicFieldLabels[reference.basicKey],
      value: basicFieldValue(context.resume, reference.basicKey),
    };
  if (reference.kind === "summary")
    return {
      kind: reference.kind,
      id: reference.id,
      title: context.summaryTitle,
      content: plainText(context.resume.summary),
    };
  if (reference.kind === "entry" && reference.module && reference.entry) {
    const entry = context.resume[reference.module].find(
      (item) => item.id === reference.entry?.id,
    );
    if (!entry) return null;
    return {
      kind: reference.kind,
      id: reference.id,
      module:
        context.moduleNames[reference.module] ?? moduleTitles[reference.module],
      title: entry.title,
      role: entry.role,
      department: entry.department,
      city: entry.city,
      start: entry.start,
      end: entry.end,
      college: entry.college,
      mode: entry.mode,
      content: plainText(entry.html),
    };
  }
  if (reference.kind === "module" && reference.module)
    return {
      kind: reference.kind,
      id: reference.id,
      module:
        context.moduleNames[reference.module] ?? moduleTitles[reference.module],
      entries: context.resume[reference.module].map((entry) => ({
        id: entry.id,
        title: entry.title,
        role: entry.role,
        department: entry.department,
        city: entry.city,
        start: entry.start,
        end: entry.end,
        content: plainText(entry.html),
      })),
    };
  if (reference.kind === "template" && reference.templateId) {
    const template = context.templates.find(
      (item) => item.id === reference.templateId,
    );
    if (!template) return null;
    return {
      kind: "template",
      id: template.id,
      name: template.name,
      sourceType: template.sourceType,
      analysis: template.analysis,
      recognitionConfidence: template.recognitionConfidence,
      recognitionWarnings: template.recognitionWarnings,
      moduleOrder: template.moduleOrder,
      moduleNames: template.moduleNames,
      summaryTitle: template.summaryTitle,
      extractedTextLength: template.extractedText?.length ?? 0,
    };
  }
  if (reference.kind === "version" && reference.versionId) {
    const commit = context.versions.commits.find(
      (item) => item.id === reference.versionId,
    );
    if (!commit) return null;
    const branch = context.versions.branches.find(
      (item) => item.id === commit.branchId,
    );
    return {
      kind: "version",
      id: commit.id,
      message: commit.message,
      createdAt: commit.createdAt,
      branch: branch?.name ?? "已删除分支",
      snapshot: versionResumeSummary(commit.snapshot),
    };
  }
  if (reference.kind === "draft")
    return draftDifference(context.workingSnapshot, context.versions);
  if (reference.kind === "branch") {
    const branch = context.versions.branches.find(
      (item) => item.id === reference.id.slice("branch:".length),
    );
    return branch
      ? {
          kind: "branch",
          id: branch.id,
          name: branch.name,
          headCommitId: branch.headCommitId,
        }
      : null;
  }
  return null;
}

function draftDifference(
  current: ResumeVersionSnapshot,
  versions: ResumeVersionStore,
) {
  const branch = versions.branches.find(
    (item) => item.id === versions.currentBranchId,
  );
  const head = versions.commits.find(
    (item) => item.id === branch?.headCommitId,
  );
  if (!head)
    return {
      kind: "draft",
      currentBranch: branch?.name ?? "当前分支",
      baseline: "无已提交 HEAD",
      changedAreas: ["首次提交"],
    };
  const before = head.snapshot;
  const changedAreas: string[] = [];
  if (current.resumeTitle !== before.resumeTitle) changedAreas.push("简历名称");
  if (current.resume.summary !== before.resume.summary)
    changedAreas.push("自我评价");
  if (
    JSON.stringify(current.moduleOrder) !== JSON.stringify(before.moduleOrder)
  )
    changedAreas.push("模块顺序");
  if (
    JSON.stringify(current.moduleNames) !== JSON.stringify(before.moduleNames)
  )
    changedAreas.push("模块名称");
  const sensitiveChanged = (
    Object.keys(current.resume.basic) as Array<keyof BasicInfo>
  ).some(
    (key) =>
      JSON.stringify(current.resume.basic[key]) !==
      JSON.stringify(before.resume.basic[key]),
  );
  if (sensitiveChanged) changedAreas.push("基本信息字段（值已省略）");
  for (const module of moduleKeys) {
    const oldEntries = new Map(
      before.resume[module].map((entry) => [entry.id, entry]),
    );
    const newEntries = new Map(
      current.resume[module].map((entry) => [entry.id, entry]),
    );
    for (const entry of current.resume[module]) {
      const old = oldEntries.get(entry.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(entry))
        changedAreas.push(
          `${current.moduleNames[module] ?? moduleTitles[module]}：${entry.title || "未命名经历"}（新增或修改）`,
        );
    }
    for (const entry of before.resume[module]) {
      if (!newEntries.has(entry.id))
        changedAreas.push(
          `${before.moduleNames[module] ?? moduleTitles[module]}：${entry.title || "未命名经历"}（移除）`,
        );
    }
  }
  if (JSON.stringify(current.layout) !== JSON.stringify(before.layout))
    changedAreas.push("排版设置");
  if (
    JSON.stringify(current.presentation) !== JSON.stringify(before.presentation)
  )
    changedAreas.push("模板与显示样式");
  return {
    kind: "draft-difference",
    currentBranch: branch?.name ?? "当前分支",
    baseline: head.message,
    changedAreas: [...new Set(changedAreas)],
  };
}

export function makeAgentSystemPrompt(
  view: AgentView,
  skillId: string | null,
  locale = "zh-CN",
) {
  const skill = agentSkills.find((item) => item.id === skillId);
  return [
    `You are Re:me's resume assistant. Reply in ${locale === "zh-CN" ? "Simplified Chinese" : "the user's language"}.`,
    "Use only the explicit references and context included in the current user message. Never invent employers, schools, duties, results, dates, or numbers.",
    "You are not authorized to apply edits, templates, or versions. When proposing a write, use the matching registered proposal tool. The host validates it and the user must confirm.",
    "A feature reference identifies a user-facing page feature, not a callable function. You may explain or locate it, but cannot modify application source code or invoke page controls through chat.",
    "When a module is selected, its listed entries are the authorized scope. Identify an entry by its exact ID before proposing a field change or deletion. If the user's description matches multiple entries, ask which one; never guess. Deletions and date changes must be presented as proposals for user confirmation.",
    `Current page: ${view}.`,
    skill
      ? `Selected skill: ${skill.title}. ${skill.instruction}`
      : "No slash skill is selected.",
  ].join("\n");
}

export function countApproxTokens(text: string) {
  return Math.ceil(text.length / 3.5);
}
