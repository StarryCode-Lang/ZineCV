import { useState } from "react";
import { readImportedTemplates } from "../domain/imported-template";
import type {
  ResumeState,
  SectionKey,
  ModuleKey,
} from "../domain/resume-model";

export function importedContentSignature(
  resume: ResumeState,
  moduleOrder: SectionKey[],
  moduleNames: Record<ModuleKey, string>,
  summaryTitle: string,
  appearance?: unknown,
) {
  return JSON.stringify({
    resume,
    moduleOrder,
    moduleNames,
    summaryTitle,
    appearance,
  });
}

export function sourcePreviewDismissalKey(templateId: string) {
  return `resume-diy-source-preview-dismissed:${templateId}`;
}

export function useImportedTemplates() {
  const [activeImportedTemplateId, setActiveImportedTemplateId] = useState<
    string | null
  >(() => window.localStorage.getItem("resume-diy-active-imported-template"));
  const [importedTemplateCatalog, setImportedTemplateCatalog] = useState(
    readImportedTemplates,
  );
  const [sourcePreview, setSourcePreview] = useState<{
    templateId: string;
    src: string;
    baseline: string | null;
  } | null>(() => {
    try {
      const templateId = window.localStorage.getItem(
        "resume-diy-active-imported-template",
      );
      if (
        !templateId ||
        window.localStorage.getItem(sourcePreviewDismissalKey(templateId)) ===
          "true"
      )
        return null;
      const template = readImportedTemplates().find(
        (item) => item.id === templateId,
      );
      if (
        !template ||
        template.sourceType !== "pdf" ||
        !template.previewDataUrl ||
        !template.resume
      )
        return null;
      return {
        templateId,
        src: template.previewDataUrl,
        baseline: null,
      };
    } catch {
      return null;
    }
  });
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

  return {
    activeImportedTemplateId,
    setActiveImportedTemplateId,
    importedTemplateCatalog,
    setImportedTemplateCatalog,
    sourcePreview,
    setSourcePreview,
    activeImportedTemplateName,
    setActiveImportedTemplateName,
    importedTemplateNames,
    setImportedTemplateNames,
  };
}
