import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { launchBrowserTestChromium } from "./fixtures/browser-test-server.mjs";

const moduleKeys = ["education", "skills", "work", "projects", "orgs", "research", "awards", "other", "portfolio", "custom"];

function snapshot() {
  return {
    schemaVersion: 2,
    resumeTitle: "完整旧简历",
    summaryTitle: "我的小结",
    resume: {
      basic: { name: "张三", phone: "", email: "", city: "", wechat: "", birth: "", ageMode: "age", avatar: "" },
      ...Object.fromEntries(moduleKeys.map((key) => [key, []])),
      summary: "<p>中文&nbsp;<b>总结</b></p>",
      work: [
        { id: "work-1", title: "工程师", role: "开发", department: "", city: "", start: "2023", end: "至今", html: "<p>第一行<br>第二行</p>" },
        { id: "work-2", title: "实习", role: "", department: "", city: "", start: "2022", end: "2023", html: "<p>辅助<b>工作</b></p>" },
      ],
    },
    moduleOrder: ["work", "summary", "education"],
    moduleNames: Object.fromEntries(moduleKeys.map((key) => [key, key === "work" ? "工作经历" : key])),
    presentation: { templateId: "legacy-v1", templateVersion: 1, densityPreset: "standard", overrides: {} },
    layout: { font: "宋体", fontSize: "13", lineHeight: "16", moduleSpacing: "8", pageMargin: "30", theme: "#000000", dateFormat: "2021年1月", titleFormat: "单行标题", separator: "使用分隔符号", textAlign: "两端对齐" },
    importedTemplate: null,
  };
}

async function loadBridge(page) {
  const transpile = async (relative) => {
    const source = await readFile(resolve(import.meta.dirname, "../..", relative), "utf8");
    return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  };
  const richTextCode = await transpile("src/platform/legacyRichText.ts");
  const snapshotCode = (await transpile("src/platform/legacySnapshot.ts"))
    .replaceAll('from "../ui/domain/version-model"', 'from "./types"')
    .replaceAll('from "../ui/domain/resume-model"', 'from "./types"')
    .replaceAll('from "../../src-tauri/src/domain/bindings/ResumeDocument"', 'from "./types"')
    .replaceAll('from "../../src-tauri/src/domain/bindings/Entry"', 'from "./types"')
    .replaceAll('from "../../src-tauri/src/domain/bindings/Presentation"', 'from "./types"')
    .replaceAll('from "../../src-tauri/src/domain/bindings/Section"', 'from "./types"')
    .replace('import { parseLegacyRichHtml } from "./legacyRichText";', 'const { parseLegacyRichHtml } = bridgeDeps;')
    .replace('import { resolveDensitySpacing } from "../ui/domain/template-model";', 'const { resolveDensitySpacing } = window.templateModelDeps;');
  const resumeModelCode = await transpile("src/ui/domain/resume-model.ts");
  const templateModelCode = await transpile("src/ui/domain/template-model.ts");
  const bridgeCode = (await transpile("src/platform/documentBridge.ts"))
    .replaceAll(/from "[^"]*\/bindings\/[A-Za-z]+"/g, 'from "./types"')
    .replace('import { inspectLegacySnapshot } from "./legacySnapshot";', 'const { inspectLegacySnapshot } = window.snapshotDeps;')
    .replace('import { parseLegacyRichHtml, richBlocksToLegacyHtml } from "./legacyRichText";', 'const { parseLegacyRichHtml, richBlocksToLegacyHtml } = window.bridgeDeps;')
    .replace('import { moduleTitles } from "../ui/domain/resume-model";', 'const { moduleTitles } = window.resumeModelDeps;')
    .replace('import { normalizePresentation, resolveDensitySpacing } from "../ui/domain/template-model";', 'const { normalizePresentation, resolveDensitySpacing } = window.templateModelDeps;');
  await page.evaluate(async ({ richTextCode, snapshotCode, resumeModelCode, templateModelCode, bridgeCode }) => {
    const blob = (code) => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    const richText = await import(blob(richTextCode));
    const resumeModel = await import(blob(resumeModelCode));
    const templateModel = await import(blob(templateModelCode));
    window.bridgeDeps = {
      parseLegacyRichHtml: richText.parseLegacyRichHtml,
      richBlocksToLegacyHtml: richText.richBlocksToLegacyHtml,
    };
    window.templateModelDeps = templateModel;
    window.snapshotDeps = await import(blob(snapshotCode));
    window.resumeModelDeps = resumeModel;
    window.templateModelDeps = templateModel;
    const bridge = await import(blob(bridgeCode));
    // 浏览器内复刻命令应用语义（仅测试用）：按命令类型演进文档，验证求差可收敛。
    const applyCommand = (document, command) => {
      const next = structuredClone(document);
      const spec = command;
      if (spec.type === "setDocumentTitle") next.title = spec.title;
      else if (spec.type === "renameSection") {
        for (const section of next.sections) if (section.id === spec.section_id) section.title = spec.title;
      } else if (spec.type === "setSectionVisibility") {
        for (const section of next.sections) if (section.id === spec.section_id) section.visible = spec.visible;
      } else if (spec.type === "moveSection") {
        const index = next.sections.findIndex((section) => section.id === spec.section_id);
        const [section] = next.sections.splice(index, 1);
        next.sections.splice(spec.index, 0, section);
      } else if (spec.type === "setEntryBody") {
        for (const section of next.sections) {
          if (section.entries) {
            const entry = section.entries.find((item) => item.id === spec.entry_id);
            if (entry) entry.body = spec.body;
          }
        }
      } else if (spec.type === "setSummaryBody") {
        for (const section of next.sections) if (section.kind === "summary") section.body = spec.body;
      } else if (spec.type === "updateEntryFields") {
        for (const section of next.sections) {
          if (section.entries) {
            const entry = section.entries.find((item) => item.id === spec.entry_id);
            if (entry) {
              // 与 Rust 语义一致：patch 中 null 表示“不修改”。
              for (const [field, value] of Object.entries(spec)) {
                if (field !== "type" && field !== "entry_id" && value !== null) entry[field] = value;
              }
            }
          }
        }
      } else if (spec.type === "addEntry") {
        for (const section of next.sections) if (section.id === spec.section_id) section.entries.push(spec.entry);
      } else if (spec.type === "deleteEntry") {
        for (const section of next.sections) {
          if (section.entries) section.entries = section.entries.filter((item) => item.id !== spec.entry_id);
        }
      } else if (spec.type === "moveEntry") {
        for (const section of next.sections) {
          if (section.entries && section.entries.some((item) => item.id === spec.entry_id)) {
            const index = section.entries.findIndex((item) => item.id === spec.entry_id);
            const [entry] = section.entries.splice(index, 1);
            section.entries.splice(spec.index, 0, entry);
          }
        }
      } else if (spec.type === "updateBasic") {
        for (const [field, value] of Object.entries(spec.patch)) {
          if (value === null || value === undefined) continue;
          if (field === "avatarAssetId") next.basic.avatarAssetId = value === "" ? null : value;
          else next.basic[field] = value;
        }
      } else if (spec.type === "setLayout") next.presentation = spec.presentation;
      else if (spec.type === "setLegacyExtensions") next.legacyExtensions = spec.extensions;
      else throw new Error("Unknown test command: " + spec.type);
      return next;
    };
    window.bridgeTest = {
      bridge,
      // 复刻 useNativeResumePersistence 的 fixpoint：每条命令后用返回文档重新求差。
      converge: (current, desired) => {
        const commands = [];
        let live = current;
        for (let index = 0; index < 64; index += 1) {
          const command = bridge.nextDocumentCommand(live, desired);
          if (!command) break;
          commands.push(command.type);
          live = applyCommand(live, command);
        }
        return { commands, equal: bridge.documentsEqual(live, desired), final: live };
      },
    };
  }, { richTextCode, snapshotCode, resumeModelCode, templateModelCode, bridgeCode });
}

test("legacy snapshot converts, round-trips and converges through minimal commands", async () => {
  const browser = await launchBrowserTestChromium({ headless: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("about:blank");
    await loadBridge(page);
    const result = await page.evaluate((fixture) => {
      const { bridge, converge } = window.bridgeTest;
      const tryConvert = (snapshot, documentId, stage) => {
        try {
          return { stage, document: bridge.documentFromSnapshot(snapshot, documentId) };
        } catch (error) {
          return { stage, error: String(error) };
        }
      };
      const firstStage = tryConvert(fixture, "doc-test", "first");
      if (firstStage.error) return firstStage;
      const first = firstStage.document;
      // 反向转换后再正向转换：与首份文档 canonical 相等（持久化收敛依赖的不变量）。
      const roundSnapshot = bridge.snapshotFromDocument(first, "");
      const secondStage = tryConvert(roundSnapshot, "doc-test", "second");
      if (secondStage.error) return secondStage;
      const second = secondStage.document;
      const roundTripEqual = bridge.documentsEqual(first, second);
      // 默认无差异；随后逐类修改验证最小命令与 fixpoint 收敛。
      const noChange = bridge.nextDocumentCommand(first, first);
      const mutated = structuredClone(roundSnapshot);
      mutated.resumeTitle = "改名的简历";
      mutated.resume.basic.phone = "13800000000";
      mutated.resume.summary = "<p>改过的<u>小结</u></p>";
      mutated.moduleOrder = ["education", "work", "summary"];
      mutated.moduleNames.work = "实习经历";
      mutated.layout.lineHeight = "18";
      const workSection = mutated.resume.work;
      workSection[0].title = "高级工程师";
      workSection[0].html = "<p>新正文<ol><li>要点</li></ol></p>";
      workSection.reverse();
      workSection.push({ id: "work-3", title: "新增", role: "", department: "", city: "", start: "", end: "", html: "<p>新条目</p>" });
      workSection.splice(0, 1); // 删除一条（原 work-2），保留 work-1 与新增的 work-3
      const desiredStage = tryConvert(mutated, "doc-test", "desired");
      if (desiredStage.error) return desiredStage;
      const desired = desiredStage.document;
      const { commands, equal, final } = converge(second, desired);
      // 收敛后的文档再反向转换，仍应与工作区快照 round-trip 一致。
      const finalSnapshot = bridge.snapshotFromDocument(final, "");
      const finalRoundStage = tryConvert(finalSnapshot, "doc-test", "finalRound");
      if (finalRoundStage.error) {
        const candidate = window.snapshotDeps.inspectLegacySnapshot(finalSnapshot, "doc-test");
        return { stage: "finalRound", error: finalRoundStage.error, issues: candidate.issues, finalWork: JSON.stringify(finalSnapshot.resume.work) };
      }
      const finalRound = finalRoundStage.document;
      return { roundTripEqual, noChange, commands, equal, finalEqual: bridge.documentsEqual(final, desired), finalStable: bridge.documentsEqual(final, finalRound) };
    }, snapshot());
    if (!result.roundTripEqual) console.log("BRIDGE DEBUG:", JSON.stringify(result));
    assert.equal(result.roundTripEqual, true, "snapshot -> document -> snapshot -> document must be canonical-stable");
    assert.equal(result.noChange, null, "identical documents must not produce commands");
    assert.equal(result.equal, true, "fixpoint must converge to the desired document");
    assert.equal(result.finalEqual, true);
    assert.equal(result.finalStable, true, "converted result must round-trip stably after edits");
    assert.ok(result.commands.length > 0 && result.commands.length <= 64, "convergence within bounded steps");
    assert.ok(result.commands.includes("setDocumentTitle"), "title change command");
    assert.ok(result.commands.includes("updateBasic"), "basic field change command");
    assert.ok(result.commands.includes("setSummaryBody"), "summary body change command");
    assert.ok(result.commands.includes("renameSection"), "module rename command");
    assert.ok(result.commands.includes("moveSection"), "module order change command");
    assert.ok(result.commands.includes("setLayout"), "layout change command");
    assert.ok(result.commands.includes("setEntryBody"), "entry body change command");
    assert.ok(result.commands.includes("updateEntryFields"), "entry field change command");
    assert.ok(result.commands.includes("deleteEntry") || result.commands.includes("addEntry"), "entry add/remove command");
    const densityCases = [
      ["legacy-v1", "comfortable", [14, 2, 1]],
      ["legacy-v1", "standard", [13, 0, 0]],
      ["legacy-v1", "compact", [12, 0, 0]],
      ["clear-single-v1", "comfortable", [16, 4, 2]],
      ["clear-single-v1", "standard", [15, 2, 1]],
      ["clear-single-v1", "compact", [14, 0, 0]],
      ["compact-single-v1", "comfortable", [16, 5, 3]],
      ["compact-single-v1", "standard", [15, 3, 2]],
      ["compact-single-v1", "compact", [14, 1, 1]],
    ];
    for (const [templateId, densityPreset, expected] of densityCases) {
      const fixture = snapshot();
      fixture.presentation = { templateId, templateVersion: 1, densityPreset, overrides: {} };
      const actual = await page.evaluate((source) => {
        const { bridge } = window.bridgeTest;
        const original = JSON.stringify(source);
        const document = bridge.documentFromSnapshot(source, "density-test");
        const restored = bridge.documentFromSnapshot(bridge.snapshotFromDocument(document, ""), "density-test");
        const explicit = structuredClone(source);
        explicit.presentation.overrides = { headingFontSize: "20", paragraphSpacing: "6", listSpacing: "4" };
        const authored = bridge.documentFromSnapshot(explicit, "density-test");
        const values = (item) => [item.headingSizePt, item.paragraphGapPt, item.listGapPt];
        return {
          spacing: values(document.presentation), authored: values(authored.presentation),
          layout: [document.presentation.fontSizePt, document.presentation.lineHeightPt, document.presentation.moduleGapPt, document.presentation.pageMarginPt],
          stable: bridge.documentsEqual(document, restored),
          command: bridge.nextDocumentCommand(document, restored),
          sourceUnchanged: JSON.stringify(source) === original,
        };
      }, fixture);
      const label = `${templateId}/${densityPreset}`;
      assert.deepEqual(actual.spacing, expected.map((value) => value * 0.75), label);
      assert.deepEqual(actual.authored, [15, 4.5, 3], `${label}: explicit spacing wins`);
      assert.deepEqual(actual.layout, [9.75, 12, 6, 22.5], `${label}: authored layout survives`);
      assert.equal(actual.stable, true, `${label}: restart representation is stable`);
      assert.equal(actual.command, null, `${label}: no redundant save after restart`);
      assert.equal(actual.sourceUnchanged, true, `${label}: source remains unchanged`);
    }
    const domainLayout = await page.evaluate(source => {
      const { bridge } = window.bridgeTest;
      const document = bridge.documentFromSnapshot(source, "domain-layout");
      document.presentation = { ...document.presentation, templateId: "clear-single-v1", density: "compact", headingSizePt: 14.25, paragraphGapPt: 3.75, listGapPt: 2.25, legacyOverrides: {} };
      const restored = bridge.snapshotFromDocument(document, "");
      return { stored: restored.presentation, native: bridge.documentFromSnapshot(restored, "domain-layout").presentation };
    }, snapshot());
    assert.equal(domainLayout.stored.templateId, "clear-single-v1", "domain template replaces stale historical identity");
    assert.equal(domainLayout.stored.densityPreset, "compact");
    assert.deepEqual(domainLayout.stored.overrides, { headingFontSize: "19", paragraphSpacing: "5", listSpacing: "3" });
    assert.equal(domainLayout.native.headingSizePt, 14.25);
    const changedLayout = await page.evaluate(source => {
      const { bridge } = window.bridgeTest;
      const document = bridge.documentFromSnapshot(source, "changed-layout");
      Object.assign(document.presentation, { fontSizePt: 12, lineHeightPt: 15, moduleGapPt: 3, pageMarginPt: 24, theme: "#ee5b2a", fontSetId: "legacy-font:楷体" });
      const restored = bridge.snapshotFromDocument(document, "");
      return { layout: restored.layout, native: bridge.documentFromSnapshot(restored, "changed-layout").presentation };
    }, snapshot());
    assert.deepEqual(changedLayout.layout, { ...snapshot().layout, font: "楷体", fontSize: "16", lineHeight: "20", moduleSpacing: "4", pageMargin: "32", theme: "#ee5b2a" });
    assert.equal(changedLayout.native.fontSizePt, 12);
    assert.equal(changedLayout.native.lineHeightPt, 15);
    const fractional = await page.evaluate(source => {
      const { bridge } = window.bridgeTest;
      const document = bridge.documentFromSnapshot(source, "fractional-fit");
      Object.assign(document.presentation, {fontSizePt:12.333333,lineHeightPt:13.5,headingSizePt:14.095238,paragraphGapPt:1.6,listGapPt:1.6});
      const first = bridge.documentFromSnapshot(bridge.snapshotFromDocument(document, ""), "fractional-fit");
      const second = bridge.documentFromSnapshot(bridge.snapshotFromDocument(first, ""), "fractional-fit");
      return {source:document.presentation,first:first.presentation,stable:bridge.documentsEqual(first,second)};
    }, snapshot());
    for(const key of ["fontSizePt","lineHeightPt","headingSizePt","paragraphGapPt","listGapPt"]) assert.equal(fractional.first[key],fractional.source[key],`${key}: shared f32 value survives CSS arithmetic`);
    assert.equal(fractional.stable,true,"fractional fit layout converges after hydration");
  } finally {
    await context.close();
    await browser.close();
  }
});
