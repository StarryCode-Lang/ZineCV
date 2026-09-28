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
} from "../../domain/resume-model";
import { A4_HEIGHT_PX, A4_WIDTH_PX } from "../../domain/resume-model";
import { PreviewContent } from "./ResumePreview";
import { PreviewInteractionLayer } from "./PreviewInteractionLayer";
import { PreviewOverflowGuard } from "./PreviewOverflowGuard";
import type { EditorNavigationTarget } from "../../app/useEditorNavigation";
import type { KnownTemplateId } from "../../domain/template-model";

let measuredScrollbarWidth: number | null = null;

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
  onNavigateToEditor: (target: EditorNavigationTarget) => void;
  onOverflowChange: Parameters<typeof PreviewOverflowGuard>[0]["onChange"];
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
  onNavigateToEditor,
  onOverflowChange,
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
  const [zoomPercent, setZoomPercent] = useState(100);
  const [zoomInput, setZoomInput] = useState("100");
  const zoomInputActiveRef = useRef(false);
  const baseScaleRef = useRef(1);
  const [currentPage, setCurrentPage] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const pendingFullscreenPaperRect = useRef<DOMRect | null>(null);
  const fullscreenAnimation = useRef<{ cancel: () => void } | null>(null);
  const showResumeContent = hasResumeContent(resume);
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
      const verticalPadding =
        Number.parseFloat(styles.paddingTop) +
        Number.parseFloat(styles.paddingBottom);
      const horizontalBorder =
        Number.parseFloat(styles.borderLeftWidth) +
        Number.parseFloat(styles.borderRightWidth);
      const verticalBorder =
        Number.parseFloat(styles.borderTopWidth) +
        Number.parseFloat(styles.borderBottomWidth);
      const paneRect = pane.getBoundingClientRect();
      const widthWithoutScrollbar = Math.max(
        1,
        paneRect.width - horizontalBorder - horizontalPadding,
      );
      const availableHeight = Math.max(
        0,
        paneRect.height - verticalBorder - verticalPadding,
      );
      const pagesRoot = pagesRef.current;
      if (!pagesRoot) return;
      const pageGap =
        Number.parseFloat(window.getComputedStyle(pagesRoot).rowGap) || 0;
      const totalGap = Math.max(0, pages.length - 1) * pageGap;
      const heightFitWidth = Math.max(
        0,
        ((availableHeight - totalGap - 1) * A4_WIDTH_PX) /
          (Math.max(1, pages.length) * A4_HEIGHT_PX),
      );
      const scrollbarWidth = getScrollbarWidth();
      const scrollbarAllowance = Math.min(
        scrollbarWidth,
        Math.max(0, widthWithoutScrollbar - heightFitWidth),
      );
      const availableWidth = Math.max(
        1,
        widthWithoutScrollbar - scrollbarAllowance,
      );
      const decorationReserve = Math.min(
        180,
        Math.max(0, (availableWidth - 650) * 0.45),
      );
      const paperFitWidth = availableWidth - decorationReserve;
      pane.dataset.decorationCompact = String(availableWidth < 980);
      const widthScale = (paperFitWidth / A4_WIDTH_PX) * zoomFactor;
      const nextScale = Math.min(2, widthScale);
      baseScaleRef.current = paperFitWidth / A4_WIDTH_PX;
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
  }, [pages.length, zoomFactor, isFullscreen]);

  useEffect(() => {
    if (!zoomInputActiveRef.current) setZoomInput(String(zoomPercent));
  }, [zoomPercent]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const updateFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === pane);
      const previous = pendingFullscreenPaperRect.current;
      pendingFullscreenPaperRect.current = null;
      if (!previous || matchMedia("(prefers-reduced-motion: reduce)").matches)
        return;
      requestAnimationFrame(() => {
        const paper =
          pagesRef.current?.querySelector<HTMLElement>(".paper-frame");
        if (!paper) return;
        const next = paper.getBoundingClientRect();
        if (!next.width || !next.height) return;
        const original = paper.style.transform;
        const x = previous.left - next.left;
        const y = previous.top - next.top;
        const scale = previous.width / next.width;
        fullscreenAnimation.current?.cancel();
        fullscreenAnimation.current = animate(
          paper,
          {
            transform: [
              `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
              original || "none",
            ],
          },
          {
            duration: 0.46,
            ease: [0.22, 1, 0.36, 1],
            onComplete: () => {
              if (original) paper.style.transform = original;
              else paper.style.removeProperty("transform");
              fullscreenAnimation.current = null;
            },
          },
        );
      });
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    updateFullscreen();
    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreen);
      fullscreenAnimation.current?.cancel();
    };
  }, []);

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
    setZoomFactor(targetPercent / 100 / baseScaleRef.current);
    setZoomInput(String(targetPercent));
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
    pendingFullscreenPaperRect.current =
      pagesRef.current
        ?.querySelector<HTMLElement>(".paper-frame")
        ?.getBoundingClientRect() ?? null;
    try {
      if (document.fullscreenElement === pane) await document.exitFullscreen();
      else if (pane.requestFullscreen) await pane.requestFullscreen();
    } catch {
      pendingFullscreenPaperRect.current = null;
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
      <div className="preview-decoration-layer" aria-hidden="true">
        <div className="preview-decoration preview-decoration-resume">
          RESUME
        </div>
        <div className="preview-decoration preview-decoration-manifesto">
          <span>A</span>
          <span>BETTER</span>
          <span>YOU</span>
          <span>A BRIGHTER</span>
          <span>WORLD.</span>
        </div>
        <div className="preview-decoration preview-decoration-handwritten">
          <span>Good</span>
          <span>People</span>
          <span>Build</span>
          <span>A Better</span>
          <span>World.</span>
        </div>
      </div>
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
            aria-label={`简历预览，共 ${pages.length} 页`}
            style={
              {
                "--paper-render-width": `${A4_WIDTH_PX}px`,
                "--paper-render-height": `${A4_HEIGHT_PX}px`,
                "--preview-scale": 1,
              } as CSSProperties
            }
          >
            {pages.map((page, pageIndex) => (
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
            aria-label={`预览页码，第 ${currentPage + 1} 页，共 ${pages.length} 页`}
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
              <strong>{currentPage + 1}</strong> / {pages.length}
            </span>
            <button
              type="button"
              aria-label="下一页"
              title="下一页"
              onClick={() => scrollToPage(currentPage + 1)}
              disabled={currentPage >= pages.length - 1}
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
          <PreviewOverflowGuard
            pages={pages}
            pagesRef={pagesRef}
            measurementRef={measurementRef}
            onChange={onOverflowChange}
          />
        </div>
      </div>
    </section>
  );
});
