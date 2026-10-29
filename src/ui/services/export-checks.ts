import type { AuthorityCursor } from "../../../src-tauri/src/domain/bindings/AuthorityCursor";
import type { ResumeDocument } from "../../../src-tauri/src/domain/bindings/ResumeDocument";
import type { RichBlock } from "../../../src-tauri/src/domain/bindings/RichBlock";
import type { Inline } from "../../../src-tauri/src/domain/bindings/Inline";
import type { ModuleKey } from "../domain/resume-model";
import type { EditorNavigationTarget } from "../app/useEditorNavigation";
import type { JobMaterialListResult } from "../../../src-tauri/src/domain/bindings/JobMaterialListResult";
import type { ExportReceipt } from "../../../src-tauri/src/domain/bindings/ExportReceipt";
import { jobRequirements, suggestJobEvidence, type JobFact } from "./job-relevance";

export type ExportFinding = {
  id: string; severity: "error" | "suggestion"; message: string;
  field: string; target?: EditorNavigationTarget;
};
export type ExportReview = {
  cursor: AuthorityCursor; documentTitle: string; branchName: string; format: "pdf" | "png";
  findings: ExportFinding[]; phase: "content" | "output"; fileName?: string;
  jobEvidence?: ExportJobEvidence[];
  recentExports?: ExportReceipt[];
};
export type ExportJobEvidence = { jobTitle: string; revision: number; requirement: string; facts: string[] };
export type ExportReviewDecision = { proceed: boolean; fileName?: string };

const inlineText = (inline: Inline): string => inline.type === "text" ? inline.text
  : inline.type === "link" ? inline.children.map(inlineText).join("") : "\n";
export const richBlockText = (blocks: RichBlock[]): string => blocks.map(block => block.type === "paragraph"
  ? block.children.map(inlineText).join("") : block.items.map(richBlockText).join("\n")).join("\n");

type DateRange = { min: number; max: number; style: string; precision: number };
export function exportDateRange(value: string): DateRange | null {
  const text = value.trim();
  if (/^(至今|现在|present|current|now)$/i.test(text)) return { min: Infinity, max: Infinity, style: "present", precision: 0 };
  const match = text.match(/^(\d{4})(?:([年./-])(\d{1,2})(?:[月./-](\d{1,2})日?)?月?)?年?$/);
  if (!match) return null;
  const year = Number(match[1]), month = match[3] ? Number(match[3]) : null, day = match[4] ? Number(match[4]) : null;
  if (year < 1000 || month !== null && (month < 1 || month > 12) || day !== null && month === null) return null;
  const days = month === null ? 31 : new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day !== null && (day < 1 || day > days)) return null;
  return {
    min: Date.UTC(year, (month ?? 1) - 1, day ?? 1),
    max: (day === null ? Date.UTC(year, month ?? 12, 0) : Date.UTC(year, (month ?? 1) - 1, day)) + 86_400_000 - 1,
    style: match[2] ?? "year", precision: day !== null ? 3 : month !== null ? 2 : 1,
  };
}

const placeholder = /(?:待填写|请输入|示例姓名|您的姓名|\bTODO\b|\bTBD\b|\bLorem ipsum\b|\bX{3,}\b)/i;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export function checkExportContent(document: ResumeDocument): ExportFinding[] {
  const findings: ExportFinding[] = [];
  const add = (id: string, message: string, field: string, target?: EditorNavigationTarget, severity: ExportFinding["severity"] = "suggestion") => {
    findings.push({ id, severity, message, field, target });
  };
  if (!document.basic.name.trim()) add("missing-name", "尚未填写姓名，请确认是否适合投递。", "basic.name", { kind: "basic", fieldLabel: "姓名" });
  if (!document.basic.phone.trim() && !document.basic.email.trim()) add("missing-contact", "电话和邮箱均为空，接收方可能无法联系你。", "basic.email", { kind: "basic", fieldLabel: "邮箱" });
  if (document.basic.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(document.basic.email.trim())) add("email-shape", "邮箱格式需要核对。", "basic.email", { kind: "basic", fieldLabel: "邮箱" });
  for (const [key, value] of Object.entries(document.basic)) {
    if (typeof value === "string" && placeholder.test(value)) add(`placeholder-basic-${key}`, "基本信息中仍有占位文字。", `basic.${key}`, { kind: "basic" });
  }
  const seen = new Map<string, string>();
  const styles = new Set<string>();
  let firstDateTarget: EditorNavigationTarget | undefined;
  for (const section of document.sections) {
    if (!section.visible) continue;
    if (!("entries" in section)) {
      const text = richBlockText(section.body);
      if (!text.trim()) add(`empty-${section.id}`, `“${section.title}”已显示，但没有正文。`, `section:${section.id}`, { kind: "summary" });
      if (placeholder.test(text)) add(`placeholder-${section.id}`, `“${section.title}”中仍有占位文字。`, `section:${section.id}/body`, { kind: "summary" });
      continue;
    }
    const module = section.kind as ModuleKey;
    if (!section.entries.length) add(`empty-${section.id}`, `“${section.title}”是可见的空模块，可以补充内容或隐藏。`, `section:${section.id}`, { kind: "module", module });
    for (const entry of section.entries) {
      const target: EditorNavigationTarget = { kind: "module", module, entryId: entry.id };
      const body = richBlockText(entry.body);
      const text = [entry.title, entry.role, entry.department, entry.city, body].join(" ");
      if (placeholder.test(text)) add(`placeholder-${entry.id}`, `“${entry.title || section.title}”中仍有占位文字。`, `entry:${entry.id}/body`, target);
      if (![entry.title, entry.role, body].some(value => value.trim())) add(`empty-entry-${entry.id}`, `“${section.title}”中有空经历。`, `entry:${entry.id}`, target);
      const signature = normalize([entry.title, entry.role, entry.start, entry.end, body].join(" "));
      if (signature.length >= 12) {
        const previous = seen.get(signature);
        if (previous) add(`duplicate-${entry.id}`, `“${entry.title || section.title}”与另一条经历的标题、日期和正文完全相同，请核对是否重复。`, `entry:${entry.id}`, target);
        else seen.set(signature, entry.id);
      }
      const start = entry.start.trim() ? exportDateRange(entry.start) : null;
      const end = entry.end.trim() ? exportDateRange(entry.end) : null;
      const startTarget: EditorNavigationTarget = { ...target, fieldLabel: module === "education" ? "在读时间" : "经历时间" };
      for (const [field, value, parsed] of [["start", entry.start, start], ["end", entry.end, end]] as const) {
        if (!value.trim()) continue;
        if (!parsed) add(`date-unknown-${entry.id}-${field}`, `“${entry.title || section.title}”的日期“${value}”无法确定，请核对格式。`, `entry:${entry.id}/${field}`, field === "start" ? startTarget : { ...target, fieldLabel: "结束时间" });
        else if (parsed.precision) { styles.add(`${parsed.style}:${parsed.precision}`); firstDateTarget ??= startTarget; }
      }
      if (start && end && start.min > end.max) add(`date-order-${entry.id}`, `“${entry.title || section.title}”的开始时间晚于结束时间。`, `entry:${entry.id}/start`, startTarget, "error");
      if (!entry.start.trim() && entry.end.trim()) add(`date-missing-${entry.id}`, `“${entry.title || section.title}”缺少开始时间。`, `entry:${entry.id}/start`, startTarget);
    }
  }
  if (styles.size > 1) add("date-styles", "日期的格式或精度不一致，请核对后统一；不会把合理的并行经历判为冲突。", "dates", firstDateTarget);
  if (document.presentation.fontSizePt < 8) add("small-font", "正文字号小于 8pt，阅读可能困难；当前不会自动改版面。", "presentation.fontSizePt");
  return findings;
}

export function checkExportJobSupport(document: ResumeDocument, branchId: string, jobs: JobMaterialListResult): {
  findings: ExportFinding[]; evidence: ExportJobEvidence[];
} {
  const facts: JobFact[] = document.sections.flatMap(section => !section.visible ? [] : "entries" in section
    ? section.entries.map(entry => ({ id: entry.id, label: `${section.title} · ${entry.title || entry.role || "未命名经历"}`,
      text: [entry.title, entry.role, entry.department, richBlockText(entry.body)].join(" ") }))
    : [{ id: section.id, label: section.title, text: richBlockText(section.body) }]);
  const findings: ExportFinding[] = [], evidence: ExportJobEvidence[] = [];
  for (const link of jobs.links.filter(link => link.branchId === branchId)) {
    const latest = jobs.materials.find(material => material.id === link.jobMaterialId);
    if (!latest) continue;
    const material = latest.revision === link.jobMaterialRevision ? latest
      : jobs.revisions.find(item => item.id === latest.id && item.revision === link.jobMaterialRevision);
    if (latest.revision !== link.jobMaterialRevision) findings.push({ id: `job-stale-${link.id}`, severity: "suggestion",
      message: `“${latest.title}”已有材料修订 ${latest.revision}，此分支仍关联修订 ${link.jobMaterialRevision}，请核对岗位依据。`, field: `job:${latest.id}` });
    if (!material) {
      findings.push({ id: `job-source-${link.id}`, severity: "suggestion", message: `“${latest.title}”的关联历史依据不可用，请重新核对岗位材料。`, field: `job:${latest.id}` });
      continue;
    }
    for (const [index, requirement] of jobRequirements(material.jobDescription).entries()) {
      const matches = suggestJobEvidence(requirement, facts);
      evidence.push({ jobTitle: material.title, revision: material.revision, requirement, facts: matches.map(fact => `${fact.label}：${fact.text}`) });
      if (!matches.length) findings.push({ id: `job-gap-${link.id}-${index}`, severity: "suggestion",
        message: `“${material.title}”的要求“${requirement}”在当前可见正文中未找到文字线索。请核对真实事实，或保留缺口。`, field: `job:${material.id}/requirement:${index}` });
    }
  }
  return { findings, evidence };
}
