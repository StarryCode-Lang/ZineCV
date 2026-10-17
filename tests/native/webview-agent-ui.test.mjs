import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { startNativeHost, stopNativeHost } from "./host-fixture.mjs";
import { installIpcInterceptor } from "./ipc-interceptor.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidenceRoot = join(root, ".artifacts/runtime-tmp/test-evidence/R23/session3-ui");

test("real Agent UI shares a frozen run across modes/views and permits mouse template rename", { timeout: 150_000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true });
  const profile = await mkdtemp(join(evidenceRoot, "profile-"));
  assert.ok(resolve(profile).startsWith(resolve(evidenceRoot) + sep));
  const requests = [];
  let heldResponse;
  const model = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    requests.push(payload);
    if (payload.tools?.some(({ function: fn }) => fn.name === "zinecv_capability_probe")) {
      const nonce = payload.tools[0].function.parameters.properties.nonce.enum[0];
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "probe-ui", type: "function", function: { name: "zinecv_capability_probe", arguments: JSON.stringify({ nonce }) } }] } }] }));
    } else {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: payload.tools?.length ? "P05 合成运行已开始" : "OK" } }] })}\n\n`);
      if (payload.tools?.length) heldResponse = response;
      else response.end("data: [DONE]\n\n");
    }
  });
  await new Promise((done, reject) => model.once("error", reject).listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
  const report = { startedAt: new Date().toISOString(), fixture: "synthetic local model and isolated WebView2 profile", hostPids: [], samples: [] };
  let host;
  let passed = false;
  try {
    host = await startNativeHost(profile);
    report.hostPids.push(host.child.pid);
    await host.page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const catalog = await invoke("read_imported_template_catalog");
      await invoke("write_imported_template_catalog", { expectedRevision: catalog.revision, payloadJson: JSON.stringify([{ id: "ui-rename-fixture", name: "P05 合成模板", sourceName: "fixture.png", sourceType: "image", createdAt: "2026-01-01T00:00:00.000Z", accent: "#2563eb", formatId: "legacy-v1", layout: "single-column", analysis: "隔离 UI 合成模板" }]) });
    });
    await host.page.reload({ waitUntil: "commit" });
    await host.page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor();
    const page = host.page;
    await page.getByRole("button", { name: "展开基本信息", exact: true }).click();
    await page.getByLabel("姓名", { exact: true }).fill("P05 合成姓名");
    await page.getByLabel("电话", { exact: true }).fill("18800000000");
    if (await page.getByRole("button", { name: "展开教育经历", exact: true }).count())
      await page.getByRole("button", { name: "展开教育经历", exact: true }).click();
    await page.getByRole("button", { name: "添加一段教育经历" }).click();
    await page.locator(".save-state").getByText("草稿已保存").waitFor();
    if (await page.getByRole("button", { name: "模型设置" }).count() === 0) await page.getByRole("button", { name: "展开 Re:me 助手" }).click();
    await page.getByRole("button", { name: "模型设置" }).click();
    const settings = page.getByRole("dialog", { name: "模型连接" });
    await settings.getByLabel("邮箱", { exact: true }).fill("agent-ui@example.com");
    await settings.getByLabel("密码", { exact: true }).fill("fixture-password");
    await settings.getByRole("button", { name: "注册并登录" }).click();
    await settings.getByText("已登录：agent-ui@example.com").waitFor();
    await settings.getByLabel("连接名称", { exact: true }).fill("合成 UI 模型");
    await settings.getByLabel("Base URL", { exact: true }).fill(baseUrl);
    await settings.getByLabel("API Key", { exact: true }).fill("synthetic-ui-secret");
    await settings.getByLabel("模型 ID", { exact: true }).fill("fixture-model");
    await settings.getByRole("button", { name: "保存连接" }).click();
    await settings.getByText(/连接已加密保存到此账户/).waitFor();
    await settings.getByRole("button", { name: "测试连接" }).click();
    await settings.getByText(/结构化工具通过/).waitFor();
    await settings.getByRole("button", { name: "关闭模型设置" }).click();
    if (await page.getByRole("button", { name: "展开聊天" }).count()) await page.getByRole("button", { name: "展开聊天" }).click();
    const composer = page.getByLabel("给 Re:me 助手发送消息");
    const verifyReference = async (query, kind, entry = false) => {
      await composer.fill(`@${query}`);
      const options = page.getByRole("listbox", { name: "选择引用" }).getByRole("option")
        .filter({ has: page.locator(".agent-completion-kind").getByText(kind, { exact: true }) });
      const option = entry ? options.filter({ hasText: "ID " }).first() : options.first();
      const label = await option.locator("strong").innerText();
      await option.click();
      await page.getByRole("button", { name: `移除引用 ${label}`, exact: true }).click();
      (report.referenceLabels ??= []).push({ query, kind, label, entry });
      await composer.fill("");
    };
    await verifyReference("基本信息", "页面功能");
    await verifyReference("姓名", "基本信息");
    await verifyReference("教育", "简历内容");
    await verifyReference("教育", "简历内容", true);
    await verifyReference("自我评价", "自我评价");
    await composer.fill("P05 三形态共享运行验证 ");
    await composer.pressSequentially("@姓名");
    await page.getByRole("listbox", { name: "选择引用" }).getByRole("option", { name: /姓名/ }).click();
    await page.locator(".agent-context-disclosure summary").click();
    const disclosed = await page.locator(".agent-context-disclosure pre").innerText();
    assert.ok(disclosed.includes("P05 合成姓名"));
    assert.equal(disclosed.includes("18800000000"), false);
    report.selectedContextDisclosureChecked = true;
    await page.locator(".agent-context-disclosure summary").click();
    // Count the actual production IPC without replacing or suppressing writes.
    await installIpcInterceptor(page);
    await page.evaluate(() => {
      window.__agentSessionWrites = [];
      window.__zinecvTestInvoke = (command, args, invoke) => {
        const sample = command === "replace_agent_sessions" ? { at: performance.now(), completed: false } : null;
        if (sample) window.__agentSessionWrites.push(sample);
        const result = invoke(command, args);
        if (sample) result.then(() => { sample.completed = true; }, () => { sample.failed = true; });
        return result;
      };
    });
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.getByRole("button", { name: "停止请求" }).waitFor();
    const frozen = (await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs")))[0];
    report.runId = frozen.id;
    report.frozenTarget = frozen.target;
    const sample = async (label) => {
      const run = (await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs"))).find((run) => run.id === frozen.id);
      assert.deepEqual(run.target, frozen.target);
      assert.deepEqual(run.referenceIds, ["basic:name"]);
      assert.equal(run.lifecycleState, "running");
      report.samples.push({ label, id: run.id, target: run.target, lifecycleState: run.lifecycleState });
    };
    await sample("chat/editor");
    await page.getByRole("button", { name: "收起聊天" }).click();
    await page.locator(".agent-mode-composer").waitFor();
    await sample("composer/editor");
    await page.getByRole("button", { name: "最小化到 Bot" }).click();
    await page.locator(".agent-mode-bot").waitFor();
    await sample("bot/editor");
    await page.getByRole("button", { name: "模板", exact: true }).click();
    await page.getByText("P05 合成模板", { exact: true }).waitFor();
    await sample("bot/templates");
    await page.getByRole("button", { name: "展开 Re:me 助手" }).click();
    await page.getByRole("button", { name: "展开聊天" }).click();
    await verifyReference("P05", "模板");
    await sample("chat/templates/reference-selection");
    await page.getByRole("button", { name: "最小化到 Bot" }).click();
    await page.getByRole("button", { name: "重命名模板 P05 合成模板" }).click();
    await page.getByRole("button", { name: "展开 Re:me 助手" }).click();
    if (await page.getByRole("button", { name: "展开聊天" }).count())
      await page.getByRole("button", { name: "展开聊天" }).click();
    await page.getByLabel("模板名称").fill("P05 鼠标保存模板");
    // Use the actual mouse button, with the expanded floating assistant present.
    await page.locator(".template-library-rename-form").getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("P05 鼠标保存模板", { exact: true }).waitFor();
    const catalog = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("read_imported_template_catalog"));
    assert.equal(JSON.parse(catalog.payloadJson)[0].name, "P05 鼠标保存模板");
    report.mouseRenameSaved = true;
    await page.getByRole("button", { name: "最小化到 Bot" }).click();
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByText("简历版本管理").first().waitFor();
    await sample("bot/versions");
    await page.getByRole("button", { name: "展开 Re:me 助手" }).click();
    await verifyReference("当前草稿", "草稿");
    await verifyReference("", "分支");
    await verifyReference("", "版本");
    await sample("composer/versions/reference-selection");
    assert.equal(await page.getByRole("button", { name: "新建对话" }).isDisabled(), true);
    assert.ok(heldResponse, "synthetic run remains in flight until released");
    // Let unrelated mode/reference writes settle, then measure only a continuous
    // stream plus one explicit collapse flush. The former per-delta write path
    // produces ~30 writes and fails the bound below.
    await page.waitForFunction(async () => {
      const { store } = await window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" });
      return window.__agentSessionWrites.every(write => write.completed) &&
        store.sessions.some(session => session.messages.some(message => message.role === "assistant" && message.text === "P05 合成运行已开始"));
    });
    await page.evaluate(() => { window.__agentSessionWrites = []; });
    if (await page.getByRole("button", { name: "展开聊天" }).count())
      await page.getByRole("button", { name: "展开聊天" }).click();
    const streamStarted = Date.now();
    const deltas = Array.from({ length: 30 }, (_, index) => `，A1片段${String(index + 1).padStart(2, "0")}`);
    const emitDeltas = async (start, end) => {
      for (let index = start; index < end; index += 1) {
        heldResponse.write(`data: ${JSON.stringify({ choices: [{ delta: { content: deltas[index] } }] })}\n\n`);
        await new Promise(done => setTimeout(done, 50));
      }
    };
    await emitDeltas(0, 15);
    await page.locator(".agent-message-assistant").getByText(/A1片段15/).waitFor();
    await page.getByRole("button", { name: "最小化到 Bot" }).click();
    await page.locator(".agent-mode-bot").waitFor();
    await page.waitForFunction(async () => {
      const { store } = await window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" });
      return store.sessions.some(session => session.messages.some(message => message.role === "assistant" && message.text.includes("A1片段15")));
    });
    report.collapseFlushedStreamingText = true;
    await emitDeltas(15, 30);
    const elapsedMs = Date.now() - streamStarted;
    const streamWrites = await page.evaluate(() => window.__agentSessionWrites);
    const windowCount = Math.ceil(elapsedMs / 800);
    // One extra write is permitted for the required mid-stream collapse flush.
    assert.ok(streamWrites.length <= windowCount + 1, `stream wrote ${streamWrites.length} times for ${windowCount} debounce windows + one collapse`);
    assert.ok(streamWrites.length < deltas.length / 2, "continuous deltas must not write per chunk");
    assert.ok(streamWrites.length > 0, "the native session-write observer must record actual writes");
    assert.equal(streamWrites.some(write => write.failed), false);
    report.streamingWriteBound = { deltas: deltas.length, intervalMs: 50, debounceMs: 800, elapsedMs, windowCount, collapseFlushAllowance: 1, ipcCalls: streamWrites.length };
    await page.getByRole("button", { name: "展开 Re:me 助手" }).click();
    if (await page.getByRole("button", { name: "展开聊天" }).count())
      await page.getByRole("button", { name: "展开聊天" }).click();
    await page.locator(".agent-message-assistant").getByText(/A1片段30/).waitFor();
    heldResponse.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "，P05 合成完成" } }] })}\n\ndata: [DONE]\n\n`);
    heldResponse = undefined;
    await page.getByRole("button", { name: "发送消息" }).waitFor();
    const completedText = "P05 合成运行已开始" + deltas.join("") + "，P05 合成完成";
    await page.waitForFunction(async text => {
      const { store } = await window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" });
      return store.sessions.some(session => session.messages.some(message => message.role === "assistant" && message.text === text));
    }, completedText);
    report.streamEndFlushedFinalText = true;
    report.sessionWriteSamples = await page.evaluate(() => window.__agentSessionWrites);
    await page.getByRole("button", { name: "新建对话" }).click();
    await page.getByRole("button", { name: "历史对话" }).click();
    await page.locator(".agent-session-list button").filter({ hasText: "P05 三形态" }).first().click();
    await page.locator(".agent-message-assistant").getByText(/P05 合成完成/).waitFor();
    report.sessionSwitchRecoveredMessages = true;
    const modelRequest = requests.find((request) => request.tools?.some(({ function: fn }) => fn.name === "propose_commands"));
    assert.ok(modelRequest);
    assert.equal(JSON.stringify(modelRequest).includes("18800000000"), false);
    assert.equal(JSON.stringify(modelRequest).includes("synthetic-ui-secret"), false);
    report.unselectedPhoneAndKeyAbsent = true;
    await composer.fill("P05 中断恢复验证");
    await page.getByRole("button", { name: "发送消息" }).click();
    await page.getByRole("button", { name: "停止请求" }).waitFor();
    await page.waitForFunction(async (previousId) => {
      const runs = await window.__TAURI_INTERNALS__.invoke("list_agent_runs");
      return runs.some((run) => run.id !== previousId && run.lifecycleState === "running");
    }, frozen.id);
    const interrupted = (await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs"))).find((run) => run.id !== frozen.id && run.lifecycleState === "running");
    report.interruptedRunId = interrupted.id;
    await stopNativeHost(host);
    host = undefined;
    heldResponse?.end("data: [DONE]\n\n");
    heldResponse = undefined;
    host = await startNativeHost(profile);
    report.hostPids.push(host.child.pid);
    const restartedPage = host.page;
    if (await restartedPage.getByRole("button", { name: "模型设置" }).count() === 0) await restartedPage.getByRole("button", { name: "展开 Re:me 助手" }).click();
    await restartedPage.getByRole("button", { name: "模型设置" }).click();
    const restartedSettings = restartedPage.getByRole("dialog", { name: "模型连接" });
    await restartedSettings.getByLabel("邮箱", { exact: true }).fill("agent-ui@example.com");
    await restartedSettings.getByLabel("密码", { exact: true }).fill("fixture-password");
    await restartedSettings.getByRole("button", { name: "登录", exact: true }).click();
    await restartedSettings.getByText("已登录：agent-ui@example.com").waitFor();
    await restartedSettings.getByRole("button", { name: "关闭模型设置" }).click();
    const restartedSessions = await restartedPage.evaluate(() => window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" }));
    assert.ok(restartedSessions.store.sessions.some(session => session.messages.some(message => message.role === "assistant" && message.text === completedText)), "all 30 streamed deltas and final text must survive a host restart");
    report.finalTextSurvivedRestart = true;
    await restartedPage.getByText("上次运行已中断；已保存的对话保留，请手动重试。").waitFor();
    const recoveredRun = (await restartedPage.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs"))).find((run) => run.id === interrupted.id);
    assert.ok(recoveredRun.interruptedReason);
    assert.equal(recoveredRun.lifecycleState, "failed");
    report.interruptionNoticeRecovered = true;
    // Real 1001-commit native graph: its oldest snapshot must require A4's
    // detail IPC. Delay only delivery of that real response, never its contents.
    const preparationPage = restartedPage;
    const lazyId = "a4-preparation-0000";
    await preparationPage.evaluate(async () => {
      const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
      const state = await invoke("document_state");
      const comparisonSnapshot = (old) => {
        const document = structuredClone(state.document);
        const section = document.sections.find(section => section.kind === "education");
        if (!section?.entries?.length) throw new Error("A4 compare fixture requires the earlier education entry");
        section.entries = [{ ...section.entries[0], id: old ? "a4-old-education" : "a4-new-education", title: old ? "A4 旧快照大学" : "A4 新快照大学" }];
        return document;
      };
      const commits = Array.from({ length: 1001 }, (_, index) => ({
        id: `a4-preparation-${String(index).padStart(4, "0")}`, branchId: "main",
        parentId: index ? `a4-preparation-${String(index - 1).padStart(4, "0")}` : null,
        message: index ? `A4 合成版本 ${index}` : "A4 未物化准备竞态版本",
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, index)).toISOString(),
        snapshot: index === 0 ? comparisonSnapshot(true) : index === 1000 ? comparisonSnapshot(false) : state.document,
      }));
      await invoke("replace_version_store", { cursor: state.cursor, replacement: {
        currentBranchId: "main", branches: [{ id: "main", name: "main", headCommitId: commits.at(-1).id, createdAt: commits[0].createdAt }], commits,
      } });
    });
    await preparationPage.reload({ waitUntil: "commit" });
    await preparationPage.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor();
    const oldest = await preparationPage.evaluate(async lazyId => (await window.__TAURI_INTERNALS__.invoke("version_graph_detailed")).commits.find(commit => commit.id === lazyId), lazyId);
    assert.equal(oldest.snapshotDocumentJson, "", "fixture must exercise actual lazy detail loading");
    if (await preparationPage.getByRole("button", { name: "展开 Re:me 助手" }).count())
      await preparationPage.getByRole("button", { name: "展开 Re:me 助手" }).click();
    if (await preparationPage.getByRole("button", { name: "展开聊天" }).count())
      await preparationPage.getByRole("button", { name: "展开聊天" }).click();
    await preparationPage.getByRole("button", { name: "版本管理" }).first().click();
    const preparationComposer = preparationPage.getByLabel("给 Re:me 助手发送消息");
    // Exercise the real local skill, including the snapshot beyond the graph's
    // materialization limit. Distinct removed/added values prove a real diff.
    const compareBaseline = await preparationPage.evaluate(async () => ({
      draft: await window.__TAURI_INTERNALS__.invoke("document_state"),
      graph: await window.__TAURI_INTERNALS__.invoke("version_graph_detailed"),
    }));
    const modelRequestsBeforeCompare = requests.length;
    await installIpcInterceptor(preparationPage);
    await preparationPage.evaluate(lazyId => {
      window.__localCompare = { lazyDetailCalls: 0, modelCalls: 0 };
      window.__zinecvTestInvoke = (command, args, invoke) => {
        if (command === "version_commit_detail" && args.commitId === lazyId) window.__localCompare.lazyDetailCalls += 1;
        if (command === "agent_chat") window.__localCompare.modelCalls += 1;
        return invoke(command, args);
      };
    }, lazyId);
    await preparationComposer.fill("@未物化");
    await preparationPage.getByRole("listbox", { name: "选择引用" }).getByRole("option").filter({ hasText: "A4 未物化准备竞态版本" }).click();
    await preparationComposer.fill("@1000");
    await preparationPage.getByRole("listbox", { name: "选择引用" }).getByRole("option").filter({ hasText: "A4 合成版本 1000" }).click();
    await preparationComposer.fill("/compare-versions");
    await preparationPage.getByRole("listbox", { name: "选择技能" }).getByRole("option").filter({ hasText: "/compare-versions" }).click();
    await preparationPage.getByRole("button", { name: "发送消息" }).click();
    const localComparison = preparationPage.locator(".agent-message-assistant").filter({ hasText: "本地确定性字段差异（不修改当前草稿）" }).last();
    await localComparison.waitFor();
    const comparisonText = await localComparison.innerText();
    assert.ok(comparisonText.includes("左侧：A4 未物化准备竞态版本"));
    assert.ok(comparisonText.includes("右侧：A4 合成版本 1000"));
    assert.ok(comparisonText.includes("移除 A4 旧快照大学"), comparisonText);
    assert.ok(comparisonText.includes("新增 A4 新快照大学"), comparisonText);
    const compareAfter = await preparationPage.evaluate(async () => ({
      draft: await window.__TAURI_INTERNALS__.invoke("document_state"),
      graph: await window.__TAURI_INTERNALS__.invoke("version_graph_detailed"),
    }));
    assert.deepEqual(compareAfter, compareBaseline, "local compare must preserve the entire native draft, revision, branch/head and graph");
    const compareSamples = await preparationPage.evaluate(() => {
      const samples = window.__localCompare;
      window.__zinecvTestInvoke = null;
      return samples;
    });
    assert.equal(compareSamples.lazyDetailCalls, 1, "local skill must actually hydrate the oldest snapshot");
    assert.equal(compareSamples.modelCalls, 0);
    assert.equal(requests.length, modelRequestsBeforeCompare);
    report.localVersionCompare = { commitId: lazyId, ...compareSamples, output: comparisonText, oldValueRemoved: true, newValueAdded: true, draftAndGraphUnchanged: true };
    await preparationComposer.fill("A4 准备期间旧请求 @未物化");
    await preparationPage.getByRole("listbox", { name: "选择引用" }).getByRole("option").filter({ hasText: "A4 未物化准备竞态版本" }).click();
    const preparationDraft = await preparationComposer.inputValue();
    const sessionsBeforePreparation = await preparationPage.evaluate(() => window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" }));
    const modelRequestsBeforePreparation = requests.length;
    await preparationPage.evaluate(lazyId => {
      const gate = new Promise(resolve => { window.__releasePreparationDetail = resolve; });
      window.__preparationDetail = { calls: 0, delivered: false, modelCalls: 0, pendingSessionWrites: 0 };
      window.__zinecvTestInvoke = async (command, args, invoke) => {
        if (command === "agent_chat") window.__preparationDetail.modelCalls += 1;
        const result = invoke(command, args);
        if (command === "replace_agent_sessions") {
          window.__preparationDetail.pendingSessionWrites += 1;
          result.then(() => { window.__preparationDetail.pendingSessionWrites -= 1; }, () => { window.__preparationDetail.pendingSessionWrites -= 1; });
        }
        if (command === "version_commit_detail" && args.commitId === lazyId) {
          window.__preparationDetail.calls += 1;
          const detail = await result;
          await gate;
          window.__preparationDetail.delivered = true;
          return detail;
        }
        return result;
      };
    }, lazyId);
    await preparationPage.getByRole("button", { name: "发送消息" }).click();
    await preparationPage.waitForFunction(() => window.__preparationDetail.calls === 1);
    await preparationPage.getByRole("button", { name: "发送消息" }).click();
    await preparationComposer.press("Enter");
    await preparationPage.getByRole("button", { name: "新建对话" }).click();
    await preparationPage.getByRole("button", { name: "历史对话" }).click();
    await preparationPage.locator(".agent-session-list button").filter({ hasText: "新对话" }).first().click();
    assert.equal(await preparationComposer.inputValue(), preparationDraft);
    assert.deepEqual(await preparationPage.evaluate(() => window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" })), sessionsBeforePreparation);
    assert.equal(await preparationPage.evaluate(() => window.__preparationDetail.calls), 1, "repeated send must not prepare another request");
    await preparationPage.getByRole("button", { name: "历史对话" }).click();
    await preparationPage.getByRole("button", { name: "模型设置" }).click();
    const preparationSettings = preparationPage.getByRole("dialog", { name: "模型连接" });
    await preparationSettings.getByRole("button", { name: "退出登录" }).click();
    await preparationSettings.getByRole("button", { name: "注册并登录" }).waitFor();
    assert.equal(await preparationSettings.getByRole("button", { name: "退出登录" }).count(), 0);
    await preparationSettings.getByLabel("邮箱", { exact: true }).fill("agent-preparation-b@example.com");
    await preparationSettings.getByLabel("密码", { exact: true }).fill("fixture-password");
    await preparationSettings.getByRole("button", { name: "注册并登录" }).click();
    await preparationSettings.getByText("已登录：agent-preparation-b@example.com").waitFor();
    await preparationSettings.getByRole("button", { name: "关闭模型设置" }).click();
    await preparationComposer.fill("A4 新账户草稿必须保留");
    await preparationPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await preparationPage.waitForFunction(() => window.__preparationDetail.pendingSessionWrites === 0);
    const newAccountSessions = await preparationPage.evaluate(() => window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" }));
    await preparationPage.evaluate(() => window.__releasePreparationDetail());
    await preparationPage.waitForFunction(() => window.__preparationDetail.delivered);
    await preparationPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Observe a full debounce interval after releasing the awaited IPC so a
    // stale async continuation has time to issue a model/session write.
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(await preparationComposer.inputValue(), "A4 新账户草稿必须保留");
    assert.deepEqual(await preparationPage.evaluate(() => window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" })), newAccountSessions);
    const preparationSamples = await preparationPage.evaluate(() => window.__preparationDetail);
    assert.equal(preparationSamples.modelCalls, 0, "account invalidation must discard the old preparation before agent_chat");
    assert.equal(requests.length, modelRequestsBeforePreparation);
    report.sendPreparationRace = { commitId: lazyId, ...preparationSamples, duplicateSendBlocked: true, sessionMutationBlocked: true, accountDraftPreserved: true, staleRequestDiscarded: true };
    report.status = "passed";
    passed = true;
  } catch (error) {
    report.status = "failed"; report.failure = String(error.stack ?? error);
    if (host) { report.visibleText = (await host.page.locator("body").innerText().catch(() => "")).slice(-5000); await host.page.screenshot({ path: join(evidenceRoot, "failed-ui.png") }).catch(() => {}); }
    throw error;
  } finally {
    heldResponse?.end("data: [DONE]\n\n");
    if (host) await stopNativeHost(host);
    await new Promise((done) => model.close(done));
    report.finishedAt = new Date().toISOString();
    await writeFile(join(evidenceRoot, "ui-evidence.json"), JSON.stringify(report, null, 2));
    if (passed) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
