import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";

// Old documents can have fewer sections and stable IDs that predate the editor.
// Align the editor's generated representation with the durable document before
// diffing, so opening an old document never silently replaces its identity.
export function alignDraftDocument(desired: ResumeDocument, current: ResumeDocument, projected?: ResumeDocument): ResumeDocument {
  const existing = new Map<string, ResumeDocument["sections"][number]>();
  for (const section of current.sections) {
    if (existing.has(section.kind)) throw new Error("Duplicate section kinds cannot be safely edited");
    existing.set(section.kind, section);
  }
  const sections = desired.sections.flatMap((section) => {
    const old = existing.get(section.kind);
    if (old) return [{ ...section, id: old.id }];
    const content = "body" in section ? section.body.length : section.entries.length;
    return section.visible || content ? [section] : [];
  });
  const basic = { ...desired.basic };
  for (const key of Object.keys(basic) as (keyof typeof basic)[]) {
    if (current.basic[key] === null && basic[key] === "") {
      (basic as Record<string, unknown>)[key] = null;
    }
  }
  const mutableKeys = new Set(["importedTemplate", "legacyAvatar", "legacyPresentation", "sourceLayoutEdits"]);
  const retained = Object.fromEntries(Object.entries(current.legacyExtensions ?? {}).filter(([key]) => !mutableKeys.has(key)));
  // 原生端把空头像表示为“无键”，编辑器推导却总带 legacyAvatar: ""。
  // 对齐到持久层表示，否则空头像文档每次提交后都会残留假脏状态。
  const legacyExtensions: ResumeDocument["legacyExtensions"] = { ...retained, ...desired.legacyExtensions };
  if (legacyExtensions.legacyAvatar === "" && (current.legacyExtensions ?? {}).legacyAvatar === undefined) {
    delete legacyExtensions.legacyAvatar;
  }
  const presentation = { ...desired.presentation };
  if (projected && presentation && current.presentation) {
    for (const key of Object.keys(presentation) as (keyof typeof presentation)[]) {
      if (JSON.stringify(presentation[key]) === JSON.stringify(projected.presentation[key])) {
        (presentation as unknown as Record<string, unknown>)[key] = current.presentation[key];
      }
    }
  }
  return { ...desired, basic, sections, presentation, legacyExtensions };
}
