import type { AgentSessionStore } from "../../agent/sessions";
import styles from "./AgentSessionPicker.module.css";

export function AgentSessionPicker({
  sessionStore,
  activeSessionId,
  busy,
  onSwitchSession,
}: {
  sessionStore: AgentSessionStore;
  activeSessionId: string;
  busy: boolean;
  onSwitchSession: (id: string) => void;
}) {
  return (
    <section className={styles.sessionPicker} aria-label="历史对话列表">
      <div className={styles.heading}>
        <strong>历史对话</strong>
        <span>仅保存在此浏览器</span>
      </div>
      <div className={styles.sessionList}>
        {[...sessionStore.sessions]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .map((session) => (
            <button
              type="button"
              key={session.id}
              className={session.id === activeSessionId ? styles.active : ""}
              aria-current={session.id === activeSessionId ? "true" : undefined}
              disabled={busy}
              onClick={() => onSwitchSession(session.id)}
            >
              <strong>{session.title}</strong>
              <small>
                {session.messages.length} 条消息 ·{" "}
                {new Date(session.updatedAt).toLocaleString("zh-CN")}
              </small>
            </button>
          ))}
      </div>
    </section>
  );
}
