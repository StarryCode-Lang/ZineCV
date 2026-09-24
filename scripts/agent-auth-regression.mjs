import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentGatewayPlugin } from "../server/agent-gateway.mjs";

const fixtureRoot = resolve(".artifacts/agent-auth");
await mkdir(fixtureRoot, { recursive: true });
const dataDirectory = await mkdtemp(join(fixtureRoot, "data-"));
const password = "local-fixture-password-123";

async function start() {
  let middleware;
  agentGatewayPlugin({ authDirectory: dataDirectory }).configureServer({
    middlewares: { use(_path, handler) { middleware = handler; } },
  });
  const server = http.createServer((request, response) => middleware(request, response));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}/api/agent/`;
  async function call(path, { body, cookie, token } = {}) {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: new URL(base).origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { "X-Agent-Session": token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  return { call, close: () => new Promise((done) => server.close(done)) };
}

let service = await start();
try {
  const guest = await service.call("config");
  assert.equal(guest.data.configured, false);
  assert.equal(guest.data.account, null);
  assert.equal((await service.call("config", { body: { name: "blocked" }, token: guest.data.sessionToken })).status, 401);

  const first = await service.call("auth/register", { body: { email: "First@example.com", password } });
  assert.equal(first.status, 200);
  assert.equal(first.data.account.email, "first@example.com");
  assert.ok(first.cookie?.startsWith("reme_agent_login="));
  const firstConfig = await service.call("config", { cookie: first.cookie });
  assert.equal(firstConfig.data.account.id, first.data.account.id);
  const saved = await service.call("config", {
    cookie: first.cookie,
    token: firstConfig.data.sessionToken,
    body: { name: "First provider", baseUrl: "http://127.0.0.1/v1", model: "model-one", apiKey: "account-one-secret" },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.provider.hasApiKey, true);
  assert.ok(!JSON.stringify(saved.data).includes("account-one-secret"));

  const second = await service.call("auth/register", { body: { email: "second@example.com", password } });
  assert.equal(second.status, 200);
  const secondConfig = await service.call("config", { cookie: second.cookie });
  assert.equal(secondConfig.data.configured, false);
  assert.equal(secondConfig.data.provider, null);
  assert.equal((await service.call("auth/login", { body: { email: "first@example.com", password: "wrong-password" } })).status, 400);
  const storage = await readFile(join(dataDirectory, "agent-accounts.json"), "utf8");
  assert.ok(storage.includes("account-one-secret"));
  assert.ok(!storage.includes(password));
  assert.ok(!storage.includes(first.cookie.split("=")[1]));

  await service.close();
  service = await start();
  const restored = await service.call("config", { cookie: first.cookie });
  assert.equal(restored.data.provider.model, "model-one");
  assert.equal(restored.data.account.email, "first@example.com");
  const logout = await service.call("auth/logout", { cookie: first.cookie, body: {} });
  assert.equal(logout.status, 200);
  assert.equal((await service.call("config", { cookie: first.cookie })).data.account, null);
  const relogin = await service.call("auth/login", { body: { email: "first@example.com", password } });
  assert.equal(relogin.status, 200);
  assert.equal((await service.call("config", { cookie: relogin.cookie })).data.provider.model, "model-one");
  console.log(JSON.stringify({ pass: true, checks: ["isolated local email accounts", "hashed passwords and opaque cookies", "per-account model persistence across server restart", "logout invalidates prior session", "unauthenticated model routes rejected"] }));
} finally {
  await service.close();
}
