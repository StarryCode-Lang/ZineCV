import { sanitizeRichHtml } from "../../utils/resume";
import { PreviewTitle } from "./PreviewSections";

// 自我评价与其他正文使用相同的安全富文本输出规则。
export function PreviewSummary({
  title,
  html,
  textAlign,
}: {
  title: string;
  html: string;
  textAlign: "系统默认" | "两端对齐";
}) {
  return (
    <section className="preview-section">
      <PreviewTitle
        title={title}
        icon={<i className="iconfont iconcv-title-icon-personal_summary" />}
      />
      <div
        className="preview-rich"
        style={{ textAlign: textAlign === "两端对齐" ? "justify" : undefined }}
        dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(html) }}
      />
    </section>
  );
}
