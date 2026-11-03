import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import type {
  ResumeBranch,
  ResumeCommit,
  ResumeVersionStore,
} from "../domain/version-model";
const LEGACY_TEMPLATE_ID = "legacy-v1";
import { GitBranch, Maximize, Minimize, RotateCcw, Trash2 } from "lucide-react";
import { loadCommitDetail } from "../../platform/versionDetails";
import type { ResumeVersionSnapshot } from "../domain/version-model";
import {
  branchTreeNodeWidth,
  branchTreeRailWidth,
  branchTreeRowHeightPx,
  branchTreeTemplateColor,
  getBranchTreeCanvasSize,
  getBranchTreeLayout,
} from "./branch-tree-magazine-layout";

const minZoom = 0.75;
const maxZoom = 2.5;
const zoomStep = 0.1;

// 内置模板的展示名；新增内置模板时在这里补一行，未登记的模板回退为"兼容格式"。
const builtinTemplateLabels: Record<string, string> = {
  [LEGACY_TEMPLATE_ID]: "原版格式",
  "clear-single-v1": "清晰单栏",
  "compact-single-v1": "紧凑单栏",
};

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
};

const shortId = (id: string) => id.replace(/^commit-/, "").slice(0, 7);

const formatStamp = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const BranchTree = memo(function BranchTree({
  store,
  importedTemplateNames,
  dirty,
  onLoad,
  onDelete,
  onDeleteBranch,
  disabled,
}: {
  store: ResumeVersionStore;
  importedTemplateNames: Readonly<Record<string, string>>;
  dirty: boolean;
  onLoad: (commit: ResumeCommit) => void;
  onDelete: (commit: ResumeCommit) => void;
  onDeleteBranch: (branch: ResumeBranch) => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ id: string; snapshot: ResumeVersionSnapshot } | null>(null);
  const [detailError, setDetailError] = useState("");
  useEffect(() => {
    let active = true;
    setDetail(null);
    setDetailError("");
    const commit = store.commits.find((item) => item.id === selected);
    if (commit && !commit.snapshot) {
      void loadCommitDetail(commit.id, commit).then((snapshot) => {
        if (active) setDetail({ id: commit.id, snapshot });
      }).catch((error) => {
        if (active) setDetailError(error instanceof Error ? error.message : "版本详情读取失败");
      });
    }
    return () => { active = false; };
  }, [selected, store.commits]);
  const [zoom, setZoom] = useState(1);
  // 分支图全屏：只铺到红条与顶栏包围的内容区，不盖竖条与顶栏。
  const [branchExpanded, setBranchExpanded] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  // 节点浮层用屏幕坐标锚定：fixed 定位不受画布缩放与滚动影响，也不会压出面板。
  const [popoverAnchor, setPopoverAnchor] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const zoomRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<PanState | null>(null);
  const layout = useMemo(() => getBranchTreeLayout(store), [store]);
  const groups = layout.groups;
  const forks = layout.forks;
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const canvas = useMemo(
    () =>
      getBranchTreeCanvasSize({
        groups,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      }),
    [groups, viewport.height, viewport.width],
  );
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const update = () =>
      setViewport((current) => {
        const width = Math.round(container.clientWidth);
        const height = Math.round(container.clientHeight);
        return current.width === width && current.height === height
          ? current
          : { width, height };
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [branchExpanded]);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    if (selected && !store.commits.some((commit) => commit.id === selected))
      setSelected(null);
  }, [selected, store.commits]);
  const clampZoom = (value: number) =>
    Math.min(maxZoom, Math.max(minZoom, Number(value.toFixed(2))));
  const applyZoom = (value: number, anchor?: { x: number; y: number }) => {
    const container = scrollRef.current;
    const previousZoom = zoomRef.current;
    const nextZoom = clampZoom(value);
    if (nextZoom === previousZoom) return;
    const point =
      container && anchor
        ? {
            x: (container.scrollLeft + anchor.x) / previousZoom,
            y: (container.scrollTop + anchor.y) / previousZoom,
          }
        : null;
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
    // 缩放后屏幕坐标失效，先收起浮层。
    setPopoverAnchor(null);
    if (container && point && anchor) {
      requestAnimationFrame(() => {
        container.scrollLeft = Math.max(0, point.x * nextZoom - anchor.x);
        container.scrollTop = Math.max(0, point.y * nextZoom - anchor.y);
      });
    }
  };
  const zoomAtCenter = (delta: number) => {
    const container = scrollRef.current;
    applyZoom(zoomRef.current + delta, {
      x: (container?.clientWidth ?? 0) / 2,
      y: (container?.clientHeight ?? 0) / 2,
    });
  };
  const fitToView = () => {
    const container = scrollRef.current;
    if (!container) {
      applyZoom(1);
      return;
    }
    const availableWidth = Math.max(1, container.clientWidth - 24);
    // 按内容宽度适配（画布本身已铺满可视区，用画布宽度会永远算出 100%）。
    const fitted = Math.min(1, availableWidth / canvas.contentWidth);
    applyZoom(Math.max(minZoom, fitted), {
      x: container.clientWidth / 2,
      y: container.clientHeight / 2,
    });
  };
  const applyZoomRef = useRef(applyZoom);
  applyZoomRef.current = applyZoom;
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const direction = event.deltaY > 0 ? -1 : 1;
      applyZoomRef.current(zoomRef.current + direction * zoomStep, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => container.removeEventListener("wheel", handleWheel);
  }, []);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=" || event.key === "]") {
      event.preventDefault();
      zoomAtCenter(zoomStep);
    } else if (event.key === "-" || event.key === "_" || event.key === "[") {
      event.preventDefault();
      zoomAtCenter(-zoomStep);
    } else if (event.key === "0") {
      event.preventDefault();
      fitToView();
    }
  };
  const beginPan = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== "mouse" ||
      !event.isPrimary ||
      ![0, 1, 2].includes(event.button)
    )
      return;
    const container = event.currentTarget;
    const target = event.target instanceof Element ? event.target : null;
    const clickedNode = Boolean(target?.closest(".branch-tree-node"));
    const rect = container.getBoundingClientRect();
    const nearScrollbar =
      event.clientX >= rect.right - 16 || event.clientY >= rect.bottom - 16;
    // preventScroll：默认 focus 会把画布滚进视野，外层工作区跟着跳动；
    // 分支图只需要键盘焦点，不需要滚动定位。
    container.focus({ preventScroll: true });
    if (event.button === 0 && (clickedNode || nearScrollbar)) return;
    event.preventDefault();
    container.setPointerCapture(event.pointerId);
    setPopoverAnchor(null);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
    };
    setIsPanning(true);
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.currentTarget.scrollLeft =
      pan.scrollLeft - (event.clientX - pan.startX);
    event.currentTarget.scrollTop =
      pan.scrollTop - (event.clientY - pan.startY);
  };
  const finishPan = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    panRef.current = null;
    setIsPanning(false);
  };
  const byId = useMemo(
    () =>
      new Map(
        groups
          .flatMap((group) => group.rows)
          .flatMap((row) => row.commits.map((item) => item.commit))
          .map((commit) => [commit.id, commit]),
      ),
    [groups],
  );
  const nodeById = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const group of groups)
      for (const row of group.rows)
        for (const node of row.commits)
          map.set(node.commit.id, { x: node.x, y: row.lineY });
    return map;
  }, [groups]);
  const selection = selected ? byId.get(selected) : undefined;
  const selectionBranch = selection
    ? store.branches.find((branch) => branch.id === selection.branchId)
    : undefined;
  // 节点详情贴着节点弹出：坐标算到滚动容器内容层（position: absolute），
  // 自动跟随缩放和滚动，不再出现"弹窗跑到天边"的错位。
  const popoverWidth = 232;
  const openNode = (
    event: React.MouseEvent<HTMLButtonElement>,
    commitId: string,
  ) => {
    const nodeRect = event.currentTarget.getBoundingClientRect();
    const scroll = scrollRef.current;
    const scrollRect = scroll?.getBoundingClientRect();
    if (!scroll || !scrollRect) {
      setPopoverAnchor({ left: nodeRect.right + 10, top: nodeRect.top });
      setSelected(commitId);
      return;
    }
    // 换算到滚动容器内容坐标（含 scrollLeft / scrollTop 偏移）。
    const contentLeft =
      nodeRect.right - scrollRect.left + scroll.scrollLeft + 10;
    const contentTop = nodeRect.top - scrollRect.top + scroll.scrollTop;
    // 夹紧到容器可视范围内：右边放不下就翻到节点左侧。
    const maxLeft = scroll.scrollWidth - popoverWidth - 8;
    const left =
      contentLeft + popoverWidth > scroll.scrollWidth
        ? Math.max(
            8,
            nodeRect.left -
              scrollRect.left +
              scroll.scrollLeft -
              popoverWidth -
              10,
          )
        : Math.min(contentLeft, maxLeft);
    const top = Math.max(4, contentTop);
    setPopoverAnchor({ left, top });
    setSelected(commitId);
  };
  const currentHeadId = store.branches.find(
    (branch) => branch.id === store.currentBranchId,
  )?.headCommitId;
  const templateName = (commit: ResumeCommit) => {
    const snapshot = commit.snapshot ?? (detail?.id === commit.id ? detail.snapshot : null);
    if (!snapshot) return "模板待载入";
    const imported = snapshot.importedTemplate;
    if (imported) return importedTemplateNames[imported.id] ?? imported.name;
    return (
      builtinTemplateLabels[
        snapshot.presentation?.templateId ?? LEGACY_TEMPLATE_ID
      ] ?? "兼容格式"
    );
  };
  return (
    <div
      className={
        "branch-tree-panel" + (branchExpanded ? " branch-tree-expanded" : "")
      }
      data-version-section="tree"
    >
      <div className="history-list-heading">
        <strong>
          <GitBranch size={15} /> 版本历史 · 分支图
        </strong>
        <span>
          {store.commits.length} 次提交 · {store.branches.length} 个分支
        </span>
      </div>
      <p className="version-view-hint">
        点击节点查看详情，拖动背景浏览分支关系。
      </p>
      <div className="branch-tree-toolbar" aria-label="分支可视化缩放">
        <div className="branch-tree-zoom-actions">
          <button
            type="button"
            className="branch-tree-zoom-button"
            aria-label="缩小分支可视化"
            disabled={zoom <= minZoom}
            onClick={() => zoomAtCenter(-zoomStep)}
          >
            −
          </button>
          <output className="branch-tree-zoom-value" aria-live="polite">
            {Math.round(zoom * 100)}%
          </output>
          <button
            type="button"
            className="branch-tree-zoom-button"
            aria-label="放大分支可视化"
            disabled={zoom >= maxZoom}
            onClick={() => zoomAtCenter(zoomStep)}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="branch-tree-fit-button"
          aria-label="适应分支可视化"
          onClick={fitToView}
        >
          适应画布
        </button>
        <button
          type="button"
          className="branch-tree-zoom-button branch-tree-expand-button"
          aria-label={branchExpanded ? "退出分支图全屏" : "分支图全屏"}
          title={branchExpanded ? "退出分支图全屏" : "分支图全屏"}
          onClick={() => setBranchExpanded((current) => !current)}
        >
          {branchExpanded ? <Minimize size={13} /> : <Maximize size={13} />}
        </button>
        <div className="branch-tree-legend" aria-label="图例">
          <span className="branch-legend-item">
            <i className="branch-legend-dot is-head" />
            提交（当前）
          </span>
          <span className="branch-legend-item">
            <i className="branch-legend-dot" />
            提交
          </span>
          <span className="branch-legend-item">
            <i className="branch-legend-ring" />
            分支节点
          </span>
          <span className="branch-legend-item">
            <i className="branch-legend-line" />
            分支连线
          </span>
        </div>
      </div>
      <div
        ref={scrollRef}
        className={`branch-tree-scroll ${isPanning ? "is-panning" : ""}`}
        tabIndex={0}
        aria-label="分支树画布：左键点击节点，拖动背景；右键或中键拖动，Ctrl 加滚轮缩放"
        onKeyDown={handleKeyDown}
        onPointerDown={beginPan}
        onPointerMove={movePan}
        onPointerUp={finishPan}
        onPointerCancel={finishPan}
        onLostPointerCapture={finishPan}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div
          className="branch-tree-zoom-space"
          style={{ width: canvas.width * zoom, height: canvas.height * zoom }}
        >
          <div
            className="branch-tree-canvas"
            style={{
              width: canvas.width,
              height: canvas.height,
              transform: `scale(${zoom})`,
            }}
          >
            <div
              className="branch-tree-plane"
              style={{
                left: canvas.offsetX,
                top: canvas.offsetY,
                width: canvas.contentWidth,
                height: canvas.contentHeight,
              }}
            >
              {groups.map((group) => (
                <div
                  className="branch-lane-group"
                  key={group.key}
                  style={{
                    top: group.y,
                    height: group.height,
                    borderColor: group.color,
                  }}
                  data-version-lane={group.key}
                >
                  <div className="branch-lane-rail">
                    <div className="branch-lane-identity">
                      <span
                        className="branch-lane-number"
                        style={{ color: group.color }}
                      >
                        {group.number}
                      </span>
                      <div className="branch-lane-titles">
                        <strong>{group.label}</strong>
                        <small>{group.latin}</small>
                      </div>
                    </div>
                    {group.rows.map((row) => (
                      <div
                        className="branch-lane-branchname"
                        key={row.branchId}
                        style={{ top: row.lineY - group.y - 22 }}
                        data-current={row.current}
                      >
                        <span
                          className="branch-lane-dot"
                          style={{ background: row.color }}
                        />
                        <span>
                          {row.name}
                          <small>
                            {row.current ? "当前分支" : "分支"} ·{" "}
                            {row.commits.length} 次提交
                          </small>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="branch-lane-rows">
                    {group.rows.map((row, rowIndex) => {
                      // 分叉分支：时间线从父提交那一列开始画，视觉上"接上去"。
                      const forkParent = row.commits[0]?.commit.parentId
                        ? byId.get(row.commits[0].commit.parentId)
                        : undefined;
                      const forkParentX =
                        forkParent && forkParent.branchId !== row.branchId
                          ? nodeById.get(forkParent.id)?.x
                          : undefined;
                      const firstX = Math.min(
                        row.commits[0]?.x ?? branchTreeRailWidth,
                        forkParentX ?? Infinity,
                      );
                      const lastX =
                        row.commits[row.commits.length - 1]?.x ?? firstX;
                      return (
                        <div
                          className="branch-lane-row"
                          key={row.branchId}
                          style={{
                            top: row.y - group.y,
                            height: branchTreeRowHeightPx,
                          }}
                          data-current={row.current}
                          data-odd={rowIndex % 2 === 1}
                        >
                          <span className="branch-lane-band" />
                          <span
                            className="branch-lane-line"
                            style={{
                              left: firstX - 32 - branchTreeRailWidth,
                              width: Math.max(40, lastX - firstX + 64),
                              background: row.color,
                            }}
                          />
                          {row.commits.map(({ commit, x }) => (
                            <div
                              className="branch-lane-slot"
                              key={commit.id}
                              style={{
                                left:
                                  x -
                                  branchTreeNodeWidth / 2 -
                                  branchTreeRailWidth,
                              }}
                            >
                              <span className="branch-lane-stamp">
                                {formatStamp(commit.createdAt)}
                              </span>
                              <button
                                className={`branch-tree-node ${selected === commit.id ? "selected" : ""}`}
                                style={{ borderLeftColor: row.color }}
                                onClick={(event) => openNode(event, commit.id)}
                                aria-pressed={selected === commit.id}
                                title={commit.message}
                                data-version-commit-id={commit.id}
                              >
                                <span>{commit.message}</span>
                                <small>
                                  {shortId(commit.id)}
                                  <b aria-hidden="true">·</b>
                                  <i
                                    className="branch-tree-node-branch"
                                    style={{ color: row.color }}
                                  >
                                    {row.name}
                                    {store.branches.some(
                                      (branch) =>
                                        branch.headCommitId === commit.id,
                                    )
                                      ? " · 最新"
                                      : ""}
                                  </i>
                                </small>
                                {templateName(commit) === group.label ? null : (
                                  <em
                                    className="version-template-badge"
                                    style={
                                      {
                                        "--badge-color":
                                          branchTreeTemplateColor(
                                            commit.snapshot?.importedTemplate
                                              ?.id ??
                                              commit.snapshot?.presentation
                                                ?.templateId ??
                                              (commit.snapshot ? LEGACY_TEMPLATE_ID : "__unloaded__"),
                                          ),
                                      } as React.CSSProperties
                                    }
                                  >
                                    {templateName(commit)}
                                  </em>
                                )}
                              </button>
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {/* 分叉连线：走两行之间的通道，压在卡片之下、行底色之上 */}
              {forks.length ? (
                <svg
                  className="branch-fork-layer"
                  width={canvas.contentWidth}
                  height={canvas.contentHeight}
                  aria-hidden="true"
                >
                  {forks.map((fork, index) => (
                    <g key={`fork-${index}`}>
                      <path
                        className="branch-fork-path"
                        d={fork.path}
                        stroke={fork.color}
                      />
                      <circle
                        className="branch-fork-joint"
                        cx={fork.parentX}
                        cy={fork.parentY}
                        r={4}
                        fill={fork.color}
                      />
                      <text
                        className="branch-fork-label"
                        x={fork.labelX}
                        y={fork.labelY}
                        textAnchor="middle"
                      >
                        ↳ {fork.label}
                      </text>
                    </g>
                  ))}
                </svg>
              ) : null}
              {[...byId.values()].map((commit) => {
                const point = nodeById.get(commit.id);
                if (!point) return null;
                const isHead = store.branches.some(
                  (branch) => branch.headCommitId === commit.id,
                );
                const branch = store.branches.find(
                  (item) => item.id === commit.branchId,
                );
                return (
                  <span
                    key={`dot-${commit.id}`}
                    className={`branch-lane-node-dot ${isHead ? "is-head" : ""}`}
                    style={{
                      left: point.x - 6,
                      top: point.y - 6,
                      borderColor:
                        branch?.id === store.currentBranchId
                          ? "#b4472a"
                          : "var(--version-surface)",
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>
        {selection && popoverAnchor && (
          <div
            className="branch-node-popover"
            onPointerDown={(event) => event.stopPropagation()}
            style={{
              left: popoverAnchor.left,
              top: popoverAnchor.top,
              width: popoverWidth,
            }}
          >
            {detailError && <p role="alert">{detailError}</p>}
            <div className="branch-node-popover-head">
              <strong>{selection.message}</strong>
              <button
                type="button"
                className="branch-node-popover-close"
                aria-label="关闭版本详情"
                onClick={() => {
                  setSelected(null);
                  setPopoverAnchor(null);
                }}
              >
                ×
              </button>
            </div>
            <p>
              {templateName(selection)} ·{" "}
              {selectionBranch?.name ?? "已删除来源"}
              <br />
              {new Date(selection.createdAt).toLocaleString("zh-CN")}
            </p>
            <div className="branch-node-actions">
              <button
                className="restore-button"
                disabled={disabled || (selection.id === currentHeadId && !dirty)}
                title={
                  selection.id === currentHeadId && !dirty
                    ? "载入此版本（当前分支最新）"
                    : "载入此版本"
                }
                onClick={() => onLoad(selection)}
              >
                <RotateCcw size={14} /> 载入
              </button>
              <button
                className="restore-button danger"
                disabled={disabled}
                onClick={() => onDelete(selection)}
              >
                <Trash2 size={14} /> 删除
              </button>
              {(() => {
                const branch = store.branches.find(
                  (b) => b.headCommitId === selection.id,
                );
                if (!branch || branch.id === "main" || branch.id.startsWith("main:")) return null;
                return (
                  <button
                    className="restore-button danger"
                    disabled={disabled}
                    onClick={() => onDeleteBranch(branch)}
                  >
                    <Trash2 size={14} /> 删除分支
                  </button>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
