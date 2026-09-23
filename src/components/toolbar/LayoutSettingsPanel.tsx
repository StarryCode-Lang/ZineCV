import {
  AlignJustify,
  CalendarDays,
  ListOrdered,
  Palette,
  SlidersHorizontal,
  Type,
  WandSparkles,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import type { SeparatorMode } from "../../domain/resume-model";
import type { KnownTemplateId } from "../../domain/template-model";
import { listTemplates } from "../../templates/registry";

export type LayoutPanelMode = "font" | "fontSize" | "spacing" | "format";

// 排版选项拆成四个小面板，面板只覆盖左侧编辑区，调整时可完整观察右侧预览。
export function LayoutSettingsPanel({
  mode,
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
  formatPresetId,
  onFontChange,
  onFontSizeChange,
  onLineHeightChange,
  onModuleSpacingChange,
  onPageMarginChange,
  onThemeChange,
  onDateChange,
  onTitleChange,
  onSeparatorChange,
  onAlignChange,
  onSmartSort,
  onFormatPresetChange,
  onClose,
}: {
  mode: LayoutPanelMode;
  font: string;
  fontSize: string;
  lineHeight: string;
  moduleSpacing: string;
  pageMargin: string;
  theme: string;
  dateFormat: "2021年1月" | "2021.01";
  titleFormat: "双行标题" | "单行标题";
  separator: SeparatorMode;
  textAlign: "系统默认" | "两端对齐";
  formatPresetId: KnownTemplateId;
  onFontChange: (value: string) => void;
  onFontSizeChange: (value: string) => void;
  onLineHeightChange: (value: string) => void;
  onModuleSpacingChange: (value: string) => void;
  onPageMarginChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onDateChange: (value: "2021年1月" | "2021.01") => void;
  onTitleChange: (value: "双行标题" | "单行标题") => void;
  onSeparatorChange: (value: SeparatorMode) => void;
  onAlignChange: (value: "系统默认" | "两端对齐") => void;
  onSmartSort: () => void;
  onFormatPresetChange: (templateId: KnownTemplateId) => void;
  onClose: () => void;
}) {
  const titles: Record<LayoutPanelMode, [string, string]> = {
    font: ["简历字体", "选择整份简历使用的字体"],
    fontSize: ["正文字号", "调整正文基准字号；模块标题沿用现有样式"],
    spacing: ["间距设置", "数值与 A4 中的实际像素一致"],
    format: ["格式与颜色", "调整日期、标题、对齐和模块颜色"],
  };
  const colors = [
    "#000000",
    "#ca3832",
    "#ee8732",
    "#4183ff",
    "#9c5bde",
    "#6db557",
  ];

  return (
    <div
      className={`floating-panel layout-settings-panel ${mode}-settings-panel`}
      role="dialog"
      aria-label={titles[mode][0]}
    >
      <div className="panel-heading compact-panel-heading">
        <div>
          <h3 className="floating-title">{titles[mode][0]}</h3>
          <p>{titles[mode][1]}</p>
        </div>
        <button className="panel-close" aria-label="关闭设置" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {mode === "font" ? (
        <div className="layout-choice-grid font-choice-grid">
          {["宋体", "雅黑", "黑体", "楷体", "仿宋"].map((option) => (
            <button
              key={option}
              className={font === option ? "active" : ""}
              aria-pressed={font === option}
              onClick={() => onFontChange(option)}
            >
              <Type size={14} /> {option}
            </button>
          ))}
        </div>
      ) : null}

      {mode === "fontSize" ? (
        <div className="layout-choice-grid size-choice-grid">
          {Array.from({ length: 9 }, (_, index) => String(index + 10)).map(
            (option) => (
              <button
                key={option}
                className={fontSize === option ? "active" : ""}
                aria-pressed={fontSize === option}
                onClick={() => onFontSizeChange(option)}
              >
                {option}px
              </button>
            ),
          )}
        </div>
      ) : null}

      {mode === "spacing" ? (
        <div className="compact-spacing-list">
          <SettingSelect
            icon={<AlignJustify size={15} />}
            label="正文行距"
            value={lineHeight}
            options={Array.from({ length: 17 }, (_, index) =>
              String(index + 12),
            )}
            suffix="px"
            onChange={onLineHeightChange}
          />
          <SettingSelect
            icon={<ListOrdered size={15} />}
            label="模块间距"
            value={moduleSpacing}
            options={Array.from({ length: 31 }, (_, index) => String(index))}
            suffix="px"
            onChange={onModuleSpacingChange}
          />
          <SettingSelect
            icon={<CalendarDays size={15} />}
            label="四边页距"
            value={pageMargin}
            options={Array.from({ length: 31 }, (_, index) =>
              String(index + 20),
            )}
            suffix="px"
            onChange={onPageMarginChange}
          />
        </div>
      ) : null}

      {mode === "format" ? (
        <>
          <section className="compact-format-section">
            <h4>
              <SlidersHorizontal size={14} /> 版式风格
            </h4>
            <div className="format-preset-grid">
              {listTemplates().map((format) => (
                <button
                  key={format.id}
                  type="button"
                  className={formatPresetId === format.id ? "active" : ""}
                  aria-pressed={formatPresetId === format.id}
                  onClick={() => onFormatPresetChange(format.id)}
                >
                  <strong>{format.name}</strong>
                  <span>{format.description}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="compact-format-section">
            <h4>
              <Palette size={14} /> 模块图标颜色
            </h4>
            <div className="layout-theme-row">
              {colors.map((color) => (
                <button
                  key={color}
                  className={`layout-theme-swatch ${theme === color ? "selected" : ""}`}
                  style={{ backgroundColor: color }}
                  aria-label={`使用颜色 ${color}`}
                  aria-pressed={theme === color}
                  onClick={() => onThemeChange(color)}
                />
              ))}
              <label className="layout-custom-color">
                <input
                  type="color"
                  value={theme}
                  aria-label="自定义模块图标颜色"
                  onChange={(event) => onThemeChange(event.target.value)}
                />
                自定义
              </label>
            </div>
          </section>
          <section className="compact-format-section">
            <h4>
              <SlidersHorizontal size={14} /> 内容格式
            </h4>
            <FormatRow label="日期">
              <SegmentedChoice
                value={dateFormat}
                options={["2021年1月", "2021.01"]}
                onChange={(value) => onDateChange(value as typeof dateFormat)}
              />
            </FormatRow>
            <FormatRow label="标题">
              <SegmentedChoice
                value={titleFormat}
                options={["双行标题", "单行标题"]}
                onChange={(value) => onTitleChange(value as typeof titleFormat)}
              />
            </FormatRow>
            <FormatRow label="分隔符">
              <SegmentedChoice
                value={separator}
                options={["使用分隔符号", "不使用分隔符号"]}
                onChange={(value) => onSeparatorChange(value as SeparatorMode)}
              />
            </FormatRow>
            <FormatRow label="正文">
              <SegmentedChoice
                value={textAlign}
                options={["系统默认", "两端对齐"]}
                onChange={(value) => onAlignChange(value as typeof textAlign)}
              />
            </FormatRow>
          </section>
          <button className="layout-sort-action" onClick={onSmartSort}>
            <WandSparkles size={15} /> 按结束时间智能排序经历
          </button>
        </>
      ) : null}
    </div>
  );
}

function SettingSelect({
  icon,
  label,
  value,
  options,
  suffix = "",
  onChange,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  options: string[];
  suffix?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="layout-setting-field">
      <span>
        {icon}
        {label}
      </span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option value={option} key={option}>
            {option}
            {suffix}
          </option>
        ))}
      </select>
    </label>
  );
}

function FormatRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="layout-format-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

function SegmentedChoice({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="layout-segmented">
      {options.map((option) => (
        <button
          key={option}
          className={value === option ? "active" : ""}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
