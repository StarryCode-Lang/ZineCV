import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { preview } from "vite";
import { agentGatewayPlugin } from "../server/agent-gateway.mjs";
import { versionStoragePlugin } from "../server/version-storage.mjs";

const output = resolve(".artifacts/agent-auth-ui");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "data-"));
const server = await preview({
  configFile: false,
  plugins: [
    versionStoragePlugin({ directory }),
    agentGatewayPlugin({ authDirectory: directory }),
  ],
  preview: { host: "127.0.0.1", port: 0, open: false },
});
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  await page.getByRole("button", { name: "模型设置" }).click();
  const dialog = page.getByRole("dialog", { name: "模型连接" });
  await dialog.getByLabel("邮箱").fill("first@example.com");
  await dialog.getByLabel("密码").fill("test-password-12345");
  await dialog.getByRole("button", { name: "注册并登录" }).click();
  await dialog.getByText("已登录：first@example.com").waitFor();
  await dialog.getByRole("textbox", { name: "连接名称" }).fill("First model");
  await dialog
    .getByRole("textbox", { name: "Base URL" })
    .fill("http://127.0.0.1/v1");
  await dialog
    .getByRole("combobox", { name: "模型 ID" })
    .fill("local-model-one");
  await dialog.getByRole("button", { name: "保存连接" }).click();
  await dialog.getByText("连接已保存到此账户", { exact: false }).waitFor();
  await dialog.getByRole("button", { name: "关闭模型设置" }).click();
  await page
    .getByRole("textbox", { name: "给 Re:me 助手发送消息" })
    .fill("/help");
  await page
    .getByRole("textbox", { name: "给 Re:me 助手发送消息" })
    .press("Enter");
  await page.locator(".agent-message-user").first().waitFor();
  await page.getByRole("button", { name: "收起聊天" }).click();

  await page.reload();
  assert.match(
    await page.locator("[data-agent-overlay]").getAttribute("class"),
    /agent-mode-composer/,
  );
  await page.getByRole("button", { name: "模型设置" }).click();
  await dialog.getByText("已登录：first@example.com").waitFor();
  assert.equal(
    await dialog.getByRole("combobox", { name: "模型 ID" }).inputValue(),
    "local-model-one",
  );
  await dialog.getByRole("button", { name: "关闭模型设置" }).click();
  await page.getByRole("button", { name: "展开聊天" }).click();
  await page.locator(".agent-message-user").first().waitFor();
  await page.getByRole("button", { name: "模型设置" }).click();
  await dialog.getByRole("button", { name: "退出登录" }).click();
  await dialog.getByRole("button", { name: "注册并登录" }).waitFor();
  await dialog.getByLabel("邮箱").fill("second@example.com");
  await dialog.getByLabel("密码").fill("test-password-67890");
  await dialog.getByRole("button", { name: "注册并登录" }).click();
  await dialog.getByText("已登录：second@example.com").waitFor();
  assert.equal(
    await dialog.getByRole("combobox", { name: "模型 ID" }).inputValue(),
    "",
  );
  await dialog.getByRole("button", { name: "关闭模型设置" }).click();
  assert.equal(await page.locator(".agent-message-user").count(), 0);
  await page.getByRole("button", { name: "最小化到 Bot" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-agent-overlay]")?.getBoundingClientRect()
        .width < 58,
  );
  const originalBot = await page.locator("[data-agent-overlay]").boundingBox();
  await page.reload();
  await page.getByRole("button", { name: "展开 Re:me 助手" }).waitFor();
  assert.equal(await page.locator(".agent-status-dot").count(), 0);
  const mark = await page.locator(".agent-shared-mark").boundingBox();
  assert.ok(mark.width <= 41 && mark.height <= 41, JSON.stringify(mark));
  await page.mouse.move(900, 280);
  await page.evaluate(() => {
    window.__altKeys = [];
    window.addEventListener("keyup", (event) =>
      window.__altKeys.push({
        key: event.key,
        altKey: event.altKey,
        time: performance.now(),
      }),
    );
  });
  for (let index = 0; index < 2; index += 1) {
    await page.keyboard.down("Alt");
    await page.keyboard.up("Alt");
  }
  await page
    .locator(".agent-mode-chat")
    .waitFor({ timeout: 2500 })
    .catch(async (error) => {
      console.error(
        "alt diagnostics",
        await page.evaluate(() => window.__altKeys),
        await page.locator("[data-agent-overlay]").getAttribute("class"),
      );
      throw error;
    });
  await page.waitForFunction(
    () =>
      document.querySelector("[data-agent-overlay]")?.getBoundingClientRect()
        .width > 400,
  );
  const summoned = await page.locator("[data-agent-overlay]").boundingBox();
  assert.ok(
    Math.abs(summoned.x + summoned.width - 928) < 32,
    JSON.stringify(summoned),
  );
  for (let index = 0; index < 2; index += 1) {
    await page.keyboard.down("Alt");
    await page.keyboard.up("Alt");
  }
  await page.getByRole("button", { name: "展开 Re:me 助手" }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-agent-overlay]")?.getBoundingClientRect()
        .width < 58,
  );
  const restoredBot = await page.locator("[data-agent-overlay]").boundingBox();
  assert.ok(
    Math.abs(restoredBot.x - originalBot.x) < 3 &&
      Math.abs(restoredBot.y - originalBot.y) < 3,
    JSON.stringify({ originalBot, restoredBot }),
  );

  await page.getByRole("button", { name: "展开 Re:me 助手" }).click();
  if (await page.getByRole("button", { name: "展开聊天" }).count())
    await page.getByRole("button", { name: "展开聊天" }).click();
  const composer = page.getByRole("textbox", { name: "给 Re:me 助手发送消息" });
  await composer.fill("@");
  const choices = page.getByRole("listbox", { name: "选择引用" });
  await choices.waitFor();
  assert.equal(await choices.getByRole("option").count(), 7);
  await composer.press("ArrowDown");
  await composer.press("ArrowDown");
  await composer.press("ArrowDown");
  await composer.press("Tab");
  assert.match(await composer.inputValue(), /实习经历/);
  assert.equal(await choices.count(), 0);
  await page.getByRole("button", { name: "收起聊天" }).click();
  await composer.fill("@");
  assert.equal(await choices.count(), 0);
  await page.getByRole("button", { name: "展开聊天" }).click();
  await choices.waitFor();

  const header = page.locator(".agent-header");
  const beforeDrag = await header.boundingBox();
  await page.mouse.move(beforeDrag.x + 110, beforeDrag.y + 23);
  await page.mouse.down();
  await page.mouse.move(beforeDrag.x + 110, beforeDrag.y - 140, { steps: 6 });
  await page.mouse.up();
  const beforeSize = await page.locator("[data-agent-overlay]").boundingBox();
  const handle = await page
    .getByRole("button", { name: "调整助手窗口大小" })
    .boundingBox();
  await page.mouse.move(handle.x + 7, handle.y + 7);
  await page.mouse.down();
  await page.mouse.move(handle.x + 97, handle.y + 87, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const saved = JSON.parse(
      localStorage.getItem("resume-diy-agent-size-v1") ?? "null",
    );
    const rect = document
      .querySelector("[data-agent-overlay]")
      ?.getBoundingClientRect();
    return (
      saved?.chat &&
      rect &&
      Math.abs(rect.width - saved.chat.width) < 3 &&
      Math.abs(rect.height - saved.chat.height) < 3
    );
  });
  const afterSize = await page.locator("[data-agent-overlay]").boundingBox();
  assert.ok(
    afterSize.width > beforeSize.width + 40 &&
      afterSize.height > beforeSize.height + 40,
    JSON.stringify({ beforeSize, afterSize }),
  );
  await page.reload();
  const persistedSize = await page
    .locator("[data-agent-overlay]")
    .boundingBox();
  assert.ok(
    Math.abs(persistedSize.width - afterSize.width) < 3 &&
      Math.abs(persistedSize.height - afterSize.height) < 3,
    JSON.stringify({ beforeSize, afterSize, persistedSize }),
  );
  assert.equal(errors.length, 0, errors.join("; "));
  console.log(
    JSON.stringify({
      pass: true,
      checks: [
        "email registration through UI",
        "model config restores after page reload",
        "second account has no access to first model or chat history",
        "Bot mode and mark size persist through refresh",
        "double Alt summons and restores Bot",
        "@ lists current modules and Tab inserts the selection",
        "folded @ menu stays hidden",
        "manual dialog size persists",
        "no browser errors",
      ],
    }),
  );
} finally {
  await context.close();
  await browser.close();
  await new Promise((done) => server.httpServer.close(done));
}
