import type { AgentMessage } from "./types";

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

export function readAgentSessions(
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

export function writeAgentSessions(
  store: AgentSessionStore,
  accountId?: string | null,
): boolean {
  if (!accountId) return true;
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
