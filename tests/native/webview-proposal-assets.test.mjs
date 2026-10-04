import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidenceRoot = join(root, ".artifacts/remaining/R22/session3-assets");
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM90AAAAASUVORK5CYII=";

test("pending avatar proposal survives killed host without applying an asset", { timeout: 90_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-"));
  assert.ok(resolve(profile).startsWith(resolve(evidenceRoot) + sep));
  let assetId;
  const modelBodies = [];
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    modelBodies.push(payload);
    if (payload.tools?.some(({ function: fn }) => fn.name === "zinecv_capability_probe")) {
      const nonce = payload.tools[0].function.parameters.properties.nonce.enum[0];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "probe-avatar", type: "function", function: { name: "zinecv_capability_probe", arguments: JSON.stringify({ nonce }) } }] } }] }));
    } else {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      const delta = !payload.tools?.length ? { content: "OK" } : payload.messages.some((message) => message.role === "tool")
        ? { content: "合成图片建议已保存，等待确认" }
        : { tool_calls: [{ index: 0, id: "call-avatar", type: "function", function: { name: "propose_commands", arguments: JSON.stringify({ explanation: "合成头像更新", commands: [{ op: "set_avatar", referenceId: "basic:avatar", assetId }] }) } }] };
      response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise((done, reject) => model.once("error", reject).listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
  const report = { startedAt: new Date().toISOString(), fixture: "synthetic local HTTP model and isolated profile", hostPids: [] };
  let host;
  let passed = false;
  try {
    host = await startNativeHost(profile);
    report.hostPids.push(host.child.pid);
    await host.page.evaluate(() => {
      const internals = window.__TAURI_INTERNALS__;
      const original = internals.invoke.bind(internals);
      internals.invoke = async (command, ...args) => {
        try { return await original(command, ...args); }
        catch (error) { throw new Error(`${command}: ${JSON.stringify(error)}`); }
      };
    });
    assetId = await host.page.evaluate(async ({ baseUrl, image }) => {
      const invoke = async (command, args) => { try { return await window.__TAURI_INTERNALS__.invoke(command, args); } catch (error) { throw new Error(`${command}: ${JSON.stringify(error)}`); } };
      await invoke("register_account", { email: "asset-fixture@example.com", password: "fixture-password" });
      await invoke("login_account", { email: "asset-fixture@example.com", password: "fixture-password" });
      await invoke("store_provider_key", { name: "Synthetic asset model", baseUrl, model: "fixture-model", key: "synthetic-model-key" });
      await invoke("provider_test", { baseUrl, model: "fixture-model", key: "" });
      const state = await invoke("bootstrap_agent_sessions", { legacyJson: JSON.stringify({ activeId: "asset-session", sessions: [{ id: "asset-session", title: "合成头像会话", createdAt: 1000, updatedAt: 1000, messages: [{ id: "asset-user-message", role: "user", text: "请为已选头像创建合成资源更新提议" }] }] }) });
      if (!state.store.sessions.some((session) => session.id === "asset-session")) throw new Error("Synthetic session not initialized");
      const document = await invoke("document_state");
      const asset = await invoke("store_avatar_asset", { cursor: document.cursor, dataUrl: image, previousHash: null });
      return asset.hash;
    }, { baseUrl, image });
    assert.match(assetId, /^[a-f0-9]{64}$/);
    const before = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    await host.page.evaluate(async () => {
      const internals = window.__TAURI_INTERNALS__;
      const state = await internals.invoke("document_state");
      const callback = internals.transformCallback(() => {});
      try {
        await internals.invoke("agent_chat", { runId: "asset-run-fixture", sessionId: "asset-session", targetCursor: state.cursor,
          referenceIds: ["basic:avatar"], userText: "请为已选头像创建合成资源更新提议", skillId: null, onEvent: `__CHANNEL__:${callback}` });
      } catch (error) { throw new Error(`agent_chat: ${JSON.stringify(error)}`); }
    });
    const pending = await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_proposals"));
    assert.equal(pending.pending.length, 1);
    assert.equal(pending.pending[0].items[0].afterValue.avatarAssetId, assetId);
    assert.equal((await host.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"))).document.basic.avatarAssetId, before.document.basic.avatarAssetId);
    report.pendingId = pending.pending[0].id;
    report.assetSha256 = assetId;
    await stopNativeHost(host);
    host = undefined;
    host = await startNativeHost(profile);
    report.hostPids.push(host.child.pid);
    assert.notEqual(report.hostPids[0], report.hostPids[1]);
    report.restored = await host.page.evaluate(async ({ proposalId, assetId }) => {
      const invoke = async (command, args) => { try { return await window.__TAURI_INTERNALS__.invoke(command, args); } catch (error) { throw new Error(`${command}: ${JSON.stringify(error)}`); } };
      await invoke("login_account", { email: "asset-fixture@example.com", password: "fixture-password" });
      const inbox = await invoke("list_agent_proposals");
      const document = await invoke("document_state");
      const asset = await invoke("read_avatar_asset", { hash: assetId });
      await invoke("reject_proposal", { request: { commandId: "asset-restart-cancel", proposalId } });
      return { pendingIds: inbox.pending.map((proposal) => proposal.id), avatarAssetId: document.document.basic.avatarAssetId, assetDataSha256Input: asset.dataUrl };
    }, { proposalId: report.pendingId, assetId });
    assert.deepEqual(report.restored.pendingIds, [report.pendingId]);
    assert.equal(report.restored.avatarAssetId, before.document.basic.avatarAssetId);
    assert.equal(report.restored.assetDataSha256Input, image);
    report.restored.assetDataSha256 = createHash("sha256").update(report.restored.assetDataSha256Input).digest("hex");
    delete report.restored.assetDataSha256Input;
    report.modelCalls = modelBodies.length;
    report.status = "passed";
    passed = true;
  } catch (error) { report.status = "failed"; report.failure = String(error.stack ?? error); throw error; }
  finally {
    if (host) await stopNativeHost(host);
    await new Promise((done) => model.close(done));
    report.finishedAt = new Date().toISOString();
    await writeFile(join(evidenceRoot, "pending-restart-evidence.json"), JSON.stringify(report, null, 2));
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
