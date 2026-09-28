import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { chromium } from "playwright";

const moduleKeys = ["education", "skills", "work", "projects", "orgs", "research", "awards", "other", "portfolio", "custom"];

function snapshot() {
  return {
    resumeTitle: "完整旧简历",
    summaryTitle: "我的小结",
    resume: {
      basic: { name: "张三", phone: "", email: "", city: "", wechat: "", birth: "", ageMode: "age", avatar: "" },
      ...Object.fromEntries(moduleKeys.map((key) => [key, []])),
      summary: "<p>中文&nbsp;<b>总结</b></p>",
      work: [{ id: "work-1", title: "工程师", role: "开发", department: "", city: "", start: "2023", end: "至今", html: "<p>第一行<br>第二行</p>" }],
      custom: [{ id: "hidden-1", title: "保留隐藏内容", role: "", department: "", city: "", start: "", end: "", html: "<p>秘密</p>" }],
    },
    moduleOrder: ["work", "summary", "education"],
    moduleNames: Object.fromEntries(moduleKeys.map((key) => [key, key === "work" ? "工作经历" : key])),
    presentation: { templateId: "legacy-v1", templateVersion: 1, densityPreset: "standard", overrides: { headingFontSize: "14", paragraphSpacing: "2", listSpacing: "1", unknownSafe: "keep" } },
    layout: { font: "宋体", fontSize: "13", lineHeight: "16", moduleSpacing: "8", pageMargin: "30", theme: "#000000", dateFormat: "2021年1月", titleFormat: "单行标题", separator: "使用分隔符号", textAlign: "两端对齐" },
    importedTemplate: null,
  };
}

test("legacy snapshot maps all sections and reports unresolved resources without committing", async () => {
  const parserSource = await readFile(resolve(import.meta.dirname, "../../src/bridge/legacyRichText.ts"), "utf8");
  const snapshotSource = await readFile(resolve(import.meta.dirname, "../../src/bridge/legacySnapshot.ts"), "utf8");
  const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 };
  const parserCode = ts.transpileModule(parserSource, { compilerOptions }).outputText;
  const snapshotCode = ts.transpileModule(snapshotSource, { compilerOptions }).outputText;
  assert.match(snapshotCode, /import \{ parseLegacyRichHtml \} from "\.\/legacyRichText";/);
  const browserCode = snapshotCode.replace('import { parseLegacyRichHtml } from "./legacyRichText";',
    `const parseLegacyRichHtml = ${"window.parseLegacyRichHtml"};`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.evaluate(async ({ parserCode, browserCode }) => {
      const parserUrl = URL.createObjectURL(new Blob([parserCode], { type: "text/javascript" }));
      try { window.parseLegacyRichHtml = (await import(parserUrl)).parseLegacyRichHtml; }
      finally { URL.revokeObjectURL(parserUrl); }
      const url = URL.createObjectURL(new Blob([browserCode], { type: "text/javascript" }));
      try { window.inspectLegacySnapshot = (await import(url)).inspectLegacySnapshot; }
      finally { URL.revokeObjectURL(url); }
    }, { parserCode, browserCode });

    const source = snapshot();
    const result = await page.evaluate((value) => window.inspectLegacySnapshot(value, "doc-1"), source);
    assert.equal(result.complete, false);
    assert.deepEqual(result.issues.map((issue) => issue.issueKind), ["fontResourcePending"]);
    assert.deepEqual(result.source, source);
    assert.deepEqual(result.document.sections.map((section) => section.kind), ["work", "summary", "education", "skills", "projects", "orgs", "research", "awards", "other", "portfolio", "custom"]);
    assert.deepEqual(result.document.sections.map((section) => section.visible), [true, true, true, false, false, false, false, false, false, false, false]);
    assert.equal(result.document.sections[0].entries[0].id, "work-1");
    assert.equal(result.document.sections.at(-1).entries[0].id, "hidden-1");
    assert.equal(result.document.presentation.fontSizePt, 9.75);
    assert.equal(result.document.presentation.lineHeightPt, 12);
    assert.equal(result.document.presentation.pageMarginPt, 22.5);
    assert.equal(result.document.presentation.headingSizePt, 10.5);
    assert.equal(result.document.presentation.legacyOverrides.unknownSafe, "keep");
    assert.equal(result.document.presentation.legacyOverrides["legacyLayout.font"], "宋体");
    assert.equal(result.document.sections[1].body[0].children[0].text, "中文\u00a0");

    const avatar = snapshot();
    avatar.resume.basic.avatar = "data:image/png;base64,ZmFrZQ==";
    const withAvatar = await page.evaluate((value) => window.inspectLegacySnapshot(value, "doc-2"), avatar);
    assert.deepEqual(withAvatar.issues.map((issue) => issue.issueKind), ["fontResourcePending", "avatarResourcePending"]);
    assert.equal(withAvatar.document.legacyExtensions.legacyAvatar, avatar.resume.basic.avatar);

    const unsupported = snapshot();
    unsupported.resume.work[0].html = '<p><img src="missing.png">文本</p>';
    unsupported.presentation.templateVersion = 99;
    const partial = await page.evaluate((value) => window.inspectLegacySnapshot(value, "doc-3"), unsupported);
    assert.ok(partial.issues.some((issue) => issue.issueKind === "richText" && issue.path.includes("work[0]")));
    assert.ok(partial.issues.some((issue) => issue.issueKind === "unsupportedTemplate"));
    assert.equal(partial.source.resume.work[0].html, unsupported.resume.work[0].html);

    const duplicate = snapshot();
    duplicate.moduleOrder.push("work");
    duplicate.resume.custom[0].id = "work-1";
    const conflict = await page.evaluate((value) => window.inspectLegacySnapshot(value, "doc-4"), duplicate);
    assert.ok(conflict.issues.some((issue) => issue.issueKind === "duplicateSection"));
    assert.ok(conflict.issues.some((issue) => issue.issueKind === "duplicateEntry"));
    assert.equal(conflict.document.sections.length, 11);

    const malformed = snapshot();
    malformed.layout.fontSize = "calc(100vw)";
    const badLayout = await page.evaluate((value) => window.inspectLegacySnapshot(value, "doc-5"), malformed);
    assert.ok(badLayout.issues.some((issue) => issue.issueKind === "invalidLayout"));
    assert.equal(badLayout.complete, false);

    const alternate = snapshot();
    alternate.presentation = { templateId: "clear-single-v1", templateVersion: 1, densityPreset: "comfortable", overrides: {} };
    alternate.importedTemplate = { id: "import-1", name: "用户模板" };
    alternate.resume.basic.legacyField = "须保留";
    const alternateResult = await page.evaluate((value) => window.inspectLegacySnapshot(value, "doc-6"), alternate);
    assert.equal(alternateResult.document.presentation.headingSizePt, 12);
    assert.equal(alternateResult.document.presentation.paragraphGapPt, 3);
    assert.equal(alternateResult.document.presentation.listGapPt, 1.5);
    assert.ok(alternateResult.issues.some((issue) => issue.issueKind === "unknownField" && issue.path === "resume.basic.legacyField"));
    assert.ok(alternateResult.issues.some((issue) => issue.issueKind === "importedTemplatePending"));
    assert.equal(alternateResult.source.resume.basic.legacyField, "须保留");
  } finally {
    await context.close();
    await browser.close();
  }
});
