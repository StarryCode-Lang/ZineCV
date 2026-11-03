import { Edit3 } from "lucide-react";
import { WorkspaceHeading } from "../layout/WorkspaceHeading";
import { useState } from "react";
import type {
  ModuleKey,
  ResumeState,
  SectionKey,
} from "../domain/resume-model";
import {
  buildEditorialChapters,
  getEditorialProgress,
} from "../domain/editorial-progress";

type EditorialBriefProps = {
  resume: ResumeState;
  resumeTitle: string;
  onResumeTitleChange: (title: string) => void;
  pageCount: number;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  exportBlocked?: boolean;
};

export function EditorialBrief({
  resume,
  resumeTitle,
  onResumeTitleChange,
  pageCount,
  moduleOrder,
  moduleNames,
  summaryTitle,
  exportBlocked = false,
}: EditorialBriefProps) {
  const chapters = buildEditorialChapters(
    resume,
    moduleOrder,
    moduleNames,
    summaryTitle,
  );
  const progress = getEditorialProgress(chapters);
  const nextChapter = progress.nextChapter;
  const hasContent = progress.characterCount > 0;
  const [editingTitle, setEditingTitle] = useState(false);

  return (
    <section
      className="editorial-brief"
      aria-labelledby="editorial-brief-title"
      data-editorial-state={
        !hasContent ? "blank" : nextChapter ? "writing" : "ready"
      }
    >
      <WorkspaceHeading
        titleId="editorial-brief-title"
        kicker="本期简报 / THE DESK NOTE"
        title={
          editingTitle ? (
            <input
              className="editorial-title-input"
              autoFocus
              value={resumeTitle}
              aria-label="简历名称"
              onChange={(event) => onResumeTitleChange(event.target.value)}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === "Escape")
                  setEditingTitle(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="editorial-title-button"
              title="编辑简历名称"
              onClick={() => setEditingTitle(true)}
            >
              <span>{resumeTitle || "未命名简历"}</span>
              <Edit3 size={13} aria-hidden="true" />
            </button>
          )
        }
        deck={
          !hasContent
            ? "空白稿纸。逐章填写，完成度会跟着涨。"
            : nextChapter
              ? `已收录 ${progress.characterCount} 字 · ${pageCount} 页，下一章是「${nextChapter.label}」。`
              : exportBlocked
                ? `全部章节都已填写，共 ${pageCount} 页；有内容超出 A4，调整后再导出。`
                : `全部章节都已填写，共 ${pageCount} 页，可以进行导出检查。`
        }
        aside={
          <div
            className="editorial-progress"
            aria-label={`内容完成度 ${progress.percent}%`}
          >
            <strong>{String(progress.percent).padStart(2, "0")}</strong>
            <span>%</span>
            <small>内容完成度</small>
          </div>
        }
      />
    </section>
  );
}
