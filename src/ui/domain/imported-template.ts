import type { KnownTemplateId, ResumePresentation } from "./template-model";
import type {
  ModuleKey,
  ResumeLayout,
  ResumeState,
  SectionKey,
} from "./resume-model";
import { hasDocumentRuntime as isTauriRuntime, nativeInvoke } from "../../platform/ipc";
import type { ImportedSourceLayout } from "./imported-layout";

export type ImportedTemplateSource = "image" | "pdf" | "word";
type ImportedTemplateLayout = "side-band" | "single-column";

export type ImportedTemplate = {
  id: string;
  name: string;
  sourceName: string;
  sourceType: ImportedTemplateSource;
  createdAt: string;
  previewDataUrl?: string;
  previewAssetId?: string;
  previewRecoveryWarning?: string;
  revisionHash?: string;
  revisionStatus?: "current" | "fallback" | "unknown";
  knownRevisions?: { revisionHash: string; rendererStatus: "current" | "fallback" }[];
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
  sourceLayout?: ImportedSourceLayout;
};

const STORAGE_KEY = "resume-diy-imported-templates-v1";
let nativeCatalog: ImportedTemplate[] | null = null;
let nativeCatalogRevision = 0;
let catalogWrites: Promise<void> = Promise.resolve();
const hydratedSourceAssets = new Map<string, string>();
type NativeCatalog = { revision: number; payloadJson: string };

export function parseImportedTemplates(serialized: string): ImportedTemplate[] {
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

async function hydrateNativeCatalog(payloadJson: string): Promise<ImportedTemplate[]> {
  const templates = parseImportedTemplates(payloadJson);
  return Promise.all(
    templates.map(async (template) => {
      let hydrated = template;
      if (template.sourceLayout) {
        const pages = await Promise.all(template.sourceLayout.pages.map(async (page) => {
          if (!page.backgroundAssetId || page.background) return page;
          try {
            const asset = (await nativeInvoke("read_avatar_asset", { hash: page.backgroundAssetId })) as { dataUrl: string };
            hydratedSourceAssets.set(page.backgroundAssetId, asset.dataUrl);
            return { ...page, background: asset.dataUrl };
          } catch {
            return page;
          }
        }));
        hydrated = { ...hydrated, sourceLayout: { ...template.sourceLayout, pages },
          ...(pages.some((page) => !page.background) ? { previewRecoveryWarning: "原版式背景资源缺失；请重新导入原文件。" } : {}) };
      }
      if (!template.previewAssetId || template.previewDataUrl) return hydrated;
      try {
        const asset = (await nativeInvoke("read_avatar_asset", {
          hash: template.previewAssetId,
        })) as { dataUrl: string };
        return { ...hydrated, previewDataUrl: asset.dataUrl };
      } catch {
        return {
          ...hydrated,
          previewRecoveryWarning:
            "原始预览资源缺失；可重新导入原文件恢复。",
        };
      }
    }),
  );
}

function mergeSavedMetadata(
  incoming: ImportedTemplate[],
  payloadJson: string,
): ImportedTemplate[] {
  const savedById = new Map(
    parseImportedTemplates(payloadJson).map((template) => [template.id, template]),
  );
  return incoming.map((template) => {
    const saved = savedById.get(template.id);
    if (!saved) return template;
    if (template.sourceLayout && saved.sourceLayout) {
      for (const [index, page] of template.sourceLayout.pages.entries()) {
        const hash = saved.sourceLayout.pages[index]?.backgroundAssetId;
        if (hash && page.background) hydratedSourceAssets.set(hash, page.background);
      }
    }
    return {
      ...template,
      ...(template.sourceLayout && saved.sourceLayout ? { sourceLayout: { ...template.sourceLayout,
        pages: template.sourceLayout.pages.map((page, index) => ({ ...page,
          backgroundAssetId: saved.sourceLayout?.pages[index]?.backgroundAssetId ?? page.backgroundAssetId })) } } : {}),
      previewAssetId: saved.previewAssetId,
      revisionHash: saved.revisionHash,
      revisionStatus: saved.revisionStatus,
      knownRevisions: saved.knownRevisions,
      previewRecoveryWarning: saved.previewRecoveryWarning,
    };
  });
}

export async function loadImportedTemplates(): Promise<ImportedTemplate[]> {
  if (!isTauriRuntime()) return readImportedTemplates();
  const stored = (await nativeInvoke("read_imported_template_catalog")) as NativeCatalog | null;
  if (stored !== null) {
    nativeCatalogRevision = stored.revision;
    nativeCatalog = await hydrateNativeCatalog(stored.payloadJson);
    return nativeCatalog;
  }
  // One-time migration from this desktop WebView's old localStorage catalog.
  const legacy = parseImportedTemplates(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
  try {
    nativeCatalogRevision = (await nativeInvoke("write_imported_template_catalog", {
      payloadJson: JSON.stringify(legacy),
      expectedRevision: 0,
    })) as number;
    const saved = (await nativeInvoke("read_imported_template_catalog")) as NativeCatalog;
    nativeCatalog = mergeSavedMetadata(legacy, saved.payloadJson);
    return nativeCatalog;
  } catch (error) {
    const concurrent = (await nativeInvoke("read_imported_template_catalog")) as NativeCatalog | null;
    if (!concurrent) throw error;
    nativeCatalogRevision = concurrent.revision;
    nativeCatalog = await hydrateNativeCatalog(concurrent.payloadJson);
    return nativeCatalog;
  }
}

export async function writeImportedTemplates(
  templates: ImportedTemplate[],
): Promise<ImportedTemplate[]> {
  if (!isTauriRuntime()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
    return templates;
  }
  const serialized = JSON.stringify(
    templates.map((template) => {
      const assetBackedTemplate = { ...template };
      if (template.previewAssetId && template.previewDataUrl) delete assetBackedTemplate.previewDataUrl;
      if (template.sourceLayout) assetBackedTemplate.sourceLayout = { ...template.sourceLayout,
        pages: template.sourceLayout.pages.map((page) => {
          const result = { ...page } as Partial<typeof page>;
          if (page.backgroundAssetId && hydratedSourceAssets.get(page.backgroundAssetId) === page.background) delete result.background;
          else if (page.background && page.backgroundAssetId) delete result.backgroundAssetId;
          return result as typeof page;
        }) };
      return assetBackedTemplate;
    }),
  );
  const pending = catalogWrites.catch(() => undefined).then(async () => {
    nativeCatalogRevision = (await nativeInvoke("write_imported_template_catalog", {
      payloadJson: serialized,
      expectedRevision: nativeCatalogRevision,
    })) as number;
    const saved = (await nativeInvoke("read_imported_template_catalog")) as NativeCatalog;
    nativeCatalog = mergeSavedMetadata(templates, saved.payloadJson);
  });
  catalogWrites = pending;
  try {
    await pending;
    return nativeCatalog ?? templates;
  } catch (error) {
    const saved = (await nativeInvoke("read_imported_template_catalog")) as NativeCatalog | null;
    nativeCatalogRevision = saved?.revision ?? 0;
    nativeCatalog = await hydrateNativeCatalog(saved?.payloadJson ?? "[]");
    throw error;
  }
}
