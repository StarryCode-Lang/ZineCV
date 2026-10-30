type DraftSaveResult = Awaited<ReturnType<ReturnType<typeof useNativeResumePersistence>["retryDraft"]>>;
type ResolvedPresentation = ReturnType<typeof resolvePresentation>;
import type * as React from "react";
import type { CSSProperties, Dispatch, RefObject, SetStateAction } from "react";
import {
  Suspense
} from "react";
import type { ImportCandidateCorrection } from "../../../../src-tauri/src/domain/bindings/ImportCandidateCorrection";
import type { UpdaterStatus } from "../../../platform/appUpdate";
import type { AgentAnchorSetting, AgentModeSetting, AgentSizeSetting } from "../../../platform/settings";
import {
  type WorkspaceSettings
} from "../../../platform/settings";
import type { DraftSaveState } from "../../../platform/useNativeResumePersistence";
import { useNativeResumePersistence } from "../../../platform/useNativeResumePersistence";
import { AgentOverlay } from "../../agent/AgentOverlay";
import type {
  AgentEditPatch,
  AgentEditTarget,
  AgentReference,
} from "../../agent/types";
import {
  type ImportedTemplate
} from "../../domain/imported-template";
import type {
  BasicInfo, ConfirmAction, Entry, ModuleKey, PreviewBlock, PreviewPageLayout, ResumeLayout, ResumeState,
  SectionKey, SeparatorMode,
} from "../../domain/resume-model";
import {
  resolvePresentation
} from "../../domain/template-model";
import type { ResumeBranch, ResumeCommit, ResumeVersionSnapshot, ResumeVersionStore } from "../../domain/version-model";
import { ResumeEditor } from "../../editor/ResumeEditor";
import { AppHeader, type HeaderPanel } from "../../layout/AppHeader";
import {
  WorkspaceRail,
  type WorkspaceView,
} from "../../layout/WorkspaceRail";
import { DocumentSwitcher } from "./DocumentSwitcher";
import { JobWorkspace, type JobTailoringSelection } from "./JobWorkspace";
import type { DocumentTransition } from "../DocumentWorkspace";
import { ConfirmDialog } from "../../overlays/ConfirmDialog";
import { ImportedSourcePreviewOverlay } from "../../preview/ImportedSourcePreviewOverlay";
import type { PreviewOverflowFinding } from "../../preview/PreviewOverflowGuard";
import { ResumePreviewPane } from "../../preview/ResumePreviewPane";
import type { ImportTarget } from "../../services/import-draft";
import {
  type ResumeVersionBackup
} from "../../services/version-backup";
import type { AppUpdateActionResult } from "../useAppUpdate";
import {
  type EditorNavigationTarget
} from "../useEditorNavigation";
import { TemplateWorkspace, VersionControlPanel, workspaceLoading } from './shared';
export function renderWorkspace(context: {
  jobTailoringRequest?: JobTailoringSelection | null;
  onRequestJobTailoring?: (selection: JobTailoringSelection) => void;
  documentTransitionBusy?: boolean;
  onDocumentTransition?: DocumentTransition;
  appUpdate: { autoBackgroundCheck: boolean; setAutoBackgroundCheck: (enabled: boolean) => void; check: (options?: { silent?: boolean | undefined; } | undefined) => Promise<{ status: UpdaterStatus | null; error?: string | undefined; }>; download: () => Promise<AppUpdateActionResult>; cancelDownload: () => Promise<AppUpdateActionResult>; install: () => Promise<AppUpdateActionResult>; installPending: boolean; };
  bundledBrowserFonts: boolean;
  theme: string;
  editorFontFamily: string;
  workspaceSettingsError: string;
  retryWorkspaceSettings: () => void;
  panel: HeaderPanel;
  setPanel: (next: HeaderPanel, anchor?: HTMLElement | undefined) => void;
  resumeTitle: string;
  titleEditing: boolean;
  saveState: DraftSaveState;
  retryDraft: () => Promise<DraftSaveResult>;
  requestConfirmation: (action: ConfirmAction) => void;
  smartFitActive: boolean;
  smartFitPulse: number;
  panelAnchorRef: RefObject<HTMLElement | null>;
  exportingFormat: "pdf" | "png" | null;
  updateController: { autoBackgroundCheck: boolean; setAutoBackgroundCheck: (enabled: boolean) => void; check: (options?: { silent?: boolean | undefined; } | undefined) => Promise<{ status: UpdaterStatus | null; error?: string | undefined; }>; download: () => Promise<AppUpdateActionResult>; cancelDownload: () => Promise<AppUpdateActionResult>; install: () => Promise<AppUpdateActionResult>; installPending: boolean; } | null;
  makeLayout: (lineHeight: string, moduleSpacing: string) => ResumeLayout;
  visibleLineHeight: number;
  visibleModuleSpacing: number;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  editingModule: ModuleKey | null;
  editSummaryFromHeading: boolean;
  setEditingModule: Dispatch<SetStateAction<ModuleKey | null>>;
  setSummaryTitle: Dispatch<SetStateAction<string>>;
  setModuleNames: Dispatch<SetStateAction<Record<ModuleKey, string>>>;
  showSection: (section: SectionKey) => void;
  hideSection: (section: SectionKey) => void;
  moveSection: (section: SectionKey, direction: 1 | -1) => void;
  setDraggingModule: Dispatch<SetStateAction<SectionKey | null>>;
  reorderModule: (target: SectionKey, finalize?: boolean) => void;
  setResumeTitle: Dispatch<SetStateAction<string>>;
  setTitleEditing: Dispatch<SetStateAction<boolean>>;
  fitOnePage: () => void;
  setFont: Dispatch<SetStateAction<string>>;
  setTheme: Dispatch<SetStateAction<string>>;
  setDateFormat: Dispatch<SetStateAction<"2021年1月" | "2021.01">>;
  dateFormat: "2021年1月" | "2021.01";
  setTitleFormat: Dispatch<SetStateAction<"双行标题" | "单行标题">>;
  titleFormat: "双行标题" | "单行标题";
  setSeparator: Dispatch<SetStateAction<SeparatorMode>>;
  setTextAlign: Dispatch<SetStateAction<"系统默认" | "两端对齐">>;
  textAlign: "系统默认" | "两端对齐";
  applyManualLayoutChange: (setter: (value: string) => void, value: string) => void;
  setFontSize: Dispatch<SetStateAction<string>>;
  setLineHeight: Dispatch<SetStateAction<string>>;
  setModuleSpacing: Dispatch<SetStateAction<string>>;
  setPageMargin: Dispatch<SetStateAction<string>>;
  smartSort: () => void;
  setEditSummaryFromHeading: Dispatch<SetStateAction<boolean>>;
  downloadResume: (format: "pdf" | "png", dpi?: number | undefined) => Promise<void>;
  copyResume: () => Promise<void>;
  resetResume: () => void;
  workspaceRef: RefObject<HTMLElement | null>;
  isResizingPanes: boolean;
  workspaceView: WorkspaceView;
  selectWorkspace: (next: WorkspaceView) => void;
  editorPaneWidth: number;
  versionStore: ResumeVersionStore;
  importedTemplateNames: Record<string, string>;
  storageStatus: string;
  storageBusy: boolean;
  hasUncommittedChanges: boolean;
  exportVersionBackup: (includeDraft: boolean) => Promise<void>;
  exportFullDatabaseBackup: () => Promise<void>;
  requestFullDatabaseRestore: (file: File) => Promise<void>;
  requestVersionImport: (backup: ResumeVersionBackup) => void;
  loadImportedDraft: (snapshot: ResumeVersionSnapshot) => void;
  commitVersion: (message: string) => Promise<boolean>;
  createBranch: (name: string) => Promise<boolean>;
  switchBranch: (branchId: string) => void;
  loadCommit: (commit: ResumeCommit) => void;
  deleteCommit: (commit: ResumeCommit) => void;
  jumpToBranch: (branch: ResumeBranch) => void;
  deleteBranch: (branch: ResumeBranch) => void;
  importLegacyBrowserData: (file: File) => Promise<void>;
  importedTemplateCatalog: ImportedTemplate[];
  resolvedPresentation: ResolvedPresentation;
  previewPages: PreviewPageLayout[];
  activeImportedTemplateId: string | null;
  applyImportedTemplate: (template: ImportedTemplate) => Promise<boolean>;
  prepareImportTarget: () => Promise<ImportTarget>;
  applyImportDraft: (draftId: string, acceptedCandidateIds: string[], corrections: ImportCandidateCorrection[], target: ImportTarget) => Promise<void>;
  setImportedTemplateCatalog: Dispatch<SetStateAction<ImportedTemplate[]>>;
  renameImportedTemplate: (templateId: string, name: string) => void;
  resume: ResumeState;
  richEditorResetKey: number;
  activeEditorSection: SectionKey | "basic";
  collapsedSections: Set<SectionKey | "basic">;
  expandSection: (section: SectionKey | "basic") => void;
  toggleOpenSection: (section: SectionKey | "basic") => void;
  openEntries: Record<string, boolean>;
  updateBasic: (key: keyof BasicInfo, value: string) => void;
  updateAvatar: (file: File) => void;
  commitModuleOrder: (nextOrder: SectionKey[]) => void;
  setResume: Dispatch<SetStateAction<ResumeState>>;
  toggleEntry: (module: ModuleKey, id: string) => void;
  updateEntry: (module: ModuleKey, id: string, patch: Partial<Entry>) => void;
  removeEntry: (module: ModuleKey, id: string) => void;
  addEntry: (module: ModuleKey) => void;
  editorScrollRef: RefObject<HTMLDivElement | null>;
  previewOverflowMessage: string | null;
  navigateToEditor: (target: EditorNavigationTarget) => void;
  paneBounds: { min: number; max: number; };
  beginPaneResize: (event: React.PointerEvent<HTMLDivElement>) => void;
  handlePaneSplitterKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  resetPaneWidth: () => void;
  templateVariant: "side-band" | undefined;
  templateSideBandBackground: string | undefined;
  templateSideBandForeground: string | undefined;
  templateHeadingFontSize: string;
  templateParagraphSpacing: string;
  templateListSpacing: string;
  paginationMeasureRef: RefObject<HTMLDivElement | null>;
  allPreviewBlocks: PreviewBlock[];
  separator: SeparatorMode;
  fontSize: string;
  measurementLineHeight: number;
  pageLetterSpacing: number;
  pagePadding: number;
  measurementModuleGap: number;
  layoutBaseModuleGap: number;
  workspaceSettings: WorkspaceSettings;
  persistPreviewZoom: (percent: number) => void;
  setPreviewOverflow: Dispatch<SetStateAction<PreviewOverflowFinding | null>>;
  sourcePreview: { templateId: string; src: string; baseline: string | null; } | null;
  workingSnapshot: ResumeVersionSnapshot;
  persistAgentLayout: (key: "agentMode" | "agentPosition" | "agentSizes", value: AgentAnchorSetting | AgentSizeSetting | AgentModeSetting) => void;
  applyAgentEdit: ({ target, patch, expectedValue, }: { target: AgentEditTarget; patch: AgentEditPatch; expectedValue: unknown; }) => boolean;
  undoAgentEdit: ({ target, originalValue, expectedValue, }: { target: AgentEditTarget; originalValue: unknown; expectedValue: unknown; }) => boolean;
  navigateToAgentReference: (reference: AgentReference) => void;
  applyVersionSnapshot: (snapshot: ResumeVersionSnapshot) => void;
  databaseBackupOperation: "exporting" | "restoring" | null;
  confirmAction: ConfirmAction | null;
  setConfirmAction: Dispatch<SetStateAction<ConfirmAction | null>>;
  confirmCurrentAction: () => void;
  notice: string;
}): React.ReactNode {
  const {
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
  } = context;
  return ((
    <>
      <div
        className="app-shell"
        inert={appUpdate.installPending || context.documentTransitionBusy || undefined}
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
          updateController={updateController}
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
          <WorkspaceRail activeView={workspaceView} onSelect={selectWorkspace} documentControls={
            <div className="workspace-rail-documents">
              <DocumentSwitcher disabled={isResizingPanes || storageBusy || !!databaseBackupOperation} onTransition={context.onDocumentTransition} />
              <JobWorkspace resume={resume} versions={versionStore} disabled={storageBusy || !!databaseBackupOperation || !!context.documentTransitionBusy || appUpdate.installPending} onCreateBranch={createBranch} onRequestTailoring={context.onRequestJobTailoring} />
            </div>
          } />

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
                {appUpdate.installPending ? workspaceLoading : (
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
                )}
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
          onDocumentTransition={context.onDocumentTransition}
          jobTailoringRequest={context.jobTailoringRequest}
          interactionDisabled={appUpdate.installPending || context.documentTransitionBusy}
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
      {appUpdate.installPending ? (
        <div className="dialog-backdrop" style={{ zIndex: 2147483647 }} aria-busy="true">
          <div className="confirm-dialog" role="status" aria-live="polite">
            <h2>正在准备安装更新</h2>
            <p>正在停止助手任务并保存最新内容，请稍候。保存失败时会返回工作区。</p>
          </div>
        </div>
      ) : null}
    </>
  ));
}
