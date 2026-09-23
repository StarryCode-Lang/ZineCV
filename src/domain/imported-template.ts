import type { KnownTemplateId, ResumePresentation } from "./template-model";
import type {
  ModuleKey,
  ResumeLayout,
  ResumeState,
  SectionKey,
} from "./resume-model";

export type ImportedTemplateSource = "image" | "pdf" | "word";
type ImportedTemplateLayout = "side-band" | "single-column";

export type ImportedTemplate = {
  id: string;
  name: string;
  sourceName: string;
  sourceType: ImportedTemplateSource;
  createdAt: string;
  previewDataUrl?: string;
  accent: string;
  formatId: KnownTemplateId;
  layout: ImportedTemplateLayout;
  sideBandBackground?: string;
  sideBandForeground?: string;
  analysis: string;
  resume?: ResumeState;
  moduleOrder?: SectionKey[];
  moduleNames?: Record<ModuleKey, string>;
  summaryTitle?: string;
  detectedFont?: string;
  extractedText?: string;
  recognitionConfidence?: "high" | "medium" | "low";
  recognitionWarnings?: string[];
  presentation?: ResumePresentation;
  resumeLayout?: ResumeLayout;
};

const STORAGE_KEY = "resume-diy-imported-templates-v1";

export function readImportedTemplates(): ImportedTemplate[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is ImportedTemplate =>
          Boolean(item) &&
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          typeof item.sourceName === "string" &&
          ["image", "pdf", "word"].includes(item.sourceType) &&
          typeof item.accent === "string" &&
          ["legacy-v1", "clear-single-v1", "compact-single-v1"].includes(
            item.formatId,
          ),
      )
      .map((item) => ({
        ...item,
        layout: item.layout === "side-band" ? "side-band" : "single-column",
        recognitionWarnings: Array.isArray(item.recognitionWarnings)
          ? item.recognitionWarnings.filter(
              (warning): warning is string => typeof warning === "string",
            )
          : [],
      }));
  } catch {
    return [];
  }
}

export function writeImportedTemplates(templates: ImportedTemplate[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}
