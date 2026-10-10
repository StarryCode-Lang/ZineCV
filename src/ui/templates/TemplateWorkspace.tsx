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
import type { ImportCandidate } from "../../../src-tauri/src/domain/bindings/ImportCandidate";
import type { ImportDraft } from "../../../src-tauri/src/domain/bindings/ImportDraft";
import type { ImportedTemplate } from "../domain/imported-template";
import {
  readImportedTemplates,
  writeImportedTemplates,
} from "../domain/imported-template";
import type { KnownTemplateId } from "../domain/template-model";
import { templateRegistry } from "./registry";
import { recognizeTemplate } from "../services/template-import";
import {
  cancelImportReviewDraft,
  createImportReviewDraft,
  type ImportTarget,
} from "../services/import-draft";
import { hasDocumentRuntime as isTauriRuntime } from "../../platform/ipc";
import {
  readTemplateLibrary,
  updateTemplateLibrary,
} from "../domain/template-library";

export function TemplateWorkspace({
  importedTemplates,
  currentTemplateId,
  currentPageCount,
  selectedTemplateId,
  onApplyImported,
  prepareImportTarget,
  onApplyImport,
  onTemplatesChange,
  onRenameImported,
  onBack,
}: {
  importedTemplates: ImportedTemplate[];
  currentTemplateId: KnownTemplateId;
  currentPageCount: number;
  selectedTemplateId: string | null;
  onApplyImported: (template: ImportedTemplate) => Promise<boolean>;
  prepareImportTarget: () => Promise<ImportTarget>;
  onApplyImport: (
    draftId: string,
    acceptedCandidateIds: string[],
    target: ImportTarget,
  ) => Promise<void>;
  onTemplatesChange?: (templates: ImportedTemplate[]) => void;
  onRenameImported: (templateId: string, name: string) => void;
  onBack: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const [templates, setTemplates] = useState(importedTemplates);
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
  const [reviewImport, setReviewImport] = useState<{
    draft: ImportDraft;
    previewDataUrl: string;
    target: ImportTarget;
  } | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [applyingImport, setApplyingImport] = useState(false);
  const importAbort = useRef<AbortController | null>(null);
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

  const saveTemplates = async (next: ImportedTemplate[]) => {
    const saved = await writeImportedTemplates(next);
    setTemplates(saved);
    onTemplatesChange?.(saved);
  };

  const applyTemplate = async (template: ImportedTemplate) => {
    try {
      if (!(await onApplyImported(template))) return;
      setSelectedId(template.id);
      setLibrary(await updateTemplateLibrary(template.id, "use"));
      setError("");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "模板使用记录保存失败",
      );
    }
  };
  const renameTemplate = async (template: ImportedTemplate) => {
    const name = draftName.trim();
    if (!name) {
      setError("模板名称不能为空");
      return;
    }
    try {
      const next = readImportedTemplates().map((item) =>
        item.id === template.id ? { ...item, name } : item,
      );
      await saveTemplates(next);
      onRenameImported(template.id, name);
      setRenamingId(null);
      setError("");
    } catch {
      setError("模板重命名保存失败，请检查本地存储");
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
    // 与审阅路径共用 importAbort：取消解析时中止识别、阻止后续保存与应用，
    // 识别管线内部（worker/PDF/OCR）在 abort 时自行释放资源。
    const controller = new AbortController();
    importAbort.current = controller;
    setRecognizing(true);
    setError("");
    try {
      const imported = await recognizeTemplate(
        pendingFile,
        setProgressLabel,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const next = [imported, ...readImportedTemplates()];
      await saveTemplates(next);
      if (controller.signal.aborted) return;
      setSelectedId(imported.id);
      setPendingFile(null);
      await applyTemplate(imported);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "模板识别失败");
    } finally {
      if (importAbort.current === controller) importAbort.current = null;
      setRecognizing(false);
      setProgressLabel("正在分析…");
    }
  };

  const reviewPendingFile = async () => {
    if (!pendingFile || recognizing || !isTauriRuntime()) return;
    const controller = new AbortController();
    importAbort.current = controller;
    setRecognizing(true);
    setError("");
    try {
      const target = await prepareImportTarget();
      const result = await createImportReviewDraft(
        pendingFile,
        setProgressLabel,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setReviewImport({ ...result, target });
      setSelectedCandidateIds(
        result.draft.candidates
          .filter((candidate) => candidate.evidence.confidence !== "low")
          .map((candidate) => candidate.id),
      );
      setPendingFile(null);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(reason instanceof Error ? reason.message : "导入审阅准备失败");
    } finally {
      if (importAbort.current === controller) importAbort.current = null;
      setRecognizing(false);
      setProgressLabel("正在分析…");
    }
  };

  const cancelReviewImport = async () => {
    const current = reviewImport;
    if (!current || applyingImport) return;
    try {
      await cancelImportReviewDraft(current.draft);
      setReviewImport(null);
      setSelectedCandidateIds([]);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取消导入失败");
    }
  };

  const applyReviewImport = async () => {
    if (!reviewImport || !selectedCandidateIds.length || applyingImport) return;
    setApplyingImport(true);
    setError("");
    try {
      await onApplyImport(
        reviewImport.draft.id,
        selectedCandidateIds,
        reviewImport.target,
      );
      setReviewImport(null);
      setSelectedCandidateIds([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "应用导入候选失败");
    } finally {
      setApplyingImport(false);
    }
  };

  const candidateDescription = (candidate: ImportCandidate) => {
    switch (candidate.value.type) {
      case "basicField":
        return candidate.value.value;
      case "sectionEntries":
        return `${candidate.value.entries.length} 条经历；确认后追加到“${candidate.value.title}”`;
      case "summaryBody":
        return candidate.evidence.excerpt || "导入的自我评价正文";
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
                onClick={() => void applyTemplate(template)}
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
                  {template.previewRecoveryWarning ? (
                    <span role="status">{template.previewRecoveryWarning}</span>
                  ) : null}
                  {template.revisionStatus === "fallback" ||
                  template.revisionStatus === "unknown" ? (
                    <span role="status">模板修订将使用当前渲染器回退</span>
                  ) : null}
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
                  onClick={async () => {
                    try {
                      setLibrary(
                        await updateTemplateLibrary(template.id, "favorite"),
                      );
                      setError("");
                    } catch {
                      setError("收藏保存失败，请检查本地存储");
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
                  onClick={async () => {
                    try {
                      await saveTemplates(
                        readImportedTemplates().filter(
                          (item) => item.id !== template.id,
                        ),
                      );
                      setLibrary(await updateTemplateLibrary(template.id, "remove"));
                      if (selected) setSelectedId("current");
                      setError("");
                    } catch {
                      setError(
                        "模板删除或使用记录清理失败，请检查本地存储",
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
                  onClick={() => {
                    if (importAbort.current) importAbort.current.abort();
                    else setPendingFile(null);
                  }}
                >
                  <X size={16} />
                </button>
                <span className="template-recognition-file" aria-hidden="true">
                  <FileText size={24} />
                </span>
                <h2 id="template-recognition-title">识别为简历模板？</h2>
                <p>
                  将分析“{pendingFile.name}
                  ”的版式、字体和文字。保存为模板会保留原有导入行为；内容审阅则只提出候选，逐项确认后才追加到当前简历。
                </p>
                {error ? (
                  <div className="template-recognition-error">{error}</div>
                ) : null}
                <div className="template-recognition-actions">
                  <button
                    type="button"
                    onClick={() => {
                      if (importAbort.current) importAbort.current.abort();
                      else setPendingFile(null);
                    }}
                  >
                    {recognizing ? "取消解析" : "不识别"}
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
                  {isTauriRuntime() ? (
                    <button
                      type="button"
                      disabled={recognizing}
                      onClick={() => void reviewPendingFile()}
                    >
                      {recognizing ? (
                        <>
                          <LoaderCircle className="spin" size={15} /> {progressLabel}
                        </>
                      ) : (
                        "提取并审阅候选"
                      )}
                    </button>
                  ) : null}
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
      {reviewImport
        ? createPortal(
            <div className="template-recognition-backdrop" role="presentation">
              <section
                className="template-recognition-dialog template-import-review-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="import-review-title"
              >
                <button
                  className="template-recognition-close"
                  type="button"
                  aria-label="取消导入审阅"
                  disabled={applyingImport}
                  onClick={() => void cancelReviewImport()}
                >
                  <X size={16} />
                </button>
                <h2 id="import-review-title">审阅导入内容</h2>
                <p>
                  “{reviewImport.draft.displayName}”的解析结果尚未写入简历。勾选要应用的候选；经历和总结会追加，基本信息会替换对应字段。
                </p>
                <img
                  className="template-import-review-preview"
                  src={reviewImport.previewDataUrl}
                  alt={`${reviewImport.draft.displayName} 来源预览`}
                />
                {reviewImport.draft.warnings.map((warning) => (
                  <p className="template-recognition-error" key={warning}>{warning}</p>
                ))}
                {reviewImport.draft.unsupportedFeatures.map((feature) => (
                  <p className="template-recognition-error" key={feature}>{feature}</p>
                ))}
                {error ? <p role="alert" className="template-recognition-error">{error}</p> : null}
                <div className="template-import-review-candidates" role="group" aria-label="待应用候选">
                  {reviewImport.draft.candidates.map((candidate) => {
                    const checked = selectedCandidateIds.includes(candidate.id);
                    return (
                      <label className="template-import-review-candidate" key={candidate.id}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={applyingImport}
                          onChange={() => setSelectedCandidateIds((current) =>
                            checked
                              ? current.filter((id) => id !== candidate.id)
                              : [...current, candidate.id],
                          )}
                        />
                        <span>
                          <strong>{candidate.label}</strong>
                          <small>{candidateDescription(candidate)}</small>
                          <em>{candidate.evidence.confidence} · {candidate.evidence.excerpt}</em>
                        </span>
                      </label>
                    );
                  })}
                  {!reviewImport.draft.candidates.length ? (
                    <p>没有可应用候选。取消审阅不会修改当前简历。</p>
                  ) : null}
                </div>
                <div className="template-recognition-actions">
                  <button type="button" disabled={applyingImport} onClick={() => void cancelReviewImport()}>
                    取消导入
                  </button>
                  <button
                    className="primary"
                    type="button"
                    disabled={applyingImport || selectedCandidateIds.length === 0}
                    onClick={() => void applyReviewImport()}
                  >
                    {applyingImport ? "正在原子应用…" : `确认应用 ${selectedCandidateIds.length} 项`}
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
