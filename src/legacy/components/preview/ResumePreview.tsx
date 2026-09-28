import type {
  ModuleKey,
  PreviewBlock,
  ResumeState,
  SeparatorMode,
} from "../../domain/resume-model";
import { PreviewHeader } from "./PreviewHeader";
import { PreviewModule } from "./PreviewSections";
import { PreviewSummary } from "./PreviewSummary";

// A4 页面内容入口：按分页结果渲染个人信息、模块和自我评价。
export function PreviewContent({
  blocks,
  resume,
  moduleNames,
  summaryTitle,
  dateFormat,
  titleFormat,
  separator,
  textAlign,
}: {
  blocks: PreviewBlock[];
  resume: ResumeState;
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  dateFormat: "2021年1月" | "2021.01";
  titleFormat: "双行标题" | "单行标题";
  separator: SeparatorMode;
  textAlign: "系统默认" | "两端对齐";
}) {
  // blocks 已由分页服务排好顺序，这里只负责生成简历正文。
  return (
    <div className="paper-content">
      {blocks.map((block, index) => {
        if (block.kind === "header")
          return (
            <div
              className="preview-block"
              data-layout-block="header"
              key="header"
            >
              <PreviewHeader basic={resume.basic} />
            </div>
          );
        if (block.kind === "summary")
          return (
            <div
              className="preview-block"
              data-layout-block="summary"
              key={`summary-${index}`}
            >
              <PreviewSummary
                title={summaryTitle || "自我评价"}
                html={resume.summary}
                textAlign={textAlign}
              />
            </div>
          );
        const entryIds = new Set(block.entryIds);
        const entries = resume[block.module].filter((entry) =>
          entryIds.has(entry.id),
        );
        return (
          <div
            className="preview-block"
            data-layout-block={block.module}
            key={`${block.module}-${block.entryIds.join("-")}-${index}`}
          >
            <PreviewModule
              module={block.module}
              title={moduleNames[block.module]}
              entries={entries}
              dateFormat={dateFormat}
              titleFormat={titleFormat}
              separator={separator}
              textAlign={textAlign}
            />
          </div>
        );
      })}
    </div>
  );
}
