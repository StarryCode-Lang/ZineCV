import { test } from "node:test";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { createBrowserTestServer, launchBrowserTestChromium, listenForBrowserTestServer } from "./fixtures/browser-test-server.mjs";

test("React rich editor preserves schema, local history, selection, paste safety, and composition buffers", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const server = await createBrowserTestServer(root);
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, reducedMotion: "reduce" });
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${address.port}`;
    await page.goto(`${origin}/__zinecv_browser_test_page.html`, { waitUntil: "commit" });
    await page.waitForFunction(() => typeof window.$RefreshReg$ === "function", undefined, { timeout: 30_000 });
    await page.evaluate(() => import("/tests/browser/fixtures/mount-rich-editor.tsx"));

    const summary = page.locator('[data-rich-field="summary"]');
    const firstSameName = page.locator('[data-rich-field="work:same-id"]');
    const sameIdInAnotherModule = page.locator('[data-rich-field="education:same-id"]');
    await summary.waitFor();
    for (const module of ["education", "skills", "work", "projects", "orgs", "research", "awards", "other", "portfolio", "custom"]) {
      await page.locator(`[data-rich-field="${module}:same-id"]`).waitFor();
    }
    assert.equal(await summary.getAttribute("contenteditable"), "true");
    assert.match(await summary.innerHTML(), /start="4"/);
    assert.match(await summary.innerHTML(), /嵌套项/);

    for (const optionalField of [
      "个人网站 1", "个人网站 2", "性别", "身高", "体重", "民族", "籍贯",
      "政治面貌", "婚姻状况", "星座", "MBTI",
    ]) {
      await page.getByRole("button", { name: new RegExp(optionalField) }).click();
      await page.getByLabel(optionalField).waitFor();
      await page.getByLabel(optionalField).fill(`合成${optionalField}`);
    }
    for (const fixedField of ["姓名", "电话", "邮箱", "现居城市", "微信", "年龄或生日"]) {
      const field = page.getByLabel(fixedField);
      await field.fill(fixedField === "年龄或生日" ? "2000-05" : `合成${fixedField}`);
    }
    await page.getByRole("button", { name: "生日" }).click();
    assert.equal(await page.getByRole("button", { name: "生日" }).getAttribute("class"), "active");
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
      name: "synthetic.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"),
    });
    await page.getByAltText("头像预览").waitFor();

    const selectText = async (editor, text) => {
      await editor.evaluate((root, value) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const start = node.textContent.indexOf(value);
          if (start >= 0) {
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + value.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            root.focus();
            return;
          }
          node = walker.nextNode();
        }
        throw new Error(`Could not select ${value}`);
      }, text);
    };
    const toolbar = summary.locator("xpath=../..").locator(".rich-toolbar");

    await selectText(summary, "粗体");
    await toolbar.getByRole("button", { name: "粗体" }).click();
    assert.match(await summary.innerHTML(), /<(?:b|strong)>粗体<\/(?:b|strong)>/);
    await toolbar.getByRole("button", { name: "撤销" }).click();
    assert.doesNotMatch(await summary.innerHTML(), /<(?:b|strong)>粗体<\/(?:b|strong)>/);
    await toolbar.getByRole("button", { name: "重做" }).click();
    assert.match(await summary.innerHTML(), /<(?:b|strong)>粗体<\/(?:b|strong)>/);
    await selectText(summary, "粗体");
    await toolbar.getByRole("button", { name: "清除格式" }).click();
    assert.doesNotMatch(await summary.innerHTML(), /<(?:b|strong)>粗体<\/(?:b|strong)>/);

    for (const [text, label, tag] of [
      ["斜体", "斜体", "(?:i|em)"],
      ["下划线", "下划线", "u"],
      ["删除线", "删除线", "(?:s|strike|del)"],
    ]) {
      await selectText(summary, text);
      await toolbar.getByRole("button", { name: label }).click();
      assert.match(await summary.innerHTML(), new RegExp(`<${tag}>${text}</${tag}>`));
    }

    const entryToolbar = firstSameName.locator("xpath=../..").locator(".rich-toolbar");
    await selectText(firstSameName, "同名经历");
    await entryToolbar.getByRole("button", { name: "编号列表" }).click();
    assert.match(await firstSameName.innerHTML(), /<ol><li><p>同名经历<\/p><\/li><\/ol>/);
    await entryToolbar.getByRole("button", { name: "撤销" }).click();
    assert.match(await firstSameName.innerHTML(), /<p>同名经历<\/p>/);
    await selectText(firstSameName, "同名经历");
    await entryToolbar.getByRole("button", { name: "项目符号" }).click();
    assert.match(await firstSameName.innerHTML(), /<ul><li><p>同名经历<\/p><\/li><\/ul>/);
    await entryToolbar.getByRole("button", { name: "撤销" }).click();

    await selectText(summary, "链接目标");
    await toolbar.getByRole("button", { name: "插入链接" }).click();
    const linkDialog = page.getByRole("dialog", { name: "插入或编辑链接" });
    const linkInput = page.getByLabel("链接地址");
    await linkInput.fill("javascript:alert(1)");
    await page.getByRole("button", { name: "保存链接" }).click();
    await page.getByRole("alert").waitFor();
    assert.doesNotMatch(await summary.innerHTML(), /href="javascript:/i);
    await linkInput.fill("example.com/profile");
    await page.getByRole("button", { name: "保存链接" }).click();
    await linkDialog.waitFor({ state: "detached" });
    assert.match(await summary.innerHTML(), /<a href="https:\/\/example\.com\/profile">链接目标<\/a>/);

    await selectText(summary, "文本输入");
    await toolbar.getByRole("button", { name: "插入链接" }).click();
    await linkInput.fill("https://discarded.example");
    await linkInput.press("Escape");
    await linkDialog.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "文本输入");
    assert.doesNotMatch(await summary.innerHTML(), /discarded\.example/);

    const compositionCommitCount = page.getByLabel("自我评价提交次数");
    const countBeforeComposition = Number(await compositionCommitCount.textContent());
    await summary.evaluate((root) => {
      root.focus();
      root.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    });
    await page.keyboard.insertText("组");
    await summary.evaluate((root) => root.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "组" })));
    assert.match(await summary.innerHTML(), /组/);
    assert.equal(Number(await compositionCommitCount.textContent()), countBeforeComposition);
    await summary.evaluate((root) => root.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "组" })));
    await page.waitForTimeout(120);
    await page.waitForFunction((before) => Number(document.querySelector('[aria-label="自我评价提交次数"]')?.textContent) === before + 1, countBeforeComposition);
    assert.equal(Number(await compositionCommitCount.textContent()), countBeforeComposition + 1);

    await firstSameName.click();
    await firstSameName.press("End");
    await firstSameName.pressSequentially(" A");
    assert.match(await page.getByLabel("第一段同名经历").textContent(), /同名经历 A/);
    assert.equal((await page.getByLabel("第二段同名经历").textContent()).trim(), "<p>同名经历</p>");
    assert.equal(await sameIdInAnotherModule.textContent(), "同名经历");

    const paste = async (editor, types) => editor.evaluate((root, records) => {
      const data = new DataTransfer();
      for (const [type, value] of records) data.setData(type, value);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      root.dispatchEvent(event);
      return event.defaultPrevented;
    }, Object.entries(types));

    await firstSameName.evaluate((root) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      root.focus();
    });
    assert.equal(await paste(firstSameName, {
      "text/html": '<p onclick="window.pastePwned=true">粘贴<b>粗体</b><a href="javascript:alert(1)">危险链接</a><img src="x" onerror="window.pastePwned=true"></p>',
      "text/plain": "粘贴粗体危险链接",
    }), true);
    assert.match(await firstSameName.innerHTML(), /<(?:b|strong)>粗体<\/(?:b|strong)>/);
    assert.doesNotMatch(await firstSameName.innerHTML(), /javascript:|<img|onclick|onerror/i);
    assert.equal(await page.evaluate(() => window.pastePwned), undefined);

    await firstSameName.evaluate((root) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      root.focus();
    });
    await paste(firstSameName, { "text/plain": "第一行\n第二行" });
    assert.match(await firstSameName.innerHTML(), /第一行<br>第二行/);

    await page.getByRole("button", { name: "载入外部正文" }).click();
    await page.waitForFunction(() => document.querySelector('[data-rich-field="summary"]')?.textContent === "外部正文");
    const beforeScopeReset = await summary.innerHTML();
    await page.getByRole("button", { name: "切换编辑来源" }).click();
    await toolbar.getByRole("button", { name: "撤销" }).click();
    assert.equal(await summary.innerHTML(), beforeScopeReset);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});
