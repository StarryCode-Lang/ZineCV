import type { ReactNode } from "react";
import { FloatingSurface } from "../overlays/FloatingSurface";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EditorNavigationTarget } from "../app/useEditorNavigation";
import type { ModuleKey, SectionKey } from "../domain/resume-model";
import type { ResumeState } from "../domain/resume-model";
import {
  buildEditorialChapters,
  type EditorialChapterKey,
} from "../domain/editorial-progress";
import { editorialNavigationTarget } from "../utils/editorial-navigation";
import { getKeyboardNavigationIndex } from "../utils/menu-keyboard";

export type EditorSectionKey = EditorialChapterKey;

type EditorSectionNavProps = {
  resume: ResumeState;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  activeKey: EditorSectionKey;
  onNavigateToEditor: (target: EditorNavigationTarget) => void;
  /** 导航行左侧的附加内容（如「继续撰写」按钮）。 */
  prefix?: ReactNode;
};

// 章节目录只负责定位与呈现真实填写状态，不写回简历、版本或右侧预览。

export function EditorSectionNav({
  resume,
  moduleOrder,
  moduleNames,
  summaryTitle,
  activeKey,
  onNavigateToEditor,
  prefix,
}: EditorSectionNavProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const chapters = buildEditorialChapters(
    resume,
    moduleOrder,
    moduleNames,
    summaryTitle,
  );
  const selectedChapter =
    chapters.find((chapter) => chapter.key === activeKey) ?? chapters[0];

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-editor-nav-key="${selectedChapter.key}"]`,
        )
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, selectedChapter.key]);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <nav
      className="editor-section-nav"
      aria-label="简历章节目录"
      data-editor-section-nav
      data-editor-nav-count={chapters.length}
    >
      <div className="editor-section-nav-heading">
        <span>章节</span>
        <span>{chapters.length} 章</span>
      </div>
      <div className="editor-section-nav-control" ref={rootRef}>
        <button
          ref={triggerRef}
          className="editor-section-nav-trigger"
          type="button"
          aria-label="跳转到章节"
          aria-haspopup="listbox"
          aria-expanded={open}
          data-editor-nav-trigger
          data-editor-nav-value={selectedChapter.key}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span className="editor-section-nav-current">
            <strong>{selectedChapter.label}</strong>
            <small>{selectedChapter.statusLabel}</small>
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        {open ? (
          <FloatingSurface
            anchor={triggerRef.current}
            matchWidth
            onClose={() => setOpen(false)}
          >
            <div
              className="editor-section-nav-menu"
              role="listbox"
              aria-label="选择章节"
              onKeyDown={(event) => {
                const options = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "[data-editor-nav-key]",
                  ),
                );
                const currentIndex = options.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeAndRestoreFocus();
                  return;
                }
                const nextIndex = getKeyboardNavigationIndex(
                  event.key,
                  currentIndex,
                  options.length,
                );
                if (nextIndex === null) return;
                event.preventDefault();
                options[nextIndex]?.focus();
              }}
            >
              {chapters.map((chapter, index) => {
                const selected = chapter.key === selectedChapter.key;
                return (
                  <button
                    className="editor-section-nav-option"
                    key={chapter.key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-editor-nav-key={chapter.key}
                    onClick={() => {
                      setOpen(false);
                      onNavigateToEditor(
                        editorialNavigationTarget(chapter.key),
                      );
                    }}
                  >
                    <span
                      className="editor-section-nav-index"
                      aria-hidden="true"
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="editor-section-nav-option-copy">
                      <span>{chapter.label}</span>
                      <small>{chapter.statusLabel}</small>
                    </span>
                    {selected ? <Check size={14} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          </FloatingSurface>
        ) : null}
      </div>
      {prefix ? <div className="editor-section-nav-action">{prefix}</div> : null}
    </nav>
  );
}
