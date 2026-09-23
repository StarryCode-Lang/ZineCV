import type { ReactNode } from "react";
import { Award, FileText } from "lucide-react";
import type {
  Entry,
  ModuleKey,
  SeparatorMode,
} from "../../domain/resume-model";
import {
  metadataLabel,
  monthLabel,
  sanitizeRichHtml,
} from "../../utils/resume";

// 普通模块根据类型选择专用条目排版，标题和图标保持统一。
export function PreviewModule({
  module,
  title,
  entries,
  dateFormat,
  titleFormat,
  separator,
  textAlign,
}: {
  module: ModuleKey;
  title: string;
  entries: Entry[];
  dateFormat: "2021年1月" | "2021.01";
  titleFormat: "双行标题" | "单行标题";
  separator: SeparatorMode;
  textAlign: "系统默认" | "两端对齐";
}) {
  if (module === "education")
    return (
      <PreviewEducation
        title={title}
        entries={entries}
        dateFormat={dateFormat}
        titleFormat={titleFormat}
        separator={separator}
        textAlign={textAlign}
      />
    );
  const icon =
    module === "skills" ? (
      <i className="iconfont iconcv-title-icon-custom" />
    ) : module === "work" ? (
      <i className="iconfont iconcv-title-icon-works" />
    ) : module === "projects" ? (
      <i className="iconfont iconcv-title-icon-project_experience" />
    ) : module === "orgs" ? (
      <i className="iconfont iconcv-title-icon-orgs" />
    ) : module === "awards" ? (
      <Award size={15} />
    ) : (
      <FileText size={15} />
    );
  return (
    <PreviewSection
      title={title}
      icon={icon}
      entries={entries}
      dateFormat={dateFormat}
      titleFormat={titleFormat}
      separator={separator}
      textAlign={textAlign}
    />
  );
}

function PreviewEducation({
  title,
  entries,
  dateFormat,
  titleFormat,
  separator,
  textAlign,
}: {
  title: string;
  entries: Entry[];
  dateFormat: "2021年1月" | "2021.01";
  titleFormat: "双行标题" | "单行标题";
  separator: SeparatorMode;
  textAlign: "系统默认" | "两端对齐";
}) {
  return (
    <section className="preview-section">
      <PreviewTitle
        title={title}
        icon={<i className="iconfont iconcv-title-icon-edus" />}
      />
      {entries.map((entry) => {
        const metadata = metadataLabel([
          entry.role,
          entry.department,
          entry.mode ?? "全日制",
          entry.college,
        ]);
        const inlineMetadata =
          metadata && entry.title
            ? `${separator === "使用分隔符号" ? " - " : " "}${metadata}`
            : metadata;
        return (
          <div
            className="preview-entry"
            data-preview-entry-id={entry.id}
            key={entry.id}
          >
            <div
              className="preview-entry-head"
              style={
                titleFormat === "双行标题"
                  ? { flexDirection: "column", gap: 1 }
                  : undefined
              }
            >
              <div className="preview-entry-left">
                <strong>{entry.title}</strong>
                {titleFormat === "单行标题" && inlineMetadata ? (
                  <span className="preview-meta-inline">{inlineMetadata}</span>
                ) : null}
              </div>
              <span>
                {monthLabel(entry.start, dateFormat)} -{" "}
                {monthLabel(entry.end, dateFormat)}
              </span>
            </div>
            {titleFormat === "双行标题" && metadata ? (
              <div className="preview-meta">{metadata}</div>
            ) : null}
            <div
              className="preview-rich"
              style={{
                textAlign: textAlign === "两端对齐" ? "justify" : undefined,
              }}
              dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(entry.html) }}
            />
          </div>
        );
      })}
    </section>
  );
}

function PreviewSection({
  title,
  icon,
  entries,
  dateFormat,
  titleFormat,
  separator,
  textAlign,
}: {
  title: string;
  icon: ReactNode;
  entries: Entry[];
  dateFormat: "2021年1月" | "2021.01";
  titleFormat: "双行标题" | "单行标题";
  separator: SeparatorMode;
  textAlign: "系统默认" | "两端对齐";
}) {
  return (
    <section className="preview-section">
      <PreviewTitle title={title} icon={icon} />
      {entries.map((entry) => {
        const metadata = metadataLabel([entry.role, entry.department]);
        const inlineMetadata =
          metadata && entry.title
            ? `${separator === "使用分隔符号" ? " - " : " "}${metadata}`
            : metadata;
        const hasHead = Boolean(entry.start || entry.end || metadata);
        const standaloneTitle =
          !hasHead && entry.title
            ? `<p>${entry.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`
            : "";
        const bodyHtml =
          standaloneTitle && entry.html === "<p><br></p>"
            ? standaloneTitle
            : `${standaloneTitle}${entry.html}`;
        return (
          <div
            className="preview-entry"
            data-preview-entry-id={entry.id}
            key={entry.id}
          >
            {hasHead ? (
              <div
                className="preview-entry-head"
                style={
                  titleFormat === "双行标题"
                    ? { flexDirection: "column", gap: 1 }
                    : undefined
                }
              >
                <div className="preview-entry-left">
                  <strong>{entry.title}</strong>
                  {titleFormat === "单行标题" && inlineMetadata ? (
                    <span className="preview-meta-inline">
                      {inlineMetadata}
                    </span>
                  ) : null}
                </div>
                <span>
                  {entry.start
                    ? `${monthLabel(entry.start, dateFormat)} - ${monthLabel(entry.end, dateFormat)}`
                    : ""}
                </span>
              </div>
            ) : null}
            {titleFormat === "双行标题" && metadata ? (
              <div className="preview-meta">{metadata}</div>
            ) : null}
            <div
              className="preview-rich"
              style={{
                textAlign: textAlign === "两端对齐" ? "justify" : undefined,
              }}
              dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(bodyHtml) }}
            />
          </div>
        );
      })}
    </section>
  );
}

export function PreviewTitle({
  title,
  icon,
}: {
  title: string;
  icon: ReactNode;
}) {
  return (
    <div className="preview-title">
      <span className="preview-title-icon">{icon}</span>
      <strong>{title}</strong>
    </div>
  );
}
