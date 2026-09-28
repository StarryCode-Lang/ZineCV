import type { ResumeVersionSnapshot } from "../legacy/domain/version-model";
import type { ModuleKey, SectionKey } from "../legacy/domain/resume-model";
import type { ResumeDocument } from "../../src-tauri/src/domain/bindings/ResumeDocument";
import type { Entry } from "../../src-tauri/src/domain/bindings/Entry";
import type { Presentation } from "../../src-tauri/src/domain/bindings/Presentation";
import type { Section } from "../../src-tauri/src/domain/bindings/Section";
import { parseLegacyRichHtml } from "./legacyRichText";

const moduleKeys: ModuleKey[] = [
  "education", "skills", "work", "projects", "orgs", "research", "awards", "other", "portfolio", "custom",
];
const sectionKeys: SectionKey[] = [...moduleKeys, "summary"];
const pxToPt = (value: number) => value * 0.75;

export type LegacySnapshotIssue = {
  issueKind: "invalidSource" | "duplicateSection" | "duplicateEntry" | "invalidLayout" |
    "unsupportedTemplate" | "fontResourcePending" | "avatarResourcePending" |
    "importedTemplatePending" | "richText" | "unknownField";
  path: string;
  detail: string;
};

export type LegacySnapshotCandidate = {
  source: ResumeVersionSnapshot;
  document: ResumeDocument | null;
  issues: LegacySnapshotIssue[];
  complete: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reportUnknownFields(value: Record<string, unknown>, path: string, known: readonly string[], issues: LegacySnapshotIssue[]): void {
  const allowed = new Set(known);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ issueKind: "unknownField", path: `${path}.${key}`, detail: "Preserved in source for review" });
  }
}

const templateDefaults = {
  "legacy-v1": { headingFontSize: "13", paragraphSpacing: "0", listSpacing: "0" },
  "clear-single-v1": { headingFontSize: "16", paragraphSpacing: "4", listSpacing: "2" },
  "compact-single-v1": { headingFontSize: "14", paragraphSpacing: "1", listSpacing: "1" },
} as const;

function readPx(value: unknown, path: string, issues: LegacySnapshotIssue[]): number {
  if (typeof value !== "string" && typeof value !== "number") {
    issues.push({ issueKind: "invalidLayout", path, detail: "Expected a CSS pixel value" });
    return 0;
  }
  const raw = String(value);
  const parsed = Number(raw);
  if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(parsed)) {
    issues.push({ issueKind: "invalidLayout", path, detail: "Expected a finite nonnegative CSS pixel value" });
    return 0;
  }
  return pxToPt(parsed);
}

export function inspectLegacySnapshot(snapshot: ResumeVersionSnapshot, documentId: string): LegacySnapshotCandidate {
  const issues: LegacySnapshotIssue[] = [];
  const fail = (path: string, detail: string): LegacySnapshotCandidate => ({
    source: snapshot, document: null,
    issues: [{ issueKind: "invalidSource", path, detail }], complete: false,
  });
  if (!isRecord(snapshot) || !isRecord(snapshot.resume) || !isRecord(snapshot.resume.basic) ||
      !isRecord(snapshot.layout) || !isRecord(snapshot.moduleNames) || !Array.isArray(snapshot.moduleOrder)) {
    return fail("snapshot", "Required legacy snapshot fields are missing");
  }
  if (!documentId.trim() || typeof snapshot.resumeTitle !== "string" || !snapshot.resumeTitle.trim() ||
      typeof snapshot.summaryTitle !== "string" || typeof snapshot.resume.summary !== "string") {
    return fail("snapshot", "Document ID, title or summary is invalid");
  }
  reportUnknownFields(snapshot, "snapshot", ["schemaVersion", "presentation", "resume", "moduleOrder", "moduleNames",
    "summaryTitle", "resumeTitle", "layout", "importedTemplate"], issues);
  reportUnknownFields(snapshot.resume, "resume", ["basic", "summary", ...moduleKeys], issues);
  const basic = snapshot.resume.basic;
  const requiredBasic = ["name", "phone", "email", "city", "wechat", "birth"] as const;
  const optionalBasic = ["website", "linkedin", "gender", "height", "weight", "ethnicity", "birthplace",
    "politicalStatus", "maritalStatus", "zodiac", "mbti", "avatar"] as const;
  if (requiredBasic.some((key) => typeof basic[key] !== "string") ||
      (basic.ageMode !== "age" && basic.ageMode !== "birthday") ||
      optionalBasic.some((key) => basic[key] !== undefined && typeof basic[key] !== "string")) {
    return fail("resume.basic", "Required basic information has an unsupported value");
  }
  reportUnknownFields(basic, "resume.basic", [...requiredBasic, ...optionalBasic, "ageMode"], issues);
  reportUnknownFields(snapshot.moduleNames, "moduleNames", moduleKeys, issues);
  const order = snapshot.moduleOrder;
  if (order.some((key) => !sectionKeys.includes(key)) || new Set(order).size !== order.length) {
    issues.push({ issueKind: "duplicateSection", path: "moduleOrder", detail: "Unknown or repeated section key" });
  }
  const visible = new Set(order);
  const orderedKeys = [...new Set(order.filter((key) => sectionKeys.includes(key))), ...sectionKeys.filter((key) => !visible.has(key))];
  const seenEntries = new Set<string>();
  const sections: Section[] = [];
  for (const key of orderedKeys) {
    if (key === "summary") {
      const result = parseLegacyRichHtml(snapshot.resume.summary);
      for (const issue of result.issues) issues.push({ issueKind: "richText", path: `resume.summary/${issue.path}`, detail: issue.issueCode });
      sections.push({ id: "legacy-section:summary", kind: "summary", title: snapshot.summaryTitle,
        visible: visible.has(key), body: result.blocks });
      continue;
    }
    const originalEntries = snapshot.resume[key];
    if (!Array.isArray(originalEntries) || typeof snapshot.moduleNames[key] !== "string") {
      return fail(`resume.${key}`, "Entries or module title are invalid");
    }
    const entries: Entry[] = [];
    for (let index = 0; index < originalEntries.length; index += 1) {
      const original = originalEntries[index];
      const path = `resume.${key}[${index}]`;
      if (!isRecord(original) || typeof original.id !== "string" || !original.id.trim() ||
          (["title", "role", "department", "city", "start", "end", "html"] as const).some((field) => typeof original[field] !== "string") ||
          (original.college !== undefined && typeof original.college !== "string") ||
          (original.mode !== undefined && typeof original.mode !== "string")) {
        return fail(path, "Entry fields are invalid");
      }
      reportUnknownFields(original, path, ["id", "title", "role", "department", "city", "start", "end", "html", "college", "mode"], issues);
      if (seenEntries.has(original.id)) issues.push({ issueKind: "duplicateEntry", path: `${path}.id`, detail: original.id });
      seenEntries.add(original.id);
      const result = parseLegacyRichHtml(original.html);
      for (const issue of result.issues) issues.push({ issueKind: "richText", path: `${path}.html/${issue.path}`, detail: issue.issueCode });
      entries.push({ id: original.id, title: original.title, role: original.role,
        department: original.department, city: original.city, start: original.start, end: original.end,
        college: original.college ?? null, mode: original.mode ?? null, body: result.blocks });
    }
    sections.push({ id: `legacy-section:${key}`, kind: key, title: snapshot.moduleNames[key],
      visible: visible.has(key), entries });
  }
  const oldPresentation = snapshot.presentation;
  if (oldPresentation && (!isRecord(oldPresentation) || typeof oldPresentation.templateId !== "string" ||
      !Number.isSafeInteger(oldPresentation.templateVersion) || !isRecord(oldPresentation.overrides) ||
      !["comfortable", "standard", "compact"].includes(oldPresentation.densityPreset))) {
    return fail("presentation", "Template presentation is invalid");
  }
  const templateId = oldPresentation?.templateId ?? "legacy-v1";
  const templateVersion = oldPresentation?.templateVersion ?? 1;
  if (!["legacy-v1", "clear-single-v1", "compact-single-v1"].includes(templateId) || templateVersion !== 1) {
    issues.push({ issueKind: "unsupportedTemplate", path: "presentation", detail: `${templateId}@${templateVersion}` });
  }
  const overrides = oldPresentation?.overrides ?? {};
  const layout = snapshot.layout;
  reportUnknownFields(layout, "layout", ["font", "fontSize", "lineHeight", "moduleSpacing", "pageMargin", "theme",
    "dateFormat", "titleFormat", "separator", "textAlign"], issues);
  const layoutKeys = ["fontSize", "lineHeight", "moduleSpacing", "pageMargin"] as const;
  const converted = Object.fromEntries(layoutKeys.map((key) => [key, readPx(layout[key], `layout.${key}`, issues)])) as Record<typeof layoutKeys[number], number>;
  const readOverride = (key: "headingFontSize" | "paragraphSpacing" | "listSpacing", fallback: string) =>
    readPx(overrides[key] ?? fallback, `presentation.overrides.${key}`, issues);
  const legacyOverrides: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
      return fail(`presentation.overrides.${key}`, "Override cannot be preserved");
    }
    legacyOverrides[key] = value;
  }
  for (const [key, value] of Object.entries(layout)) {
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) legacyOverrides[`legacyLayout.${key}`] = value;
  }
  const font = layout.font;
  if (typeof font !== "string" || !font.trim()) return fail("layout.font", "Font name is invalid");
  issues.push({ issueKind: "fontResourcePending", path: "layout.font", detail: font });
  if (basic.avatar) issues.push({ issueKind: "avatarResourcePending", path: "resume.basic.avatar", detail: "Avatar needs asset import" });
  if (snapshot.importedTemplate) issues.push({ issueKind: "importedTemplatePending", path: "importedTemplate", detail: "Imported template resources need separate transfer" });
  const choices = {
    dateFormat: ["2021年1月", "2021.01"], titleFormat: ["双行标题", "单行标题"],
    separator: ["使用分隔符号", "不使用分隔符号"], textAlign: ["系统默认", "两端对齐"],
  } as const;
  for (const key of Object.keys(choices) as Array<keyof typeof choices>) {
    if (!(choices[key] as readonly unknown[]).includes(layout[key])) return fail(`layout.${key}`, "Unknown layout choice");
  }
  if (typeof layout.theme !== "string" || !/^#[0-9a-f]{6}$/i.test(layout.theme)) return fail("layout.theme", "Theme is invalid");
  if (converted.fontSize <= 0 || converted.lineHeight <= 0 || converted.pageMargin <= 0) {
    issues.push({ issueKind: "invalidLayout", path: "layout", detail: "Text size, line height and margin must be positive" });
  }
  const defaults = templateDefaults[templateId as keyof typeof templateDefaults] ?? templateDefaults["legacy-v1"];
  const presentation: Presentation = {
    templateId, templateRevision: String(templateVersion),
    density: oldPresentation?.densityPreset ?? "standard", fontSetId: `legacy-font:${font}`,
    fontSizePt: converted.fontSize, lineHeightPt: converted.lineHeight,
    moduleGapPt: converted.moduleSpacing, pageMarginPt: converted.pageMargin,
    headingSizePt: readOverride("headingFontSize", defaults.headingFontSize),
    paragraphGapPt: readOverride("paragraphSpacing", defaults.paragraphSpacing),
    listGapPt: readOverride("listSpacing", defaults.listSpacing),
    theme: layout.theme, dateFormat: layout.dateFormat, titleFormat: layout.titleFormat,
    separator: layout.separator, textAlign: layout.textAlign, legacyOverrides,
  };
  const document: ResumeDocument = {
    schemaVersion: 2, documentId, title: snapshot.resumeTitle,
    basic: {
      name: basic.name, phone: basic.phone, email: basic.email, city: basic.city,
      wechat: basic.wechat, birth: basic.birth, ageMode: basic.ageMode,
      website: basic.website ?? null, linkedin: basic.linkedin ?? null,
      gender: basic.gender ?? null, height: basic.height ?? null,
      weight: basic.weight ?? null, ethnicity: basic.ethnicity ?? null,
      birthplace: basic.birthplace ?? null, politicalStatus: basic.politicalStatus ?? null,
      maritalStatus: basic.maritalStatus ?? null, zodiac: basic.zodiac ?? null,
      mbti: basic.mbti ?? null, avatarAssetId: null,
    }, sections, presentation,
    sourceRef: null,
    legacyExtensions: {
      importedTemplate: snapshot.importedTemplate ?? null,
      legacyAvatar: basic.avatar ?? null,
      legacyPresentation: oldPresentation ?? null,
    },
  };
  return { source: snapshot, document, issues, complete: issues.length === 0 };
}
