import {
  measureResumePages,
  getPreviewBlocks,
} from "../services/resume-pagination";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { A4_HEIGHT_PX } from "../domain/resume-model";

import type {
  ModuleKey,
  PreviewBlock,
  PreviewPageLayout,
  ResumeState,
  SectionKey,
  SeparatorMode,
} from "../domain/resume-model";
import type { ResumeVersionSnapshot } from "../domain/version-model";
import { readStoredString, writeStoredString } from "../utils/resume";

type SmartFitSnapshot = {
  fontSize: string;
  lineHeight: string;
  moduleSpacing: string;
  pageMargin: string;
};

type PaginationOptions = {
  resume: ResumeState;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  font: string;
  fontSize: string;
  lineHeight: string;
  moduleSpacing: string;
  pageMargin: string;
  dateFormat: ResumeVersionSnapshot["layout"]["dateFormat"];
  titleFormat: ResumeVersionSnapshot["layout"]["titleFormat"];
  separator: SeparatorMode;
  textAlign: ResumeVersionSnapshot["layout"]["textAlign"];
  layoutContextKey: string;
  smartFillEnabled: boolean;
  initialAutoFitEnabled: boolean;
  setFontSize: (value: string) => void;
  setLineHeight: (value: string) => void;
  setModuleSpacing: (value: string) => void;
  setPageMargin: (value: string) => void;
  setSmartFillEnabled: (value: boolean) => void;
  notify: (message: string) => void;
  planOnePage?: (isCancelled: () => boolean, finalizing?: boolean) => Promise<boolean>;
  cancelOnePagePlan?: () => void;
  // 智能一页全部轮次收敛后回调（含手动触发）；调用方据此吸收 fit 产生的版式变化。
  onSmartFitComplete?: () => void;
};
export function useResumePagination({
  resume,
  moduleOrder,
  moduleNames,
  summaryTitle,
  font,
  fontSize,
  lineHeight,
  moduleSpacing,
  pageMargin,
  dateFormat,
  titleFormat,
  separator,
  textAlign,
  layoutContextKey,
  smartFillEnabled,
  initialAutoFitEnabled,
  setFontSize,
  setLineHeight,
  setModuleSpacing,
  setPageMargin,
  setSmartFillEnabled,
  notify,
  planOnePage,
  cancelOnePagePlan,
  onSmartFitComplete,
}: PaginationOptions) {
  const [smartFitRequested, setSmartFitRequested] = useState(false);
  const [smartLayoutApplied, setSmartLayoutApplied] = useState(false);
  const [smartFitPulse, setSmartFitPulse] = useState(0);
  const smartAppliedSignatureRef = useRef<string | null>(null);
  const smartFitSourceRef = useRef<
    "manual" | "initial-load" | "viewport-change" | "template-change"
  >("manual");
  // 智能一页失败时，用这个快照恢复用户启动前的手动排版。
  const smartFitSnapshotRef = useRef<SmartFitSnapshot | null>(null);
  // 扩张后的排版必须再实测一轮，避免按估算值越过 A4 底部边距。
  const smartCandidateAppliedRef = useRef(false);
  const lastAutomaticFitRef = useRef<string | null>(null);
  const engineFitEpochRef = useRef(0);
  const engineFitPendingRef = useRef(false);
  const coreFitUsedRef = useRef(false);
  const planOnePageRef = useRef(planOnePage);
  planOnePageRef.current = planOnePage;
  const onSmartFitCompleteRef = useRef(onSmartFitComplete);
  onSmartFitCompleteRef.current = onSmartFitComplete;
  // 相同内容和参数再次开启时复用已验证结果，避免重复点击继续累加间距。
  const lastSmartFitSignatureRef = useRef(
    // v3 同时校验当前实际页数；不复用曾经成功但现在已变成多页的缓存。
    readStoredString("resume-diy-smart-fit-signature-v3", ""),
  );
  const [fontLayoutRevision, setFontLayoutRevision] = useState(0);
  const paginationMeasureRef = useRef<HTMLDivElement>(null);
  const measuredContentRef = useRef<Element | null>(null);
  const measurementObserverRef = useRef<ResizeObserver | null>(null);
  const effectiveFontSize = Number(fontSize);
  const minimumReadableLineHeight = Math.max(12, effectiveFontSize);
  const layoutBaseLineHeight = Math.max(
    Number(lineHeight),
    minimumReadableLineHeight,
  );
  const pagePadding = Number(pageMargin);
  const pageLetterSpacing = 0;
  const layoutBaseModuleGap = Math.max(0, Number(moduleSpacing));
  const measurementLineHeight = layoutBaseLineHeight;
  const measurementModuleGap = layoutBaseModuleGap;
  const [previewPages, setPreviewPages] = useState<PreviewPageLayout[]>(() => [
    {
      blocks: getPreviewBlocks(moduleOrder, resume),
      extraModuleGap: 0,
      lineHeight: layoutBaseLineHeight,
    },
  ]);
  const visibleLineHeight =
    previewPages.length === 1
      ? previewPages[0].lineHeight
      : measurementLineHeight;
  const visibleModuleSpacing =
    previewPages.length === 1
      ? layoutBaseModuleGap + previewPages[0].extraModuleGap
      : measurementModuleGap;
  useEffect(() => {
    if (Number(lineHeight) < minimumReadableLineHeight)
      setLineHeight(String(minimumReadableLineHeight));
  }, [lineHeight, minimumReadableLineHeight]);

  useEffect(() => {
    let active = true;
    document.fonts?.ready.then(() => {
      if (active) setFontLayoutRevision((revision) => revision + 1);
    });
    return () => {
      active = false;
    };
  }, [font]);

  // Font faces and template spacing can settle after the parent layout effect.
  // Watch the unscaled content, not the fixed-height A4 frame or visible zoom.
  useEffect(() => {
    const content = paginationMeasureRef.current?.querySelector(".paper-content");
    if (content === measuredContentRef.current) return;
    measurementObserverRef.current?.disconnect();
    measurementObserverRef.current = null;
    measuredContentRef.current = content ?? null;
    if (!content) return;
    const observer = new ResizeObserver(() => setFontLayoutRevision(value => value + 1));
    measurementObserverRef.current = observer;
    observer.observe(content);
  });
  useEffect(() => () => {
    measurementObserverRef.current?.disconnect();
    measurementObserverRef.current = null;
    measuredContentRef.current = null;
  }, []);

  const smartFitInputSignature = useMemo(
    () =>
      JSON.stringify({
        resume,
        moduleOrder,
        moduleNames,
        summaryTitle,
        font,
        fontSize,
        lineHeight,
        moduleSpacing,
        pageMargin,
        dateFormat,
        titleFormat,
        separator,
        textAlign,
        layoutContextKey,
      }),
    [
      resume,
      moduleOrder,
      moduleNames,
      summaryTitle,
      font,
      fontSize,
      lineHeight,
      moduleSpacing,
      pageMargin,
      dateFormat,
      titleFormat,
      separator,
      textAlign,
      layoutContextKey,
    ],
  );
  const currentFitSignatureRef = useRef(smartFitInputSignature);
  currentFitSignatureRef.current = smartFitInputSignature;
  useEffect(() => () => {
    engineFitEpochRef.current += 1;
    cancelOnePagePlan?.();
  }, [cancelOnePagePlan]);

  // 隐藏测量稿计算每个模块高度，再按 A4 可用高度拆分或智能填充。
  useLayoutEffect(() => {
    const measurement = paginationMeasureRef.current;
    if (!measurement) return;

    const contentHeight = A4_HEIGHT_PX - pagePadding * 2;
    const measuredContentHeight =
      measurement
        .querySelector<HTMLElement>(".paper-content")
        ?.getBoundingClientRect().height ?? 0;
    const rawPages = measureResumePages(
      measurement,
      moduleOrder,
      resume,
      contentHeight,
    );
    const nextPages = rawPages
      .filter((page) => page.blocks.length)
      .map((page) => ({
        blocks: page.blocks,
        lineHeight: layoutBaseLineHeight,
        extraModuleGap: 0,
      }));

    const resolvedPages = nextPages.length
      ? nextPages
      : [
          {
            blocks: [{ kind: "header" } as PreviewBlock],
            extraModuleGap: 0,
            lineHeight: layoutBaseLineHeight,
          },
        ];
    setPreviewPages(resolvedPages);

    // 首次字体加载完成前的字形高度不可靠，等待真实字体后再锁定智能结果。
    if (!smartFitRequested || fontLayoutRevision === 0 || engineFitPendingRef.current) return;

    // 分块高度可能漏掉折叠外边距；整页内容高度用于兜底，防止底部被挤进固定页距。
    const exceedsSinglePage =
      resolvedPages.length > 1 || measuredContentHeight > contentHeight + 0.5;
    if (exceedsSinglePage) {
      const currentModuleSpacing = Number(moduleSpacing);
      const currentLineHeight = Number(lineHeight);
      const currentPageMargin = Number(pageMargin);
      if (currentModuleSpacing > 0) {
        const step = smartCandidateAppliedRef.current ? 0.25 : 1;
        setModuleSpacing(String(Math.max(0, currentModuleSpacing - step)));
      } else if (currentLineHeight > minimumReadableLineHeight) {
        setLineHeight(String(currentLineHeight - 1));
      } else if (currentPageMargin > 20) {
        setPageMargin(String(Math.max(20, currentPageMargin - 2)));
      } else if (effectiveFontSize > 10) {
        const nextSize = effectiveFontSize - 1;
        setFontSize(String(nextSize));
        setLineHeight(String(Math.max(12, nextSize)));
      } else {
        const snapshot = smartFitSnapshotRef.current;
        if (snapshot) {
          setFontSize(snapshot.fontSize);
          setLineHeight(snapshot.lineHeight);
          setModuleSpacing(snapshot.moduleSpacing);
          setPageMargin(snapshot.pageMargin);
        }
        smartFitSnapshotRef.current = null;
        smartCandidateAppliedRef.current = false;
        setSmartFitRequested(false);
        setSmartFillEnabled(false);
        setSmartLayoutApplied(false);
        smartAppliedSignatureRef.current = null;
        if (smartFitSourceRef.current === "manual")
          window.setTimeout(
            () => notify("内容过多，无法在不影响观感的前提下收缩到一页 A4"),
            0,
          );
      }
      return;
    }

    // 首次得到一页时只计算一次扩张值；写回真实控件后再走一轮 DOM 实测。
    if (!smartCandidateAppliedRef.current) {
      const page = rawPages[0];
      const freeSpace = Math.max(0, contentHeight - measuredContentHeight);
      const adjustableElements = measurement.querySelectorAll<HTMLElement>(
        ".preview-entry-head, .preview-meta, .preview-rich",
      );
      const adjustableLineCount = Math.max(
        1,
        Array.from(adjustableElements).reduce(
          (total, element) =>
            total +
            element.getBoundingClientRect().height / layoutBaseLineHeight,
          0,
        ),
      );
      const transitionCount = Math.max(
        1,
        page.blocks.filter((block) => block.kind !== "header").length,
      );
      // 向下取整会留下不足一个像素的安全余量，底部不会侵入固定页距。
      const lineBudget = Math.min(freeSpace * 0.55, adjustableLineCount * 3);
      const adaptiveLineIncrease = Math.floor(
        Math.min(
          Math.max(0, 28 - layoutBaseLineHeight),
          lineBudget / adjustableLineCount,
        ),
      );
      const remainingAfterLines = Math.max(
        0,
        freeSpace - adaptiveLineIncrease * adjustableLineCount,
      );
      const adaptiveGap =
        Math.floor(
          Math.min(
            Math.max(0, 30 - layoutBaseModuleGap),
            remainingAfterLines / transitionCount,
          ) * 100,
        ) / 100;
      const targetLineHeight = layoutBaseLineHeight + adaptiveLineIncrease;
      const targetModuleSpacing = layoutBaseModuleGap + adaptiveGap;
      smartCandidateAppliedRef.current = true;
      if (
        targetLineHeight !== Number(lineHeight) ||
        targetModuleSpacing !== Number(moduleSpacing)
      ) {
        setLineHeight(String(targetLineHeight));
        setModuleSpacing(String(targetModuleSpacing));
        return;
      }
    }

    // 首轮估算后用真实 DOM 剩余高度继续补齐，避免行数估算误差形成明显底部留白。
    // 优先均匀增加模块间距；达到观感上限后，再以 1px 步进增加正文行距。
    const measuredPage = rawPages[0];
    const residualSpace = Math.max(0, contentHeight - measuredContentHeight);
    if (smartCandidateAppliedRef.current && residualSpace > 2) {
      const transitionCount = Math.max(
        1,
        measuredPage.blocks.filter((block) => block.kind !== "header").length,
      );
      const currentModuleSpacing = Number(moduleSpacing);
      if (currentModuleSpacing < 30) {
        const nextModuleSpacing = Math.min(
          30,
          Math.floor(
            (currentModuleSpacing + residualSpace / transitionCount) * 100,
          ) / 100,
        );
        if (nextModuleSpacing - currentModuleSpacing >= 0.05) {
          setModuleSpacing(String(nextModuleSpacing));
          return;
        }
      }

      const currentLineHeight = Number(lineHeight);
      const maximumComfortableLineHeight = Math.min(28, effectiveFontSize + 6);
      if (currentLineHeight < maximumComfortableLineHeight) {
        setLineHeight(String(currentLineHeight + 1));
        return;
      }
    }

    const finish = () => {
      smartFitSnapshotRef.current = null;
      smartCandidateAppliedRef.current = false;
      const signature = currentFitSignatureRef.current;
      lastSmartFitSignatureRef.current = signature;
      writeStoredString("resume-diy-smart-fit-signature-v3", signature);
      setSmartFitRequested(false);
      setSmartFillEnabled(false);
      setSmartLayoutApplied(true);
      smartAppliedSignatureRef.current = signature;
      onSmartFitCompleteRef.current?.();
      if (smartFitSourceRef.current === "manual")
        notify("智能一页已完成：四边页距一致，内容已适配一张 A4");
    };
    // DOM spacing fill can cross an engine page boundary. Confirm the durable
    // final layout once; a finite correction is final and is not filled again.
    const finalPlanner = planOnePageRef.current;
    if (coreFitUsedRef.current && finalPlanner) {
      const epoch = engineFitEpochRef.current;
      engineFitPendingRef.current = true;
      const isCancelled = () => epoch !== engineFitEpochRef.current;
      void finalPlanner(isCancelled, true).then(success => {
        if (isCancelled()) return;
        requestAnimationFrame(() => {
          if (isCancelled()) return;
          engineFitPendingRef.current = false;
          if (success) finish();
          else {
            setSmartFitRequested(false);
            setSmartFillEnabled(false);
            setSmartLayoutApplied(false);
            if (smartFitSourceRef.current === "manual")
              notify("简历已发生变化，智能一页结果已取消");
          }
        });
      }).catch(error => {
        if (isCancelled()) return;
        engineFitPendingRef.current = false;
        setSmartFitRequested(false);
        setSmartFillEnabled(false);
        if (smartFitSourceRef.current === "manual")
          notify(`智能一页未完成：${error instanceof Error ? error.message : String(error)}`);
      });
    } else finish();
  }, [
    resume,
    moduleOrder,
    moduleNames,
    summaryTitle,
    effectiveFontSize,
    layoutBaseLineHeight,
    layoutBaseModuleGap,
    lineHeight,
    moduleSpacing,
    pagePadding,
    pageMargin,
    dateFormat,
    titleFormat,
    separator,
    textAlign,
    layoutContextKey,
    smartFitRequested,
    smartFitInputSignature,
    fontLayoutRevision,
  ]);

  const startSmartFit = useCallback(
    (
      source: "manual" | "initial-load" | "viewport-change" | "template-change",
    ) => {
      if (smartFitRequested || engineFitPendingRef.current) return false;
      if (source !== "manual") {
        const automaticKey = `${source}:${smartFitInputSignature}`;
        if (lastAutomaticFitRef.current === automaticKey) return false;
        lastAutomaticFitRef.current = automaticKey;
      }
      smartFitSourceRef.current = source;
      setSmartFitPulse((pulse) => pulse + 1);
      setSmartLayoutApplied(false);
      smartFitSnapshotRef.current = {
        fontSize,
        lineHeight,
        moduleSpacing,
        pageMargin,
      };
      smartCandidateAppliedRef.current = false;
      setSmartFillEnabled(true);
      if (
        source === "manual" &&
        !planOnePage &&
        lastSmartFitSignatureRef.current === smartFitInputSignature &&
        previewPages.length === 1
      ) {
        smartFitSnapshotRef.current = null;
        setSmartFitRequested(false);
        setSmartFillEnabled(false);
        setSmartLayoutApplied(true);
        smartAppliedSignatureRef.current = smartFitInputSignature;
        notify("当前排版已经过智能一页验证");
        return true;
      }
      const useCorePlan = Boolean(planOnePage && (source === "manual" || previewPages.length > 1));
      coreFitUsedRef.current = useCorePlan;
      if (useCorePlan && planOnePage) {
        const epoch = ++engineFitEpochRef.current;
        engineFitPendingRef.current = true;
        const isCancelled = () => epoch !== engineFitEpochRef.current ||
          currentFitSignatureRef.current !== smartFitInputSignature;
        void planOnePage(isCancelled).then(success => {
          if (epoch !== engineFitEpochRef.current) return;
          engineFitPendingRef.current = false;
          if (success) {
            if (lastSmartFitSignatureRef.current === smartFitInputSignature && previewPages.length === 1) {
              smartFitSnapshotRef.current = null;
              setSmartFillEnabled(false);
              setSmartLayoutApplied(true);
              smartAppliedSignatureRef.current = smartFitInputSignature;
              if (source === "manual") notify("智能一页已完成：四边页距一致，内容已适配一张 A4");
              return;
            }
            // The shared finite solver handles compression. Preserve the
            // existing measured one-page spacing/fill after its frozen commit.
            setSmartFitRequested(true);
          } else {
            smartFitSnapshotRef.current = null;
            setSmartFillEnabled(false);
            if (source === "manual") notify(isCancelled()
              ? "简历已发生变化，智能一页结果已取消"
              : "内容过多，无法在不影响观感的前提下收缩到一页 A4");
          }
        }).catch(error => {
          if (epoch !== engineFitEpochRef.current) return;
          engineFitPendingRef.current = false;
          smartFitSnapshotRef.current = null;
          setSmartFillEnabled(false);
          if (source === "manual") notify(`智能一页未完成，原排版已保留：${error instanceof Error ? error.message : String(error)}`);
        });
      } else setSmartFitRequested(true);
      if (source === "manual")
        notify("智能一页正在协调适配字号、行距、模块间距与页距…");
      return true;
    },
    [
      fontSize,
      lineHeight,
      moduleSpacing,
      notify,
      pageMargin,
      previewPages.length,
      setSmartFillEnabled,
      smartFitInputSignature,
      smartFitRequested,
      planOnePage,
    ],
  );

  const fitOnePage = () => {
    startSmartFit("manual");
  };

  const latestStartSmartFitRef = useRef(startSmartFit);
  useEffect(() => {
    latestStartSmartFitRef.current = startSmartFit;
  }, [startSmartFit]);

  useEffect(() => {
    if (
      !smartFitRequested &&
      smartAppliedSignatureRef.current &&
      smartAppliedSignatureRef.current !== smartFitInputSignature
    ) {
      smartAppliedSignatureRef.current = null;
      setSmartLayoutApplied(false);
    }
  }, [smartFitInputSignature, smartFitRequested]);

  const initialAutoFitDoneRef = useRef(false);
  useEffect(() => {
    if (!initialAutoFitEnabled || fontLayoutRevision === 0 || initialAutoFitDoneRef.current) return;
    const timer = window.setTimeout(() => {
      initialAutoFitDoneRef.current = true;
      latestStartSmartFitRef.current("initial-load");
    }, 160);
    return () => window.clearTimeout(timer);
  }, [fontLayoutRevision, initialAutoFitEnabled]);

  useEffect(() => {
    let timer = 0;
    const viewportSignature = () =>
      [
        window.innerWidth,
        window.innerHeight,
        window.devicePixelRatio,
        window.visualViewport?.scale ?? 1,
      ].join(":");
    let lastViewport = viewportSignature();
    const handleViewportChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const nextViewport = viewportSignature();
        if (
          nextViewport === lastViewport ||
          document.visibilityState !== "visible"
        )
          return;
        lastViewport = nextViewport;
        lastAutomaticFitRef.current = null;
        latestStartSmartFitRef.current("viewport-change");
      }, 260);
    };
    window.addEventListener("resize", handleViewportChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, []);

  const applyManualLayoutChange = (
    setter: (value: string) => void,
    value: string,
  ) => {
    engineFitEpochRef.current += 1;
    engineFitPendingRef.current = false;
    cancelOnePagePlan?.();
    smartFitSnapshotRef.current = null;
    smartCandidateAppliedRef.current = false;
    setSmartFitRequested(false);
    setSmartFillEnabled(false);
    setSmartLayoutApplied(false);
    smartAppliedSignatureRef.current = null;
    setter(value);
  };

  // 恢复版本时停止正在计算的候选值，内部引用不暴露给页面。
  const stopPendingFit = () => {
    engineFitEpochRef.current += 1;
    engineFitPendingRef.current = false;
    cancelOnePagePlan?.();
    setSmartFillEnabled(false);
    setSmartFitRequested(false);
    smartCandidateAppliedRef.current = false;
    setSmartLayoutApplied(false);
    smartAppliedSignatureRef.current = null;
  };

  return {
    previewPages,
    visibleLineHeight,
    visibleModuleSpacing,
    paginationMeasureRef,
    measurementLineHeight,
    measurementModuleGap,
    pagePadding,
    pageLetterSpacing,
    layoutBaseModuleGap,
    fitOnePage,
    autoFitOnePage: startSmartFit,
    smartFitRequested,
    smartFitActive: smartFillEnabled || smartLayoutApplied,
    smartFitPulse,
    applyManualLayoutChange,
    stopPendingFit,
  };
}
