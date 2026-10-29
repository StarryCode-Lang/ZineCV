import {
  ArrowUpRight, ChevronDown, ChevronUp, CircleHelp, History, Minus, Plus, Send, Settings2, ShieldCheck,
  Square, X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type * as React from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { AgentProposalRecord } from "../../../../src-tauri/src/domain/bindings/AgentProposalRecord";
import type { AgentProposalUndoRecord } from "../../../../src-tauri/src/domain/bindings/AgentProposalUndoRecord";
import type { AuthorityCursor } from "../../../../src-tauri/src/domain/bindings/AuthorityCursor";
import { sameCursor } from "../../../platform/NativeDocumentClient";
import { hasDocumentRuntime as isTauriRuntime } from "../../../platform/ipc";
import {
  type BasicInfo,
  type Entry,
  type ModuleKey
} from "../../domain/resume-model";
import { AgentMark } from "../AgentMark";
import {
  referenceKindLabel,
  sectionContextLabel,
  type FixedRect
} from "../agentOverlayUtils";
import type { AgentSessionStore } from "../sessions";
import type { AgentSkill } from "../skills";
import type {
  AgentEditTarget,
  AgentMessage,
  AgentProposal,
  AgentProviderStatus,
  AgentReference,
  AgentView
} from "../types";
import { DurableProposalCard, ProposalCard, UndoAgentProposalCard } from './proposalCards';
import type { CatalogAgentReference } from "./shared";
import { AgentMode, CompletionMenu } from './shared';
export function renderAgentShell(context: {
  documentTitles?: Record<string, string>;
  activeCursor?: AuthorityCursor;
  activeDocumentTitle?: string;
  returnToProposalTarget?: (documentId: string) => void;
  modeValue: AgentMode;
  activeView: AgentView;
  position: FixedRect;
  dragRef: RefObject<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean; } | null>;
  resizeRef: RefObject<{ pointerId: number; x: number; y: number; width: number; height: number; } | null>;
  reduceMotion: boolean | null;
  beginDrag: (event: React.PointerEvent<HTMLElement>) => void;
  freezeDockUntil: RefObject<number>;
  moveDrag: (event: React.PointerEvent<HTMLElement>) => void;
  endDrag: (event: React.PointerEvent<HTMLElement>) => void;
  runState: "idle" | "running" | "failed" | "stopped";
  suppressBotClick: RefObject<boolean>;
  setMode: (next: AgentMode) => void;
  expandedMode: RefObject<AgentMode>;
  providerStatus: AgentProviderStatus;
  sessionPickerOpen: boolean;
  setSessionPickerOpen: Dispatch<SetStateAction<boolean>>;
  acceptingProposalId: string | null;
  createSession: () => void;
  openSettings: () => void;
  sessionStore: AgentSessionStore;
  activeSessionId: string;
  switchSession: (id: string) => void;
  messagesRef: RefObject<HTMLDivElement | null>;
  messages: AgentMessage[];
  proposals: AgentProposal[];
  referenceCatalog: CatalogAgentReference[];
  locateReference: (id: string) => void;
  acceptProposal: (proposal: AgentProposal) => Promise<void>;
  rejectProposal: (proposal: AgentProposal) => void;
  nativeProposals: AgentProposalRecord[];
  acceptNativeProposal: (proposal: AgentProposalRecord, acceptedItemIds: string[]) => Promise<void>;
  rejectNativeProposal: (proposal: AgentProposalRecord) => Promise<void>;
  nativeUndoable: AgentProposalUndoRecord[];
  undoNativeProposal: (receipt: AgentProposalUndoRecord) => Promise<void>;
  undoEdit: { target: AgentEditTarget; originalValue: unknown; expectedValue: unknown; branchId: string; headId: string | null; } | null;
  undoLastEdit: () => void;
  runStatus: string;
  interruptedSessionRun: boolean;
  composerAreaRef: RefObject<HTMLDivElement | null>;
  references: string[];
  setReferences: Dispatch<SetStateAction<string[]>>;
  selectedSkill: AgentSkill | null;
  setSkillId: Dispatch<SetStateAction<string | null>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  completionMenu: CompletionMenu;
  updateDraft: (value: string, caret: number) => void;
  onComposerKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  composingUntil: RefObject<number>;
  filteredReferences: CatalogAgentReference[];
  filteredSkills: AgentSkill[];
  menuIndex: number;
  chooseReference: (reference: AgentReference) => void;
  chooseSkill: (skill: AgentSkill) => void;
  insertComposerToken: (token: "@" | "/") => void;
  approximateContextTokens: number;
  contextPreview: string;
  localError: string;
  cancelRun: () => void;
  sendMessage: () => Promise<void>;
  hasHistory: boolean;
  providerStatusText: string;
  beginResize: (event: React.PointerEvent<HTMLButtonElement>) => void;
  moveResize: (event: React.PointerEvent<HTMLButtonElement>) => void;
  endResize: (event: React.PointerEvent<HTMLButtonElement>) => void;
}): React.ReactNode {
  const {
    modeValue, activeView, position, dragRef, resizeRef, reduceMotion, beginDrag, freezeDockUntil, moveDrag,
    endDrag, runState, suppressBotClick, setMode, expandedMode, providerStatus, sessionPickerOpen,
    setSessionPickerOpen, acceptingProposalId, createSession, openSettings, sessionStore, activeSessionId,
    switchSession, messagesRef, messages, proposals, referenceCatalog, locateReference, acceptProposal,
    rejectProposal, nativeProposals, acceptNativeProposal, rejectNativeProposal, nativeUndoable,
    undoNativeProposal, undoEdit, undoLastEdit, runStatus, interruptedSessionRun, composerAreaRef, references,
    setReferences, selectedSkill, setSkillId, textareaRef, draft, completionMenu, updateDraft,
    onComposerKeyDown, composingUntil, filteredReferences, filteredSkills, menuIndex, chooseReference,
    chooseSkill, insertComposerToken, approximateContextTokens, contextPreview, localError, cancelRun,
    sendMessage, hasHistory, providerStatusText, beginResize, moveResize, endResize,
  } = context;
  return (<motion.aside
    className={`agent-shell agent-mode-${modeValue} ${window.innerWidth < 760 ? "agent-mobile" : ""}`}
    data-agent-overlay
    data-agent-view={activeView}
    initial={false}
    animate={{
      left: position?.left ?? 0,
      top: position?.top ?? 0,
      width: position?.width ?? 56,
      height: position?.height ?? 56,
      borderRadius: modeValue === "bot" ? 28 : 14,
      opacity: 1,
    }}
    transition={
      dragRef.current || resizeRef.current
        ? { type: "spring", stiffness: 900, damping: 65, mass: 0.5 }
        : reduceMotion
          ? { duration: 0.1 }
          : { type: "spring", stiffness: 320, damping: 30, mass: 0.8 }
    }
    onPointerDown={(event) => {
      beginDrag(event);
      freezeDockUntil.current = performance.now() + 550;
    }}
    onPointerMove={moveDrag}
    onPointerUp={endDrag}
    onPointerCancel={endDrag}
    onFocusCapture={() => {
      freezeDockUntil.current = performance.now() + 900;
    }}
    onCompositionStartCapture={() => {
      freezeDockUntil.current = performance.now() + 1200;
    }}
  >
    <motion.span
      className="agent-shared-mark"
      initial={false}
      animate={{
        left: modeValue === "bot" ? 8 : 13,
        top: modeValue === "bot" ? 8 : 11,
        width: modeValue === "bot" ? 40 : 27,
        height: modeValue === "bot" ? 40 : 27,
      }}
      transition={
        reduceMotion
          ? { duration: 0.1 }
          : { type: "spring", stiffness: 320, damping: 30, mass: 0.8 }
      }
      aria-hidden="true"
    >
      <AgentMark active={runState === "running"} />
    </motion.span>
    <AnimatePresence initial={false}>
      {modeValue === "bot" ? (
        <motion.button
          key="bot"
          className="agent-bot-button"
          type="button"
          aria-label="展开 Re:me 助手"
          title="展开 Re:me 助手"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{
            duration: reduceMotion ? 0.05 : 0.14,
            ease: "easeOut",
          }}
          onClick={() => {
            if (suppressBotClick.current) return;
            setMode(expandedMode.current);
          }}
        ></motion.button>
      ) : (
        <motion.div
          key="panel"
          className={`agent-panel ${modeValue === "chat" ? "agent-panel-chat" : "agent-panel-composer"}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{
            duration: reduceMotion ? 0.05 : 0.18,
            ease: "easeOut",
          }}
        >
          <header className="agent-header">
            <div className="agent-heading-brand">
              <span className="agent-mark">
                <span
                  className="agent-mark-placeholder"
                  aria-hidden="true"
                />
              </span>
              <span>
                <strong>Re:me 助手</strong>
                <small>
                  {sectionContextLabel(activeView)} ·{" "}
                  {providerStatus.configured
                    ? providerStatus.provider?.model
                    : "本地能力可用"}
                </small>
              </span>
            </div>
            <div className="agent-header-actions">
              {modeValue === "chat" ? (
                <button
                  type="button"
                  aria-label="历史对话"
                  title="历史对话"
                  aria-expanded={sessionPickerOpen}
                  onClick={() =>
                    setSessionPickerOpen((current) => !current)
                  }
                >
                  <History size={16} />
                </button>
              ) : null}
              <button
                type="button"
                aria-label="新建对话"
                title="新建对话"
                disabled={
                  runState === "running" || acceptingProposalId !== null
                }
                onClick={createSession}
              >
                <Plus size={16} />
              </button>
              <button
                type="button"
                aria-label="模型设置"
                title="模型设置"
                onClick={openSettings}
              >
                <Settings2 size={16} />
              </button>
              {modeValue === "composer" ? (
                <button
                  type="button"
                  aria-label="展开聊天"
                  title="展开聊天"
                  onClick={() => setMode("chat")}
                >
                  <ChevronUp size={16} />
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="收起聊天"
                  title="收起聊天"
                  onClick={() => {
                    setSessionPickerOpen(false);
                    setMode("composer");
                  }}
                >
                  <ChevronDown size={16} />
                </button>
              )}
              <button
                type="button"
                aria-label="最小化到 Bot"
                title="最小化"
                onClick={() => {
                  setSessionPickerOpen(false);
                  setMode("bot");
                }}
              >
                <Minus size={16} />
              </button>
            </div>
          </header>

          {sessionPickerOpen ? (
            <section
              className="agent-session-picker"
              aria-label="历史对话列表"
            >
              <div className="agent-session-picker-heading">
                <strong>历史对话</strong>
                <span>{isTauriRuntime() ? "仅保存在此设备" : "仅保存在此浏览器"}</span>
              </div>
              <div className="agent-session-list">
                {[...sessionStore.sessions]
                  .sort((left, right) => right.updatedAt - left.updatedAt)
                  .map((session) => (
                    <button
                      type="button"
                      key={session.id}
                      className={
                        session.id === activeSessionId ? "active" : ""
                      }
                      aria-current={
                        session.id === activeSessionId ? "true" : undefined
                      }
                      disabled={
                        runState === "running" ||
                        acceptingProposalId !== null
                      }
                      onClick={() => switchSession(session.id)}
                    >
                      <strong>{session.title}</strong>
                      <small>
                        {session.messages.length} 条消息 ·{" "}
                        {new Date(session.updatedAt).toLocaleString(
                          "zh-CN",
                        )}
                      </small>
                    </button>
                  ))}
              </div>
            </section>
          ) : null}

          {modeValue === "chat" ? (
            <div
              className="agent-chat-scroll"
              ref={messagesRef}
              role="log"
              aria-live="polite"
              aria-label="助手对话"
            >
              {messages.length === 0 && proposals.length === 0 ? (
                <div className="agent-chat-empty">
                  <span>
                    <CircleHelp size={18} />
                  </span>
                  <strong>从一个明确范围开始</strong>
                  <p>
                    用 @ 选经历、模板或版本；用 / 选择一个受限的项目技能。
                  </p>
                </div>
              ) : null}
              {messages.map((message) => (
                <article
                  className={`agent-message agent-message-${message.role}`}
                  key={message.id}
                >
                  <div className="agent-message-meta">
                    <strong>
                      {message.role === "user"
                        ? "你"
                        : message.role === "system"
                          ? "状态"
                          : "Re:me 助手"}
                    </strong>
                    {message.sourceView ? (
                      <span>
                        来自{sectionContextLabel(message.sourceView)}
                      </span>
                    ) : null}
                  </div>
                  <p>{message.text}</p>
                  {message.sourceRefs?.length ? (
                    <div className="agent-message-sources">
                      {message.sourceRefs.map((id) => {
                        const reference = referenceCatalog.find(
                          (item) => item.id === id,
                        );
                        return reference ? (
                          <button
                            type="button"
                            key={id}
                            onClick={() => locateReference(id)}
                            title="定位引用来源"
                          >
                            {reference.label}
                            <ArrowUpRight size={12} />
                          </button>
                        ) : (
                          <span key={id} className="agent-stale-source">
                            来源已删除
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                </article>
              ))}
              {proposals.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  proposal={proposal}
                  onAccept={() => void acceptProposal(proposal)}
                  onReject={() => rejectProposal(proposal)}
                  busy={
                    runState === "running" || acceptingProposalId !== null
                  }
                />
              ))}
              {nativeProposals.map((proposal) => (
                <DurableProposalCard
                  key={proposal.id}
                  proposal={proposal}
                    targetLabel={(context.activeCursor?.documentId === proposal.cursor.documentId ? context.activeDocumentTitle : context.documentTitles?.[proposal.cursor.documentId]) || "名称暂不可用"}
                  inactiveReason={!context.activeCursor || !sameCursor(context.activeCursor, proposal.cursor) ? "提议的目标或修订已变化，请返回原目标核对，必要时重新生成建议。" : undefined}
                  onReturnTarget={context.activeCursor?.documentId !== proposal.cursor.documentId && context.returnToProposalTarget ? () => context.returnToProposalTarget!(proposal.cursor.documentId) : undefined}
                  referenceLabel={(id) =>
                    referenceCatalog.find((item) => item.id === id)?.label ?? id
                  }
                  onAccept={(itemIds) =>
                    void acceptNativeProposal(proposal, itemIds)
                  }
                  onReject={() => void rejectNativeProposal(proposal)}
                  busy={runState === "running" || acceptingProposalId !== null}
                />
              ))}
              {nativeUndoable.slice(0, 10).map((receipt) => (
                <UndoAgentProposalCard
                  key={receipt.receiptId}
                  receipt={receipt}
                    targetLabel={(context.activeCursor?.documentId === receipt.cursor.documentId ? context.activeDocumentTitle : context.documentTitles?.[receipt.cursor.documentId]) || "名称暂不可用"}
                  inactiveReason={!context.activeCursor || context.activeCursor.documentId !== receipt.cursor.documentId || context.activeCursor.contextId !== receipt.cursor.contextId || context.activeCursor.branchId !== receipt.cursor.branchId ? "请返回这次修改原属的简历、来源与分支后撤回。" : undefined}
                  onReturnTarget={context.activeCursor?.documentId !== receipt.cursor.documentId && context.returnToProposalTarget ? () => context.returnToProposalTarget!(receipt.cursor.documentId) : undefined}
                  busy={runState === "running" || acceptingProposalId !== null}
                  onUndo={() => void undoNativeProposal(receipt)}
                />
              ))}
              {undoEdit ? (
                <section
                  className="agent-proposal"
                  aria-label="撤回上次修改"
                >
                  <p>
                    上次确认的简历修改可撤回；若字段或分支已变化，会拒绝覆盖。
                  </p>
                  <div className="agent-proposal-actions">
                    <button type="button" onClick={undoLastEdit}>
                      撤回上次修改
                    </button>
                  </div>
                </section>
              ) : null}
              {runState === "running" ? (
                <div className="agent-running" role="status">
                  <AgentMark active className="agent-running-mark" />
                  {runStatus}
                </div>
              ) : null}
            </div>
          ) : null}

          {interruptedSessionRun ? <div className="agent-running" role="status">上次运行已中断；已保存的对话保留，请手动重试。</div> : null}
          <div className="agent-composer-area" ref={composerAreaRef}>
            <div className="agent-chips">
              {references.map((id) => {
                const reference = referenceCatalog.find(
                  (item) => item.id === id,
                );
                return (
                  <span
                    className={`agent-chip ${reference ? "" : "agent-chip-stale"}`}
                    key={id}
                  >
                    <span>
                      {reference
                        ? reference.kind === "entry"
                          ? `${reference.label} · ${reference.entry?.id.slice(-8)}`
                          : reference.label
                        : "引用已失效"}
                    </span>
                    <button
                      type="button"
                      aria-label={`移除引用 ${reference?.label ?? "已失效对象"}`}
                      onClick={() =>
                        setReferences((current) =>
                          current.filter((item) => item !== id),
                        )
                      }
                    >
                      <X size={11} />
                    </button>
                  </span>
                );
              })}
              {selectedSkill ? (
                <span className="agent-chip agent-skill-chip">
                  <span>
                    /{selectedSkill.id} · {selectedSkill.title}
                  </span>
                  <button
                    type="button"
                    aria-label={`移除技能 ${selectedSkill.title}`}
                    onClick={() => setSkillId(null)}
                  >
                    <X size={11} />
                  </button>
                </span>
              ) : null}
            </div>
            <div className="agent-input-wrap">
              <textarea
                ref={textareaRef}
                value={draft}
                aria-label="给 Re:me 助手发送消息"
                aria-expanded={
                  modeValue === "chat" && Boolean(completionMenu)
                }
                aria-controls="agent-completion-list"
                placeholder={
                  modeValue === "chat"
                    ? "继续提问… 输入 @ 引用对象，/ 选择技能"
                    : "描述你想检查或修改的内容… 输入 @ 选择对象"
                }
                rows={modeValue === "chat" ? 2 : 2}
                maxLength={6000}
                onChange={(event) =>
                  updateDraft(
                    event.currentTarget.value,
                    event.currentTarget.selectionStart,
                  )
                }
                onKeyDown={onComposerKeyDown}
                onCompositionStart={() => {
                  composingUntil.current = Number.POSITIVE_INFINITY;
                  freezeDockUntil.current = performance.now() + 1200;
                }}
                onCompositionEnd={() => {
                  composingUntil.current = performance.now() + 120;
                  freezeDockUntil.current = performance.now() + 450;
                  window.setTimeout(
                    () => window.dispatchEvent(new Event("resize")),
                    470,
                  );
                }}
              />
              {modeValue === "chat" && completionMenu ? (
                <div
                  className="agent-completion"
                  role="listbox"
                  id="agent-completion-list"
                  aria-label={
                    completionMenu.kind === "reference"
                      ? "选择引用"
                      : "选择技能"
                  }
                >
                  <div className="agent-completion-heading">
                    {completionMenu.kind === "reference"
                      ? `可引用对象 · ${filteredReferences.length} 项`
                      : `项目命令 · ${filteredSkills.length} 项`}
                  </div>
                  {completionMenu.kind === "reference" ? (
                    filteredReferences.length ? (
                      filteredReferences.map((reference, index) => (
                        <button
                          className={index === menuIndex ? "active" : ""}
                          role="option"
                          aria-selected={index === menuIndex}
                          type="button"
                          key={reference.id}
                          onPointerDown={(event) => event.preventDefault()}
                          onClick={() => chooseReference(reference)}
                        >
                          <span className="agent-completion-kind">
                            {referenceKindLabel(reference)}
                          </span>
                          <span>
                            <strong>{reference.label}</strong>
                            <small>{reference.detail}</small>
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="agent-completion-empty">
                        当前页面没有匹配对象；请调整搜索或先导入模板。
                      </p>
                    )
                  ) : filteredSkills.length ? (
                    filteredSkills.map((skill, index) => (
                      <button
                        className={index === menuIndex ? "active" : ""}
                        role="option"
                        aria-selected={index === menuIndex}
                        type="button"
                        key={skill.id}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => chooseSkill(skill)}
                      >
                        <span className="agent-completion-kind">
                          /{skill.id}
                        </span>
                        <span>
                          <strong>{skill.title}</strong>
                          <small>{skill.description}</small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="agent-completion-empty">
                      没有匹配技能；Esc 可关闭菜单并保留文本。
                    </p>
                  )}
                </div>
              ) : null}
            </div>
            <div className="agent-composer-footer">
              <div className="agent-composer-shortcuts">
                <button
                  type="button"
                  aria-label="引用对象"
                  title="引用对象"
                  onClick={() => insertComposerToken("@")}
                >
                  @
                </button>
                <button
                  type="button"
                  aria-label="选择命令"
                  title="选择命令"
                  onClick={() => insertComposerToken("/")}
                >
                  /
                </button>
              </div>
              <div className="agent-composer-meta">
                {references.length || selectedSkill ? (
                  <details className="agent-context-disclosure">
                    <summary>
                      <ShieldCheck size={12} /> 本轮将发送{" "}
                      {references.length} 个引用 · 约{" "}
                      {approximateContextTokens} tokens
                    </summary>
                    <pre>{contextPreview || "没有引用简历内容"}</pre>
                  </details>
                ) : (
                  <span className="agent-local-capability">
                    @ 引用对象 · / 选择技能
                  </span>
                )}
                {localError ? (
                  <span className="agent-inline-error" role="alert">
                    {localError}
                  </span>
                ) : null}
              </div>
              {runState === "running" ? (
                <button
                  className="agent-send-button agent-stop-button"
                  type="button"
                  aria-label="停止请求"
                  title="停止请求"
                  onClick={cancelRun}
                >
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="agent-send-button"
                  type="button"
                  aria-label="发送消息"
                  title="发送消息"
                  disabled={!draft.trim() && !selectedSkill}
                  onClick={() => void sendMessage()}
                >
                  <Send size={15} />
                </button>
              )}
            </div>
            {hasHistory && modeValue === "composer" ? (
              <span className="agent-pending-pill" role="status">
                {proposals.length
                  ? `${proposals.length} 条待审阅`
                  : runState === "running"
                    ? "请求运行中"
                    : "对话已保留"}
              </span>
            ) : null}
            {providerStatusText ? (
              <span className="agent-provider-note">
                {providerStatus.configured
                  ? providerStatus.provider?.name
                  : providerStatusText}
              </span>
            ) : null}
          </div>
          {modeValue === "chat" ? (
            <button
              type="button"
              className="agent-resize-handle"
              aria-label="调整助手窗口大小"
              title="拖动调整助手窗口大小"
              onPointerDown={beginResize}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
            />
          ) : null}
        </motion.div>
      )}
    </AnimatePresence>
  </motion.aside>);
}
