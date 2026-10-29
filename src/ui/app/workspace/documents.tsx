import type { Dispatch, RefObject, SetStateAction } from "react";
import { sameCursor } from "../../../platform/NativeDocumentClient";
import type { ImportCandidateCorrection } from "../../../../src-tauri/src/domain/bindings/ImportCandidateCorrection";
import { hasDocumentRuntime as isTauriRuntime } from "../../../platform/ipc";
import {
  flushDraftBeforeVersionAction,
  nativeClient,
  snapshotFromLoadedDocument
} from "../../../platform/workspace";
import {
  readImportedTemplates,
  type ImportedTemplate
} from "../../domain/imported-template";
import type {
  ModuleKey,
  ResumeLayout,
  ResumeState,
  SectionKey
} from "../../domain/resume-model";
import {
  moduleTitles
} from "../../domain/resume-model";
import {
  migratePersonalSites,
  normalizeResumeState,
  normalizeSectionOrder,
} from "../../domain/resume-normalization";
import {
  normalizePresentation,
  type KnownTemplateId,
  type ResumePresentation
} from "../../domain/template-model";
import type { ResumeVersionSnapshot } from "../../domain/version-model";
import {
  type WorkspaceView
} from "../../layout/WorkspaceRail";
import type { ImportTarget } from "../../services/import-draft";
import {
  sourcePreviewDismissalKey
} from "../useImportedTemplates";
type ImportedTemplateLayout = ImportedTemplate["layout"];
export function runApplyVersionSnapshot(context: {
  setRichEditorResetKey: Dispatch<SetStateAction<number>>;
  setResume: Dispatch<SetStateAction<ResumeState>>;
  setModuleOrder: Dispatch<SetStateAction<SectionKey[]>>;
  setModuleNames: Dispatch<SetStateAction<Record<ModuleKey, string>>>;
  setSummaryTitle: Dispatch<SetStateAction<string>>;
  setResumeTitle: Dispatch<SetStateAction<string>>;
  setPresentation: Dispatch<SetStateAction<ResumePresentation>>;
  applyLayoutSnapshot: (layout: ResumeLayout) => void;
  setActiveImportedTemplateId: Dispatch<SetStateAction<string | null>>;
  setActiveImportedTemplateRevisionHash: Dispatch<SetStateAction<string | null>>;
  setActiveImportedTemplateName: Dispatch<SetStateAction<string>>;
  notify: (message: string) => void;
  setSmartFillEnabled: Dispatch<SetStateAction<boolean>>;
  stopPendingFit: () => void;
}, snapshot: ResumeVersionSnapshot): void {
  const {
    setRichEditorResetKey, setResume, setModuleOrder, setModuleNames, setSummaryTitle, setResumeTitle,
    setPresentation, applyLayoutSnapshot, setActiveImportedTemplateId, setActiveImportedTemplateRevisionHash,
    setActiveImportedTemplateName, notify, setSmartFillEnabled, stopPendingFit,
  } = context;

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

}

export async function runApplyImportDraft(context: {
  nativeReady: boolean;
  applyVersionSnapshot: (snapshot: ResumeVersionSnapshot) => void;
  selectWorkspace: (next: WorkspaceView) => void;
  notify: (message: string) => void;
}, draftId: string, acceptedCandidateIds: string[], corrections: ImportCandidateCorrection[], target: ImportTarget): Promise<void> {
  const { nativeReady, applyVersionSnapshot, selectWorkspace, notify } = context;

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
    corrections,
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

}

export async function runApplyImportedTemplate(context: {
  nativeReady: boolean;
  importedContextSwitching: RefObject<boolean>;
  setRichEditorResetKey: Dispatch<SetStateAction<number>>;
  applyVersionSnapshot: (snapshot: ResumeVersionSnapshot) => void;
  setActiveImportedTemplateRevisionHash: Dispatch<SetStateAction<string | null>>;
  setActiveImportedTemplateName: Dispatch<SetStateAction<string>>;
  setImportedTemplateNames: Dispatch<SetStateAction<Record<string, string>>>;
  setSourcePreview: Dispatch<SetStateAction<{ templateId: string; src: string; baseline: string | null; } | null>>;
  notify: (message: string) => void;
  setPresentation: Dispatch<SetStateAction<ResumePresentation>>;
  setFormatAutoFitRevision: Dispatch<SetStateAction<number>>;
  applyFormatPreset: (templateId: KnownTemplateId, importedAccent?: string | undefined, importedLayout?: ImportedTemplateLayout | undefined, sideBandBackground?: string | undefined, sideBandForeground?: string | undefined, autoFit?: boolean) => void;
  stopPendingFit: () => void;
  applyLayoutSnapshot: (layout: ResumeLayout) => void;
  setResume: Dispatch<SetStateAction<ResumeState>>;
  setModuleOrder: Dispatch<SetStateAction<SectionKey[]>>;
  setModuleNames: Dispatch<SetStateAction<Record<ModuleKey, string>>>;
  setSummaryTitle: Dispatch<SetStateAction<string>>;
  setFont: Dispatch<SetStateAction<string>>;
  setActiveImportedTemplateId: Dispatch<SetStateAction<string | null>>;
}, template: ImportedTemplate): Promise<boolean> {
  const {
    nativeReady, importedContextSwitching, setRichEditorResetKey, applyVersionSnapshot,
    setActiveImportedTemplateRevisionHash, setActiveImportedTemplateName, setImportedTemplateNames,
    setSourcePreview, notify, setPresentation, setFormatAutoFitRevision, applyFormatPreset, stopPendingFit,
    applyLayoutSnapshot, setResume, setModuleOrder, setModuleNames, setSummaryTitle, setFont,
    setActiveImportedTemplateId,
  } = context;

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

}
