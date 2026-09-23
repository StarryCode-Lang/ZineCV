import {
  emptyResume,
  moduleTitles,
  type Entry,
  type ModuleKey,
  type ResumeState,
  type SectionKey,
} from "../domain/resume-model";
import { createEntityId } from "../utils/resume";

export type RecognizedLine = {
  text: string;
  page?: number;
  x?: number;
  y?: number;
  fontSize?: number;
  fontName?: string;
};

type RecognizedResumeContent = {
  resume: ResumeState;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  extractedText: string;
  detectedFont?: string;
  confidence: "high" | "medium" | "low";
  warnings: string[];
};

const sectionAliases: Array<[RegExp, SectionKey, string]> = [
  [/^(教育经历|教育背景|学历|education)$/i, "education", "教育经历"],
  [
    /^(专业技能|职业技能|技能|技能特长|核心技能|skills?|vocational skills)$/i,
    "skills",
    "职业技能",
  ],
  [
    /^(工作经历|实习经历|职业经历|工作经验|experience|work experience)$/i,
    "work",
    "工作经历",
  ],
  [/^(项目经历|项目经验|项目|projects?)$/i, "projects", "项目经历"],
  [
    /^(校园经历|社团经历|组织经历|校园活动|activities|leadership)$/i,
    "orgs",
    "校园经历",
  ],
  [/^(科研经历|研究经历|论文|research)$/i, "research", "研究经历"],
  [
    /^(荣誉奖项|技能证书|资格证书|奖项|证书|honors?|awards?)$/i,
    "awards",
    "技能证书",
  ],
  [/^(作品集|作品|portfolio)$/i, "portfolio", "作品集"],
  [
    /^(自我评价|个人总结|个人简介|关于我|summary|profile)$/i,
    "summary",
    "自我评价",
  ],
  [
    /^(兴趣爱好|个人爱好|hobbies and interests|其他经历|其他|others?)$/i,
    "other",
    "兴趣爱好",
  ],
];

const dateRangePattern =
  /((?:19|20)\d{2})[./年-]?\s*(\d{1,2})?\s*(?:月)?\s*(?:-|–|—|至|~)\s*(?:(?:((?:19|20)\d{2})[./年-]?\s*(\d{1,2})?\s*(?:月)?)|(至今|现在|present))/i;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function linesToHtml(lines: string[]) {
  const clean = lines.map((line) => line.trim()).filter(Boolean);
  if (!clean.length) return "<p><br></p>";
  const bulletLike = clean.filter((line) => /^[•·▪●*-]/.test(line)).length;
  if (bulletLike >= Math.max(1, clean.length / 2))
    return `<ul>${clean.map((line) => `<li>${escapeHtml(line.replace(/^[•·▪●*-]\s*/, ""))}</li>`).join("")}</ul>`;
  return clean.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

function normalizeDate(year?: string, month?: string) {
  if (!year) return "";
  return month ? `${year}-${month.padStart(2, "0")}` : year;
}

function buildEntries(module: ModuleKey, lines: string[]): Entry[] {
  const clean = lines.map((line) => line.trim()).filter(Boolean);
  if (!clean.length) return [];
  if (module === "skills")
    return [
      {
        id: createEntityId(`import-${module}`),
        title: "",
        role: "",
        department: "",
        city: "",
        start: "",
        end: "",
        html: linesToHtml(clean),
      },
    ];
  const groups: string[][] = [];
  let current: string[] = [];
  clean.forEach((line) => {
    const startsEntry = dateRangePattern.test(line) && current.length > 0;
    if (startsEntry) {
      groups.push(current);
      current = [];
    }
    current.push(line);
  });
  if (current.length) groups.push(current);
  return groups.map((group, index) => {
    const joined = group.join(" ");
    const date = joined.match(dateRangePattern);
    const withoutDate = group.map((line) =>
      line
        .replace(dateRangePattern, "")
        .replace(/\s{2,}/g, " ")
        .trim(),
    );
    const title =
      withoutDate.find(Boolean) ?? `${moduleTitles[module]} ${index + 1}`;
    const details = withoutDate.filter((line) => line && line !== title);
    return {
      id: createEntityId(`import-${module}`),
      title,
      role: "",
      department: "",
      city: "",
      start: normalizeDate(date?.[1], date?.[2]),
      end: date?.[5] ? "至今" : normalizeDate(date?.[3], date?.[4]),
      html: linesToHtml(details),
      mode: module === "education" ? "全日制" : undefined,
    };
  });
}

function mapFontName(fonts: string[]) {
  const font = fonts.join(" ").toLowerCase();
  if (/simsun|song|宋/.test(font)) return "宋体";
  if (/simhei|hei|黑/.test(font)) return "黑体";
  if (/yahei|微软雅黑/.test(font)) return "雅黑";
  if (/kaiti|楷/.test(font)) return "楷体";
  if (/fangsong|仿宋/.test(font)) return "仿宋";
  return undefined;
}

export function structureRecognizedLines(
  inputLines: RecognizedLine[],
  source: "pdf" | "word" | "image",
): RecognizedResumeContent {
  const lines = inputLines
    .map((line) => ({ ...line, text: line.text.replace(/\s+/g, " ").trim() }))
    .filter((line) => line.text);
  const sections = new Map<SectionKey, { title: string; lines: string[] }>();
  const unassigned: string[] = [];
  const header: string[] = [];
  let activeSection: SectionKey | null = null;
  let seenSection = false;

  lines.forEach((line) => {
    const normalized = line.text.replace(/[：:|｜·•\s]+$/g, "").trim();
    const matched = sectionAliases.find(([pattern]) =>
      pattern.test(normalized),
    );
    if (matched) {
      activeSection = matched[1];
      seenSection = true;
      if (!sections.has(activeSection))
        sections.set(activeSection, { title: matched[2], lines: [] });
      return;
    }
    if (activeSection) sections.get(activeSection)?.lines.push(line.text);
    else if (!seenSection) header.push(line.text);
    else unassigned.push(line.text);
  });

  const resume: ResumeState = structuredClone(emptyResume);
  const phone = lines
    .map((line) => line.text)
    .join(" ")
    .match(/(?:\+?86[-\s]?)?1[3-9]\d{9}|(?:\+?\d[\d\s-]{7,}\d)/)?.[0];
  const email = lines
    .map((line) => line.text)
    .join(" ")
    .match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
  const website = lines
    .map((line) => line.text)
    .join(" ")
    .match(/https?:\/\/[^\s，。]+|(?:www\.)[^\s，。]+/i)?.[0];
  const name = header
    .map((line) => line.split(/[●•]/)[0].trim())
    .find(
      (line) =>
        line.length >= 2 &&
        line.length <= 24 &&
        !line.includes("@") &&
        !/\d{5,}/.test(line) &&
        !/^(个人简历|求职简历|简历|personal resume|resume)$/i.test(line) &&
        !/^(?:[●•]?\s*(?:民族|学历|出生年月|联系电话|意向职位|求职意向))/.test(
          line,
        ),
    );
  const birth = header
    .join(" ")
    .match(/出生年月\s*[：:]?\s*((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月/);
  const ethnicity = header
    .join(" ")
    .match(/民族\s*[：:]?\s*([^\s●•，,]+)/)?.[1];
  const intent = header
    .join(" ")
    .match(/(?:意向职位|求职意向)\s*[｜|:：]?\s*([^●•]+)/)?.[1]
    ?.trim();
  resume.basic = {
    ...emptyResume.basic,
    name: name ?? "",
    phone: phone ?? "",
    email: email ?? "",
    website: website ?? "",
    birth: birth ? `${birth[1]}-${birth[2].padStart(2, "0")}` : "",
    ethnicity: ethnicity ?? "",
  };

  const moduleOrder: SectionKey[] = [];
  sections.forEach((section, key) => {
    if (key === "summary") {
      resume.summary = linesToHtml(section.lines);
      moduleOrder.push("summary");
      return;
    }
    resume[key] = buildEntries(key, section.lines);
    if (resume[key].length) moduleOrder.push(key);
  });

  const headerRemainder = header.filter(
    (line) =>
      !line.startsWith(name ?? "\u0000") &&
      !/^(个人简历|求职简历|简历|personal resume|resume)$/i.test(line) &&
      !/[●•]?\s*(民族|学历|出生年月|联系电话|意向职位|求职意向)\s*[：:｜|]/.test(
        line,
      ) &&
      !line.includes(phone ?? "\u0000") &&
      !line.includes(email ?? "\u0000") &&
      !line.includes(website ?? "\u0000"),
  );
  const remaining = [
    ...(intent ? [`意向职位：${intent}`] : []),
    ...headerRemainder,
    ...unassigned,
  ];
  if (remaining.length) {
    resume.custom = buildEntries("custom", remaining);
    if (!moduleOrder.includes("custom")) moduleOrder.push("custom");
  }
  if (!moduleOrder.length && lines.length) {
    resume.custom = buildEntries(
      "custom",
      lines.map((line) => line.text),
    );
    moduleOrder.push("custom");
  }

  const fonts = lines
    .map((line) => line.fontName)
    .filter((font): font is string => Boolean(font));
  const warnings: string[] = [];
  if (source === "image")
    warnings.push(
      "图片文字由 OCR 识别；字体只能按视觉特征近似，建议在编辑页核对。 ",
    );
  if (!sections.size)
    warnings.push("未检测到明确的章节标题，内容已完整保留在“自定义模块”。");
  const extractedText = lines.map((line) => line.text).join("\n");
  return {
    resume,
    moduleOrder,
    moduleNames: {
      ...moduleTitles,
      ...(sections.has("skills")
        ? { skills: sections.get("skills")!.title }
        : {}),
      ...(sections.has("awards")
        ? { awards: sections.get("awards")!.title }
        : {}),
      ...(sections.has("other") ? { other: sections.get("other")!.title } : {}),
      ...(intent ? { custom: "求职意向" } : {}),
    },
    summaryTitle: sections.get("summary")?.title ?? "自我评价",
    extractedText,
    detectedFont: mapFontName(fonts),
    confidence: sections.size >= 3 ? "high" : sections.size ? "medium" : "low",
    warnings,
  };
}
