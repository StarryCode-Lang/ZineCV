import type { KnownTemplateId, ResumePresentation } from "./template-model";
import type {
  ModuleKey,
  ResumeLayout,
  ResumeState,
  SectionKey,
} from "./resume-model";
import { isTauriRuntime, nativeInvoke } from "../../platform/ipc";

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
let nativeCatalog: ImportedTemplate[] | null = null;
let nativeCatalogRevision = 0;
let catalogWrites: Promise<void> = Promise.resolve();
type NativeCatalog = { revision: number; payloadJson: string };

function parseImportedTemplates(serialized: string): ImportedTemplate[] {
  try {
    const value = JSON.parse(serialized);
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

export function readImportedTemplates(): ImportedTemplate[] {
  if (isTauriRuntime()) return nativeCatalog ?? [];
  return parseImportedTemplates(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
}

export async function loadImportedTemplates(): Promise<ImportedTemplate[]> {
  if (!isTauriRuntime()) return readImportedTemplates();
  const stored = (await nativeInvoke("read_imported_template_catalog")) as NativeCatalog | null;
  if (stored !== null) {
    nativeCatalogRevision = stored.revision;
    nativeCatalog = parseImportedTemplates(stored.payloadJson);
    return nativeCatalog;
  }
  // One-time migration from this desktop WebView's old localStorage catalog.
  const legacy = parseImportedTemplates(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
  try {
    nativeCatalogRevision = (await nativeInvoke("write_imported_template_catalog", {
      payloadJson: JSON.stringify(legacy),
      expectedRevision: 0,
    })) as number;
    nativeCatalog = legacy;
    return legacy;
  } catch (error) {
    const concurrent = (await nativeInvoke("read_imported_template_catalog")) as NativeCatalog | null;
    if (!concurrent) throw error;
    nativeCatalogRevision = concurrent.revision;
    nativeCatalog = parseImportedTemplates(concurrent.payloadJson);
    return nativeCatalog;
  }
}

export async function writeImportedTemplates(templates: ImportedTemplate[]): Promise<void> {
  const serialized = JSON.stringify(templates);
  if (!isTauriRuntime()) {
    window.localStorage.setItem(STORAGE_KEY, serialized);
    return;
  }
  nativeCatalog = templates;
  const pending = catalogWrites.catch(() => undefined).then(async () => {
    nativeCatalogRevision = (await nativeInvoke("write_imported_template_catalog", {
      payloadJson: serialized,
      expectedRevision: nativeCatalogRevision,
    })) as number;
  });
  catalogWrites = pending;
  try {
    await pending;
  } catch (error) {
    const saved = (await nativeInvoke("read_imported_template_catalog")) as NativeCatalog | null;
    nativeCatalogRevision = saved?.revision ?? 0;
    nativeCatalog = parseImportedTemplates(saved?.payloadJson ?? "[]");
    throw error;
  }
}
