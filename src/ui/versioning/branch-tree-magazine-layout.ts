const LEGACY_TEMPLATE_ID = "legacy-v1";
import type { ResumeVersionStore } from "../domain/version-model";

// 分支图改成横向泳道（swimlane）：模板 = 泳道组，分支 = 组内一行，
// 提交在同一行内从左到右按时间推进。与"每分支一列"的旧画法相比，
// 它更符合"版本像校样一样翻过去"的阅读习惯，也不再把长历史压成窄列。
export const branchTreeColors = [
  "#b4472a",
  "#5b5b5b",
  "#a57b39",
  "#8a6a52",
  "#6f7b6c",
  "#4a4038",
];

// 左侧装订栏：编号、模板名、缩略图都挂在这一栏里。
export const branchTreeRailWidth = 208;
export const branchTreeNodeWidth = 196;
export const branchTreeNodeStep = 232;
export const branchTreeRowHeightPx = 140;
const branchTreeRowHeight = 140;
const branchTreeGroupGap = 16;
const branchTreeGroupHeader = 52;
const branchTreeFirstNodeX = branchTreeRailWidth + 56;
const branchTreePadding = 40;

export type BranchTreeCommit = ResumeVersionStore["commits"][number];

export type BranchTreeRow = {
  branchId: string;
  name: string;
  color: string;
  current: boolean;
  y: number;
  lineY: number;
  commits: Array<{ commit: BranchTreeCommit; x: number }>;
};

export type BranchTreeGroup = {
  key: string;
  label: string;
  latin: string;
  color: string;
  number: string;
  y: number;
  height: number;
  rows: BranchTreeRow[];
};

/** 分叉连线：从父提交的圆点，经肘形通道，连到子分支的首个提交。 */
export type BranchTreeFork = {
  parentX: number;
  parentY: number;
  childX: number;
  childY: number;
  /** 肘形横向段所在的 y（两行之间的通道）。 */
  midY: number;
  color: string;
  label: string;
  /** 连线路径（含圆角肘）。 */
  path: string;
  /** 标签锚点：横向段中点，落在两行之间的通道里。 */
  labelX: number;
  labelY: number;
};

const builtinTemplateLabels: Record<string, { label: string; latin: string }> =
  {
    [LEGACY_TEMPLATE_ID]: { label: "原版格式", latin: "CLASSIC" },
    "clear-single-v1": { label: "清晰单栏", latin: "CLEAR" },
    "compact-single-v1": { label: "紧凑单栏", latin: "COMPACT" },
  };

export function branchTreeTemplateMeta(
  templateKey: string,
  importedName?: string,
) {
  if (templateKey === "__unloaded__") return { label: "模板待载入", latin: "UNAVAILABLE" };
  const builtin = builtinTemplateLabels[templateKey];
  if (builtin) return builtin;
  return { label: importedName ?? "导入版式", latin: "IMPORTED" };
}

const templateKeyOf = (commit: BranchTreeCommit) =>
  !commit.snapshot ? "__unloaded__" :
  commit.snapshot.importedTemplate?.id ??
  commit.snapshot.presentation?.templateId ??
  LEGACY_TEMPLATE_ID;

// 模板 → 颜色：同一模板在导图里始终同一色，内置模板用固定色，
// 导入模板按 id 散列到调色板，保证跨分支可比。
const builtinTemplateColors: Record<string, string> = {
  [LEGACY_TEMPLATE_ID]: "#b4472a",
  "clear-single-v1": "#3f6d5a",
  "compact-single-v1": "#a57b39",
};

export function branchTreeTemplateColor(templateKey: string) {
  const builtin = builtinTemplateColors[templateKey];
  if (builtin) return builtin;
  let hash = 0;
  for (let index = 0; index < templateKey.length; index += 1)
    hash = (hash * 31 + templateKey.charCodeAt(index)) % 9973;
  return branchTreeColors[hash % branchTreeColors.length];
}

export function getBranchTreeLayout(store: ResumeVersionStore): {
  groups: BranchTreeGroup[];
  forks: BranchTreeFork[];
} {
  const branchById = new Map(
    store.branches.map((branch) => [branch.id, branch]),
  );
  const commitById = new Map(store.commits.map((c) => [c.id, c]));

  // 分支按"首提交时间"排队，泳道顺序天然稳定；已删除分支的提交单独成行。
  const commitsByBranch = new Map<string, BranchTreeCommit[]>(
    store.branches.map((branch) => [branch.id, []]),
  );
  for (const commit of store.commits) {
    const list = commitsByBranch.get(commit.branchId) ?? [];
    list.push(commit);
    commitsByBranch.set(commit.branchId, list);
  }
  for (const list of commitsByBranch.values())
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const rows = [...commitsByBranch.entries()].map(([branchId, commits]) => {
    const branch = branchById.get(branchId);
    const head = commits[0];
    return {
      branchId,
      name: branch?.name ?? `已删除分支 · ${branchId}`,
      current: branchId === store.currentBranchId,
      firstAt: head?.createdAt ?? branch?.createdAt ?? "",
      templateKey: head ? templateKeyOf(head) : "__unloaded__",
      importedName: head?.snapshot?.importedTemplate?.name,
      commits,
    };
  });

  // ---- 横向坐标：DAG 深度列（Mermaid 式）----
  // 每个提交落在"离根提交几步"的列上：子分支的首提交必然在父提交右侧一列，
  // 平行分支的同深度提交共享同一列，图宽由最长链决定，不会被时间间隔拉长。
  const commitById2 = commitById;
  const depthCache = new Map<string, number>();
  const depthOf = (commit: BranchTreeCommit): number => {
    const path: BranchTreeCommit[] = [];
    const seen = new Set<string>();
    let current: BranchTreeCommit | undefined = commit;
    while (current && !depthCache.has(current.id) && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current);
      current = current.parentId ? commitById2.get(current.parentId) : undefined;
    }
    let depth = current && depthCache.has(current.id) ? depthCache.get(current.id)! : -1;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depthCache.set(path[index].id, ++depth);
    }
    return depthCache.get(commit.id) ?? 0;
  };
  const xByCommit = new Map<string, number>();
  for (const commit of store.commits)
    xByCommit.set(
      commit.id,
      branchTreeFirstNodeX + depthOf(commit) * branchTreeNodeStep,
    );

  // ---- 分组（按模板）----
  const groupKeys: string[] = [];
  for (const row of rows)
    if (!groupKeys.includes(row.templateKey)) groupKeys.push(row.templateKey);
  const groupFirstAt = new Map<string, string>();
  for (const row of rows) {
    const seen = groupFirstAt.get(row.templateKey);
    if (!seen || row.firstAt < seen)
      groupFirstAt.set(row.templateKey, row.firstAt);
  }
  groupKeys.sort((a, b) =>
    (groupFirstAt.get(a) ?? "").localeCompare(groupFirstAt.get(b) ?? ""),
  );

  const forks: BranchTreeFork[] = [];
  let cursorY = 0;
  const groups = groupKeys.map((key, groupIndex) => {
    const groupRows = rows
      .filter((row) => row.templateKey === key)
      .sort((a, b) => a.firstAt.localeCompare(b.firstAt));
    const color = branchTreeTemplateColor(key);
    const meta = branchTreeTemplateMeta(
      key,
      groupRows.find((row) => row.importedName)?.importedName,
    );
    const headerY = cursorY;
    let rowY = cursorY + branchTreeGroupHeader;
    const builtRows: BranchTreeRow[] = groupRows.map((row, rowIndex) => {
      const current = rowY;
      rowY += branchTreeRowHeight;
      return {
        branchId: row.branchId,
        name: row.name,
        color:
          branchTreeColors[
            (groupIndex * 2 + rowIndex) % branchTreeColors.length
          ],
        current: row.current,
        y: current,
        lineY: current + 42,
        // 分叉出来的分支：时间线从父提交的列开始画，视觉上"接上去"。
        commits: row.commits.map((commit) => ({
          commit,
          x: xByCommit.get(commit.id) ?? branchTreeFirstNodeX,
        })),
      };
    });
    const height = rowY - headerY;
    cursorY = rowY + branchTreeGroupGap;
    return {
      key,
      label: meta.label,
      latin: meta.latin,
      color,
      number: String(groupIndex + 1).padStart(2, "0"),
      y: headerY,
      height,
      rows: builtRows,
    };
  });

  // ---- 分叉连线：肘形，走在两行之间的通道里，绝不穿过卡片 ----
  const rowById = new Map<string, BranchTreeRow>();
  for (const group of groups)
    for (const row of group.rows) rowById.set(row.branchId, row);

  for (const row of rows) {
    const first = row.commits[0];
    if (!first?.parentId) continue;
    const parent = commitById.get(first.parentId);
    if (!parent || parent.branchId === row.branchId) continue;
    const parentRow = rowById.get(parent.branchId);
    const childRow = rowById.get(row.branchId);
    if (!parentRow || !childRow) continue;
    const parentX = xByCommit.get(parent.id) ?? branchTreeFirstNodeX;
    const childX = xByCommit.get(first.id) ?? branchTreeFirstNodeX;
    const parentY = parentRow.lineY;
    const childY = childRow.lineY;
    // 通道 y：落在父卡片下缘与子卡片上缘之间（卡片高 76，行高 140）。
    // 不能取两行中点——那会落进父卡片的下缘，标签被卡片盖住。
    const parentCardBottom = parentY + 86;
    const childCardTop = childY + 10;
    const midY = Math.round((parentCardBottom + childCardTop) / 2);
    // 肘形从父卡片右缘外 18px 出发，避开 196px 宽的卡片（半宽 98）。
    // 肘形从父卡片右缘外 18px 出发，避开 196px 宽的卡片（半宽 98）。
    const elbowX = parentX + branchTreeNodeWidth / 2 + 18;
    const radius = 12;
    const dir = childX >= elbowX ? 1 : -1;
    const vDir = childY > parentY ? 1 : -1;
    // 四段直线 + 四角圆角：横线走在两行之间的通道，绝不穿过卡片。
    const path = [
      `M ${parentX} ${parentY}`,
      `L ${elbowX - radius} ${parentY}`,
      `Q ${elbowX} ${parentY} ${elbowX} ${parentY + vDir * radius}`,
      `L ${elbowX} ${midY - vDir * radius}`,
      `Q ${elbowX} ${midY} ${elbowX + dir * radius} ${midY}`,
      `L ${childX - dir * radius} ${midY}`,
      `Q ${childX} ${midY} ${childX} ${midY + vDir * radius}`,
      `L ${childX} ${childY}`,
    ].join(" ");
    forks.push({
      parentX,
      parentY,
      childX,
      childY,
      midY,
      color: childRow.color,
      label: `从「${parent.message}」分出`,
      path,
      labelX: Math.round((elbowX + childX) / 2),
      labelY: midY - 7,
    });
  }

  return { groups, forks };
}

export function getBranchTreeCanvasSize({
  groups,
  viewportWidth,
  viewportHeight,
}: {
  groups: BranchTreeGroup[];
  viewportWidth: number;
  viewportHeight: number;
}) {
  const lastCommitX = Math.max(
    0,
    ...groups.flatMap((group) =>
      group.rows.flatMap((row) =>
        row.commits.length
          ? [row.commits[row.commits.length - 1].x + branchTreeNodeWidth / 2]
          : [],
      ),
    ),
  );
  const contentWidth = Math.max(
    branchTreeRailWidth + 360,
    lastCommitX + 96,
    Math.min(viewportWidth, 1600),
  );
  const contentHeight = Math.max(
    220,
    ...groups.map((group) => group.y + group.height),
  );
  const width = Math.max(contentWidth, viewportWidth) + branchTreePadding * 2;
  const height =
    Math.max(contentHeight, viewportHeight) + branchTreePadding * 2;
  return {
    width,
    height,
    contentWidth,
    contentHeight,
    offsetX: Math.round((width - contentWidth) / 2),
    // 固定从顶部开始排：分支图高度随时在变，垂直居中会让每次新增提交都整体位移。
    offsetY: branchTreePadding,
  };
}
