import type { ResumeDocument } from "../../../src-tauri/src/domain/bindings/ResumeDocument";
import { parseSourceLayoutEdits } from "../../platform/sourceLayoutEdits";
import type { ImportedSourceLayout } from "../domain/imported-layout";
import type { ImportedTemplate } from "../domain/imported-template";

/** Bind a source-layout render to the document actually saved at the requested cursor. */
export function freezeSourceLayoutForExport(
  document: Pick<ResumeDocument, "legacyExtensions">,
  template: Pick<ImportedTemplate, "id" | "revisionHash" | "sourceLayout">,
): { layout: ImportedSourceLayout; edits: Record<string, string> } {
  const saved = document.legacyExtensions?.importedTemplate;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("当前文档没有可用的原版式模板");
  const identity = saved as Record<string, unknown>;
  if (identity.id !== template.id || identity.revisionHash !== template.revisionHash) {
    throw new Error("原版式模板或修订已变化，请重新加载后导出");
  }
  const layout = template.sourceLayout;
  if (!layout || layout.version !== 1 || !Array.isArray(layout.pages) || !layout.pages.length || layout.pages.length > 50 ||
      !Array.isArray(layout.boxes) || layout.pages.some(page => !page || !Number.isFinite(page.width) || page.width <= 0 ||
        !Number.isFinite(page.height) || page.height <= 0 || typeof page.background !== "string" || !page.background)) {
    throw new Error("原版式页面或背景资源无效");
  }
  const ids = new Set<string>();
  for (const box of layout.boxes) {
    if (!box || typeof box.id !== "string" || !box.id || ids.has(box.id) || !Number.isInteger(box.page) || box.page < 1 || box.page > layout.pages.length) {
      throw new Error("原版式文字框无效");
    }
    ids.add(box.id);
  }
  const savedEdits = parseSourceLayoutEdits(document.legacyExtensions.sourceLayoutEdits, template.id, template.revisionHash);
  const edits = savedEdits?.edits ?? {};
  if (Object.keys(edits).some(id => !ids.has(id))) throw new Error("原版式文字与模板不匹配，请重新核对");
  return { layout: structuredClone(layout), edits: structuredClone(edits) };
}
