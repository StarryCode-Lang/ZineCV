import {
  Award,
  Boxes,
  FileText,
  LayoutTemplate,
  RotateCcw,
  Search,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useMemo, useState } from "react";
import { WorkspaceHeading } from "../layout/WorkspaceHeading";
import {
  effectiveBoxText,
  isBoxEdited,
  type ImportedLayoutBox,
  type ImportedSourceLayout,
} from "../domain/imported-layout";
import { matchSection } from "../services/resume-content-recognition";
import "../styles/imported-layout.css";

type BoxGroup = {
  id: string;
  title: string;
  boxes: ImportedLayoutBox[];
  // 与内置模板一致的连续编号：跨页也不重来。
  index: number;
};
type PageGroup = { page: number; groups: BoxGroup[] };

// 章节图标与内置编辑器同一套：同样的分组在两套模板下看起来是同一个东西。
const sectionIcons = {
  basic: UserRound,
  summary: FileText,
  experience: Boxes,
  skills: Sparkles,
  certificates: Award,
  projects: LayoutTemplate,
} as const;

function SectionIcon({ id }: { id: string }) {
  const Icon = sectionIcons[id as keyof typeof sectionIcons] ?? FileText;
  return <Icon size={16} />;
}

function groupBoxes(layout: ImportedSourceLayout): PageGroup[] {
  const built = layout.pages.map((page, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const boxes = layout.boxes.filter((box) => box.page === pageNumber);
    const byPosition = (a: ImportedLayoutBox, b: ImportedLayoutBox) =>
      a.y - b.y || a.x - b.x;
    const left = boxes.filter(
      (box) => box.x + box.width / 2 < page.width * 0.34,
    );
    const right = boxes.filter(
      (box) => box.x + box.width / 2 >= page.width * 0.34,
    );
    // 页眉横贯行（双栏区之上的宽行）排最前；双栏区之内的长 bullet
    // 也会超过 55% 宽，不能跟着前段化，否则会被塞进页眉组。
    const columnTop = Math.min(
      ...[left[0], right[0]].filter(Boolean).map((box) => box.y),
    );
    const headerRows = boxes.filter(
      (box) => box.width > page.width * 0.55 && box.y < columnTop,
    );
    const ordered =
      left.length >= 4 && right.length >= 4
        ? [
            ...headerRows.sort(byPosition),
            ...left.sort(byPosition),
            ...right.sort(byPosition),
          ]
        : boxes.sort(byPosition);
    const groups: BoxGroup[] = [];
    for (const box of ordered) {
      const matched = matchSection(box.text);
      const section = matched ? { key: matched[1], alias: matched[2] } : null;
      const last = groups.at(-1);
      // 模板常见“英文装饰行 + 中文标题”成对出现（如 VOCATIONAL SKILLS /
      // 职业技能）：相邻同章节不再劈成两个同名组。
      if (!groups.length) {
        groups.push({
          id: section?.key ?? "basic",
          title: section?.alias ?? "基本信息",
          boxes: [],
          index: 0,
        });
      } else if (section && section.key !== last!.id) {
        groups.push({
          id: section.key,
          title: section.alias,
          boxes: [],
          index: 0,
        });
      }
      // 标题行本身仍是可编辑框（版式保真：标题也是源文件的一个文本框）。
      groups.at(-1)!.boxes.push(box);
    }
    return { page: pageNumber, groups };
  });
  // 编号跨页连续，和内置模板的 01/02/03 一致。
  let counter = 0;
  for (const page of built) {
    for (const group of page.groups) group.index = ++counter;
  }
  return built;
}

export function ImportedLayoutEditor({
  layout,
  edits,
  templateName,
  onChange,
  onReset,
}: {
  layout: ImportedSourceLayout;
  edits: Record<string, string>;
  templateName: string;
  onChange: (boxId: string, value: string) => void;
  onReset: () => void;
}) {
  const [query, setQuery] = useState("");
  const pages = useMemo(() => groupBoxes(layout), [layout]);
  const editedCount = layout.boxes.filter((box) =>
    isBoxEdited(box, edits),
  ).length;
  const groupCount = pages.reduce((sum, page) => sum + page.groups.length, 0);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visiblePages = pages
    .map((page) => ({
      ...page,
      groups: page.groups
        .map((group) => ({
          ...group,
          boxes: group.boxes.filter((box) =>
            effectiveBoxText(box, edits)
              .toLocaleLowerCase()
              .includes(normalizedQuery),
          ),
        }))
        .filter((group) => group.boxes.length),
    }))
    .filter((page) => page.groups.length);

  return (
    <div className="imported-layout-editor" data-imported-layout-editor>
      {/* 与内置版式的编辑器共用同一套顶部块，切换模板时标题不会跳。 */}
      <WorkspaceHeading
        kicker="SOURCE TEXT / 源版文字"
        title={templateName}
        deck="版式、图片和文本框位置已锁定；这里只替换文字，右侧其余内容保持不变。"
        actions={
          <>
            <div className="imported-layout-editor-meta">
              <span>{groupCount} 个模块</span>
              <span>{layout.boxes.length} 段可编辑文字</span>
              {editedCount ? <strong>{editedCount} 段已修改</strong> : null}
            </div>
            {editedCount ? (
              <button
                type="button"
                className="imported-layout-reset"
                onClick={onReset}
              >
                <RotateCcw size={13} aria-hidden="true" />
                恢复原文
              </button>
            ) : null}
            <label className="imported-layout-search">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label="搜索可编辑文字"
                placeholder="搜索姓名、经历或技能…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <kbd>
                  {visiblePages
                    .flatMap((page) => page.groups)
                    .reduce((sum, group) => sum + group.boxes.length, 0)}{" "}
                  段
                </kbd>
              ) : null}
            </label>
          </>
        }
      />
      <div className="imported-layout-editor-groups">
        {visiblePages.map(({ page, groups }) => (
          <section className="imported-layout-editor-page" key={page}>
            {pages.length > 1 ? <h3>第 {page} 页</h3> : null}
            {groups.map((group) => (
              <section
                className="imported-layout-editor-group module-card section-card"
                data-imported-layout-group={group.id}
                key={`${page}-${group.id}`}
              >
                {/* 与内置模板同一套模块标题：编号 + 章节图标 + 名称 + 状态胶囊，
                    这样导入版式和内置版式的左侧看起来是同一个编辑器。 */}
                <div className="module-heading imported-layout-group-heading">
                  <span className="heading-left">
                    <span className="editor-section-number" aria-hidden="true">
                      {String(group.index).padStart(2, "0")}
                    </span>
                    <span className="module-mark" aria-hidden="true">
                      <SectionIcon id={group.id} />
                    </span>
                    <strong>{group.title}</strong>
                    <span className="heading-subtitle">Source text</span>
                    <span
                      className={`module-fill-state${
                        group.boxes.length ? " filled" : ""
                      }`}
                    >
                      {group.boxes.length} 段
                    </span>
                  </span>
                </div>
                <div className="imported-layout-editor-fields">
                  {group.boxes.map((box, index) => {
                    const value = effectiveBoxText(box, edits);
                    const edited = isBoxEdited(box, edits);
                    const long =
                      box.text.length > 42 || box.height > box.fontSize * 1.7;
                    return (
                      <div
                        className={`imported-layout-field ${edited ? "is-edited" : ""}`}
                        key={box.id}
                        data-imported-layout-field={box.id}
                      >
                        <label htmlFor={`imported-box-${box.id}`}>
                          <span>
                            {String(index + 1).padStart(2, "0")} ·{" "}
                            {box.text.slice(0, 24)}
                            {box.text.length > 24 ? "…" : ""}
                          </span>
                          {edited ? <strong>已修改</strong> : null}
                        </label>
                        {long ? (
                          <textarea
                            id={`imported-box-${box.id}`}
                            value={value}
                            rows={Math.min(
                              6,
                              Math.max(
                                2,
                                Math.round(box.height / box.lineHeight),
                              ),
                            )}
                            onChange={(event) =>
                              onChange(box.id, event.target.value)
                            }
                          />
                        ) : (
                          <input
                            id={`imported-box-${box.id}`}
                            value={value}
                            onChange={(event) =>
                              onChange(box.id, event.target.value)
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </section>
        ))}
        {!visiblePages.length ? (
          <p className="imported-layout-empty" role="status">
            没有匹配的文字，换个关键词试试。
          </p>
        ) : null}
      </div>
    </div>
  );
}
