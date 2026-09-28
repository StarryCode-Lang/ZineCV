// 简历的数据模型与业务常量。默认示例内容位于 initial-resume.ts。
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
  | { kind: "summary" }
  | { kind: "module"; module: ModuleKey; entryIds: string[] };

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
export const fontFamilies: Record<string, string> = {
  雅黑: '"Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", sans-serif',
  黑体: 'SimHei, "Source Han Sans SC", "Noto Sans CJK SC", sans-serif',
  宋体: '"Source Han Serif CN", "Source Han Serif SC", SimSun, STSong, serif',
  楷体: 'KaiTi, STKaiti, "KaiTi SC", serif',
  仿宋: 'FangSong, STFangsong, "FangSong SC", serif',
};

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

export { initialResume } from "./initial-resume";

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
