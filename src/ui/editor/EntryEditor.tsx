import {
  ChevronDown,
  ChevronUp,
  Edit3,
  FileText,
  GripVertical,
  Maximize2,
  Minimize2,
  Trash2,
} from "lucide-react";
import { useMemo } from "react";
import type { Entry, ModuleKey } from "../domain/resume-model";
import { monthLabel, sanitizeRichHtml, stripHtml } from "../utils/resume";

import { Field, SelectField } from "./FormField";
import { RichEditor } from "./RichEditor";
import { AnimatedCollapse } from "./AnimatedCollapse";
import type { EntryDragHandleProps } from "./SortableEntryList";

// 单段经历编辑器，根据模块类型切换教育、技能或通用字段。
export function EntryEditor({
  module,
  moduleLabel,
  entry,
  open,
  onToggle,
  onChange,
  onDelete,
  richEditorResetKey,
  dragHandle,
  dragging = false,
}: {
  module: ModuleKey;
  moduleLabel: string;
  entry: Entry;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<Entry>) => void;
  onDelete: () => void;
  richEditorResetKey: string | number;
  dragHandle?: EntryDragHandleProps;
  dragging?: boolean;
}) {
  // education 模块走 educationForm 专用表单；labels 只服务通用字段行。
  const labels: Array<[string, "title" | "role" | "department" | "city"]> =
    module === "work"
      ? [["公司名称", "title"], ["职位名称", "role"], ["所在部门", "department"], ["所在城市", "city"]]
      : module === "orgs"
        ? [["组织/活动名称", "title"], ["你的角色", "role"], ["所在部门", "department"], ["所在城市", "city"]]
        : [["经历名称", "title"], ["你的角色", "role"], ["所在部门", "department"], ["所在城市", "city"]];
  const compact =
    module === "skills" ||
    (!entry.start && !entry.end && entry.html === "<p><br></p>");
  const richOnly = module === "skills";
  const displayTitle = richOnly ? "技能内容" : entry.title || "未命名经历";
  const titleIsEmpty = !richOnly && !entry.title;
  const entryLabel = moduleLabel || "经历";
  const expandLabel = open
    ? `收起并编辑${entryLabel}`
    : `展开编辑${entryLabel}`;
  // 折叠摘要只需随 html 变化重算；stripHtml 的 DOMParser 解析是击键热路径
  // 上每个条目各一次的确定成本，未变更条目经 memo 跳过。
  const contentSummaryText = useMemo(
    () => stripHtml(sanitizeRichHtml(entry.html)),
    [entry.html],
  );
  const dateRange = [monthLabel(entry.start), monthLabel(entry.end)]
    .filter(Boolean)
    .join(" - ");
  const compactMeta = richOnly
    ? contentSummaryText
      ? "已填写技能内容"
      : "尚未填写"
    : [dateRange, entry.role].filter(Boolean).join(" · ") ||
      (contentSummaryText ? "已填写内容" : "尚未填写");
  const educationForm = (
    <>
      <Field
        label="学校名称"
        value={entry.title}
        placeholder="请输入学校名称"
        onChange={(value) => onChange({ title: value })}
      />
      <Field
        label="专业"
        value={entry.role}
        placeholder="请输入专业名称"
        onChange={(value) => onChange({ role: value })}
      />
      <SelectField
        label="学历"
        value={entry.department || "本科"}
        options={["中专", "高中", "大专", "本科", "硕士", "博士", "MBA"]}
        onChange={(value) => onChange({ department: value })}
      />
      <SelectField
        label="培养方式"
        value={entry.mode ?? "全日制"}
        options={["全日制", "非全日制", "交换/交流"]}
        onChange={(value) => onChange({ mode: value })}
      />
      <Field
        label="学院"
        value={entry.college ?? ""}
        placeholder="请输入"
        onChange={(value) => onChange({ college: value })}
      />
      <Field
        label="所在城市"
        value={entry.city}
        placeholder="请输入"
        onChange={(value) => onChange({ city: value })}
      />
    </>
  );
  return (
    <article
      className={`entry-card ${compact ? "compact-entry" : ""} ${open ? "expanded" : ""} ${dragging ? "entry-dragging" : ""}`}
      data-editor-entry-id={entry.id}
    >
      <div
        className="entry-header"
        data-editor-focus="entry"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={(event) => {
          if (!(event.target as Element).closest("button")) onToggle();
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="entry-heading-wrap">
          {dragHandle ? <button
            className="icon-button entry-sort-handle"
            type="button"
            aria-label="拖动经历排序"
            aria-description="拖动调整顺序，或使用上下方向键移动经历"
            title="拖动排序；上下方向键移动"
            {...dragHandle}
          ><GripVertical size={14} aria-hidden="true" /></button> : null}
          <button
            className="entry-expand-affordance"
            type="button"
            aria-label={open ? "收起经历" : "展开经历"}
            aria-description={expandLabel}
            title={expandLabel}
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? (
              <Minimize2 size={14} aria-hidden="true" />
            ) : (
              <Maximize2 size={14} aria-hidden="true" />
            )}
          </button>
          <div
            className={`entry-heading-main ${
              module === "education" ? "entry-heading-education" : ""
            } ${richOnly ? "entry-heading-rich" : ""}`}
          >
            <strong
              className={titleIsEmpty ? "entry-heading-empty" : undefined}
              title={displayTitle}
              aria-label={displayTitle}
              tabIndex={
                titleIsEmpty || displayTitle.length > 24 ? 0 : undefined
              }
            >
              {displayTitle}
            </strong>
            {!open ? (
              <span className="entry-heading-meta" title={compactMeta}>
                {compactMeta}
              </span>
            ) : null}
          </div>
        </div>
        <div className="entry-actions">
          <button
            className="icon-button danger secondary-danger"
            aria-label="删除经历"
            aria-description={`删除${entryLabel}`}
            title={`删除${entryLabel}`}
            onClick={onDelete}
          >
            <Trash2 size={15} />
          </button>
          <button
            className="icon-button entry-collapse-button"
            aria-label={open ? "收起条目" : "展开条目"}
            aria-hidden="true"
            tabIndex={-1}
            title={open ? `收起${entryLabel}` : `展开${entryLabel}`}
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>
      <AnimatedCollapse open={open}>
        <div className={`entry-form ${richOnly ? "rich-only-form" : ""}`}>
          {!richOnly ? (
            <>
              <div className="editor-form-title">
                <Edit3 size={14} />
                <span>基础信息</span>
              </div>
              <div className="form-grid">
                {module === "education"
                  ? educationForm
                  : labels.map(([label, field]) => (
                      <Field
                        key={label}
                        label={label}
                        value={entry[field]}
                        placeholder={field === "department" ? "选填" : "请输入"}
                        onChange={(value) => onChange({ [field]: value } as Partial<Entry>)}
                      />
                    ))}
              </div>
              <div className="date-grid">
                <Field
                  label={module === "education" ? "在读时间" : "经历时间"}
                  type="month"
                  value={entry.start}
                  placeholder="请选择开始日期"
                  onChange={(value) => onChange({ start: value })}
                />
                <Field
                  label="结束时间"
                  type="month"
                  value={entry.end}
                  placeholder="请选择结束日期"
                  onChange={(value) => onChange({ end: value })}
                />
              </div>
            </>
          ) : null}
          <div className="editor-form-title content-title">
            <FileText size={14} />
            <span>{richOnly ? "专业技能内容" : "内容描述"}</span>
          </div>
          <RichEditor
            value={entry.html}
            onChange={(html) => onChange({ html })}
            fieldKey={`${module}:${entry.id}`}
            resetKey={richEditorResetKey}
          />
        </div>
      </AnimatedCollapse>
    </article>
  );
}

// Tiptap 保持选区和本地历史；持久化仍由外层原生文档命令队列负责。
