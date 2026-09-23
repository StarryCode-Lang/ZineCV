import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  ModuleKey,
  ResumeState,
  SectionKey,
  SeparatorMode,
} from "../domain/resume-model";
import type { DraftSaveState } from "../domain/draft-save-state";
import type { ResumePresentation } from "../domain/template-model";
import { writeStoredString } from "../utils/resume";

type ResumePersistenceOptions = {
  presentation: ResumePresentation;
  resume: ResumeState;
  setSaveState: Dispatch<SetStateAction<DraftSaveState>>;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  resumeTitle: string;
  summaryTitle: string;
  font: string;
  fontSize: string;
  lineHeight: string;
  moduleSpacing: string;
  pageMargin: string;
  theme: string;
  smartFillEnabled: boolean;
  dateFormat: "2021年1月" | "2021.01";
  titleFormat: "双行标题" | "单行标题";
  separator: SeparatorMode;
  textAlign: "系统默认" | "两端对齐";
};

type DraftSaveResult = {
  ok: boolean;
  failedKeys: string[];
};

type DraftSnapshot = Omit<ResumePersistenceOptions, "setSaveState">;
type DraftWrite = { key: string; value: string };

const savingLabel = "正在保存浏览器草稿…";
const retryingLabel = "正在重试浏览器草稿…";
const savedLabel = "浏览器草稿已保存";
const failedLabel = "浏览器草稿保存失败";

function buildDraftWrites(draft: DraftSnapshot): DraftWrite[] {
  return [
    {
      key: "resume-diy-presentation-v1",
      value: JSON.stringify(draft.presentation),
    },
    { key: "resume-diy-state", value: JSON.stringify(draft.resume) },
    { key: "resume-diy-modules", value: JSON.stringify(draft.moduleOrder) },
    {
      key: "resume-diy-section-order-v2",
      value: JSON.stringify(draft.moduleOrder),
    },
    {
      key: "resume-diy-module-names",
      value: JSON.stringify(draft.moduleNames),
    },
    { key: "resume-diy-title", value: draft.resumeTitle },
    { key: "resume-diy-summary-title", value: draft.summaryTitle },
    {
      key: "resume-diy-preferences",
      value: JSON.stringify({
        font: draft.font,
        fontSize: draft.fontSize,
        lineHeight: draft.lineHeight,
        moduleSpacing: draft.moduleSpacing,
        pageMargin: draft.pageMargin,
        theme: draft.theme,
        smartFillV2: String(draft.smartFillEnabled),
        dateFormat: draft.dateFormat,
        titleFormat: draft.titleFormat,
        separator: draft.separator,
        textAlign: draft.textAlign,
      }),
    },
    { key: "resume-diy-layout-consistency-v1", value: "true" },
  ];
}

// 草稿、模块、标题和排版偏好的写入；版本库、分栏和分页缓存由各自模块维护。
export function useResumePersistence({
  presentation,
  resume,
  setSaveState,
  moduleOrder,
  moduleNames,
  resumeTitle,
  summaryTitle,
  font,
  fontSize,
  lineHeight,
  moduleSpacing,
  pageMargin,
  theme,
  smartFillEnabled,
  dateFormat,
  titleFormat,
  separator,
  textAlign,
}: ResumePersistenceOptions) {
  const latestDraft = useRef<DraftSnapshot | null>(null);
  const pendingTimer = useRef<number | null>(null);
  latestDraft.current = {
    presentation,
    resume,
    moduleOrder,
    moduleNames,
    resumeTitle,
    summaryTitle,
    font,
    fontSize,
    lineHeight,
    moduleSpacing,
    pageMargin,
    theme,
    smartFillEnabled,
    dateFormat,
    titleFormat,
    separator,
    textAlign,
  };

  const flushDraft = useCallback((): DraftSaveResult => {
    if (pendingTimer.current !== null) {
      window.clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    }
    const draft = latestDraft.current;
    if (!draft) {
      setSaveState({ status: "failed", label: failedLabel });
      return { ok: false, failedKeys: ["snapshot"] };
    }
    let writes: DraftWrite[];
    try {
      writes = buildDraftWrites(draft);
    } catch {
      setSaveState({ status: "failed", label: failedLabel });
      return { ok: false, failedKeys: ["serialization"] };
    }

    const failedKeys = writes.flatMap(({ key, value }) => {
      try {
        return writeStoredString(key, value) ? [] : [key];
      } catch {
        return [key];
      }
    });
    const result = { ok: failedKeys.length === 0, failedKeys };
    setSaveState({
      status: result.ok ? "saved" : "failed",
      label: result.ok ? savedLabel : failedLabel,
    });
    return result;
  }, [setSaveState]);

  const retryDraft = useCallback(() => {
    setSaveState({ status: "retrying", label: retryingLabel });
    return flushDraft();
  }, [flushDraft, setSaveState]);

  useEffect(() => {
    setSaveState({ status: "saving", label: savingLabel });
    if (pendingTimer.current !== null)
      window.clearTimeout(pendingTimer.current);
    pendingTimer.current = window.setTimeout(() => {
      pendingTimer.current = null;
      flushDraft();
    }, 180);
    return () => {
      if (pendingTimer.current !== null) {
        window.clearTimeout(pendingTimer.current);
        pendingTimer.current = null;
      }
    };
  }, [
    presentation,
    resume,
    moduleOrder,
    moduleNames,
    resumeTitle,
    summaryTitle,
    font,
    fontSize,
    lineHeight,
    moduleSpacing,
    pageMargin,
    theme,
    smartFillEnabled,
    dateFormat,
    titleFormat,
    separator,
    textAlign,
    flushDraft,
    setSaveState,
  ]);

  useEffect(() => {
    const flushOnPageHide = () => flushDraft();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [flushDraft]);

  return { flushDraft, retryDraft };
}
