import {
  VERSION_STORAGE_KEY,
  createEmptyVersionStore,
  type ResumeVersionStore,
} from "../domain/version-model";
import { validateVersionStore } from "../../server/version-schema.mjs";
import { readStoredString, writeStoredString } from "../utils/resume";

const SYNC_KEY = "resume-diy-version-project-revision";
type ProjectVersions = {
  store: ResumeVersionStore | null;
  revision: string;
};

type VersionReadResult = {
  store: ResumeVersionStore;
  source: "primary" | "backup" | "empty";
  hasInvalidData: boolean;
  message: string | null;
};

const validationMessage = (errors: string[]) =>
  errors.length ? errors.slice(0, 3).join("；") : "未知结构错误";

// 浏览器缓存属于存储层；domain 只保留版本数据结构和无副作用的默认值。
export function readVersionStoreResult(): VersionReadResult {
  let hasInvalidData = false;
  let primaryMessage: string | null = null;
  for (const [key, source] of [
    [VERSION_STORAGE_KEY, "primary"],
    [`${VERSION_STORAGE_KEY}-backup`, "backup"],
  ] as const) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed: unknown = JSON.parse(raw);
      const validation = validateVersionStore(parsed, { mode: "read" });
      if (!validation.valid) {
        hasInvalidData = true;
        primaryMessage = `浏览器版本库${source === "primary" ? "主缓存" : "备份"}结构无效：${validationMessage(validation.errors)}`;
        continue;
      }
      const diagnostic = validation.diagnostics.length
        ? `；兼容性诊断：${validation.diagnostics.slice(0, 2).join("；")}`
        : "";
      const message =
        source === "backup"
          ? `浏览器版本库主缓存不可用，已使用备份${diagnostic}`
          : diagnostic
            ? `浏览器版本库${diagnostic}`
            : null;
      return {
        store: parsed as ResumeVersionStore,
        source,
        hasInvalidData,
        message,
      };
    } catch {
      hasInvalidData = true;
      primaryMessage = `浏览器版本库${source === "primary" ? "主缓存" : "备份"}无法读取，原文件未改动`;
    }
  }
  return {
    store: createEmptyVersionStore(),
    source: "empty",
    hasInvalidData,
    message: hasInvalidData
      ? `${primaryMessage ?? "浏览器版本库读取失败"}；原文件未改动，请检查备份`
      : null,
  };
}

export async function loadProjectVersions(): Promise<ProjectVersions | null> {
  const response = await fetch("/api/resume-versions", { cache: "no-store" });
  // 普通静态托管没有文件服务，仍保留浏览器版本库。
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("项目版本文件读取失败，未覆盖原有历史");
  if (!response.headers.get("content-type")?.includes("application/json"))
    return null;
  const project = (await response.json()) as ProjectVersions;
  if (
    !project ||
    typeof project.revision !== "string" ||
    (project.store !== null &&
      !validateVersionStore(project.store, { mode: "read" }).valid)
  )
    throw new Error("项目版本文件结构无效，未覆盖原有历史");
  return project;
}

export async function saveProjectVersions(
  store: ResumeVersionStore,
  revision: string,
) {
  const validation = validateVersionStore(store, { mode: "write" });
  if (!validation.valid)
    throw new Error(`版本库结构无效：${validationMessage(validation.errors)}`);
  const response = await fetch("/api/resume-versions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ store, revision }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "项目版本文件保存失败");
  writeStoredString(SYNC_KEY, result.revision);
  return result.revision as string;
}

export function cacheVersions(store: ResumeVersionStore) {
  if (!validateVersionStore(store, { mode: "write" }).valid) return false;
  const previous = readStoredString(VERSION_STORAGE_KEY, "");
  if (previous) {
    try {
      const parsed = JSON.parse(previous);
      if (validateVersionStore(parsed, { mode: "read" }).valid)
        writeStoredString(`${VERSION_STORAGE_KEY}-backup`, previous);
    } catch {
      /* 不用损坏的主缓存覆盖有效备份。 */
    }
  }
  return writeStoredString(VERSION_STORAGE_KEY, JSON.stringify(store));
}

// 从仍存活的分支 HEAD 沿 parentId 回溯；删除分支时只删除不可达提交。
function getReachableCommitIds(store: ResumeVersionStore) {
  const commitsById = new Map(
    store.commits.map((commit) => [commit.id, commit]),
  );
  const reachable = new Set<string>();
  const pending = store.branches
    .map((branch) => branch.headCommitId)
    .filter((id): id is string => Boolean(id));
  while (pending.length) {
    const id = pending.pop();
    if (!id || reachable.has(id)) continue;
    const commit = commitsById.get(id);
    if (!commit) continue;
    reachable.add(id);
    if (commit.parentId) pending.push(commit.parentId);
  }
  return reachable;
}

export function removeBranchPreservingAncestors(
  store: ResumeVersionStore,
  branchId: string,
) {
  const branches = store.branches.filter((branch) => branch.id !== branchId);
  const nextStore = {
    ...store,
    currentBranchId:
      store.currentBranchId === branchId ? "main" : store.currentBranchId,
    branches,
  };
  const reachable = getReachableCommitIds(nextStore);
  return {
    ...nextStore,
    commits: store.commits.filter((commit) => reachable.has(commit.id)),
  };
}

// 删除单个提交时把它的子提交接到其父提交，并同步所有分支 HEAD。
// 这样历史列表和分支图始终由同一份、无悬空引用的数据驱动。
export function removeCommitPreservingGraph(
  store: ResumeVersionStore,
  commitId: string,
) {
  const target = store.commits.find((commit) => commit.id === commitId);
  if (!target) return store;
  return {
    ...store,
    branches: store.branches.map((branch) =>
      branch.headCommitId === commitId
        ? { ...branch, headCommitId: target.parentId }
        : branch,
    ),
    commits: store.commits
      .filter((commit) => commit.id !== commitId)
      .map((commit) =>
        commit.parentId === commitId
          ? { ...commit, parentId: target.parentId }
          : commit,
      ),
  };
}

// 首次接入文件存储时合并旧浏览器的提交，已有同步标记时以项目文件为准，避免复活已删除分支。
export function reconcileVersions(
  local: ResumeVersionStore,
  project: ResumeVersionStore,
) {
  if (readStoredString(SYNC_KEY, "")) return project;
  const commits = new Map(project.commits.map((commit) => [commit.id, commit]));
  local.commits.forEach((commit) => {
    if (!commits.has(commit.id)) commits.set(commit.id, commit);
  });
  const branches = new Map(
    project.branches.map((branch) => [branch.id, branch]),
  );
  local.branches.forEach((branch) => {
    const existing = branches.get(branch.id);
    const localTime = commits.get(branch.headCommitId ?? "")?.createdAt ?? "";
    const projectTime =
      commits.get(existing?.headCommitId ?? "")?.createdAt ?? "";
    if (!existing || localTime > projectTime) branches.set(branch.id, branch);
  });
  return {
    ...project,
    branches: [...branches.values()],
    commits: [...commits.values()],
  };
}
