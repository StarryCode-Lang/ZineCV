import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";
import type {
  ResumeCommit,
  ResumeVersionStore,
} from "../../domain/version-model";
import { GitBranch, LocateFixed, RotateCcw, Trash2 } from "lucide-react";
import {
  branchTreeColors as colors,
  branchTreeLaneWidth as laneWidth,
  getBranchTreeCanvasHeight,
  getBranchTreeCanvasWidth,
  getBranchTreeLanes,
  getBranchTreeRows,
} from "./branch-tree-layout";
// Keep the smallest readable node type above browser-default thumbnail size;
// the canvas can still be browsed horizontally when a history has many lanes.
const minZoom = 0.75;
const maxZoom = 2.5;
const zoomStep = 0.1;

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
};

export function BranchTree({
  store,
  importedTemplateNames,
  dirty,
  onRestore,
  onJump,
  onDelete,
  disabled,
}: {
  store: ResumeVersionStore;
  importedTemplateNames: Readonly<Record<string, string>>;
  dirty: boolean;
  onRestore: (commit: ResumeCommit) => void;
  onJump: (commit: ResumeCommit) => void;
  onDelete: (commit: ResumeCommit) => void;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const zoomRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<PanState | null>(null);
  const rows = useMemo(() => getBranchTreeRows(store), [store]);
  const lanes = useMemo(() => getBranchTreeLanes(store), [store]);
  const canvasWidth = getBranchTreeCanvasWidth(lanes.length);
  const canvasHeight = getBranchTreeCanvasHeight(rows.length);
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
    // Fit the horizontal lanes while leaving vertical scrolling available so
    // node labels remain readable on long histories.
    const fitted = Math.min(1, availableWidth / canvasWidth);
    applyZoom(Math.max(minZoom, fitted), {
      x: container.clientWidth / 2,
      y: container.clientHeight / 2,
    });
  };
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const direction = event.deltaY > 0 ? -1 : 1;
    applyZoom(zoomRef.current + direction * zoomStep, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };
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
    container.focus();
    if (event.button === 0 && (clickedNode || nearScrollbar)) return;
    event.preventDefault();
    container.setPointerCapture(event.pointerId);
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
  const byId = new Map(rows.map((row) => [row.commit.id, row]));
  const selection = rows.find((row) => row.commit.id === selected)?.commit;
  const selectionBranch = selection
    ? store.branches.find((branch) => branch.id === selection.branchId)
    : undefined;
  const currentHeadId = store.branches.find(
    (branch) => branch.id === store.currentBranchId,
  )?.headCommitId;
  const templateName = (commit: ResumeCommit) => {
    const imported = commit.snapshot.importedTemplate;
    if (imported) return importedTemplateNames[imported.id] ?? imported.name;
    return (
      {
        "legacy-v1": "原版格式",
        "clear-single-v1": "清晰单栏",
        "compact-single-v1": "紧凑单栏",
      }[commit.snapshot.presentation?.templateId ?? "legacy-v1"] ?? "兼容格式"
    );
  };
  const branchTemplate = (branchId: string) => {
    const headId = store.branches.find(
      (branch) => branch.id === branchId,
    )?.headCommitId;
    const head = store.commits.find((commit) => commit.id === headId);
    return head?.snapshot.importedTemplate ? templateName(head) : null;
  };
  return (
    <div className="branch-tree-panel" data-version-section="tree">
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
        <span className="branch-tree-toolbar-label">画布缩放</span>
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
          <button
            type="button"
            className="branch-tree-fit-button"
            aria-label="适应分支可视化"
            onClick={fitToView}
          >
            适应
          </button>
        </div>
        <span
          className="branch-tree-zoom-hint"
          role="img"
          aria-label="分支图操作提示"
          title="右键或中键拖动；Ctrl 加滚轮，或使用 +/-、[ ] 缩放；按 0 适应宽度"
        >
          操作提示
        </span>
      </div>
      <div
        ref={scrollRef}
        className={`branch-tree-scroll ${isPanning ? "is-panning" : ""}`}
        tabIndex={0}
        aria-label="分支树画布：左键点击节点，拖动背景；右键或中键拖动，Ctrl 加滚轮缩放"
        onWheel={handleWheel}
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
          style={{ width: canvasWidth * zoom, height: canvasHeight * zoom }}
        >
          <div
            className="branch-tree-canvas"
            style={{
              width: canvasWidth,
              height: canvasHeight,
              transform: `scale(${zoom})`,
            }}
          >
            {lanes.map((lane, index) => (
              <div
                className="branch-tree-lane"
                key={lane.id}
                style={{
                  left: index * laneWidth,
                  width: laneWidth,
                  borderColor: colors[index % colors.length],
                }}
              >
                <strong
                  title={
                    lane.active
                      ? `${branchTemplate(lane.id) ?? lane.name} · ${lane.name}`
                      : lane.name
                  }
                >
                  {lane.active
                    ? (branchTemplate(lane.id) ?? lane.name)
                    : lane.name}
                </strong>
                {lane.active && (
                  <small
                    title={branchTemplate(lane.id) ? lane.name : "原版格式"}
                  >
                    {branchTemplate(lane.id) ? lane.name : "原版格式"}
                  </small>
                )}
                {lane.active && lane.id === store.currentBranchId && (
                  <span>当前分支</span>
                )}
                {!lane.active && <span>历史来源</span>}
              </div>
            ))}
            <svg
              className="branch-tree-edges"
              width="100%"
              height="100%"
              aria-hidden="true"
            >
              {rows.map((row) => {
                const parent = byId.get(row.commit.parentId ?? "");
                if (!parent) return null;
                return (
                  <path
                    key={row.commit.id}
                    d={`M ${parent.x} ${parent.y + 28} C ${parent.x} ${parent.y + 65}, ${row.x} ${row.y - 30}, ${row.x} ${row.y}`}
                    stroke={
                      colors[
                        Math.max(
                          0,
                          lanes.findIndex(
                            (lane) => lane.id === row.commit.branchId,
                          ),
                        ) % colors.length
                      ]
                    }
                  />
                );
              })}
            </svg>
            {rows.map(({ commit, x, y }) => (
              <button
                key={commit.id}
                className={`branch-tree-node ${selected === commit.id ? "selected" : ""}`}
                style={{ left: x - 82, top: y, width: 164 }}
                onClick={() => setSelected(commit.id)}
                aria-pressed={selected === commit.id}
                title={commit.message}
                data-version-commit-id={commit.id}
              >
                <span>{commit.message}</span>
                <small>
                  {commit.id.replace(/^commit-/, "").slice(0, 7)}
                  {store.branches.some((b) => b.headCommitId === commit.id)
                    ? " · 分支最新"
                    : ""}
                </small>
                <em className="version-template-badge">
                  {templateName(commit)}
                </em>
              </button>
            ))}
          </div>
        </div>
      </div>
      {selection && (
        <div className="branch-node-detail">
          <div>
            <strong>{selection.message}</strong>
            <p>
              {templateName(selection)} ·{" "}
              {selectionBranch?.name ?? "已删除来源"} ·{" "}
              {new Date(selection.createdAt).toLocaleString("zh-CN")}
            </p>
          </div>
          <div className="branch-node-actions">
            <button
              className="restore-button"
              disabled={disabled || (selection.id === currentHeadId && !dirty)}
              title={
                selection.id === currentHeadId && !dirty
                  ? "当前版本，无需恢复"
                  : "恢复此版本"
              }
              onClick={() => onRestore(selection)}
            >
              <RotateCcw size={14} /> 恢复
            </button>
            <button
              className="restore-button"
              disabled={disabled}
              onClick={() => onJump(selection)}
            >
              <LocateFixed size={14} /> 跳转
            </button>
            <button
              className="restore-button danger"
              disabled={disabled}
              onClick={() => onDelete(selection)}
            >
              <Trash2 size={14} /> 删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
