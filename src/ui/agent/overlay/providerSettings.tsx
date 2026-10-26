import type * as React from "react";
import type { Dispatch, FormEvent, RefObject, SetStateAction } from "react";
import { hasDocumentRuntime as isTauriRuntime, nativeInvoke } from "../../../platform/ipc";
import {
  nativeAgentStatus,
  nativeAuthenticate,
  nativeClearProvider,
  nativeLogout,
  nativeSaveProvider,
} from "../../../platform/nativeAgentIdentity";
import {
  nodeId
} from "../agentOverlayUtils";
import {
  runAgentTurns
} from "../runtime";
import {
  flushAgentSessionWrites,
  flushScheduledAgentSessionWrite
} from "../sessions";
import type {
  AgentProviderStatus
} from "../types";
import { DiscoveredModel, errorMessage, ProviderDraft } from './shared';
export function runOpenSettings(context: {
  setProviderStatusText: Dispatch<SetStateAction<string>>;
  providerStatus: AgentProviderStatus;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
}): void {
  const { setProviderStatusText, providerStatus, setSettingsOpen } = context;

  setProviderStatusText(
    providerStatus.configured
      ? isTauriRuntime()
        ? providerStatus.provider?.capability === "structured"
          ? "结构化工具已验证：宿主只读引用并生成待确认建议"
          : "连接已保存：可聊天；宿主工具需先通过结构化测试"
        : providerStatus.provider?.capability === "structured"
          ? "连接已验证：可生成待审阅提议"
          : "连接已保存：仅聊天，修改提议需完成结构化能力测试"
      : "尚未配置模型连接",
  );
  setSettingsOpen(true);

}

export async function runAuthenticate(context: {
  accountTransitionRef: RefObject<boolean>;
  sendScopeGeneration: RefObject<number>;
  setAuthBusy: Dispatch<SetStateAction<boolean>>;
  setAuthError: Dispatch<SetStateAction<string>>;
  cancelRun: () => void;
  authDraft: { email: string; password: string; };
  changeAccount: (account: { id: string; email: string; } | null) => Promise<void>;
  setProviderStatus: Dispatch<SetStateAction<AgentProviderStatus>>;
  setProviderStatusText: Dispatch<SetStateAction<string>>;
  setProviderDraft: Dispatch<SetStateAction<ProviderDraft>>;
  setAuthDraft: Dispatch<SetStateAction<{ email: string; password: string; }>>;
}, mode: "login" | "register"): Promise<void> {
  const {
    accountTransitionRef, sendScopeGeneration, setAuthBusy, setAuthError, cancelRun, authDraft, changeAccount,
    setProviderStatus, setProviderStatusText, setProviderDraft, setAuthDraft,
  } = context;

  if (accountTransitionRef.current) return;
  accountTransitionRef.current = true;
  sendScopeGeneration.current += 1;
  setAuthBusy(true);
  setAuthError("");
  try {
    cancelRun();
    flushScheduledAgentSessionWrite();
    await flushAgentSessionWrites();
    const status = await nativeAuthenticate(mode, authDraft);
    await changeAccount(status.account ?? null);
    setProviderStatus(status);
    setProviderStatusText(
      status.provider?.apiKeyNeedsReentry
        ? "当前 Windows 用户无法解密已保存的 API Key；请重新输入。原连接配置和密文仍保留。"
        : status.configured
          ? status.provider?.capability === "structured"
            ? "已恢复此账户的加密连接：结构化工具已验证"
            : "已恢复此账户的加密连接：可聊天；宿主工具需先通过结构化测试"
          : "登录成功，请配置此账户的模型连接",
    );
    if (status.provider)
      setProviderDraft((current) => ({
        ...current,
        name: status.provider?.name ?? "",
        baseUrl: status.provider?.baseUrl ?? current.baseUrl,
        model: status.provider?.model ?? "",
        apiKey: "",
      }));
    setAuthDraft((current) => ({ ...current, password: "" }));
  } catch (error) {
    setAuthError(error instanceof Error ? error.message : "登录失败");
  } finally {
    accountTransitionRef.current = false;
    setAuthBusy(false);
  }

}

export async function runLogoutAccount(context: {
  accountTransitionRef: RefObject<boolean>;
  sendScopeGeneration: RefObject<number>;
  cancelRun: () => void;
  setAuthError: Dispatch<SetStateAction<string>>;
  changeAccount: (account: { id: string; email: string; } | null) => Promise<void>;
  setAuthDraft: Dispatch<SetStateAction<{ email: string; password: string; }>>;
  setProviderStatus: Dispatch<SetStateAction<AgentProviderStatus>>;
  setProviderStatusText: Dispatch<SetStateAction<string>>;
}): Promise<void> {
  const {
    accountTransitionRef, sendScopeGeneration, cancelRun, setAuthError, changeAccount, setAuthDraft,
    setProviderStatus, setProviderStatusText,
  } = context;

  if (accountTransitionRef.current) return;
  accountTransitionRef.current = true;
  sendScopeGeneration.current += 1;
  try {
    cancelRun();
    try {
      flushScheduledAgentSessionWrite();
      await flushAgentSessionWrites();
      await nativeLogout();
    } catch {
      setAuthError("退出登录失败，请重试");
      return;
    }
    await changeAccount(null);
    // 登出后登录表单会重新出现；不清空会把上一个账户的密码回填给下一个输入者。
    setAuthDraft((draft) => ({ ...draft, password: "" }));
    setProviderStatus({
      configured: false,
      provider: null,
      keyStorage: "local-account",
      authRequired: true,
      account: null,
    });
    setProviderStatusText("已退出登录");
  } finally {
    accountTransitionRef.current = false;
  }

}

export async function runDiscoverProviderModels(context: {
  discoverySequence: RefObject<number>;
  setProviderBusy: Dispatch<SetStateAction<boolean>>;
  setDiscoveryStatus: Dispatch<SetStateAction<string>>;
  setModelSuggestionsOpen: Dispatch<SetStateAction<boolean>>;
  providerDraft: ProviderDraft;
  setDiscoveredModels: Dispatch<SetStateAction<DiscoveredModel[]>>;
  setProviderDraft: Dispatch<SetStateAction<ProviderDraft>>;
}): Promise<void> {
  const {
    discoverySequence, setProviderBusy, setDiscoveryStatus, setModelSuggestionsOpen, providerDraft,
    setDiscoveredModels, setProviderDraft,
  } = context;

  const sequence = ++discoverySequence.current;
  setProviderBusy(true);
  setDiscoveryStatus("正在检测服务并读取模型列表…");
  setModelSuggestionsOpen(false);
  try {
    const result = await nativeInvoke("provider_models", {
      baseUrl: providerDraft.baseUrl.trim(),
      key: providerDraft.apiKey.trim(),
    }) as { baseUrl: string; models?: DiscoveredModel[]; error?: string };
    if (sequence !== discoverySequence.current) return;
    const models = Array.isArray(result.models)
      ? (result.models as DiscoveredModel[])
      : [];
    setDiscoveredModels(models);
    setProviderDraft((current) => ({ ...current, baseUrl: result.baseUrl }));
    setDiscoveryStatus(
      `服务返回 ${models.length} 个模型。输入模型 ID 前缀可选择；API Key 与所选模型是否可调用仍需“测试连接”。`,
    );
  } catch (error) {
    if (sequence !== discoverySequence.current) return;
    setDiscoveredModels([]);
    setDiscoveryStatus(
      errorMessage(error, "模型列表检测失败"),
    );
  } finally {
    setProviderBusy(false);
  }

}

export function runOnModelIdKeyDown(context: {
  modelSuggestionsOpen: boolean;
  modelSuggestions: DiscoveredModel[];
  setModelSuggestionIndex: Dispatch<SetStateAction<number>>;
  chooseDiscoveredModel: (model: DiscoveredModel) => void;
  modelSuggestionIndex: number;
  setModelSuggestionsOpen: Dispatch<SetStateAction<boolean>>;
}, event: React.KeyboardEvent<HTMLInputElement>): void {
  const {
    modelSuggestionsOpen, modelSuggestions, setModelSuggestionIndex, chooseDiscoveredModel,
    modelSuggestionIndex, setModelSuggestionsOpen,
  } = context;

  if (!modelSuggestionsOpen || !modelSuggestions.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    setModelSuggestionIndex(
      (current) =>
        (current +
          (event.key === "ArrowDown" ? 1 : -1) +
          modelSuggestions.length) %
        modelSuggestions.length,
    );
  } else if (event.key === "Enter") {
    event.preventDefault();
    chooseDiscoveredModel(
      modelSuggestions[modelSuggestionIndex] ?? modelSuggestions[0],
    );
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    setModelSuggestionsOpen(false);
  }

}

export async function runSaveProvider(context: {
  setProviderBusy: Dispatch<SetStateAction<boolean>>;
  setProviderStatusText: Dispatch<SetStateAction<string>>;
  providerDraft: ProviderDraft;
  setProviderStatus: Dispatch<SetStateAction<AgentProviderStatus>>;
  setProviderDraft: Dispatch<SetStateAction<ProviderDraft>>;
}, event?: FormEvent): Promise<void> {
  const { setProviderBusy, setProviderStatusText, providerDraft, setProviderStatus, setProviderDraft } = context;

  event?.preventDefault();
  setProviderBusy(true);
  setProviderStatusText("正在保存此账户的模型连接…");
  try {
    const status = await nativeSaveProvider(providerDraft);
    setProviderStatus(status);
    setProviderDraft((current) => ({ ...current, apiKey: "" }));
    setProviderStatusText("连接已加密保存到此账户：可聊天；宿主工具需先通过结构化测试");
  } catch (error) {
    setProviderStatusText(
      errorMessage(error, "保存连接失败"),
    );
  } finally {
    setProviderBusy(false);
  }

}

export async function runTestProvider(context: {
  setProviderBusy: Dispatch<SetStateAction<boolean>>;
  setProviderStatusText: Dispatch<SetStateAction<string>>;
  providerDraft: ProviderDraft;
  setProviderStatus: Dispatch<SetStateAction<AgentProviderStatus>>;
}): Promise<void> {
  const { setProviderBusy, setProviderStatusText, providerDraft, setProviderStatus } = context;

  setProviderBusy(true);
  setProviderStatusText("正在向所选服务发送不含简历的连接测试…");
  try {
    const result = await nativeInvoke("provider_test", {
      baseUrl: providerDraft.baseUrl.trim(),
      model: providerDraft.model.trim(),
      key: providerDraft.apiKey.trim(),
    }) as { success: boolean; structuredOutput: boolean; model: string; error?: string };
    setProviderStatusText(
      !result.success
        ? "模型未返回可用的基础响应。"
        : result.structuredOutput
          ? `结构化工具通过（${result.model}）；宿主可读取已选引用并生成待确认建议。`
          : `基础响应通过（${result.model}）；桌面结构化工具能力尚未验证。`,
    );
    setProviderStatus(await nativeAgentStatus());
  } catch (error) {
    setProviderStatusText(
      errorMessage(error, "连接测试失败"),
    );
  } finally {
    setProviderBusy(false);
  }

}

export async function runCheckHarness(context: {
  setHarnessStatusText: Dispatch<SetStateAction<string>>;
  providerStatus: AgentProviderStatus;
}): Promise<void> {
  const { setHarnessStatusText, providerStatus } = context;

  const events: number[] = [];
  try {
    const fixture = await runAgentTurns<string>({
      runId: nodeId("self-check"),
      messages: [{ role: "user", content: "fixture only" }],
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event.seq),
      invoke: async () => ({
        content: "fixture",
        toolCalls: [
          {
            id: "fixture-call",
            name: "context_list_resources",
            arguments: "{}",
          },
        ],
      }),
      execute: () => ({
        ok: true,
        data: [],
        truncated: false,
        proposal: "fixture",
      }),
    });
    if (
      fixture.proposals[0] !== "fixture" ||
      events.some((seq, index) => seq !== index + 1)
    )
      throw new Error("运行时事件或工具校验异常");
    setHarnessStatusText(
      `项目 Harness 自检通过：本地有界运行、工具派发与事件顺序可用；连接器：${providerStatus.configured ? (providerStatus.provider?.capability === "structured" ? "结构化工具已验证" : "仅聊天") : "未配置"}。此检查不调用模型。`,
    );
  } catch (error) {
    setHarnessStatusText(
      error instanceof Error ? error.message : "项目 Harness 自检失败",
    );
  }

}

export async function runClearProvider(context: {
  setProviderBusy: Dispatch<SetStateAction<boolean>>;
  setProviderStatus: Dispatch<SetStateAction<AgentProviderStatus>>;
  authAccount: { id: string; email: string; } | null;
  setProviderStatusText: Dispatch<SetStateAction<string>>;
  setProviderDraft: Dispatch<SetStateAction<ProviderDraft>>;
  invalidateModelDiscovery: () => void;
}): Promise<void> {
  const {
    setProviderBusy, setProviderStatus, authAccount, setProviderStatusText, setProviderDraft,
    invalidateModelDiscovery,
  } = context;

  setProviderBusy(true);
  try {
    await nativeClearProvider();
    setProviderStatus({
      configured: false,
      provider: null,
      keyStorage: "local-account",
      authRequired: true,
      account: authAccount,
    });
    setProviderStatusText("此账户的模型连接已清除");
    setProviderDraft((current) => ({ ...current, apiKey: "" }));
    invalidateModelDiscovery();
  } catch {
    setProviderStatusText("清除连接失败");
  } finally {
    setProviderBusy(false);
  }

}
