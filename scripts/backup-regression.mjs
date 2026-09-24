import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { preview } from "vite";

import { versionStoragePlugin } from "../server/version-storage.mjs";

const output = resolve(".artifacts/backup");
await mkdir(output, { recursive: true });
const dataDirectory = await mkdtemp(join(output, "data-"));
const checks = [];
const pageErrors = [];
const failedFonts = [];
let server;
let browser;
let context;

async function chooseChapter(page, key) {
  await page.locator("[data-editor-nav-trigger]").click();
  const menu = page.getByRole("listbox", {
    name: "选择章节",
    exact: true,
  });
  await menu.locator(`[data-editor-nav-key="${key}"]`).click();
  await page.waitForFunction(
    (targetKey) =>
      document.querySelector("[data-editor-nav-trigger]")?.dataset
        .editorNavValue === targetKey,
    key,
  );
}

try {
  server = await preview({
    configFile: false,
    plugins: [versionStoragePlugin({ directory: dataDirectory })],
    preview: { host: "127.0.0.1", port: 0, open: false },
  });
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    if (request.url().includes("/fonts/")) failedFonts.push(request.url());
  });

  await page.goto(base);
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page.getByText("已保存到本机项目", { exact: true }).waitFor();
  await page.getByRole("button", { name: "简历编辑", exact: true }).click();
  await chooseChapter(page, "basic");
  await page.getByLabel("姓名", { exact: true }).fill("导出草稿");
  await page.getByRole("button", { name: "版本管理", exact: true }).click();
  await page
    .getByRole("button", { name: "有未提交修改，前往保存当前版本" })
    .waitFor();
  await page.getByLabel("附带当前未提交草稿").check();
  await page.getByRole("button", { name: "最小化到 Bot" }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出版本备份", exact: true }).click();
  const download = await downloadEvent;
  const downloadedPath = await download.path();
  assert.ok(downloadedPath);
  const backupPath = join(output, "exported-with-draft.json");
  await download.saveAs(backupPath);
  const backup = JSON.parse(await readFile(backupPath, "utf8"));
  assert.equal(backup.format, "resume-diy-version-backup");
  assert.equal(backup.formatVersion, 2);
  assert.equal(backup.draft.kind, "uncommitted-workspace");
  assert.equal(backup.store.commits.length, 1);
  checks.push(
    "exported complete version store with optional uncommitted draft and format marker",
  );

  const legacyBackup = structuredClone(backup);
  legacyBackup.formatVersion = 1;
  for (const commit of legacyBackup.store.commits) {
    delete commit.snapshot.schemaVersion;
    delete commit.snapshot.presentation;
  }
  delete legacyBackup.draft.snapshot.schemaVersion;
  delete legacyBackup.draft.snapshot.presentation;
  const legacyBackupPath = join(output, "legacy-v1-backup.json");
  await writeFile(
    legacyBackupPath,
    JSON.stringify(legacyBackup, null, 2),
    "utf8",
  );
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(legacyBackupPath);
  await page.getByText("包含 1 个分支、1 次提交", { exact: false }).waitFor();
  checks.push(
    "legacy format-1 backup without template metadata remains readable",
  );

  await page.getByLabel("版本说明").fill("导出前提交");
  await page
    .getByRole("button", { name: "提交到当前分支", exact: true })
    .click();
  await page.getByText("导出前提交", { exact: true }).waitFor();
  await page.getByRole("button", { name: "简历编辑", exact: true }).click();
  await page.getByLabel("姓名", { exact: true }).fill("当前改动");
  await page.getByRole("button", { name: "版本管理", exact: true }).click();

  const invalidJsonPath = join(output, "invalid.json");
  await writeFile(invalidJsonPath, "{broken", "utf8");
  await fileInput.setInputFiles(invalidJsonPath);
  await page.getByText("备份文件不是有效的 JSON", { exact: false }).waitFor();
  const currentBeforeImport = await readFile(
    join(dataDirectory, "versions.json"),
    "utf8",
  );
  checks.push(
    "invalid JSON import reports an error and keeps the current project file",
  );

  const unknownFormatPath = join(output, "unknown-format.json");
  await writeFile(
    unknownFormatPath,
    JSON.stringify({ format: "other-app", formatVersion: 1 }),
    "utf8",
  );
  await fileInput.setInputFiles(unknownFormatPath);
  await page
    .getByText("不是 resume DIY 版本备份文件", { exact: false })
    .waitFor();
  assert.equal(
    await readFile(join(dataDirectory, "versions.json"), "utf8"),
    currentBeforeImport,
  );

  await fileInput.setInputFiles(backupPath);
  await page.getByText("包含 1 个分支、1 次提交", { exact: false }).waitFor();
  assert.match(await page.locator(".resume-pages").innerText(), /当前改动/);
  checks.push("valid backup preview does not auto-load its draft");
  await page.getByRole("button", { name: "载入此草稿", exact: true }).click();
  assert.match(await page.locator(".resume-pages").innerText(), /导出草稿/);
  checks.push("draft is loaded only after the explicit load action");

  const beforeCancel = await readFile(
    join(dataDirectory, "versions.json"),
    "utf8",
  );
  await page
    .getByRole("button", { name: "替换当前版本库", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  assert.equal(
    await readFile(join(dataDirectory, "versions.json"), "utf8"),
    beforeCancel,
  );
  checks.push(
    "cancelled replacement leaves the current project file unchanged",
  );

  await page
    .getByRole("button", { name: "替换当前版本库", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "确认替换版本库", exact: true })
    .click();
  await page
    .getByText("版本库已替换，当前工作内容未自动变更", { exact: true })
    .waitFor();
  const replaced = JSON.parse(
    await readFile(join(dataDirectory, "versions.json"), "utf8"),
  );
  const previous = JSON.parse(
    await readFile(join(dataDirectory, "versions.backup.json"), "utf8"),
  );
  assert.equal(replaced.commits.length, 1);
  assert.equal(previous.commits.length, 2);
  assert.match(await page.locator(".resume-pages").innerText(), /导出草稿/);
  checks.push(
    "confirmed replacement writes the imported store, preserves the previous file backup and keeps work content explicit",
  );

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedFonts, []);
  const result = { status: "PASS", checks, pageErrors, failedFonts };
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context?.close();
  await browser?.close();
  if (server?.httpServer.listening)
    await new Promise((resolveServer) =>
      server.httpServer.close(resolveServer),
    );
}
