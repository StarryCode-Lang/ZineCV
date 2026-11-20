import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { animate } from "motion/mini";
import {
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minimize,
  Minus,
  Plus,
} from "lucide-react";
import type {
  ModuleKey,
  PreviewBlock,
  PreviewPageLayout,
  ResumeState,
  SeparatorMode,
} from "../domain/resume-model";
import { A4_HEIGHT_PX, A4_WIDTH_PX } from "../domain/resume-model";
import { PreviewContent } from "./ResumePreview";
import { PreviewInteractionLayer } from "./PreviewInteractionLayer";
import { PreviewOverflowGuard } from "./PreviewOverflowGuard";
import type { EditorNavigationTarget } from "../app/useEditorNavigation";
import type { KnownTemplateId } from "../domain/template-model";
import type { ImportedSourceLayout } from "../domain/imported-layout";
import { ImportedLayoutPaper } from "./ImportedLayoutPaper";
import {
  readNativeWindowFullscreen,
  setNativeWindowFullscreen,
} from "../../platform/useDesktopWindow";

let measuredScrollbarWidth: number | null = null;

// 预览宽度始终预留滚动条槽：不随内容高度是否溢出而改变。
// 否则同一缩放值会因滚动条出现从 100% 漂移到 98%，全屏进出也会横跳 15px。
function getScrollbarWidth() {
  if (measuredScrollbarWidth !== null) return measuredScrollbarWidth;
  const probe = document.createElement("div");
  Object.assign(probe.style, {
    position: "fixed",
    top: "-10000px",
    width: "100px",
    height: "100px",
    overflow: "scroll",
    visibility: "hidden",
    pointerEvents: "none",
  });
  document.body.appendChild(probe);
  measuredScrollbarWidth = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return measuredScrollbarWidth;
}

function hasResumeContent(resume: ResumeState) {
  return (
    Object.entries(resume.basic).some(
      ([key, value]) =>
        key !== "ageMode" &&
        typeof value === "string" &&
        value.trim().length > 0,
    ) ||
    resume.summary.replace(/<[^>]*>|&nbsp;|\s/g, "").length > 0 ||
    (Object.keys(resume) as Array<keyof ResumeState>).some(
      (key) =>
        Array.isArray(resume[key]) && (resume[key] as unknown[]).length > 0,
    )
  );
}

type ResumePreviewPaneProps = {
  templateId: KnownTemplateId;
  templateVariant?: "side-band";
  templateSideBandBackground?: string;
  templateSideBandForeground?: string;
  templateHeadingFontSize: string;
  templateParagraphSpacing: string;
  templateListSpacing: string;
  measurementRef: RefObject<HTMLDivElement | null>;
  pages: PreviewPageLayout[];
  allBlocks: PreviewBlock[];
  resume: ResumeState;
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  dateFormat: "2021年1月" | "2021.01";
  titleFormat: "双行标题" | "单行标题";
  separator: SeparatorMode;
  textAlign: "系统默认" | "两端对齐";
  fontFamily: string;
  fontSize: string;
  measurementLineHeight: number;
  letterSpacing: number;
  pagePadding: number;
  measurementModuleGap: number;
  baseModuleGap: number;
  theme: string;
  initialZoomPercent: number | null;
  onZoomPercentChange: (value: number) => void;
  onNavigateToEditor: (target: EditorNavigationTarget) => void;
  onOverflowChange: Parameters<typeof PreviewOverflowGuard>[0]["onChange"];
  importedLayout?: ImportedSourceLayout | null;
  importedEdits?: Record<string, string>;
};

// 右侧 A4 预览容器：隐藏测量稿负责分页，可见纸张负责屏幕和打印输出。
export const ResumePreviewPane = memo(function ResumePreviewPane({
  templateId,
  templateVariant,
  templateSideBandBackground,
  templateSideBandForeground,
  templateHeadingFontSize,
  templateParagraphSpacing,
  templateListSpacing,
  measurementRef,
  pages,
  allBlocks,
  resume,
  moduleNames,
  summaryTitle,
  dateFormat,
  titleFormat,
  separator,
  textAlign,
  fontFamily,
  fontSize,
  measurementLineHeight,
  letterSpacing,
  pagePadding,
  measurementModuleGap,
  baseModuleGap,
  theme,
  initialZoomPercent,
  onZoomPercentChange,
  onNavigateToEditor,
  onOverflowChange,
  importedLayout,
  importedEdits,
}: ResumePreviewPaneProps) {
  const templateClass = [
    templateId === "legacy-v1" ? "" : `template-${templateId}`,
    templateVariant === "side-band" ? "template-imported-side-band" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const paneRef = useRef<HTMLElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [zoomPercent, setZoomPercent] = useState(initialZoomPercent ?? 100);
  const [zoomInput, setZoomInput] = useState(String(initialZoomPercent ?? 100));
  const zoomInputActiveRef = useRef(false);
  const baseScaleRef = useRef(1);
  const initialZoomApplied = useRef(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pendingFullscreenPaperRects = useRef(
    new Map<HTMLElement, DOMRect>(),
  );
  const fullscreenAnimations = useRef(new Set<{ cancel: () => void }>());
  const nativeFullscreenOwned = useRef(false);
  const showResumeContent = hasResumeContent(resume);
  // 原版式模式：页数由源文件页决定，分页、缩放与页码都按它计算。
  const layoutPageCount = importedLayout?.pages.length ?? 0;
  const visiblePageCount = importedLayout ? layoutPageCount : pages.length;
  const sharedContentProps = {
    resume,
    moduleNames,
    summaryTitle,
    dateFormat,
    titleFormat,
    separator,
    textAlign,
  };

  // 在滚动条临界区间连续吸收槽宽，避免预览宽度突然增减；缩放变量直接写入
  // 预览根节点，让分栏和纸张在同一渲染帧完成自适应，不触发整棵 React 树更新。
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const updateScale = () => {
      const styles = window.getComputedStyle(pane);
      const horizontalPadding =
        Number.parseFloat(styles.paddingLeft) +
        Number.parseFloat(styles.paddingRight);
      // 用 border-box 宽度扣 padding 再固定预留滚动条：外框宽度不随滚动条出现变化，
      // 缩放百分比与全屏 FLIP 的起止宽度因此保持稳定。
      const borderWidth =
        Number.parseFloat(styles.borderLeftWidth) +
        Number.parseFloat(styles.borderRightWidth);
      const paperFitWidth = Math.max(
        1,
        pane.getBoundingClientRect().width -
          borderWidth -
          horizontalPadding -
          getScrollbarWidth(),
      );
      baseScaleRef.current = paperFitWidth / A4_WIDTH_PX;
      if (!initialZoomApplied.current && initialZoomPercent !== null) {
        initialZoomApplied.current = true;
        const initialPercent = Math.min(200, Math.max(20, initialZoomPercent));
        setZoomFactor(initialPercent / 100 / baseScaleRef.current);
        setZoomPercent(initialPercent);
        setZoomInput(String(initialPercent));
        return;
      }
      const widthScale = (paperFitWidth / A4_WIDTH_PX) * zoomFactor;
      const nextScale = Math.min(2, widthScale);
      const pagesRoot = pagesRef.current;
      if (!pagesRoot) return;
      pagesRoot.style.setProperty(
        "--paper-render-width",
        `${A4_WIDTH_PX * nextScale}px`,
      );
      pagesRoot.style.setProperty(
        "--paper-render-height",
        `${A4_HEIGHT_PX * nextScale}px`,
      );
      pagesRoot.style.setProperty("--preview-scale", String(nextScale));
      setZoomPercent(Math.max(1, Math.round(nextScale * 100)));
      pagesRoot
        .querySelectorAll<HTMLElement>(".paper-frame")
        .forEach((frame) => frame.style.removeProperty("transform"));
    };
    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(pane);
    window.addEventListener("resize", updateScale);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateScale);
    };
  }, [visiblePageCount, zoomFactor, isFullscreen, initialZoomPercent]);

  // 原版式页面就是源文件的原样背景，不参与内容分页，也不产生溢出判定。
  useEffect(() => {
    if (importedLayout) onOverflowChange(null);
  }, [importedLayout, onOverflowChange]);

  useEffect(() => {
    if (!zoomInputActiveRef.current) setZoomInput(String(zoomPercent));
  }, [zoomPercent]);

  const releaseNativeWindowFullscreen = () => {
    if (!nativeFullscreenOwned.current) return;
    nativeFullscreenOwned.current = false;
    void setNativeWindowFullscreen(false);
  };

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const updateFullscreen = () => {
      const active = document.fullscreenElement === pane;
      setIsFullscreen(active);
      if (!active) releaseNativeWindowFullscreen();
      const pending = pendingFullscreenPaperRects.current;
      pendingFullscreenPaperRects.current = new Map();
      if (
        !pending.size ||
        matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      // 全屏切换的那一帧先把纸张钉回切换前的位置，避免在动画启动前
      // 闪一下全屏尺寸；随后等窗口全屏/回流稳定，再补上到最终落位的动画。
      const held: Array<{ paper: HTMLElement; previous: DOMRect }> = [];
      pending.forEach((previous, frame) => {
        if (!frame.isConnected) return;
        const paper = frame.firstElementChild as HTMLElement | null;
        if (!paper) return;
        const next = paper.getBoundingClientRect();
        if (!next.width || !next.height) return;
        const layoutWidth = Math.max(1, paper.offsetWidth);
        const previousScale = previous.width / layoutWidth;
        const x = previous.left - next.left;
        const y = previous.top - next.top;
        paper.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${previousScale})`;
        held.push({ paper, previous });
      });
      if (!held.length) return;
      const animations = fullscreenAnimations.current;
      let frame = 0;
      let fallback = 0;
      let settled = false;
      let stableFrames = 0;
      let lastWidth = -1;
      let lastHeight = -1;
      let lastClientWidth = -1;
      const finish = () => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(frame);
        window.clearTimeout(fallback);
        observer.disconnect();
        animations.forEach((animation) => animation.cancel());
        animations.clear();
        held.forEach(({ paper, previous }) => {
          // 窗口全屏可能在上面的等待期间才真正改变布局；去掉临时 transform
          // 重新量当前落位，再按切换前的视觉矩形重新钉住，避免从旧中间态起步。
          paper.style.removeProperty("transform");
          const current = paper.getBoundingClientRect();
          const target = getComputedStyle(paper).transform;
          const layoutWidth = Math.max(1, paper.offsetWidth);
          const previousScale = previous.width / layoutWidth;
          const x = previous.left - current.left;
          const y = previous.top - current.top;
          const from = `translate3d(${x}px, ${y}px, 0) scale(${previousScale})`;
          paper.style.transform = from;
          const animation = animate(
            paper,
            {
              transform: [from, target === "none" ? "scale(1)" : target],
            },
            {
              duration: 0.5,
              ease: [0.4, 0, 0.2, 1],
              onComplete: () => {
                paper.style.removeProperty("transform");
                animations.delete(animation);
              },
            },
          );
          animations.add(animation);
        });
        if (document.fullscreenElement !== pane) return;
        const header = pane.querySelector<HTMLElement>(
          ".preview-workspace-header",
        );
        if (header) {
          const animation = animate(
            header,
            {
              opacity: [0.55, 1],
              transform: ["translateY(-6px)", "translateY(0)"],
            },
            {
              duration: 0.4,
              ease: [0.22, 1, 0.36, 1],
              onComplete: () => {
                header.style.removeProperty("opacity");
                header.style.removeProperty("transform");
                animations.delete(animation);
              },
            },
          );
          animations.add(animation);
        }
      };
      const observer = new ResizeObserver(() => {
        if (settled) return;
        stableFrames = 0;
        // 元素全屏/窗口全屏的布局不是同一帧落定的；每次尺寸变化都重新
        // 把纸张钉回切换前的视觉矩形，否则会先横移到新布局位置再弹回。
        held.forEach(({ paper, previous }) => {
          paper.style.removeProperty("transform");
          const current = paper.getBoundingClientRect();
          const layoutWidth = Math.max(1, paper.offsetWidth);
          const previousScale = previous.width / layoutWidth;
          const x = previous.left - current.left;
          const y = previous.top - current.top;
          paper.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${previousScale})`;
        });
      });
      observer.observe(pane);
      // 等窗口全屏的边框/滚动条几何真正稳定（连续 3 帧不变）再量终点；
      // 固定 50ms 会在窗口尺寸尚未落定时量到旧值，动画结尾再跳 15px。
      const poll = () => {
        if (settled) return;
        if (
          window.innerWidth === lastWidth &&
          window.innerHeight === lastHeight &&
          pane.clientWidth === lastClientWidth
        ) {
          stableFrames += 1;
        } else {
          stableFrames = 0;
          lastWidth = window.innerWidth;
          lastHeight = window.innerHeight;
          lastClientWidth = pane.clientWidth;
        }
        if (stableFrames >= 3) {
          finish();
          return;
        }
        frame = requestAnimationFrame(poll);
      };
      frame = requestAnimationFrame(poll);
      fallback = window.setTimeout(finish, 600);
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    updateFullscreen();
    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreen);
      fullscreenAnimations.current.forEach((animation) =>
        animation.cancel(),
      );
      fullscreenAnimations.current.clear();
      releaseNativeWindowFullscreen();
    };
  }, []);

  // WebView2 不在按下 Escape 时自动退出元素全屏，必须自己处理键盘退出。
  useEffect(() => {
    if (!isFullscreen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void document.exitFullscreen?.()?.catch(() => undefined);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isFullscreen]);

  useEffect(() => {
    const pane = paneRef.current;
    const pagesRoot = pagesRef.current;
    if (!pane || !pagesRoot) return;
    let frame = 0;
    const updateCurrentPage = () => {
      frame = 0;
      const paneRect = pane.getBoundingClientRect();
      const middle = paneRect.top + pane.clientHeight / 2;
      let closest = 0;
      let distance = Infinity;
      pagesRoot
        .querySelectorAll<HTMLElement>(".paper-frame")
        .forEach((paper, index) => {
          const rect = paper.getBoundingClientRect();
          const nextDistance = Math.max(
            rect.top - middle,
            middle - rect.bottom,
            0,
          );
          if (nextDistance < distance) {
            closest = index;
            distance = nextDistance;
          }
        });
      setCurrentPage(closest);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(updateCurrentPage);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(pane);
    observer.observe(pagesRoot);
    pane.addEventListener("scroll", schedule, { passive: true });
    updateCurrentPage();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      pane.removeEventListener("scroll", schedule);
    };
  }, [pages]);

  const scrollToPage = (pageIndex: number) => {
    const page =
      pagesRef.current?.querySelectorAll<HTMLElement>(".paper-frame")[
        pageIndex
      ];
    const pane = paneRef.current;
    if (!page || !pane) return;
    pane.scrollTo({
      top:
        pane.scrollTop +
        page.getBoundingClientRect().top -
        pane.getBoundingClientRect().top,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  };

  const changeZoomToPercent = (value: number) => {
    const targetPercent = Math.min(200, Math.max(20, value));
    initialZoomApplied.current = true;
    setZoomFactor(targetPercent / 100 / baseScaleRef.current);
    setZoomPercent(targetPercent);
    setZoomInput(String(targetPercent));
    onZoomPercentChange(targetPercent);
  };

  const commitZoomInput = () => {
    zoomInputActiveRef.current = false;
    const parsed = Number(zoomInput);
    if (!zoomInput.trim() || !Number.isFinite(parsed)) {
      setZoomInput(String(zoomPercent));
      return;
    }
    changeZoomToPercent(parsed);
  };

  const toggleFullscreen = async () => {
    const pane = paneRef.current;
    if (!pane) return;
    const previous = new Map<HTMLElement, DOMRect>();
    pagesRef.current
      ?.querySelectorAll<HTMLElement>(".paper-frame")
      .forEach((frame) => previous.set(frame, frame.getBoundingClientRect()));
    pendingFullscreenPaperRects.current = previous;
    const entering = document.fullscreenElement !== pane;
    try {
      if (entering) {
        // 元素全屏只铺满 WebView，Windows 任务栏仍会在底部留下黑条。
        // 先请求元素全屏（保留用户手势），同时把 Tauri 窗口切到原生全屏；
        // 退出时只还原本次由预览接管的窗口状态。
        const request = pane.requestFullscreen
          ? pane.requestFullscreen()
          : Promise.resolve();
        const wasFullscreen = await readNativeWindowFullscreen();
        if (wasFullscreen === false) {
          const changed = await setNativeWindowFullscreen(true);
          nativeFullscreenOwned.current = changed;
        }
        await request;
      } else {
        await document.exitFullscreen();
      }
    } catch {
      pendingFullscreenPaperRects.current = new Map();
      releaseNativeWindowFullscreen();
      setIsFullscreen(false);
    }
  };

  return (
    <section
      className="preview-pane"
      ref={paneRef}
      style={{ overflowAnchor: "none" }}
    >
      <header className="preview-workspace-header">
        <div className="preview-workspace-heading">
          <div className="preview-workspace-kicker">LIVE PREVIEW</div>
          <div className="preview-workspace-subtitle">
            实时预览，与优秀的你相遇。
          </div>
        </div>
        <div className="preview-workspace-controls" aria-label="预览控制">
          <button
            type="button"
            className="preview-reset-control"
            aria-label="恢复默认缩放"
            title="恢复默认缩放（按当前分栏自适应）"
            onClick={() => {
              initialZoomApplied.current = true;
              setZoomFactor(1);
              onZoomPercentChange(Math.round(baseScaleRef.current * 100));
            }}
          >
            适应
          </button>
          <div
            className="preview-zoom-control"
            role="group"
            aria-label="预览缩放"
          >
            <button
              type="button"
              aria-label="缩小预览"
              title="缩小预览"
              onClick={() => changeZoomToPercent(zoomPercent - 10)}
              disabled={zoomPercent <= 20}
            >
              <Minus size={15} aria-hidden="true" />
            </button>
            <label className="preview-zoom-value">
              <input
                type="number"
                inputMode="decimal"
                min="20"
                max="200"
                step="1"
                aria-label="预览缩放百分比"
                value={zoomInput}
                style={{ width: `${Math.max(2, zoomInput.length) + 0.2}ch` }}
                onFocus={() => {
                  zoomInputActiveRef.current = true;
                }}
                onChange={(event) => setZoomInput(event.target.value)}
                onBlur={commitZoomInput}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
              <span aria-hidden="true">%</span>
            </label>
            <button
              type="button"
              aria-label="放大预览"
              title="放大预览"
              onClick={() => changeZoomToPercent(zoomPercent + 10)}
              disabled={zoomPercent >= 200}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            className="preview-fullscreen-control"
            aria-label={isFullscreen ? "退出全屏预览" : "全屏预览"}
            title={isFullscreen ? "退出全屏预览" : "全屏预览"}
            onClick={() => void toggleFullscreen()}
          >
            {isFullscreen ? (
              <Minimize size={16} aria-hidden="true" />
            ) : (
              <Maximize size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      </header>
      <div className="preview-canvas">
        <div className="preview-stage">
          <div
            ref={measurementRef}
            className={`paper layout-measure ${templateClass}`}
            data-template-id={templateId}
            aria-hidden="true"
            style={
              {
                fontFamily,
                fontSize: `${fontSize}px`,
                lineHeight: `${measurementLineHeight}px`,
                letterSpacing: `${letterSpacing}px`,
                padding: `${pagePadding}px`,
                "--resume-accent": theme,
                "--imported-side-background": templateSideBandBackground,
                "--imported-side-foreground": templateSideBandForeground,
                "--module-gap": `${measurementModuleGap}px`,
                "--template-heading-font-size": `${templateHeadingFontSize}px`,
                "--template-paragraph-spacing": `${templateParagraphSpacing}px`,
                "--template-list-spacing": `${templateListSpacing}px`,
              } as CSSProperties
            }
          >
            <PreviewContent blocks={allBlocks} {...sharedContentProps} />
          </div>

          <div
            className="resume-pages"
            ref={pagesRef}
            aria-label={`简历预览，共 ${visiblePageCount} 页`}
            style={
              {
                "--paper-render-width": `${A4_WIDTH_PX}px`,
                "--paper-render-height": `${A4_HEIGHT_PX}px`,
                "--preview-scale": 1,
              } as CSSProperties
            }
          >
            {importedLayout
              ? importedLayout.pages.map((layoutPage, layoutIndex) => (
                  // 导入分支的 frame 不能写死 A4 尺寸：纸面被 --preview-scale 缩放，
                  // frame 必须继承 .resume-pages 上按缩放算出的 --paper-render-*，
                  // 否则页尾会多出一大块死白、纸张还会溢出预览容器。
                  <div className="paper-frame" key={`layout-${layoutIndex}`}>
                    <div
                      className="paper imported-layout-paper"
                      data-template-id={templateId}
                      data-page-number={layoutIndex + 1}
                      data-layout-width={layoutPage.width}
                      data-layout-height={layoutPage.height}
                      style={{ width: A4_WIDTH_PX, height: A4_HEIGHT_PX }}
                    >
                      <ImportedLayoutPaper
                        layout={importedLayout}
                        pageIndex={layoutIndex}
                        edits={importedEdits ?? {}}
                      />
                    </div>
                  </div>
                ))
              : pages.map((page, pageIndex) => (
              <div
                className="paper-frame"
                key={`${templateId}-${pageIndex}-${page.blocks
                  .map((block) =>
                    block.kind === "module" ? block.module : block.kind,
                  )
                  .join("-")}`}
              >
                <div
                  className={`paper ${templateClass}`}
                  data-template-id={templateId}
                  data-page-number={pageIndex + 1}
                  style={
                    {
                      fontFamily,
                      fontSize: `${fontSize}px`,
                      lineHeight: `${page.lineHeight}px`,
                      letterSpacing: `${letterSpacing}px`,
                      padding: `${pagePadding}px`,
                      "--resume-accent": theme,
                      "--imported-side-background": templateSideBandBackground,
                      "--imported-side-foreground": templateSideBandForeground,
                      "--module-gap": `${baseModuleGap + page.extraModuleGap}px`,
                      "--template-heading-font-size": `${templateHeadingFontSize}px`,
                      "--template-paragraph-spacing": `${templateParagraphSpacing}px`,
                      "--template-list-spacing": `${templateListSpacing}px`,
                    } as CSSProperties
                  }
                >
                  {showResumeContent && (
                    <PreviewContent
                      blocks={page.blocks}
                      {...sharedContentProps}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
          <div
            className="preview-pagination"
            role="group"
            aria-label={`预览页码，第 ${currentPage + 1} 页，共 ${visiblePageCount} 页`}
          >
            <button
              type="button"
              aria-label="上一页"
              title="上一页"
              onClick={() => scrollToPage(currentPage - 1)}
              disabled={currentPage <= 0}
            >
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <span>
              <strong>{currentPage + 1}</strong> / {visiblePageCount}
            </span>
            <button
              type="button"
              aria-label="下一页"
              title="下一页"
              onClick={() => scrollToPage(currentPage + 1)}
              disabled={currentPage >= visiblePageCount - 1}
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
          {showResumeContent && (
            <PreviewInteractionLayer
              pages={pages}
              moduleNames={moduleNames}
              summaryTitle={summaryTitle}
              previewPaneRef={paneRef}
              pagesRef={pagesRef}
              onNavigateToEditor={onNavigateToEditor}
            />
          )}
          {/* 版式层模式下纸面是源文件栅格 + 补丁，常规溢出检测整体停用。 */}
          {importedLayout ? null : (
            <PreviewOverflowGuard
              pages={pages}
              pagesRef={pagesRef}
              measurementRef={measurementRef}
              onChange={onOverflowChange}
            />
          )}
        </div>
      </div>
    </section>
  );
});
