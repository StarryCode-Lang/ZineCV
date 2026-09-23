import { CircleDot, Sparkles } from "lucide-react";

export function AiAssistantPanel({ onReturn }: { onReturn: () => void }) {
  return (
    <div className="assistant-workspace editor-scroll" data-assistant-workspace>
      <p className="assistant-kicker">AI ASSISTANT / BETA</p>
      <h1>把修改意见，变成下一版。</h1>
      <section className="assistant-empty-state">
        <span className="assistant-orbit" aria-hidden="true">
          <CircleDot size={24} />
        </span>
        <div>
          <strong>助手工作区已就位</strong>
          <p>
            当前版本先提供独立页面与编辑上下文保留。智能改写能力尚未接入，现阶段不会虚构处理结果。
          </p>
        </div>
      </section>
      <button className="assistant-return" type="button" onClick={onReturn}>
        <Sparkles size={15} aria-hidden="true" /> 返回编辑模板
      </button>
    </div>
  );
}
