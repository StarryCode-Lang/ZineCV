import type { EditorialCommand } from "./EditorialCommandPalette";
import type { HeaderPanel } from "./AppHeader";
import type { EditorialChapter } from "../domain/editorial-progress";
import type { EditorNavigationTarget } from "../app/useEditorNavigation";
import { editorialNavigationTarget } from "../utils/editorial-navigation";

export type EditorialCommandInput = {
  chapters: EditorialChapter[];
  smartFitActive: boolean;
  exportingFormat: "pdf" | "png" | null;
  onSelectEditor: () => void;
  onSelectTemplates: () => void;
  onSelectVersions: () => void;
  onOpenAgent: () => void;
  onNavigateToEditor: (target: EditorNavigationTarget) => void;
  onSmartFit: () => void;
  onOpenPanel: (panel: Exclude<HeaderPanel, null>) => void;
  onExportPdf: () => void;
  onExportPng: () => void;
  onCopyText: () => void;
  onOpenLegacyArchives: () => void;
};

export function createEditorialCommands({
  chapters,
  smartFitActive,
  exportingFormat,
  onSelectEditor,
  onSelectTemplates,
  onSelectVersions,
  onOpenAgent,
  onNavigateToEditor,
  onSmartFit,
  onOpenPanel,
  onExportPdf,
  onExportPng,
  onCopyText,
  onOpenLegacyArchives,
}: EditorialCommandInput): EditorialCommand[] {
  const nextChapter = chapters.find((chapter) => !chapter.complete);
  return [
    ...(nextChapter
      ? [
          {
            id: "continue",
            icon: "write" as const,
            label: `继续撰写 · ${nextChapter.label}`,
            description: `当前状态：${nextChapter.statusLabel}，直接定位到下一处待完善内容`,
            keywords: "下一步 继续 撰写 当前 内容",
            group: "content" as const,
            action: () =>
              onNavigateToEditor(editorialNavigationTarget(nextChapter.key)),
          },
        ]
      : []),
    {
      id: "write",
      icon: "write",
      label: "回到内容工坊",
      description: "继续撰写本期简历，保留当前章节上下文",
      keywords: "编辑 内容 撰稿",
      group: "content",
      action: onSelectEditor,
    },
    ...chapters.map((chapter, index) => ({
      id: `chapter-${chapter.key}`,
      icon: "chapter" as const,
      label: `${String(index + 1).padStart(2, "0")} · ${chapter.label}`,
      description: `前往章节 · ${chapter.statusLabel}`,
      keywords: `章节 跳转 ${chapter.label} ${chapter.statusLabel}`,
      group: "content" as const,
      action: () => onNavigateToEditor(editorialNavigationTarget(chapter.key)),
    })),
    {
      id: "assistant",
      icon: "smart",
      label: "打开 ZineBot",
      description: "带上你明确选择的上下文，与 ZineBot 讨论或核对提议",
      keywords: "助手 AI 协作 校样 提议 智能",
      group: "content",
      action: onOpenAgent,
    },
    {
      id: "template",
      icon: "template",
      label: "打开版型资料室",
      description: "应用或导入图片、PDF、DOCX 模板",
      keywords: "模板 版型 导入",
      group: "layout",
      action: onSelectTemplates,
    },
    {
      id: "versions",
      icon: "versions",
      label: "打开版本档案馆",
      description: "提交、分支、恢复或备份历史版本",
      keywords: "版本 历史 存档 分支",
      group: "content",
      action: onSelectVersions,
    },
    {
      id: "smart",
      icon: "smart",
      label: smartFitActive ? "关闭单页排印" : "单页排印",
      description: "只协调排版参数，不改写简历正文",
      keywords: "单页 一页 排印 自适应",
      group: "layout",
      action: onSmartFit,
    },
    {
      id: "font",
      icon: "layout",
      label: "更换正文字体",
      description: "在受控字体列表中选择，实时核对 A4",
      keywords: "字体 宋体 黑体 排版",
      group: "layout",
      action: () => onOpenPanel("font"),
    },
    {
      id: "fontSize",
      icon: "layout",
      label: "调整正文基准字号",
      description: "只改排版参数，正文内容保持不变",
      keywords: "字号 大小 排版",
      group: "layout",
      action: () => onOpenPanel("fontSize"),
    },
    {
      id: "spacing",
      icon: "layout",
      label: "调整行距与页边距",
      description: "控制行距、模块间距和页面呼吸感",
      keywords: "行距 间距 页边距 留白 排版",
      group: "layout",
      action: () => onOpenPanel("spacing"),
    },
    {
      id: "layout",
      icon: "layout",
      label: "调整格式与颜色",
      description: "控制主题、日期、标题、分隔符与对齐",
      keywords: "版式 颜色 字体 格式",
      group: "layout",
      action: () => onOpenPanel("format"),
    },
    {
      id: "modules",
      icon: "modules",
      label: "管理章节与顺序",
      description: "显示、隐藏、命名或重新编排模块",
      keywords: "模块 章节 排序",
      group: "content",
      action: () => onOpenPanel("manager"),
    },
    {
      id: "pdf",
      icon: "pdf",
      label: "导出 PDF",
      description: "生成与当前 A4 预览一致的投递文件",
      keywords: "下载 导出 pdf 校样 投递",
      group: "output",
      disabled: Boolean(exportingFormat),
      action: onExportPdf,
    },
    {
      id: "png",
      icon: "png",
      label: "导出高清 PNG",
      description: "导出当前简历的长图",
      keywords: "下载 导出 图片 png 校样",
      group: "output",
      disabled: Boolean(exportingFormat),
      action: onExportPng,
    },
    {
      id: "copy",
      icon: "copy",
      label: "复制纯文本",
      description: "复制完整简历内容，便于投递到其他平台",
      keywords: "复制 文本 剪贴板 投递",
      group: "output",
      action: onCopyText,
    },
    {
      id: "legacy-archives",
      icon: "write",
      label: "查看旧版逐框编辑归档",
      description: "查看迁移保全的旧浏览器逐框编辑文字（原版式资源缺失，可复制）",
      keywords: "旧版 逐框 归档 迁移 恢复 查看",
      group: "output" as const,
      action: onOpenLegacyArchives,
    },
  ];
}
