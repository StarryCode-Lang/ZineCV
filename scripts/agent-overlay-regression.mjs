import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distRoot = path.join(projectRoot, "dist");
const fixtureResume = {
  basic: {
    name: "Ada Fixture",
    phone: "15500001111",
    email: "private@example.test",
    city: "",
    wechat: "",
    birth: "",
    ageMode: "age",
    website: "",
    linkedin: "",
    gender: "",
    height: "",
    weight: "",
    ethnicity: "",
    birthplace: "",
    politicalStatus: "",
    maritalStatus: "",
    zodiac: "",
    mbti: "",
    avatar: "",
  },
  education: [],
  skills: [],
  work: [],
  projects: [],
  orgs: [],
  research: [],
  awards: [],
  other: [],
  portfolio: [],
  custom: [],
  summary: "",
};
const importedResume = {
  ...fixtureResume,
  basic: { ...fixtureResume.basic, name: "Template Candidate" },
  education: [
    {
      id: "agent-fixture-education",
      title: "Fixture University",
      role: "Computer Science",
      department: "",
      city: "",
      start: "2020",
      end: "2024",
      html: "<p>Controlled local template content.</p>",
    },
  ],
};
const importedTemplate = {
  id: "agent-fixture-template",
  name: "Agent Fixture Template",
  sourceName: "agent-fixture.png",
  sourceType: "image",
  createdAt: "2026-09-24T00:00:00.000Z",
  accent: "#a84c22",
  formatId: "legacy-v1",
  layout: "single-column",
  analysis: "Controlled test template.",
  resume: importedResume,
  moduleOrder: ["education", "skills", "work", "projects", "summary"],
  extractedText: "Controlled local template content.",
};

function serve() {
  const mime = {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".ttf": "font/ttf",
    ".woff2": "font/woff2",
  };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(
      new URL(request.url || "/", "http://127.0.0.1").pathname,
    );
    let file = path.resolve(distRoot, `.${pathname}`);
    if (
      !file.startsWith(`${distRoot}${path.sep}`) ||
      !fs.existsSync(file) ||
      fs.statSync(file).isDirectory()
    )
      file = path.join(distRoot, "index.html");
    response.setHeader(
      "Content-Type",
      mime[path.extname(file).toLowerCase()] || "application/octet-stream",
    );
    response.end(fs.readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

async function waitForView(page, view) {
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector("[data-agent-overlay]")
        ?.getAttribute("data-agent-view") === expected,
    view,
  );
}

async function switchView(page, view, label) {
  await page
    .locator(".rail-navigation")
    .getByRole("button", { name: label, exact: true })
    .click();
  await waitForView(page, view);
}

async function chooseReference(page, query, label) {
  const composer = page.getByRole("textbox", {
    name: "给 Re:me 助手发送消息",
  });
  if (await page.getByRole("button", { name: "展开聊天" }).count())
    await page.getByRole("button", { name: "展开聊天" }).click();
  await composer.fill(`@${query}`);
  await page.getByRole("option", { name: new RegExp(label) }).click();
}

async function chooseSkill(page, query, label) {
  const composer = page.getByRole("textbox", {
    name: "给 Re:me 助手发送消息",
  });
  await composer.fill(`/${query}`);
  await page.getByRole("option", { name: new RegExp(label) }).click();
}

async function fulfillStream(route, reply) {
  const parts = reply.content
    ? [reply.content.slice(0, 5), reply.content.slice(5)]
        .filter(Boolean)
        .map((text) => ({ type: "delta", text }))
    : [];
  parts.push({ type: "done", ...reply });
  await route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""),
  });
}

const server = await serve();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const chatRequests = [];
const errors = [];
let modelTurn = 0;
let releaseLateResponse = null;
let releaseBackgroundResponse = null;
const modelDiscoveryRequests = [];

try {
  await context.addInitScript(
    ({ resume, template }) => {
      if (localStorage.getItem("agent-overlay-regression-seeded")) return;
      localStorage.setItem("resume-diy-state", JSON.stringify(resume));
      localStorage.setItem(
        "resume-diy-imported-templates-v1",
        JSON.stringify([template]),
      );
      localStorage.setItem("agent-overlay-regression-seeded", "true");
    },
    { resume: fixtureResume, template: importedTemplate },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/agent/config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        provider: {
          name: "Controlled test model",
          baseUrl: "https://fixture.invalid/v1",
          model: "fixture-model",
          hasApiKey: true,
          capability: "structured",
        },
        keyStorage: "memory-only",
        sessionToken: "fixture-session-token",
      }),
    });
  });
  await page.route("**/api/agent/models", async (route) => {
    modelDiscoveryRequests.push({
      body: route.request().postDataJSON(),
      token: route.request().headers()["x-agent-session"],
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        baseUrl: "https://openrouter.ai/api/v1",
        count: 3,
        models: [
          { id: "openai/gpt-example", name: "GPT Example" },
          { id: "qwen/qwen3.8-27b:free", name: "Qwen 3.8 Free" },
          { id: "qwen/qwen3.8-72b", name: "Qwen 3.8" },
        ],
      }),
    });
  });
  await page.route("**/api/agent/chat/stream", async (route) => {
    const payload = route.request().postDataJSON();
    chatRequests.push(payload);
    modelTurn += 1;
    const runText = payload.messages
      .map((message) => message.content)
      .join(" ");
    if (runText.includes("multi-turn-read")) {
      const last = payload.messages.at(-1);
      const toolCalls =
        last.role === "tool"
          ? [
              {
                id: `fixture-proposal-${modelTurn}`,
                name: "propose_resume_patch",
                arguments: JSON.stringify({
                  target: { kind: "basic", key: "name" },
                  patch: { value: "Multi Turn Suggested" },
                  explanation: "读取后提议",
                }),
              },
            ]
          : [
              {
                id: `fixture-read-${modelTurn}`,
                name: "resume_read",
                arguments: JSON.stringify({ id: "basic:name" }),
              },
            ];
      await fulfillStream(route, {
          model: "fixture-model",
          content: "",
          toolCalls,
      });
      return;
    }
    if (payload.messages.at(-1).content.includes("delayed-cancel"))
      await new Promise((resolve) => {
        releaseLateResponse = resolve;
      });
    if (payload.messages.at(-1).content.includes("background-run"))
      await new Promise((resolve) => {
        releaseBackgroundResponse = resolve;
      });
    const suggestedName =
      modelTurn === 1 ? "Agent Suggested" : "Stale Suggestion";
    await fulfillStream(route, {
        model: "fixture-model",
        content: "我根据明确引用生成了一条待审阅提议。",
        toolCalls: [
          {
            id: `fixture-call-${modelTurn}`,
            name: "propose_resume_patch",
            arguments: JSON.stringify({
              target: { kind: "basic", key: "name" },
              patch: { value: suggestedName },
              explanation: "测试模型建议的字段修改。",
            }),
          },
        ],
    });
  });

  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("[data-agent-overlay]").waitFor();
  await page.getByRole("button", { name: "编辑基本信息", exact: true }).click();
  await page.getByRole("textbox", { name: "姓名" }).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "姓名" }).inputValue(),
    "Ada Fixture",
  );

  await chooseReference(page, "姓名", "姓名");
  const composer = page.getByRole("textbox", {
    name: "给 Re:me 助手发送消息",
  });
  await composer.fill("请只修改我选择的字段。");
  await switchView(page, "templates", "模板");
  assert.ok(await page.locator(".agent-chips").getByText("姓名").count());
  assert.equal(await composer.inputValue(), "请只修改我选择的字段。");
  await switchView(page, "editor", "简历编辑");
  for (let index = 0; index < 10; index += 1) {
    await switchView(page, "templates", "模板");
    await switchView(page, "editor", "简历编辑");
  }
  assert.equal(await page.locator("[data-agent-overlay]").count(), 1);
  assert.equal(await composer.inputValue(), "请只修改我选择的字段。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.locator(".agent-proposal").waitFor();

  const sentText = chatRequests[0].messages.at(-1).content;
  assert.match(sentText, /Ada Fixture/);
  assert.doesNotMatch(sentText, /15500001111|private@example\.test/);
  assert.ok(
    await page
      .locator(".paper:not(.layout-measure)")
      .first()
      .getByText("Ada Fixture", { exact: true })
      .count(),
    "the model proposal changed the resume before user confirmation",
  );
  assert.equal(
    await page
      .locator(".paper:not(.layout-measure)")
      .first()
      .getByText("Agent Suggested", { exact: true })
      .count(),
    0,
  );
  await page
    .locator(".agent-proposal")
    .getByRole("button", { name: "确认并应用" })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await page
    .locator(".paper:not(.layout-measure)")
    .first()
    .getByText("Agent Suggested", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "撤回上次修改" }).click();
  await page
    .locator(".paper:not(.layout-measure)")
    .first()
    .getByText("Ada Fixture", { exact: true })
    .waitFor();

  await chooseReference(page, "姓名", "姓名");
  await composer.fill("请给出可撤回的修改。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.locator(".agent-proposal").waitFor();
  await page
    .locator(".agent-proposal")
    .getByRole("button", { name: "确认并应用" })
    .click();
  await page.getByRole("textbox", { name: "姓名" }).fill("Manual After Accept");
  await page.getByRole("button", { name: "撤回上次修改" }).click();
  await page
    .getByText(/无法撤回：分支或原字段已在接受后变化/)
    .last()
    .waitFor();
  await page
    .locator(".paper:not(.layout-measure)")
    .first()
    .getByText("Manual After Accept", { exact: true })
    .waitFor();

  await chooseReference(page, "姓名", "姓名");
  await composer.fill("再给一版建议。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.locator(".agent-proposal").waitFor();
  await page.getByRole("textbox", { name: "姓名" }).fill("Manual Update");
  await page
    .locator(".agent-proposal")
    .getByRole("button", { name: "确认并应用" })
    .click();
  await page
    .getByText(/提议已过期/)
    .last()
    .waitFor();
  await page
    .locator(".paper:not(.layout-measure)")
    .first()
    .getByText("Manual Update", { exact: true })
    .waitFor();

  await switchView(page, "templates", "模板");
  await chooseReference(page, "Fixture", "Agent Fixture Template");
  await chooseSkill(page, "apply-template", "申请应用模板");
  await composer.fill("申请应用我选中的本地模板。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.locator(".agent-proposal").waitFor();
  await page
    .locator(".agent-proposal")
    .getByText(/Fixture University/)
    .waitFor();
  assert.equal(chatRequests.length, 3, "local template skill called the model");
  await page
    .locator(".agent-proposal")
    .getByRole("button", { name: "确认并应用" })
    .click();
  await page
    .locator(".paper:not(.layout-measure)")
    .first()
    .getByText("Template Candidate", { exact: true })
    .waitFor();

  await switchView(page, "templates", "模板");
  await chooseReference(page, "Fixture", "Agent Fixture Template");
  await chooseSkill(page, "apply-template", "申请应用模板");
  await composer.fill("再次申请应用模板。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.locator(".agent-proposal").waitFor();
  await switchView(page, "editor", "简历编辑");
  await page
    .getByRole("textbox", { name: "姓名" })
    .fill("Manual Template Edit");
  await page
    .locator(".agent-proposal")
    .getByRole("button", { name: "确认并应用" })
    .click();
  await page
    .getByText(/模板提议已过期/)
    .last()
    .waitFor();
  await page
    .locator(".paper:not(.layout-measure)")
    .first()
    .getByText("Manual Template Edit", { exact: true })
    .waitFor();

  await switchView(page, "editor", "简历编辑");
  await chooseReference(page, "姓名", "姓名");
  await composer.fill("请提出另一条姓名修改建议。");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.locator(".agent-proposal").waitFor();
  await switchView(page, "versions", "版本管理");
  await page.getByLabel("新分支名称").fill("Agent 分支回归");
  await page.getByRole("button", { name: "新建分支" }).click();
  await page
    .getByLabel("切换简历分支")
    .filter({ hasText: "Agent 分支回归" })
    .waitFor();
  await page
    .locator(".agent-proposal")
    .getByRole("button", { name: "确认并应用" })
    .click();
  await page
    .getByText(/提议已过期：当前分支或 HEAD 已变化/)
    .last()
    .waitFor();
  await page
    .locator(".paper:not(.layout-measure)")
    .first()
    .getByText("Manual Template Edit", { exact: true })
    .waitFor();

  await page
    .locator(".version-storage-status")
    .filter({ hasText: /已保存到当前浏览器|已保存到本机项目/ })
    .waitFor({ timeout: 10_000 });
  await chooseSkill(page, "save-version", "申请保存版本");
  await composer.fill("Agent Harness 回归保存");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.locator(".agent-proposal").waitFor();
  await page
    .locator(".agent-proposal")
    .getByRole("button", { name: "确认并应用" })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await page
    .getByText("已按确认执行，并通过现有宿主流程完成。")
    .last()
    .waitFor();
  await page.reload();
  await switchView(page, "versions", "版本管理");
  await page
    .locator(".version-storage-status")
    .filter({ hasText: /已保存到当前浏览器|已保存到本机项目/ })
    .waitFor({ timeout: 10_000 });
  await page
    .locator("[data-version-commit-id]")
    .filter({ hasText: "Agent Harness 回归保存" })
    .waitFor();
  assert.equal(
    await page
      .locator("[data-version-commit-id]")
      .filter({ hasText: "Agent Harness 回归保存" })
      .count(),
    1,
    "a repeated approval created multiple commits",
  );
  await switchView(page, "editor", "简历编辑");
  await page.getByRole("button", { name: "编辑基本信息", exact: true }).click();
  await page.getByRole("textbox", { name: "姓名" }).fill("Compared Name");
  await switchView(page, "versions", "版本管理");
  await chooseReference(page, "当前草稿", "当前草稿");
  await chooseReference(page, "回归保存", "Agent Harness 回归保存");
  await chooseSkill(page, "compare-versions", "比较版本");
  await composer.fill("比较这两个快照");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page
    .getByText(/基本信息：姓名（值不展示）/)
    .last()
    .waitFor();
  assert.equal(
    chatRequests.length,
    4,
    "local version comparison called the model",
  );
  await chooseSkill(page, "settings", "模型设置");
  await page.getByRole("button", { name: "发送消息" }).click();
  const discoveryDialog = page.getByRole("dialog", { name: "模型连接" });
  await discoveryDialog.waitFor();
  await discoveryDialog
    .getByRole("textbox", { name: "Base URL" })
    .fill("https://openrouter.ai/api/v1/chat/completions");
  await discoveryDialog
    .getByRole("textbox", { name: "API Key" })
    .fill("fixture-discovery-key");
  await discoveryDialog
    .getByRole("button", { name: "检测连接并获取模型" })
    .click();
  await discoveryDialog.getByText(/服务返回 3 个模型/).waitFor();
  assert.equal(
    await discoveryDialog
      .getByRole("textbox", { name: "Base URL" })
      .inputValue(),
    "https://openrouter.ai/api/v1",
  );
  assert.equal(modelDiscoveryRequests.length, 1);
  assert.equal(modelDiscoveryRequests[0].token, "fixture-session-token");
  assert.equal(modelDiscoveryRequests[0].body.apiKey, "fixture-discovery-key");
  const modelInput = discoveryDialog.getByRole("combobox", { name: "模型 ID" });
  await modelInput.fill("gpt");
  assert.deepEqual(
    await discoveryDialog.getByRole("option").allTextContents(),
    ["openai/gpt-exampleGPT Example"],
  );
  await modelInput.press("Enter");
  assert.equal(await modelInput.inputValue(), "openai/gpt-example");
  await modelInput.fill("qwen3.8");
  assert.equal(await discoveryDialog.getByRole("option").count(), 2);
  await discoveryDialog.getByRole("option").first().click();
  assert.equal(await modelInput.inputValue(), "qwen/qwen3.8-27b:free");
  assert.equal(
    chatRequests.length,
    4,
    "listing models called the chat endpoint",
  );
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify(localStorage).includes("fixture-discovery-key"),
    ),
    false,
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "模型连接" })
    .waitFor({ state: "hidden" });
  await switchView(page, "editor", "简历编辑");
  await chooseReference(page, "姓名", "姓名");
  await composer.fill("delayed-cancel");
  await page.getByRole("button", { name: "发送消息" }).click();
  for (let attempt = 0; attempt < 100 && !releaseLateResponse; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(releaseLateResponse, "the delayed model response was not held");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".agent-stack-slab")].some(
      (element) => element.getAnimations().length > 0,
    ),
  );
  await page.getByRole("button", { name: "停止请求" }).click();
  releaseLateResponse();
  await page.waitForTimeout(150);
  assert.equal(await page.locator(".agent-proposal").count(), 0);
  await page
    .locator(".paper:not(.layout-measure)")
    .first()
    .getByText("Compared Name", { exact: true })
    .waitFor();

  await chooseReference(page, "姓名", "姓名");
  await composer.fill("background-run");
  await page.getByRole("button", { name: "发送消息" }).click();
  for (
    let attempt = 0;
    attempt < 100 && !releaseBackgroundResponse;
    attempt += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(releaseBackgroundResponse);
  await switchView(page, "templates", "模板");
  await page.getByRole("button", { name: "最小化到 Bot" }).click();
  assert.equal(await page.locator(".agent-shared-mark").count(), 1);
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".agent-stack-slab")].some(
      (element) => element.getAnimations().length > 0,
    ),
  );
  releaseBackgroundResponse();
  await page.getByRole("button", { name: "展开 Re:me 助手" }).click();
  await page.locator(".agent-proposal").waitFor();
  await page
    .locator(".agent-proposal")
    .getByRole("button", { name: "拒绝" })
    .click();
  await switchView(page, "editor", "简历编辑");

  await chooseReference(page, "现居城市", "现居城市");
  await chooseSkill(page, "优化表达", "优化表达");
  await composer.fill("请改写空字段");
  const requestsBeforeEmpty = chatRequests.length;
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.getByText(/还没有可改写的事实/).waitFor();
  assert.equal(chatRequests.length, requestsBeforeEmpty);
  await page.getByRole("button", { name: /移除引用 现居城市/ }).click();
  await page.getByRole("button", { name: /移除技能/ }).click();

  await chooseReference(page, "姓名", "姓名");
  await composer.fill("multi-turn-read");
  await page.getByRole("button", { name: "发送消息" }).click();
  await page.locator(".agent-proposal").waitFor();
  const multiTurnRequests = chatRequests.filter((request) =>
    request.messages.some((message) =>
      message.content.includes("multi-turn-read"),
    ),
  );
  assert.equal(multiTurnRequests.length, 2);
  const readResult = JSON.parse(multiTurnRequests[1].messages.at(-1).content);
  assert.equal(readResult.ok, true);
  assert.equal(readResult.data.value, "Compared Name");
  assert.doesNotMatch(
    JSON.stringify(multiTurnRequests),
    /15500001111|private@example\.test/,
  );
  await page
    .locator(".agent-proposal")
    .getByRole("button", { name: "拒绝" })
    .click();

  const sessionContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  try {
    const sessionPage = await sessionContext.newPage();
    await sessionPage.route("**/api/agent/config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configured: false, provider: null, keyStorage: "local-account", authRequired: true, account: { id: "fixture-account", email: "fixture@example.com" }, sessionToken: "fixture-session-token" }),
      });
    });
    await sessionPage.goto(`http://127.0.0.1:${server.address().port}`);
    const sessionComposer = sessionPage.getByRole("textbox", {
      name: "给 Re:me 助手发送消息",
    });
    await sessionComposer.fill("/settings");
    await sessionComposer.press("Enter");
    await sessionPage.getByRole("dialog", { name: "模型连接" }).waitFor();
    await sessionPage.getByRole("button", { name: "关闭模型设置" }).click();
    await sessionComposer.fill("第一段会话");
    await sessionComposer.press("Enter");
    await sessionPage.getByRole("dialog", { name: "模型连接" }).waitFor();
    await sessionPage.getByRole("button", { name: "关闭模型设置" }).click();
    await sessionPage.getByRole("button", { name: "新建对话" }).click();
    await sessionComposer.fill("第二段会话");
    await sessionComposer.press("Enter");
    await sessionPage.getByRole("dialog", { name: "模型连接" }).waitFor();
    await sessionPage.getByRole("button", { name: "关闭模型设置" }).click();
    await sessionPage.reload();
    if (await sessionPage.getByRole("button", { name: "展开聊天" }).count())
      await sessionPage.getByRole("button", { name: "展开聊天" }).click();
    await sessionPage.getByRole("button", { name: "历史对话" }).click();
    const history = sessionPage.getByLabel("历史对话列表");
    await history.getByRole("button", { name: /第一段会话/ }).click();
    await sessionPage.getByText("第一段会话", { exact: true }).waitFor();
    assert.match(
      await sessionPage.locator(".agent-message-user").last().innerText(),
      /第一段会话/,
    );
    await sessionPage.getByRole("button", { name: "收起聊天" }).click();
    assert.equal(
      await sessionPage.getByRole("button", { name: "历史对话" }).count(),
      0,
    );
    await sessionPage.getByRole("button", { name: "引用对象" }).click();
    assert.equal(await sessionPage.getByRole("listbox", { name: "选择引用" }).count(), 0);
    await sessionPage.getByRole("button", { name: "展开聊天" }).click();
    await sessionPage.getByRole("listbox", { name: "选择引用" }).waitFor();
    await sessionPage.getByText(/可引用对象 · /).waitFor();
    assert.ok(await sessionPage.getByRole("option", { name: /实习经历/ }).count());
    assert.match(
      await sessionPage.locator("[data-agent-overlay]").getAttribute("class"),
      /agent-mode-chat/,
    );
    await switchView(sessionPage, "templates", "模板");
    await sessionComposer.fill("@模板导入");
    assert.ok(await sessionPage.getByRole("option", { name: /模板导入与识别/ }).count());
    await switchView(sessionPage, "versions", "版本管理");
    await sessionComposer.fill("@版本比较");
    assert.ok(await sessionPage.getByRole("option", { name: /版本比较/ }).count());
  } finally {
    await sessionContext.close();
  }

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const mobilePage = await mobileContext.newPage();
    await mobilePage.route("**/api/agent/config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configured: false, provider: null, keyStorage: "local-account", authRequired: true, account: { id: "mobile-fixture", email: "mobile@example.com" }, sessionToken: "fixture-session-token" }),
      });
    });
    await mobilePage.route("**/api/agent/models", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          baseUrl: "https://openrouter.ai/api/v1",
          count: 3,
          models: [
            { id: "qwen/qwen3.8-27b:free", name: "Qwen 3.8 Free" },
            { id: "qwen/qwen3.8-72b", name: "Qwen 3.8" },
            { id: "openai/gpt-example", name: "GPT Example" },
          ],
        }),
      });
    });
    await mobilePage.goto(`http://127.0.0.1:${server.address().port}`);
    await mobilePage.getByRole("button", { name: "展开 Re:me 助手" }).click();
    const settingsButton = mobilePage.getByRole("button", { name: "模型设置" });
    await settingsButton.waitFor();
    await mobilePage.waitForFunction(() => {
      const bounds = document
        .querySelector("[data-agent-overlay]")
        ?.getBoundingClientRect();
      return Boolean(bounds && bounds.left >= 0 && bounds.right <= innerWidth);
    });
    await mobilePage.waitForTimeout(500);
    await mobilePage.screenshot({
      path: path.join(projectRoot, ".artifacts", "agent-mobile-sheet.png"),
    });
    const mobileComposer = mobilePage.getByRole("textbox", {
      name: "给 Re:me 助手发送消息",
    });
    await mobileComposer.fill("中文输入中");
    await mobileComposer.dispatchEvent("compositionstart");
    await mobileComposer.press("Enter");
    await mobileComposer.dispatchEvent("compositionend");
    await mobileComposer.press("Enter");
    assert.match(
      await mobileComposer.inputValue(),
      /^中文输入中/,
      "IME confirmation must not clear the draft",
    );
    assert.equal(
      await mobilePage.locator(".agent-message-user").count(),
      0,
      "IME confirmation must not send a message",
    );
    await mobilePage.setViewportSize({ width: 390, height: 500 });
    await mobilePage.waitForFunction(() => {
      const bounds = document
        .querySelector("[data-agent-overlay]")
        ?.getBoundingClientRect();
      return Boolean(
        bounds &&
        bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight,
      );
    });
    await mobilePage.setViewportSize({ width: 390, height: 844 });
    await settingsButton.click();
    const dialog = mobilePage.getByRole("dialog", { name: "模型连接" });
    await dialog.waitFor();
    await mobilePage.waitForTimeout(250);
    await mobilePage.screenshot({
      path: path.join(projectRoot, ".artifacts", "agent-settings-mobile.png"),
    });
    const settingsType = await dialog.evaluate((element) => ({
      intro: parseFloat(
        getComputedStyle(element.querySelector(".agent-settings-intro"))
          .fontSize,
      ),
      label: parseFloat(
        getComputedStyle(element.querySelector("label")).fontSize,
      ),
      input: parseFloat(
        getComputedStyle(element.querySelector("input")).fontSize,
      ),
      footer: parseFloat(
        getComputedStyle(element.querySelector("footer")).fontSize,
      ),
    }));
    assert.ok(
      settingsType.intro >= 13 &&
        settingsType.label >= 13 &&
        settingsType.input >= 13 &&
        settingsType.footer >= 11,
      `model settings text is too small: ${JSON.stringify(settingsType)}`,
    );
    assert.equal(
      await mobilePage.locator(":focus").getAttribute("aria-label"),
      "关闭模型设置",
    );
    await dialog
      .getByRole("textbox", { name: "Base URL" })
      .fill("https://openrouter.ai/api/v1/chat/completions");
    await dialog.getByRole("textbox", { name: "API Key" }).fill("fixture-key");
    await dialog
      .getByRole("button", { name: "检测连接并获取模型" })
      .click();
    await dialog.getByText(/服务返回 3 个模型/).waitFor();
    await dialog.getByRole("combobox", { name: "模型 ID" }).fill("qwen");
    const suggestionBounds = await dialog.getByRole("listbox").boundingBox();
    const dialogBounds = await dialog.boundingBox();
    assert.ok(suggestionBounds && dialogBounds);
    assert.ok(
      suggestionBounds.y >= dialogBounds.y &&
        suggestionBounds.y + suggestionBounds.height <=
          dialogBounds.y + dialogBounds.height,
      "mobile model suggestions should remain within the settings dialog",
    );
    await dialog.getByRole("option").first().click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "项目能力自检" }).click();
    await dialog.getByText(/项目 Harness 自检通过/).waitFor();
    await dialog.getByRole("textbox", { name: "连接名称" }).fill("本地模型");
    await dialog
      .getByRole("textbox", { name: "Base URL" })
      .fill("http://127.0.0.1:1234/v1");
    await dialog.getByRole("combobox", { name: "模型 ID" }).fill("local-model");
    assert.ok(
      await dialog.getByRole("button", { name: "测试连接" }).isEnabled(),
    );
    assert.ok(
      await dialog.getByRole("button", { name: "保存连接" }).isEnabled(),
    );
    await mobilePage.keyboard.press("Shift+Tab");
    assert.ok(await dialog.locator(":focus").count());
    await mobilePage.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.ok(
      await settingsButton.evaluate(
        (button) => button === document.activeElement,
      ),
    );
    for (let index = 0; index < 10; index += 1) {
      await mobilePage.getByRole("button", { name: "最小化到 Bot" }).click();
      await mobilePage.getByRole("button", { name: "展开 Re:me 助手" }).click();
    }
    assert.equal(await mobilePage.locator("[data-agent-overlay]").count(), 1);
    await mobilePage
      .getByRole("button", { name: "展开 Re:me 助手" })
      .waitFor({ state: "hidden" });
    assert.equal(
      await mobilePage.getByRole("button", { name: "展开 Re:me 助手" }).count(),
      0,
    );
  } finally {
    await mobileContext.close();
  }

  const positionContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  try {
    const positionPage = await positionContext.newPage();
    await positionPage.goto(`http://127.0.0.1:${server.address().port}`);
    const shell = positionPage.locator("[data-agent-overlay]");
    const immediateBox = await shell.boundingBox();
    await positionPage.waitForTimeout(550);
    const initialBox = await shell.boundingBox();
    assert.ok(initialBox && immediateBox);
    assert.ok(
      Math.abs(immediateBox.x - initialBox.x) < 3 &&
        Math.abs(immediateBox.y - initialBox.y) < 3,
      "assistant flew in from a temporary position after refresh",
    );
    const composerInput = positionPage.getByRole("textbox", {
      name: "给 Re:me 助手发送消息",
    });
    const composerInputBox = await composerInput.boundingBox();
    await positionPage.getByRole("button", { name: "展开聊天" }).click();
    await positionPage.waitForTimeout(500);
    const chatInputBox = await composerInput.boundingBox();
    assert.ok(composerInputBox && chatInputBox);
    assert.ok(
      Math.abs(composerInputBox.y - chatInputBox.y) < 3,
      "message input jumped when chat expanded",
    );
    await positionPage.getByRole("button", { name: "收起聊天" }).click();
    await positionPage.waitForTimeout(500);
    const collapsedInputBox = await composerInput.boundingBox();
    assert.ok(
      collapsedInputBox &&
        Math.abs(composerInputBox.y - collapsedInputBox.y) < 3,
      "message input jumped when chat collapsed",
    );
    const header = await positionPage
      .locator(".agent-heading-brand")
      .boundingBox();
    assert.ok(header);
    await positionPage.mouse.move(header.x + 50, header.y + header.height / 2);
    await positionPage.mouse.down();
    await positionPage.mouse.move(header.x + 130, header.y - 50, { steps: 6 });
    await positionPage.waitForTimeout(80);
    const movingBox = await shell.boundingBox();
    assert.ok(
      movingBox && movingBox.x - initialBox.x > 40,
      "assistant did not follow the pointer during drag",
    );
    await positionPage.mouse.move(header.x + 210, header.y - 100, {
      steps: 12,
    });
    await positionPage.mouse.up();
    await positionPage.waitForTimeout(350);
    assert.equal(
      await positionPage.evaluate(() => window.getSelection()?.toString()),
      "",
    );
    const draggedBox = await shell.boundingBox();
    assert.ok(draggedBox);
    assert.ok(Math.abs(draggedBox.x - initialBox.x) > 100);
    assert.ok(Math.abs(draggedBox.y - initialBox.y) > 50);
    assert.ok(
      await positionPage.evaluate(() =>
        localStorage.getItem("resume-diy-agent-position-v1"),
      ),
    );
    for (const [view, label] of [
      ["templates", "模板"],
      ["versions", "版本管理"],
      ["editor", "简历编辑"],
    ]) {
      await switchView(positionPage, view, label);
      await positionPage.waitForTimeout(350);
      const box = await shell.boundingBox();
      assert.ok(box);
      assert.ok(
        Math.abs(box.x - draggedBox.x) < 3 &&
          Math.abs(box.y - draggedBox.y) < 3,
        `assistant moved while switching to ${view}`,
      );
    }
    await positionPage.reload();
    await shell.waitFor();
    await positionPage.waitForTimeout(350);
    const restoredBox = await shell.boundingBox();
    assert.ok(restoredBox);
    assert.ok(
      Math.abs(restoredBox.x - draggedBox.x) < 3 &&
        Math.abs(restoredBox.y - draggedBox.y) < 3,
      "assistant did not restore its dragged position after reload",
    );
    await positionPage.getByRole("button", { name: "最小化到 Bot" }).click();
    await positionPage.waitForTimeout(500);
    const botBox = await shell.boundingBox();
    assert.ok(botBox);
    assert.ok(
      Math.abs(botBox.x + botBox.width - restoredBox.x - restoredBox.width) < 3,
    );
    assert.ok(
      Math.abs(botBox.y + botBox.height - restoredBox.y - restoredBox.height) <
        3,
    );
    await positionPage.getByRole("button", { name: "展开 Re:me 助手" }).click();
    await positionPage.waitForTimeout(500);
    const reopenedBox = await shell.boundingBox();
    assert.ok(reopenedBox);
    assert.ok(
      Math.abs(reopenedBox.x - restoredBox.x) < 3 &&
        Math.abs(reopenedBox.y - restoredBox.y) < 3,
    );
    await positionPage.getByRole("button", { name: "最小化到 Bot" }).click();
    await positionPage.waitForTimeout(500);
    const botDragStart = await shell.boundingBox();
    assert.ok(botDragStart);
    await positionPage.mouse.move(botDragStart.x + 28, botDragStart.y + 28);
    await positionPage.mouse.down();
    await positionPage.mouse.move(botDragStart.x - 92, botDragStart.y - 52, {
      steps: 10,
    });
    await positionPage.mouse.up();
    await positionPage.waitForTimeout(350);
    const movedBot = await shell.boundingBox();
    assert.ok(movedBot && botDragStart.x - movedBot.x > 80);
    await positionPage.getByRole("button", { name: "展开 Re:me 助手" }).click();
    await positionPage.waitForTimeout(500);
    const movedPanel = await shell.boundingBox();
    assert.ok(movedPanel && restoredBox.x - movedPanel.x > 80);
    await positionPage.reload();
    await positionPage.waitForTimeout(350);
    const botDragRestored = await shell.boundingBox();
    assert.ok(
      botDragRestored && Math.abs(botDragRestored.x - movedPanel.x) < 3,
    );
  } finally {
    await positionContext.close();
  }

  const duplicateContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  try {
    await duplicateContext.addInitScript(
      (resume) => {
        localStorage.setItem("resume-diy-state", JSON.stringify(resume));
      },
      {
        ...fixtureResume,
        work: [
          {
            id: "same-title-first",
            title: "同名项目",
            role: "工程师",
            department: "",
            city: "",
            start: "2020",
            end: "2021",
            html: "<p>first fact</p>",
          },
          {
            id: "same-title-second",
            title: "同名项目",
            role: "负责人",
            department: "",
            city: "",
            start: "2022",
            end: "2023",
            html: "<p>second fact</p>",
          },
        ],
      },
    );
    const duplicatePage = await duplicateContext.newPage();
    await duplicatePage.goto(`http://127.0.0.1:${server.address().port}`);
    const duplicateComposer = duplicatePage.getByRole("textbox", {
      name: "给 Re:me 助手发送消息",
    });
    await duplicatePage.getByRole("button", { name: "展开聊天" }).click();
    await duplicateComposer.fill("@同名项目");
    const options = await duplicatePage.getByRole("option").allTextContents();
    assert.equal(options.length, 2);
    assert.ok(
      options.some(
        (option) => option.includes("工程师") && option.includes("le-first"),
      ),
    );
    assert.ok(
      options.some(
        (option) => option.includes("负责人") && option.includes("-second"),
      ),
    );
    await duplicatePage.getByRole("option", { name: /负责人/ }).click();
    assert.match(
      await duplicatePage.locator(".agent-chips").innerText(),
      /-second/,
    );
  } finally {
    await duplicateContext.close();
  }

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      pass: true,
      checks: [
        "one conversation and selected reference persist across 20 workspace switches",
        "only explicitly referenced personal fields reach the controlled model route",
        "edit proposal waits for confirmation and updates the live A4 preview",
        "accepted edit can be undone while its target still matches",
        "undo refuses to overwrite later manual edits",
        "stale edit and template proposals reject changed resume state",
        "switching branches rejects an old edit proposal even when the target field matches",
        "local template apply uses the host workflow without a model call",
        "confirmed version save persists in the isolated browser profile",
        "local version comparison reports redacted field-level changes without a model call",
        "settings skill opens the local model dialog without a model call",
        "direct /settings command, browser-local session history, switching, and reload recovery",
        "@ expands compact composer and lists page-level features across editor, templates, and versions",
        "brand stack logo animates during active requests and remains continuous in Bot mode",
        "model discovery reports count, normalizes Base URL, and offers keyboard and pointer prefix suggestions",
        "cancelled run discards a late model proposal",
        "minimizing and switching pages preserves an in-flight run and its original target",
        "multi-turn read returns only the selected field before a proposal",
        "empty selected fields request confirmed facts without invoking the model",
        "mobile assistant stays inside resized viewport, IME Enter does not send, and 10 Bot cycles preserve settings focus",
        "assistant opens at its final position, keeps the message input fixed, and dragging does not select text",
        "dragged position survives all three workspaces, reload, and Bot-to-panel transitions",
        "same-title references show role, dates, and stable ID in the menu and selected chip",
      ],
      modelRequests: chatRequests.length,
      errors,
    }),
  );
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
