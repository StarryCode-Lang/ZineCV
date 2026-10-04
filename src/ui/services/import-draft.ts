import type { Entry as NativeEntry } from "../../../src-tauri/src/domain/bindings/Entry";
import type { AuthorityCursor } from "../../../src-tauri/src/domain/bindings/AuthorityCursor";
import type { ImportBasicField } from "../../../src-tauri/src/domain/bindings/ImportBasicField";
import type { ImportCandidate } from "../../../src-tauri/src/domain/bindings/ImportCandidate";
import type { ImportDraft } from "../../../src-tauri/src/domain/bindings/ImportDraft";
import type { ModuleKind } from "../../../src-tauri/src/domain/bindings/ModuleKind";
import type { RichBlock } from "../../../src-tauri/src/domain/bindings/RichBlock";
import { blocksFromLegacyHtml } from "../../platform/documentBridge";
import { isTauriRuntime, nativeInvoke } from "../../platform/ipc";
import type { Entry, ModuleKey } from "../domain/resume-model";
import type { ImportedTemplate } from "../domain/imported-template";
import { createEntityId } from "../utils/resume";
import { IMPORT_LIMITS } from "./import-limits";
import type { FieldProvenance } from "./resume-content-recognition";
import {
  importedTemplateFieldProvenance,
  recognizeTemplate,
} from "./template-import";

export type ImportTarget = {
  cursor: AuthorityCursor;
  sessionEpoch: number;
};

const moduleKinds: Record<ModuleKey, ModuleKind> = {
  education: "education",
  skills: "skills",
  work: "work",
  projects: "projects",
  orgs: "orgs",
  research: "research",
  awards: "awards",
  other: "other",
  portfolio: "portfolio",
  custom: "custom",
};

function sourceKind(file: File): "pdf" | "docx" | "image" {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (file.type.startsWith("image/")) return "image";
  if (extension === "pdf" || file.type === "application/pdf") return "pdf";
  if (extension === "docx") return "docx";
  throw new Error("仅支持图片、PDF 或 DOCX 格式的简历");
}

function confidence(value: ImportedTemplate["recognitionConfidence"]): string {
  return value ?? "unknown";
}

function evidence(
  field: string,
  value: string,
  extractedText: string,
  confidenceValue: string,
  source?: FieldProvenance,
) {
  // page 与 excerpt 优先取识别管线保留的结构化来源（首个可靠来源行），
  // 无结构化来源（DOCX/图片无页码、或值跨行拼接无法定位）时 page 保持 null，
  // 不编造页码；excerpt 回退到既有的全文行匹配行为。
  const excerpt =
    source?.text ??
    extractedText
      .split(/\r?\n/)
      .find((line) => line.toLocaleLowerCase().includes(value.toLocaleLowerCase())) ??
    value;
  return {
    page: source?.page ?? null,
    excerpt: excerpt.slice(0, 512),
    sourceField: field,
    confidence: confidenceValue,
  };
}

function nativeEntry(entry: Entry): NativeEntry {
  return {
    id: entry.id,
    title: entry.title,
    role: entry.role,
    department: entry.department,
    city: entry.city,
    start: entry.start,
    end: entry.end,
    college: entry.college ?? null,
    mode: entry.mode ?? null,
    body: blocksFromLegacyHtml(entry.html),
  };
}

function candidatesFrom(template: ImportedTemplate): {
  candidates: ImportCandidate[];
  warnings: string[];
  unsupported: string[];
} {
  const resume = template.resume;
  if (!resume) return { candidates: [], warnings: [...(template.recognitionWarnings ?? [])], unsupported: [] };
  const confidenceValue = confidence(template.recognitionConfidence);
  const text = template.extractedText ?? "";
  const provenance = importedTemplateFieldProvenance(template);
  const candidates: ImportCandidate[] = [];
  const warnings = [...(template.recognitionWarnings ?? [])];
  const unsupported: string[] = [];
  const basicFields: Array<[ImportBasicField, string, string]> = [
    ["name", "姓名", resume.basic.name],
    ["phone", "电话", resume.basic.phone],
    ["email", "邮箱", resume.basic.email],
    ["city", "城市", resume.basic.city],
    ["wechat", "微信", resume.basic.wechat],
    ["birth", "出生日期", resume.basic.birth],
    ["website", "个人网站", resume.basic.website ?? ""],
    ["linkedin", "LinkedIn", resume.basic.linkedin ?? ""],
    ["gender", "性别", resume.basic.gender ?? ""],
    ["height", "身高", resume.basic.height ?? ""],
    ["weight", "体重", resume.basic.weight ?? ""],
    ["ethnicity", "民族", resume.basic.ethnicity ?? ""],
    ["birthplace", "籍贯", resume.basic.birthplace ?? ""],
    ["politicalStatus", "政治面貌", resume.basic.politicalStatus ?? ""],
    ["maritalStatus", "婚姻状况", resume.basic.maritalStatus ?? ""],
    ["zodiac", "星座", resume.basic.zodiac ?? ""],
    ["mbti", "MBTI", resume.basic.mbti ?? ""],
  ];
  for (const [field, label, value] of basicFields) {
    if (!value.trim()) continue;
    candidates.push({
      id: createEntityId("candidate"),
      label,
      value: { type: "basicField", field, value },
      evidence: evidence(field, value, text, confidenceValue, provenance[`basic:${field}`]),
    });
  }
  for (const [module, kind] of Object.entries(moduleKinds) as Array<[ModuleKey, ModuleKind]>) {
    const entries = resume[module];
    if (!entries.length) continue;
    if (entries.length > 100) {
      unsupported.push(`${module} 超过 100 条，仅提供前 100 条供审阅。`);
    }
    const bounded = entries.slice(0, 100);
    candidates.push({
      id: createEntityId("candidate"),
      label: template.moduleNames?.[module] ?? module,
      value: {
        type: "sectionEntries",
        kind,
        title: template.moduleNames?.[module] ?? module,
        entries: bounded.map(nativeEntry),
      },
      evidence: evidence(
        module,
        bounded[0]?.title || bounded[0]?.role || bounded[0]?.html || "导入的经历内容",
        text,
        confidenceValue,
        provenance[`section:${module}`],
      ),
    });
  }
  if (resume.summary.trim()) {
    const body = blocksFromLegacyHtml(resume.summary) as RichBlock[];
    candidates.push({
      id: createEntityId("candidate"),
      label: template.summaryTitle ?? "自我评价",
      value: {
        type: "summaryBody",
        title: template.summaryTitle ?? "自我评价",
        body,
      },
      evidence: evidence(
        "summary",
        resume.summary.replace(/<[^>]*>/g, " ").trim(),
        text,
        confidenceValue,
        provenance["summary"],
      ),
    });
  }
  if (resume.basic.avatar) {
    unsupported.push("识别到可能的头像区域，请在编辑器中人工选择并核对头像。");
  }
  if (!candidates.length) warnings.push("没有生成可应用的候选字段；当前文档不会发生更改。");
  return { candidates, warnings, unsupported };
}

async function sha256(file: File): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

function transition(
  draftId: string,
  expectedStatus: ImportDraft["status"],
  nextStatus: ImportDraft["status"],
  values: Partial<Pick<ImportDraft, "candidates" | "warnings" | "unsupportedFeatures">> = {},
  previewDataUrl: string | null = null,
) {
  return nativeInvoke("transition_import_draft", {
    request: {
      draftId,
      expectedStatus,
      nextStatus,
      candidates: values.candidates ?? null,
      warnings: values.warnings ?? null,
      unsupportedFeatures: values.unsupportedFeatures ?? null,
      previewDataUrl,
    },
  }) as Promise<ImportDraft>;
}

export async function createImportReviewDraft(
  file: File,
  onProgress: (message: string) => void,
  callerSignal?: AbortSignal,
): Promise<{ draft: ImportDraft; previewDataUrl: string }> {
  if (!isTauriRuntime()) throw new Error("导入审阅需要桌面原生存储");
  if (file.size > IMPORT_LIMITS.fileBytes) throw new Error("文件不能超过 18MB");
  if (callerSignal?.aborted) throw new DOMException("导入已取消", "AbortError");
  const draftId = createEntityId("import-draft");
  const draft = (await nativeInvoke("create_import_draft", {
    request: {
      draftId,
      sourceKind: sourceKind(file),
      displayName: file.name,
      sourceHash: await sha256(file),
    },
  })) as ImportDraft;
  await transition(draft.id, "queued", "running");

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), IMPORT_LIMITS.timeoutMs);
  const timedAbort = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new DOMException("导入超过两分钟限额或已取消", "AbortError")),
      { once: true },
    );
  });
  try {
    onProgress("正在读取文件并识别正文…");
    const parsed = await Promise.race([
      recognizeTemplate(file, onProgress, controller.signal),
      timedAbort,
    ]);
    if (controller.signal.aborted || callerSignal?.aborted)
      throw new DOMException("导入已取消", "AbortError");
    const mapped = candidatesFrom(parsed);
    if (!parsed.previewDataUrl) throw new Error("源文件预览未生成，导入草稿未进入审阅");
    if (new TextEncoder().encode(JSON.stringify(mapped)).length > IMPORT_LIMITS.reviewBytes)
      throw new Error("识别结果超过 2 MiB 审阅上限，请拆分或缩小源文件后重试");
    onProgress("正在保存待审草稿…");
    const reviewDraft = await transition(
      draft.id,
      "running",
      "review_required",
      {
        candidates: mapped.candidates,
        warnings: mapped.warnings,
        unsupportedFeatures: mapped.unsupported,
      },
      parsed.previewDataUrl,
    );
    return { draft: reviewDraft, previewDataUrl: parsed.previewDataUrl };
  } catch (error) {
    const cancelled = controller.signal.aborted || callerSignal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError");
    try {
      await transition(draft.id, "running", cancelled ? "cancelled" : "failed");
    } catch {
      // Keep the parser failure visible; a state-transition failure is recorded by native diagnostics.
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function cancelImportReviewDraft(draft: ImportDraft): Promise<void> {
  if (draft.status === "committed" || draft.status === "failed" || draft.status === "cancelled") return;
  await transition(draft.id, draft.status, "cancelled");
}
