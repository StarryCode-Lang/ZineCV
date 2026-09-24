export type RuntimeToolCall = { id: string; name: string; arguments: string };
export type RuntimeReply = {
  content: string;
  model?: string;
  toolCalls: RuntimeToolCall[];
};
export type RuntimeEvent = {
  runId: string;
  seq: number;
  type:
    | "run.started"
    | "message.delta"
    | "tool.started"
    | "tool.finished"
    | "proposal.ready"
    | "run.completed"
    | "run.failed"
    | "run.cancelled";
  detail?: string;
};
export type RuntimeToolResult =
  | { ok: true; data: unknown; truncated: false }
  | { ok: false; code: string; message: string };

export type RuntimeMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export async function runAgentTurns<T>({
  runId,
  messages,
  invoke,
  execute,
  signal,
  onEvent,
}: {
  runId: string;
  messages: RuntimeMessage[];
  invoke: (
    messages: RuntimeMessage[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
  ) => Promise<RuntimeReply>;
  execute: (call: RuntimeToolCall) => RuntimeToolResult & { proposal?: T };
  signal: AbortSignal;
  onEvent?: (event: RuntimeEvent) => void;
}) {
  let seq = 0;
  const emit = (type: RuntimeEvent["type"], detail?: string) =>
    onEvent?.({ runId, seq: ++seq, type, detail });
  const started = Date.now();
  const seen = new Set<string>();
  const proposals: T[] = [];
  const text: string[] = [];
  const transcript = [...messages];
  let toolCount = 0;
  let model = "";
  let invalidArguments = 0;
  emit("run.started");
  try {
    for (let turn = 0; turn < 6; turn += 1) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (Date.now() - started > 90_000) throw new Error("运行超过 90 秒上限");
      if (JSON.stringify(transcript).length > 48_000)
        throw new Error("本轮上下文已达到网关预算，请缩小引用范围后重试");
      let streamed = false;
      const reply = await invoke(transcript, signal, (delta) => {
        if (signal.aborted || !delta) return;
        if (!streamed && text.length) emit("message.delta", "\n\n");
        streamed = true;
        emit("message.delta", delta);
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      model = reply.model ?? model;
      if (!Array.isArray(reply.toolCalls) || reply.toolCalls.length > 4)
        throw new Error("模型工具调用数量无效");
      if (reply.content.trim()) {
        text.push(reply.content);
        if (!streamed) emit("message.delta", reply.content);
      }
      if (!reply.toolCalls.length) {
        emit("run.completed");
        return { text: text.join("\n\n"), proposals, model };
      }
      if (toolCount + reply.toolCalls.length > 12)
        throw new Error("本轮达到 12 次工具调用上限");
      const turnIds = new Set<string>();
      for (const call of reply.toolCalls) {
        if (
          !call ||
          typeof call.id !== "string" ||
          !call.id ||
          typeof call.name !== "string" ||
          typeof call.arguments !== "string" ||
          seen.has(call.id) ||
          turnIds.has(call.id)
        )
          throw new Error("模型返回重复或无效的工具调用 ID");
        turnIds.add(call.id);
      }
      toolCount += reply.toolCalls.length;
      transcript.push({
        role: "assistant",
        content: reply.content,
        tool_calls: reply.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of reply.toolCalls) {
        seen.add(call.id);
        emit("tool.started", call.name);
        const result = execute(call);
        if (!result.ok && result.code === "INVALID_ARGUMENT") {
          invalidArguments += 1;
          if (invalidArguments > 1)
            throw new Error("工具参数两次未通过校验，已停止本轮运行");
        }
        if (result.proposal) {
          proposals.push(result.proposal);
          emit("proposal.ready", call.name);
        }
        emit("tool.finished", call.name);
        transcript.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      if (proposals.length) {
        emit("run.completed");
        return { text: text.join("\n\n"), proposals, model };
      }
    }
    throw new Error("本轮达到 6 次模型调用上限");
  } catch (error) {
    emit(signal.aborted ? "run.cancelled" : "run.failed");
    throw error;
  }
}
