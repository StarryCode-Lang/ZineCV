import type { EditorNavigationTarget } from "../app/useEditorNavigation";
import type { EditorialChapterKey } from "../domain/editorial-progress";

// 章节键 → 编辑器定位目标的统一映射；目录、简报和指令面板共用这一份。
// 放在组件之外，避免 react-refresh 要求「只导出组件」的组件文件混出纯函数。
export function editorialNavigationTarget(
  key: EditorialChapterKey,
): EditorNavigationTarget {
  if (key === "basic") return { kind: "basic" };
  if (key === "summary") return { kind: "summary" };
  return { kind: "module", module: key };
}
