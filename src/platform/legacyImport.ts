// 旧版浏览器数据导出（zinecv-legacy-browser-export）→ 桌面工作区/版本库。
// 只读取导出文件，不访问旧 origin 本身；解析结果经既有 normalize/版本替换
// 通道进入 SQLite，与手动操作走完全相同的路径。
import {
  migratePersonalSites,
  normalizeResumeState,
  normalizeSectionOrder,
} from "../legacy/domain/resume-normalization";
import {
  moduleTitles,
  type ResumeState,
  type SectionKey,
} from "../legacy/domain/resume-model";
import {
  normalizePresentation,
  type ResumePresentation,
} from "../legacy/domain/template-model";
import type {
  ResumeBranch,
  ResumeCommit,
  ResumeVersionSnapshot,
  ResumeVersionStore,
} from "../legacy/domain/version-model";
import { documentFromSnapshot } from "./documentBridge";
import { nativeClient } from "./workspace";

const EXPORT_FORMAT = "zinecv-legacy-browser-export";

export type LegacyBrowserImport = {
  origin: string;
  snapshot: ResumeVersionSnapshot;
  store: ResumeVersionStore | null;
  sessionKeyCount: number;
};

function entriesToMap(entries: unknown): Map<string, string> {
  if (!Array.isArray(entries)) throw new Error("导出文件的 entries 不是数组");
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new Error("导出文件的 entries 存在非法条目");
    }
    map.set(entry[0], entry[1]);
  }
  return map;
}

function readString(map: Map<string, string>, key: string, fallback: string): string {
  const value = map.get(key);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function buildSnapshot(map: Map<string, string>): ResumeVersionSnapshot {
  const rawState = map.get("resume-diy-state");
  const resume: ResumeState = rawState
    ? migratePersonalSites(normalizeResumeState(JSON.parse(rawState) as Partial<ResumeState>))
    : normalizeResumeState({});
  const preferences = (() => {
    try {
      const parsed = JSON.parse(map.get("resume-diy-preferences") ?? "{}") as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  })();
  const storedOrder = (() => {
    try {
      const current = map.get("resume-diy-section-order-v2");
      if (current) return normalizeSectionOrder(JSON.parse(current));
      const saved = map.get("resume-diy-modules");
      if (!saved) return undefined;
      const parsed = normalizeSectionOrder(JSON.parse(saved));
      return parsed.includes("summary") ? parsed : [...parsed, "summary"];
    } catch {
      return undefined;
    }
  })();
  let moduleNames: Record<string, string>;
  try {
    const parsed = JSON.parse(map.get("resume-diy-module-names") ?? "{}") as Record<string, unknown>;
    moduleNames = { ...moduleTitles };
    for (const key of Object.keys(moduleTitles)) {
      if (typeof parsed[key] === "string") moduleNames[key] = parsed[key] as string;
    }
  } catch {
    moduleNames = { ...moduleTitles };
  }
  const layout = {
    font: typeof preferences.font === "string" ? preferences.font : "宋体",
    fontSize: typeof preferences.fontSize === "string" ? preferences.fontSize : "13",
    lineHeight: typeof preferences.lineHeight === "string" ? preferences.lineHeight : "13",
    moduleSpacing: typeof preferences.moduleSpacing === "string" ? preferences.moduleSpacing : "0",
    pageMargin: typeof preferences.pageMargin === "string" ? preferences.pageMargin : "30",
    theme: typeof preferences.theme === "string" ? preferences.theme : "#000000",
    dateFormat: preferences.dateFormat === "2021.01" ? "2021.01" : "2021年1月",
    titleFormat: preferences.titleFormat === "双行标题" ? "双行标题" : "单行标题",
    separator: preferences.separator === "不使用分隔符号" ? "不使用分隔符号" : "使用分隔符号",
    textAlign: preferences.textAlign === "系统默认" ? "系统默认" : "两端对齐",
  } as const;
  let presentation: ResumePresentation = normalizePresentation(undefined);
  const rawPresentation = map.get("resume-diy-presentation-v1");
  if (rawPresentation) {
    try {
      presentation = normalizePresentation(JSON.parse(rawPresentation));
    } catch {
      presentation = normalizePresentation(undefined);
    }
  }
  const importedTemplate = map.get("resume-diy-active-imported-template");
  const snapshot: ResumeVersionSnapshot = {
    schemaVersion: 2,
    presentation,
    resume,
    moduleOrder: (storedOrder ?? ["education", "skills", "work", "projects", "orgs", "summary"]) as SectionKey[],
    moduleNames,
    summaryTitle: readString(map, "resume-diy-summary-title", "自我评价"),
    resumeTitle: readString(map, "resume-diy-title", "resume DIY"),
    layout,
    importedTemplate: importedTemplate ? { id: importedTemplate, name: importedTemplate } : null,
  };
  return snapshot;
}

function buildStore(map: Map<string, string>): ResumeVersionStore | null {
  const raw = map.get("resume-diy-version-store-v1");
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("浏览器版本库数据无法解析，已跳过版本导入");
  }
  const store = parsed as Partial<ResumeVersionStore>;
  if (!store || !Array.isArray(store.branches) || !Array.isArray(store.commits) ||
      typeof store.currentBranchId !== "string") {
    throw new Error("浏览器版本库结构不完整，已跳过版本导入");
  }
  const documentId = nativeClient.snapshot?.document.documentId ?? "workspace-default-document";
  const branches: ResumeBranch[] = store.branches.map((branch) => ({
    id: String(branch?.id ?? ""),
    name: String(branch?.name ?? ""),
    createdAt: typeof branch?.createdAt === "string" ? branch.createdAt : new Date().toISOString(),
    headCommitId: typeof branch?.headCommitId === "string" ? branch.headCommitId : null,
  }));
  const commits: ResumeCommit[] = store.commits.map((commit) => {
    const snapshot = commit?.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      throw new Error(`版本“${String(commit?.message ?? commit?.id)}”缺少快照，已中止版本导入`);
    }
    // 提前走一次文档转换：不完整的快照在导入前报错，而不是写入一半。
    documentFromSnapshot(snapshot as ResumeVersionSnapshot, documentId);
    return {
      id: String(commit.id ?? ""),
      branchId: String(commit.branchId ?? ""),
      parentId: typeof commit.parentId === "string" ? commit.parentId : null,
      message: String(commit.message ?? ""),
      createdAt: typeof commit.createdAt === "string" ? commit.createdAt : new Date().toISOString(),
      snapshot: snapshot as ResumeVersionSnapshot,
    };
  });
  return { currentBranchId: store.currentBranchId, branches, commits };
}

export function parseLegacyBrowserExport(json: unknown): LegacyBrowserImport {
  const payload = json as { format?: unknown; version?: unknown; origin?: unknown; entries?: unknown };
  if (!payload || payload.format !== EXPORT_FORMAT || payload.version !== 1) {
    throw new Error("这不是旧版浏览器数据导出文件（格式或版本不符）");
  }
  const map = entriesToMap(payload.entries);
  const snapshot = buildSnapshot(map);
  const store = buildStore(map);
  const sessionKeyCount = Array.from(map.keys())
    .filter((key) => key.startsWith("resume-diy-agent-sessions-v2:")).length;
  return {
    origin: typeof payload.origin === "string" ? payload.origin : "unknown",
    snapshot,
    store,
    sessionKeyCount,
  };
}
