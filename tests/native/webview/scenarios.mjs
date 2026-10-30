import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { installAsyncWait, waitForFirstPage, settleBefore } from "../async-wait.mjs";
import { readRemainingFixture } from "../../../fixtures/remaining.mjs";
export async function exerciseTemplateCatalog(context) {
const { page } = context;

    const importedFixture = [{
      id: "fixture-imported-template", name: "持久化模板", sourceName: "fixture.png",
      sourceType: "image", createdAt: "2026-01-01T00:00:00.000Z",
      accent: "#2563eb", formatId: "legacy-v1", layout: "single-column",
      analysis: "隔离测试模板",
    }];
    await page.evaluate(async (payloadJson) => {
      const current = await window.__TAURI_INTERNALS__.invoke("read_imported_template_catalog");
      await window.__TAURI_INTERNALS__.invoke("write_imported_template_catalog", {
        payloadJson, expectedRevision: current.revision,
      });
    }, JSON.stringify(importedFixture));
    await page.reload({ waitUntil: "commit" });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "模板", exact: true }).click();
    await page.getByText("持久化模板", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "重命名模板 持久化模板" }).click();
    await page.getByLabel("模板名称").fill("已重命名模板");
    await page.getByLabel("模板名称").press("Enter");
    await page.getByText("已重命名模板", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "收藏模板 已重命名模板" }).click();
    await page.getByRole("button", { name: "取消收藏 已重命名模板" }).waitFor();
    assert.equal((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke(
      "bootstrap_template_activity", { legacyJson: "{}" })))[0].favorite, true);
    assert.equal(JSON.parse((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke(
      "read_imported_template_catalog"))).payloadJson)[0].name, "已重命名模板");
    await page.reload({ waitUntil: "commit" });
    await page.getByRole("button", { name: "模板", exact: true }).click();
    await page.getByText("已重命名模板", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "取消收藏 已重命名模板" }).waitFor();
    await page.getByRole("button", { name: "删除模板 已重命名模板" }).click();
    // The async handler publishes the catalog before removing its UI card.
    // A click acknowledges input delivery, not completion of SQLite persistence.
    await page.getByRole("button", { name: "删除模板 已重命名模板" }).waitFor({ state: "hidden", timeout: 15_000 });
    assert.deepEqual(JSON.parse((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke(
      "read_imported_template_catalog"))).payloadJson), []);
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke(
      "bootstrap_template_activity", { legacyJson: "{}" })).length === 0);
    await page.reload({ waitUntil: "commit" });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    assert.deepEqual(JSON.parse((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke(
      "read_imported_template_catalog"))).payloadJson), [], "deleted catalog stays empty after reloading the actual workspace");
    await page.getByRole("button", { name: "简历编辑" }).click();
}

export async function exerciseNativeSelectedContext(context) {
const { page } = context;

    const selectedContext = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const state = await invoke("document_state");
      const selected = await invoke("agent_selected_context", {
        expectedCursor: state.cursor, referenceIds: ["basic:name"],
      });
      let rejectedAvatar = false;
      let rejectedStaleCursor = false;
      try {
        await invoke("agent_selected_context", {
          expectedCursor: state.cursor, referenceIds: ["basic:avatar"],
        });
      } catch { rejectedAvatar = true; }
      try {
        await invoke("agent_selected_context", {
          expectedCursor: { ...state.cursor, revision: "0" }, referenceIds: ["basic:name"],
        });
      } catch { rejectedStaleCursor = true; }
      return { selected, rejectedAvatar, rejectedStaleCursor };
    });
    assert.deepEqual(selectedContext.selected.map(({ kind, value }) => [kind, value]), [["basic-field", "王测试"]]);
    assert.equal(JSON.stringify(selectedContext.selected).includes("phone"), false);
    assert.equal(JSON.stringify(selectedContext.selected).includes("avatar"), false);
    assert.equal(selectedContext.rejectedAvatar, false);
    assert.equal(selectedContext.rejectedStaleCursor, true);
}

export async function exerciseNativeModelStream(context) {
const { page, modelRequests } = context;

    if (await page.getByRole("button", { name: "展开聊天" }).count()) {
      await page.getByRole("button", { name: "展开聊天" }).click();
    }
    await page.getByLabel("给 Re:me 助手发送消息").fill("请回复连接状态 ");
    await page.getByLabel("给 Re:me 助手发送消息").pressSequentially("@姓名");
    await page.getByRole("listbox", { name: "选择引用" }).getByRole("option", { name: /姓名/ }).click();
    await page.evaluate(() => {
      const internals = window.__TAURI_INTERNALS__;
      const invoke = internals.invoke.bind(internals);
      window.__agentChatError = null;
      internals.invoke = async (command, args, options) => {
        try {
          return await invoke(command, args, options);
        } catch (error) {
          if (command === "agent_chat") window.__agentChatError = String(error);
          throw error;
        }
      };
    });
    await page.getByRole("button", { name: "发送消息" }).click();
    try {
      await page.locator(".agent-message-assistant").getByText("桌面网关已连接").waitFor({ timeout: 15_000 });
    } catch (error) {
      const diagnostic = await page.evaluate(async () => ({
        agentChatError: window.__agentChatError,
        runs: await window.__TAURI_INTERNALS__.invoke("list_agent_runs"),
        agentAlerts: [...document.querySelectorAll(".agent-inline-error,[role=status]")].map((item) => item.textContent),
      }));
      console.log(`R21 agent diagnostic: ${JSON.stringify(diagnostic)}`);
      throw error;
    }
    assert.equal(modelRequests.length, 4);
    assert.deepEqual(modelRequests.map(({ method, url }) => [method, url]), [
      ["GET", "/v1/models"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/v1/chat/completions"],
      ["POST", "/v1/chat/completions"],
    ]);
    assert.ok(modelRequests.every(({ authorization }) => authorization === "Bearer sk-fixture-secret-123456"));
    assert.ok(JSON.parse(modelRequests[2].body).tools?.length === 1);
    const sentAgentRequest = JSON.parse(modelRequests[3].body);
    assert.deepEqual(sentAgentRequest.tools.map(({ function: fn }) => fn.name), [
      "read_selected", "compare_versions", "inspect_template", "local_help", "propose_commands",
    ]);
    assert.equal(sentAgentRequest.messages[0].role, "system");
    assert.ok(sentAgentRequest.messages[0].content.includes("You are the local ZineCV resume assistant."));
    assert.ok(!sentAgentRequest.messages.some(({ content }) => content?.includes("renderer forged system")));
    const sentContext = sentAgentRequest.messages.at(-1).content;
    assert.ok(sentContext.includes('"value":"王测试"'));
    assert.equal(sentContext.includes('"field":"phone"'), false);
    assert.ok(modelRequests[3].body.includes("请回复连接状态"));
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("list_agent_runs"))[0]?.status === "completed");
    const nativeRuns = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs"));
    const chatRun = nativeRuns.find(({ status }) => status === "completed");
    assert.ok(chatRun);
    assert.deepEqual(chatRun.referenceIds, ["basic:name"]);
    assert.equal(chatRun.target.documentId, "workspace-default-document");
}

export async function exerciseNativeAgentSessionReload(context) {
const { page, pendingInbox, settings } = context;

    await page.waitForFunction(async () => {
      const state = await window.__TAURI_INTERNALS__.invoke("bootstrap_agent_sessions", { legacyJson: "{}" });
      return state.store.sessions.some((session) => session.messages.some(
        (message) => message.text.includes("待确认建议（尚未应用）")));
    });
    await page.reload({ waitUntil: "commit" });
    await page.locator(".agent-message-assistant").getByText("待确认建议（尚未应用）").waitFor({ timeout: 15_000 });
    const recoveredProposal = page.getByLabel("宿主保存的待审阅提议");
    await recoveredProposal.waitFor({ timeout: 15_000 });
    // 入场动画期间按钮位置不稳定且会被 composer 短暂遮挡；等有限动画收尾后再点。
    await page.evaluate(async () => {
      const finite = document.getAnimations().filter((animation) => animation.effect?.getTiming?.().iterations !== Infinity);
      await Promise.allSettled(finite.map((animation) => animation.finished));
    });
    await recoveredProposal.getByRole("button", { name: "确认所选 1 项" }).click();
    await page.waitForFunction(async () => {
      const state = await window.__TAURI_INTERNALS__.invoke("document_state");
      const inbox = await window.__TAURI_INTERNALS__.invoke("list_agent_proposals");
      return state.document.basic.name === "未经确认的新名称" && inbox.undoable.length === 1;
    }, null, { timeout: 15_000 });
    const runsAfterConfirm = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs"));
    assert.equal(runsAfterConfirm.find(({ id }) => id === pendingInbox.pending[0].runId)?.lifecycleState, "completed");
    assert.equal(await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke("document_state")).document.basic.name), "未经确认的新名称");
    await page.getByRole("button", { name: "撤回这次修改" }).click();
    await page.waitForFunction(async () => {
      const state = await window.__TAURI_INTERNALS__.invoke("document_state");
      const inbox = await window.__TAURI_INTERNALS__.invoke("list_agent_proposals");
      return state.document.basic.name === "王测试" && inbox.undoable.length === 0;
    }, null, { timeout: 15_000 });
    assert.equal((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("list_agent_runs")))[0].status, "completed");
    await page.getByRole("button", { name: "模型设置" }).click();
    await settings.getByRole("button", { name: "退出登录" }).click();
    await settings.getByRole("button", { name: "注册并登录" }).waitFor({ timeout: 15_000 });
    await assert.rejects(page.evaluate(() => window.__TAURI_INTERNALS__.invoke("provider_profile")));
}

export async function exerciseR24VersionUIRoundTrip(context) {
const { page } = context;

    const graphInitial = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    const mainBranchId = graphInitial.cursor.branchId;
    const initialHeadId = graphInitial.cursor.headId;
    assert.ok(initialHeadId, "the default branch must begin with its initial commit");
    const mainBranchName = graphInitial.branches.find((branch) => branch.id === mainBranchId)?.name;
    const initialCommit = graphInitial.commits.find((commit) => commit.id === initialHeadId);
    assert.ok(mainBranchName);
    assert.ok(initialCommit);
    const initialName = JSON.parse(initialCommit.snapshotDocumentJson).basic.name;
    await page.getByRole("button", { name: "简历编辑" }).click();
    const expandBasic = page.locator("button[aria-label='展开基本信息']");
    if (await expandBasic.count()) await expandBasic.click();
    await page.getByLabel("姓名", { exact: true }).fill("R24 主线版本");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByLabel("版本说明").fill("R24 主线提交");
    await page.getByRole("button", { name: "提交到当前分支" }).click();
    await page.waitForFunction(async () => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return graph.commits.some((commit) => commit.message === "R24 主线提交");
    }, undefined, { timeout: 20_000 });
    const graphCommitted = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    const mainCommit = graphCommitted.commits.find((commit) => commit.message === "R24 主线提交");
    assert.ok(mainCommit);
    assert.equal(mainCommit.parentId, initialHeadId);
    await page.getByLabel("新分支名称").fill("R24 验收支线");
    await page.getByRole("button", { name: "新建分支" }).click();
    await page.waitForFunction(async () => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return graph.branches.some((branch) => branch.name === "R24 验收支线");
    }, undefined, { timeout: 20_000 });
    const graphBranched = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    const testBranch = graphBranched.branches.find((branch) => branch.name === "R24 验收支线");
    assert.ok(testBranch);
    assert.notEqual(graphBranched.cursor.branchId, mainBranchId);
    assert.equal(graphBranched.commits.length, graphCommitted.commits.length + 1, "creating a branch also commits its initial snapshot");
    const branchHead = graphBranched.commits.find((commit) => commit.id === testBranch.headCommitId);
    assert.equal(branchHead?.parentId, mainCommit.id);

    // A cancelled dirty branch switch must preserve the branch and current draft.
    await page.getByRole("button", { name: "简历编辑" }).click();
    await page.getByLabel("姓名", { exact: true }).fill("R24 取消切换保留");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByLabel("切换简历分支").click();
    await page.getByRole("option", { name: mainBranchName }).click();
    await page.getByRole("alertdialog").getByRole("heading", { name: /切换到/ }).waitFor();
    await page.getByRole("alertdialog").getByRole("button", { name: "取消" }).click();
    let graphAfterCancel = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    let stateAfterCancel = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    assert.equal(graphAfterCancel.cursor.branchId, testBranch.id);
    assert.equal(stateAfterCancel.document.basic.name, "R24 取消切换保留");

    // Confirm the same switch, then prove loading an older commit changes only the draft.
    await page.getByLabel("切换简历分支").click();
    await page.getByRole("option", { name: mainBranchName }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "放弃修改并切换" }).click();
    await page.waitForFunction(async (branchId) => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return graph.cursor.branchId === branchId;
    }, mainBranchId, { timeout: 20_000 });
    const mainHeadBeforeLoad = (await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"))).cursor.headId;
    await page.locator(`.branch-tree-node[data-version-commit-id="${initialHeadId}"]`).click();
    await page.getByRole("button", { name: "载入", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "载入此版本" }).click();
    await page.waitForFunction(async (expectedName) => {
      const state = await window.__TAURI_INTERNALS__.invoke("document_state");
      return state.document.basic.name === expectedName;
    }, initialName, { timeout: 20_000 });
    const graphAfterHistoryLoad = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    assert.equal(graphAfterHistoryLoad.cursor.headId, mainHeadBeforeLoad, "loading history must not move the branch head");

    // Deleting a commit reconnects its child to the former parent; deleting the
    // branch then keeps that shared ancestor available to the main branch.
    await page.getByRole("button", { name: "简历编辑" }).click();
    await page.getByLabel("姓名", { exact: true }).fill("R24 删除 head 前的草稿");
    await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    const mainCommitNode = page.locator(`.branch-tree-node[data-version-commit-id="${mainCommit.id}"]`);
    await mainCommitNode.click();
    assert.equal(await page.locator(".branch-tree-node.selected").getAttribute("data-version-commit-id"), mainCommit.id);
    assert.equal(await page.locator(".branch-node-detail strong").textContent(), mainCommit.message);
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "删除当前版本" }).click();
    await page.waitForFunction(async (commitId) => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return !graph.commits.some((commit) => commit.id === commitId);
    }, mainCommit.id, { timeout: 20_000 });
    let graphAfterDeleteCommit = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    assert.ok(graphAfterDeleteCommit.commits.some((commit) => commit.id === initialHeadId));
    const reconnectedBranchHead = graphAfterDeleteCommit.commits.find((commit) => commit.id === branchHead.id);
    assert.equal(reconnectedBranchHead?.parentId, initialHeadId);
    await page.waitForFunction(async expectedName => (await window.__TAURI_INTERNALS__.invoke("document_state"))
      .document.basic.name === expectedName, initialName, { timeout: 15_000 });
    await page.locator(".version-storage-status").getByText("已保存到本机数据库").waitFor({ timeout: 15_000 });
    await page.reload({ waitUntil: "commit" });
    await page.locator(".app-shell").waitFor({ timeout: 20_000 });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.getByText("简历版本管理").first().waitFor({ timeout: 15_000 });
    await page.waitForFunction((branchName) =>
      document.querySelector(".branch-toolbar .themed-select-trigger")?.textContent?.includes(branchName) === true,
    mainBranchName, { timeout: 20_000 });
    await page.getByLabel("切换简历分支").click();
    await page.getByRole("option", { name: "R24 验收支线" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "放弃修改并切换" }).click();
    await page.waitForFunction(async (branchId) => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return graph.cursor.branchId === branchId;
    }, testBranch.id, { timeout: 20_000 });
    await page.waitForFunction((branchName) =>
      document.querySelector(".branch-toolbar .themed-select-trigger")?.textContent?.includes(branchName) === true,
    "R24 验收支线", { timeout: 20_000 });
    await page.getByRole("button", { name: "删除当前分支" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "删除分支" }).click();
    await page.waitForFunction(async (branchId) => {
      const graph = await window.__TAURI_INTERNALS__.invoke("version_graph_detailed");
      return !graph.branches.some((branch) => branch.id === branchId);
    }, testBranch.id, { timeout: 20_000 });
    await page.waitForFunction((branchName) =>
      document.querySelector(".branch-toolbar .themed-select-trigger")?.textContent?.includes(branchName) === true,
    mainBranchName, { timeout: 20_000 });
    const graphAfterDeleteBranch = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    assert.ok(graphAfterDeleteBranch.commits.some((commit) => commit.id === initialHeadId), "shared ancestors must survive branch deletion");
    assert.ok(graphAfterDeleteBranch.branches.some((branch) => branch.id === mainBranchId));
    await page.reload({ waitUntil: "commit" });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    const graphAfterVersionRestart = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    assert.deepEqual(
      graphAfterVersionRestart.branches.map((branch) => [branch.id, branch.headCommitId]).sort(),
      graphAfterDeleteBranch.branches.map((branch) => [branch.id, branch.headCommitId]).sort(),
    );
    assert.deepEqual(
      graphAfterVersionRestart.commits.map((commit) => [commit.id, commit.parentId]).sort(),
      graphAfterDeleteBranch.commits.map((commit) => [commit.id, commit.parentId]).sort(),
    );
    await page.getByRole("button", { name: "版本管理" }).first().click();
}

export async function exerciseLegacyMigrationReviewAndIdempotency(context) {
const { profile, page } = context;

    const sourcePath = join(profile, "synthetic-versions.json");
    const modules = ["education", "skills", "work", "projects", "orgs", "research", "awards", "other", "portfolio", "custom"];
    const basic = Object.fromEntries([
      "name", "phone", "email", "city", "wechat", "birth", "website", "linkedin",
      "gender", "height", "weight", "ethnicity", "birthplace", "politicalStatus",
      "maritalStatus", "zodiac", "mbti", "avatar",
    ].map((key) => [key, key === "name" ? "迁移验收合成" : ""]));
    basic.ageMode = "age";
    const legacySnapshot = {
      schemaVersion: 2,
      resumeTitle: "迁移验收合成简历",
      summaryTitle: "自我评价",
      resume: {
        basic,
        ...Object.fromEntries(modules.map((key) => [key, []])),
        summary: "",
      },
      moduleOrder: ["education", "skills", "work", "projects", "orgs", "summary"],
      moduleNames: Object.fromEntries(modules.map((key) => [key, key])),
      presentation: { templateId: "legacy-v1", templateVersion: 1, densityPreset: "standard", overrides: {} },
      layout: {
        font: "宋体", fontSize: "13", lineHeight: "16", moduleSpacing: "8", pageMargin: "30",
        theme: "#000000", dateFormat: "2021年1月", titleFormat: "单行标题",
        separator: "使用分隔符号", textAlign: "两端对齐",
      },
      importedTemplate: null,
    };
    const sourceJson = JSON.stringify({
      currentBranchId: "main",
      branches: [{
        id: "main", name: "R20 合成迁移分支",
        createdAt: "2026-01-01T00:00:00.000Z", headCommitId: "legacy-commit-1",
      }],
      commits: [{
        id: "legacy-commit-1", branchId: "main", parentId: null,
        message: "R20 合成迁移提交", createdAt: "2026-01-01T00:00:00.000Z",
        snapshot: legacySnapshot,
      }],
    });
    await writeFile(sourcePath, sourceJson, "utf8");
    const sourceHashBefore = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    const graphBefore = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    const documentBefore = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    await page.evaluate(() => {
      window.__migrationNotices = [];
      window.__migrationIpc = [];
      const internals = window.__TAURI_INTERNALS__;
      const originalInvoke = internals.invoke.bind(internals);
      internals.invoke = (command, ...args) => {
        const pending = originalInvoke(command, ...args);
        window.__migrationIpc.push({ command, state: "started" });
        Promise.resolve(pending).then(
          () => window.__migrationIpc.push({ command, state: "resolved" }),
          (error) => window.__migrationIpc.push({ command, state: "rejected", error: String(error?.message ?? error) }),
        );
        return pending;
      };
      new MutationObserver(() => {
        const notice = document.querySelector(".notice-toast")?.textContent?.trim();
        if (notice) window.__migrationNotices.push(notice);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const chooserOpened = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "导入旧版数据" }).click();
      await (await chooserOpened).setFiles(sourcePath);
      const inputDiagnostic = await page.getByLabel("选择旧版浏览器导出数据文件").evaluate((input) => ({
        value: input.value,
        files: Array.from(input.files ?? []).map((file) => ({ name: file.name, size: file.size })),
      }));
      console.log(`Migration input event state: ${JSON.stringify(inputDiagnostic)}`);
      const dialog = page.getByRole("alertdialog");
      try {
        await dialog.getByRole("heading", { name: "审阅并导入旧版数据？" }).waitFor({ timeout: 20_000 });
      } catch (error) {
        const pageText = (await page.locator("body").innerText().catch(() => "unavailable")).slice(-2_000);
        const diagnostics = await page.evaluate(() => ({
          notices: window.__migrationNotices,
          ipc: window.__migrationIpc,
        })).catch(() => ({ notices: [], ipc: [] }));
        throw new Error(`Migration review did not open. Visible page text: ${pageText}; diagnostics: ${JSON.stringify(diagnostics)}`, { cause: error });
      }
      const description = await dialog.locator("#confirm-description").textContent();
      assert.match(description ?? "", /将追加 1 个分支、1 次提交/);
      assert.match(description ?? "", /旧 Key 不迁入，需重新输入/);
      await dialog.getByRole("button", { name: "确认并原子导入" }).click();
      await page.getByText(/旧版迁移已原子提交：新增 1 个分支、1 次提交/).waitFor({ timeout: 20_000 });
    }
    const graphAfter = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    const documentAfter = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("document_state"));
    const sourceHashAfter = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
    assert.equal(graphAfter.branches.length, graphBefore.branches.length + 1);
    assert.equal(graphAfter.commits.length, graphBefore.commits.length + 1);
    assert.ok(graphAfter.commits.some((commit) => commit.message === "R20 合成迁移提交"));
    assert.equal(documentAfter.document.title, documentBefore.document.title, "versions-only import must not replace the current draft");
    assert.equal(sourceHashAfter, sourceHashBefore, "migration must leave original source bytes unchanged");

    assert.ok((await stat(join(profile, "ZineCVData", "zinecv.sqlite3"))).size >= 4096);
    assert.equal(new URL(page.url()).protocol, "http:");
}

export async function exerciseR241001CommitCompleteJSONBackupViaUI(context) {
const { page, profile, restoredLazy, graphSignature, versionBackup } = context;

    const denseGraphBeforeExport = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"));
    assert.equal(denseGraphBeforeExport.commits.length, 1001);
    assert.equal(denseGraphBeforeExport.cursor.headId, "commit-0999", "history load must not move HEAD");
    await page.getByLabel("附带当前未提交草稿").check();
    const denseBackupDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出版本备份", exact: true }).click();
    const completeDenseBackupPath = join(profile, "r24-version-backup-1001-complete.json");
    await (await denseBackupDownload).saveAs(completeDenseBackupPath);
    const completeDenseBackup = JSON.parse(await readFile(completeDenseBackupPath, "utf8"));
    assert.equal(completeDenseBackup.format, "resume-diy-version-backup");
    assert.equal(completeDenseBackup.store.commits.length, denseGraphBeforeExport.commits.length);
    const nativeMainId = `main:${restoredLazy.document.documentId}`;
    const portableBranchId = id => id === nativeMainId ? "main" : id;
    assert.equal(completeDenseBackup.store.currentBranchId, portableBranchId(denseGraphBeforeExport.cursor.branchId));
    assert.deepEqual(completeDenseBackup.store.branches.map(branch => [branch.id, branch.headCommitId]).sort(),
      denseGraphBeforeExport.branches.map(branch => [portableBranchId(branch.id), branch.headCommitId]).sort());
    assert.deepEqual(completeDenseBackup.store.commits.map(commit =>
      [commit.id, commit.branchId, commit.parentId, commit.message, commit.createdAt]).sort(),
    denseGraphBeforeExport.commits.map(commit =>
      [commit.id, portableBranchId(commit.originBranchId), commit.parentId, commit.message, commit.createdAt]).sort());
    for (const commit of completeDenseBackup.store.commits) {
      assert.ok(commit.snapshot?.resume && commit.snapshot.layout && commit.snapshot.moduleOrder,
        `JSON backup must include a complete snapshot for ${commit.id}`);
    }
    assert.equal(completeDenseBackup.store.commits.find(commit => commit.id === "r24-lazy-ancestor")
      .snapshot.resume.basic.name, "R24 按需历史快照");
    assert.equal(completeDenseBackup.draft.snapshot.resume.basic.name, "R24 按需历史快照",
      "included draft must preserve the loaded history content");
    assert.deepEqual(graphSignature(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("version_graph_detailed"))),
      graphSignature(denseGraphBeforeExport), "complete backup must preserve all branch/head/parent relations");

    // Empty graph remains a valid durable state and renders without stale nodes.
    const emptyBackupPath = join(profile, "r24-empty-version-graph.json");
    await writeFile(emptyBackupPath, JSON.stringify({
      format: versionBackup.format,
      formatVersion: versionBackup.formatVersion,
      exportedAt: new Date().toISOString(),
      store: {
        currentBranchId: "main",
        branches: [{ id: "main", name: "main", createdAt: new Date().toISOString(), headCommitId: null }],
        commits: [],
      },
    }), "utf8");
    await page.getByLabel("选择版本备份文件", { exact: true }).setInputFiles(emptyBackupPath);
    await page.getByText("已读取版本备份", { exact: true }).waitFor({ timeout: 15_000 });
    await page.locator(".version-import-preview").getByRole("button", { name: "替换当前版本库" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "确认替换版本库" }).click();
    await page.getByText("版本库已替换，当前工作内容未自动变更", { exact: true }).waitFor({ timeout: 20_000 });
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("version_graph_detailed")).commits.length === 0, null, { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll(".branch-tree-node").length === 0, null, { timeout: 20_000 });
    assert.equal(await page.locator(".branch-tree-node").count(), 0);
    await page.reload({ waitUntil: "commit" });
    await page.locator(".save-state").getByText(/草稿已保存|已从本地数据库恢复/).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "版本管理" }).first().click();
    await page.waitForFunction(async () => (await window.__TAURI_INTERNALS__.invoke("version_graph_detailed")).commits.length === 0, null, { timeout: 20_000 });
    assert.equal(await page.locator(".branch-tree-node").count(), 0);
}

export async function exerciseCloseFlush(context) {
const { page, child, verifyWorkerJobCleanup, profile, waitForProcessExit, renderWorkerProcessId } = context;

    await page.evaluate(() => {
      window.originalFetch = window.fetch;
      window.fetch = (url, ...args) => String(url).includes("/apply_document_command")
        ? Promise.resolve(new Response("fixture disk write failure", {
          headers: { "Tauri-Response": "error", "Content-Type": "text/plain" },
        })) : window.originalFetch(url, ...args);
    });
    await page.getByRole("button", { name: "简历编辑" }).click();
    await page.locator(".resume-title").click();
    await page.getByLabel("简历名称", { exact: true }).fill("关闭前最后修改");
    await page.getByLabel("简历名称", { exact: true }).press("Tab");
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }));
    await page.locator(".save-state").getByText(/保存失败/).waitFor({ timeout: 15_000 });
    assert.equal(child.exitCode, null, "failed save must keep the desktop window open");
    await page.evaluate(() => { window.fetch = window.originalFetch; });
    if (verifyWorkerJobCleanup) {
      await page.locator(".resume-title").click();
      const retryTitleInput = page.getByLabel("简历名称", { exact: true });
      await retryTitleInput.fill("关闭前最后修改-重试");
      await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
      await retryTitleInput.fill("关闭前最后修改");
      await page.locator(".save-state").getByText("草稿已保存").waitFor({ timeout: 15_000 });
    } else {
      const exited = new Promise((done) => child.once("exit", done));
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }));
      await settleBefore(exited, 10_000);
      assert.notEqual(child.exitCode, null, "close must finish after flushing the draft");
    }
    const { stdout } = await promisify(execFile)("python", ["-c",
      "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.loads(c.execute('SELECT document_json FROM drafts').fetchone()[0])['title'])",
      join(profile, "ZineCVData", "zinecv.sqlite3")]);
    assert.equal(stdout.trim(), "关闭前最后修改");
    if (verifyWorkerJobCleanup) {
      const exited = new Promise((done) => child.once("exit", done));
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise((done) => killer.once("exit", done));
      await settleBefore(exited, 10_000);
      assert.notEqual(child.exitCode, null, "simulated host process must terminate");
      assert.equal(await waitForProcessExit(renderWorkerProcessId), true, "Windows job close must reap the worker after abrupt host exit");
      console.log(`R09 host PID=${child.pid} terminated; worker PID=${renderWorkerProcessId} was reaped without taskkill /T`);
    }
}
