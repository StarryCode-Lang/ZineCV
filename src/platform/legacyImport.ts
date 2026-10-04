// 旧版浏览器数据导出（zinecv-legacy-browser-export）→ 桌面工作区/版本库。
// 只读取导出文件，不访问旧 origin 本身；解析结果经既有 normalize/版本替换
// 通道进入 SQLite，与手动操作走完全相同的路径。
import {
  migratePersonalSites,
  normalizeResumeState,
  normalizeSectionOrder,
} from "../ui/domain/resume-normalization";
import {
  moduleTitles,
  type ResumeState,
  type SectionKey,
} from "../ui/domain/resume-model";
import {
  normalizePresentation,
  type ResumePresentation,
} from "../ui/domain/template-model";
import type {
  ResumeBranch,
  ResumeCommit,
  ResumeVersionSnapshot,
  ResumeVersionStore,
} from "../ui/domain/version-model";
import { documentFromSnapshot } from "./documentBridge";
import { nativeInvoke } from "./ipc";
import { nativeClient } from "./workspace";
import type { AuthorityCursor } from "../../src-tauri/src/domain/bindings/AuthorityCursor";
import type { CommitLegacyMigrationRequest } from "../../src-tauri/src/domain/bindings/CommitLegacyMigrationRequest";
import type { LegacyMigrationPreference } from "../../src-tauri/src/domain/bindings/LegacyMigrationPreference";
import type { LegacyMigrationTemplates } from "../../src-tauri/src/domain/bindings/LegacyMigrationTemplates";
import { parseImportedTemplates, type ImportedTemplate } from "../ui/domain/imported-template";
import type { LegacyMigrationConvertedDocument } from "../../src-tauri/src/domain/bindings/LegacyMigrationConvertedDocument";
import type { LegacyMigrationDryRun } from "../../src-tauri/src/domain/bindings/LegacyMigrationDryRun";
import type { LegacyMigrationExpectedHash } from "../../src-tauri/src/domain/bindings/LegacyMigrationExpectedHash";
import type { LegacyMigrationIdentityConflict } from "../../src-tauri/src/domain/bindings/LegacyMigrationIdentityConflict";
import type { LegacyMigrationReport } from "../../src-tauri/src/domain/bindings/LegacyMigrationReport";
import type { LegacyMigrationSourceKind } from "../../src-tauri/src/domain/bindings/LegacyMigrationSourceKind";
import type { LegacyMigrationVersionGraph } from "../../src-tauri/src/domain/bindings/LegacyMigrationVersionGraph";
import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";

const EXPORT_FORMAT = "zinecv-legacy-browser-export";

export type LegacyBrowserImport = {
  origin: string;
  snapshot: ResumeVersionSnapshot;
  store: ResumeVersionStore | null;
  sessionKeyCount: number;
  preferences: LegacyMigrationPreference[];
  templates: ImportedTemplate[];
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
  const store = parsed as Partial<ResumeVersionStore> | null;
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
  // 旧版偏好记录按原样保留到桌面 settings 表的 legacy.* 命名空间，
  // 不映射成新的工作区偏好键；损坏记录由原生 inspect 报告为审阅项。
  const legacyPreferenceEntries: Array<[string, string | undefined]> = [
    ["legacy.resume-diy-preferences", map.get("resume-diy-preferences")],
    ["legacy.resume-diy-presentation-v1", map.get("resume-diy-presentation-v1")],
  ];
  const preferences: LegacyMigrationPreference[] = legacyPreferenceEntries.flatMap(
    ([key, raw]) => {
      if (typeof raw !== "string" || raw.length === 0 || raw.length > 16384) return [];
      try {
        const parsedValue = JSON.parse(raw) as unknown;
        if (!parsedValue || typeof parsedValue !== "object") return [];
      } catch {
        return [];
      }
      return [{ key, value: raw }];
    },
  );
  const templates = parseImportedTemplates(map.get("resume-diy-imported-templates-v1") ?? "[]");
  return {
    origin: typeof payload.origin === "string" ? payload.origin : "unknown",
    snapshot,
    store,
    sessionKeyCount,
    preferences,
    templates,
  };
}

// 旧版本机项目文件 `.data/versions.json`：裸 ResumeVersionStore。版本图只
// 包含历史提交，不能据当前 branch head 推断或覆盖工作区草稿。
export type LegacyProjectImport = {
  snapshot: ResumeVersionSnapshot | null;
  store: ResumeVersionStore;
};

function looksLikeVersionStore(value: unknown): value is Partial<ResumeVersionStore> {
  const store = value as Partial<ResumeVersionStore> | null;
  return store !== null
    && typeof store === "object"
    && typeof store.currentBranchId === "string"
    && Array.isArray(store.branches)
    && Array.isArray(store.commits);
}

export function parseLegacyProjectVersions(json: unknown): LegacyProjectImport {
  if (!looksLikeVersionStore(json)) {
    throw new Error("这不是旧版项目版本文件（缺少 branches/commits 结构）");
  }
  const store = buildStore(new Map([
    ["resume-diy-version-store-v1", JSON.stringify(json)],
  ]));
  if (!store) throw new Error("项目版本文件解析失败");
  return { snapshot: null, store };
}

export type LegacyDataImport =
  | ({ kind: "browser-export" } & LegacyBrowserImport)
  | ({ kind: "project-versions" } & LegacyProjectImport);

export type PreparedLegacyMigration = {
  request: CommitLegacyMigrationRequest;
  report: LegacyMigrationReport;
  dryRun: LegacyMigrationDryRun;
  namespace: string;
  identityConflicts: LegacyMigrationIdentityConflict[];
};

export async function legacyMigrationNamespace(
  parsed: LegacyDataImport,
  fileName: string,
): Promise<string> {
  const prefix = parsed.kind === "browser-export" ? "browser" : "versions";
  const identity = parsed.kind === "browser-export" ? parsed.origin : fileName;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${prefix}\0${identity}`),
  );
  const shortHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
  return `resume-diy-${prefix}-${shortHash}`;
}

export async function prepareLegacyMigration(
  jsonText: string,
  parsed: LegacyDataImport,
  cursor: AuthorityCursor,
  namespace: string,
): Promise<PreparedLegacyMigration> {
  const sourceId = parsed.kind === "browser-export" ? "browser-export" : "version-json";
  const sourceKind: LegacyMigrationSourceKind = parsed.kind === "browser-export"
    ? "browser_export"
    : "version_json";
  const inspection = {
    sourceNamespace: namespace,
    sources: [{ sourceId, kind: sourceKind, rawJson: jsonText }],
  };
  const report = await nativeInvoke("inspect_legacy_migration", { request: inspection }) as LegacyMigrationReport;
  if (!report.readyForDryRun || report.namespaceDecisionRequired) {
    const blocking = [...report.issues, ...report.sources.flatMap((source) => source.issues)]
      .filter((issue) => issue.severity === "error")
      .map((issue) => issue.message);
    throw new Error(blocking.length
      ? `旧版数据检查未通过：${blocking.slice(0, 4).join("；")}`
      : "旧版数据需要先解决命名空间或结构问题；当前数据未改动");
  }

  const sourceReport = report.sources.find((source) => source.sourceId === sourceId);
  if (!sourceReport) throw new Error("原生检查未返回来源清单");
  const expectedSourceHashes: LegacyMigrationExpectedHash[] = report.sources.map((source) => ({
    sourceId: source.sourceId,
    sourceSha256: source.sourceSha256,
  }));
  const convertedDocuments: LegacyMigrationConvertedDocument[] = [];
  let currentDraft: ResumeDocument | null = null;
  if (parsed.kind === "browser-export") {
    currentDraft = documentFromSnapshot(parsed.snapshot, cursor.documentId);
    convertedDocuments.push({
      sourceId,
      sourceSha256: sourceReport.sourceSha256,
      documentKind: "current_draft",
      legacyId: "current-draft",
      document: currentDraft,
    });
  }

  let versionGraph: LegacyMigrationVersionGraph | null = null;
  if (parsed.store) {
    const branches = parsed.store.branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      headCommitId: branch.headCommitId,
      createdAt: branch.createdAt,
    }));
    const commits = parsed.store.commits.map((commit) => {
      if (!commit.snapshot) throw new Error("备份版本缺少快照，无法迁移");
      const document = documentFromSnapshot(commit.snapshot, cursor.documentId);
      convertedDocuments.push({
        sourceId,
        sourceSha256: sourceReport.sourceSha256,
        documentKind: "version_commit",
        legacyId: commit.id,
        document,
      });
      return {
        id: commit.id,
        branchId: commit.branchId,
        parentId: commit.parentId,
        message: commit.message,
        createdAt: commit.createdAt,
        snapshot: document,
      };
    });
    versionGraph = {
      sourceId,
      currentBranchId: parsed.store.currentBranchId,
      branches,
      commits,
    };
  }

  const dryRun = await nativeInvoke("dry_run_legacy_migration", {
    request: { inspection, expectedSourceHashes, convertedDocuments },
  }) as LegacyMigrationDryRun;
  if (dryRun.status !== "ready" && dryRun.status !== "requires_review") {
    const issues = dryRun.conversionIssues.map((issue) => issue.message);
    throw new Error(issues.length
      ? `旧版数据转换未通过：${issues.slice(0, 4).join("；")}`
      : `旧版数据预演未通过（${dryRun.status}）；当前数据未改动`);
  }
  const identityConflicts = versionGraph
    ? await nativeInvoke("inspect_legacy_identity_conflicts", {
        request: {
          targetDocumentId: cursor.documentId,
          sourceNamespace: namespace,
          versionGraph,
        },
      }) as LegacyMigrationIdentityConflict[]
    : [];
  // 模板目录：现有目录优先，旧版模板仅按稳定 ID 追加新增项；同 ID 冲突
  // 不覆盖现有条目，由迁移审阅报告的模板计数核对。
  let templates: LegacyMigrationTemplates | null = null;
  if (parsed.kind === "browser-export" && parsed.templates.length > 0) {
    const stored = await nativeInvoke("read_imported_template_catalog") as {
      revision: number;
      payloadJson: string;
    } | null;
    const existing: Array<{ id?: unknown }> = (() => {
      if (!stored) return [];
      try {
        const value = JSON.parse(stored.payloadJson) as unknown;
        return Array.isArray(value) ? (value as Array<{ id?: unknown }>) : [];
      } catch {
        return [];
      }
    })();
    const existingIds = new Set(existing.map((entry) => String(entry.id ?? "")));
    const additions = parsed.templates.filter((template) => !existingIds.has(template.id));
    templates = {
      expectedRevision: String(stored?.revision ?? 0),
      catalogJson: JSON.stringify([...existing, ...additions]),
    };
  }
  return {
    request: {
      commandId: crypto.randomUUID(),
      cursor,
      inspection,
      expectedSourceHashes,
      confirmed: false,
      acknowledgedReviewItems: [],
      acceptedIdentityUpdates: identityConflicts.map((conflict) => conflict.conflictKey),
      currentDraft,
      versionGraph,
      preferences: parsed.kind === "browser-export" ? parsed.preferences : [],
      templates,
    },
    report,
    dryRun,
    namespace,
    identityConflicts,
  };
}

async function reviewItemKeys(report: LegacyMigrationReport): Promise<string[]> {
  const items = [...report.issues, ...report.sources.flatMap((source) => source.issues)]
    .filter((issue) => issue.severity === "review");
  const keys = await Promise.all(items.map(async (issue) => {
    const bytes = new TextEncoder().encode(`${issue.sourceId}\0${issue.code}\0${issue.path}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }));
  return [...new Set(keys)].sort();
}

export async function commitPreparedLegacyMigration(
  prepared: PreparedLegacyMigration,
): Promise<import("../../src-tauri/src/domain/bindings/LegacyMigrationCommitReceipt").LegacyMigrationCommitReceipt> {
  const request: CommitLegacyMigrationRequest = {
    ...prepared.request,
    confirmed: true,
    acknowledgedReviewItems: await reviewItemKeys(prepared.report),
  };
  return await nativeInvoke("commit_legacy_migration", { request }) as import(
    "../../src-tauri/src/domain/bindings/LegacyMigrationCommitReceipt"
  ).LegacyMigrationCommitReceipt;
}

// 同一文件入口自动识别：旧版浏览器导出包 / 裸项目版本库 JSON。
export function parseLegacyDataFile(json: unknown): LegacyDataImport {
  const asObject = json as { format?: unknown } | null;
  if (asObject && asObject.format === EXPORT_FORMAT) {
    return { kind: "browser-export", ...parseLegacyBrowserExport(json) };
  }
  return { kind: "project-versions", ...parseLegacyProjectVersions(json) };
}
