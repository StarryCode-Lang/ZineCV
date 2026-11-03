import type { ModuleKey, ResumeState, SectionKey } from "./resume-model";
const DEFAULT_SUMMARY_TITLE = "自我评价";

export type EditorialChapterKey = "basic" | SectionKey;
export type EditorialChapter = {
  key: EditorialChapterKey;
  label: string;
  complete: boolean;
  started: boolean;
  statusLabel: string;
  entryCount: number;
  filledEntryCount: number;
  textLength: number;
};

// 章节状态文案的单一来源；编辑器卡片的兜底展示也使用这一份。
export const editorialStatusLabels = {
  documented: "已建档",
  awaitingContact: "待补联系方式",
  awaitingName: "待补姓名",
  written: "已撰写",
  pending: "待撰写",
  refine: "待完善",
} as const;

const textFromHtml = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const entryText = (entry: ResumeState["work"][number]) =>
  [
    entry.title,
    entry.role,
    entry.department,
    entry.city,
    entry.start,
    entry.end,
    textFromHtml(entry.html),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();

export function buildEditorialChapters(
  resume: ResumeState,
  moduleOrder: SectionKey[],
  moduleNames: Record<ModuleKey, string>,
  summaryTitle: string,
): EditorialChapter[] {
  const basicValues = Object.entries(resume.basic).flatMap(([key, value]) =>
    key !== "ageMode" && key !== "avatar" && typeof value === "string"
      ? [value.trim()]
      : [],
  );
  const basicText = basicValues.filter(Boolean).join(" ");
  const hasName = Boolean(resume.basic.name.trim());
  const hasContact = Boolean(
    resume.basic.phone.trim() ||
    resume.basic.email.trim() ||
    resume.basic.city.trim(),
  );
  const basicComplete = hasName && hasContact;

  return [
    {
      key: "basic",
      label: "基本信息",
      complete: basicComplete,
      started: Boolean(basicText),
      statusLabel: basicComplete
        ? editorialStatusLabels.documented
        : basicText
          ? hasName
            ? editorialStatusLabels.awaitingContact
            : editorialStatusLabels.awaitingName
          : editorialStatusLabels.refine,
      entryCount: 0,
      filledEntryCount: 0,
      textLength: basicText.length,
    },
    ...moduleOrder.map((section): EditorialChapter => {
      if (section === "summary") {
        const text = textFromHtml(resume.summary);
        return {
          key: section,
          label: summaryTitle || DEFAULT_SUMMARY_TITLE,
          complete: text.length > 0,
          started: text.length > 0,
          statusLabel:
            text.length > 0
              ? editorialStatusLabels.written
              : editorialStatusLabels.pending,
          entryCount: 0,
          filledEntryCount: 0,
          textLength: text.length,
        };
      }

      const entries = resume[section];
      const entryTexts = entries.map(entryText);
      const filledEntryCount = entryTexts.filter(Boolean).length;
      const textLength = entryTexts.reduce(
        (total, text) => total + text.length,
        0,
      );
      return {
        key: section,
        label: moduleNames[section],
        complete: filledEntryCount > 0,
        started: entries.length > 0,
        statusLabel:
          entries.length === 0
            ? editorialStatusLabels.pending
            : filledEntryCount === 0
              ? editorialStatusLabels.refine
              : filledEntryCount === entries.length
                ? `${filledEntryCount} 段`
                : `${filledEntryCount}/${entries.length} 段`,
        entryCount: entries.length,
        filledEntryCount,
        textLength,
      };
    }),
  ];
}

export function getEditorialProgress(chapters: EditorialChapter[]) {
  const completed = chapters.filter((chapter) => chapter.complete).length;
  const total = chapters.length;
  return {
    completed,
    total,
    percent: total ? Math.round((completed / total) * 100) : 0,
    nextChapter: chapters.find((chapter) => !chapter.complete) ?? null,
    entryCount: chapters.reduce(
      (total, chapter) => total + chapter.filledEntryCount,
      0,
    ),
    characterCount: chapters.reduce(
      (total, chapter) => total + chapter.textLength,
      0,
    ),
  };
}
