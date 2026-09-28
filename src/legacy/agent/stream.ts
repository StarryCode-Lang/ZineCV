import type { RuntimeMessage, RuntimeReply } from "./runtime";

export async function invokeAgentStream({
  messages,
  tools,
  sessionToken,
  signal,
  onDelta,
}: {
  messages: RuntimeMessage[];
  tools: unknown[];
  sessionToken: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}): Promise<RuntimeReply> {
  const response = await fetch("/api/agent/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Session": sessionToken,
    },
    signal,
    body: JSON.stringify({ messages, tools, maxTokens: 1400 }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new Error(
      typeof value?.error === "string" ? value.error : "Agent 请求失败",
    );
  }
  if (!response.body) throw new Error("本机网关没有返回流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let received = 0;
  let result: RuntimeReply | null = null;
  const consume = (frame: string) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let event: {
      type?: string;
      text?: string;
      error?: string;
      content?: string;
      model?: string;
      toolCalls?: RuntimeReply["toolCalls"];
    };
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error("本机网关返回了无效的流式事件");
    }
    if (event.type === "error")
      throw new Error(event.error || "模型流式请求失败");
    if (event.type === "delta" && typeof event.text === "string")
      onDelta(event.text);
    if (event.type === "done")
      result = {
        content: typeof event.content === "string" ? event.content : "",
        model: event.model,
        toolCalls: Array.isArray(event.toolCalls) ? event.toolCalls : [],
      };
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > 2 * 1024 * 1024)
        throw new Error("本机网关流式响应超过大小限制");
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        consume(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }
  if (!result) throw new Error("模型流式响应提前中断，内容未完成");
  return result;
}
