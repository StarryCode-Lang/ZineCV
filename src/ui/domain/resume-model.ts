// 简历的数据模型与业务常量。
export type ModuleKey =
  | "education"
  | "skills"
  | "work"
  | "projects"
  | "orgs"
  | "research"
  | "awards"
  | "other"
  | "portfolio"
  | "custom";
export type SectionKey = ModuleKey | "summary";

export type PreviewBlock =
  | { kind: "header" }
  | { kind: "summary"; html?: string; continued?: boolean }
  | { kind: "module"; module: ModuleKey; entryIds: string[]; html?: string };

export type PreviewPageLayout = {
  blocks: PreviewBlock[];
  extraModuleGap: number;
  lineHeight: number;
};

export type ConfirmAction = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
};

export const A4_HEIGHT_PX = 1122.52;
export const A4_WIDTH_PX = 793.688;
export const DEFAULT_PAGE_MARGIN_PX = 30;

export const defaultSectionOrder: SectionKey[] = [
  "education",
  "skills",
  "work",
  "projects",
  "orgs",
  "summary",
];
// 字体统一方案（2026-10-30）：全部简历只落两套栈——黑体统一微软雅黑，
// 衬线统一内嵌思源宋体（Heavy 为标题艺术字重）。楷体/仿宋/黑体(SimHei) 是
// 历史文档保留的键，值并入统一栈，保证旧文档与引擎 PDF 渲染一致。
export const fontFamilies: Record<string, string> = {
  雅黑: '"Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans Hebrew", sans-serif',
  黑体: '"Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", "Noto Sans Hebrew", sans-serif',
  宋体: '"Source Han Serif CN", "Source Han Serif SC", SimSun, STSong, "Noto Sans Hebrew", serif',
  楷体: '"Source Han Serif CN", "Source Han Serif SC", SimSun, STSong, "Noto Sans Hebrew", serif',
  仿宋: '"Source Han Serif CN", "Source Han Serif SC", SimSun, STSong, "Noto Sans Hebrew", serif',
};

/** 选择器只提供两个统一选项；历史文档的旧键继续可渲染。 */
export const fontFamilyOptions = ["宋体", "雅黑"] as const;

export type Entry = {
  id: string;
  title: string;
  role: string;
  department: string;
  city: string;
  start: string;
  end: string;
  html: string;
  college?: string;
  mode?: string;
};

export type BasicInfo = {
  name: string;
  phone: string;
  email: string;
  city: string;
  wechat: string;
  birth: string;
  ageMode: "age" | "birthday";
  website?: string;
  linkedin?: string;
  gender?: string;
  height?: string;
  weight?: string;
  ethnicity?: string;
  birthplace?: string;
  politicalStatus?: string;
  maritalStatus?: string;
  zodiac?: string;
  mbti?: string;
  avatar?: string;
};

export type ResumeState = {
  basic: BasicInfo;
  education: Entry[];
  skills: Entry[];
  work: Entry[];
  projects: Entry[];
  orgs: Entry[];
  research: Entry[];
  awards: Entry[];
  other: Entry[];
  portfolio: Entry[];
  custom: Entry[];
  summary: string;
};

export const moduleTitles: Record<ModuleKey, string> = {
  education: "教育经历",
  skills: "专业技能",
  work: "实习经历",
  projects: "项目经历",
  orgs: "社团和组织经历",
  research: "研究经历",
  awards: "荣誉奖项",
  other: "其他经历",
  portfolio: "作品集",
  custom: "自定义模块",
};

export const emptyResume: ResumeState = {
  basic: {
    name: "",
    phone: "",
    email: "",
    city: "",
    wechat: "",
    birth: "",
    ageMode: "age",
    website: "",
    linkedin: "",
    gender: "",
    height: "",
    weight: "",
    ethnicity: "",
    birthplace: "",
    politicalStatus: "",
    maritalStatus: "",
    zodiac: "",
    mbti: "",
    avatar: "",
  },
  education: [],
  skills: [],
  work: [],
  projects: [],
  orgs: [],
  research: [],
  awards: [],
  other: [],
  portfolio: [],
  custom: [],
  summary: "",
};

// 首次启动与清空操作使用相同的空白内容，但各持有独立对象。
export const initialResume: ResumeState = structuredClone(emptyResume);

export type SeparatorMode = "使用分隔符号" | "不使用分隔符号";

// 新增经历和重新显示空模块共用同一份初始字段。
export function createEmptyEntry(module: ModuleKey, id: string): Entry {
  return {
    id,
    title: "",
    role: "",
    department: "",
    city: "",
    start: "",
    end: "",
    html: "<p><br></p>",
    mode: module === "education" ? "全日制" : undefined,
  };
}

export type ResumeLayout = {
  font: string;
  fontSize: string;
  lineHeight: string;
  moduleSpacing: string;
  pageMargin: string;
  theme: string;
  dateFormat: "2021年1月" | "2021.01";
  titleFormat: "双行标题" | "单行标题";
  separator: SeparatorMode;
  textAlign: "系统默认" | "两端对齐";
};
