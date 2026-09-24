import { forwardRef } from "react";
import { ArrowUpRight, CircleHelp } from "lucide-react";
import type {
  AgentMessage,
  AgentProposal,
  AgentEditTarget,
} from "../../agent/types";
import { AgentMark } from "./AgentMark";
import { AgentProposalCard } from "./AgentProposalCard";
import {
  sectionContextLabel,
  type CatalogAgentReference,
} from "./agent-overlay-utils";
import styles from "./AgentMessageList.module.css";

type AgentMessageListProps = {
  messages: AgentMessage[];
  proposals: AgentProposal[];
  referenceCatalog: CatalogAgentReference[];
  runState: "idle" | "running" | "failed" | "stopped";
  runStatus: string;
  busy: boolean;
  undoEdit: {
    target: AgentEditTarget;
    originalValue: unknown;
    expectedValue: unknown;
    branchId: string;
    headId: string | null;
  } | null;
  onLocateReference: (id: string) => void;
  onAcceptProposal: (proposal: AgentProposal) => void;
  onRejectProposal: (proposal: AgentProposal) => void;
  onUndoLastEdit: () => void;
};

export const AgentMessageList = forwardRef<
  HTMLDivElement,
  AgentMessageListProps
>(function AgentMessageList(
  {
    messages,
    proposals,
    referenceCatalog,
    runState,
    runStatus,
    busy,
    undoEdit,
    onLocateReference,
    onAcceptProposal,
    onRejectProposal,
    onUndoLastEdit,
  },
  ref,
) {
  return (
    <div
      className={styles.chatScroll}
      ref={ref}
      role="log"
      aria-live="polite"
      aria-label="助手对话"
    >
      {messages.length === 0 && proposals.length === 0 ? (
        <div className={styles.chatEmpty}>
          <span>
            <CircleHelp size={18} />
          </span>
          <strong>从一个明确范围开始</strong>
          <p>用 @ 选经历、模板或版本；用 / 选择一个受限的项目技能。</p>
        </div>
      ) : null}
      {messages.map((message) => (
        <article
          className={`${styles.message} ${message.role === "user" ? styles.messageUser : ""}`}
          key={message.id}
        >
          <div className={styles.messageMeta}>
            <strong>
              {message.role === "user"
                ? "你"
                : message.role === "system"
                  ? "状态"
                  : "Re:me 助手"}
            </strong>
            {message.sourceView ? (
              <span>来自{sectionContextLabel(message.sourceView)}</span>
            ) : null}
          </div>
          <p>{message.text}</p>
          {message.sourceRefs?.length ? (
            <div className={styles.messageSources}>
              {message.sourceRefs.map((id) => {
                const reference = referenceCatalog.find(
                  (item) => item.id === id,
                );
                return reference ? (
                  <button
                    type="button"
                    key={id}
                    onClick={() => onLocateReference(id)}
                    title="定位引用来源"
                  >
                    {reference.label}
                    <ArrowUpRight size={12} />
                  </button>
                ) : (
                  <span key={id} className={styles.staleSource}>
                    来源已删除
                  </span>
                );
              })}
            </div>
          ) : null}
        </article>
      ))}
      {proposals.map((proposal) => (
        <AgentProposalCard
          key={proposal.id}
          proposal={proposal}
          onAccept={() => onAcceptProposal(proposal)}
          onReject={() => onRejectProposal(proposal)}
          busy={busy}
        />
      ))}
      {undoEdit ? (
        <section className={styles.undoProposal} aria-label="撤回上次修改">
          <p>上次确认的简历修改可撤回；若字段或分支已变化，会拒绝覆盖。</p>
          <div className={styles.undoActions}>
            <button type="button" onClick={onUndoLastEdit}>
              撤回上次修改
            </button>
          </div>
        </section>
      ) : null}
      {runState === "running" ? (
        <div className={styles.running} role="status">
          <AgentMark active className={styles.runningMark} />
          {runStatus}
        </div>
      ) : null}
    </div>
  );
});
