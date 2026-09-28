// 桌面版版本库钩子：与旧版 useResumeVersions 相同的返回面与确认流，
// 数据与事务全部来自 Rust SQLite（commit/branch/delete 事务 + 修订 CAS）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VersionGraphDetailed } from "../../src-tauri/src/domain/bindings/VersionGraphDetailed";
import type { AuthorityCursor } from "../../src-tauri/src/domain/bindings/AuthorityCursor";
import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";
import type { ConfirmAction } from "../legacy/domain/resume-model";
import type {
  ResumeBranch,
  ResumeCommit,
  ResumeVersionSnapshot,
  ResumeVersionStore,
} from "../legacy/domain/version-model";
import { documentFromSnapshot, documentsEqual, snapshotFromDocument } from "./documentBridge";
import {
  flushDraftBeforeVersionAction,
  nativeClient,
  reloadWorkspaceState,
} from "./workspace";
import { nativeInvoke } from "./ipc";

type VersionOptions = {
  workingSnapshot: ResumeVersionSnapshot;
  notify: (message: string) => void;
  requestConfirmation: (action: ConfirmAction) => void;
  applyVersionSnapshot: (snapshot: ResumeVersionSnapshot) => void;
  enabled: boolean;
};

type GraphPayload = {
  cursor: AuthorityCursor;
  branches: VersionGraphDetailed["branches"];
  commits: Array<
    VersionGraphDetailed["commits"][number] & { snapshotDocument: ResumeDocument }
  >;
};

function storeFromGraph(graph: GraphPayload): ResumeVersionStore {
  const branches: ResumeBranch[] = graph.branches.map((branch) => ({
    id: branch.id,
    name: branch.name,
    createdAt: branch.createdAt,
    headCommitId: branch.headCommitId,
  }));
  const commits: ResumeCommit[] = graph.commits.map((commit) => ({
    id: commit.id,
    branchId: commit.originBranchId,
    parentId: commit.parentId,
    message: commit.message,
    createdAt: commit.createdAt,
    snapshot: snapshotFromDocument(commit.snapshotDocument, ""),
  }));
  const current = graph.branches.find((branch) => branch.isCurrent);
  return {
    currentBranchId: current?.id ?? branches[0]?.id ?? "main",
    branches,
    commits,
  };
}

function parseGraph(payload: unknown): GraphPayload {
  const raw = payload as VersionGraphDetailed & {
    commits: Array<VersionGraphDetailed["commits"][number] & { snapshotDocumentJson: string }>;
  };
  return {
    cursor: raw.cursor,
    branches: raw.branches,
    commits: raw.commits.map((commit) => ({
      ...commit,
      snapshotDocument: JSON.parse(commit.snapshotDocumentJson) as ResumeDocument,
    })),
  };
}

function currentCursor(): AuthorityCursor {
  const cursor = nativeClient.snapshot?.cursor;
  if (!cursor) throw new Error("文档尚未就绪");
  return cursor;
}

export function useNativeResumeVersions({
  workingSnapshot,
  notify,
  requestConfirmation,
  applyVersionSnapshot,
  enabled,
}: VersionOptions) {
  const [versionStore, setVersionStore] = useState<ResumeVersionStore>(() => ({
    currentBranchId: "main",
    branches: [
      { id: "main", name: "默认版本", createdAt: "", headCommitId: null },
    ],
    commits: [],
  }));
  const [storageStatus, setStorageStatus] = useState("正在读取版本库…");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const graphRef = useRef<GraphPayload | null>(null);
  const snapshotRef = useRef(workingSnapshot);
  snapshotRef.current = workingSnapshot;

  const currentBranch = versionStore.branches.find(
    (branch) => branch.id === versionStore.currentBranchId,
  );
  const currentHead = versionStore.commits.find(
    (commit) => commit.id === currentBranch?.headCommitId,
  );

  // 未提交判断在文档层做 canonical 比较：head 的原生快照与当前草稿文档直接对比，
  // 避免旧 HTML round-trip 归一化差异造成的误报。
  const headDocument = useMemo(() => {
    const graph = graphRef.current;
    const branch = graph?.branches.find((item) => item.isCurrent);
    return graph?.commits.find((commit) => commit.id === branch?.headCommitId)?.snapshotDocument ?? null;
  }, [versionStore]);
  const draftDocument = useMemo(() => {
    try {
      return documentFromSnapshot(
        snapshotRef.current,
        nativeClient.snapshot?.document.documentId ?? "workspace-default-document",
      );
    } catch {
      return null;
    }
  }, [workingSnapshot]);
  const hasUncommittedChanges = useMemo(() => {
    if (!ready) return false;
    if (!headDocument || !draftDocument) return true;
    return !documentsEqual(headDocument, draftDocument);
  }, [draftDocument, headDocument, ready]);

  const refreshGraph = useCallback(async (): Promise<GraphPayload | null> => {
    try {
      const payload = parseGraph(await nativeInvoke("version_graph_detailed"));
      graphRef.current = payload;
      setVersionStore(storeFromGraph(payload));
      return payload;
    } catch (error) {
      setStorageStatus(error instanceof Error ? error.message : "版本库读取失败，请刷新重试");
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void (async () => {
      const graph = await refreshGraph();
      if (!active) return;
      if (graph) {
        setStorageStatus("已保存到本机数据库");
        setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [enabled, refreshGraph]);

  const runVersionAction = useCallback(
    async (action: () => Promise<void>, successMessage: string | null) => {
      if (savingRef.current) return false;
      savingRef.current = true;
      setSaving(true);
      try {
        await flushDraftBeforeVersionAction();
        await action();
        await refreshGraph();
        if (successMessage) notify(successMessage);
        setStorageStatus("已保存到本机数据库");
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "版本操作失败";
        setStorageStatus(message);
        notify(message);
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [notify, refreshGraph],
  );

  // 切分支/历史载入/删除会让 Rust 重写草稿；统一重新载入文档并恢复工作区视图。
  const applyCurrentDraftToWorkspace = useCallback(async () => {
    const { snapshot } = await reloadWorkspaceState();
    applyVersionSnapshot(snapshot);
  }, [applyVersionSnapshot]);

  const commitVersion = useCallback(
    (message: string) => {
      const branchName = currentBranch?.name ?? "当前分支";
      return runVersionAction(async () => {
        await nativeInvoke("commit_version", { cursor: currentCursor(), message });
        await nativeClient.reload();
      }, `已提交到“${branchName}”`);
    },
    [currentBranch?.name, runVersionAction],
  );

  const createBranch = useCallback(
    (name: string) =>
      runVersionAction(async () => {
        const graph = graphRef.current;
        if (graph?.branches.some(
          (branch) => branch.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        )) {
          throw new Error("已经存在同名分支");
        }
        await nativeInvoke("create_version_branch", { cursor: currentCursor(), name });
        await nativeClient.reload();
      }, `已创建并切换到“${name}”`),
    [runVersionAction],
  );

  const switchBranch = useCallback(
    (branchId: string) => {
      if (branchId === versionStore.currentBranchId) return;
      const branch = versionStore.branches.find((item) => item.id === branchId);
      if (!branch) return;
      const switchNow = () => {
        void runVersionAction(async () => {
          await nativeInvoke("switch_version_branch", {
            cursor: currentCursor(),
            branchId,
            discardUncommitted: true,
          });
          await applyCurrentDraftToWorkspace();
        }, `已切换到“${branch.name}”`);
      };
      if (hasUncommittedChanges) {
        requestConfirmation({
          title: `切换到“${branch.name}”？`,
          description: "当前未提交修改会被目标分支内容替换，请先提交需要保留的版本。",
          confirmLabel: "放弃修改并切换",
          onConfirm: switchNow,
        });
      } else {
        switchNow();
      }
    },
    [applyCurrentDraftToWorkspace, hasUncommittedChanges, requestConfirmation, runVersionAction, versionStore],
  );

  const jumpToBranch = useCallback(
    (branch: ResumeBranch) => {
      if (!branch.headCommitId) {
        notify("当前分支还没有可跳转的版本");
        return;
      }
      const jumpNow = () => {
        void runVersionAction(async () => {
          await nativeInvoke("switch_version_branch", {
            cursor: currentCursor(),
            branchId: branch.id,
            discardUncommitted: true,
          });
          await applyCurrentDraftToWorkspace();
        }, `已跳转到“${branch.name}”的最新版本`);
      };
      if (hasUncommittedChanges) {
        requestConfirmation({
          title: `跳转到“${branch.name}”？`,
          description: "当前未提交修改会被目标分支最新版本替换。",
          confirmLabel: "跳转到当前分支",
          onConfirm: jumpNow,
        });
      } else void jumpNow();
    },
    [applyCurrentDraftToWorkspace, hasUncommittedChanges, notify, requestConfirmation, runVersionAction],
  );

  const loadCommit = useCallback(
    (commit: ResumeCommit) => {
      requestConfirmation({
        title: `载入“${commit.message}”？`,
        description: "当前工作内容会切换到该版本；未提交修改不会被保存。",
        confirmLabel: "载入此版本",
        onConfirm: () => {
          void runVersionAction(async () => {
            await nativeInvoke("load_history_commit", {
              cursor: currentCursor(),
              commitId: commit.id,
              confirmed: true,
            });
            await applyCurrentDraftToWorkspace();
          }, "版本已载入到工作区");
        },
      });
    },
    [applyCurrentDraftToWorkspace, requestConfirmation, runVersionAction],
  );

  const deleteCommit = useCallback(
    (commit: ResumeCommit) => {
      requestConfirmation({
        title: `删除版本“${commit.message}”？`,
        description:
          "该版本会从历史与分支图中同时移除，后续版本会自动接回它的上一个版本。此操作无法撤销。",
        confirmLabel: "删除当前版本",
        onConfirm: () => {
          void runVersionAction(async () => {
            const wasCurrentHead = currentHead?.id === commit.id;
            await nativeInvoke("delete_version_commit", {
              cursor: currentCursor(),
              commitId: commit.id,
              confirmed: true,
            });
            // 旧版语义：删除当前 head 后工作区切到新的 head；Rust 已把原内容保留为草稿，
            // 这里显式载入新 head，使桌面行为与旧版一致。
            if (wasCurrentHead) {
              const graph = await refreshGraph();
              const branchId = nativeClient.snapshot?.cursor.branchId;
              const nextHead = graph?.branches.find((branch) => branch.id === branchId)?.headCommitId;
              if (nextHead) {
                await nativeInvoke("load_history_commit", {
                  cursor: currentCursor(),
                  commitId: nextHead,
                  confirmed: true,
                });
              }
            }
            await applyCurrentDraftToWorkspace();
          }, "版本已从历史与分支图中删除");
        },
      });
    },
    [applyCurrentDraftToWorkspace, currentHead, refreshGraph, requestConfirmation, runVersionAction],
  );

  const deleteBranch = useCallback(
    (branch: ResumeBranch) => {
      if (branch.id === "main" || branch.id.startsWith("main:")) return;
      requestConfirmation({
        title: `删除分支“${branch.name}”？`,
        description:
          "该分支入口会被删除；其他分支依赖的祖先提交会保留并标记为已删除来源，其余不可达提交会移除。此操作无法撤销。",
        confirmLabel: "删除分支",
        onConfirm: () => {
          void runVersionAction(async () => {
            const wasCurrent = versionStore.currentBranchId === branch.id;
            await nativeInvoke("delete_version_branch", {
              cursor: currentCursor(),
              branchId: branch.id,
              confirmed: true,
            });
            if (wasCurrent) {
              await applyCurrentDraftToWorkspace();
            }
          }, "分支已删除");
        },
      });
    },
    [applyCurrentDraftToWorkspace, requestConfirmation, runVersionAction, versionStore.currentBranchId],
  );

  const replaceVersionStore = useCallback(
    (next: ResumeVersionStore) =>
      runVersionAction(async () => {
        const cursor = currentCursor();
        const draft = nativeClient.snapshot?.document;
        if (!draft) throw new Error("文档尚未就绪");
        const branches = next.branches.map((branch) => ({
          id: branch.id,
          name: branch.name,
          headCommitId: branch.headCommitId ?? null,
          createdAt: branch.createdAt || new Date().toISOString(),
        }));
        const commits = next.commits.map((commit) => ({
          id: commit.id,
          branchId: commit.branchId,
          parentId: commit.parentId,
          message: commit.message,
          createdAt: commit.createdAt,
          snapshot: documentFromSnapshot(commit.snapshot, cursor.documentId),
        }));
        await nativeInvoke("replace_version_store", {
          cursor,
          replacement: {
            currentBranchId: next.currentBranchId,
            branches,
            commits,
            draft,
          },
        });
        await applyCurrentDraftToWorkspace();
      }, "版本库已替换，当前工作内容未自动变更"),
    [applyCurrentDraftToWorkspace, runVersionAction],
  );

  return {
    storageStatus,
    storageBusy: !ready || saving,
    versionStore,
    hasUncommittedChanges,
    commitVersion,
    createBranch,
    replaceVersionStore,
    switchBranch,
    loadCommit,
    jumpToBranch,
    deleteCommit,
    deleteBranch,
  };
}
