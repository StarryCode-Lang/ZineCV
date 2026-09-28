import type {
  ModuleKey,
  ResumeState,
  SectionKey,
} from "../domain/resume-model";
import { monthLabel, stripHtml } from "../utils/resume";

export function buildResumePlainText({
  resume,
  moduleOrder,
  moduleNames,
  summaryTitle,
}: {
  resume: ResumeState;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
}) {
  const basic = resume.basic;
  return [
    basic.name,
    [basic.phone, basic.email, basic.wechat].filter(Boolean).join(" · "),
    [basic.birth, basic.city, basic.gender].filter(Boolean).join(" · "),
    [basic.website, basic.linkedin].filter(Boolean).join(" · "),
    ...moduleOrder.flatMap((section) =>
      section === "summary"
        ? [summaryTitle || "自我评价", stripHtml(resume.summary)]
        : [
            moduleNames[section],
            ...resume[section].flatMap((entry) => [
              entry.title,
              [entry.role, entry.department, entry.city]
                .filter(Boolean)
                .join(" · "),
              [monthLabel(entry.start), monthLabel(entry.end)]
                .filter(Boolean)
                .join(" - "),
              stripHtml(entry.html),
            ]),
          ],
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
