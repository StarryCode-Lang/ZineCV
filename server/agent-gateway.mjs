import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createLocalAgentAccounts } from "./local-agent-accounts.mjs";

const endpoint = "/api/agent/";
const allowedTools = new Set([
  "context_list_resources",
  "resume_read",
  "templates_list",
  "templates_read",
  "versions_list",
  "versions_read",
  "versions_diff",
  "ui_locate",
  "propose_resume_patch",
  "propose_resume_entry_delete",
  "propose_template_application",
  "propose_version_save",
]);
const localHosts = new Set(["127.0.0.1", "::1", "localhost"]);

function providerSignature(baseUrl, model, apiKey) {
  return createHash("sha256")
    .update(JSON.stringify([baseUrl, model, apiKey]))
    .digest("hex");
}

function parseAuthority(authority) {
  if (typeof authority !== "string") return null;
  try {
    const parsed = new URL(`http://${authority}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function isTrustedRequest(request) {
  const authority = parseAuthority(request.headers.host);
  if (!authority || !localHosts.has(authority.hostname.toLowerCase()))
    return false;
  const originHeader = request.headers.origin;
  if (originHeader === undefined) return true;
  if (typeof originHeader !== "string") return false;
  try {
    const origin = new URL(originHeader);
    return (
      origin.protocol === "http:" &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash &&
      origin.host.toLowerCase() === authority.host.toLowerCase()
    );
  } catch {
    return false;
  }
}

function ipv4Octets(address) {
  const octets = address.split(".").map(Number);
  return octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function isPrivateIpv4(address) {
  const octets = ipv4Octets(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Words(address) {
  let normalized = address;
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = ipv4Octets(dotted[1]);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, -dotted[1].length)}${high}:${low}`;
  }
  if (normalized.includes(":::")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (
    (halves.length === 2 && omitted < 1) ||
    left.length + right.length + omitted !== 8
  )
    return null;
  const words = [...left, ...Array(omitted).fill("0"), ...right].map((part) =>
    /^[\da-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : Number.NaN,
  );
  return words.every(Number.isInteger) ? words : null;
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized.includes(":")) return isPrivateIpv4(normalized);
  const words = ipv6Words(normalized);
  if (!words) return true;
  const ipv4Mapped =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const ipv4Compatible = words.slice(0, 6).every((word) => word === 0);
  if (ipv4Mapped || ipv4Compatible) {
    const octets = [
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff,
    ];
    return isPrivateIpv4(octets.join("."));
  }
  return (
    words.slice(0, 7).every((word) => word === 0) ||
    (words[0] & 0xfe00) === 0xfc00 ||
    (words[0] & 0xffc0) === 0xfe80 ||
    (words[0] & 0xff00) === 0xff00 ||
    (words[0] === 0x2001 && words[1] === 0x0db8)
  );
}

function isProxyMappedAddress(address) {
  const octets = ipv4Octets(address);
  return Boolean(
    octets && octets[0] === 198 && (octets[1] === 18 || octets[1] === 19),
  );
}

async function validateProviderUrl(value, lookupImpl = lookup) {
  if (typeof value !== "string" || value.length > 512)
    throw new Error("Base URL 无效");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入有效的 Base URL");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("Base URL 不支持凭据、查询参数或此协议");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLocal = localHosts.has(hostname);
  if (url.protocol !== "https:" && !isLocal)
    throw new Error("远程模型服务必须使用 HTTPS；HTTP 仅允许本机回环地址");
  if (isIP(hostname)) {
    if (!isLocal && isPrivateAddress(hostname))
      throw new Error("Base URL 指向受保护的本地或私有网络地址");
  } else if (!isLocal) {
    let addresses;
    try {
      addresses = await lookupImpl(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("Base URL 主机名无法解析");
    }
    if (
      !addresses.length ||
      addresses.some(
        ({ address }) =>
          isPrivateAddress(address) &&
          !(
            hostname === "openrouter.ai" &&
            url.protocol === "https:" &&
            isProxyMappedAddress(address)
          ),
      )
    )
      throw new Error("Base URL 主机名解析到了受保护的本地或私有网络地址");
  }
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/(?:chat\/completions|models)$/i, "");
  return url.toString().replace(/\/$/, "");
}

async function readJson(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求超过大小限制");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求格式无效");
  }
}

function validateMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 40)
    throw new Error("对话消息数量超出限制");
  let total = 0;
  const messages = value.map((message) => {
    if (
      !message ||
      !["system", "user", "assistant", "tool"].includes(message.role) ||
      typeof message.content !== "string"
    )
      throw new Error("对话消息结构无效");
    total += message.content.length;
    if (message.content.length > 20_000) throw new Error("单条消息过长");
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      if (message.tool_calls.length > 4)
        throw new Error("工具调用数量超出限制");
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.tool_calls.map((call) => ({
          id: String(call.id ?? "").slice(0, 128),
          type: "function",
          function: {
            name: String(call.function?.name ?? "").slice(0, 80),
            arguments: String(call.function?.arguments ?? "").slice(0, 6000),
          },
        })),
      };
    }
    if (message.role === "tool")
      return {
        role: "tool",
        tool_call_id: String(message.tool_call_id ?? "").slice(0, 128),
        content: message.content,
      };
    return { role: message.role, content: message.content };
  });
  if (total > 48_000) throw new Error("本轮上下文超过本地网关限制");
  return messages;
}

function validateTools(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > allowedTools.size)
    throw new Error("项目工具数量超出限制");
  const tools = value.map((tool) => {
    const fn = tool?.function;
    if (
      tool?.type !== "function" ||
      !allowedTools.has(fn?.name) ||
      typeof fn?.description !== "string" ||
      !fn.parameters ||
      fn.parameters.type !== "object"
    )
      throw new Error("请求包含未注册的项目工具");
    const serialized = JSON.stringify(fn.parameters);
    if (serialized.length > 8_000) throw new Error("项目工具参数定义过长");
    return {
      type: "function",
      function: {
        name: fn.name,
        description: fn.description.slice(0, 1200),
        parameters: fn.parameters,
        ...(fn.strict === true ? { strict: true } : {}),
      },
    };
  });
  return tools;
}

async function callProvider(provider, body, fetchImpl, signal) {
  const timeout = AbortSignal.timeout(45_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: requestSignal,
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey
          ? { Authorization: `Bearer ${provider.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages: body.messages,
        ...(body.tools?.length
          ? { tools: body.tools, tool_choice: "auto" }
          : {}),
        temperature: 0.25,
        max_tokens: body.maxTokens,
        stream: false,
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError")
      throw error;
    throw new Error("无法连接模型服务；请检查地址、网络和 TLS 设置");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error("模型服务拒绝了凭据，请核对 API Key");
    if (response.status === 429)
      throw new Error("模型服务当前限流，请稍后重试");
    throw new Error(`模型服务返回 HTTP ${response.status}`);
  }
  let result;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty response");
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > 1024 * 1024) {
        await reader.cancel();
        throw new Error("模型服务响应超过 1 MB 限制");
      }
      chunks.push(value);
    }
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("超过 1 MB"))
      throw error;
    throw new Error("模型服务返回了无效的 JSON");
  }
  const message = result?.choices?.[0]?.message;
  if (result?.choices?.[0]?.finish_reason === "length")
    throw new Error("模型输出达到长度上限，工具调用未执行；请缩小请求范围");
  if (
    !message ||
    (typeof message.content !== "string" && !Array.isArray(message.tool_calls))
  )
    throw new Error("模型服务没有返回可用的消息或工具调用");
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 4)
    throw new Error("模型工具调用数量超出限制");
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => ({
        id: String(call.id ?? randomUUID()).slice(0, 128),
        name: String(call.function?.name ?? "").slice(0, 80),
        arguments: String(call.function?.arguments ?? "").slice(0, 6000),
      }))
    : [];
  return {
    content:
      typeof message.content === "string"
        ? message.content.slice(0, 24_000)
        : "",
    toolCalls,
    finishReason: String(result?.choices?.[0]?.finish_reason ?? "stop").slice(
      0,
      40,
    ),
  };
}

async function streamProvider(provider, body, fetchImpl, signal, emit) {
  let response;
  try {
    response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages: body.messages,
        ...(body.tools?.length
          ? { tools: body.tools, tool_choice: "auto" }
          : {}),
        temperature: 0.25,
        max_tokens: body.maxTokens,
        stream: true,
      }),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError")
      throw error;
    throw new Error("无法连接模型服务；请检查地址、网络和 TLS 设置");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error("模型服务拒绝了凭据，请核对 API Key");
    if (response.status === 429)
      throw new Error("模型服务当前限流，请稍后重试");
    throw new Error(`模型服务返回 HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("模型服务没有返回流式内容");
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let received = 0;
  let content = "";
  let finishReason = "";
  let completed = false;
  const calls = new Map();
  const consume = (frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      completed = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new Error("模型服务返回了无效的流式 JSON");
    }
    if (chunk.error) throw new Error("模型服务在生成过程中返回错误");
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (typeof delta?.content === "string" && delta.content) {
      content += delta.content;
      if (content.length > 24_000) throw new Error("模型输出超过 24k 字符限制");
      emit(delta.content);
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const part of delta.tool_calls) {
        if (!Number.isInteger(part.index) || part.index < 0 || part.index > 3)
          throw new Error("模型工具调用索引无效");
        const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
        if (typeof part.id === "string") call.id += part.id;
        if (typeof part.function?.name === "string") call.name += part.function.name;
        if (typeof part.function?.arguments === "string")
          call.arguments += part.function.arguments;
        if (call.id.length > 128 || call.name.length > 80 || call.arguments.length > 6000)
          throw new Error("模型工具调用超过大小限制");
        calls.set(part.index, call);
      }
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > 1024 * 1024) throw new Error("模型服务响应超过 1 MB 限制");
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
  if (!completed && !finishReason)
    throw new Error("模型流式响应提前中断，内容未完成");
  if (finishReason === "length")
    throw new Error("模型输出达到长度上限，工具调用未执行；请缩小请求范围");
  const toolCalls = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({
      id: call.id || randomUUID(),
      name: call.name,
      arguments: call.arguments,
    }));
  if (!content && !toolCalls.length)
    throw new Error("模型服务没有返回可用的消息或工具调用");
  return { content, toolCalls, finishReason: finishReason || "stop" };
}

async function discoverModels(baseUrl, apiKey, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new Error("获取模型列表超时");
    throw new Error("无法获取模型列表；请检查 Base URL 和网络连接");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new Error("模型服务拒绝了 API Key");
    if (response.status === 404)
      throw new Error("该服务未提供 /models 列表接口，请手动填写模型 ID");
    throw new Error(`获取模型列表失败：HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("模型列表响应为空");
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > 4 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("模型列表超过 4 MB 限制");
    }
    chunks.push(value);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data;
  } catch {
    throw new Error("模型服务返回了无效的列表 JSON");
  }
  if (!Array.isArray(data) || data.length > 5000)
    throw new Error("模型服务返回了无效或过大的模型列表");
  const seen = new Set();
  const models = [];
  for (const item of data) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || id.length > 128 || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: typeof item.name === "string" ? item.name.slice(0, 160) : id,
    });
  }
  return { baseUrl, count: models.length, models };
}

export function agentGatewayPlugin({
  fetchImpl = fetch,
  lookupImpl = lookup,
  requireAuth = true,
  authDirectory,
} = {}) {
  let guestProvider = null;
  const testedConnections = new Map();
  const activeRuns = new Map();
  const accounts = createLocalAgentAccounts(authDirectory);
  const sessionToken = randomUUID();
  const configure = (server) => {
    server.middlewares.use(endpoint, async (request, response) => {
      const send = (status, value, headers = {}) => {
        response.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...headers,
        });
        response.end(JSON.stringify(value));
      };
      try {
        if (!isTrustedRequest(request))
          return send(403, { error: "请求来源不匹配" });
        const route = request.url?.split("?")[0] ?? "";
        if (route.endsWith("/auth/session")) {
          if (request.method !== "GET") return send(405, { error: "不支持的操作" });
          const account = requireAuth ? await accounts.session(request) : null;
          return send(200, { authenticated: Boolean(account), account: account ? { id: account.id, email: account.email } : null });
        }
        if (route.endsWith("/auth/register") || route.endsWith("/auth/login")) {
          if (request.method !== "POST") return send(405, { error: "不支持的操作" });
          const body = await readJson(request, 4096);
          const result = route.endsWith("/register")
            ? await accounts.register(body.email, body.password)
            : await accounts.login(body.email, body.password);
          return send(200, { authenticated: true, account: result.account }, { "Set-Cookie": accounts.cookie(result.token) });
        }
        if (route.endsWith("/auth/logout")) {
          if (request.method !== "POST") return send(405, { error: "不支持的操作" });
          await accounts.logout(request);
          return send(200, { authenticated: false, account: null }, { "Set-Cookie": accounts.clearCookie });
        }
        const account = requireAuth ? await accounts.session(request) : null;
        const accountKey = account?.id ?? "guest";
        let provider = account ? account.provider : guestProvider;
        let testedConnection = testedConnections.get(accountKey) ?? null;
        const activeRun = activeRuns.get(accountKey) ?? null;
        if (request.method === "GET")
          return send(200, {
            configured: Boolean(account || !requireAuth) && Boolean(provider),
            authRequired: requireAuth,
            account: account ? { id: account.id, email: account.email } : null,
            sessionToken,
            provider: provider
              ? {
                  name: provider.name,
                  baseUrl: provider.baseUrl,
                  model: provider.model,
                  hasApiKey: Boolean(provider.apiKey),
                  capability: provider.capability,
                }
              : null,
            keyStorage: requireAuth ? "local-account" : "memory-only",
          });
        if (request.method !== "POST")
          return send(405, { error: "不支持的操作" });
        if (requireAuth && !account) return send(401, { error: "请先登录本机账户" });
        if (request.headers["x-agent-session"] !== sessionToken)
          return send(403, { error: "本机会话令牌无效" });
        if (route.endsWith("/clear")) {
          if (account) await accounts.setProvider(account.id, null);
          else guestProvider = null;
          testedConnections.delete(accountKey);
          return send(200, { configured: false });
        }
        const body = await readJson(request);
        if (route.endsWith("/models")) {
          const baseUrl = await validateProviderUrl(body.baseUrl, lookupImpl);
          const enteredKey =
            typeof body.apiKey === "string" ? body.apiKey.trim() : "";
          if (enteredKey.length > 4096)
            return send(400, { error: "API Key 过长" });
          const apiKey =
            enteredKey ||
            (provider?.baseUrl === baseUrl ? provider.apiKey : "");
          const hostname = new URL(baseUrl).hostname
            .replace(/^\[|\]$/g, "")
            .toLowerCase();
          if (!apiKey && !localHosts.has(hostname))
            return send(400, { error: "远程模型服务需要 API Key" });
          return send(200, await discoverModels(baseUrl, apiKey, fetchImpl));
        }
        if (route.endsWith("/test") || route.endsWith("/config/test")) {
          const baseUrl = await validateProviderUrl(body.baseUrl, lookupImpl);
          const model = typeof body.model === "string" ? body.model.trim() : "";
          const enteredKey =
            typeof body.apiKey === "string" ? body.apiKey.trim() : "";
          const apiKey =
            enteredKey ||
            (provider?.baseUrl === baseUrl ? provider.apiKey : "");
          if (!model || model.length > 128)
            return send(400, { error: "请填写有效的模型 ID" });
          if (
            !apiKey &&
            !localHosts.has(
              new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase(),
            )
          )
            return send(400, { error: "远程模型服务需要 API Key" });
          const result = await callProvider(
            { baseUrl, model, apiKey },
            {
              messages: [
                { role: "system", content: "Reply with exactly OK." },
                { role: "user", content: "OK" },
              ],
              maxTokens: 16,
            },
            fetchImpl,
          );
          let structuredOutput = false;
          try {
            const probe = await callProvider(
              { baseUrl, model, apiKey },
              {
                messages: [
                  {
                    role: "system",
                    content: "Call the available function once with ok=true.",
                  },
                  {
                    role: "user",
                    content: "Run the harmless structure check.",
                  },
                ],
                tools: [
                  {
                    type: "function",
                    function: {
                      name: "agent_capability_probe",
                      description: "A no-op structure capability probe.",
                      parameters: {
                        type: "object",
                        properties: { ok: { type: "boolean" } },
                        required: ["ok"],
                        additionalProperties: false,
                      },
                    },
                  },
                ],
                maxTokens: 32,
              },
              fetchImpl,
            );
            structuredOutput = probe.toolCalls.some((toolCall) => {
              if (toolCall.name !== "agent_capability_probe") return false;
              try {
                return JSON.parse(toolCall.arguments).ok === true;
              } catch {
                return false;
              }
            });
          } catch {
            structuredOutput = false;
          }
          const success =
            Boolean(result.content.trim()) && result.toolCalls.length === 0;
          testedConnection = success
            ? {
                signature: providerSignature(baseUrl, model, apiKey),
                structuredOutput,
              }
            : null;
          if (testedConnection) testedConnections.set(accountKey, testedConnection);
          else testedConnections.delete(accountKey);
          return send(200, {
            success,
            structuredOutput,
            model,
          });
        }
        if (route.endsWith("/config")) {
          const baseUrl = await validateProviderUrl(body.baseUrl, lookupImpl);
          const model = typeof body.model === "string" ? body.model.trim() : "";
          const enteredKey =
            typeof body.apiKey === "string" ? body.apiKey.trim() : "";
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name || name.length > 80)
            return send(400, { error: "连接名称长度需为 1–80 个字符" });
          if (!model || model.length > 128)
            return send(400, { error: "模型 ID 长度需为 1–128 个字符" });
          if (enteredKey.length > 4096)
            return send(400, { error: "API Key 过长" });
          const hostname = new URL(baseUrl).hostname
            .replace(/^\[|\]$/g, "")
            .toLowerCase();
          const apiKey =
            enteredKey ||
            (provider?.baseUrl === baseUrl ? provider.apiKey : "");
          if (!apiKey && !localHosts.has(hostname))
            return send(400, { error: "远程模型服务需要 API Key" });
          provider = {
            name,
            baseUrl,
            model,
            apiKey:
              apiKey || (provider?.baseUrl === baseUrl ? provider.apiKey : ""),
            capability:
              testedConnection?.signature ===
                providerSignature(baseUrl, model, apiKey) &&
              testedConnection.structuredOutput
                ? "structured"
                : "chat",
          };
          if (account) await accounts.setProvider(account.id, provider);
          else guestProvider = provider;
          return send(200, {
            configured: true,
            authRequired: requireAuth,
            account: account ? { id: account.id, email: account.email } : null,
            provider: {
              name,
              baseUrl,
              model,
              hasApiKey: Boolean(apiKey),
              capability: provider.capability,
            },
            keyStorage: requireAuth ? "local-account" : "memory-only",
          });
        }
        const wantsStream = route.endsWith("/chat/stream");
        if (!route.endsWith("/chat") && !wantsStream)
          return send(404, { error: "Agent 路由不存在" });
        if (!provider) return send(409, { error: "尚未配置模型连接" });
        if (activeRun) return send(429, { error: "当前会话已有请求运行中" });
        const messages = validateMessages(body.messages);
        const tools = validateTools(body.tools);
        if (tools?.length && provider.capability !== "structured")
          return send(409, {
            error:
              "该连接仅验证了普通聊天；请先对当前设置完成结构化工具能力测试",
          });
        const maxTokens = Number.isInteger(body.maxTokens)
          ? Math.min(2048, Math.max(128, body.maxTokens))
          : 1200;
        const runId = randomUUID();
        const controller = new AbortController();
        const runProvider = provider;
        activeRuns.set(accountKey, { runId, controller });
        request.once("aborted", () => controller.abort());
        try {
          if (wantsStream) {
            response.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            });
            response.on("close", () => controller.abort());
            const writeEvent = (value) => {
              if (!response.destroyed)
                response.write(`data: ${JSON.stringify(value)}\n\n`);
            };
            try {
              const result = await streamProvider(
                runProvider,
                { messages, tools, maxTokens },
                fetchImpl,
                controller.signal,
                (text) => writeEvent({ type: "delta", text }),
              );
              writeEvent({ type: "done", runId, model: runProvider.model, ...result });
            } catch (error) {
              writeEvent({
                type: "error",
                error: error instanceof Error ? error.message : "模型流式请求失败",
              });
            }
            response.end();
          } else {
            const result = await callProvider(
              runProvider,
              { messages, tools, maxTokens },
              fetchImpl,
              controller.signal,
            );
            if (!response.destroyed)
              send(200, { runId, model: runProvider.model, ...result });
          }
        } finally {
          if (activeRuns.get(accountKey)?.runId === runId) activeRuns.delete(accountKey);
        }
      } catch (error) {
        const status = error?.name === "AbortError" ? 499 : 400;
        if (!response.destroyed && !response.headersSent)
          send(status, {
            error:
              error?.name === "AbortError"
                ? "请求已停止"
                : error instanceof Error
                  ? error.message
                  : "Agent 请求失败",
          });
      }
    });
  };
  return {
    name: "resume-agent-gateway",
    configureServer: configure,
    configurePreviewServer: configure,
  };
}
