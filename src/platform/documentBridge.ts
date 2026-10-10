// 旧版工作区快照 ↔ Rust ResumeDocument 的双向转换与最小命令求差。
// 前向（快照→文档）复用 bridge/legacySnapshot 的迁移转换器；反向（文档→快照）
// 按同一映射逐字段还原，保证 round-trip 后 canonical 相等。
import type { Entry as NativeEntry } from "../../src-tauri/src/domain/bindings/Entry";
import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";
import type { RichBlock } from "../../src-tauri/src/domain/bindings/RichBlock";
import type { Section } from "../../src-tauri/src/domain/bindings/Section";
import type { SummarySection } from "../../src-tauri/src/domain/bindings/SummarySection";
import type { DomainCommand } from "../../src-tauri/src/domain/bindings/DomainCommand";
import type { BasicPatch } from "../../src-tauri/src/domain/bindings/BasicPatch";

import { inspectLegacySnapshot } from "./legacySnapshot";
import { parseLegacyRichHtml, richBlocksToLegacyHtml } from "./legacyRichText";
import type {
  ModuleKey,
  ResumeState,
  SectionKey,
} from "../ui/domain/resume-model";
import { moduleTitles } from "../ui/domain/resume-model";
import type { ResumeVersionSnapshot } from "../ui/domain/version-model";
import type { ResumePresentation } from "../ui/domain/template-model";
import { normalizePresentation, resolveDensitySpacing } from "../ui/domain/template-model";

const ptToPx = (value: number): string => String(value / 0.75);

// Presentation is f32 in the shared contract. Match its shortest round-trip
// decimal representation so CSS arithmetic cannot cause endless CAS writes.
function nativeFloat32(value: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.fround(value);
  for (let digits = 1; digits <= 9; digits += 1) {
    const decimal = Number(rounded.toPrecision(digits));
    if (Math.fround(decimal) === rounded) return decimal;
  }
  return rounded;
}

export type DocumentConversionError = Error & { issues?: string[] };

export function documentFromSnapshot(
  snapshot: ResumeVersionSnapshot,
  documentId: string,
): ResumeDocument {
  const candidate = inspectLegacySnapshot(snapshot, documentId);
  if (!candidate.document) {
    const firstIssue = candidate.issues[0];
    const reason = firstIssue ? firstIssue.detail : "unknown reason";
    const error = new Error(
      "Workspace snapshot cannot be converted to the native document: " + reason,
    ) as DocumentConversionError;
    error.issues = candidate.issues.map(
      (issue) => issue.path + ": " + issue.detail,
    );
    throw error;
  }
  for (const key of ["fontSizePt", "lineHeightPt", "moduleGapPt", "pageMarginPt", "headingSizePt", "paragraphGapPt", "listGapPt"] as const) {
    candidate.document.presentation[key] = nativeFloat32(candidate.document.presentation[key]);
  }
  return candidate.document;
}

function presentationFromDocument(document: ResumeDocument): ResumePresentation {
  const legacy = document.legacyExtensions as Record<string, unknown> | null;
  const stored = legacy?.legacyPresentation;
  const previous = stored ? normalizePresentation(stored) : null;
  const overrides: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(document.presentation.legacyOverrides ?? {})) {
    if (!key.startsWith("legacyLayout.")) overrides[key] = value;
  }
  const native = document.presentation;
  // Unknown historical renderer identities stay recoverable through their
  // legacy fallback. Supported identities follow the current domain command.
  const historicalFallback = previous && native.templateId === "legacy-v1" &&
    (!["legacy-v1", "clear-single-v1", "compact-single-v1"].includes(previous.templateId) || previous.templateVersion !== 1);
  const templateId = historicalFallback ? previous.templateId : native.templateId;
  const templateVersion = historicalFallback ? previous.templateVersion : Number(native.templateRevision) || 1;
  const densityPreset = native.density;
  const defaults = resolveDensitySpacing(templateId, densityPreset);
  for (const [key, pt] of [["headingFontSize", native.headingSizePt], ["paragraphSpacing", native.paragraphGapPt], ["listSpacing", native.listGapPt]] as const) {
    const px = ptToPx(pt);
    if (key in overrides ? Number(overrides[key]) !== Number(px) : Number(px) !== Number(defaults[key])) overrides[key] = px;
  }
  return normalizePresentation({
    templateId,
    templateVersion,
    densityPreset,
    overrides,
  });
}

function layoutFromDocument(document: ResumeDocument) {
  const presentation = document.presentation;
  const legacy = (presentation.legacyOverrides ?? {}) as Record<string, string | number>;
  const legacyValue = (key: string, fallback: string, numeric = false): string => {
    const value = legacy["legacyLayout." + key];
    // Preserve lexical round trips only while the legacy value still represents
    // the current domain layout. Engine/CAS edits must survive hydration.
    return typeof value === "string" && (numeric ? Number(value) === Number(fallback) : value === fallback)
      ? value : fallback;
  };
  const fontMatch = presentation.fontSetId.match(/^legacy-font:(.+)$/);
  return {
    font: legacyValue("font", fontMatch ? fontMatch[1] : "宋体"),
    fontSize: legacyValue("fontSize", ptToPx(presentation.fontSizePt), true),
    lineHeight: legacyValue("lineHeight", ptToPx(presentation.lineHeightPt), true),
    moduleSpacing: legacyValue("moduleSpacing", ptToPx(presentation.moduleGapPt), true),
    pageMargin: legacyValue("pageMargin", ptToPx(presentation.pageMarginPt), true),
    theme: legacyValue("theme", presentation.theme),
    dateFormat: presentation.dateFormat,
    titleFormat: presentation.titleFormat,
    separator: presentation.separator,
    textAlign: presentation.textAlign,
  };
}

function entriesToLegacy(entries: NativeEntry[]): ResumeState[ModuleKey] {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    role: entry.role,
    department: entry.department,
    city: entry.city,
    start: entry.start,
    end: entry.end,
    html: richBlocksToLegacyHtml(entry.body),
    college: entry.college ?? undefined,
    mode: entry.mode ?? undefined,
  }));
}

function basicFromDocument(document: ResumeDocument, avatar: string): ResumeState["basic"] {
  const basic = document.basic;
  const optional = (value: string | null): string | undefined => value ?? undefined;
  return {
    name: basic.name,
    phone: basic.phone,
    email: basic.email,
    city: basic.city,
    wechat: basic.wechat,
    birth: basic.birth,
    ageMode: basic.ageMode,
    website: optional(basic.website),
    linkedin: optional(basic.linkedin),
    gender: optional(basic.gender),
    height: optional(basic.height),
    weight: optional(basic.weight),
    ethnicity: optional(basic.ethnicity),
    birthplace: optional(basic.birthplace),
    politicalStatus: optional(basic.politicalStatus),
    maritalStatus: optional(basic.maritalStatus),
    zodiac: optional(basic.zodiac),
    mbti: optional(basic.mbti),
    avatar,
  };
}

// SummarySection 的 kind 在生成绑定里是 string，无法做判别式收窄；用 body 字段判别。
function isSummarySection(section: Section): section is SummarySection {
  return "body" in section;
}

function entriesOf(section: Section): NativeEntry[] {
  if ("entries" in section) return section.entries;
  return [];
}

// ResumeDocument → 旧版工作区快照。avatar 为已解析的 data URL（无头像传空串）。
export function snapshotFromDocument(
  document: ResumeDocument,
  avatar: string,
): ResumeVersionSnapshot {
  const resume: ResumeState = {
    basic: basicFromDocument(document, avatar),
    education: [], skills: [], work: [], projects: [], orgs: [],
    research: [], awards: [], other: [], portfolio: [], custom: [],
    summary: "",
  };
  const moduleNames = { ...moduleTitles };
  const moduleOrder: SectionKey[] = [];
  let summaryTitle = "自我评价";
  for (const section of document.sections) {
    if (isSummarySection(section)) {
      if (section.visible) moduleOrder.push("summary");
      summaryTitle = section.title;
      resume.summary = richBlocksToLegacyHtml(section.body);
      continue;
    }
    const moduleKey = section.kind as ModuleKey;
    moduleNames[moduleKey] = section.title;
    if (section.visible) moduleOrder.push(moduleKey);
    resume[moduleKey] = entriesToLegacy(section.entries);
  }
  const legacy = document.legacyExtensions as Record<string, unknown> | null;
  const importedTemplate = (legacy?.importedTemplate ?? null) as
    | { id: string; name: string; revisionHash?: string }
    | null;
  return {
    schemaVersion: 2,
    presentation: presentationFromDocument(document),
    resume,
    moduleOrder,
    moduleNames,
    summaryTitle,
    resumeTitle: document.title,
    layout: layoutFromDocument(document),
    importedTemplate,
  };
}

// ---- canonical 相等与命令求差 ----

export function canonicalJsonValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonValue).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return "{" + entries
    .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJsonValue(item))
    .join(",") + "}";
}

export function documentsEqual(left: ResumeDocument, right: ResumeDocument): boolean {
  return canonicalJsonValue(left) === canonicalJsonValue(right);
}

const richBlockCache = new Map<string, RichBlock[]>();

export function blocksFromLegacyHtml(html: string): RichBlock[] {
  const cached = richBlockCache.get(html);
  if (cached) return cached;
  const blocks = parseLegacyRichHtml(html).blocks;
  richBlockCache.set(html, blocks);
  if (richBlockCache.size > 400) {
    const oldest = richBlockCache.keys().next().value;
    if (oldest !== undefined) richBlockCache.delete(oldest);
  }
  return blocks;
}

const BASIC_STRING_FIELDS = [
  "name", "phone", "email", "city", "wechat", "birth",
  "website", "linkedin", "gender", "height", "weight", "ethnicity",
  "birthplace", "politicalStatus", "maritalStatus", "zodiac", "mbti",
] as const;

const ENTRY_STRING_FIELDS = [
  "title", "role", "department", "city", "start", "end", "college", "mode",
] as const;

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? null) === (right ?? null);
}

function basicPatchFrom(
  current: ResumeDocument["basic"],
  desired: ResumeDocument["basic"],
): BasicPatch | null {
  // Rust 侧 null 表示“不修改”；因此总是发全字段 patch，仅变更字段携带新值。
  let changed = false;
  const patch: BasicPatch = {
    name: null, phone: null, email: null, city: null, wechat: null, birth: null,
    ageMode: null, website: null, linkedin: null, gender: null, height: null,
    weight: null, ethnicity: null, birthplace: null, politicalStatus: null,
    maritalStatus: null, zodiac: null, mbti: null, avatarAssetId: null,
  };
  for (const field of BASIC_STRING_FIELDS) {
    if (!sameText(current[field], desired[field])) {
      patch[field] = desired[field] ?? null;
      changed = true;
    }
  }
  if (current.ageMode !== desired.ageMode) {
    patch.ageMode = desired.ageMode;
    changed = true;
  }
  if (!sameText(current.avatarAssetId, desired.avatarAssetId)) {
    // 空字符串是“清除头像”的约定哨兵（见 domain.rs UpdateBasic）。
    patch.avatarAssetId = desired.avatarAssetId ?? "";
    changed = true;
  }
  return changed ? patch : null;
}

function entryFieldPatch(
  left: NativeEntry,
  right: NativeEntry,
): { title: string | null; role: string | null; department: string | null; city: string | null; start: string | null; end: string | null; college: string | null; mode: string | null } | null {
  let changed = false;
  const patch = {
    title: null as string | null, role: null as string | null,
    department: null as string | null, city: null as string | null,
    start: null as string | null, end: null as string | null,
    college: null as string | null, mode: null as string | null,
  };
  for (const field of ENTRY_STRING_FIELDS) {
    if (!sameText(left[field], right[field])) {
      patch[field] = right[field] ?? null;
      changed = true;
    }
  }
  return changed ? patch : null;
}

// 返回把 current 演进为 desired 的下一条命令；相等时返回 null。
// 调用方循环应用（每条命令后以返回的最新文档重新求差），直到收敛。
export function nextDocumentCommand(
  current: ResumeDocument,
  desired: ResumeDocument,
): DomainCommand | null {
  if (current.title !== desired.title) {
    return { type: "setDocumentTitle", title: desired.title };
  }

  const basicPatch = basicPatchFrom(current.basic, desired.basic);
  if (basicPatch) {
    return { type: "updateBasic", patch: basicPatch };
  }

  const currentSections = new Map(current.sections.map((section) => [section.id, section]));
  // 1) 内容优先：正文、条目字段、增删（与顺序无关，先保证内容收敛）。
  for (const section of desired.sections) {
    const before = currentSections.get(section.id);
    if (!before) continue;
    if (isSummarySection(section)) {
      const beforeBody = isSummarySection(before) ? before.body : null;
      if (canonicalJsonValue(beforeBody) !== canonicalJsonValue(section.body)) {
        return { type: "setSummaryBody", section_id: section.id, body: section.body };
      }
      continue;
    }
    const beforeEntries = entriesOf(before);
    const beforeById = new Map(beforeEntries.map((entry) => [entry.id, entry]));
    for (const entry of section.entries) {
      const existing = beforeById.get(entry.id);
      if (!existing) {
        return { type: "addEntry", section_id: section.id, entry };
      }
      const fieldPatch = entryFieldPatch(existing, entry);
      if (fieldPatch) {
        return { type: "updateEntryFields", entry_id: entry.id, ...fieldPatch };
      }
      if (canonicalJsonValue(existing.body) !== canonicalJsonValue(entry.body)) {
        return { type: "setEntryBody", entry_id: entry.id, body: entry.body };
      }
    }
    const desiredIds = new Set(section.entries.map((entry) => entry.id));
    for (const entry of beforeEntries) {
      if (!desiredIds.has(entry.id)) {
        return { type: "deleteEntry", entry_id: entry.id };
      }
    }
  }

  // 2) 可见性与标题。
  for (const section of desired.sections) {
    const before = currentSections.get(section.id);
    if (!before) continue;
    if (before.visible !== section.visible) {
      return { type: "setSectionVisibility", section_id: section.id, visible: section.visible };
    }
    if (before.title !== section.title) {
      return { type: "renameSection", section_id: section.id, title: section.title };
    }
  }

  // 3) 章节顺序：把第一个错位的 section 移到目标位置。
  for (let index = 0; index < desired.sections.length; index += 1) {
    if (current.sections[index]?.id !== desired.sections[index].id) {
      return {
        type: "moveSection",
        section_id: desired.sections[index].id,
        index,
      };
    }
  }

  // 4) 条目顺序（章节顺序稳定后）。
  for (const section of desired.sections) {
    if (isSummarySection(section)) continue;
    const before = currentSections.get(section.id);
    const beforeEntries = before ? entriesOf(before) : [];
    for (let index = 0; index < section.entries.length; index += 1) {
      if (beforeEntries[index]?.id !== section.entries[index].id) {
        return {
          type: "moveEntry",
          entry_id: section.entries[index].id,
          section_id: section.id,
          index,
        };
      }
    }
  }

  // 5) 排版最后应用，避免触发中间态。
  if (canonicalJsonValue(current.presentation) !== canonicalJsonValue(desired.presentation)) {
    return { type: "setLayout", presentation: desired.presentation };
  }

  // 6) 封存元数据（迁移来源等）：无功能语义但必须随版本快照保真。
  if (canonicalJsonValue(current.legacyExtensions ?? {}) !== canonicalJsonValue(desired.legacyExtensions ?? {})) {
    return {
      type: "setLegacyExtensions",
      extensions: (desired.legacyExtensions ?? {}) as Record<string, unknown>,
    };
  }
  return null;
}
