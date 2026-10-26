import type * as React from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AgentProposalInbox } from "../../../../src-tauri/src/domain/bindings/AgentProposalInbox";
import {
  nativeAgentStatus
} from "../../../platform/nativeAgentIdentity";
import {
  type BasicInfo,
  type Entry,
  type ModuleKey
} from "../../domain/resume-model";
import type { AgentSessionStore } from "../sessions";
import {
  flushAgentSessionWrites, flushScheduledAgentSessionWrite, loadAgentSessions, newAgentSession,
  readAgentSessions,
} from "../sessions";
import type { AgentSkill } from "../skills";
import type {
  AgentEditTarget,
  AgentProposal,
  AgentProviderStatus,
  AgentReference
} from "../types";
import { AgentMode, CompletionMenu, ProviderDraft } from './shared';
export async function runChangeAccount(context: {
  sendScopeGeneration: RefObject<number>;
  accountLoadGeneration: RefObject<number>;
  setLoadedSessionAccountId: Dispatch<SetStateAction<string | null>>;
  setAuthAccount: Dispatch<SetStateAction<{ id: string; email: string; } | null>>;
  setSessionStore: Dispatch<SetStateAction<AgentSessionStore>>;
  setSessionProposals: Dispatch<SetStateAction<Record<string, AgentProposal[]>>>;
  setNativeProposalInbox: Dispatch<SetStateAction<AgentProposalInbox>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setReferences: Dispatch<SetStateAction<string[]>>;
  setCompletionMenu: Dispatch<SetStateAction<CompletionMenu>>;
  setProviderDraft: Dispatch<SetStateAction<ProviderDraft>>;
}, account: { id: string; email: string } | null): Promise<void> {
  const {
    sendScopeGeneration, accountLoadGeneration, setLoadedSessionAccountId, setAuthAccount, setSessionStore,
    setSessionProposals, setNativeProposalInbox, setDraft, setReferences, setCompletionMenu, setProviderDraft,
  } = context;

  sendScopeGeneration.current += 1;
  const generation = ++accountLoadGeneration.current;
  setLoadedSessionAccountId(null);
  setAuthAccount(account);
  setSessionStore(readAgentSessions());
  setSessionProposals({});
  setNativeProposalInbox({ pending: [], undoable: [] });
  setDraft("");
  setReferences([]);
  setCompletionMenu(null);
  setProviderDraft({
    name: "",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    apiKey: "",
  });
  flushScheduledAgentSessionWrite();
  await flushAgentSessionWrites().catch(() => undefined);
  if (generation !== accountLoadGeneration.current) return;
  if (!account) return;
  const loaded = await loadAgentSessions(account.id);
  if (generation !== accountLoadGeneration.current) return;
  setSessionStore(loaded);
  setLoadedSessionAccountId(account.id);

}

export function runSyncSetProviderStatus9(context: {
  setProviderStatus: Dispatch<SetStateAction<AgentProviderStatus>>;
  changeAccount: (account: { id: string; email: string; } | null) => Promise<void>;
  setLocalError: Dispatch<SetStateAction<string>>;
  setProviderStatusText: Dispatch<SetStateAction<string>>;
  setProviderDraft: Dispatch<SetStateAction<ProviderDraft>>;
}): () => void {
  const { setProviderStatus, changeAccount, setLocalError, setProviderStatusText, setProviderDraft } = context;

  let active = true;
  nativeAgentStatus()
    .then((status) => {
      if (!active) return;
      setProviderStatus(status);
      void changeAccount(status.account ?? null).catch((error) => {
        if (active) setLocalError(error instanceof Error ? error.message : "对话载入失败");
      });
      setProviderStatusText(
        status.provider?.apiKeyNeedsReentry
          ? "当前 Windows 用户无法解密已保存的 API Key；请重新输入。原连接配置和密文仍保留。"
          : status.configured
            ? status.provider?.capability === "structured"
              ? "结构化工具已验证：宿主只读引用并生成待确认建议"
              : "连接已加密保存：可聊天；宿主工具需先通过结构化测试"
            : status.authRequired && !status.account
              ? "请先登录本机账户，再配置模型"
              : "尚未配置模型连接",
      );
      if (status.provider)
        setProviderDraft((current) => ({
          ...current,
          name: status.provider?.name ?? "",
          baseUrl: status.provider?.baseUrl ?? current.baseUrl,
          model: status.provider?.model ?? "",
        }));
    })
    .catch(() => {
      if (active) setProviderStatusText("本机 Agent 网关尚未启动");
    });
  return () => {
    active = false;
  };

}

export function runSyncSettingsOpen11(context: {
  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
}): (() => void) | undefined {
  const { settingsOpen, setSettingsOpen } = context;

  if (!settingsOpen) return;
  const returnFocus = document.activeElement;
  const dialog = document.querySelector<HTMLElement>(
    ".agent-settings-dialog",
  );
  const focusable = () => [
    ...(dialog?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled)",
    ) ?? []),
  ];
  focusable()[0]?.focus();
  const onKeyDown = (event: globalThis.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setSettingsOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKeyDown);
  return () => {
    document.removeEventListener("keydown", onKeyDown);
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected)
      returnFocus.focus();
  };

}

export function runSwitchSession(context: {
  sendPreparationRef: RefObject<object | null>;
  runState: "idle" | "running" | "failed" | "stopped";
  acceptingProposalId: string | null;
  sessionStore: AgentSessionStore;
  sendScopeGeneration: RefObject<number>;
  setSessionStore: Dispatch<SetStateAction<AgentSessionStore>>;
  setSessionPickerOpen: Dispatch<SetStateAction<boolean>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setReferences: Dispatch<SetStateAction<string[]>>;
  setSkillId: Dispatch<SetStateAction<string | null>>;
  setCompletionMenu: Dispatch<SetStateAction<CompletionMenu>>;
  setUndoEdit: Dispatch<SetStateAction<{ target: AgentEditTarget; originalValue: unknown; expectedValue: unknown; branchId: string; headId: string | null; } | null>>;
  setRunStatus: Dispatch<SetStateAction<string>>;
  setRunState: Dispatch<SetStateAction<"idle" | "running" | "failed" | "stopped">>;
  setMode: (next: AgentMode) => void;
}, id: string): void {
  const {
    sendPreparationRef, runState, acceptingProposalId, sessionStore, sendScopeGeneration, setSessionStore,
    setSessionPickerOpen, setDraft, setReferences, setSkillId, setCompletionMenu, setUndoEdit, setRunStatus,
    setRunState, setMode,
  } = context;

  if (sendPreparationRef.current || runState === "running" || acceptingProposalId) return;
  if (!sessionStore.sessions.some((item) => item.id === id)) return;
  sendScopeGeneration.current += 1;
  setSessionStore((current) => ({ ...current, activeId: id }));
  setSessionPickerOpen(false);
  setDraft("");
  setReferences([]);
  setSkillId(null);
  setCompletionMenu(null);
  setUndoEdit(null);
  setRunStatus("");
  setRunState("idle");
  setMode("chat");

}

export function runCreateSession(context: {
  sendPreparationRef: RefObject<object | null>;
  runState: "idle" | "running" | "failed" | "stopped";
  acceptingProposalId: string | null;
  sendScopeGeneration: RefObject<number>;
  setSessionStore: Dispatch<SetStateAction<AgentSessionStore>>;
  setSessionPickerOpen: Dispatch<SetStateAction<boolean>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setReferences: Dispatch<SetStateAction<string[]>>;
  setSkillId: Dispatch<SetStateAction<string | null>>;
  setCompletionMenu: Dispatch<SetStateAction<CompletionMenu>>;
  setUndoEdit: Dispatch<SetStateAction<{ target: AgentEditTarget; originalValue: unknown; expectedValue: unknown; branchId: string; headId: string | null; } | null>>;
  setRunStatus: Dispatch<SetStateAction<string>>;
  setRunState: Dispatch<SetStateAction<"idle" | "running" | "failed" | "stopped">>;
  setMode: (next: AgentMode) => void;
}): void {
  const {
    sendPreparationRef, runState, acceptingProposalId, sendScopeGeneration, setSessionStore,
    setSessionPickerOpen, setDraft, setReferences, setSkillId, setCompletionMenu, setUndoEdit, setRunStatus,
    setRunState, setMode,
  } = context;

  if (sendPreparationRef.current || runState === "running" || acceptingProposalId) return;
  sendScopeGeneration.current += 1;
  const session = newAgentSession();
  setSessionStore((current) => ({
    activeId: session.id,
    sessions: [session, ...current.sessions],
  }));
  setSessionPickerOpen(false);
  setDraft("");
  setReferences([]);
  setSkillId(null);
  setCompletionMenu(null);
  setUndoEdit(null);
  setRunStatus("");
  setRunState("idle");
  setMode("chat");

}

export function runChooseReference(context: {
  references: string[];
  setCompletionMenu: Dispatch<SetStateAction<CompletionMenu>>;
  completionMenu: CompletionMenu;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  setReferences: Dispatch<SetStateAction<string[]>>;
  setMenuIndex: Dispatch<SetStateAction<number>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}, reference: AgentReference): void {
  const {
    references, setCompletionMenu, completionMenu, draft, setDraft, setReferences, setMenuIndex, textareaRef,
  } = context;

  if (references.includes(reference.id)) {
    setCompletionMenu(null);
    return;
  }
  const token = completionMenu;
  if (token?.kind === "reference") {
    const next = `${draft.slice(0, token.start)}${reference.label} ${draft.slice(token.end)}`;
    setDraft(next);
  }
  setReferences((current) =>
    current.length >= 8 ? current : [...current, reference.id],
  );
  setCompletionMenu(null);
  setMenuIndex(0);
  requestAnimationFrame(() => textareaRef.current?.focus());

}

export function runInsertComposerToken(context: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  updateDraft: (value: string, caret: number) => void;
}, token: "@" | "/"): void {
  const { textareaRef, draft, updateDraft } = context;

  const field = textareaRef.current;
  const caret = field?.selectionStart ?? draft.length;
  const needsSpace = caret > 0 && !/\s/.test(draft[caret - 1]);
  const prefix = needsSpace ? ` ${token}` : token;
  const next = `${draft.slice(0, caret)}${prefix}${draft.slice(caret)}`;
  const nextCaret = caret + prefix.length;
  updateDraft(next, nextCaret);
  requestAnimationFrame(() => {
    field?.focus();
    field?.setSelectionRange(nextCaret, nextCaret);
  });

}

export function runOnComposerKeyDown(context: {
  composingUntil: RefObject<number>;
  draft: string;
  sendMessage: () => Promise<void>;
  completionMenu: CompletionMenu;
  menuCount: number;
  setMenuIndex: Dispatch<SetStateAction<number>>;
  filteredReferences: ({ view: "editor"; id: string; kind: "summary" | "template" | "basic-field" | "entry" | "module" | "version" | "draft" | "branch" | "feature"; label: string; detail: string; module?: ModuleKey | undefined; entry?: Entry | undefined; basicKey?: keyof BasicInfo | undefined; templateId?: string | undefined; versionId?: string | undefined; featureDescription?: string | undefined; } | { view: "templates"; id: string; kind: "summary" | "template" | "basic-field" | "entry" | "module" | "version" | "draft" | "branch" | "feature"; label: string; detail: string; module?: ModuleKey | undefined; entry?: Entry | undefined; basicKey?: keyof BasicInfo | undefined; templateId?: string | undefined; versionId?: string | undefined; featureDescription?: string | undefined; } | { view: "versions"; id: string; kind: "summary" | "template" | "basic-field" | "entry" | "module" | "version" | "draft" | "branch" | "feature"; label: string; detail: string; module?: ModuleKey | undefined; entry?: Entry | undefined; basicKey?: keyof BasicInfo | undefined; templateId?: string | undefined; versionId?: string | undefined; featureDescription?: string | undefined; })[];
  menuIndex: number;
  chooseReference: (reference: AgentReference) => void;
  filteredSkills: AgentSkill[];
  chooseSkill: (skill: AgentSkill) => void;
  setCompletionMenu: Dispatch<SetStateAction<CompletionMenu>>;
}, event: React.KeyboardEvent<HTMLTextAreaElement>): void {
  const {
    composingUntil, draft, sendMessage, completionMenu, menuCount, setMenuIndex, filteredReferences, menuIndex,
    chooseReference, filteredSkills, chooseSkill, setCompletionMenu,
  } = context;

  if (
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229 ||
    performance.now() < composingUntil.current
  )
    return;
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    /^\/(settings|sessions|new|help)$/i.test(draft.trim())
  ) {
    event.preventDefault();
    void sendMessage();
    return;
  }
  if (completionMenu && menuCount && event.key === "ArrowDown") {
    event.preventDefault();
    setMenuIndex((current) => (current + 1) % menuCount);
    return;
  }
  if (completionMenu && menuCount && event.key === "ArrowUp") {
    event.preventDefault();
    setMenuIndex((current) => (current - 1 + menuCount) % menuCount);
    return;
  }
  if (
    completionMenu &&
    menuCount &&
    (event.key === "Enter" || event.key === "Tab")
  ) {
    event.preventDefault();
    if (completionMenu.kind === "reference") {
      const reference = filteredReferences[menuIndex];
      if (reference) chooseReference(reference);
    } else {
      const skill = filteredSkills[menuIndex];
      if (skill) chooseSkill(skill);
    }
    return;
  }
  if (completionMenu && event.key === "Escape") {
    event.preventDefault();
    setCompletionMenu(null);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }

}
