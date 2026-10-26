import {
  Check,
  CircleHelp,
  LoaderCircle,
  Settings2,
  X
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type * as React from "react";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import { isTauriRuntime as isNativeHost, hasDocumentRuntime as isTauriRuntime } from "../../../platform/ipc";
import type {
  AgentProviderStatus
} from "../types";
import { DiscoveredModel, ProviderDraft } from './shared';
export function renderAgentSettings(context: {
  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  reduceMotion: boolean | null;
  setProviderDraft: Dispatch<SetStateAction<ProviderDraft>>;
  providerStatus: AgentProviderStatus;
  authAccount: { id: string; email: string; } | null;
  authenticate: (mode: "login" | "register") => Promise<void>;
  authDraft: { email: string; password: string; };
  setAuthDraft: Dispatch<SetStateAction<{ email: string; password: string; }>>;
  authError: string;
  authBusy: boolean;
  logoutAccount: () => Promise<void>;
  saveProvider: (event?: FormEvent<Element> | undefined) => Promise<void>;
  providerDraft: ProviderDraft;
  invalidateModelDiscovery: () => void;
  providerBusy: boolean;
  canDiscoverModels: boolean;
  discoverProviderModels: () => Promise<void>;
  discoveryStatus: string;
  modelSuggestionsOpen: boolean;
  modelSuggestions: DiscoveredModel[];
  setModelSuggestionIndex: Dispatch<SetStateAction<number>>;
  setModelSuggestionsOpen: Dispatch<SetStateAction<boolean>>;
  onModelIdKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  discoveredModels: DiscoveredModel[];
  modelSuggestionIndex: number;
  chooseDiscoveredModel: (model: DiscoveredModel) => void;
  providerStatusText: string;
  checkHarness: () => Promise<void>;
  harnessStatusText: string;
  canSaveProviderDraft: boolean;
  testProvider: () => Promise<void>;
  clearProvider: () => Promise<void>;
}): React.ReactNode {
  const {
    settingsOpen, setSettingsOpen, reduceMotion, setProviderDraft, providerStatus, authAccount, authenticate,
    authDraft, setAuthDraft, authError, authBusy, logoutAccount, saveProvider, providerDraft,
    invalidateModelDiscovery, providerBusy, canDiscoverModels, discoverProviderModels, discoveryStatus,
    modelSuggestionsOpen, modelSuggestions, setModelSuggestionIndex, setModelSuggestionsOpen, onModelIdKeyDown,
    discoveredModels, modelSuggestionIndex, chooseDiscoveredModel, providerStatusText, checkHarness,
    harnessStatusText, canSaveProviderDraft, testProvider, clearProvider,
  } = context;
  return (<AnimatePresence>
    {settingsOpen ? (
      <motion.div
        className="agent-settings-backdrop"
        role="presentation"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setSettingsOpen(false);
        }}
      >
        <motion.section
          className="agent-settings-dialog"
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
              className="agent-auth-form"
              onSubmit={(event) => {
                event.preventDefault();
                void authenticate("login");
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
              <div className="agent-settings-actions">
                <button
                  type="submit"
                  className="primary"
                  disabled={authBusy}
                >
                  登录
                </button>
                <button
                  type="button"
                  disabled={authBusy}
                  onClick={() => void authenticate("register")}
                >
                  注册并登录
                </button>
              </div>
              <small>
                密码至少 10 个字符；这是本机账户，不发送验证邮件。
              </small>
            </form>
          ) : (
            <>
              {authAccount ? (
                <div className="agent-account-bar">
                  <span>已登录：{authAccount.email}</span>
                  <button
                    type="button"
                    onClick={() => void logoutAccount()}
                  >
                    退出登录
                  </button>
                </div>
              ) : null}
              <p className="agent-settings-intro">
                {isNativeHost()
                  ? "连接配置和 API Key 由 Rust 保存到本机数据库，Key 使用当前 Windows 用户的 DPAPI 加密。模型列表、基础连接测试和聊天可用；结构化提议需确认后才写入。"
                  : "通过浏览器连接 OpenAI-compatible Chat Completions，服务须允许 CORS。API Key 使用浏览器不可导出密钥加密，连接配置保存在此网站的本地数据库中。Base URL 填 API 根地址。"}
              </p>
              <form onSubmit={(event) => void saveProvider(event)}>
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
                      invalidateModelDiscovery();
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
                      invalidateModelDiscovery();
                      setProviderDraft((current) => ({
                        ...current,
                        apiKey: event.target.value,
                      }));
                    }}
                    maxLength={4096}
                    placeholder={
                      providerStatus.provider?.apiKeyNeedsReentry
                        ? "原 Key 无法解密；请重新输入以修复"
                        : providerStatus.provider?.hasApiKey
                          ? "已在当前账户配置；留空不会更新"
                          : "远程 HTTPS 服务需要 API Key"
                    }
                  />
                </label>
                <button
                  className="agent-discover-button"
                  type="button"
                  disabled={providerBusy || !canDiscoverModels}
                  onClick={() => void discoverProviderModels()}
                >
                  {providerBusy ? (
                    <LoaderCircle className="agent-spinner" size={15} />
                  ) : (
                    <Settings2 size={15} />
                  )}
                  检测连接并获取模型
                </button>
                {discoveryStatus ? (
                  <p className="agent-discovery-status" role="status">
                    {discoveryStatus}
                  </p>
                ) : null}
                <div className="agent-model-field">
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
                      setModelSuggestionIndex(0);
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
                      className="agent-model-suggestions"
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
                            index === modelSuggestionIndex ? "active" : ""
                          }
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => chooseDiscoveredModel(model)}
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
                <p className="agent-settings-status" role="status">
                  {providerStatusText}
                </p>
                <button type="button" onClick={() => void checkHarness()}>
                  项目能力自检
                </button>
                {harnessStatusText ? (
                  <p role="status">{harnessStatusText}</p>
                ) : null}
                <div className="agent-settings-actions">
                  <button
                    type="button"
                    disabled={
                      providerBusy ||
                      !providerDraft.model ||
                      !canSaveProviderDraft
                    }
                    onClick={() => void testProvider()}
                  >
                    <CircleHelp size={14} /> 测试连接
                  </button>
                  <button
                    type="submit"
                    className="primary"
                    disabled={
                      providerBusy ||
                      !providerDraft.name ||
                      !providerDraft.model ||
                      !canSaveProviderDraft
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
                    className="agent-clear-connection"
                    type="button"
                    disabled={providerBusy}
                    onClick={() => void clearProvider()}
                  >
                    清除此账户的模型连接
                  </button>
                ) : null}
              </form>
              <footer>
                {isTauriRuntime()
                  ? "桌面版通过 Rust 网关获取模型列表和聊天。结构化模型可生成持久待审阅提议；只有你确认后才原子写入，当前支持基本信息、自我评价和经历正文。连接测试发送两条不含简历的短请求，供应商可能收费。"
                  : "仅测试用户选定的服务。测试请求不含简历内容，供应商可能收费。连接验证不会自动启用未通过 schema 校验的工具调用。"}
              </footer>
            </>
          )}
        </motion.section>
      </motion.div>
    ) : null}
  </AnimatePresence>);
}
