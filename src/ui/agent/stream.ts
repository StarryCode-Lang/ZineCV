import type { RuntimeReply } from "./runtime";
import { isTauriRuntime, nativeInvoke } from "../../platform/ipc";
import { Channel } from "@tauri-apps/api/core";
import type { AuthorityCursor } from "../../../src-tauri/src/domain/bindings/AuthorityCursor";
import { flushAgentSessionWrites } from "./sessions";

export async function invokeAgentStream({
  sessionId,
  targetCursor,
  referenceIds,
  userText,
  skillId,
  signal,
  onDelta,
}: {
  sessionId: string;
  targetCursor: AuthorityCursor | null;
  referenceIds: string[];
  userText: string;
  skillId: string | null;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}): Promise<RuntimeReply> {
  if (!isTauriRuntime())
    throw new Error("模型连接仅在桌面应用中可用");
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (!targetCursor) throw new Error("权威文档尚未加载");
  const runId = crypto.randomUUID();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await flushAgentSessionWrites();
  const channel = new Channel<{
    runId: string;
    seq: number;
    epoch: number;
    kind: string;
    text: string | null;
  }>();
  let lastSeq = 0;
  let eventEpoch: number | null = null;
  channel.onmessage = (event) => {
    if (
      signal.aborted ||
      event.runId !== runId ||
      !Number.isSafeInteger(event.seq) ||
      event.seq <= lastSeq ||
      !Number.isSafeInteger(event.epoch) ||
      (eventEpoch !== null && event.epoch !== eventEpoch)
    )
      return;
    lastSeq = event.seq;
    eventEpoch ??= event.epoch;
    if (event.kind === "delta" && typeof event.text === "string")
      onDelta(event.text);
  };
  const cancel = () => { void nativeInvoke("cancel_agent_run", { runId }).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const reply = await nativeInvoke("agent_chat", {
      runId,
      sessionId,
      targetCursor,
      referenceIds,
      userText,
      skillId,
      onEvent: channel,
    }) as RuntimeReply;
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return reply;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
