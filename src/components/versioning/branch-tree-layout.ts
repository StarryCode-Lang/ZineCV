import type { ResumeVersionStore } from "../../domain/version-model";

export const branchTreeColors = [
  "#c74e2d",
  "#594c40",
  "#a57b39",
  "#976652",
  "#817b6c",
  "#4a4038",
];
export const branchTreeLaneWidth = 200;
const branchTreeRowHeight = 92;
const branchTreeTop = 56;

type BranchTreeRow = {
  commit: ResumeVersionStore["commits"][number];
  x: number;
  y: number;
};

type BranchTreeLane = {
  id: string;
  name: string;
  active: boolean;
};

// 被删除分支的祖先提交进入独立来源 lane，不能被误画到 main 分支。
export function getBranchTreeLanes(
  store: ResumeVersionStore,
): BranchTreeLane[] {
  const active = store.branches.map((branch) => ({
    id: branch.id,
    name: branch.name,
    active: true,
  }));
  const activeIds = new Set(active.map((lane) => lane.id));
  const deleted = Array.from(
    new Set(
      store.commits
        .map((commit) => commit.branchId)
        .filter((branchId) => !activeIds.has(branchId)),
    ),
  ).map((branchId) => ({
    id: branchId,
    name: `已删除分支 · ${branchId}`,
    active: false,
  }));
  return [...active, ...deleted];
}

// 版本按提交时间纵向排列，分支顺序只决定固定的横向 lane。
export function getBranchTreeRows(store: ResumeVersionStore): BranchTreeRow[] {
  const lanes = getBranchTreeLanes(store);
  const branchIndexes = new Map(lanes.map((lane, index) => [lane.id, index]));
  return store.commits
    .map((commit, sourceIndex) => ({ commit, sourceIndex }))
    .sort(
      (a, b) =>
        a.commit.createdAt.localeCompare(b.commit.createdAt) ||
        a.sourceIndex - b.sourceIndex,
    )
    .map(({ commit }, index) => ({
      commit,
      x:
        (branchIndexes.get(commit.branchId) ?? 0) * branchTreeLaneWidth +
        branchTreeLaneWidth / 2,
      y: branchTreeTop + index * branchTreeRowHeight,
    }));
}

export function getBranchTreeCanvasWidth(branchCount: number) {
  return Math.max(1, branchCount) * branchTreeLaneWidth;
}

export function getBranchTreeCanvasHeight(rowCount: number) {
  return Math.max(170, rowCount * branchTreeRowHeight + branchTreeTop);
}
