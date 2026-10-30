import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AgentProposalInbox } from "../../../../src-tauri/src/domain/bindings/AgentProposalInbox";
import type { AgentProposalReceipt } from "../../../../src-tauri/src/domain/bindings/AgentProposalReceipt";
import type { AgentProposalRecord } from "../../../../src-tauri/src/domain/bindings/AgentProposalRecord";
import type { AgentProposalUndoRecord } from "../../../../src-tauri/src/domain/bindings/AgentProposalUndoRecord";
import { nativeInvoke } from "../../../platform/ipc";
import { sameCursor } from "../../../platform/NativeDocumentClient";
import {
  flushDraftBeforeVersionAction,
  nativeClient,
  reloadWorkspaceState,
} from "../../../platform/workspace";
import type { ImportedTemplate } from "../../domain/imported-template";
import type { ResumeState } from "../../domain/resume-model";
import {
  moduleTitles,
  type BasicInfo,
  type Entry,
  type ModuleKey,
} from "../../domain/resume-model";
import type {
  ResumeVersionSnapshot,
  ResumeVersionStore,
} from "../../domain/version-model";
import { stripHtml } from "../../utils/resume";
import {
  nodeId,
  safeMessage,
  sanitizeProposalHtml,
  signature
} from "../agentOverlayUtils";
import type {
  AgentEditPatch,
  AgentEditTarget,
  AgentMessage,
  AgentProposal,
  AgentView
} from "../types";
import { basicTargets, CatalogAgentReference, currentBranchOf, describeTemplateEffects, entryTargets } from './shared';
// 原生提议三操作（确认/拒绝/撤回）共用的互斥门与回执上下文。
type NativeProposalGateContext = {
  acceptingProposalIds: RefObject<Set<string>>;
  setAcceptingProposalId: Dispatch<SetStateAction<string | null>>;
  proposalCommandId: (key: string) => string;
  onNativeWorkspaceReload: (snapshot: ResumeVersionSnapshot) => void;
  refreshNativeProposalInbox: () => Promise<AgentProposalInbox | null>;
  appendMessage: (message: Omit<AgentMessage, "id">) => void;
  setLocalError: Dispatch<SetStateAction<string>>;
};
export function runBuildResumeProposal(context: {
  resume: ResumeState;
  moduleNames: Record<ModuleKey, string>;
  workingSnapshot: ResumeVersionSnapshot;
  versionStore: ResumeVersionStore;
  referenceCatalog: CatalogAgentReference[];
  templates: ImportedTemplate[];
  activeTemplateId: string | null;
}, call: { id: string; name: string; arguments: string }, sourceView: AgentView, sourceRefs: string[]): AgentProposal | null {
  const {
    resume, moduleNames, workingSnapshot, versionStore, referenceCatalog, templates, activeTemplateId,
  } = context;

  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(call.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    args = parsed;
  } catch {
    return null;
  }
  const proposalEnvelope = {
    expectedSnapshotSignature: signature(workingSnapshot),
    expectedBranchId: versionStore.currentBranchId,
    expectedHeadId: currentBranchOf(versionStore)?.headCommitId ?? null,
    sourceView,
    sourceRefs,
  };
  if (call.name === "propose_resume_entry_delete") {
    const module = args.module as ModuleKey;
    const id = args.id;
    if (typeof module !== "string" || typeof id !== "string") return null;
    const authorized =
      sourceRefs.includes(`module:${module}`) ||
      sourceRefs.includes(`entry:${module}:${id}`);
    const currentEntry = resume[module]?.find((entry) => entry.id === id);
    if (!authorized || !currentEntry) return null;
    return {
      id: nodeId("proposal"),
      kind: "resume-delete",
      title: `删除经历：${currentEntry.title || moduleNames[module] || moduleTitles[module]}`,
      explanation:
        safeMessage(args.explanation) ||
        "请核对要删除的经历及时间，确认后才会移除。",
      target: { module, id },
      expectedValue: currentEntry,
      ...proposalEnvelope,
    };
  }
  if (call.name === "propose_resume_patch") {
    const rawTarget = args.target as Record<string, unknown> | undefined;
    const rawPatch = args.patch as Record<string, unknown> | undefined;
    if (!rawTarget || !rawPatch || !sourceRefs.length) return null;
    const selected = sourceRefs
      .map((id) => referenceCatalog.find((reference) => reference.id === id))
      .filter((reference): reference is CatalogAgentReference =>
        Boolean(reference),
      );
    let target: AgentEditTarget | null = null;
    let expectedValue: unknown;
    let patch: AgentEditPatch | null = null;
    if (rawTarget.kind === "basic" && typeof rawTarget.key === "string") {
      const key = rawTarget.key as keyof BasicInfo;
      if (
        !basicTargets.has(key) ||
        !selected.some((reference) => reference.id === `basic:${key}`)
      )
        return null;
      target = { kind: "basic", key };
      expectedValue = resume.basic[key];
      if (!String(expectedValue ?? "").trim()) return null;
      if (
        Object.keys(rawPatch).length !== 1 ||
        typeof rawPatch.value !== "string" ||
        rawPatch.value.length > 3000
      )
        return null;
      patch = { value: safeMessage(rawPatch.value) };
    } else if (rawTarget.kind === "summary") {
      if (!selected.some((reference) => reference.kind === "summary"))
        return null;
      const text =
        typeof rawPatch.text === "string" ? rawPatch.text : rawPatch.html;
      if (
        typeof text !== "string" ||
        text.length > 5000 ||
        Object.keys(rawPatch).some((key) => !["html", "text"].includes(key))
      )
        return null;
      target = { kind: "summary" };
      expectedValue = resume.summary;
      if (!stripHtml(resume.summary)) return null;
      patch = { html: sanitizeProposalHtml(text) };
    } else if (
      rawTarget.kind === "entry" &&
      typeof rawTarget.module === "string" &&
      typeof rawTarget.id === "string"
    ) {
      const module = rawTarget.module as ModuleKey;
      const selectedEntry = selected.find(
        (reference) =>
          reference.module === module &&
          (reference.kind === "module" ||
            (reference.kind === "entry" &&
              reference.entry?.id === rawTarget.id)),
      );
      const currentEntry = resume[module]?.find(
        (entry) => entry.id === rawTarget.id,
      );
      if (!selectedEntry || !currentEntry) return null;
      if (
        ![
          currentEntry.title,
          currentEntry.role,
          currentEntry.department,
          currentEntry.city,
          currentEntry.start,
          currentEntry.end,
          stripHtml(currentEntry.html),
        ].some((value) => value?.trim())
      )
        return null;
      const cleanPatch: Partial<Omit<Entry, "id">> = {};
      for (const [key, value] of Object.entries(rawPatch)) {
        if (!entryTargets.has(key as keyof Omit<Entry, "id">)) return null;
        if (key === "html") {
          if (typeof value !== "string" || value.length > 5000) return null;
          cleanPatch.html = sanitizeProposalHtml(value);
          if (cleanPatch.html.length > 5000) return null;
        } else if (typeof value === "string" && value.length <= 5000)
          cleanPatch[key as keyof Omit<Entry, "id">] = safeMessage(
            value,
          ) as never;
        else return null;
      }
      if (!Object.keys(cleanPatch).length) return null;
      target = { kind: "entry", module, id: currentEntry.id };
      expectedValue = currentEntry;
      patch = cleanPatch;
    }
    if (!target || !patch) return null;
    return {
      id: nodeId("proposal"),
      kind: "resume-edit",
      title: "简历修改提议",
      explanation:
        safeMessage(args.explanation) ||
        "模型建议修改所选字段，请核对事实后决定。",
      target,
      patch,
      expectedValue,
      ...proposalEnvelope,
    };
  }
  if (call.name === "propose_template_application") {
    const templateId =
      typeof args.templateId === "string" ? args.templateId : "";
    const templateRef = sourceRefs
      .map((id) => referenceCatalog.find((reference) => reference.id === id))
      .find(
        (reference) =>
          reference?.kind === "template" &&
          reference.templateId === templateId,
      );
    const template =
      templateId && templateRef
        ? templates.find((item) => item.id === templateId)
        : null;
    if (!template) return null;
    const effects = describeTemplateEffects(
      template,
      workingSnapshot,
      activeTemplateId,
    );
    return {
      id: nodeId("proposal"),
      kind: "apply-template",
      title: `应用模板：${template.name}`,
      explanation:
        safeMessage(args.explanation) || "此操作将按下方清单更新当前简历。",
      templateId,
      effects,
      ...proposalEnvelope,
      expectedTemplateSignature: signature(template),
    };
  }
  if (call.name === "propose_version_save") {
    const hasDraftReference = sourceRefs.includes("draft:current");
    if (!hasDraftReference) return null;
    const branch = currentBranchOf(versionStore);
    if (!branch || typeof args.message !== "string") return null;
    const message = safeMessage(args.message).slice(0, 120);
    if (!message) return null;
    return {
      id: nodeId("proposal"),
      kind: "save-version",
      title: "保存当前版本",
      explanation:
        safeMessage(args.explanation) || "保存当前工作区快照到此分支。",
      message,
      branchId: branch.id,
      expectedHeadId: branch.headCommitId,
      expectedSnapshotSignature: signature(workingSnapshot),
      sourceView,
      sourceRefs,
    };
  }
  return null;

}

export async function runAcceptNativeProposal(context: NativeProposalGateContext, proposal: AgentProposalRecord, acceptedItemIds: string[]): Promise<void> {
  const {
    acceptingProposalIds, setAcceptingProposalId, proposalCommandId, onNativeWorkspaceReload,
    refreshNativeProposalInbox, appendMessage, setLocalError,
  } = context;

  if (acceptingProposalIds.current.size || !acceptedItemIds.length) return;
  acceptingProposalIds.current.add(proposal.id);
  setAcceptingProposalId(proposal.id);
  const sortedItemIds = [...acceptedItemIds].sort();
  const commandKey = `confirm:${proposal.id}:${sortedItemIds.join(",")}`;
  try {
    await flushDraftBeforeVersionAction();
    const cursor = nativeClient.snapshot?.cursor;
    if (!cursor) throw new Error("权威文档尚未加载");
    const receipt = await nativeInvoke("confirm_proposal", {
      request: {
        commandId: proposalCommandId(commandKey),
        cursor,
        proposalId: proposal.id,
        acceptedItemIds: sortedItemIds,
      },
    }) as AgentProposalReceipt;
    const { state, snapshot } = await reloadWorkspaceState();
    if (!sameCursor(receipt.cursor, state.cursor))
      throw new Error("确认回执与当前文档状态不一致；已保留原生收据，请刷新后核对");
    onNativeWorkspaceReload(snapshot);
    await refreshNativeProposalInbox();
    appendMessage({
      role: "assistant",
      text: `已确认并原子应用 ${receipt.acceptedItemIds.length} 项；可在此会话撤回。`,
    });
    setLocalError("");
  } catch (error) {
    let recovered = false;
    try {
      const inbox = await refreshNativeProposalInbox();
      if (inbox?.undoable.some((item) => item.proposalId === proposal.id)) {
        const { state, snapshot } = await reloadWorkspaceState();
        const undo = inbox.undoable.find((item) => item.proposalId === proposal.id);
        if (undo && sameCursor(undo.cursor, state.cursor)) {
          onNativeWorkspaceReload(snapshot);
          appendMessage({
            role: "assistant",
            text: "确认已由宿主提交并保存回执，界面已从权威文档恢复。",
          });
          setLocalError("");
          recovered = true;
        }
      }
    } catch {
      // Keep the original error visible; a later inbox refresh can recover the durable result.
    }
    if (!recovered)
      setLocalError(error instanceof Error ? error.message : String(error));
  } finally {
    acceptingProposalIds.current.delete(proposal.id);
    setAcceptingProposalId(null);
  }

}

export async function runRejectNativeProposal(context: Pick<NativeProposalGateContext,
  "acceptingProposalIds" | "setAcceptingProposalId" | "proposalCommandId" | "refreshNativeProposalInbox" | "appendMessage" | "setLocalError"
>, proposal: AgentProposalRecord): Promise<void> {
  const {
    acceptingProposalIds, setAcceptingProposalId, proposalCommandId, refreshNativeProposalInbox, appendMessage,
    setLocalError,
  } = context;

  if (acceptingProposalIds.current.size) return;
  acceptingProposalIds.current.add(proposal.id);
  setAcceptingProposalId(proposal.id);
  try {
    await nativeInvoke("reject_proposal", {
      request: {
        commandId: proposalCommandId(`reject:${proposal.id}`),
        proposalId: proposal.id,
      },
    });
    await refreshNativeProposalInbox();
    appendMessage({ role: "assistant", text: "已拒绝这条提议，简历数据未改动。" });
    setLocalError("");
  } catch (error) {
    setLocalError(error instanceof Error ? error.message : String(error));
    await refreshNativeProposalInbox().catch(() => undefined);
  } finally {
    acceptingProposalIds.current.delete(proposal.id);
    setAcceptingProposalId(null);
  }

}

export async function runUndoNativeProposal(context: NativeProposalGateContext, receipt: AgentProposalUndoRecord): Promise<void> {
  const {
    acceptingProposalIds, setAcceptingProposalId, proposalCommandId, onNativeWorkspaceReload,
    refreshNativeProposalInbox, appendMessage, setLocalError,
  } = context;

  if (acceptingProposalIds.current.size) return;
  const actionId = `undo:${receipt.receiptId}`;
  acceptingProposalIds.current.add(actionId);
  setAcceptingProposalId(actionId);
  try {
    const target = nativeClient.captureTarget();
    if (target.cursor.documentId !== receipt.cursor.documentId || target.cursor.contextId !== receipt.cursor.contextId || target.cursor.branchId !== receipt.cursor.branchId) {
      throw new Error("请返回原提议的简历、来源和分支后再撤回");
    }
    await flushDraftBeforeVersionAction();
    nativeClient.assertTarget(target);
    const cursor = nativeClient.snapshot?.cursor;
    if (!cursor) throw new Error("权威文档尚未加载");
    const commandKey = `${actionId}:${JSON.stringify(cursor)}`;
    const result = await nativeInvoke("undo_confirmed_proposal", {
      request: {
        commandId: proposalCommandId(commandKey),
        cursor,
        receiptId: receipt.receiptId,
      },
    }) as AgentProposalReceipt;
    const { state, snapshot } = await reloadWorkspaceState();
    if (!sameCursor(result.cursor, state.cursor))
      throw new Error("撤回回执与当前文档状态不一致；请刷新后核对");
    onNativeWorkspaceReload(snapshot);
    await refreshNativeProposalInbox();
    appendMessage({ role: "assistant", text: "已安全撤回；后续手工编辑均已保留。" });
    setLocalError("");
  } catch (error) {
    setLocalError(error instanceof Error ? error.message : String(error));
    await refreshNativeProposalInbox().catch(() => undefined);
  } finally {
    acceptingProposalIds.current.delete(actionId);
    setAcceptingProposalId(null);
  }

}

export async function runAcceptProposal(context: {
  acceptingProposalIds: RefObject<Set<string>>;
  setAcceptingProposalId: Dispatch<SetStateAction<string | null>>;
  versionStore: ResumeVersionStore;
  expireProposal: (proposal: Pick<AgentProposal, "id" | "sourceView" | "sourceRefs">, text: string) => void;
  workingSnapshot: ResumeVersionSnapshot;
  onApplyEdit: (change: { target: AgentEditTarget; patch: AgentEditPatch; expectedValue: unknown; }) => boolean;
  setUndoEdit: Dispatch<SetStateAction<{ target: AgentEditTarget; originalValue: unknown; expectedValue: unknown; branchId: string; headId: string | null; } | null>>;
  undoConsumed: RefObject<boolean>;
  onDeleteEntry: (module: ModuleKey, id: string, expectedValue: Entry) => boolean;
  templates: ImportedTemplate[];
  onApplyTemplate: (template: ImportedTemplate) => Promise<boolean>;
  appendMessage: (message: Omit<AgentMessage, "id">) => void;
  onCommitVersion: (message: string) => Promise<boolean>;
  dismissProposal: (id: string) => void;
}, proposal: AgentProposal): Promise<void> {
  const {
    acceptingProposalIds, setAcceptingProposalId, versionStore, expireProposal, workingSnapshot, onApplyEdit,
    setUndoEdit, undoConsumed, onDeleteEntry, templates, onApplyTemplate, appendMessage, onCommitVersion,
    dismissProposal,
  } = context;

  if (acceptingProposalIds.current.size) return;
  acceptingProposalIds.current.add(proposal.id);
  setAcceptingProposalId(proposal.id);
  try {
    if (proposal.kind !== "save-version") {
      const currentHead = currentBranchOf(versionStore)?.headCommitId ?? null;
      if (
        versionStore.currentBranchId !== proposal.expectedBranchId ||
        currentHead !== proposal.expectedHeadId
      ) {
        expireProposal(proposal, "提议已过期：当前分支或 HEAD 已变化。请重新生成提议。");
        return;
      }
    }
    if (proposal.kind === "resume-edit") {
      if (signature(workingSnapshot) !== proposal.expectedSnapshotSignature) {
        expireProposal(proposal, "提议已过期：生成后工作区发生变化。请重新生成，以免覆盖新的编辑。");
        return;
      }
      const applied = onApplyEdit({
        target: proposal.target,
        patch: proposal.patch,
        expectedValue: proposal.expectedValue,
      });
      if (!applied) {
        expireProposal(proposal, "提议已过期：目标内容在生成后发生变化。请重新引用并生成提议。");
        return;
      }
      setUndoEdit({
        target: proposal.target,
        originalValue: proposal.expectedValue,
        expectedValue:
          proposal.target.kind === "entry"
            ? { ...(proposal.expectedValue as Entry), ...proposal.patch }
            : proposal.target.kind === "summary" && "html" in proposal.patch
              ? proposal.patch.html
              : "value" in proposal.patch
                ? proposal.patch.value
                : null,
        branchId: proposal.expectedBranchId,
        headId: proposal.expectedHeadId,
      });
      undoConsumed.current = false;
    } else if (proposal.kind === "resume-delete") {
      if (
        signature(workingSnapshot) !== proposal.expectedSnapshotSignature ||
        !onDeleteEntry(
          proposal.target.module,
          proposal.target.id,
          proposal.expectedValue,
        )
      ) {
        expireProposal(proposal, "删除提议已过期：目标经历或当前草稿发生变化。请重新引用后再试。");
        return;
      }
      setUndoEdit(null);
    } else if (proposal.kind === "apply-template") {
      const template = templates.find(
        (item) => item.id === proposal.templateId,
      );
      if (!template) {
        expireProposal(proposal, "模板已删除，不能应用这条提议。");
        return;
      }
      if (
        signature(template) !== proposal.expectedTemplateSignature ||
        signature(workingSnapshot) !== proposal.expectedSnapshotSignature
      ) {
        expireProposal(proposal, "模板提议已过期：模板或当前简历在生成后发生变化。请重新检查影响并生成提议。");
        return;
      }
      if (!(await onApplyTemplate(template))) {
        appendMessage({
          role: "assistant",
          text: "模板应用未完成；这条提议仍保留，可检查保存状态后重试。",
          sourceView: proposal.sourceView,
          sourceRefs: proposal.sourceRefs,
        });
        return;
      }
    } else {
      const branch = versionStore.branches.find(
        (item) => item.id === proposal.branchId,
      );
      if (
        !branch ||
        branch.headCommitId !== proposal.expectedHeadId ||
        versionStore.currentBranchId !== proposal.branchId ||
        signature(workingSnapshot) !== proposal.expectedSnapshotSignature
      ) {
        expireProposal(proposal, "版本提议已过期：当前分支或 HEAD 已变化。请重新生成提议。");
        return;
      }
      const saved = await onCommitVersion(proposal.message);
      if (!saved) {
        appendMessage({
          role: "assistant",
          text: "版本保存失败；草稿和这条待审阅提议已保留，请检查版本存储状态后重试。",
          sourceView: proposal.sourceView,
          sourceRefs: proposal.sourceRefs,
        });
        return;
      }
    }
    dismissProposal(proposal.id);
    appendMessage({
      role: "assistant",
      text: "已按确认执行，并通过现有宿主流程完成。",
      sourceView: proposal.sourceView,
      sourceRefs: proposal.sourceRefs,
    });
  } finally {
    acceptingProposalIds.current.delete(proposal.id);
    setAcceptingProposalId(null);
  }

}

export function runUndoLastEdit(context: {
  undoEdit: { target: AgentEditTarget; originalValue: unknown; expectedValue: unknown; branchId: string; headId: string | null; } | null;
  undoConsumed: RefObject<boolean>;
  versionStore: ResumeVersionStore;
  onUndoEdit: (change: { target: AgentEditTarget; originalValue: unknown; expectedValue: unknown; }) => boolean;
  appendMessage: (message: Omit<AgentMessage, "id">) => void;
  setUndoEdit: Dispatch<SetStateAction<{ target: AgentEditTarget; originalValue: unknown; expectedValue: unknown; branchId: string; headId: string | null; } | null>>;
}): void {
  const { undoEdit, undoConsumed, versionStore, onUndoEdit, appendMessage, setUndoEdit } = context;

  if (!undoEdit || undoConsumed.current) return;
  undoConsumed.current = true;
  const head = currentBranchOf(versionStore)?.headCommitId ?? null;
  const applied =
    versionStore.currentBranchId === undoEdit.branchId &&
    head === undoEdit.headId &&
    onUndoEdit(undoEdit);
  appendMessage({
    role: "assistant",
    text: applied
      ? "已撤回上次确认的修改。"
      : "无法撤回：分支或原字段已在接受后变化；没有覆盖后续编辑。",
    sourceView: "editor",
  });
  setUndoEdit(null);

}
