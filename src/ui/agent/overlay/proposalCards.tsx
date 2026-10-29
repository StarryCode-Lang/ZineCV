import {
  ShieldCheck
} from "lucide-react";
import {
  useEffect,
  useState
} from "react";
import type { AgentProposalRecord } from "../../../../src-tauri/src/domain/bindings/AgentProposalRecord";
import type { AgentProposalUndoRecord } from "../../../../src-tauri/src/domain/bindings/AgentProposalUndoRecord";
import { nativeInvoke } from "../../../platform/ipc";
import {
  moduleTitles,
  type BasicInfo
} from "../../domain/resume-model";
import { stripHtml } from "../../utils/resume";
import {
  basicFieldLabels
} from "../context";
import type {
  AgentProposal
} from "../types";
export function ProposalCard({
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
    <section className="agent-proposal" aria-label={proposal.title}>
      <header>
        <span>
          <ShieldCheck size={14} /> 待你审阅
        </span>
        <strong>{proposal.title}</strong>
      </header>
      <p>{proposal.explanation}</p>
      {proposal.kind === "resume-edit" ? (
        <div className="agent-proposal-diff">
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
              {stripHtml(String(proposal.expectedValue ?? "")) || "（空）"} →{" "}
              {stripHtml(String(proposal.patch.html ?? ""))}
            </pre>
          ) : null}
          {proposal.target.kind === "entry"
            ? Object.entries(proposal.patch).map(([key, value]) => (
              <div key={key}>
                <b>{key === "html" ? "正文" : key}</b>
                <span>
                  {key === "html" ? stripHtml(String(value)) : String(value)}
                </span>
              </div>
            ))
            : null}
        </div>
      ) : proposal.kind === "resume-delete" ? (
        <div className="agent-proposal-diff">
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
        <div className="agent-proposal-diff">
          <small>{proposal.message}</small>
          <span>保存到所选当前分支；确认后才会写入版本库。</span>
        </div>
      )}
      <div className="agent-proposal-actions">
        <button type="button" onClick={onReject} disabled={busy}>
          拒绝
        </button>
        <button
          type="button"
          className="primary"
          onClick={onAccept}
          disabled={busy}
        >
          确认并应用
        </button>
      </div>
    </section>
  );
}

export function proposalValueText(value: unknown): string {
  if (value === null || value === undefined) return "（空）";
  if (typeof value === "string") return stripHtml(value) || "（空）";
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) {
    const text = value.map(proposalValueText).filter(Boolean).join("\n");
    return text || "（空）";
  }
  if (typeof value === "object") {
    const node = value as Record<string, unknown>;
    if (node.type === "text" && typeof node.text === "string") return node.text;
    if (node.type === "break") return "\n";
    if (Array.isArray(node.children)) return proposalValueText(node.children);
    if (Array.isArray(node.items)) return proposalValueText(node.items);
    if ("present" in node && node.present === false) return "（不存在）";
    if (node.entry && typeof node.entry === "object") {
      const entry = node.entry as Record<string, unknown>;
      const title = typeof entry.title === "string" ? entry.title : "未命名经历";
      const body = proposalValueText(entry.body);
      return body === "（空）" ? title : `${title}\n${body}`;
    }
    const fields = Object.values(node).map(proposalValueText).filter((item) => item !== "（空）");
    return fields.join(" / ") || "（空）";
  }
  return String(value);
}

export function ProposalAvatarPreview({ value, label }: { value: unknown; label: string }) {
  const hash = value && typeof value === "object" ? (value as { avatarAssetId?: unknown }).avatarAssetId : null;
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setImage(null);
    setFailed(false);
    if (typeof hash === "string" && hash) {
      void nativeInvoke("read_avatar_asset", { hash }).then((asset) => {
        if (active) setImage((asset as { dataUrl: string }).dataUrl);
      }).catch(() => { if (active) setFailed(true); });
    }
    return () => { active = false; };
  }, [hash]);
  return <span>{image ? <img src={image} alt={label} width={48} height={48} style={{ objectFit: "contain" }} /> : failed ? "图片不可用" : hash ? "图片载入中" : "无头像"}</span>;
}

export function proposalChangeLabel(proposal: AgentProposalRecord["items"][number]) {
  switch (proposal.change.type) {
    case "updateBasic":
      if (typeof proposal.change.patch.avatarAssetId === "string") return "头像 · 确认后更新本机图片";
      return `基本信息 · ${Object.entries(proposal.change.patch)
        .filter(([, value]) => value !== null)
        .map(([key]) => basicFieldLabels[key as keyof BasicInfo] ?? key)
        .join("、") || proposal.referenceId}`;
    case "setSummaryBody":
      return "自我评价正文";
    case "setEntryBody":
    case "updateEntryFields":
    case "deleteEntry":
    case "moveEntry":
      return `经历 · ${proposal.referenceId}`;
    case "addEntry":
      return `新增经历 · ${proposal.referenceId}`;
    case "renameSection":
      return `模块名称 · ${proposal.referenceId}`;
    case "setSectionVisibility":
      return `模块显示 · ${proposal.referenceId}`;
    case "moveSection":
      return `模块顺序 · ${proposal.referenceId}`;
    case "setDocumentTitle":
      return "简历标题";
    case "applyTemplate":
      return `模板切换 · ${proposal.change.template_id}`;
    case "commitVersion":
      return `确认后保存版本 · ${proposal.change.message}`;
  }
}

export function DurableProposalCard({
  proposal,
  referenceLabel,
  onAccept,
  onReject,
  busy,
  targetLabel,
  inactiveReason,
  onReturnTarget,
}: {
  proposal: AgentProposalRecord;
  referenceLabel: (id: string) => string;
  onAccept: (acceptedItemIds: string[]) => void;
  onReject: () => void;
  busy: boolean;
  targetLabel?: string;
  inactiveReason?: string;
  onReturnTarget?: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(proposal.items.map((item) => item.id)),
  );
  const acceptedItemIds = proposal.items
    .filter((item) => selected.has(item.id))
    .map((item) => item.id);
  return (
    <section className="agent-proposal" aria-label="宿主保存的待审阅提议">
      <header>
        <span><ShieldCheck size={14} /> 待你审阅 · 已保存</span>
        <strong>{proposal.explanation}</strong>
      </header>
      {targetLabel ? <p title={proposal.cursor.documentId}>目标简历：{targetLabel}</p> : null}
      {inactiveReason ? <p role="status">{inactiveReason}{onReturnTarget ? <button type="button" disabled={busy} onClick={onReturnTarget}>切回此提议的简历</button> : null}</p> : null}
      {proposal.items.map((item) => (
        <label className="agent-proposal-diff" key={item.id}>
          <small>
            <input
              type="checkbox"
              checked={selected.has(item.id)}
              disabled={busy}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked) next.add(item.id);
                  else next.delete(item.id);
                  return next;
                });
              }}
            />{" "}
            {referenceLabel(item.referenceId)}
          </small>
          <b>{item.summary || proposalChangeLabel(item)}</b>
          {item.change.type === "updateBasic" && typeof item.change.patch.avatarAssetId === "string" ? (
            <div className="agent-avatar-proposal-preview">
              <ProposalAvatarPreview value={item.beforeValue} label="当前头像" />
              <span aria-hidden="true">→</span>
              <ProposalAvatarPreview value={item.afterValue} label="确认后的头像" />
            </div>
          ) : <pre>
            {proposalValueText(item.beforeValue)} → {proposalValueText(item.afterValue)}
          </pre>}
        </label>
      ))}
      <div className="agent-proposal-actions">
        <button type="button" onClick={onReject} disabled={busy}>拒绝</button>
        <button
          type="button"
          className="primary"
          onClick={() => onAccept(acceptedItemIds)}
          disabled={busy || !!inactiveReason || acceptedItemIds.length === 0}
        >
          确认所选 {acceptedItemIds.length} 项
        </button>
      </div>
    </section>
  );
}

export function UndoAgentProposalCard({
  receipt,
  busy,
  onUndo,
  targetLabel,
  inactiveReason,
  onReturnTarget,
}: {
  receipt: AgentProposalUndoRecord;
  busy: boolean;
  onUndo: () => void;
  targetLabel?: string;
  inactiveReason?: string;
  onReturnTarget?: () => void;
}) {
  return (
    <section className="agent-proposal" aria-label="撤回已确认的 Agent 修改">
      {targetLabel ? <p title={receipt.cursor.documentId}>目标简历：{targetLabel}</p> : null}
      {inactiveReason ? <p role="status">{inactiveReason}{onReturnTarget ? <button type="button" disabled={busy} onClick={onReturnTarget}>返回这次修改的简历</button> : null}</p> : null}
      <p>
        最近一次确认写入了 {receipt.acceptedItemIds.length} 项。撤回会检查当前值；后续手工编辑不会被覆盖。
      </p>
      <div className="agent-proposal-actions">
        <button type="button" onClick={onUndo} disabled={busy || !!inactiveReason}>撤回这次修改</button>
      </div>
    </section>
  );
}
