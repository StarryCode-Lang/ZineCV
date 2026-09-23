import {
  validateVersionSnapshot,
  validateVersionStore,
} from "../../server/version-schema.mjs";
import type {
  ResumeVersionSnapshot,
  ResumeVersionStore,
} from "../domain/version-model";

const VERSION_BACKUP_FORMAT = "resume-diy-version-backup";
const VERSION_BACKUP_FORMAT_VERSION = 2;

export type ResumeVersionBackup = {
  format: typeof VERSION_BACKUP_FORMAT;
  formatVersion: 1 | typeof VERSION_BACKUP_FORMAT_VERSION;
  exportedAt: string;
  store: ResumeVersionStore;
  draft?: {
    kind: "uncommitted-workspace";
    snapshot: ResumeVersionSnapshot;
  };
};

export type ParsedVersionBackup = {
  backup: ResumeVersionBackup;
  hasDraft: boolean;
  branchCount: number;
  commitCount: number;
};

const errorsFor = (errors: string[]) =>
  errors.length ? errors.slice(0, 3).join("；") : "未知格式错误";

export function createVersionBackup(
  store: ResumeVersionStore,
  draft: ResumeVersionSnapshot | null,
): ResumeVersionBackup {
  return {
    format: VERSION_BACKUP_FORMAT,
    formatVersion: VERSION_BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    store,
    ...(draft
      ? { draft: { kind: "uncommitted-workspace", snapshot: draft } }
      : {}),
  };
}

export function parseVersionBackup(raw: string): ParsedVersionBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("备份文件不是有效的 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("备份文件格式不完整");
  const candidate = parsed as Partial<ResumeVersionBackup>;
  if (candidate.format !== VERSION_BACKUP_FORMAT)
    throw new Error("不是 resume DIY 版本备份文件");
  if (candidate.formatVersion !== 1 && candidate.formatVersion !== 2)
    throw new Error("暂不支持此版本的备份格式");
  if (typeof candidate.exportedAt !== "string" || !candidate.exportedAt)
    throw new Error("备份文件缺少导出时间");
  const storeValidation = validateVersionStore(candidate.store, {
    mode: "read",
  });
  if (!storeValidation.valid)
    throw new Error(`备份版本库无效：${errorsFor(storeValidation.errors)}`);
  if (candidate.draft !== undefined) {
    if (!candidate.draft || candidate.draft.kind !== "uncommitted-workspace")
      throw new Error("备份草稿标记无效");
    const draftValidation = validateVersionSnapshot(candidate.draft.snapshot);
    if (!draftValidation.valid)
      throw new Error(`备份草稿无效：${errorsFor(draftValidation.errors)}`);
  }
  const backup = candidate as ResumeVersionBackup;
  return {
    backup,
    hasDraft: Boolean(backup.draft),
    branchCount: backup.store.branches.length,
    commitCount: backup.store.commits.length,
  };
}
