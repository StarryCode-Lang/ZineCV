import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";
import type { VersionCommitDetailed } from "../../src-tauri/src/domain/bindings/VersionCommitDetailed";
import type { ResumeCommit, ResumeVersionSnapshot, ResumeVersionStore } from "../ui/domain/version-model";
import { nativeInvoke } from "./ipc";
import { nativeClient, snapshotFromLoadedDocument } from "./workspace";

// 历史图只物化有界窗口；需要快照的操作单独读取，不缓存跨工作区响应。
export async function loadCommitDetail(commitId: string, expected?: ResumeCommit): Promise<ResumeVersionSnapshot> {
  const epoch = nativeClient.currentSessionEpoch;
  const contextId = nativeClient.snapshot?.cursor.contextId;
  const detail = await nativeInvoke("version_commit_detail", { commitId }) as VersionCommitDetailed;
  if (detail.id !== commitId || !detail.snapshotDocumentJson) {
    throw new Error("版本详情无效，请刷新版本库后重试");
  }
  if (expected && (detail.originBranchId !== expected.branchId || detail.parentId !== expected.parentId ||
      detail.message !== expected.message || detail.createdAt !== expected.createdAt)) {
    throw new Error("版本库已变化，请刷新版本列表后重试备份");
  }
  const snapshot = await snapshotFromLoadedDocument(JSON.parse(detail.snapshotDocumentJson) as ResumeDocument);
  if (epoch !== nativeClient.currentSessionEpoch || contextId !== nativeClient.snapshot?.cursor.contextId) {
    throw new Error("工作区已切换，请重新选择版本");
  }
  return snapshot;
}

export async function materializeVersionStore(store: ResumeVersionStore): Promise<ResumeVersionStore> {
  const cursor = nativeClient.snapshot?.cursor;
  const epoch = nativeClient.currentSessionEpoch;
  const cursorKey = (value: typeof cursor) => value && JSON.stringify([
    value.documentId, value.contextId, value.branchId, value.headId, value.revision,
  ]);
  const expectedCursor = cursorKey(cursor);
  const branch = store.branches.find((item) => item.id === store.currentBranchId);
  if (!cursor || !branch || cursor.branchId !== branch.id || cursor.headId !== branch.headCommitId ||
      cursor.headId && !store.commits.some((commit) => commit.id === cursor.headId)) {
    throw new Error("版本库已变化，请刷新版本列表后重试备份");
  }
  const commits = [];
  // 备份需要全量快照；顺序读取避免把大历史同时排入原生 IPC 队列。
  for (const commit of store.commits) {
    commits.push(commit.snapshot ? commit : { ...commit, snapshot: await loadCommitDetail(commit.id, commit) });
    if (epoch !== nativeClient.currentSessionEpoch || expectedCursor !== cursorKey(nativeClient.snapshot?.cursor)) {
      throw new Error("版本库已变化，请刷新版本列表后重试备份");
    }
  }
  if (epoch !== nativeClient.currentSessionEpoch || expectedCursor !== cursorKey(nativeClient.snapshot?.cursor)) {
    throw new Error("版本库已变化，请刷新版本列表后重试备份");
  }
  return { ...store, commits };
}
