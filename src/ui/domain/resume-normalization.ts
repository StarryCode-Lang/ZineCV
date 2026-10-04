import {
  defaultSectionOrder,
  initialResume,
  moduleTitles,
} from "./resume-model";
import type {
  ResumeState,
  BasicInfo,
  Entry,
  ModuleKey,
  SectionKey,
} from "./resume-model";
import { createEntityId, sanitizeRichHtml } from "../utils/resume";
export function migratePersonalSites(state: ResumeState): ResumeState {
  if (state.basic.website && state.basic.linkedin) return state;
  const document = new DOMParser().parseFromString(state.summary, "text/html");
  const links = Array.from(document.querySelectorAll("a[href]"));
  const csdn = links.find((link) =>
    link.getAttribute("href")?.includes("csdn.net"),
  );
  const github = links.find((link) =>
    link.getAttribute("href")?.includes("github.com"),
  );
  if (!csdn && !github) return state;
  [csdn, github].forEach((link) => link?.closest("p")?.remove());
  return {
    ...state,
    basic: {
      ...state.basic,
      website: state.basic.website || csdn?.getAttribute("href") || "",
      linkedin: state.basic.linkedin || github?.getAttribute("href") || "",
    },
    summary: document.body.innerHTML,
  };
}

// 本地版本可能缺字段或被手工改坏；条目进入界面前统一转换为安全字符串。
function normalizeEntry(value: unknown, module: ModuleKey): Entry {
  const entry = value && typeof value === "object" ? value : {};
  const read = (key: keyof Entry) => {
    const candidate = (entry as Partial<Entry>)[key];
    return typeof candidate === "string" ? candidate : "";
  };
  return {
    id: read("id") || createEntityId(module),
    title: read("title"),
    role: read("role"),
    department: read("department"),
    city: read("city"),
    start: read("start"),
    end: read("end"),
    html: sanitizeRichHtml(read("html")),
    college: read("college") || undefined,
    mode: read("mode") || undefined,
  };
}

// 本地存档可能来自旧版本；缺失或损坏的字段在进入界面前统一补全。
export function normalizeResumeState(
  parsed: Partial<ResumeState>,
): ResumeState {
  const parsedBasic: Partial<BasicInfo> =
    parsed.basic && typeof parsed.basic === "object" ? parsed.basic : {};
  // 只保留当前模型声明的个人信息键，自动清掉旧版求职意向等废弃字段。
  const basic = Object.fromEntries(
    (Object.keys(initialResume.basic) as Array<keyof BasicInfo>).map((key) => [
      key,
      typeof parsedBasic[key] === "string"
        ? parsedBasic[key]
        : initialResume.basic[key],
    ]),
  ) as BasicInfo;
  basic.ageMode = basic.ageMode === "birthday" ? "birthday" : "age";
  const normalized = {
    ...initialResume,
    ...parsed,
    basic,
    summary:
      typeof parsed.summary === "string"
        ? sanitizeRichHtml(parsed.summary)
        : initialResume.summary,
  } as ResumeState;
  (Object.keys(moduleTitles) as ModuleKey[]).forEach((module) => {
    normalized[module] = Array.isArray(parsed[module])
      ? parsed[module].map((entry) => normalizeEntry(entry, module))
      : initialResume[module];
  });
  return normalized;
}

export function normalizeSectionOrder(value: unknown): SectionKey[] {
  if (!Array.isArray(value)) return defaultSectionOrder;
  const allowed = new Set<SectionKey>([
    ...(Object.keys(moduleTitles) as ModuleKey[]),
    "summary",
  ]);
  const unique = value.filter(
    (item, index): item is SectionKey =>
      allowed.has(item as SectionKey) && value.indexOf(item) === index,
  );
  return unique.length ? unique : defaultSectionOrder;
}
