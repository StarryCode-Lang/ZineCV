import type { ResumeLayout } from "../domain/resume-model";
import type { DensityPreset, KnownTemplateId } from "../domain/template-model";

type TemplateLayoutDefaults = ResumeLayout & {
  headingFontSize: string;
  paragraphSpacing: string;
  listSpacing: string;
};

type TemplateDefinition = {
  id: KnownTemplateId;
  version: number;
  name: string;
  description: string;
  recommendedFor: string;
  defaultDensity: DensityPreset;
  defaults: TemplateLayoutDefaults;
  allowedOverrides: ReadonlyArray<keyof TemplateLayoutDefaults>;
};

const sharedFormatDefaults = {
  font: "宋体",
  theme: "#000000",
  dateFormat: "2021年1月" as const,
  titleFormat: "单行标题" as const,
  separator: "使用分隔符号" as const,
  textAlign: "两端对齐" as const,
};

const adjustableKeys = [
  "font",
  "fontSize",
  "headingFontSize",
  "lineHeight",
  "moduleSpacing",
  "paragraphSpacing",
  "listSpacing",
  "pageMargin",
  "theme",
  "dateFormat",
  "titleFormat",
  "separator",
  "textAlign",
] as const;

export const templateRegistry = {
  "legacy-v1": {
    id: "legacy-v1",
    version: 1,
    name: "原版",
    description: "当前经典版式，保持现有预览、分页和导出。",
    recommendedFor: "已有简历与需要完全兼容的场景",
    defaultDensity: "standard",
    defaults: {
      ...sharedFormatDefaults,
      fontSize: "13",
      headingFontSize: "13",
      lineHeight: "13",
      moduleSpacing: "0",
      paragraphSpacing: "0",
      listSpacing: "0",
      pageMargin: "30",
    },
    allowedOverrides: adjustableKeys,
  },
  "clear-single-v1": {
    id: "clear-single-v1",
    version: 1,
    name: "清晰单栏",
    description: "层级清晰、留白舒展，优先保障快速阅读。",
    recommendedFor: "内容适中、重视阅读节奏的校招与社招简历",
    defaultDensity: "comfortable",
    defaults: {
      ...sharedFormatDefaults,
      fontSize: "12",
      headingFontSize: "16",
      lineHeight: "17",
      moduleSpacing: "8",
      paragraphSpacing: "4",
      listSpacing: "2",
      pageMargin: "34",
      theme: "#ee5b2a",
    },
    allowedOverrides: adjustableKeys,
  },
  "compact-single-v1": {
    id: "compact-single-v1",
    version: 1,
    name: "紧凑单栏",
    description: "对齐严谨、信息密度更高，保留清楚的阅读顺序。",
    recommendedFor: "技术经历较多或需要减少页数的简历",
    defaultDensity: "compact",
    defaults: {
      ...sharedFormatDefaults,
      fontSize: "11",
      headingFontSize: "14",
      lineHeight: "14",
      moduleSpacing: "3",
      paragraphSpacing: "1",
      listSpacing: "1",
      pageMargin: "25",
      theme: "#ee5b2a",
    },
    allowedOverrides: adjustableKeys,
  },
} as const satisfies Record<KnownTemplateId, TemplateDefinition>;

export const templateVersions = Object.fromEntries(
  Object.values(templateRegistry).map((template) => [
    template.id,
    template.version,
  ]),
) as Record<KnownTemplateId, number>;

export const listTemplates = (): TemplateDefinition[] =>
  Object.values(templateRegistry);
