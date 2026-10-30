import { runApplyImportDraft, runApplyImportedTemplate, runApplyVersionSnapshot } from './workspace/documents';
import {
  runCopyResume, runDownloadResume, runExportFullDatabaseBackup, runExportVersionBackup,
  runImportLegacyBrowserData, runRequestFullDatabaseRestore,
} from './workspace/exports';
import { runApplyFormatPreset, runMakeLayout, runPlanOnePage } from './workspace/layout';
import {
  runApplyAgentEdit, runNavigateToAgentReference, runNavigateToEditor, runResetResume, runSmartSort,
  runUndoAgentEdit,
} from './workspace/navigation';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { DatabaseRestoreResult } from "../../../src-tauri/src/domain/bindings/DatabaseRestoreResult";
import type { Presentation } from "../../../src-tauri/src/domain/bindings/Presentation";
import { platformCapabilities } from "../../platform/capability";
import { isTauriRuntime as isDesktopRuntime, hasDocumentRuntime as isTauriRuntime, nativeInvoke } from "../../platform/ipc";
import {
  readCachedWorkspaceSettings, writeWorkspaceSetting, type WorkspaceSettingKey, type WorkspaceSettings,
  type WorkspaceSettingWrite,
} from "../../platform/settings";
import { useNativeBootstrap } from "../../platform/useNativeBootstrap";
import { useNativeResumePersistence } from "../../platform/useNativeResumePersistence";
import { useNativeResumeVersions } from "../../platform/useNativeResumeVersions";
import {
  flushDraftBeforeVersionAction,
  captureDocumentHostTarget,
  nativeClient
} from "../../platform/workspace";
import { EngineFitClient } from "../../preview/engineFit";
import {
  migratePersonalSites,
  normalizeResumeState,
  normalizeSectionOrder,
} from "../domain/resume-normalization";
import { getPreviewBlocks } from "../services/resume-pagination";
import "../styles/index.css";
import { useAppUpdate } from "./useAppUpdate";
import {
  useEditorNavigation,
  type EditorNavigationTarget,
} from "./useEditorNavigation";
import {
  importedContentSignature,
  sourcePreviewDismissalKey,
  useImportedTemplates,
} from "./useImportedTemplates";
import { useLayoutSettings } from "./useLayoutSettings";
import { useNotice } from "./useNotice";
import { usePaneResize } from "./usePaneResize";
import { useResumeEditing } from "./useResumeEditing";
import { useResumePagination } from "./useResumePagination";
import { renderWorkspace } from './workspace/renderWorkspace';
import type { DocumentTransition } from './DocumentWorkspace';
import type { JobTailoringSelection } from './workspace/JobWorkspace';
import { useExportHost } from './ExportReviewHost';
import { collapsedSectionsFromSettings, isHexColor, TailParameters } from './workspace/shared';

import { type HeaderPanel } from "../layout/AppHeader";
import {
  type WorkspaceView
} from "../layout/WorkspaceRail";
import type { PreviewOverflowFinding } from "../preview/PreviewOverflowGuard";

import {
  defaultSectionOrder,
  fontFamilies,
  initialResume,
  moduleTitles
} from "../domain/resume-model";

import type { DraftSaveState } from "../../platform/useNativeResumePersistence";
import {
  readImportedTemplates,
  writeImportedTemplates
} from "../domain/imported-template";
import type {
  ConfirmAction,
  ModuleKey,
  ResumeLayout,
  ResumeState,
  SectionKey
} from "../domain/resume-model";
import {
  normalizePresentation, resolveDensitySpacing, resolvePresentation, TEMPLATE_SNAPSHOT_SCHEMA_VERSION,
  type KnownTemplateId, type ResumePresentation,
} from "../domain/template-model";
import type { ResumeVersionSnapshot } from "../domain/version-model";
import {
  type ResumeVersionBackup
} from "../services/version-backup";
import { templateRegistry, templateVersions } from "../templates/registry";
import { readStoredString } from "../utils/resume";


export default function App({ onDocumentTransition, documentTransitionBusy = false }: {
  onDocumentTransition?: DocumentTransition; documentTransitionBusy?: boolean;
} = {}) {
  const { notice, notify } = useNotice();
  const [nativeReady, setNativeReady] = useState(false);
  const [jobTailoringRequest, setJobTailoringRequest] = useState<JobTailoringSelection | null>(null);
  const [initialAutoFitEnabled, setInitialAutoFitEnabled] = useState(
    () => !isTauriRuntime(),
  );
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings>(
    readCachedWorkspaceSettings,
  );
  const [workspaceSettingsError, setWorkspaceSettingsError] = useState("");
  const pendingWorkspaceSettings = useRef(
    new Map<WorkspaceSettingKey, { value: WorkspaceSettings[WorkspaceSettingKey]; sequence: number }>(),
  );
  const workspaceSettingSequences = useRef(new Map<WorkspaceSettingKey, number>());
  const writeWorkspaceSettingAttempt = useCallback(
    async (
      key: WorkspaceSettingKey,
      value: WorkspaceSettings[WorkspaceSettingKey],
      sequence: number,
    ) => {
      try {
        await writeWorkspaceSetting(key, value as never);
        if (workspaceSettingSequences.current.get(key) !== sequence) return;
        pendingWorkspaceSettings.current.delete(key);
        if (pendingWorkspaceSettings.current.size === 0)
          setWorkspaceSettingsError("");
      } catch (error) {
        if (workspaceSettingSequences.current.get(key) !== sequence) return;
        const detail = error instanceof Error ? error.message : "未知错误";
        setWorkspaceSettingsError(`工作区偏好保存失败（${key}）：${detail}`);
      }
    },
    [],
  );
  const persistWorkspaceSetting = useCallback<WorkspaceSettingWrite>(
    (key, value) => {
      setWorkspaceSettings((current) => ({ ...current, [key]: value }));
      const sequence = (workspaceSettingSequences.current.get(key) ?? 0) + 1;
      workspaceSettingSequences.current.set(key, sequence);
      pendingWorkspaceSettings.current.set(key, {
        value: value as WorkspaceSettings[WorkspaceSettingKey],
        sequence,
      });
      void writeWorkspaceSettingAttempt(key, value as never, sequence);
    },
    [writeWorkspaceSettingAttempt],
  );
  const retryWorkspaceSettings = useCallback(() => {
    for (const [key, pending] of pendingWorkspaceSettings.current) {
      const sequence = (workspaceSettingSequences.current.get(key) ?? 0) + 1;
      workspaceSettingSequences.current.set(key, sequence);
      pendingWorkspaceSettings.current.set(key, { ...pending, sequence });
      void writeWorkspaceSettingAttempt(key, pending.value as never, sequence);
    }
  }, [writeWorkspaceSettingAttempt]);
  const persistPaneWidth = useCallback(
    (width: number) => persistWorkspaceSetting("editorPaneWidth", width),
    [persistWorkspaceSetting],
  );
  const persistPreviewZoom = useCallback(
    (percent: number) => persistWorkspaceSetting("previewZoomPercent", percent),
    [persistWorkspaceSetting],
  );
  const persistAgentLayout = useCallback(
    (
      key: "agentMode" | "agentPosition" | "agentSizes",
      value: WorkspaceSettings["agentMode"] | WorkspaceSettings["agentPosition"] | WorkspaceSettings["agentSizes"],
    ) => {
      persistWorkspaceSetting(key, value as never);
    },
    [persistWorkspaceSetting],
  );
  useEffect(() => {
    const stored = window.sessionStorage.getItem("zinecv.full-database-restore-notice");
    if (!stored) return;
    window.sessionStorage.removeItem("zinecv.full-database-restore-notice");
    try {
      const result = JSON.parse(stored) as DatabaseRestoreResult;
      notify(
        `完整数据库已恢复（schema ${result.schemaVersion}）。请重新登录本机账户。原数据库副本：${result.preRestoreBackupPath}。${result.unavailableSecretCount > 0 ? ` ${result.unavailableSecretCount} 个模型 Key 无法由${platformCapabilities().core === "wasm" ? "当前浏览器" : "当前 Windows 用户"}解密，请在连接设置中重新输入。` : "如模型 Key 无法解密，请在连接设置中重新输入。"}`,
      );
    } catch {
      notify("完整数据库已恢复，请重新登录本机账户；如模型 Key 无法解密，请在连接设置中重新输入。");
    }
  }, [notify]);
  const {
    workspaceRef, editorPaneWidth, paneBounds, isResizingPanes, beginPaneResize, handlePaneSplitterKeyDown,
    resetPaneWidth,
  } = usePaneResize({
    initialWidth: workspaceSettings.editorPaneWidth,
    persistenceEnabled: !isTauriRuntime() || nativeReady,
    onWidthChange: persistPaneWidth,
  });
  // 简历正文：优先恢复浏览器本地数据，没有存档时使用空白简历。
  const [resume, setResume] = useState<ResumeState>(() => {
    try {
      const saved = window.localStorage.getItem("resume-diy-state");
      if (!saved) return initialResume;
      const parsed = JSON.parse(saved) as Partial<ResumeState>;
      return migratePersonalSites(normalizeResumeState(parsed));
    } catch {
      return initialResume;
    }
  });
  const [richEditorResetKey, setRichEditorResetKey] = useState(0);
  const [presentation, setPresentation] = useState<ResumePresentation>(() => {
    try {
      const stored = window.localStorage.getItem("resume-diy-presentation-v1");
      return normalizePresentation(stored ? JSON.parse(stored) : undefined);
    } catch {
      return normalizePresentation(undefined);
    }
  });
  const [collapsedSections, setCollapsedSectionsState] = useState<
    Set<"basic" | SectionKey>
  >(() => collapsedSectionsFromSettings(workspaceSettings.collapsedSections));
  const collapsedSectionsRef = useRef(collapsedSections);
  const setCollapsedSectionsFromBootstrap = useCallback(
    (next: Set<"basic" | SectionKey>) => {
      collapsedSectionsRef.current = next;
      setCollapsedSectionsState(next);
    },
    [],
  );
  const updateCollapsedSections = useCallback(
    (update: (current: Set<"basic" | SectionKey>) => Set<"basic" | SectionKey>) => {
      const next = update(collapsedSectionsRef.current);
      if (next === collapsedSectionsRef.current) return;
      setCollapsedSectionsFromBootstrap(next);
      persistWorkspaceSetting("collapsedSections", [...next]);
    },
    [persistWorkspaceSetting, setCollapsedSectionsFromBootstrap],
  );
  const [summaryTitle, setSummaryTitle] = useState(() =>
    readStoredString("resume-diy-summary-title", "自我评价"),
  );
  const {
    font, setFont, fontSize, setFontSize, lineHeight, setLineHeight, moduleSpacing, setModuleSpacing,
    pageMargin, setPageMargin, theme, setTheme, smartFillEnabled, setSmartFillEnabled, dateFormat,
    setDateFormat, titleFormat, setTitleFormat, textAlign, setTextAlign, separator, setSeparator,
    formatAutoFitRevision, setFormatAutoFitRevision,
  } = useLayoutSettings();

  const [panel, setPanelState] = useState<HeaderPanel>(null);
  const panelAnchorRef = useRef<HTMLElement | null>(null);
  const setPanel = useCallback((next: HeaderPanel, anchor?: HTMLElement) => {
    if (next)
      panelAnchorRef.current =
        anchor ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
    setPanelState(next);
  }, []);

  // 模块结构：顺序、名称、拖拽和当前展开状态集中维护。
  const [moduleOrder, setModuleOrder] = useState<SectionKey[]>(() => {
    try {
      const current = window.localStorage.getItem(
        "resume-diy-section-order-v2",
      );
      if (current) return normalizeSectionOrder(JSON.parse(current));
      const saved = window.localStorage.getItem("resume-diy-modules");
      if (!saved) return defaultSectionOrder;
      const parsed = normalizeSectionOrder(JSON.parse(saved));
      return parsed.includes("summary") ? parsed : [...parsed, "summary"];
    } catch {
      return defaultSectionOrder;
    }
  });
  const [moduleNames, setModuleNames] = useState<Record<ModuleKey, string>>(
    () => {
      try {
        const saved = window.localStorage.getItem("resume-diy-module-names");
        const parsed = saved ? JSON.parse(saved) : {};
        return {
          ...moduleTitles,
          ...(parsed && typeof parsed === "object" ? parsed : {}),
        };
      } catch {
        return { ...moduleTitles };
      }
    },
  );
  const [editingModule, setEditingModule] = useState<ModuleKey | null>(null);
  const [editSummaryFromHeading, setEditSummaryFromHeading] = useState(false);
  const [localExportingFormat, setExportingFormat] = useState<"pdf" | "png" | null>(
    null,
  );
  const exportHost = useExportHost();
  const exportingFormat = exportHost?.format ?? localExportingFormat;
  // 更新器只在真实桌面运行时创建（浏览器预览与注册测试平台不出现入口）；
  // isExporting 经 ref 稳定化，避免导出状态每次变化都重建安装回调。
  const exportingFormatRef = useRef<"pdf" | "png" | null>(null);
  exportingFormatRef.current = exportingFormat;
  const prepareInstallRef = useRef<() => void>(() => { });
  const appUpdate = useAppUpdate({
    isExporting: useCallback(() => exportingFormatRef.current !== null, []),
    prepareWorkspace: useCallback(() => prepareInstallRef.current(), []),
    notify,
  });
  const updateController = isDesktopRuntime() ? appUpdate : null;
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const [databaseBackupOperation, setDatabaseBackupOperation] = useState<
    "exporting" | "restoring" | null
  >(null);
  const [saveState, setSaveState] = useState<DraftSaveState>({
    status: "saving",
    label: "正在载入本地文档…",
  });
  // 桌面引导完成前，持久化与版本钩子保持待命，避免把初始空白误写进数据库。
  const importedContextSwitching = useRef(false);
  const [previewOverflow, setPreviewOverflow] =
    useState<PreviewOverflowFinding | null>(null);
  const [resumeTitle, setResumeTitle] = useState(() =>
    readStoredString("resume-diy-title", "resume DIY"),
  );
  const [workspaceView, setWorkspaceViewState] = useState<WorkspaceView>(
    workspaceSettings.workspaceView,
  );
  const setWorkspaceView = useCallback(
    (next: WorkspaceView) => {
      setWorkspaceViewState(next);
      persistWorkspaceSetting("workspaceView", next);
    },
    [persistWorkspaceSetting],
  );
  const {
    activeImportedTemplateId, setActiveImportedTemplateId, activeImportedTemplateRevisionHash,
    setActiveImportedTemplateRevisionHash, importedTemplateCatalog, setImportedTemplateCatalog, sourcePreview,
    setSourcePreview, activeImportedTemplateName, setActiveImportedTemplateName, importedTemplateNames,
    setImportedTemplateNames,
  } = useImportedTemplates();

  const [editorNavigationTarget, setEditorNavigationTarget] =
    useState<EditorNavigationTarget | null>(null);
  const [activeEditorSection, setActiveEditorSection] = useState<
    "basic" | SectionKey
  >("basic");
  const editorScrollRef = useRef<HTMLDivElement | null>(null);
  const [titleEditing, setTitleEditing] = useState(false);
  const resolvedPresentation = useMemo(
    () => resolvePresentation(presentation, templateVersions),
    [presentation],
  );
  const activeTemplate =
    templateRegistry[resolvedPresentation.resolvedTemplateId];
  const presentationOverrides = resolvedPresentation.fallbackReason
    ? {}
    : resolvedPresentation.stored.overrides;
  const templateValue = (
    key: "headingFontSize" | "paragraphSpacing" | "listSpacing",
  ) => String(presentationOverrides[key] ?? resolveDensitySpacing(
    resolvedPresentation.resolvedTemplateId,
    resolvedPresentation.fallbackReason
      ? activeTemplate.defaultDensity
      : resolvedPresentation.stored.densityPreset,
  )[key]);
  const templateHeadingFontSize = templateValue("headingFontSize");
  const templateParagraphSpacing = templateValue("paragraphSpacing");
  const templateListSpacing = templateValue("listSpacing");
  const templateVariant =
    presentationOverrides.importedLayout === "side-band"
      ? "side-band"
      : undefined;
  const templateSideBandBackground = isHexColor(
    presentationOverrides.importedSideBandBackground,
  )
    ? presentationOverrides.importedSideBandBackground
    : undefined;
  const templateSideBandForeground = isHexColor(
    presentationOverrides.importedSideBandForeground,
  )
    ? presentationOverrides.importedSideBandForeground
    : undefined;
  const engineFitClient = useMemo(() => new EngineFitClient(nativeInvoke), []);
  const engineFitOriginalRef = useRef<{ presentation: Presentation; contentKey: string } | null>(null);
  const cancelOnePagePlan = useCallback(() => engineFitClient.cancel(), [engineFitClient]);
  const planOnePage = (...args: TailParameters<typeof runPlanOnePage>) => runPlanOnePage({ engineFitOriginalRef, setPresentation, applyLayoutSnapshot, engineFitClient }, ...args);
  // 最新来源预览内容签名；智能一页完成回调以它吸收 fit 产生的版式变化。
  const sourcePreviewSignatureRef = useRef<string | null>(null);
  const {
    previewPages, visibleLineHeight, visibleModuleSpacing, paginationMeasureRef, measurementLineHeight,
    measurementModuleGap, pagePadding, pageLetterSpacing, layoutBaseModuleGap, fitOnePage, autoFitOnePage,
    smartFitRequested, smartFitActive, smartFitPulse, applyManualLayoutChange, stopPendingFit,
  } = useResumePagination({
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
    layoutContextKey: `${resolvedPresentation.resolvedTemplateId}@${activeTemplate.version}:${templateVariant ?? "default"}:${resolvedPresentation.stored.densityPreset}:${templateHeadingFontSize}:${templateParagraphSpacing}:${templateListSpacing}`,
    smartFillEnabled,
    setFontSize,
    setLineHeight,
    setModuleSpacing,
    setPageMargin,
    setSmartFillEnabled,
    initialAutoFitEnabled,
    notify,
    planOnePage: nativeReady && isTauriRuntime() ? planOnePage : undefined,
    cancelOnePagePlan,
    onSmartFitComplete: () =>
      setSourcePreview((current) =>
        current
          ? { ...current, baseline: sourcePreviewSignatureRef.current }
          : current,
      ),
  });
  const makeLayout = (...args: TailParameters<typeof runMakeLayout>) => runMakeLayout({ font, fontSize, pageMargin, theme, dateFormat, titleFormat, separator, textAlign }, ...args);

  const workingSnapshot = useMemo<ResumeVersionSnapshot>(
    () => ({
      schemaVersion: TEMPLATE_SNAPSHOT_SCHEMA_VERSION,
      presentation,
      resume,
      moduleOrder,
      moduleNames,
      summaryTitle,
      resumeTitle,
      layout: makeLayout(
        String(visibleLineHeight),
        String(visibleModuleSpacing),
      ),
      importedTemplate: activeImportedTemplateId
        ? {
          id: activeImportedTemplateId,
          name: activeImportedTemplateName,
          ...(activeImportedTemplateRevisionHash
            ? { revisionHash: activeImportedTemplateRevisionHash }
            : {}),
        }
        : null,
    }),
    [
      resume,
      presentation,
      moduleOrder,
      moduleNames,
      summaryTitle,
      resumeTitle,
      font,
      fontSize,
      visibleLineHeight,
      visibleModuleSpacing,
      pageMargin,
      theme,
      dateFormat,
      titleFormat,
      separator,
      textAlign,
      activeImportedTemplateId,
      activeImportedTemplateName,
      activeImportedTemplateRevisionHash,
    ],
  );
  // 桌面持久化：同一输入语义，写入走 Rust 命令队列；引导完成前不产生命令。
  const { retryDraft } = useNativeResumePersistence({
    workingSnapshot,
    setSaveState,
    enabled: nativeReady,
  });

  useEffect(() => {
    const closePanels = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (
        !target?.closest(".floating-panel, .floating-menu") &&
        !target?.closest(".topbar button, .topbar input")
      )
        setPanel(null);
    };
    document.addEventListener("pointerdown", closePanels);
    return () => document.removeEventListener("pointerdown", closePanels);
  }, [setPanel]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPanel(null);
        setEditingModule(null);
        setEditSummaryFromHeading(false);
        setTitleEditing(false);
        setConfirmAction(null);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [setPanel]);

  const requestConfirmation = useCallback((action: ConfirmAction) => {
    setPanel(null);
    setConfirmAction(action);
  }, [setPanel]);

  const confirmCurrentAction = () => {
    if (!confirmAction) return;
    const action = confirmAction;
    setConfirmAction(null);
    action.onConfirm();
  };

  const applyLayoutSnapshot = (layout: ResumeLayout) => {
    setFont(layout.font);
    setFontSize(layout.fontSize);
    setLineHeight(layout.lineHeight);
    setModuleSpacing(layout.moduleSpacing);
    setPageMargin(layout.pageMargin);
    setTheme(layout.theme);
    setDateFormat(layout.dateFormat);
    setTitleFormat(layout.titleFormat);
    setSeparator(layout.separator);
    setTextAlign(layout.textAlign);
  };

  // 恢复版本会同时恢复正文、模块顺序、简历名称和全部排版参数。
  const applyVersionSnapshot = (...args: TailParameters<typeof runApplyVersionSnapshot>) => runApplyVersionSnapshot({
    setRichEditorResetKey, setResume, setModuleOrder, setModuleNames, setSummaryTitle, setResumeTitle,
    setPresentation, applyLayoutSnapshot, setActiveImportedTemplateId, setActiveImportedTemplateRevisionHash,
    setActiveImportedTemplateName, notify, setSmartFillEnabled, stopPendingFit,
  }, ...args);

  const prepareImportTarget = async () => {
    if (!nativeReady || !isTauriRuntime())
      throw new Error("导入审阅仅在桌面原生工作区中可用");
    await flushDraftBeforeVersionAction();
    return captureDocumentHostTarget();
  };

  const applyImportDraft = (...args: TailParameters<typeof runApplyImportDraft>) => runApplyImportDraft({ nativeReady, applyVersionSnapshot, selectWorkspace, notify }, ...args);

  const {
    versionStore, storageStatus, storageBusy, hasUncommittedChanges, commitVersion, createBranch,
    replaceVersionStore, refreshAfterLegacyMigration, switchBranch, loadCommit, jumpToBranch, deleteCommit,
    deleteBranch,
  } = useNativeResumeVersions({
    workingSnapshot,
    notify,
    requestConfirmation,
    applyVersionSnapshot,
    enabled: nativeReady,
  });

  // 桌面启动引导：从 SQLite 载入权威文档，经 applyVersionSnapshot 恢复整个工作区。
  const { retry: retryNativeBootstrap } = useNativeBootstrap({
    applyVersionSnapshot,
    onWorkspaceSettingsLoaded: (settings) => {
      setWorkspaceSettings(settings);
      setWorkspaceViewState(settings.workspaceView);
      setCollapsedSectionsFromBootstrap(
        collapsedSectionsFromSettings(settings.collapsedSections),
      );
    },
    onTemplatesLoaded: (templates) => {
      setImportedTemplateCatalog(templates);
      setImportedTemplateNames(
        Object.fromEntries(templates.map((template) => [template.id, template.name])),
      );
    },
    setSaveState,
    onReady: () => {
      const state = nativeClient.snapshot;
      setInitialAutoFitEnabled(
        state?.cursor.revision === "0" &&
        state.cursor.contextId === "workspace-default-context",
      );
      setNativeReady(true);
    },
  });

  const applyTemplateDefaults = (templateId: KnownTemplateId) => {
    const defaults = templateRegistry[templateId].defaults;
    applyLayoutSnapshot(defaults);
    setSmartFillEnabled(false);
    stopPendingFit();
  };

  const applyFormatPreset = (...args: TailParameters<typeof runApplyFormatPreset>) => runApplyFormatPreset({ setPresentation, applyTemplateDefaults, setTheme, setFormatAutoFitRevision }, ...args);

  const applyImportedTemplate = (...args: TailParameters<typeof runApplyImportedTemplate>) => runApplyImportedTemplate({
    nativeReady, importedContextSwitching, setRichEditorResetKey, applyVersionSnapshot,
    setActiveImportedTemplateRevisionHash, setActiveImportedTemplateName, setImportedTemplateNames,
    setSourcePreview, notify, setPresentation, setFormatAutoFitRevision, applyFormatPreset, stopPendingFit,
    applyLayoutSnapshot, setResume, setModuleOrder, setModuleNames, setSummaryTitle, setFont,
    setActiveImportedTemplateId,
  }, ...args);

  const renameImportedTemplate = (templateId: string, name: string) => {
    setImportedTemplateNames((current) => ({ ...current, [templateId]: name }));
    if (activeImportedTemplateId === templateId)
      setActiveImportedTemplateName(name);
  };

  // 源预览失效签名缓存：缓存键为下方 useMemo 依赖元组（resume + 全部外观排版
  // 参数 + moduleOrder/moduleNames/summaryTitle + sourcePreviewActive 门控），
  // 任一输入变化才重新全量 stringify。sourcePreview 激活期间仅因 baseline 回写
  // 或关闭重开而更换对象引用，不经过 sourcePreviewActive（模板间切换同样只换
  // 引用），因此不会触发重复序列化；关闭（null）时返回 null，零序列化开销。
  const sourcePreviewActive = sourcePreview !== null;
  const sourcePreviewContentSignature = useMemo(() => {
    if (!sourcePreviewActive) return null;
    return importedContentSignature(
      resume,
      moduleOrder,
      moduleNames,
      summaryTitle,
      {
        presentation, font, fontSize, lineHeight, moduleSpacing, pageMargin, theme, dateFormat, titleFormat,
        separator, textAlign,
      },
    );
  }, [
    dateFormat,
    font,
    fontSize,
    lineHeight,
    moduleNames,
    moduleOrder,
    moduleSpacing,
    pageMargin,
    presentation,
    resume,
    separator,
    sourcePreviewActive,
    summaryTitle,
    textAlign,
    theme,
    titleFormat,
  ]);
  sourcePreviewSignatureRef.current = sourcePreviewContentSignature;

  useEffect(() => {
    if (!sourcePreview || sourcePreviewContentSignature === null) return;
    if (smartFitRequested) return; // 智能一页进行中：版式变化随 fit 完成整体吸收。
    if (sourcePreview.baseline === null) {
      setSourcePreview((current) =>
        current?.templateId === sourcePreview.templateId
          ? { ...current, baseline: sourcePreviewContentSignature }
          : current,
      );
      return;
    }
    if (sourcePreview.baseline === sourcePreviewContentSignature) return;
    try {
      window.localStorage.setItem(
        sourcePreviewDismissalKey(sourcePreview.templateId),
        "true",
      );
    } catch {
      // Dismissal remains effective for this session if browser storage is full.
    }
    setSourcePreview(null);
  }, [sourcePreview, sourcePreviewContentSignature, smartFitRequested, setSourcePreview]);

  useEffect(() => {
    if (!nativeReady || !activeImportedTemplateId) return;
    const timer = window.setTimeout(() => {
      const templates = readImportedTemplates();
      const index = templates.findIndex(
        (template) => template.id === activeImportedTemplateId,
      );
      if (index < 0) return;
      const next = [...templates];
      next[index] = {
        ...next[index],
        resume,
        moduleOrder,
        moduleNames,
        summaryTitle,
        detectedFont: font,
        presentation,
        resumeLayout: makeLayout(lineHeight, moduleSpacing),
      };
      void writeImportedTemplates(next).catch(() => {
        notify("导入模板同步保存失败，请检查本地数据库。");
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    activeImportedTemplateId,
    nativeReady,
    font,
    moduleNames,
    moduleOrder,
    resume,
    summaryTitle,
    presentation,
    fontSize,
    lineHeight,
    moduleSpacing,
    pageMargin,
    theme,
    dateFormat,
    titleFormat,
    separator,
    textAlign,
    notify,
  ]);

  // 模板选择的延迟适配只应由 formatAutoFitRevision 触发一次；autoFitOnePage
  // 的函数身份随每次渲染变化，直接放进依赖会让定时器被无关渲染反复重置，
  // 使 fit 推迟到 saved 之后才落盘（导出期间多出一个 revision）。
  const autoFitOnePageRef = useRef(autoFitOnePage);
  autoFitOnePageRef.current = autoFitOnePage;
  useEffect(() => {
    if (!formatAutoFitRevision) return;
    const timer = window.setTimeout(
      () => autoFitOnePageRef.current("template-change"),
      180,
    );
    return () => window.clearTimeout(timer);
  }, [formatAutoFitRevision]);

  const selectWorkspace = (next: WorkspaceView) => {
    setPanel(null);
    setTitleEditing(false);
    setWorkspaceView(next);
  };
  const {
    openEntries, setOpenEntries, setDraggingModule, updateBasic, updateAvatar, updateEntry, addEntry,
    removeEntry, showSection, hideSection, moveSection, reorderModule, commitModuleOrder, toggleEntry,
  } = useResumeEditing({
    resume, setResume, setModuleOrder, moduleNames, notify, requestConfirmation, setPanel, setEditingModule,
  });
  const toggleOpenSection = useCallback((section: "basic" | SectionKey) => {
    updateCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, [updateCollapsedSections]);
  const expandSection = useCallback((section: "basic" | SectionKey) => {
    updateCollapsedSections((current) => {
      if (!current.has(section)) return current;
      const next = new Set(current);
      next.delete(section);
      return next;
    });
  }, [updateCollapsedSections]);
  const navigateToEditor = useCallback(
    (...args: TailParameters<typeof runNavigateToEditor>) => runNavigateToEditor({
      setPanel, setEditingModule, setEditSummaryFromHeading, setTitleEditing, setWorkspaceView, expandSection,
      setActiveEditorSection, setOpenEntries, resume, setEditorNavigationTarget,
    }, ...args),
    [expandSection, resume, setOpenEntries, setPanel],
  );
  const applyAgentEdit = useCallback(
    (...args: TailParameters<typeof runApplyAgentEdit>) => runApplyAgentEdit({ resume, updateBasic, navigateToEditor, setResume, updateEntry }, ...args),
    [navigateToEditor, resume, setResume, updateBasic, updateEntry],
  );
  const undoAgentEdit = useCallback(
    (...args: TailParameters<typeof runUndoAgentEdit>) => runUndoAgentEdit({ resume, setResume }, ...args),
    [resume, setResume],
  );
  const navigateToAgentReference = useCallback(
    (...args: TailParameters<typeof runNavigateToAgentReference>) => runNavigateToAgentReference({ setPanel, setWorkspaceView, navigateToEditor }, ...args),
    [navigateToEditor, setPanel],
  );
  const clearEditorNavigation = useCallback(
    () => setEditorNavigationTarget(null),
    [],
  );
  useEditorNavigation({
    active: workspaceView === "editor",
    target: editorNavigationTarget,
    editorScrollRef,
    onSettled: clearEditorNavigation,
  });
  const copyResume = (...args: TailParameters<typeof runCopyResume>) => runCopyResume({ resume, moduleOrder, moduleNames, summaryTitle, notify }, ...args);

  const exportFileName =
    resumeTitle.trim().replace(/[\\/:*?"<>|]/g, "-") || "resume";

  const exportVersionBackup = (...args: TailParameters<typeof runExportVersionBackup>) => runExportVersionBackup({ versionStore, hasUncommittedChanges, workingSnapshot, notify, exportFileName }, ...args);

  const exportFullDatabaseBackup = (...args: TailParameters<typeof runExportFullDatabaseBackup>) => runExportFullDatabaseBackup({ databaseBackupOperation, notify, setDatabaseBackupOperation, exportFileName }, ...args);

  const requestFullDatabaseRestore = (...args: TailParameters<typeof runRequestFullDatabaseRestore>) => runRequestFullDatabaseRestore({ notify, requestConfirmation, databaseBackupOperation, setDatabaseBackupOperation }, ...args);

  const requestVersionImport = (backup: ResumeVersionBackup) => {
    requestConfirmation({
      title: "替换当前版本库？",
      description: `将以备份中的 ${backup.store.branches.length} 个分支和 ${backup.store.commits.length} 次提交替换当前版本库。当前工作内容不会自动变更，草稿也不会自动载入。替换前会保留现有版本备份。`,
      confirmLabel: "确认替换版本库",
      onConfirm: () => {
        void replaceVersionStore(backup.store);
      },
    });
  };

  const loadImportedDraft = (snapshot: ResumeVersionSnapshot) => {
    void (async () => {
      await flushDraftBeforeVersionAction();
      applyVersionSnapshot(snapshot);
      notify("备份中的未提交草稿已载入工作区");
    })().catch((error) => {
      notify(error instanceof Error ? error.message : "当前草稿未能保存，未载入备份草稿");
    });
  };

  // B10：旧版数据导入（浏览器导出包 / 项目 versions.json），经既有命令/事务通道。
  const importLegacyBrowserData = (...args: TailParameters<typeof runImportLegacyBrowserData>) => runImportLegacyBrowserData({ setPanel, requestConfirmation, refreshAfterLegacyMigration, notify }, ...args);

  const previewOverflowMessage = previewOverflow
    ? (() => {
      const label =
        previewOverflow.blockKey === "header"
          ? "基本信息"
          : previewOverflow.blockKey === "summary"
            ? summaryTitle || "自我评价"
            : moduleNames[previewOverflow.blockKey];
      return `第 ${previewOverflow.pageIndex + 1} 页的“${label}”有内容超出 A4 可用区域，导出已暂停。请编辑内容后再试；当前不会自动收缩或修改页距。`;
    })()
    : null;

  const downloadResume = (...args: TailParameters<typeof runDownloadResume>) => runDownloadResume({
    exportingFormat, previewOverflow, notify, previewOverflowMessage, setPanel, setExportingFormat, exportHost,
    branchName: versionStore.branches.find(branch => branch.id === versionStore.currentBranchId)?.name,
    navigateToEditor,
    exportFileName,
  }, ...args);

  const resetResume = (...args: TailParameters<typeof runResetResume>) => runResetResume({
    requestConfirmation, setResume, setModuleOrder, setModuleNames, setOpenEntries, setResumeTitle,
    setSummaryTitle, notify,
  }, ...args);

  const smartSort = (...args: TailParameters<typeof runSmartSort>) => runSmartSort({ setResume, notify }, ...args);

  const bundledBrowserFonts = platformCapabilities().core === "wasm";
  const editorFontFamily = bundledBrowserFonts ? fontFamilies["宋体"] : (fontFamilies[font] ?? font);
  const allPreviewBlocks = useMemo(
    () => getPreviewBlocks(moduleOrder, resume),
    [moduleOrder, resume],
  );
  prepareInstallRef.current = () => {
    if (storageBusy || databaseBackupOperation || importedContextSwitching.current) {
      throw new Error("工作区仍有保存或切换操作，请完成后再安装更新。");
    }
    stopPendingFit();
    cancelOnePagePlan();
  };

  if (isTauriRuntime() && !nativeReady) {
    const failed = saveState.status === "failed";
    return (
      <main className="native-bootstrap-screen" role={failed ? "alert" : "status"}>
        <p>{saveState.label}</p>
        {failed ? (
          <button type="button" onClick={retryNativeBootstrap}>
            重试载入
          </button>
        ) : null}
      </main>
    );
  }

  return renderWorkspace({
    jobTailoringRequest,
    onRequestJobTailoring: selection => { setJobTailoringRequest(selection); setWorkspaceView("editor"); },
    documentTransitionBusy,
    onDocumentTransition: onDocumentTransition ? async action => {
      if (storageBusy || databaseBackupOperation || importedContextSwitching.current) {
        throw new Error("工作区仍有保存或切换操作，请完成后再切换简历");
      }
      stopPendingFit();
      cancelOnePagePlan();
      await onDocumentTransition(action);
    } : undefined,
    appUpdate, bundledBrowserFonts, theme, editorFontFamily, workspaceSettingsError, retryWorkspaceSettings,
    panel, setPanel, resumeTitle, titleEditing, saveState, retryDraft, requestConfirmation, smartFitActive,
    smartFitPulse, panelAnchorRef, exportingFormat, updateController, makeLayout, visibleLineHeight,
    visibleModuleSpacing, moduleOrder, moduleNames, summaryTitle, editingModule, editSummaryFromHeading,
    setEditingModule, setSummaryTitle, setModuleNames, showSection, hideSection, moveSection, setDraggingModule,
    reorderModule, setResumeTitle, setTitleEditing, fitOnePage, setFont, setTheme, setDateFormat, dateFormat,
    setTitleFormat, titleFormat, setSeparator, setTextAlign, textAlign, applyManualLayoutChange, setFontSize,
    setLineHeight, setModuleSpacing, setPageMargin, smartSort, setEditSummaryFromHeading, downloadResume,
    copyResume, resetResume, workspaceRef, isResizingPanes, workspaceView, selectWorkspace, editorPaneWidth,
    versionStore, importedTemplateNames, storageStatus, storageBusy, hasUncommittedChanges, exportVersionBackup,
    exportFullDatabaseBackup, requestFullDatabaseRestore, requestVersionImport, loadImportedDraft,
    commitVersion, createBranch, switchBranch, loadCommit, deleteCommit, jumpToBranch, deleteBranch,
    importLegacyBrowserData, importedTemplateCatalog, resolvedPresentation, previewPages,
    activeImportedTemplateId, applyImportedTemplate, prepareImportTarget, applyImportDraft,
    setImportedTemplateCatalog, renameImportedTemplate, resume, richEditorResetKey, activeEditorSection,
    collapsedSections, expandSection, toggleOpenSection, openEntries, updateBasic, updateAvatar,
    commitModuleOrder, setResume, toggleEntry, updateEntry, removeEntry, addEntry, editorScrollRef,
    previewOverflowMessage, navigateToEditor, paneBounds, beginPaneResize, handlePaneSplitterKeyDown,
    resetPaneWidth, templateVariant, templateSideBandBackground, templateSideBandForeground,
    templateHeadingFontSize, templateParagraphSpacing, templateListSpacing, paginationMeasureRef,
    allPreviewBlocks, separator, fontSize, measurementLineHeight, pageLetterSpacing, pagePadding,
    measurementModuleGap, layoutBaseModuleGap, workspaceSettings, persistPreviewZoom, setPreviewOverflow,
    sourcePreview, workingSnapshot, persistAgentLayout, applyAgentEdit, undoAgentEdit, navigateToAgentReference,
    applyVersionSnapshot, databaseBackupOperation, confirmAction, setConfirmAction, confirmCurrentAction,
    notice,
  });
}
