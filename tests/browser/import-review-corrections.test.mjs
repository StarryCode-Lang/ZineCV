import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { composePdf } from "../../fixtures/import-quality/materialize.mjs";
import { createBrowserTestServer, listenForBrowserTestServer, launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

const reviewPdf = () =>
  composePdf([{
    lines: [
      "Alex Sample",
      "13800000000",
      "alex@example.invalid",
      "Work Experience",
      "Example Labs 2020-07 - 2024-06",
      "Built offline storage.",
    ],
  }]);

async function openReviewDialog(page, server, bytes) {
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
  await page.evaluate(() => import("/tests/browser/fixtures/mount-import-review.tsx"));
  await page.locator("input[type=file]").setInputFiles({
    name: "review-sample.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await page.getByRole("dialog").getByRole("button", { name: "提取并审阅候选" }).click();
  await page.getByRole("heading", { name: "审阅导入内容" }).waitFor();
}

test("import review corrections edit fields, split and merge entries, reassign module and carry corrections into apply", { timeout: 120_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await openReviewDialog(page, server, reviewPdf());

    // The persisted source text reaches the review dialog for side-by-side
    // comparison; corrections never rewrite it.
    const summary = page.getByText(/原始全文（\d+ 字，供校正对照）/);
    await summary.click();
    await page.locator(".template-import-review-source pre").waitFor();
    assert.match(await page.locator(".template-import-review-source pre").textContent(), /Alex Sample/);

    // Basic field correction on the parsed name candidate.
    const nameRow = page.locator(".template-import-review-candidate").filter({ has: page.locator("strong", { hasText: "姓名" }) });
    await nameRow.getByRole("button", { name: "展开姓名校正" }).click();
    await page.getByLabel("校正姓名").fill("Alex Corrected");

    // Section correction: split the parsed entry at a caret, then merge back.
    const workRow = page.locator(".template-import-review-candidate").filter({ hasText: "1 条经历" });
    await workRow.getByRole("button", { name: /校正$/ }).click();
    const bodyArea = workRow.locator("textarea").first();
    await bodyArea.fill("Built offline storage.");
    // Move the caret like a user would (React tracks it via onSelect/selectionchange).
    await bodyArea.click();
    await page.keyboard.press("Home");
    for (let index = 0; index < 5; index += 1) await page.keyboard.press("ArrowRight");
    await workRow.getByRole("button", { name: "在光标处拆分经历 1" }).click();
    const splitSecond = workRow.locator("textarea").nth(1);
    await splitSecond.waitFor();
    assert.match(await splitSecond.inputValue(), /^ offline storage\.$/);
    await workRow.getByRole("button", { name: "将经历 1 与下一条合并" }).click();
    assert.equal(await workRow.locator("textarea").count(), 1);
    assert.equal(await workRow.locator("textarea").first().inputValue(), "Built\n offline storage.");

    // Module reassignment moves the reviewed entries to another module.
    const moduleSelect = page.getByLabel(/模块归属/);
    await moduleSelect.selectOption({ label: "项目经历" });
    assert.equal(await moduleSelect.inputValue(), "projects");

    await page.getByRole("button", { name: /确认应用 \d+ 项/ }).click();
    await page.waitForFunction(() => window.importReviewFixture.applies.length === 1);
    const applies = await page.evaluate(() => window.importReviewFixture.applies);
    assert.equal(applies.length, 1);
    const { draftId, acceptedCandidateIds, corrections } = applies[0];
    assert.match(draftId, /^import-draft-/);
    assert.ok(acceptedCandidateIds.length >= 2, "both parsed candidates stay confirmed");
    assert.equal(corrections.length, 2, "untouched candidates carry no corrections");
    const nameCorrection = corrections.find((correction) => correction.value.type === "basicField");
    assert.equal(nameCorrection.value.field, "name");
    assert.equal(nameCorrection.value.value, "Alex Corrected");
    const workCorrection = corrections.find((correction) => correction.value.type === "sectionEntries");
    assert.equal(workCorrection.value.kind, "projects");
    assert.equal(workCorrection.value.entries.length, 1);
    const mergedBody = workCorrection.value.entries[0].body
      .map((block) => block.children.map((child) => child.text ?? "").join("")).join("\n");
    assert.equal(mergedBody, "Built\n offline storage.");
    // The reviewed entry keeps its parsed identity here (merging re-adopts the
    // first row's ID); the storage host derives stable import-entry IDs at
    // apply time, which the native correction tests cover.
    const persisted = await page.evaluate(() => window.importReviewFixture.draft.extractedText);
    assert.match(persisted, /Alex Sample/, "extracted text is persisted with the draft");
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("review dialog shows an explicit empty state when an old draft has no source text and cancel still releases the draft", { timeout: 120_000 }, async () => {
  const server = await createBrowserTestServer(resolve(import.meta.dirname, "../.."));
  await listenForBrowserTestServer(server);
  const browser = await launchBrowserTestChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zinecv_browser_test_page.html`);
    await page.evaluate(() => import("/tests/browser/fixtures/mount-import-review.tsx"));
    await page.evaluate(() => { window.importReviewFixture.forceNullText = true; });
    await page.locator("input[type=file]").setInputFiles({
      name: "legacy-draft.pdf",
      mimeType: "application/pdf",
      buffer: reviewPdf(),
    });
    await page.getByRole("dialog").getByRole("button", { name: "提取并审阅候选" }).click();
    await page.getByRole("heading", { name: "审阅导入内容" }).waitFor();
    // Old drafts without a source-text resource show the empty state, not an error.
    await page.getByText("原始全文不可用", { exact: false }).waitFor();
    assert.equal(await page.locator(".template-import-review-source").count(), 0);

    await page.getByRole("button", { name: "取消导入", exact: true }).click();
    await page.getByRole("heading", { name: "审阅导入内容" }).waitFor({ state: "detached" });
    const terminal = await page.evaluate(() => window.importReviewFixture.draft.status);
    assert.equal(terminal, "cancelled");
  } finally {
    await browser?.close();
    await server.close();
  }
});
