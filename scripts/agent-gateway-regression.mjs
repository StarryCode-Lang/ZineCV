import assert from "node:assert/strict";
import http from "node:http";
import { agentGatewayPlugin } from "../server/agent-gateway.mjs";

const providerCalls = [];
const providerKey = "process-memory-test-key";
let releaseDelayedProvider = null;

function modelResponse(message, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      choices: [{ message, finish_reason: finishReason }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const plugin = agentGatewayPlugin({
  requireAuth: false,
  lookupImpl: async () => [{ address: "198.18.0.22", family: 4 }],
  fetchImpl: async (url, init) => {
    if (init.method === "GET") {
      providerCalls.push({
        url,
        authorization: init.headers.Authorization,
        method: "GET",
      });
      return new Response(
        JSON.stringify({
          data: [
            { id: "qwen/qwen3.8-27b:free", name: "Qwen 3.8" },
            { id: "openai/gpt-example", name: "GPT Example" },
            { id: "qwen/qwen3.8-27b:free", name: "Duplicate" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const payload = JSON.parse(init.body);
    if (payload.messages?.some((message) => message.content === "delayed-chat"))
      await new Promise((resolve) => {
        releaseDelayedProvider = resolve;
      });
    providerCalls.push({
      url,
      authorization: init.headers.Authorization,
      payload,
    });
    if (payload.stream) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"逐步"}}]}\n\n',
              ),
            );
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"content":"输出"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                ),
              );
              controller.close();
            }, 120);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (
      payload.messages?.some((message) => message.content === "truncated-tool")
    )
      return modelResponse(
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "partial",
              type: "function",
              function: {
                name: "propose_resume_patch",
                arguments: '{"target":',
              },
            },
          ],
        },
        "length",
      );
    const probe = payload.tools?.[0]?.function?.name;
    if (probe === "agent_capability_probe")
      return modelResponse(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "probe-call",
              type: "function",
              function: {
                name: "agent_capability_probe",
                arguments: '{"ok":true}',
              },
            },
          ],
        },
        "tool_calls",
      );
    if (probe === "propose_resume_patch")
      return modelResponse(
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "proposal-call",
              type: "function",
              function: {
                name: probe,
                arguments:
                  '{"target":{"kind":"summary"},"patch":{"text":"edited"}}',
              },
            },
          ],
        },
        "tool_calls",
      );
    if (
      payload.messages?.some(
        (message) => message.content === "oversized-provider",
      )
    )
      return modelResponse({
        role: "assistant",
        content: "x".repeat(1024 * 1024),
      });
    return modelResponse({ role: "assistant", content: "OK" });
  },
});

let handler;
plugin.configureServer({
  middlewares: {
    use(_mountPath, middleware) {
      handler = middleware;
    },
  },
});

const server = http.createServer((request, response) =>
  handler(request, response),
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let sessionToken = "";

async function request(
  route,
  { body, origin = new URL(baseUrl).origin, token = sessionToken } = {},
) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (body !== undefined && token) headers["X-Agent-Session"] = token;
  const response = await fetch(`${baseUrl}/api/agent/${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (typeof result.sessionToken === "string")
    sessionToken = result.sessionToken;
  return { status: response.status, result };
}

try {
  const initial = await request("config");
  assert.equal(initial.status, 200);
  assert.equal(initial.result.configured, false);

  const originRejected = await request("config", {
    origin: "http://attacker.example",
  });
  assert.equal(originRejected.status, 403);
  const tokenRejected = await request("config", {
    body: {
      name: "No token",
      baseUrl: "http://127.0.0.1/v1",
      model: "test-model",
    },
    token: "",
  });
  assert.equal(tokenRejected.status, 403);

  const connectionTest = await request("test", {
    body: {
      name: "Test provider",
      baseUrl: "http://127.0.0.1/v1",
      model: "test-model",
      apiKey: providerKey,
    },
  });
  assert.deepEqual(connectionTest, {
    status: 200,
    result: {
      success: true,
      structuredOutput: true,
      model: "test-model",
    },
  });
  assert.equal(
    providerCalls.length,
    2,
    "test should probe plain and structured output",
  );
  assert.equal(providerCalls[0].authorization, `Bearer ${providerKey}`);
  assert.equal((await request("config")).result.configured, false);

  for (const baseUrl of [
    "https://192.168.1.25/v1",
    "https://[::ffff:ac10:1]/v1",
  ]) {
    const privateEndpoint = await request("config", {
      body: {
        name: "Private endpoint",
        baseUrl,
        model: "test-model",
        apiKey: providerKey,
      },
    });
    assert.equal(privateEndpoint.status, 400);
  }
  assert.equal(
    providerCalls.length,
    2,
    "private endpoint reached the provider",
  );

  const configured = await request("config", {
    body: {
      name: "Local Harness Test",
      baseUrl: "http://127.0.0.1/v1",
      model: "test-model",
      apiKey: providerKey,
    },
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.result.provider.hasApiKey, true);
  assert.equal(configured.result.provider.capability, "structured");
  assert.equal(configured.result.keyStorage, "memory-only");
  assert.equal(JSON.stringify(configured.result).includes(providerKey), false);

  const allowedTool = {
    type: "function",
    function: {
      name: "propose_resume_patch",
      description: "Propose a selected resume edit for review.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  };
  const chat = await request("chat", {
    body: {
      messages: [
        { role: "system", content: "Use only the selected context." },
        { role: "user", content: "Please review my selected summary." },
      ],
      tools: [allowedTool],
      maxTokens: 256,
    },
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.result.toolCalls[0].name, "propose_resume_patch");
  assert.equal(providerCalls.at(-1).authorization, `Bearer ${providerKey}`);

  const streamResponse = await fetch(`${baseUrl}/api/agent/chat/stream`, {
    method: "POST",
    headers: {
      Origin: new URL(baseUrl).origin,
      "Content-Type": "application/json",
      "X-Agent-Session": sessionToken,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "stream fixture" }],
    }),
  });
  assert.equal(streamResponse.status, 200);
  const streamReader = streamResponse.body.getReader();
  const firstChunk = new TextDecoder().decode((await streamReader.read()).value);
  assert.match(firstChunk, /逐步/);
  assert.doesNotMatch(firstChunk, /"type":"done"/);
  let streamTail = "";
  while (true) {
    const { done, value } = await streamReader.read();
    if (done) break;
    streamTail += new TextDecoder().decode(value);
  }
  assert.match(streamTail, /输出/);
  assert.match(streamTail, /"type":"done"/);
  assert.equal(providerCalls.at(-1).payload.stream, true);

  const beforeRejectedTool = providerCalls.length;
  const rejectedTool = await request("chat", {
    body: {
      messages: [{ role: "user", content: "run a tool" }],
      tools: [
        {
          ...allowedTool,
          function: { ...allowedTool.function, name: "execute_shell" },
        },
      ],
    },
  });
  assert.equal(rejectedTool.status, 400);
  assert.equal(providerCalls.length, beforeRejectedTool);

  const oversizedContext = await request("chat", {
    body: {
      messages: [{ role: "user", content: "x".repeat(48_001) }],
    },
  });
  assert.equal(oversizedContext.status, 400);

  const oversizedProvider = await request("chat", {
    body: { messages: [{ role: "user", content: "oversized-provider" }] },
  });
  assert.equal(oversizedProvider.status, 400);
  assert.match(oversizedProvider.result.error, /超过 1 MB/);

  const truncatedTool = await request("chat", {
    body: {
      messages: [{ role: "user", content: "truncated-tool" }],
      tools: [allowedTool],
    },
  });
  assert.equal(truncatedTool.status, 400);
  assert.match(truncatedTool.result.error, /长度上限/);

  const changedModel = await request("config", {
    body: {
      name: "Untested model",
      baseUrl: "http://127.0.0.1/v1",
      model: "untested-model",
      apiKey: providerKey,
    },
  });
  assert.equal(changedModel.result.provider.capability, "chat");
  const blockedProposal = await request("chat", {
    body: {
      messages: [{ role: "user", content: "try proposal" }],
      tools: [allowedTool],
    },
  });
  assert.equal(blockedProposal.status, 409);
  const chatOnly = await request("chat", {
    body: { messages: [{ role: "user", content: "plain chat" }] },
  });
  assert.equal(chatOnly.status, 200);

  const delayedChat = request("chat", {
    body: { messages: [{ role: "user", content: "delayed-chat" }] },
  });
  for (let attempt = 0; attempt < 100 && !releaseDelayedProvider; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    releaseDelayedProvider,
    "the delayed provider request did not start",
  );
  const clearedDuringRun = await request("clear", { body: {} });
  assert.equal(clearedDuringRun.status, 200);
  releaseDelayedProvider();
  const completedRun = await delayedChat;
  assert.equal(completedRun.status, 200);
  assert.equal(completedRun.result.model, "untested-model");

  const cleared = await request("clear", { body: {} });
  assert.equal(cleared.status, 200);
  assert.equal((await request("config")).result.configured, false);
  const discovery = await request("models", {
    body: {
      baseUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: providerKey,
    },
  });
  assert.equal(discovery.status, 200);
  assert.equal(discovery.result.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(discovery.result.count, 2);
  assert.deepEqual(
    discovery.result.models.map((model) => model.id),
    ["qwen/qwen3.8-27b:free", "openai/gpt-example"],
  );
  assert.equal(providerCalls.at(-1).url, "https://openrouter.ai/api/v1/models");
  assert.equal(providerCalls.at(-1).authorization, `Bearer ${providerKey}`);
  assert.equal(JSON.stringify(discovery).includes(providerKey), false);
  const proxyAddressBlocked = await request("models", {
    body: { baseUrl: "https://198.18.0.22/api/v1", apiKey: providerKey },
  });
  assert.equal(proxyAddressBlocked.status, 400);
  const otherHostBlocked = await request("models", {
    body: { baseUrl: "https://other.example/v1", apiKey: providerKey },
  });
  assert.equal(otherHostBlocked.status, 400);
  assert.equal(
    JSON.stringify([
      initial,
      connectionTest,
      configured,
      chat,
      cleared,
    ]).includes(providerKey),
    false,
    "the API key was returned by the local gateway",
  );

  console.log(
    JSON.stringify({
      pass: true,
      checks: [
        "same-origin local gateway and process-memory provider config",
        "plain and structured-output model capability probe",
        "private network rejection and tool allowlist",
        "bounded request context and key-free responses",
        "oversized provider response is rejected before JSON parsing",
        "changed untested model is limited to chat until its tool capability is verified",
        "clearing settings during an active request preserves that run's model identity",
        "provider config clear",
        "OpenRouter proxy DNS exception is host-specific and model discovery normalizes endpoint URLs",
        "provider SSE chunks reach the local client before completion",
      ],
      providerCalls: providerCalls.length,
    }),
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
