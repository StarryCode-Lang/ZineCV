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
  width?: number;
  height?: number;
};

// 字段级来源：page 为来源行的页码（DOCX/图片无页码时为 null，不编造），
// text 为该字段命中的第一行来源文本（识别管线的结构化证据，而非显示文本）。
export type FieldProvenance = {
  page: number | null;
  text: string;
};
export type FieldProvenanceKey =
  | `basic:${string}`
  | `section:${string}`
  | "summary";
export type RecognizedFieldProvenance = Partial<
  Record<FieldProvenanceKey, FieldProvenance>
>;

export type RecognizedResumeContent = {
  resume: ResumeState;
  moduleOrder: SectionKey[];
  moduleNames: Record<ModuleKey, string>;
  summaryTitle: string;
  extractedText: string;
  detectedFont?: string;
  confidence: "high" | "medium" | "low";
  warnings: string[];
  fieldProvenance: RecognizedFieldProvenance;
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

const sectionGlyphs: Record<string, SectionKey> = {
  "\ue76f": "education", "\ue76b": "skills", "\ue76d": "work",
  "\ue774": "projects", "\ue772": "orgs", "\ue770": "summary",
};

function matchSection(text: string) {
  const normalized = text.replace(/[：:|｜·•\s]+$/g, "").trim();
  const direct = sectionAliases.find(([pattern]) => pattern.test(normalized));
  if (direct) return direct;
  const glyphKind = sectionGlyphs[normalized[0]];
  if (!glyphKind) return undefined;
  const afterGlyph = normalized.slice(1).trim();
  return sectionAliases.find(([pattern, kind]) => kind === glyphKind && pattern.test(afterGlyph));
}
export { matchSection };

// 行首前缀匹配用的别名文本（含多词别名如 "work experience"），由既有别名
// 正则推导，最长优先，避免 "work" 抢先于 "work experience"。
const sectionAliasPrefixes = sectionAliases
  .flatMap(([pattern, kind, title]) => {
    const base = pattern.source.replace(/^\^/, "").replace(/\$$/, "").replace(/^\(/, "").replace(/\)$/, "");
    return base.split("|").flatMap(alias => {
      // "skills?" 一类正则尾量在字面前缀里取去掉量词的常见形式。
      const texts = [alias];
      if (/[a-z]\?$/i.test(alias)) texts.push(alias.slice(0, -1));
      return texts.map(text => ({ alias: text, kind, title }));
    });
  })
  .filter(entry => entry.alias)
  .sort((a, b) => b.alias.length - a.alias.length);

function splitSectionPrefix(text: string) {
  for (const { alias, kind, title } of sectionAliasPrefixes) {
    const match = new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\u00a0]*[：:]?[ \\u00a0]+(\\S.*)$`, "i").exec(text);
    if (match) return { kind, title, rest: match[1] };
  }
  return undefined;
}

// A single missing CJK glyph is a recoverable label clue, never a spelling
// rewrite. Only a unique module followed by same-page dated evidence can use
// this path; substitutions (e.g. 项目经理/项目经历) and short ambiguities cannot.
function matchTruncatedSection(text: string) {
  const normalized = text.replace(/[：:|｜·•\s]+$/g, "").trim();
  if (!/^[\u4e00-\u9fff]{3,5}$/.test(normalized)) return undefined;
  const candidates = sectionAliasPrefixes.filter(({ alias, kind }) =>
    !["skills", "summary", "portfolio"].includes(kind) && /^[\u4e00-\u9fff]+$/.test(alias)
    && alias.length === normalized.length + 1
    && [...alias].some((_, index) => alias.slice(0, index) + alias.slice(index + 1) === normalized));
  const kinds = new Set(candidates.map(candidate => candidate.kind));
  return kinds.size === 1 ? sectionAliases.find(([, kind]) => kinds.has(kind)) : undefined;
}

function samePage(left: RecognizedLine, right: RecognizedLine | undefined) {
  return right !== undefined && left.page === right.page;
}

const numericDateRangePattern =
  /((?:19|20)\d{2})[./年-]?\s*(\d{1,2})?\s*(?:月)?\s*(?:-|–|—|至|~)\s*(?:(?:((?:19|20)\d{2})[./年-]?\s*(\d{1,2})?\s*(?:月)?)|(至今|现在|present))/;
const englishMonthPattern = [
  "jan(?:uary)?", "feb(?:ruary)?", "mar(?:ch)?", "apr(?:il)?", "may", "jun(?:e)?",
  "jul(?:y)?", "aug(?:ust)?", "sep(?:t(?:ember)?)?", "oct(?:ober)?", "nov(?:ember)?", "dec(?:ember)?",
].join("|");
const englishDateRangePattern = String.raw`\b(?:(${englishMonthPattern})\.?\s+)?((?:19|20)\d{2})\s*(?:-|–|—|至|~)\s*(?:(?:(${englishMonthPattern})\.?\s+)?((?:19|20)\d{2})\b|(present|至今|现在))`;
const dateRangePattern = new RegExp(`${numericDateRangePattern.source}|${englishDateRangePattern}`, "i");
export const dateRangePatternSource = dateRangePattern.source;

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
  if (!month) return year;
  const namedMonth = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    .indexOf(month.slice(0, 3).toLowerCase());
  const numericMonth = namedMonth >= 0 ? String(namedMonth + 1) : month;
  return `${year}-${numericMonth.padStart(2, "0")}`;
}

function buildEntries(module: ModuleKey, lines: string[], warnings: string[] = []): Entry[] {
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
    const date = line.match(dateRangePattern);
    const dateOnly = date && !line.replace(date[0], "").replace(/[\s|｜,，:：]/g, "");
    const previousHasDate = current.some(item => dateRangePattern.test(item));
    // A date on its own line belongs to the preceding institution/title. When
    // another dated entry already exists, retain its last heading for the next
    // entry instead of turning the new body's first sentence into its title.
    const standaloneHeading = current.at(-1);
    if (dateOnly && previousHasDate && standaloneHeading && current.length > 1 &&
        !dateRangePattern.test(standaloneHeading) &&
        !/^[•·▪●*-]|[。.!！?？;；]$/.test(standaloneHeading)) {
      const heading = current.pop()!;
      groups.push(current);
      current = [heading, line];
      warnings.push(`${moduleTitles[module]}“${heading.slice(0, 160)}”的日期独占一行，已按相邻标题分段，请核对经历边界。`);
      return;
    }
    const startsEntry = date && previousHasDate && !dateOnly &&
      !/^[•·▪●*-]/.test(line) && !/[。.!！?？]$/.test(line);
    if (startsEntry) {
      groups.push(current);
      current = [];
    }
    current.push(line);
  });
  if (current.length) groups.push(current);
  return groups.map((group, index) => {
    const dateLineIndex = group.findIndex(line => dateRangePattern.test(line));
    const date = group[dateLineIndex]?.match(dateRangePattern);
    const withoutDate = group.map((line, lineIndex) =>
      (lineIndex === dateLineIndex ? line.replace(dateRangePattern, "") : line)
        .replace(/\s{2,}/g, " ")
        .trim(),
    );
    const titleIndex = withoutDate.findIndex(Boolean);
    let title =
      withoutDate[titleIndex] ?? `${moduleTitles[module]} ${index + 1}`;
    // Only an explicit, delimited education metadata suffix is a mode. The
    // same words in an institution name or body remain untouched.
    const educationMode = module === "education" ? title.match(/^(.+\S)\s+[-–—|｜]\s*(全日制|非全日制|交换\/交流)$/) : null;
    if (educationMode) title = educationMode[1].trim();
    const details = withoutDate.filter((line, lineIndex) => line && lineIndex !== titleIndex);
    if ((module === "education" || module === "work") && !date) {
      warnings.push(`${moduleTitles[module]}“${title.slice(0, 160)}”未识别到起止日期；原文已保留，请核对经历边界。`);
    }
    return {
      id: createEntityId(`import-${module}`),
      title,
      role: "",
      department: "",
      city: "",
      start: normalizeDate(date?.[1] ?? date?.[7], date?.[2] ?? date?.[6]),
      end: date?.[5] || date?.[10] ? "至今" : normalizeDate(date?.[3] ?? date?.[9], date?.[4] ?? date?.[8]),
      html: linesToHtml(details),
      mode: educationMode?.[2],
    };
  });
}

function phoneCandidates(lines: RecognizedLine[], header: RecognizedLine[]) {
  const candidates: Array<{ value: string; source: RecognizedLine }> = [];
  const label = /(?:联系电话|联系方式|手机|电话|mobile|phone|tel)\s*[:：]?/i;
  for (const line of lines) {
    if (!header.includes(line) && !label.test(line.text)) continue;
    // Never join different lines into a plausible phone number or treat an
    // employment date range as contact information.
    const text = line.text.replace(new RegExp(dateRangePattern.source, "gi"), " ");
    const matches = text.matchAll(/(?<![\w])(?:\+?\d[\d ()-]{5,}\d|\(\d{2,4}\)[\d ()-]{5,}\d)(?![\w])/g);
    for (const match of matches) {
      const value = match[0].trim();
      const digits = value.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15 ||
          /^(?:19|20)\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?$/.test(value) ||
          (!label.test(line.text) && !value.startsWith("+") && digits.length < 10)) continue;
      if (!candidates.some(candidate => candidate.value === value)) candidates.push({ value, source: line });
    }
  }
  return candidates;
}

function removeHeaderValue(text: string, value: string | undefined, label: string, glyph = "") {
  if (!value) return text;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${glyph ? `(?:[${glyph}]\\s*)?` : ""}(?:(?:${label})\\s*[:：]?\\s*)?${escaped}`, "i"), " ");
}

function joinWrappedDateRanges(lines: RecognizedLine[]) {
  const result: string[] = [];
  const beginning = /(?<!\d)(?:19|20)\d{2}[./年-](?:0?[1-9]|1[0-2])月?\s*[-–—至~]\s*$/;
  const ending = /^(?:(?:19|20)\d{2}[./年-](?:0?[1-9]|1[0-2])月?|至今|现在|present)$/i;
  // OCR 折行会把条目标题的短词单独断出（"Example" / "Labs 2022-01 - …"）。
  const shortTitle = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff .·]{0,18}$/;
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index], next = lines[index + 1];
    if (beginning.test(current.text) && next && ending.test(next.text) && samePage(current, next) &&
        !/(?:电话|手机|phone|mobile|tel)\s*[:：]?/i.test(current.text) && !/\d{5,}/.test(current.text)) {
      result.push(`${current.text} ${next.text}`);
      index += 1;
    } else if (next && samePage(current, next) && shortTitle.test(current.text) &&
        !dateRangePattern.test(current.text) && !matchSection(current.text) &&
        !/[。.!！?？:：]$/.test(current.text) && dateRangePattern.test(next.text) &&
        // 标题与日期整行分行是合法形态，由分段逻辑处理；只有折行把标题
        // 截断（下一行仍有正文词开头）时才重接。
        !/^\s*(?:(?:19|20)\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(next.text)) {
      result.push(`${current.text} ${next.text}`);
      index += 1;
    } else result.push(current.text);
  }
  return result;
}

function bareWebsite(header: RecognizedLine[]) {
  const domain = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s，。|｜●•]*)?/i;
  const label = /^(?:[\ue75c\ue6fe]\s*|(?:个人网站|网站|website|url)\s*[:：]\s*)/i;
  for (const [index, line] of header.entries()) {
    const prefixed = line.text.match(label);
    const previous = header[index - 1];
    const previousGlyph = previous && /^[\ue75c\ue6fe]$/.test(previous.text) && samePage(line, previous);
    if (!prefixed && !previousGlyph) continue;
    const candidate = line.text.slice(prefixed?.[0].length ?? 0).match(domain)?.[0];
    if (candidate) return { value: candidate, source: line };
  }
  return undefined;
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
  const normalized = inputLines
    .map((line) => ({ ...line, text: line.text.replace(/\s+/g, " ").trim() }))
    .filter((line) => line.text);
  // OCR 会把两三个字的姓名断成相邻碎片行（"林合"/"成"）；连续的无空格
  // 短字母/汉字行合并回一行，竖排姓名也由此还原。
  const rejoined: RecognizedLine[] = [];
  for (const line of normalized) {
    const previous = rejoined.at(-1);
    // Physical wrapping may divide a complete range at its separator or the
    // final month. Rejoin only exact numeric continuations on the same page;
    // standalone counts, headings and page-boundary fragments stay separate.
    const dateContinuation = previous && previous.page === line.page && (
      /(?:19|20)\d{2}[./-]\d{1,2}$/.test(previous.text)
        && /^[-–—至~]\s*(?:19|20)\d{2}[./-]\d{1,2}月?$/.test(line.text)
      || /(?:19|20)\d{2}[./-]\d{1,2}\s*[-–—至~]\s*(?:19|20)\d{2}[./-]$/.test(previous.text)
        && /^\d{1,2}月?$/.test(line.text));
    if (previous && dateContinuation) {
      previous.text += (/[-/.]$/.test(previous.text) ? "" : " ") + line.text;
      continue;
    }
    const fragment = /^[A-Za-z\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff]{0,2}$/;
    if (previous && previous.page === line.page && fragment.test(previous.text) && fragment.test(line.text)
      && !matchSection(previous.text) && !matchSection(line.text)) {
      previous.text = `${previous.text}${line.text}`;
    } else rejoined.push(line);
  }
  // 窄栏与 OCR 的长网址续行有三种形态：跨行断开（下一行是纯 URL 记号）、
  // 同行查询串断开（"…27 ?view=resume"）、同行域名断点（"example. invalid"）。
  // 全部原样重接，不吞并普通正文。
  const lines: RecognizedLine[] = [];
  for (const line of rejoined.map((line) => ({ ...line, text: line.text
    .replace(/(https?:\/\/[^\s，。|｜●•]+)[ \u00a0]+(?=[?&/])/gi, "$1")
    .replace(/(https?:\/\/[^\s，。|｜●•]*\.)[ \u00a0]+((?:[A-Za-z0-9\-._~%]+[./?#&=])+[A-Za-z0-9\-._~%/?#&=]*)/gi, "$1$2")
    .replace(/([\w.+-]+@[\w-]+\.)(?:[ \u00a0]+)((?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+)/g, "$1$2") }))) {
    const previous = lines.at(-1);
    const joinable = previous !== undefined && previous.page === line.page
      && /https?:\/\/[^\s]+$/.test(previous.text)
      && /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(line.text)
      && (/^[?&/#]/.test(line.text) || /[.:/_?-]$/.test(previous.text));
    if (previous && joinable) previous.text = `${previous.text}${line.text}`;
    else lines.push(line);
  }
  const sections = new Map<SectionKey, { title: string; lines: RecognizedLine[] }>();
  const unassigned: RecognizedLine[] = [];
  const header: RecognizedLine[] = [];
  let activeSection: SectionKey | null = null;
  let seenSection = false;

  const fieldProvenance: RecognizedFieldProvenance = {};
  const headingWarnings: string[] = [];
  const recordProvenance = (
    key: FieldProvenanceKey,
    source: RecognizedLine | undefined,
  ) => {
    // 只记录首个可靠来源；来源行缺失（如跨行拼接才命中的值）时不记录，页码保持 null。
    if (!source || fieldProvenance[key]) return;
    fieldProvenance[key] = {
      page: typeof source.page === "number" ? source.page : null,
      text: source.text,
    };
  };

  lines.forEach((line, index) => {
    const following = lines[index + 1];
    const standaloneGlyph = sectionGlyphs[line.text];
    if (standaloneGlyph && following && samePage(line, following) && matchSection(following.text)?.[1] === standaloneGlyph) return;
    assignLine(line, following);
  });

  // 悬挂标签与标签式版式把章节标题和首条内容放在同一行（"教育经历 合成大学
  // …"）。行首完整别名视为标题，其余文本重新走同一归类逻辑；这样标题连排
  // （"教育经历 工作经历"）也能各归各节。
  function assignLine(line: RecognizedLine, following?: RecognizedLine): void {
    const direct = matchSection(line.text);
    const truncated = !direct && samePage(line, following) && dateRangePattern.test(following!.text)
      ? matchTruncatedSection(line.text) : undefined;
    const matched = direct ?? truncated;
    if (matched) {
      if (truncated) headingWarnings.push(`章节标题“${line.text}”疑似缺字，暂按“${matched[2]}”归类，请核对来源。`);
      activeSection = matched[1];
      seenSection = true;
      if (!sections.has(activeSection))
        sections.set(activeSection, { title: matched[2], lines: [] });
      return;
    }
    const prefixed = splitSectionPrefix(line.text);
    if (prefixed) {
      activeSection = prefixed.kind;
      seenSection = true;
      if (!sections.has(activeSection))
        sections.set(activeSection, { title: prefixed.title, lines: [] });
      assignLine({ ...line, text: prefixed.rest }, following);
      return;
    }
    if (activeSection) {
      sections.get(activeSection)?.lines.push(line);
      recordProvenance(
        activeSection === "summary" ? "summary" : `section:${activeSection}`,
        line,
      );
    } else if (!seenSection) header.push(line);
    else unassigned.push(line);
  }

  const resume: ResumeState = structuredClone(emptyResume);
  const phones = phoneCandidates(lines, header);
  const phone = phones[0]?.value;
  const email = lines
    .map((line) => line.text)
    .join(" ")
    .match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
  const explicitWebsite = lines.map(line => ({ source: line, value: line.text.match(/https?:\/\/[^\s，。|｜●•]+/i)?.[0] }))
    .find(candidate => candidate.value);
  const displayedWebsite = explicitWebsite ? undefined : bareWebsite(header);
  const wwwWebsite = explicitWebsite || displayedWebsite ? undefined : lines
    .map(line => ({ source: line, value: line.text.match(/www\.[^\s，。|｜●•]+/i)?.[0] })).find(candidate => candidate.value);
  const website = explicitWebsite?.value ?? displayedWebsite?.value ?? wwwWebsite?.value;
  const websiteSource = explicitWebsite?.source ?? displayedWebsite?.source ?? wwwWebsite?.source;
  const nameLine = header
    .map((line) => ({ line, head: line.text.split(/[●•]/)[0].trim() }))
    .find(
      ({ line, head }) =>
        head.length >= 2 &&
        head.length <= 24 &&
        !head.includes("@") &&
        line !== websiteSource &&
        !/\d{5,}/.test(head) &&
        !/^(个人简历|求职简历|简历|personal resume|resume)$/i.test(head) &&
        !/^(?:[●•]?\s*(?:民族|学历|出生年月|联系电话|意向职位|求职意向))/.test(
          head,
        ),
    );
  const name = nameLine?.head;
  if (nameLine) recordProvenance("basic:name", nameLine.line);
  const headerText = header.map((line) => line.text).join(" ");
  const birthPattern =
    /出生年月\s*[：:]?\s*((?:19|20)\d{2})\s*年\s*(\d{1,2})\s*月/;
  const birth = headerText.match(birthPattern);
  if (birth)
    recordProvenance(
      "basic:birth",
      header.find((line) => birthPattern.test(line.text)),
    );
  const ethnicity = headerText.match(/民族\s*[：:]?\s*([^\s●•，,]+)/)?.[1];
  if (ethnicity)
    recordProvenance(
      "basic:ethnicity",
      header.find((line) => line.text.includes(ethnicity)),
    );
  const intentSource = header.find(
    (line) => line.text.includes("意向职位") || line.text.includes("求职意向"),
  );
  const intent = intentSource?.text
    .match(/(?:意向职位|求职意向)\s*[｜|:：]?\s*([^●•|｜]+)/)?.[1]
    ?.trim();
  if (phone)
    recordProvenance(
      "basic:phone",
      phones[0].source,
    );
  if (email)
    recordProvenance(
      "basic:email",
      lines.find((line) => line.text.includes(email)),
    );
  if (website)
    recordProvenance(
      "basic:website",
      websiteSource,
    );
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
  const warnings: string[] = [...headingWarnings];
  sections.forEach((section, key) => {
    if (key === "summary") {
      resume.summary = linesToHtml(section.lines.map((line) => line.text));
      moduleOrder.push("summary");
      return;
    }
    resume[key] = buildEntries(
      key,
      joinWrappedDateRanges(section.lines),
      warnings,
    );
    if (resume[key].length) moduleOrder.push(key);
  });

  const headerRemainder = header.flatMap((line, index) => {
    if (/^(个人简历|求职简历|简历|personal resume|resume)$/i.test(line.text)) return [];
    let text = line.text;
    if (line === nameLine?.line) text = text.replace(nameLine.head, " ");
    const next = header[index + 1];
    const standaloneContact = line.text === "\ue75b" && phone && next?.text.includes(phone) ||
      line.text === "\ue74a" && email && next?.text.includes(email) ||
      /^[\ue75c\ue6fe]$/.test(line.text) && next === websiteSource;
    if (standaloneContact && samePage(line, next)) return [];
    text = removeHeaderValue(text, phone, "联系电话|联系方式|手机|电话|mobile|phone|tel", "\ue75b");
    text = removeHeaderValue(text, email, "电子邮箱|联系方式|邮箱|email|e-mail", "\ue74a");
    text = removeHeaderValue(text, website, "个人网站|网站|website|url", "\ue75c\ue6fe");
    if (birth) text = text.replace(birthPattern, " ");
    if (ethnicity) text = removeHeaderValue(text, ethnicity, "民族");
    if (line === intentSource && intent) {
      text = removeHeaderValue(text, intent, "意向职位|求职意向");
    }
    text = text.replace(/^[\s●•|｜,，;；:：]+|[\s●•|｜,，;；:：]+$/g, "").trim();
    return text ? [{ ...line, text }] : [];
  });
  const remaining = [
    ...(intent ? [`意向职位：${intent}`] : []),
    ...headerRemainder.map((line) => line.text),
    ...unassigned.map((line) => line.text),
  ];
  if (remaining.length) {
    resume.custom = buildEntries("custom", remaining);
    if (!moduleOrder.includes("custom")) moduleOrder.push("custom");
    recordProvenance(
      "section:custom",
      intentSource ?? headerRemainder[0] ?? unassigned[0],
    );
  }
  if (!moduleOrder.length && lines.length) {
    resume.custom = buildEntries(
      "custom",
      lines.map((line) => line.text),
    );
    moduleOrder.push("custom");
    recordProvenance("section:custom", lines[0]);
  }

  const fonts = lines
    .map((line) => line.fontName)
    .filter((font): font is string => Boolean(font));
  if (!name) warnings.push("未识别到姓名，请核对基本信息和来源原文。");
  if (!phone) warnings.push("未识别到可靠的联系电话；日期和跨行数字不会作为电话，请核对是否缺失。");
  if (!email) warnings.push("未识别到邮箱，请核对是否缺失。");
  if (phones.length > 1) warnings.push("检测到多个电话候选，已暂取首项；其他号码保留在原文中，请确认联系方式归属。");
  if (website && !/^https?:\/\//i.test(website)) warnings.push("个人网站仅识别到可见地址，未取得链接协议或真实 href；已原样保留，请核对完整目标。");
  if (headerRemainder.length) warnings.push("头部有未归类文字，已保留在“自定义模块”，请核对字段归属。");
  const hasMappingUncertainty = warnings.length > 0;
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
    confidence: sections.size >= 3 && !hasMappingUncertainty ? "high" : sections.size ? "medium" : "low",
    warnings,
    fieldProvenance,
  };
}
