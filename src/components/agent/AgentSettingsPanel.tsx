import { motion } from "motion/react";
import type { FormEvent, KeyboardEvent } from "react";
import { Check, CircleHelp, LoaderCircle, Settings2, X } from "lucide-react";
import type { AgentProviderStatus } from "../../agent/types";
import {
  isLocalModelUrl,
  type DiscoveredModel,
  type ProviderDraft,
} from "./agent-overlay-utils";
import styles from "./AgentSettingsPanel.module.css";

type AgentSettingsPanelProps = {
  reduceMotion: boolean;
  providerStatus: AgentProviderStatus;
  providerStatusText: string;
  providerDraft: ProviderDraft;
  providerBusy: boolean;
  discoveredModels: DiscoveredModel[];
  discoveryStatus: string;
  modelSuggestionsOpen: boolean;
  modelSuggestions: DiscoveredModel[];
  modelSuggestionIndex: number;
  harnessStatusText: string;
  authAccount: { id: string; email: string } | null;
  authDraft: { email: string; password: string };
  authBusy: boolean;
  authError: string;
  canDiscoverModels: boolean;
  setSettingsOpen: (open: boolean) => void;
  setProviderDraft: (update: (current: ProviderDraft) => ProviderDraft) => void;
  setAuthDraft: (
    update: (current: { email: string; password: string }) => {
      email: string;
      password: string;
    },
  ) => void;
  setModelSuggestionsOpen: (open: boolean) => void;
  setModelSuggestionIndex: (update: (current: number) => number) => void;
  onAuthenticate: (mode: "login" | "register") => void;
  onLogout: () => void;
  onDiscoverModels: () => void;
  onChooseDiscoveredModel: (model: DiscoveredModel) => void;
  onModelIdKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSaveProvider: (event?: FormEvent) => void;
  onTestProvider: () => void;
  onCheckHarness: () => void;
  onClearProvider: () => void;
  onInvalidateModelDiscovery: () => void;
};

export function AgentSettingsPanel({
  reduceMotion,
  providerStatus,
  providerStatusText,
  providerDraft,
  providerBusy,
  discoveredModels,
  discoveryStatus,
  modelSuggestionsOpen,
  modelSuggestions,
  modelSuggestionIndex,
  harnessStatusText,
  authAccount,
  authDraft,
  authBusy,
  authError,
  canDiscoverModels,
  setSettingsOpen,
  setProviderDraft,
  setAuthDraft,
  setModelSuggestionsOpen,
  setModelSuggestionIndex,
  onAuthenticate,
  onLogout,
  onDiscoverModels,
  onChooseDiscoveredModel,
  onModelIdKeyDown,
  onSaveProvider,
  onTestProvider,
  onCheckHarness,
  onClearProvider,
  onInvalidateModelDiscovery,
}: AgentSettingsPanelProps) {
  return (
    <motion.div
      className={styles.backdrop}
      role="presentation"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) setSettingsOpen(false);
      }}
    >
      <motion.section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-settings-title"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduceMotion ? 0.1 : 0.18 }}
      >
        <header>
          <div>
            <small>LOCAL HARNESS</small>
            <h2 id="agent-settings-title">模型连接</h2>
          </div>
          <button
            type="button"
            aria-label="关闭模型设置"
            onClick={() => {
              setSettingsOpen(false);
              setProviderDraft((current) => ({ ...current, apiKey: "" }));
            }}
          >
            <X size={17} />
          </button>
        </header>
        {providerStatus.authRequired && !authAccount ? (
          <form
            className={styles.authForm}
            onSubmit={(event) => {
              event.preventDefault();
              onAuthenticate("login");
            }}
          >
            <p>
              使用本机邮箱账户登录。模型连接和 API Key
              只属于此账户，刷新与服务重启后会恢复。
            </p>
            <label>
              邮箱
              <input
                type="email"
                autoComplete="email"
                required
                value={authDraft.email}
                onChange={(event) =>
                  setAuthDraft((current) => ({
                    ...current,
                    email: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              密码
              <input
                type="password"
                autoComplete="current-password"
                minLength={10}
                required
                value={authDraft.password}
                onChange={(event) =>
                  setAuthDraft((current) => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
              />
            </label>
            {authError ? <p role="alert">{authError}</p> : null}
            <div className={styles.actions}>
              <button
                type="submit"
                className={styles.primary}
                disabled={authBusy}
              >
                登录
              </button>
              <button
                type="button"
                disabled={authBusy}
                onClick={() => onAuthenticate("register")}
              >
                注册并登录
              </button>
            </div>
            <small>密码至少 10 个字符；这是本机账户，不发送验证邮件。</small>
          </form>
        ) : (
          <>
            {authAccount ? (
              <div className={styles.accountBar}>
                <span>已登录：{authAccount.email}</span>
                <button type="button" onClick={onLogout}>
                  退出登录
                </button>
              </div>
            ) : null}
            <p className={styles.intro}>
              使用本机 Harness 调用 OpenAI-compatible Chat Completions。API Key
              保存在此账户的本机 .data 目录，不写入浏览器或 Git 仓库。 Base URL
              填 API 根地址；粘贴完整的 chat/completions 地址也会自动整理。
            </p>
            <form onSubmit={onSaveProvider}>
              <label>
                连接名称
                <input
                  value={providerDraft.name}
                  onChange={(event) =>
                    setProviderDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  maxLength={80}
                  placeholder="例如：我的模型连接"
                />
              </label>
              <label>
                Base URL
                <input
                  value={providerDraft.baseUrl}
                  onChange={(event) => {
                    onInvalidateModelDiscovery();
                    setProviderDraft((current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }));
                  }}
                  maxLength={512}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  autoComplete="off"
                  value={providerDraft.apiKey}
                  onChange={(event) => {
                    onInvalidateModelDiscovery();
                    setProviderDraft((current) => ({
                      ...current,
                      apiKey: event.target.value,
                    }));
                  }}
                  maxLength={4096}
                  placeholder={
                    providerStatus.provider?.hasApiKey
                      ? "已在当前账户配置；留空不会更新"
                      : "远程 HTTPS 服务需要 API Key"
                  }
                />
              </label>
              <button
                className={styles.discoverButton}
                type="button"
                disabled={providerBusy || !canDiscoverModels}
                onClick={onDiscoverModels}
              >
                {providerBusy ? (
                  <LoaderCircle className="agent-spinner" size={15} />
                ) : (
                  <Settings2 size={15} />
                )}
                检测连接并获取模型
              </button>
              {discoveryStatus ? (
                <p className={styles.discoveryStatus} role="status">
                  {discoveryStatus}
                </p>
              ) : null}
              <div className={styles.modelField}>
                <label htmlFor="agent-model-id">模型 ID</label>
                <input
                  id="agent-model-id"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={
                    modelSuggestionsOpen && modelSuggestions.length > 0
                  }
                  aria-controls="agent-model-suggestions"
                  value={providerDraft.model}
                  onChange={(event) => {
                    setProviderDraft((current) => ({
                      ...current,
                      model: event.target.value,
                    }));
                    setModelSuggestionIndex(() => 0);
                    setModelSuggestionsOpen(true);
                  }}
                  onFocus={() => setModelSuggestionsOpen(true)}
                  onBlur={() => setModelSuggestionsOpen(false)}
                  onKeyDown={onModelIdKeyDown}
                  maxLength={128}
                  placeholder={
                    discoveredModels.length
                      ? "输入模型 ID 前缀选择"
                      : "检测后选择，或手动输入模型 ID"
                  }
                  autoComplete="off"
                />
                {modelSuggestionsOpen && modelSuggestions.length > 0 ? (
                  <div
                    className={styles.modelSuggestions}
                    id="agent-model-suggestions"
                    role="listbox"
                    aria-label="可用模型"
                  >
                    {modelSuggestions.map((model, index) => (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={index === modelSuggestionIndex}
                        className={
                          index === modelSuggestionIndex ? styles.active : ""
                        }
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => onChooseDiscoveredModel(model)}
                      >
                        <strong>{model.id}</strong>
                        {model.name !== model.id ? (
                          <span>{model.name}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <p className={styles.status} role="status">
                {providerStatusText}
              </p>
              <button type="button" onClick={onCheckHarness}>
                项目能力自检
              </button>
              {harnessStatusText ? (
                <p role="status">{harnessStatusText}</p>
              ) : null}
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={
                    providerBusy ||
                    !providerDraft.model ||
                    (!providerDraft.apiKey &&
                      !providerStatus.provider?.hasApiKey &&
                      !isLocalModelUrl(providerDraft.baseUrl))
                  }
                  onClick={onTestProvider}
                >
                  <CircleHelp size={14} /> 测试连接
                </button>
                <button
                  type="submit"
                  className={styles.primary}
                  disabled={
                    providerBusy ||
                    !providerDraft.name ||
                    !providerDraft.model ||
                    (!providerDraft.apiKey &&
                      !providerStatus.provider?.hasApiKey &&
                      !isLocalModelUrl(providerDraft.baseUrl))
                  }
                >
                  {providerBusy ? (
                    <LoaderCircle className="agent-spinner" size={14} />
                  ) : (
                    <Check size={14} />
                  )}{" "}
                  保存连接
                </button>
              </div>
              {providerStatus.configured ? (
                <button
                  className={styles.clearConnection}
                  type="button"
                  disabled={providerBusy}
                  onClick={onClearProvider}
                >
                  清除此账户的模型连接
                </button>
              ) : null}
            </form>
            <footer>
              仅测试用户选定的服务。测试请求不含简历内容，供应商可能收费。连接验证不会自动启用未通过
              schema 校验的工具调用。
            </footer>
          </>
        )}
      </motion.section>
    </motion.div>
  );
}
