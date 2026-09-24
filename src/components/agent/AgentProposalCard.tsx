import { ShieldCheck } from "lucide-react";
import type { AgentProposal } from "../../agent/types";
import { moduleTitles } from "../../domain/resume-model";
import { basicFieldLabels, plainText } from "../../agent/context";
import styles from "./AgentProposalCard.module.css";

export function AgentProposalCard({
  proposal,
  onAccept,
  onReject,
  busy,
}: {
  proposal: AgentProposal;
  onAccept: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  return (
    <section className={styles.proposal} aria-label={proposal.title}>
      <header>
        <span>
          <ShieldCheck size={14} /> 待你审阅
        </span>
        <strong>{proposal.title}</strong>
      </header>
      <p>{proposal.explanation}</p>
      {proposal.kind === "resume-edit" ? (
        <div className={styles.proposalDiff}>
          <small>
            {proposal.target.kind === "basic"
              ? basicFieldLabels[proposal.target.key]
              : proposal.target.kind === "summary"
                ? "自我评价"
                : `${proposal.target.module} · ${proposal.target.id.slice(-8)}`}
          </small>
          {proposal.target.kind === "basic" && "value" in proposal.patch ? (
            <pre>
              {String(proposal.expectedValue ?? "")} → {proposal.patch.value}
            </pre>
          ) : null}
          {proposal.target.kind === "summary" && "html" in proposal.patch ? (
            <pre>
              {plainText(String(proposal.expectedValue ?? "")) || "（空）"} →{" "}
              {plainText(String(proposal.patch.html ?? ""))}
            </pre>
          ) : null}
          {proposal.target.kind === "entry"
            ? Object.entries(proposal.patch).map(([key, value]) => (
                <div key={key}>
                  <b>{key === "html" ? "正文" : key}</b>
                  <span>
                    {key === "html" ? plainText(String(value)) : String(value)}
                  </span>
                </div>
              ))
            : null}
        </div>
      ) : proposal.kind === "resume-delete" ? (
        <div className={styles.proposalDiff}>
          <small>
            {moduleTitles[proposal.target.module]} ·{" "}
            {proposal.expectedValue.title || "未命名经历"}
          </small>
          <pre>
            {[proposal.expectedValue.start, proposal.expectedValue.end]
              .filter(Boolean)
              .join(" – ") || "未填写时间"}
          </pre>
          <span>确认后从当前草稿移除这条经历。</span>
        </div>
      ) : proposal.kind === "apply-template" ? (
        <ul>
          {proposal.effects.map((effect) => (
            <li key={effect}>{effect}</li>
          ))}
        </ul>
      ) : (
        <div className={styles.proposalDiff}>
          <small>{proposal.message}</small>
          <span>保存到所选当前分支；确认后才会写入版本库。</span>
        </div>
      )}
      <div className={styles.proposalActions}>
        <button type="button" onClick={onReject} disabled={busy}>
          拒绝
        </button>
        <button
          type="button"
          className={styles.primary}
          onClick={onAccept}
          disabled={busy}
        >
          确认并应用
        </button>
      </div>
    </section>
  );
}
