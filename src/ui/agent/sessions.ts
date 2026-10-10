import type { AgentMessage } from "./types";
import { hasDocumentRuntime as isTauriRuntime, nativeInvoke } from "../../platform/ipc";

// ---------------------------------------------------------------------------
// 流式会话落盘调度（写放大治理）
//
// AgentOverlay 的写 effect 原先对每次 sessionStore 变更（含每个流式 delta）都
// 直接调用 writeAgentSessions：全量 JSON.stringify 整个会话存储，并经
// replace_agent_sessions 全量替换数据库；流式输出期间形成每 delta 一次的
// CPU/IPC/SQLite 写放大。这里提供 800ms trailing 去抖调度：窗口内的多次变更
// 只保留最后一次并合并为一次落盘。流结束、浮层关闭、组件卸载、账户切换由
// 调用方触发 flushScheduledAgentSessionWrite 强制立即落盘，保证最终状态一定
// 写入。写入仍经 writeAgentSessions 既有串行队列与 revision 乐观锁，写入
// 顺序与失败（ack）语义不变。
// ---------------------------------------------------------------------------
export const AGENT_SESSION_WRITE_DEBOUNCE_MS = 800;

type ScheduledAgentSessionWrite = {
  store: AgentSessionStore;
  accountId: string;
  onSaved?: (saved: boolean) => void;
};

let scheduledAgentSessionWrite: ScheduledAgentSessionWrite | null = null;
let scheduledAgentSessionTimer: ReturnType<typeof setTimeout> | null = null;

// 记录最新待写状态并重置去抖窗口（trailing：以最后一次调度为准）。
export function scheduleAgentSessionWrite(
  store: AgentSessionStore,
  accountId: string,
  onSaved?: (saved: boolean) => void,
): void {
  scheduledAgentSessionWrite = { store, accountId, onSaved };
  if (scheduledAgentSessionTimer !== null)
    clearTimeout(scheduledAgentSessionTimer);
  scheduledAgentSessionTimer = setTimeout(() => {
    scheduledAgentSessionTimer = null;
    flushScheduledAgentSessionWrite();
  }, AGENT_SESSION_WRITE_DEBOUNCE_MS);
}

// 取消未触发的去抖定时器，并立即把最新待写状态交给 writeAgentSessions；
// 没有待写状态时是安全的空操作。
export function flushScheduledAgentSessionWrite(): void {
  if (scheduledAgentSessionTimer !== null) {
    clearTimeout(scheduledAgentSessionTimer);
    scheduledAgentSessionTimer = null;
  }
  const pending = scheduledAgentSessionWrite;
  if (!pending) return;
  scheduledAgentSessionWrite = null;
  void writeAgentSessions(pending.store, pending.accountId).then((saved) => {
    pending.onSaved?.(saved);
  });
}

export type AgentSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AgentMessage[];
};

export type AgentSessionStore = {
  activeId: string;
  sessions: AgentSession[];
};

const storageKey = (accountId: string) =>
  `resume-diy-agent-sessions-v2:${accountId}`;
const nativeStores = new Map<string, { revision: number; store: AgentSessionStore }>();
let sessionWrites: Promise<void> = Promise.resolve();

export function newAgentSession(): AgentSession {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function readBrowserAgentSessions(
  accountId?: string | null,
): AgentSessionStore {
  try {
    const parsed = JSON.parse(
      accountId
        ? (localStorage.getItem(storageKey(accountId)) ?? "null")
        : "null",
    );
    if (Array.isArray(parsed?.sessions)) {
      const sessions = parsed.sessions
        .filter((item: unknown): item is AgentSession =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as AgentSession).id === "string" &&
            typeof (item as AgentSession).title === "string" &&
            Array.isArray((item as AgentSession).messages),
          ),
        )
        .map((item: AgentSession) => ({
          ...item,
          messages: item.messages.filter(
            (message) =>
              message &&
              typeof message.id === "string" &&
              typeof message.text === "string" &&
              ["user", "assistant", "system"].includes(message.role),
          ),
        }));
      if (sessions.length) {
        return {
          activeId: sessions.some(
            (item: AgentSession) => item.id === parsed.activeId,
          )
            ? parsed.activeId
            : sessions[0].id,
          sessions,
        };
      }
    }
  } catch {
    // A damaged or unavailable browser cache starts a fresh local conversation.
  }
  const session = newAgentSession();
  return { activeId: session.id, sessions: [session] };
}

export function readAgentSessions(accountId?: string | null): AgentSessionStore {
  if (isTauriRuntime() && accountId && nativeStores.has(accountId))
    return nativeStores.get(accountId)!.store;
  return readBrowserAgentSessions(isTauriRuntime() ? null : accountId);
}

export async function loadAgentSessions(accountId: string): Promise<AgentSessionStore> {
  if (!isTauriRuntime()) return readBrowserAgentSessions(accountId);
  const legacy = readBrowserAgentSessions(accountId);
  const state = await nativeInvoke("bootstrap_agent_sessions", {
    legacyJson: JSON.stringify(legacy),
  }) as { revision: number; store: AgentSessionStore };
  nativeStores.set(accountId, state);
  return state.store;
}

export async function flushAgentSessionWrites(): Promise<void> {
  await sessionWrites;
}

export async function writeAgentSessions(
  store: AgentSessionStore,
  accountId?: string | null,
): Promise<boolean> {
  if (!accountId) return true;
  if (isTauriRuntime()) {
    if (!nativeStores.has(accountId)) return false;
    const payloadJson = JSON.stringify(store);
    const pending = sessionWrites.catch(() => undefined).then(async () => {
      const current = nativeStores.get(accountId);
      if (!current) throw new Error("Agent account changed");
      const revision = await nativeInvoke("replace_agent_sessions", {
        expectedRevision: current.revision,
        payloadJson,
      }) as number;
      nativeStores.set(accountId, { revision, store });
    });
    sessionWrites = pending;
    try {
      await pending;
      return true;
    } catch {
      return false;
    }
  }
  try {
    localStorage.setItem(storageKey(accountId), JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function appendSessionMessage(
  store: AgentSessionStore,
  sessionId: string,
  message: AgentMessage,
): AgentSessionStore {
  const now = Date.now();
  return {
    ...store,
    sessions: store.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      const firstPrompt =
        message.role === "user" &&
        !session.messages.some((item) => item.role === "user");
      return {
        ...session,
        title: firstPrompt
          ? message.text.replace(/\s+/g, " ").trim().slice(0, 36) || "新对话"
          : session.title,
        updatedAt: now,
        messages: [...session.messages, message],
      };
    }),
  };
}
