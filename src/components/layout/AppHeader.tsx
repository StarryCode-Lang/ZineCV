import { FloatingSurface } from "../overlays/FloatingSurface";
import type { Dispatch, SetStateAction } from "react";
import {
  AlignJustify,
  Box,
  ChevronDown,
  Download,
  Edit3,
  Save,
  SlidersHorizontal,
  WandSparkles,
} from "lucide-react";
import type {
  ModuleKey,
  SectionKey,
  ResumeLayout as LayoutState,
} from "../../domain/resume-model";
import type { KnownTemplateId } from "../../domain/template-model";
import { DownloadMenu } from "../overlays/DownloadMenu";
import { ModuleManager } from "../overlays/ModuleManager";
import {
  LayoutSettingsPanel,
  type LayoutPanelMode,
} from "../toolbar/LayoutSettingsPanel";
import { ToolbarButton } from "../toolbar/ToolbarControls";

export type HeaderPanel = LayoutPanelMode | "manager" | "download" | null;

type ModuleManagerState = {
  order: SectionKey[];
  names: Record<ModuleKey, string>;
  summaryTitle: string;
  editingModule: ModuleKey | null;
  editSummaryOnOpen: boolean;
  setEditingModule: (module: ModuleKey | null) => void;
  setSummaryTitle: (title: string) => void;
  setModuleNames: Dispatch<SetStateAction<Record<ModuleKey, string>>>;
  onShowSection: (section: SectionKey) => void;
  onHideSection: (section: SectionKey) => void;
  onMoveSection: (section: SectionKey, direction: -1 | 1) => void;
  onDragStart: (module: SectionKey) => void;
  onMove: (module: SectionKey) => void;
  onDrop: (module: SectionKey) => void;
};

// 顶部栏的唯一修改入口：控制按钮数量、顺序以及四个下拉面板。
export function AppHeader({
  panel,
  setPanel,
  resumeTitle,
  titleEditing,
  saveLabel,
  onRetryDraft,
  smartFillEnabled,
  smartFitPulse,
  formatPresetId,
  panelAnchor,
  exportingFormat,
  contentActionsDisabled = false,
  layout,
  modules,
  onResumeTitleChange,
  onTitleEditingChange,
  onToggleSmartFill,
  onFormatPresetChange,
  onLayoutChange,
  onSmartSort,
  onOpenModuleManager,
  onDownloadPdf,
  onDownloadPng,
  onCopy,
  onReset,
}: {
  panel: HeaderPanel;
  setPanel: (panel: HeaderPanel, anchor?: HTMLElement) => void;
  resumeTitle: string;
  titleEditing: boolean;
  saveLabel: string;
  onRetryDraft: () => void;
  smartFillEnabled: boolean;
  smartFitPulse: number;
  formatPresetId: KnownTemplateId;
  panelAnchor: HTMLElement | null;
  exportingFormat: "pdf" | "png" | null;
  contentActionsDisabled?: boolean;
  layout: LayoutState;
  modules: ModuleManagerState;
  onResumeTitleChange: (title: string) => void;
  onTitleEditingChange: (editing: boolean) => void;
  onToggleSmartFill: () => void;
  onFormatPresetChange: (templateId: KnownTemplateId) => void;
  onLayoutChange: (key: keyof LayoutState, value: string) => void;
  onSmartSort: () => void;
  onOpenModuleManager: () => void;
  onDownloadPdf: () => void;
  onDownloadPng: () => void;
  onCopy: () => void;
  onReset: () => void;
}) {
  const togglePanel = (next: Exclude<HeaderPanel, null>, anchor: HTMLElement) =>
    setPanel(panel === next ? null : next, anchor);

  return (
    <header className="topbar">
      <div className="brand-side" data-header-group="identity">
        <div className="brand-context">
          <span className="brand-mark" aria-hidden="true">
            R
          </span>
          <div className="brand-copy">
            <span className="brand-product">Resume DIY</span>
            <span className="back-block">我的简历</span>
          </div>
        </div>
        <div className="resume-title-group">
          {titleEditing ? (
            <input
              className="resume-title-input"
              autoFocus
              value={resumeTitle}
              aria-label="简历名称"
              disabled={contentActionsDisabled}
              onChange={(event) => onResumeTitleChange(event.target.value)}
              onBlur={() => onTitleEditingChange(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "Escape")
                  onTitleEditingChange(false);
              }}
            />
          ) : (
            <button
              className="resume-title"
              title="编辑简历名称"
              disabled={contentActionsDisabled}
              onClick={() => onTitleEditingChange(true)}
            >
              {resumeTitle}
            </button>
          )}
          <button
            className="title-edit-icon"
            aria-label="编辑简历名称"
            title="编辑简历名称"
            disabled={contentActionsDisabled}
            onClick={() => onTitleEditingChange(true)}
          >
            <Edit3 size={13} />
          </button>
        </div>
        <div
          className={`save-state ${saveLabel.includes("失败") ? "save-state-failed" : ""}`}
          aria-live="polite"
        >
          <Save size={14} /> {saveLabel}
          {saveLabel.includes("失败") ? (
            <button
              type="button"
              className="save-retry"
              aria-label="重试保存浏览器草稿"
              onClick={onRetryDraft}
            >
              重试
            </button>
          ) : null}
        </div>
      </div>

      <div className="toolbar" data-header-group="tools">
        <div
          className="toolbar-group toolbar-layout-group"
          data-toolbar-group="layout"
          aria-label="排版工具"
        >
          <ToolbarButton
            key={smartFitPulse}
            className={`smart-fill-toggle ${smartFitPulse ? "smart-fill-pulse" : ""}`}
            icon={<WandSparkles size={15} />}
            label="智能一页"
            active={smartFillEnabled}
            tooltip={
              smartFillEnabled
                ? "关闭后保留当前智能排版"
                : "协调适配字号、行距、模块间距和页距并铺满一张 A4"
            }
            onClick={onToggleSmartFill}
          />
          <ToolbarButton
            endIcon={<ChevronDown size={13} />}
            label={layout.font}
            tooltip="选择简历字体"
            expanded={panel === "font"}
            onClick={(anchor) => togglePanel("font", anchor)}
          />
          <ToolbarButton
            endIcon={<ChevronDown size={13} />}
            label={`${layout.fontSize}px`}
            tooltip="调整正文基准字号"
            expanded={panel === "fontSize"}
            onClick={(anchor) => togglePanel("fontSize", anchor)}
          />
          <ToolbarButton
            icon={<AlignJustify size={15} />}
            endIcon={<ChevronDown size={13} />}
            label={`${layout.lineHeight}px`}
            ariaLabel="间距"
            tooltip="调整行距、模块间距和页边距"
            expanded={panel === "spacing"}
            onClick={(anchor) => togglePanel("spacing", anchor)}
          />
          <ToolbarButton
            icon={<SlidersHorizontal size={15} />}
            endIcon={<ChevronDown size={13} />}
            label="格式"
            tooltip="调整格式与颜色"
            expanded={panel === "format"}
            onClick={(anchor) => togglePanel("format", anchor)}
          />
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <div
          className="toolbar-group toolbar-module-group"
          data-toolbar-group="modules"
          aria-label="模块工具"
        >
          <ToolbarButton
            className="manager-trigger"
            icon={<Box size={19} />}
            label="模块管理"
            endIcon={<ChevronDown size={13} />}
            tooltip="管理模块顺序与显示"
            disabled={contentActionsDisabled}
            expanded={panel === "manager"}
            onClick={(anchor) => {
              if (panel !== "manager") onOpenModuleManager();
              togglePanel("manager", anchor);
            }}
          />
        </div>
      </div>

      <div className="top-actions">
        <button
          type="button"
          className="action-pill export-trigger"
          aria-label="导出"
          title="导出 PDF、PNG 或复制文本"
          aria-expanded={panel === "download"}
          disabled={contentActionsDisabled}
          onClick={(event) => togglePanel("download", event.currentTarget)}
        >
          <Download size={15} />
          导出 <ChevronDown size={14} />
        </button>
      </div>

      {panel ? (
        <FloatingSurface
          key={panel}
          anchor={panelAnchor}
          onClose={() => setPanel(null)}
        >
          {panel === "font" ||
          panel === "fontSize" ||
          panel === "spacing" ||
          panel === "format" ? (
            <LayoutSettingsPanel
              mode={panel}
              {...layout}
              formatPresetId={formatPresetId}
              onFontChange={(value) => onLayoutChange("font", value)}
              onFontSizeChange={(value) => onLayoutChange("fontSize", value)}
              onLineHeightChange={(value) =>
                onLayoutChange("lineHeight", value)
              }
              onModuleSpacingChange={(value) =>
                onLayoutChange("moduleSpacing", value)
              }
              onPageMarginChange={(value) =>
                onLayoutChange("pageMargin", value)
              }
              onThemeChange={(value) => onLayoutChange("theme", value)}
              onDateChange={(value) => onLayoutChange("dateFormat", value)}
              onTitleChange={(value) => onLayoutChange("titleFormat", value)}
              onSeparatorChange={(value) => onLayoutChange("separator", value)}
              onAlignChange={(value) => onLayoutChange("textAlign", value)}
              onSmartSort={onSmartSort}
              onFormatPresetChange={onFormatPresetChange}
              onClose={() => setPanel(null)}
            />
          ) : null}
          {panel === "manager" ? (
            <ModuleManager
              moduleOrder={modules.order}
              moduleNames={modules.names}
              summaryTitle={modules.summaryTitle}
              editingModule={modules.editingModule}
              editSummaryOnOpen={modules.editSummaryOnOpen}
              setEditingModule={modules.setEditingModule}
              setSummaryTitle={modules.setSummaryTitle}
              setModuleNames={modules.setModuleNames}
              onShowSection={modules.onShowSection}
              onHideSection={modules.onHideSection}
              onMoveSection={modules.onMoveSection}
              onDragStart={modules.onDragStart}
              onMove={modules.onMove}
              onDrop={modules.onDrop}
              onClose={() => setPanel(null)}
            />
          ) : null}
          {panel === "download" ? (
            <DownloadMenu
              exporting={exportingFormat}
              onPdf={onDownloadPdf}
              onPng={onDownloadPng}
              onCopy={onCopy}
              onReset={onReset}
            />
          ) : null}
        </FloatingSurface>
      ) : null}
    </header>
  );
}
