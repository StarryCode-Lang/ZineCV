import { useEffect, useMemo, useRef, useState } from "react";

import {
  loadProjectVersions,
  saveProjectVersions,
  cacheVersions,
  reconcileVersions,
  readVersionStoreResult,
  removeBranchPreservingAncestors,
  removeCommitPreservingGraph,
} from "../services/version-storage";

import type { ConfirmAction } from "../domain/resume-model";
import type {
  ResumeBranch,
  ResumeCommit,
  ResumeVersionSnapshot,
  ResumeVersionStore,
} from "../domain/version-model";
import { createEntityId, readStoredString } from "../utils/resume";

type VersionOptions = {
  workingSnapshot: ResumeVersionSnapshot;
  notify: (message: string) => void;
  requestConfirmation: (action: ConfirmAction) => void;
  applyVersionSnapshot: (snapshot: ResumeVersionSnapshot) => void;
};
export function useResumeVersions({
  workingSnapshot,
  notify,
  requestConfirmation,
  applyVersionSnapshot,
}: VersionOptions) {
  const [versionStore, setVersionStore] = useState<ResumeVersionStore>(
    () => readVersionStoreResult().store,
  );
  const [storageStatus, setStorageStatus] = useState("正在读取版本库…");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const revisionRef = useRef<string | null>(null);
  const hadDraft = useRef(Boolean(readStoredString("resume-diy-state", "")));
  const initialWorkspace = useRef({ workingSnapshot, applyVersionSnapshot });
  const currentBranch = versionStore.branches.find(
    (branch) => branch.id === versionStore.currentBranchId,
  );
  const currentHead = versionStore.commits.find(
    (commit) => commit.id === currentBranch?.headCommitId,
  );
  const hasUncommittedChanges = useMemo(
    () =>
      !currentHead ||
      JSON.stringify(currentHead.snapshot) !== JSON.stringify(workingSnapshot),
    [currentHead, workingSnapshot],
  );

  // 第一次启用版本库时自动建立主分支基线，确保任何分支都能安全切回。
  useEffect(() => {
    const { workingSnapshot, applyVersionSnapshot } = initialWorkspace.current;
    let active = true;
    const initialize = async () => {
      try {
        const project = await loadProjectVersions();
        if (!active) return;
        const local = readVersionStoreResult();
        if (!project && local.hasInvalidData) {
          setStorageStatus(
            local.message ?? "浏览器版本库读取失败，原文件未改动",
          );
          return;
        }
        let current = project?.store
          ? reconcileVersions(local.store, project.store)
          : local.store;
        const main = current.branches.find((branch) => branch.id === "main");
        if (main && !main.headCommitId && !current.commits.length) {
          const commit: ResumeCommit = {
            id: createEntityId("commit"),
            branchId: "main",
            parentId: null,
            message: "初始版本",
            createdAt: new Date().toISOString(),
            snapshot: JSON.parse(
              JSON.stringify(workingSnapshot),
            ) as ResumeVersionSnapshot,
          };
          current = {
            ...current,
            branches: current.branches.map((branch) =>
              branch.id === "main"
                ? { ...branch, headCommitId: commit.id }
                : branch,
            ),
            commits: [commit],
          };
        }
        if (project) {
          revisionRef.current = local.hasInvalidData
            ? project.revision
            : await saveProjectVersions(current, project.revision);
        }
        if (!active) return;
        const cached = local.hasInvalidData ? true : cacheVersions(current);
        if (!cached && !project)
          throw new Error("浏览器版本保存失败，请检查存储空间后刷新");
        setVersionStore(current);
        if (project?.store && !hadDraft.current) {
          const head = current.branches.find(
            (branch) => branch.id === current.currentBranchId,
          )?.headCommitId;
          const snapshot = current.commits.find(
            (commit) => commit.id === head,
          )?.snapshot;
          if (snapshot) applyVersionSnapshot(snapshot);
        }
        const savedStatus = project ? "已保存到本机项目" : "已保存到当前浏览器";
        setStorageStatus(
          local.message ? `${savedStatus}；${local.message}` : savedStatus,
        );
        setReady(true);
      } catch (error) {
        if (active)
          setStorageStatus(
            error instanceof Error
              ? error.message
              : "版本库读取失败，请刷新重试",
          );
      }
    };
    void initialize();
    return () => {
      active = false;
    };
    // 只在首次挂载时创建基线；后续修改由用户主动提交。
  }, []);

  const persistVersionStore = async (next: ResumeVersionStore) => {
    if (!ready || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      if (revisionRef.current !== null)
        revisionRef.current = await saveProjectVersions(
          next,
          revisionRef.current,
        );
      const cached = cacheVersions(next);
      if (!cached && revisionRef.current === null)
        throw new Error("浏览器保存失败，请检查存储空间");
      setVersionStore(next);
      setStorageStatus(
        revisionRef.current !== null
          ? "已保存到本机项目"
          : "已保存到当前浏览器",
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "版本保存失败";
      setStorageStatus(message);
      notify(message);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const commitVersion = async (message: string) => {
    const branch = versionStore.branches.find(
      (item) => item.id === versionStore.currentBranchId,
    );
    if (!branch) return false;
    const commit: ResumeCommit = {
      id: createEntityId("commit"),
      branchId: branch.id,
      parentId: branch.headCommitId,
      message,
      createdAt: new Date().toISOString(),
      snapshot: JSON.parse(
        JSON.stringify(workingSnapshot),
      ) as ResumeVersionSnapshot,
    };
    const next = {
      ...versionStore,
      branches: versionStore.branches.map((item) =>
        item.id === branch.id ? { ...item, headCommitId: commit.id } : item,
      ),
      commits: [...versionStore.commits, commit],
    };
    const saved = await persistVersionStore(next);
    if (saved) notify(`已提交到“${branch.name}”`);
    return saved;
  };

  const createBranch = async (name: string) => {
    if (
      versionStore.branches.some(
        (branch) =>
          branch.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      notify("已经存在同名分支");
      return false;
    }
    const branchId = createEntityId("branch");
    const commitId = createEntityId("commit");
    const now = new Date().toISOString();
    const branch: ResumeBranch = {
      id: branchId,
      name,
      createdAt: now,
      headCommitId: commitId,
    };
    const commit: ResumeCommit = {
      id: commitId,
      branchId,
      parentId: currentBranch?.headCommitId ?? null,
      message: `创建分支：${name}`,
      createdAt: now,
      snapshot: JSON.parse(
        JSON.stringify(workingSnapshot),
      ) as ResumeVersionSnapshot,
    };
    const next = {
      currentBranchId: branchId,
      branches: [...versionStore.branches, branch],
      commits: [...versionStore.commits, commit],
    };
    const saved = await persistVersionStore(next);
    if (saved) notify(`已创建并切换到“${name}”`);
    return saved;
  };

  const replaceVersionStore = async (next: ResumeVersionStore) => {
    const saved = await persistVersionStore(next);
    if (saved) notify("版本库已替换，当前工作内容未自动变更");
    return saved;
  };

  const switchBranch = (branchId: string) => {
    if (branchId === versionStore.currentBranchId) return;
    const branch = versionStore.branches.find((item) => item.id === branchId);
    if (!branch) return;
    const switchNow = async () => {
      const head = versionStore.commits.find(
        (commit) => commit.id === branch.headCommitId,
      );
      if (
        await persistVersionStore({
          ...versionStore,
          currentBranchId: branchId,
        })
      ) {
        if (head) applyVersionSnapshot(head.snapshot);
        notify(`已切换到“${branch.name}”`);
      }
    };
    if (hasUncommittedChanges) {
      requestConfirmation({
        title: `切换到“${branch.name}”？`,
        description:
          "当前未提交修改会被目标分支内容替换，请先提交需要保留的版本。",
        confirmLabel: "放弃修改并切换",
        onConfirm: switchNow,
      });
    } else {
      switchNow();
    }
  };

  const restoreCommit = (commit: ResumeCommit) => {
    requestConfirmation({
      title: `恢复“${commit.message}”？`,
      description: "该版本会载入为当前工作内容；确认无误后可再次提交为新版本。",
      confirmLabel: "恢复此版本",
      onConfirm: () => {
        applyVersionSnapshot(commit.snapshot);
        notify("版本已恢复到工作区");
      },
    });
  };

  const jumpToCommit = (commit: ResumeCommit) => {
    requestConfirmation({
      title: `跳转到“${commit.message}”？`,
      description: "当前工作内容会切换到该版本；未提交修改不会被保存。",
      confirmLabel: "跳转到此版本",
      onConfirm: () => {
        applyVersionSnapshot(commit.snapshot);
        notify("已跳转到所选版本");
      },
    });
  };

  const jumpToBranch = (branch: ResumeBranch) => {
    const head = versionStore.commits.find(
      (commit) => commit.id === branch.headCommitId,
    );
    if (!head) {
      notify("当前分支还没有可跳转的版本");
      return;
    }
    const jumpNow = async () => {
      if (
        await persistVersionStore({
          ...versionStore,
          currentBranchId: branch.id,
        })
      ) {
        applyVersionSnapshot(head.snapshot);
        notify(`已跳转到“${branch.name}”的最新版本`);
      }
    };
    if (hasUncommittedChanges) {
      requestConfirmation({
        title: `跳转到“${branch.name}”？`,
        description: "当前未提交修改会被目标分支最新版本替换。",
        confirmLabel: "跳转到当前分支",
        onConfirm: jumpNow,
      });
    } else void jumpNow();
  };

  const deleteCommit = (commit: ResumeCommit) => {
    requestConfirmation({
      title: `删除版本“${commit.message}”？`,
      description:
        "该版本会从历史与分支图中同时移除，后续版本会自动接回它的上一个版本。此操作无法撤销。",
      confirmLabel: "删除当前版本",
      onConfirm: async () => {
        const next = removeCommitPreservingGraph(versionStore, commit.id);
        if (await persistVersionStore(next)) {
          const branch = next.branches.find(
            (item) => item.id === next.currentBranchId,
          );
          const head = next.commits.find(
            (item) => item.id === branch?.headCommitId,
          );
          if (head && currentHead?.id === commit.id)
            applyVersionSnapshot(head.snapshot);
          notify("版本已从历史与分支图中删除");
        }
      },
    });
  };

  const deleteBranch = (branch: ResumeBranch) => {
    if (branch.id === "main") return;
    requestConfirmation({
      title: `删除分支“${branch.name}”？`,
      description:
        "该分支入口会被删除；其他分支依赖的祖先提交会保留并标记为已删除来源，其余不可达提交会移除。此操作无法撤销。",
      confirmLabel: "删除分支",
      onConfirm: async () => {
        const next = removeBranchPreservingAncestors(versionStore, branch.id);
        const main = next.branches.find((item) => item.id === "main");
        const mainHead = next.commits.find(
          (commit) => commit.id === main?.headCommitId,
        );
        if (await persistVersionStore(next)) {
          if (versionStore.currentBranchId === branch.id && mainHead)
            applyVersionSnapshot(mainHead.snapshot);
          notify("分支已删除");
        }
      },
    });
  };

  return {
    storageStatus,
    storageBusy: !ready || saving,
    versionStore,
    hasUncommittedChanges,
    commitVersion,
    createBranch,
    replaceVersionStore,
    switchBranch,
    restoreCommit,
    jumpToCommit,
    jumpToBranch,
    deleteCommit,
    deleteBranch,
  };
}
