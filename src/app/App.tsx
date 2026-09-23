import { useResumeEditing } from "./useResumeEditing";
import { getPreviewBlocks } from "../services/resume-pagination";
import { ResumeEditor } from "../components/editor/ResumeEditor";
import { useResumeVersions } from "./useResumeVersions";
import { useResumePagination } from "./useResumePagination";
import { useResumePersistence } from "./useResumePersistence";
import { useNotice } from "./useNotice";
import {
  useEditorNavigation,
  type EditorNavigationTarget,
} from "./useEditorNavigation";
import { usePaneResize } from "./usePaneResize";
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

import { ConfirmDialog } from "../components/overlays/ConfirmDialog";
import { AppHeader, type HeaderPanel } from "../components/layout/AppHeader";
import {
  WorkspaceRail,
  type WorkspaceView,
} from "../components/layout/WorkspaceRail";
import { ResumePreviewPane } from "../components/preview/ResumePreviewPane";
import type { PreviewOverflowFinding } from "../components/preview/PreviewOverflowGuard";

import {
  DEFAULT_PAGE_MARGIN_PX,
  defaultSectionOrder,
  emptyResume,
  fontFamilies,
  initialResume,
  moduleTitles,
} from "../domain/resume-model";

import {
  exportResumeAsPdf,
  exportResumeAsPng,
} from "../services/resume-export";
import { buildResumePlainText } from "../services/resume-copy";
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
import type { DraftSaveState } from "../domain/draft-save-state";
import type { ResumeVersionSnapshot } from "../domain/version-model";
import {
  readImportedTemplates,
  writeImportedTemplates,
  type ImportedTemplate,
} from "../domain/imported-template";
import {
  TEMPLATE_SNAPSHOT_SCHEMA_VERSION,
  normalizePresentation,
  resolvePresentation,
  type KnownTemplateId,
  type ResumePresentation,
} from "../domain/template-model";
import { templateRegistry, templateVersions } from "../templates/registry";
import { readStoredPreference, readStoredString } from "../utils/resume";

const TemplateWorkspace = lazy(() =>
  import("../components/templates/TemplateWorkspace").then((module) => ({
    default: module.TemplateWorkspace,
  })),
);
const VersionControlPanel = lazy(() =>
  import("../components/versioning/VersionControlPanel").then((module) => ({
    default: module.VersionControlPanel,
  })),
);
const AiAssistantPanel = lazy(() =>
  import("../components/assistant/AiAssistantPanel").then((module) => ({
    default: module.AiAssistantPanel,
  })),
);
const workspaceLoading = (
  <div role="status" className="workspace-loading">
    正在载入工作区…
  </div>
);

const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[\da-fA-F]{6}$/.test(value);

export default function App() {
  const { notice, notify } = useNotice();
  const {
    workspaceRef,
    editorPaneWidth,
    paneBounds,
    isResizingPanes,
    beginPaneResize,
    handlePaneSplitterKeyDown,
    resetPaneWidth,
  } = usePaneResize();
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
  const [presentation, setPresentation] = useState<ResumePresentation>(() => {
    try {
      const stored = window.localStorage.getItem("resume-diy-presentation-v1");
      return normalizePresentation(stored ? JSON.parse(stored) : undefined);
    } catch {
      return normalizePresentation(undefined);
    }
  });
  const [openBasic, setOpenBasic] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryTitle, setSummaryTitle] = useState(() =>
    readStoredString("resume-diy-summary-title", "自我评价"),
  );
  // A4 排版参数：对应顶部“排版设置”弹窗中的控件。
  const [font, setFont] = useState(() => {
    const stored = readStoredPreference("font", "宋体");
    return stored === "微软雅黑" ? "雅黑" : stored;
  });
  const [fontSize, setFontSize] = useState(() =>
    readStoredPreference("fontSize", "13"),
  );
  const [lineHeight, setLineHeight] = useState(() =>
    readStoredPreference("lineHeight", "13"),
  );
  const [moduleSpacing, setModuleSpacing] = useState(() =>
    readStoredPreference("moduleSpacing", "0"),
  );
  const [pageMargin, setPageMargin] = useState(() => {
    const stored = Number(
      readStoredPreference("pageMargin", String(DEFAULT_PAGE_MARGIN_PX)),
    );
    // 旧版本把 5 表示成约 30px；迁移后控件直接显示真实页距。
    return String(stored < 20 ? Math.round(25.2362 + stored) : stored);
  });
  const [theme, setTheme] = useState(() =>
    readStoredPreference("theme", "#000000"),
  );
  const [smartFillEnabled, setSmartFillEnabled] = useState(
    () => readStoredPreference("smartFillV2", "false") === "true",
  );
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
  const [dateFormat, setDateFormat] = useState<"2021年1月" | "2021.01">(
    () =>
      readStoredPreference("dateFormat", "2021年1月") as
        "2021年1月" | "2021.01",
  );
  const [titleFormat, setTitleFormat] = useState<"双行标题" | "单行标题">(
    () =>
      readStoredPreference("titleFormat", "单行标题") as
        "双行标题" | "单行标题",
  );
  const [textAlign, setTextAlign] = useState<"系统默认" | "两端对齐">(() =>
    window.localStorage.getItem("resume-diy-layout-consistency-v1")
      ? (readStoredPreference("textAlign", "两端对齐") as
          "系统默认" | "两端对齐")
      : "两端对齐",
  );
  const [separator, setSeparator] = useState<SeparatorMode>(
    () => readStoredPreference("separator", "使用分隔符号") as SeparatorMode,
  );
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
  const [saveState, setSaveState] = useState<DraftSaveState>({
    status: "saved",
    label: "浏览器草稿已保存",
  });
  const [previewOverflow, setPreviewOverflow] =
    useState<PreviewOverflowFinding | null>(null);
  const [resumeTitle, setResumeTitle] = useState(() =>
    readStoredString("resume-diy-title", "resume DIY"),
  );
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("editor");
  const [activeImportedTemplateId, setActiveImportedTemplateId] = useState<
    string | null
  >(() => window.localStorage.getItem("resume-diy-active-imported-template"));
  const [activeImportedTemplateName, setActiveImportedTemplateName] = useState(
    () => {
      const id = window.localStorage.getItem(
        "resume-diy-active-imported-template",
      );
      return readImportedTemplates().find((item) => item.id === id)?.name ?? "";
    },
  );
  const [importedTemplateNames, setImportedTemplateNames] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      readImportedTemplates().map((template) => [template.id, template.name]),
    ),
  );
  const [formatAutoFitRevision, setFormatAutoFitRevision] = useState(0);
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
  ) => String(presentationOverrides[key] ?? activeTemplate.defaults[key]);
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
    layoutContextKey: `${resolvedPresentation.resolvedTemplateId}@${activeTemplate.version}:${templateVariant ?? "default"}`,
    smartFillEnabled,
    setFontSize,
    setLineHeight,
    setModuleSpacing,
    setPageMargin,
    setSmartFillEnabled,
    notify,
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
      layout: {
        font,
        fontSize,
        lineHeight: String(Math.round(visibleLineHeight)),
        moduleSpacing: String(Math.round(visibleModuleSpacing)),
        pageMargin,
        theme,
        dateFormat,
        titleFormat,
        separator,
        textAlign,
      },
      importedTemplate: activeImportedTemplateId
        ? { id: activeImportedTemplateId, name: activeImportedTemplateName }
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
    ],
  );
  const { retryDraft } = useResumePersistence({
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
    setResume(migratePersonalSites(normalizeResumeState(snapshot.resume)));
    setModuleOrder(normalizeSectionOrder(snapshot.moduleOrder));
    setModuleNames({ ...moduleTitles, ...snapshot.moduleNames });
    setSummaryTitle(snapshot.summaryTitle || "自我评价");
    setResumeTitle(snapshot.resumeTitle || "resume DIY");
    setPresentation(normalizePresentation(snapshot.presentation));
    applyLayoutSnapshot(snapshot.layout);
    const imported = snapshot.importedTemplate ?? null;
    setActiveImportedTemplateId(imported?.id ?? null);
    setActiveImportedTemplateName(
      readImportedTemplates().find((item) => item.id === imported?.id)?.name ??
        imported?.name ??
        "",
    );
    if (imported)
      window.localStorage.setItem(
        "resume-diy-active-imported-template",
        imported.id,
      );
    else window.localStorage.removeItem("resume-diy-active-imported-template");
    setSmartFillEnabled(false);
    stopPendingFit();
  };

  const {
    versionStore,
    storageStatus,
    storageBusy,
    hasUncommittedChanges,
    commitVersion,
    createBranch,
    replaceVersionStore,
    switchBranch,
    loadCommit,
    jumpToBranch,
    deleteCommit,
    deleteBranch,
  } = useResumeVersions({
    workingSnapshot,
    notify,
    requestConfirmation,
    applyVersionSnapshot,
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

  const applyImportedTemplate = (template: ImportedTemplate) => {
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
    if (template.resume) setResume(normalizeResumeState(template.resume));
    if (template.moduleOrder)
      setModuleOrder(normalizeSectionOrder(template.moduleOrder));
    if (template.moduleNames)
      setModuleNames({ ...moduleTitles, ...template.moduleNames });
    if (template.summaryTitle) setSummaryTitle(template.summaryTitle);
    if (template.detectedFont) setFont(template.detectedFont);
    setActiveImportedTemplateId(template.id);
    setActiveImportedTemplateName(template.name);
    setImportedTemplateNames((current) => ({
      ...current,
      [template.id]: template.name,
    }));
    window.localStorage.setItem(
      "resume-diy-active-imported-template",
      template.id,
    );
    notify(
      template.resume
        ? `已切换到“${template.name}”，正文可在编辑模板页继续修改`
        : `已应用“${template.name}”的视觉样式`,
    );
  };

  const renameImportedTemplate = (templateId: string, name: string) => {
    setImportedTemplateNames((current) => ({ ...current, [templateId]: name }));
    if (activeImportedTemplateId === templateId)
      setActiveImportedTemplateName(name);
  };

  useEffect(() => {
    if (!activeImportedTemplateId) return;
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
        resumeLayout: {
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
      };
      try {
        writeImportedTemplates(next);
      } catch {
        notify("导入模板同步保存失败，浏览器存储空间可能已满。");
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    activeImportedTemplateId,
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
  const navigateToEditor = useCallback(
    (target: EditorNavigationTarget) => {
      setPanel(null);
      setEditingModule(null);
      setEditSummaryFromHeading(false);
      setTitleEditing(false);
      setWorkspaceView("editor");
      setOpenBasic(target.kind === "basic");
      setSummaryOpen(target.kind === "summary");
      setActiveEditorSection(
        target.kind === "basic"
          ? "basic"
          : target.kind === "summary"
            ? "summary"
            : target.module,
      );
      if (target.kind === "module") {
        const entryIds = target.entryId
          ? [target.entryId]
          : (target.entryIds ?? resume[target.module].map((entry) => entry.id));
        setOpenEntries(Object.fromEntries(entryIds.map((id) => [id, true])));
      } else setOpenEntries({});
      setEditorNavigationTarget(target);
    },
    [resume, setOpenEntries, setPanel],
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
        document.execCommand("copy");
        textarea.remove();
      }
      notify("简历文本已复制");
    } catch {
      notify("复制失败，请检查浏览器权限");
    }
  };

  const exportFileName =
    resumeTitle.trim().replace(/[\\/:*?"<>|]/g, "-") || "resume";

  const exportVersionBackup = (includeDraft: boolean) => {
    const backup = createVersionBackup(
      versionStore,
      includeDraft && hasUncommittedChanges ? workingSnapshot : null,
    );
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${exportFileName}-版本备份-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    notify(
      includeDraft ? "版本备份已导出，包含当前未提交草稿" : "版本备份已导出",
    );
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
    applyVersionSnapshot(snapshot);
    notify("备份中的未提交草稿已载入工作区");
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

  const downloadResume = async (format: "pdf" | "png") => {
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
      await (format === "pdf" ? exportResumeAsPdf : exportResumeAsPng)(
        exportFileName,
      );
      notify(`${label} 已下载`);
    } catch (error) {
      console.error(`${format.toUpperCase()} export failed`, error);
      notify(`${format.toUpperCase()} 生成失败，请稍后重试`);
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

  const editorFontFamily = fontFamilies[font] ?? font;
  const allPreviewBlocks = useMemo(
    () => getPreviewBlocks(moduleOrder, resume),
    [moduleOrder, resume],
  );

  return (
    <div
      className="app-shell"
      style={
        {
          "--accent": theme,
          "--editor-font": editorFontFamily,
        } as CSSProperties
      }
    >
      <AppHeader
        panel={panel}
        setPanel={setPanel}
        resumeTitle={resumeTitle}
        titleEditing={titleEditing}
        saveState={saveState}
        onRetryDraft={retryDraft}
        smartFillEnabled={smartFitActive}
        smartFitPulse={smartFitPulse}
        panelAnchor={panelAnchorRef.current}
        exportingFormat={exportingFormat}
        layout={{
          font,
          fontSize,
          lineHeight: String(Math.round(visibleLineHeight)),
          moduleSpacing: String(Math.round(visibleModuleSpacing)),
          pageMargin,
          theme,
          dateFormat,
          titleFormat,
          separator,
          textAlign,
        }}
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
        onDownloadPng={() => void downloadResume("png")}
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
                  onRequestImport={requestVersionImport}
                  onLoadDraft={loadImportedDraft}
                  onCommit={commitVersion}
                  onCreateBranch={createBranch}
                  onSwitchBranch={switchBranch}
                  onLoadCommit={loadCommit}
                  onDeleteCommit={deleteCommit}
                  onJumpToBranch={jumpToBranch}
                  onDeleteBranch={deleteBranch}
                />
              </Suspense>
            </div>
          ) : workspaceView === "templates" ? (
            <Suspense fallback={workspaceLoading}>
              <TemplateWorkspace
                currentTemplateId={resolvedPresentation.resolvedTemplateId}
                currentPageCount={previewPages.length}
                selectedTemplateId={activeImportedTemplateId}
                onApplyImported={applyImportedTemplate}
                onRenameImported={renameImportedTemplate}
                onBack={() => selectWorkspace("editor")}
              />
            </Suspense>
          ) : workspaceView === "assistant" ? (
            <Suspense fallback={workspaceLoading}>
              <AiAssistantPanel onReturn={() => selectWorkspace("editor")} />
            </Suspense>
          ) : (
            <ResumeEditor
              resume={resume}
              moduleOrder={moduleOrder}
              moduleNames={moduleNames}
              summaryTitle={summaryTitle}
              activeSectionKey={activeEditorSection}
              openBasic={openBasic}
              setOpenBasic={setOpenBasic}
              summaryOpen={summaryOpen}
              setSummaryOpen={setSummaryOpen}
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
          onNavigateToEditor={navigateToEditor}
          onOverflowChange={setPreviewOverflow}
        />
      </main>
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
