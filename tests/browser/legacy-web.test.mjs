/* 由 3 个同组测试文件合并；测试块自包含，行为与合并前一致。 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";
import ts from "typescript";

/* ==== 原 legacy-export.test.mjs ==== */

test("old-origin export reads only app keys after a click and leaves storage unchanged", async () => {
  const html = await readFile(resolve(import.meta.dirname, "../../public/legacy-export.html"), "utf8");
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await context.newPage();
    await page.route("http://127.0.0.1:5173/legacy-export.html", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("http://127.0.0.1:5173/legacy-export.html");
    await page.evaluate(() => {
      localStorage.setItem("resume-diy-state", '{"summary":"中文 草稿"}');
      localStorage.setItem("resume-diy-agent-sessions-v2:account-1", '{"sessions":[]}');
      localStorage.setItem("another-app-secret", "exclude-this");
    });
    await page.reload();
    assert.equal(await page.evaluate(() => localStorage.length), 3);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "下载浏览器数据" }).click(),
    ]);
    const chunks = [];
    for await (const chunk of await download.createReadStream()) chunks.push(chunk);
    const exported = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(exported.format, "zinecv-legacy-browser-export");
    assert.equal(exported.version, 1);
    assert.equal(exported.origin, "http://127.0.0.1:5173");
    assert.deepEqual(exported.entries, [
      ["resume-diy-agent-sessions-v2:account-1", '{"sessions":[]}'],
      ["resume-diy-state", '{"summary":"中文 草稿"}'],
    ]);
    assert.equal(exported.sourceHash, createHash("sha256").update(JSON.stringify(exported.entries)).digest("hex"));
    assert.equal(await page.evaluate(() => localStorage.getItem("another-app-secret")), "exclude-this");
    assert.equal(await page.evaluate(() => localStorage.length), 3);

    const wrongOrigin = await context.newPage();
    await wrongOrigin.route("http://127.0.0.1:5174/legacy-export.html", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    await wrongOrigin.goto("http://127.0.0.1:5174/legacy-export.html");
    assert.equal(await wrongOrigin.getByRole("button", { name: "下载浏览器数据" }).isDisabled(), true);
  } finally {
    await context.close();
    await browser.close();
  }
});

test("parallel browser leases isolate same-origin storage and survive peer teardown", async () => {
  const first = await launchBrowserTestChromium({ headless: true });
  const second = await launchBrowserTestChromium({ headless: true });
  try {
    const a = await first.newContext(), b = await second.newContext();
    const url = "http://127.0.0.1:5173/owned-isolation.html";
    for (const context of [a, b]) await context.route(url, route => route.fulfill({ contentType: "text/html", body: "<title>owned isolation</title>" }));
    const x = await a.newPage(), y = await b.newPage();
    await Promise.all([x.goto(url), y.goto(url)]);
    await x.evaluate(() => { localStorage.setItem("owned", "first"); document.cookie = "owned=first"; });
    assert.equal(await y.evaluate(() => localStorage.getItem("owned")), null);
    assert.equal(await y.evaluate(() => document.cookie), "");
    await first.close();
    await y.evaluate(() => localStorage.setItem("owned", "second"));
    assert.equal(await y.evaluate(() => localStorage.getItem("owned")), "second");
  } finally { await first.close(); await second.close(); }
});

/* ==== 原 legacy-richtext.test.mjs ==== */

test("legacy HTML maps to Rust rich blocks without silent semantic loss", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../../src/platform/legacyRichText.ts"), "utf8");
  const golden = JSON.parse(await readFile(resolve(import.meta.dirname, "../../fixtures/legacy-richtext-golden.json"), "utf8"));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.evaluate(async (code) => {
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      try {
        const module = await import(url);
        window.parseLegacyRichHtml = module.parseLegacyRichHtml;
        window.richBlocksToLegacyHtml = module.richBlocksToLegacyHtml;
      }
      finally { URL.revokeObjectURL(url); }
    }, compiled);

    const parsed = await page.evaluate((html) => window.parseLegacyRichHtml(html), golden.html);
    assert.equal(parsed.complete, true);
    assert.deepEqual(parsed.issues, []);
    assert.equal(parsed.rawHtml, golden.html);
    assert.deepEqual(parsed.blocks, golden.blocks);
    const roundTrip = await page.evaluate((blocks) => {
      const html = window.richBlocksToLegacyHtml(blocks);
      return { html, parsed: window.parseLegacyRichHtml(html) };
    }, parsed.blocks);
    assert.equal(roundTrip.parsed.complete, true);
    assert.deepEqual(roundTrip.parsed.blocks, parsed.blocks);

    const blank = await page.evaluate(() => window.parseLegacyRichHtml("<p><br></p>"));
    assert.equal(blank.complete, true);
    assert.deepEqual(blank.blocks, [{ type: "paragraph", children: [{ type: "break" }] }]);

    const unsafe = '<p data-x="1"><span style="font-weight:700">保留文字</span><a href="javascript:alert(1)">不安全链接</a><img src="x"></p>';
    const partial = await page.evaluate((html) => window.parseLegacyRichHtml(html), unsafe);
    assert.equal(partial.complete, false);
    assert.equal(partial.rawHtml, unsafe);
    assert.deepEqual(partial.issues.map((issue) => issue.issueCode), [
      "unsupportedAttribute", "unsupportedAttribute", "invalidLink", "unsupportedTag", "unsupportedAttribute",
    ]);
    assert.equal(partial.blocks[0].children.map((item) => item.text ?? "").join(""), "保留文字不安全链接");

    const movedHead = await page.evaluate(() => window.parseLegacyRichHtml('<meta name="x" content="y"><script>window.bad = true</script><p>正文</p>'));
    assert.equal(movedHead.complete, false);
    assert.ok(movedHead.issues.some((issue) => issue.issueCode === "unsupportedTag" && issue.name === "meta"));
    assert.ok(movedHead.issues.some((issue) => issue.issueCode === "unsupportedTag" && issue.name === "script"));
    assert.equal(movedHead.blocks[0].children[0].text, "正文");

    const whitespace = await page.evaluate(() => window.parseLegacyRichHtml("  "));
    assert.equal(whitespace.complete, false);
    assert.deepEqual(whitespace.issues.map((issue) => issue.issueCode), ["orphanWhitespace"]);
    assert.equal(whitespace.blocks[0].children[0].text, "  ");

    const oversized = await page.evaluate(() => window.parseLegacyRichHtml("x".repeat(1_000_001)));
    assert.equal(oversized.complete, false);
    assert.deepEqual(oversized.issues.map((issue) => issue.issueCode), ["resourceLimit"]);

    const escaped = await page.evaluate(() => window.richBlocksToLegacyHtml([
      { type: "paragraph", children: [{ type: "text", text: '<img src=x onerror="alert(1)">&', marks: [] }] },
    ]));
    assert.equal(escaped, '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;</p>');
    await assert.rejects(page.evaluate(() => window.richBlocksToLegacyHtml([
      { type: "paragraph", children: [{ type: "link", href: "javascript:alert(1)", children: [] }] },
    ])), /unsupported link/);
  } finally {
    await context.close();
    await browser.close();
  }
});

/* ==== 原 legacy-snapshot.test.mjs ==== */

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
  const parserSource = await readFile(resolve(import.meta.dirname, "../../src/platform/legacyRichText.ts"), "utf8");
  const snapshotSource = await readFile(resolve(import.meta.dirname, "../../src/platform/legacySnapshot.ts"), "utf8");
  const templateSource = await readFile(resolve(import.meta.dirname, "../../src/ui/domain/template-model.ts"), "utf8");
  const sourceEditsSource = await readFile(resolve(import.meta.dirname, "../../src/platform/sourceLayoutEdits.ts"), "utf8");
  const compilerOptions = { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 };
  const parserCode = ts.transpileModule(parserSource, { compilerOptions }).outputText;
  const snapshotCode = ts.transpileModule(snapshotSource, { compilerOptions }).outputText;
  const templateCode = ts.transpileModule(templateSource, { compilerOptions }).outputText;
  const sourceEditsCode = ts.transpileModule(sourceEditsSource, { compilerOptions }).outputText;
  assert.match(snapshotCode, /import \{ parseLegacyRichHtml \} from "\.\/legacyRichText";/);
  const browserCode = snapshotCode.replace('import { parseLegacyRichHtml } from "./legacyRichText";',
    `const parseLegacyRichHtml = ${"window.parseLegacyRichHtml"};`)
    .replace('import { resolveDensitySpacing } from "../ui/domain/template-model";', 'const { resolveDensitySpacing } = window.templateModelDeps;')
    .replace('import { parseSourceLayoutEdits } from "./sourceLayoutEdits";', 'const { parseSourceLayoutEdits } = window.sourceEditsDeps;');
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("about:blank");
    await page.evaluate(async ({ parserCode, browserCode, templateCode, sourceEditsCode }) => {
      const templateUrl = URL.createObjectURL(new Blob([templateCode], { type: "text/javascript" }));
      try { window.templateModelDeps = await import(templateUrl); }
      finally { URL.revokeObjectURL(templateUrl); }
      const parserUrl = URL.createObjectURL(new Blob([parserCode], { type: "text/javascript" }));
      try { window.parseLegacyRichHtml = (await import(parserUrl)).parseLegacyRichHtml; }
      finally { URL.revokeObjectURL(parserUrl); }
      const editsUrl = URL.createObjectURL(new Blob([sourceEditsCode], { type: "text/javascript" }));
      try { window.sourceEditsDeps = await import(editsUrl); }
      finally { URL.revokeObjectURL(editsUrl); }
      const url = URL.createObjectURL(new Blob([browserCode], { type: "text/javascript" }));
      try { window.inspectLegacySnapshot = (await import(url)).inspectLegacySnapshot; }
      finally { URL.revokeObjectURL(url); }
    }, { parserCode, browserCode, templateCode, sourceEditsCode });

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

