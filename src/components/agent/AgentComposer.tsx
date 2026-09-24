import { forwardRef } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { ShieldCheck, Square, Send, X } from "lucide-react";
import {
  referenceKindLabel,
  type CatalogAgentReference,
  type CompletionMenu,
} from "./agent-overlay-utils";
import type { AgentSkill } from "../../agent/skills";
import styles from "./AgentComposer.module.css";

type AgentComposerProps = {
  modeValue: "chat" | "composer";
  draft: string;
  references: string[];
  referenceCatalog: CatalogAgentReference[];
  selectedSkill: AgentSkill | null;
  completionMenu: CompletionMenu;
  menuIndex: number;
  filteredReferences: CatalogAgentReference[];
  filteredSkills: AgentSkill[];
  approximateContextTokens: number;
  contextPreview: string;
  localError: string;
  runState: "idle" | "running" | "failed" | "stopped";
  providerStatusConfigured: boolean;
  providerName: string | undefined;
  providerStatusText: string;
  hasHistory: boolean;
  proposalsCount: number;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string, caret: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onRemoveReference: (id: string) => void;
  onRemoveSkill: () => void;
  onChooseReference: (reference: CatalogAgentReference) => void;
  onChooseSkill: (skill: AgentSkill) => void;
  onInsertToken: (token: "@" | "/") => void;
  onSend: () => void;
  onCancelRun: () => void;
};

export const AgentComposer = forwardRef<HTMLDivElement, AgentComposerProps>(
  function AgentComposer(
    {
      modeValue,
      draft,
      references,
      referenceCatalog,
      selectedSkill,
      completionMenu,
      menuIndex,
      filteredReferences,
      filteredSkills,
      approximateContextTokens,
      contextPreview,
      localError,
      runState,
      providerStatusConfigured,
      providerName,
      providerStatusText,
      hasHistory,
      proposalsCount,
      textareaRef,
      onDraftChange,
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      onRemoveReference,
      onRemoveSkill,
      onChooseReference,
      onChooseSkill,
      onInsertToken,
      onSend,
      onCancelRun,
    },
    ref,
  ) {
    return (
      <div
        className={`${styles.composerArea} ${modeValue === "composer" ? styles.modeComposer : ""}`}
        ref={ref}
      >
        <div className={styles.chips}>
          {references.map((id) => {
            const reference = referenceCatalog.find((item) => item.id === id);
            return (
              <span
                className={`${styles.chip} ${reference ? "" : styles.chipStale}`}
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
                  onClick={() => onRemoveReference(id)}
                >
                  <X size={11} />
                </button>
              </span>
            );
          })}
          {selectedSkill ? (
            <span className={`${styles.chip} ${styles.skillChip}`}>
              <span>
                /{selectedSkill.id} · {selectedSkill.title}
              </span>
              <button
                type="button"
                aria-label={`移除技能 ${selectedSkill.title}`}
                onClick={onRemoveSkill}
              >
                <X size={11} />
              </button>
            </span>
          ) : null}
        </div>
        <div className={styles.inputWrap}>
          <textarea
            ref={textareaRef}
            value={draft}
            aria-label="给 Re:me 助手发送消息"
            aria-expanded={modeValue === "chat" && Boolean(completionMenu)}
            aria-controls="agent-completion-list"
            placeholder={
              modeValue === "chat"
                ? "继续提问… 输入 @ 引用对象，/ 选择技能"
                : "描述你想检查或修改的内容… 输入 @ 选择对象"
            }
            rows={modeValue === "chat" ? 2 : 2}
            maxLength={6000}
            onChange={(event) =>
              onDraftChange(
                event.currentTarget.value,
                event.currentTarget.selectionStart,
              )
            }
            onKeyDown={onKeyDown}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
          />
          {modeValue === "chat" && completionMenu ? (
            <div
              className={styles.completion}
              role="listbox"
              id="agent-completion-list"
              aria-label={
                completionMenu.kind === "reference" ? "选择引用" : "选择技能"
              }
            >
              <div className={styles.completionHeading}>
                {completionMenu.kind === "reference"
                  ? `可引用对象 · ${filteredReferences.length} 项`
                  : `项目命令 · ${filteredSkills.length} 项`}
              </div>
              {completionMenu.kind === "reference" ? (
                filteredReferences.length ? (
                  filteredReferences.map((reference, index) => (
                    <button
                      className={index === menuIndex ? styles.active : ""}
                      role="option"
                      aria-selected={index === menuIndex}
                      type="button"
                      key={reference.id}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => onChooseReference(reference)}
                    >
                      <span className={styles.completionKind}>
                        {referenceKindLabel(reference)}
                      </span>
                      <span>
                        <strong>{reference.label}</strong>
                        <small>{reference.detail}</small>
                      </span>
                    </button>
                  ))
                ) : (
                  <p className={styles.completionEmpty}>
                    当前页面没有匹配对象；请调整搜索或先导入模板。
                  </p>
                )
              ) : filteredSkills.length ? (
                filteredSkills.map((skill, index) => (
                  <button
                    className={index === menuIndex ? styles.active : ""}
                    role="option"
                    aria-selected={index === menuIndex}
                    type="button"
                    key={skill.id}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => onChooseSkill(skill)}
                  >
                    <span className={styles.completionKind}>/{skill.id}</span>
                    <span>
                      <strong>{skill.title}</strong>
                      <small>{skill.description}</small>
                    </span>
                  </button>
                ))
              ) : (
                <p className={styles.completionEmpty}>
                  没有匹配技能；Esc 可关闭菜单并保留文本。
                </p>
              )}
            </div>
          ) : null}
        </div>
        <div className={styles.footer}>
          <div className={styles.shortcuts}>
            <button
              type="button"
              aria-label="引用对象"
              title="引用对象"
              onClick={() => onInsertToken("@")}
            >
              @
            </button>
            <button
              type="button"
              aria-label="选择命令"
              title="选择命令"
              onClick={() => onInsertToken("/")}
            >
              /
            </button>
          </div>
          <div className={styles.meta}>
            {references.length || selectedSkill ? (
              <details className={styles.contextDisclosure}>
                <summary>
                  <ShieldCheck size={12} /> 本轮将发送 {references.length}{" "}
                  个引用 · 约 {approximateContextTokens} tokens
                </summary>
                <pre>{contextPreview || "没有引用简历内容"}</pre>
              </details>
            ) : (
              <span className={styles.localCapability}>
                @ 引用对象 · / 选择技能
              </span>
            )}
            {localError ? (
              <span className={styles.inlineError} role="alert">
                {localError}
              </span>
            ) : null}
          </div>
          {runState === "running" ? (
            <button
              className={`${styles.sendButton} ${styles.stopButton}`}
              type="button"
              aria-label="停止请求"
              title="停止请求"
              onClick={onCancelRun}
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              className={styles.sendButton}
              type="button"
              aria-label="发送消息"
              title="发送消息"
              disabled={!draft.trim() && !selectedSkill}
              onClick={onSend}
            >
              <Send size={15} />
            </button>
          )}
        </div>
        {hasHistory && modeValue === "composer" ? (
          <span className={styles.pendingPill} role="status">
            {proposalsCount
              ? `${proposalsCount} 条待审阅`
              : runState === "running"
                ? "请求运行中"
                : "对话已保留"}
          </span>
        ) : null}
        {providerStatusText ? (
          <span className={styles.providerNote}>
            {providerStatusConfigured ? providerName : providerStatusText}
          </span>
        ) : null}
      </div>
    );
  },
);
