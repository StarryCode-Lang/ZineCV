import {
  ArrowLeft,
  Check,
  ChevronDown,
  FileImage,
  FileText,
  FileType2,
  LoaderCircle,
  Plus,
  Pencil,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ImportedTemplate } from "../../domain/imported-template";
import {
  readImportedTemplates,
  writeImportedTemplates,
} from "../../domain/imported-template";
import type { KnownTemplateId } from "../../domain/template-model";
import { templateRegistry } from "../../templates/registry";
import { recognizeTemplate } from "../../services/template-import";
import {
  readTemplateLibrary,
  updateTemplateLibrary,
} from "../../domain/template-library";

export function TemplateWorkspace({
  currentTemplateId,
  currentPageCount,
  selectedTemplateId,
  onApplyImported,
  onRenameImported,
  onBack,
}: {
  currentTemplateId: KnownTemplateId;
  currentPageCount: number;
  selectedTemplateId: string | null;
  onApplyImported: (template: ImportedTemplate) => void;
  onRenameImported: (templateId: string, name: string) => void;
  onBack: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [templates, setTemplates] = useState(readImportedTemplates);
  const [library, setLibrary] = useState(readTemplateLibrary);
  const [filter, setFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [selectedId, setSelectedId] = useState(selectedTemplateId ?? "current");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState("");
  const [progressLabel, setProgressLabel] = useState("正在分析…");
  const currentFormat = templateRegistry[currentTemplateId];

  useEffect(() => {
    if (!filterOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!filterRef.current?.contains(event.target as Node))
        setFilterOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFilterOpen(false);
      filterButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [filterOpen]);

  const saveTemplates = (next: ImportedTemplate[]) => {
    writeImportedTemplates(next);
    setTemplates(next);
  };

  const applyTemplate = (template: ImportedTemplate) => {
    try {
      onApplyImported(template);
      setSelectedId(template.id);
      setLibrary(updateTemplateLibrary(template.id, "use"));
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "模板使用记录保存失败",
      );
    }
  };
  const renameTemplate = (template: ImportedTemplate) => {
    const name = draftName.trim();
    if (!name) {
      setError("模板名称不能为空");
      return;
    }
    try {
      const next = readImportedTemplates().map((item) =>
        item.id === template.id ? { ...item, name } : item,
      );
      saveTemplates(next);
      onRenameImported(template.id, name);
      setRenamingId(null);
      setError("");
    } catch {
      setError("模板重命名保存失败，请检查浏览器存储空间");
    }
  };
  const visibleTemplates = templates.filter((template) =>
    filter === "favorites"
      ? library[template.id]?.favorite
      : filter === "recent"
        ? library[template.id]?.lastUsedAt
        : true,
  );
  if (filter === "recent")
    visibleTemplates.sort(
      (a, b) =>
        (library[b.id]?.lastUsedAt ?? 0) - (library[a.id]?.lastUsedAt ?? 0),
    );

  const recognizePendingFile = async () => {
    if (!pendingFile || recognizing) return;
    setRecognizing(true);
    setError("");
    try {
      const imported = await recognizeTemplate(pendingFile, setProgressLabel);
      const next = [imported, ...readImportedTemplates()];
      saveTemplates(next);
      setSelectedId(imported.id);
      setPendingFile(null);
      applyTemplate(imported);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模板识别失败");
    } finally {
      setRecognizing(false);
      setProgressLabel("正在分析…");
    }
  };

  return (
    <div className="template-workspace editor-scroll" data-template-workspace>
      <button className="template-back" type="button" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" /> 返回编辑
      </button>
      <header className="template-workspace-heading">
        <p>Template Library</p>
        <h1>简历模板</h1>
        <span>识别版式与正文，并映射为编辑页可继续修改的模块。</span>
      </header>

      <section className="template-import-panel" aria-label="导入新简历模板">
        <div className="template-import-copy">
          <span className="template-import-icon" aria-hidden="true">
            <Upload size={20} />
          </span>
          <div>
            <strong>导入新简历</strong>
            <span>图片、PDF 或 Word（DOCX），最大 18MB</span>
          </div>
        </div>
        <div className="template-import-types" aria-hidden="true">
          <span>
            <FileImage size={14} /> 图片
          </span>
          <span>
            <FileText size={14} /> PDF
          </span>
          <span>
            <FileType2 size={14} /> Word
          </span>
        </div>
        <button
          className="template-import-action"
          type="button"
          onClick={() => fileInputRef.current?.click()}
        >
          <Plus size={15} /> 选择文件
        </button>
        <input
          ref={fileInputRef}
          type="file"
          hidden
          accept="image/*,.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            setError("");
            setPendingFile(file);
          }}
        />
      </section>

      <div className="template-library-heading">
        <div>
          <strong>已保存模板</strong>
          <span>{templates.length + 1} 个模板</span>
        </div>
        <small>版式密度与标题样式已移至顶部“格式”</small>
      </div>

      <div className="template-library-filter" ref={filterRef}>
        <span>查看模板</span>
        <button
          ref={filterButtonRef}
          type="button"
          aria-label="查看模板"
          aria-haspopup="menu"
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((open) => !open)}
        >
          {{ all: "全部模板", favorites: "已收藏", recent: "最近使用" }[filter]}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        {filterOpen ? (
          <div
            className="template-library-filter-menu"
            role="menu"
            aria-label="模板筛选"
          >
            {(
              [
                ["all", "全部模板"],
                ["favorites", "已收藏"],
                ["recent", "最近使用"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={filter === value}
                onClick={() => {
                  setFilter(value);
                  setFilterOpen(false);
                  filterButtonRef.current?.focus();
                }}
              >
                {label}
                {filter === value ? (
                  <Check size={13} aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {error && !pendingFile ? (
        <p role="alert" className="template-recognition-error">
          {error}
        </p>
      ) : null}
      <div className="template-library-list" role="list" aria-label="简历模板">
        {filter === "all" ? (
          <button
            type="button"
            role="listitem"
            className={`template-library-card ${selectedId === "current" ? "selected" : ""}`}
            aria-pressed={selectedId === "current"}
            onClick={() => setSelectedId("current")}
          >
            <span className="template-library-preview current-template-preview">
              <i />
              <i />
              <i />
              <i />
            </span>
            <span className="template-library-card-copy">
              <small>当前预览</small>
              <strong>我的当前模板</strong>
              <span>
                {currentFormat.name} · {currentPageCount} 页
              </span>
            </span>
            {selectedId === "current" ? <Check size={17} /> : null}
          </button>
        ) : null}

        {visibleTemplates.map((template) => {
          const selected = selectedId === template.id;
          return (
            <div
              className={`template-library-card imported ${selected ? "selected" : ""}`}
              role="listitem"
              key={template.id}
            >
              <button
                className="template-library-select"
                type="button"
                aria-pressed={selected}
                onClick={() => applyTemplate(template)}
              >
                <span className="template-library-preview">
                  {template.previewDataUrl ? (
                    <img src={template.previewDataUrl} alt="" />
                  ) : (
                    <FileText size={28} aria-hidden="true" />
                  )}
                </span>
                <span className="template-library-card-copy">
                  <small>{template.sourceType.toUpperCase()} · 已识别</small>
                  <strong>{template.name}</strong>
                  <span>
                    {template.analysis}
                    {template.recognitionConfidence
                      ? ` · ${
                          template.recognitionConfidence === "high"
                            ? "高置信"
                            : template.recognitionConfidence === "medium"
                              ? "待核对"
                              : "需核对"
                        }`
                      : ""}
                  </span>
                </span>
                {selected ? <Check size={17} /> : null}
              </button>
              <div className="template-library-actions">
                <button
                  className="template-library-rename"
                  type="button"
                  aria-label={`重命名模板 ${template.name}`}
                  title="重命名模板"
                  onClick={() => {
                    setRenamingId(template.id);
                    setDraftName(template.name);
                    setError("");
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="template-library-favorite"
                  type="button"
                  aria-label={`${library[template.id]?.favorite ? "取消收藏" : "收藏模板"} ${template.name}`}
                  aria-pressed={library[template.id]?.favorite === true}
                  title={
                    library[template.id]?.favorite ? "取消收藏" : "收藏模板"
                  }
                  onClick={() => {
                    try {
                      setLibrary(
                        updateTemplateLibrary(template.id, "favorite"),
                      );
                      setError("");
                    } catch {
                      setError("收藏保存失败，请检查浏览器存储空间");
                    }
                  }}
                >
                  <Star
                    size={14}
                    fill={
                      library[template.id]?.favorite ? "currentColor" : "none"
                    }
                  />
                </button>
                <button
                  className="template-library-delete"
                  type="button"
                  aria-label={`删除模板 ${template.name}`}
                  title="删除模板"
                  onClick={() => {
                    try {
                      saveTemplates(
                        readImportedTemplates().filter(
                          (item) => item.id !== template.id,
                        ),
                      );
                      setLibrary(updateTemplateLibrary(template.id, "remove"));
                      if (selected) setSelectedId("current");
                      setError("");
                    } catch {
                      setError(
                        "模板删除或使用记录清理失败，请检查浏览器存储空间",
                      );
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {renamingId === template.id ? (
                <form
                  className="template-library-rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    renameTemplate(template);
                  }}
                >
                  <input
                    aria-label="模板名称"
                    autoFocus
                    maxLength={60}
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                  />
                  <button type="submit">保存</button>
                  <button type="button" onClick={() => setRenamingId(null)}>
                    取消
                  </button>
                </form>
              ) : null}
            </div>
          );
        })}
        {filter !== "all" && visibleTemplates.length === 0 ? (
          <p className="template-library-empty">
            {filter === "favorites"
              ? "还没有收藏的模板"
              : "还没有使用过的导入模板"}
          </p>
        ) : null}
      </div>

      {pendingFile
        ? createPortal(
            <div className="template-recognition-backdrop" role="presentation">
              <section
                className="template-recognition-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="template-recognition-title"
              >
                <button
                  className="template-recognition-close"
                  type="button"
                  aria-label="关闭"
                  disabled={recognizing}
                  onClick={() => setPendingFile(null)}
                >
                  <X size={16} />
                </button>
                <span className="template-recognition-file" aria-hidden="true">
                  <FileText size={24} />
                </span>
                <h2 id="template-recognition-title">识别为简历模板？</h2>
                <p>
                  将分析“{pendingFile.name}
                  ”的版式、字体和全部文字，并映射到当前编辑器允许修改的字段。识别并保存后，会切换为这份简历的可编辑内容。
                </p>
                {error ? (
                  <div className="template-recognition-error">{error}</div>
                ) : null}
                <div className="template-recognition-actions">
                  <button
                    type="button"
                    disabled={recognizing}
                    onClick={() => setPendingFile(null)}
                  >
                    不识别
                  </button>
                  <button
                    className="primary"
                    type="button"
                    disabled={recognizing}
                    onClick={() => void recognizePendingFile()}
                  >
                    {recognizing ? (
                      <>
                        <LoaderCircle className="spin" size={15} />{" "}
                        {progressLabel}
                      </>
                    ) : (
                      "识别并保存"
                    )}
                  </button>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
