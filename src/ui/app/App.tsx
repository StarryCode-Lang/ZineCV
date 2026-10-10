import { platformCapabilities } from "../../platform/capability";
import { useResumeEditing } from "./useResumeEditing";
import { getPreviewBlocks } from "../services/resume-pagination";
import { ResumeEditor } from "../editor/ResumeEditor";
import { useNativeResumeVersions } from "../../platform/useNativeResumeVersions";
import { materializeVersionStore } from "../../platform/versionDetails";
import {
  commitPreparedLegacyMigration,
  legacyMigrationNamespace,
  parseLegacyDataFile,
  prepareLegacyMigration,
} from "../../platform/legacyImport";
import {
  flushDraftBeforeVersionAction,
  runDraftAuthorityAction,
  nativeClient,
  snapshotFromLoadedDocument,
} from "../../platform/workspace";
import { sameCursor } from "../../platform/NativeDocumentClient";
import { hasDocumentRuntime as isTauriRuntime, nativeInvoke, NativeIpcError } from "../../platform/ipc";
import type { DatabaseBackupPayload } from "../../../src-tauri/src/domain/bindings/DatabaseBackupPayload";
import type { DatabaseRestoreResult } from "../../../src-tauri/src/domain/bindings/DatabaseRestoreResult";
import type { ExportData } from "../../../src-tauri/src/domain/bindings/ExportData";
import type { Presentation } from "../../../src-tauri/src/domain/bindings/Presentation";
import { useNativeResumePersistence } from "../../platform/useNativeResumePersistence";
import { useNativeBootstrap } from "../../platform/useNativeBootstrap";
import {
  readCachedWorkspaceSettings,
  writeWorkspaceSetting,
  type WorkspaceSettingKey,
  type WorkspaceSettingWrite,
  type WorkspaceSettings,
} from "../../platform/settings";
import { flushAgentSessionWrites } from "../agent/sessions";
import { useResumePagination } from "./useResumePagination";
import { EngineFitClient } from "../../preview/engineFit";
import { useNotice } from "./useNotice";
import {
  useEditorNavigation,
  type EditorNavigationTarget,
} from "./useEditorNavigation";
import { usePaneResize } from "./usePaneResize";
import { useLayoutSettings } from "./useLayoutSettings";
import {
  useImportedTemplates,
  importedContentSignature,
  sourcePreviewDismissalKey,
} from "./useImportedTemplates";
import {
  migratePersonalSites,
  normalizeResumeState,
  normalizeSectionOrder,
} from "../domain/resume-normalization";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties } from "react";
import "../styles/index.css";

import { ConfirmDialog } from "../overlays/ConfirmDialog";
import { AppHeader, type HeaderPanel } from "../layout/AppHeader";
import {
  WorkspaceRail,
  type WorkspaceView,
} from "../layout/WorkspaceRail";
import { ResumePreviewPane } from "../preview/ResumePreviewPane";
import { ImportedSourcePreviewOverlay } from "../preview/ImportedSourcePreviewOverlay";
import type { PreviewOverflowFinding } from "../preview/PreviewOverflowGuard";

import {
  defaultSectionOrder,
  emptyResume,
  fontFamilies,
  initialResume,
  moduleTitles,
} from "../domain/resume-model";

import { buildResumePlainText } from "../services/resume-copy";
import type { ImportTarget } from "../services/import-draft";
import {
  createVersionBackup,
  type ResumeVersionBackup,
} from "../services/version-backup";
import type {
  ConfirmAction,
  Entry,
  ModuleKey,
  ResumeState,
  ResumeLayout,
  SectionKey,
  SeparatorMode,
} from "../domain/resume-model";
import type { DraftSaveState } from "../../platform/useNativeResumePersistence";
import type { ResumeVersionSnapshot } from "../domain/version-model";
import type {
  AgentEditPatch,
  AgentEditTarget,
  AgentReference,
} from "../agent/types";
import {
  readImportedTemplates,
  writeImportedTemplates,
  type ImportedTemplate,
} from "../domain/imported-template";
import {
  TEMPLATE_SNAPSHOT_SCHEMA_VERSION,
  normalizePresentation,
  resolveDensitySpacing,
  resolvePresentation,
  type KnownTemplateId,
  type ResumePresentation,
} from "../domain/template-model";
import { templateRegistry, templateVersions } from "../templates/registry";
import { readStoredString } from "../utils/resume";

import { AgentOverlay } from "../agent/AgentOverlay";
const TemplateWorkspace = lazy(() =>
  import("../templates/TemplateWorkspace").then((module) => ({
    default: module.TemplateWorkspace,
  })),
);
const VersionControlPanel = lazy(() =>
  import("../versioning/VersionControlPanel").then((module) => ({
    default: module.VersionControlPanel,
  })),
);
const workspaceLoading = (
  <div role="status" className="workspace-loading">
    正在载入工作区…
  </div>
);

function collapsedSectionsFromSettings(
  values: string[],
): Set<"basic" | SectionKey> {
  return new Set(
    values.filter(
      (value): value is "basic" | SectionKey =>
        value === "basic" || value === "summary" || value in moduleTitles,
    ),
  );
}

const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[\da-fA-F]{6}$/.test(value);

function downloadJsonBlob(fileName: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function App() {
  const { notice, notify } = useNotice();
  const [nativeReady, setNativeReady] = useState(false);
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
      if (key === "agentMode")
        persistWorkspaceSetting("agentMode", value as WorkspaceSettings["agentMode"]);
      else if (key === "agentPosition")
        persistWorkspaceSetting("agentPosition", value as WorkspaceSettings["agentPosition"]);
      else persistWorkspaceSetting("agentSizes", value as WorkspaceSettings["agentSizes"]);
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
    workspaceRef,
    editorPaneWidth,
    paneBounds,
    isResizingPanes,
    beginPaneResize,
    handlePaneSplitterKeyDown,
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
    font,
    setFont,
    fontSize,
    setFontSize,
    lineHeight,
    setLineHeight,
    moduleSpacing,
    setModuleSpacing,
    pageMargin,
    setPageMargin,
    theme,
    setTheme,
    smartFillEnabled,
    setSmartFillEnabled,
    dateFormat,
    setDateFormat,
    titleFormat,
    setTitleFormat,
    textAlign,
    setTextAlign,
    separator,
    setSeparator,
    formatAutoFitRevision,
    setFormatAutoFitRevision,
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
  const [exportingFormat, setExportingFormat] = useState<"pdf" | "png" | null>(
    null,
  );
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
    activeImportedTemplateId,
    setActiveImportedTemplateId,
    activeImportedTemplateRevisionHash,
    setActiveImportedTemplateRevisionHash,
    importedTemplateCatalog,
    setImportedTemplateCatalog,
    sourcePreview,
    setSourcePreview,
    activeImportedTemplateName,
    setActiveImportedTemplateName,
    importedTemplateNames,
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
  const planOnePage = async (isCancelled: () => boolean, finalizing = false): Promise<boolean> => {
    await flushDraftBeforeVersionAction();
    if (isCancelled()) return false;
    const frozen = nativeClient.snapshot;
    if (!frozen) throw new Error("本地文档尚未载入");
    const contentKey = (state: typeof frozen) => JSON.stringify([
      state.cursor.documentId, state.cursor.contextId, state.cursor.branchId, state.cursor.headId,
      state.document.title, state.document.basic, state.document.sections, state.document.sourceRef,
    ]);
    if (!finalizing) engineFitOriginalRef.current = {
      presentation: structuredClone(frozen.document.presentation), contentKey: contentKey(frozen),
    };
    const restoreLayout = async () => {
      const original = engineFitOriginalRef.current;
      await flushDraftBeforeVersionAction();
      await runDraftAuthorityAction(async () => {
        const current = nativeClient.snapshot;
        if (!original || !current || isCancelled() || contentKey(current) !== original.contentKey) return;
        const restored = await nativeClient.submit({ type: "setLayout", presentation: original.presentation });
        const snapshot = await snapshotFromLoadedDocument(restored.document);
        if (isCancelled()) return;
        setPresentation(normalizePresentation(snapshot.presentation));
        applyLayoutSnapshot(snapshot.layout);
      });
    };
    try {
      const proposal = await engineFitClient.request(frozen.cursor);
      if (!proposal || isCancelled()) return false;
      await flushDraftBeforeVersionAction();
      const current = nativeClient.snapshot;
      if (!current || isCancelled() || !sameCursor(current.cursor, frozen.cursor)) return false;
      if (proposal.plan.status === "alreadyFits") {
        if (finalizing) engineFitOriginalRef.current = null;
        return true;
      }
      if (proposal.plan.status !== "fitted") {
        if (finalizing) await restoreLayout();
        return false;
      }
      const result = await engineFitClient.apply(proposal, current.cursor);
      if (!result) return false;
      const loaded = await nativeClient.reload();
      if (!sameCursor(loaded.cursor, result.cursor)) return false;
      const snapshot = await snapshotFromLoadedDocument(result.document);
      if (isCancelled() || !sameCursor(nativeClient.snapshot!.cursor, result.cursor)) return false;
      setPresentation(normalizePresentation(snapshot.presentation));
      applyLayoutSnapshot(snapshot.layout);
      if (finalizing) engineFitOriginalRef.current = null;
      return true;
    } catch (error) {
      if (finalizing && !isCancelled()) await restoreLayout();
      engineFitOriginalRef.current = null;
      throw error;
    }
  };
  const {
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
    autoFitOnePage,
    smartFitActive,
    smartFitPulse,
    applyManualLayoutChange,
    stopPendingFit,
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
  });
  const makeLayout = (
    lineHeight: string,
    moduleSpacing: string,
  ): ResumeLayout => ({
    font,
    fontSize,
    lineHeight,
    moduleSpacing,
    pageMargin,
    theme,
    dateFormat,
    titleFormat,
    separator,
    textAlign,
  });

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

  const requestConfirmation = (action: ConfirmAction) => {
    setPanel(null);
    setConfirmAction(action);
  };

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
  const applyVersionSnapshot = (snapshot: ResumeVersionSnapshot) => {
    setRichEditorResetKey((current) => current + 1);
    setResume(migratePersonalSites(normalizeResumeState(snapshot.resume)));
    setModuleOrder(normalizeSectionOrder(snapshot.moduleOrder));
    setModuleNames({ ...moduleTitles, ...snapshot.moduleNames });
    setSummaryTitle(snapshot.summaryTitle || "自我评价");
    setResumeTitle(snapshot.resumeTitle || "resume DIY");
    setPresentation(normalizePresentation(snapshot.presentation));
    applyLayoutSnapshot(snapshot.layout);
    const imported = snapshot.importedTemplate ?? null;
    setActiveImportedTemplateId(imported?.id ?? null);
    setActiveImportedTemplateRevisionHash(imported?.revisionHash ?? null);
    setActiveImportedTemplateName(
      readImportedTemplates().find((item) => item.id === imported?.id)?.name ??
        imported?.name ??
        "",
    );
    try {
      if (imported)
        window.localStorage.setItem(
          "resume-diy-active-imported-template",
          imported.id,
        );
      else window.localStorage.removeItem("resume-diy-active-imported-template");
    } catch {
      // SQLite owns the active source; localStorage is only a legacy browser cache.
    }
    if (imported?.revisionHash) {
      const template = readImportedTemplates().find((item) => item.id === imported.id);
      const revision = template?.knownRevisions?.find(
        (item) => item.revisionHash === imported.revisionHash,
      );
      if (!revision) {
        notify("历史模板修订清单不可用；已保留快照版式与元数据，将使用当前渲染器回退。");
      } else if (revision.rendererStatus === "fallback") {
        notify("历史模板使用当前渲染器回退；已保留快照版式与修订元数据。");
      }
    }
    setSmartFillEnabled(false);
    stopPendingFit();
  };

  const prepareImportTarget = async () => {
    if (!nativeReady || !isTauriRuntime())
      throw new Error("导入审阅仅在桌面原生工作区中可用");
    await flushDraftBeforeVersionAction();
    const state = nativeClient.snapshot;
    if (!state) throw new Error("本地文档尚未载入");
    return {
      cursor: structuredClone(state.cursor),
      sessionEpoch: nativeClient.currentSessionEpoch,
    };
  };

  const applyImportDraft = async (
    draftId: string,
    acceptedCandidateIds: string[],
    target: ImportTarget,
  ): Promise<void> => {
    if (!nativeReady || !isTauriRuntime())
      throw new Error("导入审阅仅在桌面原生工作区中可用");
    const matchesTarget = () => {
      const current = nativeClient.snapshot?.cursor;
      return nativeClient.currentSessionEpoch === target.sessionEpoch &&
        current !== undefined &&
        sameCursor(current, target.cursor);
    };
    if (!matchesTarget())
      throw new Error("导入解析期间编辑来源或文档修订已变化，请重新导入审阅");
    await flushDraftBeforeVersionAction();
    if (!matchesTarget())
      throw new Error("导入审阅期间简历已发生变化；为保留后续手工编辑，请重新审阅候选");
    const result = await nativeClient.applyImport(
      draftId,
      acceptedCandidateIds,
      target.cursor,
    );
    const appliedCursor = nativeClient.snapshot?.cursor;
    if (
      nativeClient.currentSessionEpoch !== target.sessionEpoch ||
      appliedCursor === undefined ||
      !sameCursor(appliedCursor, result.cursor)
    )
      throw new Error("导入回执属于已经切换的编辑来源，已拒绝覆盖当前界面");
    const snapshot = await snapshotFromLoadedDocument(result.document);
    if (target.sessionEpoch !== nativeClient.currentSessionEpoch)
      throw new Error("导入结果已过期，当前编辑来源没有变化");
    applyVersionSnapshot(snapshot);
    selectWorkspace("editor");
    notify("已将确认的导入候选原子写入当前简历。");
  };

  const {
    versionStore,
    storageStatus,
    storageBusy,
    hasUncommittedChanges,
    commitVersion,
    createBranch,
    replaceVersionStore,
    refreshAfterLegacyMigration,
    switchBranch,
    loadCommit,
    jumpToBranch,
    deleteCommit,
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

  const applyFormatPreset = (
    templateId: KnownTemplateId,
    importedAccent?: string,
    importedLayout?: ImportedTemplate["layout"],
    sideBandBackground?: string,
    sideBandForeground?: string,
    autoFit = true,
  ) => {
    const template = templateRegistry[templateId];
    setPresentation({
      templateId,
      templateVersion: template.version,
      densityPreset: template.defaultDensity,
      overrides: importedLayout
        ? {
            importedLayout,
            ...(sideBandBackground
              ? { importedSideBandBackground: sideBandBackground }
              : {}),
            ...(sideBandForeground
              ? { importedSideBandForeground: sideBandForeground }
              : {}),
          }
        : {},
    });
    applyTemplateDefaults(templateId);
    if (importedAccent) setTheme(importedAccent);
    if (autoFit) setFormatAutoFitRevision((revision) => revision + 1);
  };

  const applyImportedTemplate = async (template: ImportedTemplate): Promise<boolean> => {
    if (nativeReady && isTauriRuntime()) {
      if (importedContextSwitching.current) return false;
      importedContextSwitching.current = true;
      try {
        await flushDraftBeforeVersionAction();
        const current = nativeClient.snapshot;
        if (!current) throw new Error("本地文档尚未载入");
        const initialDocument = structuredClone(current.document);
        initialDocument.legacyExtensions = {
          ...initialDocument.legacyExtensions,
          importedTemplate: {
            id: template.id,
            name: template.name,
            ...(template.revisionHash ? { revisionHash: template.revisionHash } : {}),
          },
        };
        const switched = await nativeClient.switchEditingContext({
          expectedCursor: current.cursor,
          sourceKind: "imported_template",
          sourceId: template.id,
          initialDocument,
        });
        if (switched.created) {
          setRichEditorResetKey((current) => current + 1);
        }
        if (!switched.created) {
          const restored = await snapshotFromLoadedDocument(switched.document);
          restored.importedTemplate = {
            id: template.id,
            name: template.name,
            ...(restored.importedTemplate?.revisionHash
              ? { revisionHash: restored.importedTemplate.revisionHash }
              : template.revisionHash
                ? { revisionHash: template.revisionHash }
                : {}),
          };
          applyVersionSnapshot(restored);
          setActiveImportedTemplateRevisionHash(
            restored.importedTemplate.revisionHash ?? null,
          );
          setActiveImportedTemplateName(template.name);
          setImportedTemplateNames((currentNames) => ({
            ...currentNames,
            [template.id]: template.name,
          }));
          if (template.sourceType === "pdf" && template.previewDataUrl) {
            setSourcePreview({
              templateId: template.id,
              src: template.previewDataUrl,
              baseline: null,
            });
          } else setSourcePreview(null);
          notify(`已恢复“${template.name}”的独立草稿`);
          return true;
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : "切换导入来源失败，原工作区已保留");
        return false;
      } finally {
        importedContextSwitching.current = false;
      }
    }
    const autoFit = !(template.resume && template.layout === "side-band");
    if (template.presentation) {
      const restored = normalizePresentation(template.presentation);
      setPresentation({
        ...restored,
        overrides: {
          ...restored.overrides,
          ...(template.sideBandBackground
            ? { importedSideBandBackground: template.sideBandBackground }
            : {}),
          ...(template.sideBandForeground
            ? { importedSideBandForeground: template.sideBandForeground }
            : {}),
        },
      });
      if (autoFit) setFormatAutoFitRevision((revision) => revision + 1);
    } else
      applyFormatPreset(
        template.formatId,
        template.accent,
        template.layout,
        template.sideBandBackground,
        template.sideBandForeground,
        autoFit,
      );
    if (!autoFit) stopPendingFit();
    if (template.resumeLayout) applyLayoutSnapshot(template.resumeLayout);
    if (template.resume) {
      setRichEditorResetKey((current) => current + 1);
      setResume(normalizeResumeState(template.resume));
    }
    if (template.moduleOrder)
      setModuleOrder(normalizeSectionOrder(template.moduleOrder));
    if (template.moduleNames)
      setModuleNames({ ...moduleTitles, ...template.moduleNames });
    if (template.summaryTitle) setSummaryTitle(template.summaryTitle);
    if (template.detectedFont) setFont(template.detectedFont);
    if (template.sourceType === "pdf" && template.previewDataUrl) {
      try {
        window.localStorage.removeItem(sourcePreviewDismissalKey(template.id));
      } catch {
        // The current session can still show the source preview if storage is full.
      }
      setSourcePreview({
        templateId: template.id,
        src: template.previewDataUrl,
        baseline: null,
      });
    } else setSourcePreview(null);
    setActiveImportedTemplateId(template.id);
    setActiveImportedTemplateRevisionHash(template.revisionHash ?? null);
    setActiveImportedTemplateName(template.name);
    setImportedTemplateNames((current) => ({
      ...current,
      [template.id]: template.name,
    }));
    try {
      window.localStorage.setItem(
        "resume-diy-active-imported-template",
        template.id,
      );
    } catch {
      // The active source is already represented by the native document context.
    }
    if (template.revisionStatus === "fallback" || template.revisionStatus === "unknown") {
      notify("此模板修订使用当前渲染器回退；原始修订身份与已保存版式仍会保留。");
    }
    notify(
      template.resume
        ? `已切换到“${template.name}”，正文可在编辑模板页继续修改`
        : `已应用“${template.name}”的视觉样式`,
    );
    return true;
  };

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
        presentation,
        font,
        fontSize,
        lineHeight,
        moduleSpacing,
        pageMargin,
        theme,
        dateFormat,
        titleFormat,
        separator,
        textAlign,
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

  useEffect(() => {
    if (!sourcePreview || sourcePreviewContentSignature === null) return;
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
  }, [sourcePreview, sourcePreviewContentSignature, setSourcePreview]);

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

  useEffect(() => {
    if (!formatAutoFitRevision) return;
    const timer = window.setTimeout(
      () => autoFitOnePage("template-change"),
      180,
    );
    return () => window.clearTimeout(timer);
  }, [autoFitOnePage, formatAutoFitRevision]);

  const selectWorkspace = (next: WorkspaceView) => {
    setPanel(null);
    setTitleEditing(false);
    setWorkspaceView(next);
  };
  const {
    openEntries,
    setOpenEntries,
    setDraggingModule,
    updateBasic,
    updateAvatar,
    updateEntry,
    addEntry,
    removeEntry,
    showSection,
    hideSection,
    moveSection,
    reorderModule,
    commitModuleOrder,
    toggleEntry,
  } = useResumeEditing({
    resume,
    setResume,
    setModuleOrder,
    moduleNames,
    notify,
    requestConfirmation,
    setPanel,
    setEditingModule,
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
    (target: EditorNavigationTarget) => {
      setPanel(null);
      setEditingModule(null);
      setEditSummaryFromHeading(false);
      setTitleEditing(false);
      setWorkspaceView("editor");
      expandSection(
        target.kind === "basic"
          ? "basic"
          : target.kind === "summary"
            ? "summary"
            : target.module,
      );
      setActiveEditorSection(
        target.kind === "basic"
          ? "basic"
          : target.kind === "summary"
            ? "summary"
            : target.module,
      );
      if (target.kind === "module") {
        setOpenEntries((current) => {
          const next = { ...current };
          for (const entry of resume[target.module]) delete next[entry.id];
          if (
            target.entryId &&
            resume[target.module].some((entry) => entry.id === target.entryId)
          )
            next[target.entryId] = true;
          return next;
        });
      }
      setEditorNavigationTarget(target);
    },
    [expandSection, resume, setOpenEntries, setPanel],
  );
  const applyAgentEdit = useCallback(
    ({
      target,
      patch,
      expectedValue,
    }: {
      target: AgentEditTarget;
      patch: AgentEditPatch;
      expectedValue: unknown;
    }) => {
      if (target.kind === "basic") {
        if (
          target.key === "avatar" ||
          !("value" in patch) ||
          typeof patch.value !== "string" ||
          resume.basic[target.key] !== expectedValue
        )
          return false;
        updateBasic(target.key, patch.value);
        navigateToEditor({ kind: "basic" });
        return true;
      }
      if (target.kind === "summary") {
        if (
          !("html" in patch) ||
          typeof patch.html !== "string" ||
          resume.summary !== expectedValue
        )
          return false;
        const summary = patch.html;
        setResume((current) => ({ ...current, summary }));
        navigateToEditor({ kind: "summary" });
        return true;
      }
      const currentEntry = resume[target.module].find(
        (entry) => entry.id === target.id,
      );
      const allowedKeys = new Set([
        "title",
        "role",
        "department",
        "city",
        "start",
        "end",
        "html",
        "college",
        "mode",
      ]);
      const patchEntries = Object.entries(patch);
      if (
        !currentEntry ||
        JSON.stringify(currentEntry) !== JSON.stringify(expectedValue) ||
        patchEntries.length === 0 ||
        patchEntries.some(
          ([key, value]) =>
            !allowedKeys.has(key) ||
            typeof value !== "string" ||
            value.length > 5000,
        )
      )
        return false;
      updateEntry(
        target.module,
        target.id,
        Object.fromEntries(patchEntries) as Partial<Entry>,
      );
      navigateToEditor({
        kind: "module",
        module: target.module,
        entryId: target.id,
      });
      return true;
    },
    [navigateToEditor, resume, setResume, updateBasic, updateEntry],
  );
  const undoAgentEdit = useCallback(
    ({
      target,
      originalValue,
      expectedValue,
    }: {
      target: AgentEditTarget;
      originalValue: unknown;
      expectedValue: unknown;
    }) => {
      if (target.kind === "basic") {
        if (resume.basic[target.key] !== expectedValue) return false;
        setResume((current) => ({
          ...current,
          basic: { ...current.basic, [target.key]: originalValue },
        }));
        return true;
      }
      if (target.kind === "summary") {
        if (resume.summary !== expectedValue) return false;
        setResume((current) => ({
          ...current,
          summary: String(originalValue),
        }));
        return true;
      }
      const currentEntry = resume[target.module].find(
        (entry) => entry.id === target.id,
      );
      if (
        !currentEntry ||
        JSON.stringify(currentEntry) !== JSON.stringify(expectedValue)
      )
        return false;
      setResume((current) => ({
        ...current,
        [target.module]: current[target.module].map((entry) =>
          entry.id === target.id ? (originalValue as Entry) : entry,
        ),
      }));
      return true;
    },
    [resume, setResume],
  );
  const navigateToAgentReference = useCallback(
    (reference: AgentReference) => {
      setPanel(null);
      if (reference.kind === "feature") {
        setWorkspaceView(reference.view ?? "editor");
      } else if (reference.kind === "basic-field") {
        navigateToEditor({ kind: "basic" });
      } else if (reference.kind === "summary") {
        navigateToEditor({ kind: "summary" });
      } else if (reference.kind === "module" && reference.module) {
        navigateToEditor({ kind: "module", module: reference.module });
      } else if (
        reference.kind === "entry" &&
        reference.module &&
        reference.entry
      ) {
        navigateToEditor({
          kind: "module",
          module: reference.module,
          entryId: reference.entry.id,
        });
      } else if (reference.kind === "template") {
        setWorkspaceView("templates");
      } else if (
        reference.kind === "version" ||
        reference.kind === "draft" ||
        reference.kind === "branch"
      ) {
        setWorkspaceView("versions");
      }
    },
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
  const copyResume = async () => {
    const plain = buildResumePlainText({
      resume,
      moduleOrder,
      moduleNames,
      summaryTitle,
    });
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(plain);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = plain;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
          if (!document.execCommand("copy")) throw new Error("Clipboard rejected copy");
        } finally {
          textarea.remove();
        }
      }
      notify("简历文本已复制");
    } catch {
      notify("复制失败，请检查浏览器权限");
    }
  };

  const exportFileName =
    resumeTitle.trim().replace(/[\\/:*?"<>|]/g, "-") || "resume";

  const exportVersionBackup = async (includeDraft: boolean) => {
    let backup: ResumeVersionBackup;
    try {
      const documentId = nativeClient.snapshot?.document.documentId;
      const nativeDefaultBranchId = documentId ? `main:${documentId}` : "main";
      backup = createVersionBackup(
        await materializeVersionStore(versionStore),
        includeDraft && hasUncommittedChanges ? workingSnapshot : null,
        nativeDefaultBranchId,
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "版本备份导出失败");
      return;
    }
    downloadJsonBlob(
      `${exportFileName}-版本备份-${new Date().toISOString().slice(0, 10)}.json`,
      backup,
    );
    notify(
      includeDraft ? "版本备份已导出，包含当前未提交草稿" : "版本备份已导出",
    );
  };

  const exportFullDatabaseBackup = async () => {
    if (databaseBackupOperation) return;
    if (!isTauriRuntime()) {
      notify("完整数据库备份仅在桌面应用中可用");
      return;
    }
    setDatabaseBackupOperation("exporting");
    try {
      await flushDraftBeforeVersionAction();
      await flushAgentSessionWrites();
      const payload = (await nativeInvoke("export_database_backup")) as DatabaseBackupPayload;
      downloadJsonBlob(
        `${exportFileName}-完整数据库备份-${new Date().toISOString().slice(0, 10)}.json`,
        payload,
      );
      notify("完整数据库备份已导出；文件包含本机账户和加密连接密文，请妥善保管");
    } catch (error) {
      notify(error instanceof Error ? error.message : "完整数据库备份失败");
    } finally {
      setDatabaseBackupOperation(null);
    }
  };

  const requestFullDatabaseRestore = async (file: File) => {
    const maximumFileBytes = 180 * 1024 * 1024;
    if (file.size > maximumFileBytes) {
      notify("完整数据库备份文件超过 180 MiB 上限");
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as Partial<DatabaseBackupPayload>;
      if (
        parsed.format !== "zinecv-sqlite-full-backup" ||
        parsed.formatVersion !== 1 ||
        typeof parsed.databaseBase64 !== "string" ||
        typeof parsed.databaseSha256 !== "string" ||
        typeof parsed.schemaVersion !== "number"
      ) {
        throw new Error("文件不是受支持的完整数据库备份");
      }
      const payload = parsed as DatabaseBackupPayload;
      requestConfirmation({
        title: "恢复完整数据库？",
        description: `这会替换当前本机数据库中的简历、版本、模板、账户、对话与连接设置。恢复前会自动保留当前数据库副本。当前简历将先保存；恢复后需要重新登录。备份记录的 schema 为 ${payload.schemaVersion}，其中 ${payload.unavailableSecretCount ?? 0} 个 Key 在导出时已无法解密。当前文件包含加密保存的 Key 密文，但整个备份文件未加密。`,
        confirmLabel: "恢复完整数据库",
        onConfirm: () => {
          void (async () => {
            if (databaseBackupOperation) return;
            setDatabaseBackupOperation("restoring");
            try {
              await flushDraftBeforeVersionAction();
              await flushAgentSessionWrites();
              const result = (await nativeInvoke("restore_database_backup", {
                payload,
              })) as DatabaseRestoreResult;
              window.sessionStorage.setItem(
                "zinecv.full-database-restore-notice",
                JSON.stringify(result),
              );
              window.location.reload();
            } catch (error) {
              setDatabaseBackupOperation(null);
              const appError = error instanceof NativeIpcError ? error.detail : null;
              const reason = appError?.code === "STORAGE_CORRUPT"
                ? "备份文件未通过完整性或数据库校验"
                : "当前数据未能完成恢复";
              notify(
                `完整数据库恢复失败；${reason}，当前数据库未替换${appError?.diagnosticId ? `（诊断编号 ${appError.diagnosticId}）` : ""}`,
              );
            }
          })();
        },
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : "完整数据库备份读取失败");
    }
  };

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
  const importLegacyBrowserData = async (file: File) => {
    setPanel(null);
    try {
      const raw = await file.text();
      const json = JSON.parse(raw);
      const parsed = parseLegacyDataFile(json);
      await flushDraftBeforeVersionAction();
      const cursor = nativeClient.snapshot?.cursor;
      if (!cursor) throw new Error("本机文档尚未载入");
      const namespace = await legacyMigrationNamespace(parsed, file.name);
      const prepared = await prepareLegacyMigration(raw, parsed, cursor, namespace);
      const branchCount = parsed.store?.branches.length ?? 0;
      const commitCount = parsed.store?.commits.length ?? 0;
      const reviewMessages = [...prepared.report.issues, ...prepared.report.sources.flatMap((source) => source.issues)]
        .filter((issue) => issue.severity === "review")
        .map((issue) => issue.message);
      const conflictLabels = prepared.report.conflicts.map((conflict) => conflict.entityKind);
      const identityConflictSummary = prepared.identityConflicts.length
        ? `检测到 ${prepared.identityConflicts.length} 个已导入实体的内容发生变化（${prepared.identityConflicts.slice(0, 4).map((conflict) => `${conflict.entityKind}:${conflict.legacyId}，已有 ${conflict.existingVariantCount} 个版本`).join("；")}）。确认后会按内容生成独立身份并追加，保留旧记录，不覆盖。`
        : "未发现与本机迁移映射冲突的实体。";
      requestConfirmation({
        title: "审阅并导入旧版数据？",
        description: `来源命名空间：${namespace}（重复导入会复用本机身份映射）。原生预演检查了 ${prepared.report.sources.length} 个来源、${prepared.dryRun.stagedDocumentCount} 个转换文档；${parsed.store ? `将追加 ${branchCount} 个分支、${commitCount} 次提交` : "未发现版本图"}；${prepared.request.currentDraft ? "当前工作区草稿会按本次确认更新" : "当前工作区草稿保持不变"}。${identityConflictSummary}${conflictLabels.length ? `另有跨文件冲突类别：${[...new Set(conflictLabels)].join("、")}；同名分支会附加来源标识并分别保留。` : "未发现跨文件来源冲突。"}${reviewMessages.length ? `待确认提示：${[...new Set(reviewMessages)].slice(0, 5).join("；")}` : "没有待确认的结构提示。"}本次在一个 SQLite 事务中写入版本图、可选草稿、模板、偏好、来源映射和幂等回执；另将迁入 ${prepared.report.totals.accountRecords} 个账户、${prepared.report.totals.providerProfiles} 个公开连接配置、${prepared.report.totals.agentSessions} 个 Agent 会话。旧 Key 不迁入，需重新输入；活跃登录令牌不迁入，旧运行标记中断。资源文件等剩余类别以提交回执为准，不计入完整迁移。`,
        confirmLabel: "确认并原子导入",
        onConfirm: () => {
          void (async () => {
            const receipt = await commitPreparedLegacyMigration(prepared);
            await refreshAfterLegacyMigration();
            notify(`旧版迁移已原子提交：新增 ${receipt.versionBranchCount} 个分支、${receipt.versionCommitCount} 次提交${receipt.currentDraftApplied ? "，已应用确认的当前草稿" : "，当前草稿保持不变"}；账户 ${receipt.accountCount} 个、连接 ${receipt.providerCount} 个、会话 ${receipt.sessionCount} 个，${receipt.secretReentryCount} 个连接需重输 Key。未迁移：${receipt.remainingCategories.join("、")}`);
          })().catch((error) => {
            notify(error instanceof Error ? error.message : "旧版数据导入失败；原数据未改动");
          });
        },
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : "旧版数据导入失败");
    }
  };

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

  const downloadResume = async (format: "pdf" | "png", dpi?: number) => {
    if (exportingFormat) return;
    if (previewOverflow) {
      notify(
        previewOverflowMessage ||
          "预览内容超出 A4 可用区域，导出已暂停。请编辑内容后再试。",
      );
      return;
    }
    setPanel(null);
    setExportingFormat(format);
    const label = format === "pdf" ? "PDF" : "高清 PNG";
    notify(`正在生成 ${label}…`);
    try {
      // R15：PDF/PNG/长图都来自同一次引擎编译的冻结修订；等草稿命令全部
      // 落盘后再取快照，保证导出与已保存内容一致。保存走原生对话框，
      // 取消不是错误；中文路径与磁盘满由宿主映射为可读反馈。
      await flushDraftBeforeVersionAction();
      const cursor = nativeClient.snapshot?.cursor;
      if (!cursor) throw new Error("文档尚未就绪");
      // product 按需导出：PDF 不再承担 PNG 栅格与像素预算，PNG 不再编码 PDF；
      // 缺省 bundle 保持完整包行为（R15 冻结修订语义不变）。
      const bundle = (await nativeInvoke("render_document_export", {
        cursor,
        product: format,
        ...(format === "png" && dpi !== undefined ? { dpi } : {}),
      })) as { data: ExportData };
      const data = bundle.data;
      const saveFile = async (path: string, base64: string) => {
        await nativeInvoke("write_export_file", { path, dataBase64: base64 });
      };
      if (format === "pdf") {
        const target = await nativeInvoke("pick_export_path", {
          kind: "pdf",
          defaultName: `${exportFileName}.pdf`,
        });
        if (typeof target !== "string") {
          notify("已取消导出");
          return;
        }
        await saveFile(target, data.pdfBase64);
        notify(platformCapabilities().nativeDialogs ? `PDF 已保存：${target}` : `PDF 已开始下载：${target}`);
        return;
      }
      if (data.longPng && !data.longImageLimited) {
        const target = await nativeInvoke("pick_export_path", {
          kind: "png",
          defaultName: `${exportFileName}.png`,
        });
        if (typeof target !== "string") {
          notify("已取消导出");
          return;
        }
        await saveFile(target, data.longPng.dataBase64);
        notify(platformCapabilities().nativeDialogs ? `高清长图已保存：${target}` : `高清长图已开始下载：${target}`);
        return;
      }
      // 长图超出像素预算时按引擎页序逐页保存到用户选择的文件夹。
      const directory = await nativeInvoke("pick_export_directory");
      if (typeof directory !== "string") {
        notify("已取消导出");
        return;
      }
      for (const page of data.pngPages) {
        await saveFile(
          `${directory}\\${exportFileName}-第${page.page}页.png`,
          page.dataBase64,
        );
      }
      notify(
        platformCapabilities().nativeDialogs ? `长图超出单图预算，已按 ${data.pngPages.length} 页保存到 ${directory}` : `长图超出单图预算，已开始下载 ${data.pngPages.length} 页图片`,
      );
    } catch (error) {
      console.error(`${format.toUpperCase()} export failed`, error);
      const detail =
        error instanceof Error && error.message ? `：${error.message}` : "";
      notify(`${label} 导出失败${detail || "，请稍后重试"}`);
    } finally {
      setExportingFormat(null);
    }
  };

  const resetResume = () => {
    requestConfirmation({
      title: "清空当前简历？",
      description:
        "所有已填写内容都会被清空，并恢复默认模块结构。此操作无法撤销。",
      confirmLabel: "确认清空",
      onConfirm: () => {
        setResume(emptyResume);
        setModuleOrder(defaultSectionOrder);
        setModuleNames({ ...moduleTitles });
        setOpenEntries({});
        setResumeTitle("resume DIY");
        setSummaryTitle("自我评价");
        notify("简历已清空");
      },
    });
  };

  const smartSort = () => {
    const byDate = (left: Entry, right: Entry) =>
      `${right.end}${right.start}`.localeCompare(`${left.end}${left.start}`);
    setResume((current) => ({
      ...current,
      ...Object.fromEntries(
        (Object.keys(moduleTitles) as ModuleKey[]).map((module) => [
          module,
          [...current[module]].sort(byDate),
        ]),
      ),
    }));
    notify("经历已按结束时间排序");
  };

  const bundledBrowserFonts = platformCapabilities().core === "wasm";
  const editorFontFamily = bundledBrowserFonts ? fontFamilies["宋体"] : (fontFamilies[font] ?? font);
  const allPreviewBlocks = useMemo(
    () => getPreviewBlocks(moduleOrder, resume),
    [moduleOrder, resume],
  );

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

  return (
    <div
      className="app-shell"
      data-font-host={bundledBrowserFonts ? "bundled" : "system"}
      style={
        {
          "--accent": theme,
          "--editor-font": editorFontFamily,
        } as CSSProperties
      }
    >
      {workspaceSettingsError ? (
        <div className="workspace-settings-error" role="alert">
          <span>{workspaceSettingsError}</span>
          <button type="button" onClick={retryWorkspaceSettings}>
            重试保存
          </button>
        </div>
      ) : null}
      <AppHeader
        panel={panel}
        setPanel={setPanel}
        resumeTitle={resumeTitle}
        titleEditing={titleEditing}
        saveState={saveState}
        onRetryDraft={() => {
          if (!saveState.conflict) {
            void retryDraft();
            return;
          }
          requestConfirmation({
            title: "重新载入最新草稿？",
            description: "其他窗口已经保存了更新。重新载入会放弃本窗口尚未保存的修改，显示数据库中的最新草稿；取消则保留当前输入。",
            confirmLabel: "放弃本窗口修改并重新载入",
            onConfirm: () => window.location.reload(),
          });
        }}
        smartFillEnabled={smartFitActive}
        smartFitPulse={smartFitPulse}
        panelAnchor={panelAnchorRef.current}
        exportingFormat={exportingFormat}
        layout={makeLayout(
          String(Math.round(visibleLineHeight)),
          String(Math.round(visibleModuleSpacing)),
        )}
        modules={{
          order: moduleOrder,
          names: moduleNames,
          summaryTitle,
          editingModule,
          editSummaryOnOpen: editSummaryFromHeading,
          setEditingModule,
          setSummaryTitle,
          setModuleNames,
          onShowSection: showSection,
          onHideSection: hideSection,
          onMoveSection: moveSection,
          onDragStart: setDraggingModule,
          onMove: (module) => reorderModule(module, false),
          onDrop: reorderModule,
        }}
        onResumeTitleChange={setResumeTitle}
        onTitleEditingChange={setTitleEditing}
        onToggleSmartFill={fitOnePage}
        onLayoutChange={(key, value) => {
          if (key === "font") setFont(value);
          else if (key === "theme") setTheme(value);
          else if (key === "dateFormat")
            setDateFormat(value as typeof dateFormat);
          else if (key === "titleFormat")
            setTitleFormat(value as typeof titleFormat);
          else if (key === "separator") setSeparator(value as SeparatorMode);
          else if (key === "textAlign") setTextAlign(value as typeof textAlign);
          else if (key === "fontSize")
            applyManualLayoutChange(setFontSize, value);
          else if (key === "lineHeight")
            applyManualLayoutChange(setLineHeight, value);
          else if (key === "moduleSpacing")
            applyManualLayoutChange(setModuleSpacing, value);
          else if (key === "pageMargin")
            applyManualLayoutChange(setPageMargin, value);
        }}
        onSmartSort={smartSort}
        onOpenModuleManager={() => setEditSummaryFromHeading(false)}
        onDownloadPdf={() => void downloadResume("pdf")}
        onDownloadPng={(dpi) => void downloadResume("png", dpi)}
        onCopy={() => {
          setPanel(null);
          void copyResume();
        }}
        onReset={resetResume}
      />

      <main
        ref={workspaceRef}
        className={`workspace ${isResizingPanes ? "workspace-resizing" : ""}`}
      >
        <WorkspaceRail activeView={workspaceView} onSelect={selectWorkspace} />

        <section
          className={`editor-pane ${workspaceView}-workspace-pane`}
          style={{
            width: `${editorPaneWidth}px`,
            minWidth: `${editorPaneWidth}px`,
            flex: `0 0 ${editorPaneWidth}px`,
          }}
        >
          {workspaceView === "versions" ? (
            <div className="editor-scroll version-scroll">
              <Suspense fallback={workspaceLoading}>
                <VersionControlPanel
                  store={versionStore}
                  importedTemplateNames={importedTemplateNames}
                  storageStatus={storageStatus}
                  storageBusy={storageBusy}
                  dirty={hasUncommittedChanges}
                  onExportBackup={exportVersionBackup}
                  onExportFullDatabaseBackup={() => void exportFullDatabaseBackup()}
                  onRequestFullDatabaseRestore={(file) => void requestFullDatabaseRestore(file)}
                  onRequestImport={requestVersionImport}
                  onLoadDraft={loadImportedDraft}
                  onCommit={commitVersion}
                  onCreateBranch={createBranch}
                  onSwitchBranch={switchBranch}
                  onLoadCommit={loadCommit}
                  onDeleteCommit={deleteCommit}
                  onJumpToBranch={jumpToBranch}
                  onDeleteBranch={deleteBranch}
                  onImportLegacyBrowser={importLegacyBrowserData}
                />
              </Suspense>
            </div>
          ) : workspaceView === "templates" ? (
            <Suspense fallback={workspaceLoading}>
              <TemplateWorkspace
                importedTemplates={importedTemplateCatalog}
                currentTemplateId={resolvedPresentation.resolvedTemplateId}
                currentPageCount={previewPages.length}
                selectedTemplateId={activeImportedTemplateId}
                onApplyImported={applyImportedTemplate}
                prepareImportTarget={prepareImportTarget}
                onApplyImport={applyImportDraft}
                onTemplatesChange={setImportedTemplateCatalog}
                onRenameImported={renameImportedTemplate}
                onBack={() => selectWorkspace("editor")}
              />
            </Suspense>
          ) : (
            <ResumeEditor
              resume={resume}
              moduleOrder={moduleOrder}
              moduleNames={moduleNames}
              summaryTitle={summaryTitle}
              richEditorResetKey={richEditorResetKey}
              activeSectionKey={activeEditorSection}
              collapsedSections={collapsedSections}
              expandSection={expandSection}
              toggleOpenSection={toggleOpenSection}
              openEntries={openEntries}
              updateBasic={updateBasic}
              updateAvatar={updateAvatar}
              onSaveDraft={retryDraft}
              commitModuleOrder={commitModuleOrder}
              setDraggingModule={setDraggingModule}
              setEditSummaryFromHeading={setEditSummaryFromHeading}
              setPanel={setPanel}
              setResume={setResume}
              setEditingModule={setEditingModule}
              toggleEntry={toggleEntry}
              updateEntry={updateEntry}
              removeEntry={removeEntry}
              addEntry={addEntry}
              editorScrollRef={editorScrollRef}
              overflowWarning={previewOverflowMessage}
              onNavigateToEditor={navigateToEditor}
            />
          )}
        </section>

        <div
          className="workspace-splitter"
          role="separator"
          tabIndex={0}
          aria-label="调整编辑器与预览宽度"
          aria-orientation="vertical"
          aria-valuemin={paneBounds.min}
          aria-valuemax={paneBounds.max}
          aria-valuenow={Math.round(editorPaneWidth)}
          aria-valuetext={`编辑器宽度 ${Math.round(editorPaneWidth)} 像素`}
          title="拖动调整编辑器与预览宽度，双击恢复默认"
          onPointerDown={beginPaneResize}
          onKeyDown={handlePaneSplitterKeyDown}
          onDoubleClick={resetPaneWidth}
        >
          <span aria-hidden="true" />
        </div>

        <ResumePreviewPane
          templateId={resolvedPresentation.resolvedTemplateId}
          templateVariant={templateVariant}
          templateSideBandBackground={templateSideBandBackground}
          templateSideBandForeground={templateSideBandForeground}
          templateHeadingFontSize={templateHeadingFontSize}
          templateParagraphSpacing={templateParagraphSpacing}
          templateListSpacing={templateListSpacing}
          measurementRef={paginationMeasureRef}
          pages={previewPages}
          allBlocks={allPreviewBlocks}
          resume={resume}
          moduleNames={moduleNames}
          summaryTitle={summaryTitle}
          dateFormat={dateFormat}
          titleFormat={titleFormat}
          separator={separator}
          textAlign={textAlign}
          fontFamily={editorFontFamily}
          fontSize={fontSize}
          measurementLineHeight={measurementLineHeight}
          letterSpacing={pageLetterSpacing}
          pagePadding={pagePadding}
          measurementModuleGap={measurementModuleGap}
          baseModuleGap={layoutBaseModuleGap}
          theme={theme}
          initialZoomPercent={workspaceSettings.previewZoomPercent}
          onZoomPercentChange={persistPreviewZoom}
          onNavigateToEditor={navigateToEditor}
          onOverflowChange={setPreviewOverflow}
        />
      </main>
      <ImportedSourcePreviewOverlay src={sourcePreview?.src ?? null} />
      <AgentOverlay
        activeView={workspaceView}
        resume={resume}
        moduleOrder={moduleOrder}
        moduleNames={moduleNames}
        summaryTitle={summaryTitle}
        resumeTitle={resumeTitle}
        activeTemplateId={activeImportedTemplateId}
        templates={importedTemplateCatalog}
        versionStore={versionStore}
        workingSnapshot={workingSnapshot}
        hasUncommittedChanges={hasUncommittedChanges}
        layoutPreferences={{
          mode: workspaceSettings.agentMode,
          anchor: workspaceSettings.agentPosition,
          sizes: workspaceSettings.agentSizes,
        }}
        onLayoutPreferenceChange={persistAgentLayout}
        onApplyEdit={applyAgentEdit}
        onUndoEdit={undoAgentEdit}
        onDeleteEntry={(module, id, expectedValue) => {
          const currentEntry = resume[module].find((entry) => entry.id === id);
          if (
            !currentEntry ||
            JSON.stringify(currentEntry) !== JSON.stringify(expectedValue)
          )
            return false;
          setResume((current) => ({
            ...current,
            [module]: current[module].filter((entry) => entry.id !== id),
          }));
          navigateToEditor({ kind: "module", module });
          return true;
        }}
        onApplyTemplate={async (template) => {
          const applied = await applyImportedTemplate(template);
          if (applied) selectWorkspace("editor");
          return applied;
        }}
        onCommitVersion={commitVersion}
        onNavigateToReference={navigateToAgentReference}
        onNativeWorkspaceReload={applyVersionSnapshot}
      />
      {databaseBackupOperation ? (
        <div className="dialog-backdrop" aria-busy="true">
          <div className="confirm-dialog" role="status" aria-live="polite">
            <h2>
              {databaseBackupOperation === "exporting"
                ? "正在创建完整数据库备份"
                : "正在验证并恢复完整数据库"}
            </h2>
            <p>
              {databaseBackupOperation === "exporting"
                ? "请稍候，备份包含当前已保存的简历、模板、账户和对话数据。"
                : "正在校验候选数据库。完成后应用会重新载入并要求重新登录。"}
            </p>
          </div>
        </div>
      ) : null}
      {confirmAction ? (
        <ConfirmDialog
          action={confirmAction}
          onCancel={() => setConfirmAction(null)}
          onConfirm={confirmCurrentAction}
        />
      ) : null}
      {notice ? (
        <div className="notice-toast" role="status" aria-live="polite">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
