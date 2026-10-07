import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(root, "fixtures", "remaining");
const documentRoot = join(fixtureRoot, "documents");
const mode = process.argv[2] ?? "--check";
if (!new Set(["--write", "--check"]).has(mode)) {
  throw new Error("Usage: node tools/generate-remaining-fixtures.mjs [--write|--check]");
}

const moduleKinds = [
  "education", "skills", "work", "projects", "orgs", "research", "awards", "other", "portfolio", "custom",
];

function paragraph(text, marks = []) {
  return { type: "paragraph", children: [{ type: "text", text, marks }] };
}

function entry(id, title, body, overrides = {}) {
  return {
    id,
    title,
    role: "工程师",
    department: "合成测试组",
    city: "上海",
    start: "2023-07",
    end: "至今",
    college: null,
    mode: null,
    body,
    ...overrides,
  };
}

function document(id, sections, overrides = {}) {
  return {
    schemaVersion: 2,
    documentId: `fixture-${id}`,
    title: `合成验收样本：${id}`,
    basic: {
      name: "林沐言（合成数据）",
      phone: "138-0000-0000",
      email: "synthetic@example.invalid",
      city: "上海",
      wechat: "fixture-only",
      birth: "2001-06",
      ageMode: "birthday",
      website: "https://example.invalid/profile",
      linkedin: null,
      gender: null,
      height: null,
      weight: null,
      ethnicity: null,
      birthplace: null,
      politicalStatus: null,
      maritalStatus: null,
      zodiac: null,
      mbti: null,
      avatarAssetId: null,
    },
    sections,
    presentation: {
      templateId: "legacy-v1",
      templateRevision: "1",
      density: "standard",
      fontSetId: "legacy-font:宋体",
      fontSizePt: 9.75,
      lineHeightPt: 9.75,
      moduleGapPt: 0,
      pageMarginPt: 22.5,
      headingSizePt: 9.75,
      paragraphGapPt: 0,
      listGapPt: 0,
      theme: "#000000",
      dateFormat: "2021年1月",
      titleFormat: "单行标题",
      separator: "使用分隔符号",
      textAlign: "两端对齐",
      legacyOverrides: {},
    },
    sourceRef: null,
    legacyExtensions: {},
    ...overrides,
  };
}

function entrySection(kind, entries = [], visible = true, title = `合成${kind}`) {
  return { id: `section-${kind}`, kind, title, visible, entries };
}

function summarySection(body = [], visible = true) {
  return { id: "section-summary", kind: "summary", title: "自我评价（合成）", visible, body };
}

const blankSections = [
  entrySection("education"), entrySection("skills"), entrySection("work"), entrySection("projects"),
  entrySection("orgs"), entrySection("research"), entrySection("awards"), entrySection("other"),
  entrySection("portfolio"), entrySection("custom"), summarySection(),
];

const shortSections = [
  entrySection("education", [entry("edu-short", "示例大学", [paragraph("计算机科学与技术；课程包括编译原理与数据库。")])]),
  entrySection("work", [entry("work-short", "合成软件工作室", [paragraph("负责桌面应用的稳定性和数据保护。")])]),
  summarySection([paragraph("虚构内容，仅用于 ZineCV 自动化验收。")]),
];

function repeatedSections(id, count, charsPerEntry = 280) {
  const entries = Array.from({ length: count }, (_, index) => {
    const text = `案例 ${index + 1}：跨页和页尾布局的合成内容。`.repeat(Math.ceil(charsPerEntry / 22)).slice(0, charsPerEntry);
    return entry(`${id}-${String(index + 1).padStart(3, "0")}`, `项目经历 ${String(index + 1).padStart(3, "0")}`, [
      paragraph(`2024-01—2025-01 · 平台组 · 上海 · ${text}`),
      paragraph("结果：保存、排版和版本回路均只使用本地合成数据。"),
    ]);
  });
  return [entrySection("work", entries), summarySection([paragraph("页数目标以实际引擎渲染记录为准。")])];
}

const allModules = moduleKinds.map((kind) => entrySection(kind, [
  entry(`all-${kind}-1`, `同名条目`, [paragraph(`模块 ${kind} 的合成内容。`)])], kind !== "awards"));
allModules.find((section) => section.kind === "custom").entries.push(
  entry("empty-entry", "", []),
  entry("duplicate-title-a", "重复标题", [paragraph("稳定 ID A。")]),
  entry("duplicate-title-b", "重复标题", [paragraph("稳定 ID B。")]),
);
allModules.push(summarySection([paragraph("隐藏模块仍保留正文。")], true));

const richText = document("richtext-edge", [
  entrySection("work", [entry("richtext-entry", "CJK / Latin / emoji / link", [
    { type: "paragraph", children: [
      { type: "text", text: "中文 CJK、English ffi、组合字符 e\u0301 和 emoji 😀。", marks: [] },
      { type: "text", text: "粗体", marks: ["bold"] },
      { type: "text", text: "斜体", marks: ["italic"] },
      { type: "text", text: "下划线", marks: ["underline"] },
      { type: "text", text: "删除线", marks: ["strike"] },
      { type: "link", href: "https://example.invalid/a/very/long/path/for/layout/wrapping?query=synthetic", children: [
        { type: "text", text: "长链接文本（合成）", marks: [] },
      ] },
      { type: "break" },
      { type: "break" },
      { type: "text", text: "连续软换行之后。", marks: [] },
    ] },
    { type: "list", ordered: true, start: 7, items: [
      [paragraph("有序列表从 7 开始。")],
      [paragraph("第二项。"), { type: "list", ordered: false, start: null, items: [[paragraph("嵌套无序项。")]] }],
    ] },
  ])]),
  summarySection([paragraph("逻辑文本、软换行和列表的测试值都为合成数据。")]),
]);

const documents = new Map([
  ["blank-profile", document("blank-profile", blankSections, {
    title: "",
    basic: { ...document("blank-base", []).basic, name: "", phone: "", email: "", city: "", wechat: "", birth: "", website: null },
  })],
  ["one-page", document("one-page", shortSections)],
  ["near-page-bottom", document("near-page-bottom", repeatedSections("near-bottom", 8, 180))],
  ["just-over-one-page", document("just-over-one-page", repeatedSections("over-page", 16, 300))],
  ["two-pages", document("two-pages", repeatedSections("two-page", 20, 320))],
  ["five-pages", document("five-pages", repeatedSections("five-page", 45, 360))],
  ["all-modules-hidden-and-duplicate-ids", document("all-modules", allModules)],
  ["cross-page-long-entry", document("long-entry", [
    entrySection("work", [entry("entry-long", "单条超长经历", [paragraph("长经历正文用于跨页命中核验。".repeat(2400))])]),
  ])],
  ["richtext-cjk-latin-emoji-link-lists", richText],
  ["same-title-different-ids", document("same-title", [entrySection("work", [
    entry("same-id-a", "相同标题", [paragraph("第一条；靠 ID 定位。")]),
    entry("same-id-b", "相同标题", [paragraph("第二条；靠 ID 定位。")]),
  ])])],
  ["avatar-resource", document("avatar", [entrySection("work", [entry("avatar-entry", "头像资源生命周期", [paragraph("资源为 1×1 红色 PNG 合成夹具。")])])], {
    basic: { ...document("avatar-base", []).basic, avatarAssetId: "fixture-avatar-red-1px" },
  })],
  ["unknown-template-revision", document("unknown-template", shortSections, {
    presentation: {
      ...document("unknown-base", []).presentation,
      templateId: "unknown-template:fixture-v99",
      templateRevision: "99",
      legacyOverrides: { "future.numeric": 12, "future.label": "preserve-me" },
    },
    legacyExtensions: { "fixture.unknownField": { retained: true } },
  })],
]);

const graph = makeVersionGraph();
const png = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082",
  "hex",
);

function makeVersionGraph() {
  const commits = [];
  const append = (branchId, start, end, parentAtStart) => {
    let parentId = parentAtStart;
    for (let index = start; index <= end; index += 1) {
      const id = `commit-${String(index).padStart(4, "0")}`;
      commits.push({
        id,
        branchId,
        parentId,
        message: `合成版本 ${String(index).padStart(4, "0")}`,
        createdAt: new Date(Date.UTC(2024, 0, 1) + index * 60_000).toISOString(),
        snapshotHash: createHash("sha256").update(`synthetic-snapshot-${index}`).digest("hex"),
      });
      parentId = id;
    }
  };
  append("main", 0, 399, null);
  append("feature", 400, 599, "commit-0399");
  append("release", 600, 699, "commit-0399");
  append("main", 700, 999, "commit-0399");
  return {
    schema: "synthetic-version-graph/v1",
    generatedFrom: "fixed deterministic generator",
    commitCount: commits.length,
    branches: [
      { id: "main", name: "main", headCommitId: "commit-0999" },
      { id: "feature", name: "feature", headCommitId: "commit-0599" },
      { id: "release", name: "release", headCommitId: "commit-0699" },
    ],
    commits,
  };
}

const scenarioMetadata = [
  ["blank-profile", ["F01", "F02", "F03", "F09"], 1],
  ["one-page", ["F10", "F11", "F12", "F16", "F19"], 1],
  ["near-page-bottom", ["F10", "F14", "F17"], 1],
  ["just-over-one-page", ["F10", "F13", "F14", "F17"], 2],
  ["two-pages", ["F10", "F15", "F16", "F17"], 2],
  ["five-pages", ["F10", "F15", "F16", "F17", "D07"], 5],
  ["all-modules-hidden-and-duplicate-ids", ["F03", "F04", "F05"], 1],
  ["cross-page-long-entry", ["F10", "F15", "F16"], 8],
  ["richtext-cjk-latin-emoji-link-lists", ["F05", "F06", "F07", "F15", "D07"], 1],
  ["same-title-different-ids", ["F04", "F15", "F36"], 1],
  ["avatar-resource", ["F02", "F10", "F16", "F17", "F29"], 1],
  ["unknown-template-revision", ["F19", "F20", "F44"], 1],
];

const layoutMatrix = {
  schema: "synthetic-layout-matrix/v1",
  sourceDocument: "fixtures/remaining/documents/one-page.json",
  combinations: ["legacy-v1", "clear-single-v1", "compact-single-v1"].flatMap((templateId) =>
    ["comfortable", "standard", "compact"].map((density) => ({ templateId, density }))),
  isolatedParameterCases: [
    { fontSizePt: 7.5 }, { fontSizePt: 14 }, { lineHeightPt: 8.5 }, { lineHeightPt: 18 },
    { moduleGapPt: 0 }, { moduleGapPt: 18 }, { pageMarginPt: 9 }, { pageMarginPt: 50 },
    { headingSizePt: 8 }, { headingSizePt: 20 }, { paragraphGapPt: 0 }, { paragraphGapPt: 12 },
    { listGapPt: 0 }, { listGapPt: 12 },
    { dateFormat: "2021.01" }, { titleFormat: "双行标题" },
    { separator: "不使用分隔符号" }, { textAlign: "系统默认" },
  ],
  note: "Apply one parameter override at a time; render and compare after the production command path is connected.",
};

const migrationScenarios = {
  schema: "synthetic-migration-scenarios/v1",
  dataClassification: "fictional only; create isolated source packages during R19/R20",
  cases: [
    { id: "full-browser-export", categories: ["resume", "layout", "sections", "templates", "versionGraph", "settings", "accounts", "sessions"], expected: "complete category inventory" },
    { id: "versions-json-only", categories: ["versionGraph"], expected: "no current draft inferred" },
    { id: "main-corrupt-backup-valid", categories: ["versionGraph"], expected: "backup recoverable; source bytes unchanged" },
    { id: "same-id-different-content", categories: ["resume", "versionGraph"], expected: "explicit conflict; no overwrite" },
    { id: "same-content-different-commit", categories: ["versionGraph"], expected: "distinct commit identities retained" },
    { id: "missing-image", categories: ["assets", "resume"], expected: "missing asset reported" },
    { id: "future-schema", categories: ["resume", "versionGraph"], expected: "write refused with unsupported schema" },
    { id: "damaged-account", categories: ["accounts", "sessions"], expected: "account status reported separately" },
    { id: "undecryptable-secret", categories: ["providers", "secrets"], expected: "config retained; re-entry required" },
  ],
};

const coverageInputs = {
  F01: ["blank-profile", "NATIVE-01"], F02: ["avatar-resource", "NATIVE-01"],
  F03: ["all-modules-hidden-and-duplicate-ids", "NATIVE-01"], F04: ["same-title-different-ids", "VERSION-01"],
  F05: ["richtext-cjk-latin-emoji-link-lists", "IME-01"], F06: ["richtext-cjk-latin-emoji-link-lists", "IME-01"],
  F07: ["richtext-cjk-latin-emoji-link-lists", "IME-01"], F08: ["all-modules-hidden-and-duplicate-ids", "UI-01"],
  F09: ["all-modules-hidden-and-duplicate-ids", "UI-01"],
  F10: ["one-page", "near-page-bottom", "just-over-one-page", "two-pages", "five-pages", "cross-page-long-entry", "VIS-01"],
  F11: ["layout-matrix.json", "VIS-01"], F12: ["layout-matrix.json", "VIS-01"],
  F13: ["just-over-one-page", "five-pages", "VIS-01"], F14: ["near-page-bottom", "two-pages", "five-pages", "VIS-01"],
  F15: ["two-pages", "five-pages", "cross-page-long-entry", "richtext-cjk-latin-emoji-link-lists", "UI-01"],
  F16: ["one-page", "two-pages", "five-pages", "cross-page-long-entry", "NATIVE-01"],
  F17: ["one-page", "two-pages", "five-pages", "cross-page-long-entry", "FILE-01"],
  F18: ["IMPORT-01"], F19: ["layout-matrix.json", "unknown-template-revision", "VERSION-01"],
  F20: ["unknown-template-revision", "VERSION-01"], F21: ["IMPORT-01"], F22: ["IMPORT-01"],
  F23: ["IMPORT-01", "INSTALL-01"],
  F24: ["version-graph-1000.json", "VERSION-01"], F25: ["version-graph-1000.json", "VERSION-01"],
  F26: ["version-graph-1000.json", "VERSION-01"], F27: ["version-graph-1000.json", "VERSION-01"],
  F28: ["version-graph-1000.json", "VERSION-01", "NATIVE-01"],
  F29: ["avatar-resource", "NATIVE-01", "FILE-01"], F30: ["migration-scenarios.json", "MIGRATION-01"],
  F31: ["migration-scenarios.json", "IDENTITY-01"], F32: ["IDENTITY-01", "REAL-MODEL-01"],
  F33: ["REAL-MODEL-01"], F34: ["AGENT-01", "VIS-01"], F35: ["AGENT-01", "NATIVE-01"],
  F36: ["same-title-different-ids", "AGENT-01"], F37: ["AGENT-01"],
  F38: ["PROPOSAL-01", "REAL-MODEL-01"], F39: ["PROPOSAL-01", "REAL-MODEL-01"],
  F40: ["migration-scenarios.json", "MIGRATION-01", "IDENTITY-01"],
  F41: ["MOTION-01"], F42: ["UI-01", "MOTION-01"], F43: ["NATIVE-01", "FILE-01"],
  F44: ["VIS-01", "LICENSE-01"],
  D01: ["INSTALL-01"], D02: ["INSTALL-01"], D03: ["LICENSE-01", "INSTALL-01"],
  D04: ["INSTALL-01", "FILE-01"], D05: ["INSTALL-01"], D06: ["INSTALL-01", "NATIVE-01"],
  D07: ["five-pages", "richtext-cjk-latin-emoji-link-lists", "RELEASE-01"],
  D08: ["REPRO-01", "INSTALL-01"],
};

const outputs = new Map();
for (const [name, value] of documents) {
  outputs.set(`documents/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}
outputs.set("assets/avatar-red-1px.png", png);
outputs.set("version-graph-1000.json", `${JSON.stringify(graph, null, 2)}\n`);
outputs.set("layout-matrix.json", `${JSON.stringify(layoutMatrix, null, 2)}\n`);
outputs.set("migration-scenarios.json", `${JSON.stringify(migrationScenarios, null, 2)}\n`);
outputs.set("coverage-input-map.json", `${JSON.stringify(coverageInputs, null, 2)}\n`);

const hash = (value) => createHash("sha256").update(value).digest("hex");
const legacyExportSourceSha256 = hash(await readFile(join(root, "crates", "zinecv-storage", "src", "migration.rs")));
const manualScenarioText = await readFile(join(fixtureRoot, "manual-scenarios.md"), "utf8");
const manualScenarioSha256 = hash(Buffer.from(manualScenarioText));
const manualScenarioIds = [...manualScenarioText.matchAll(/^## ([A-Z]+(?:-[A-Z]+)*-\d{2})\b/gm)].map((match) => match[1]);
const currentOriginalDocumentHashes = Object.fromEntries(await Promise.all([
  "docs/DEVELOPMENT_PLAN.md", "docs/FEASIBILITY.md", "docs/FEATURE_PARITY.md", "docs/target.archify.json",
].map(async (path) => [path, hash(await readFile(join(root, path)))])));
const fixedResourceHashes = Object.fromEntries(await Promise.all([
  "public/fonts/source-han-serif-cn-regular.otf", "public/fonts/source-han-serif-cn-heavy.ttf",
  "public/fonts/wondercv-iconfont.css", "public/fonts/wondercv-iconfont.woff2", "public/fonts/wondercv-iconfont.ttf",
  "crates/zinecv-engine/src/templates.typ", "src/ui/styles/preview.css",
  "src/ui/styles/template-clear-single.css", "src/ui/styles/template-compact-single.css",
].map(async (path) => [path, hash(await readFile(join(root, path)))])));
const fileHashes = Object.fromEntries([...outputs].map(([path, value]) => [path, hash(value)]));
const manifest = {
  schemaVersion: 1,
  package: "R01",
  capturedAt: "2026-09-30",
  sourceRevision: "07a874b994aa57287e373c95ede5a691818df7c4 plus protected pre-existing worktree",
  dataClassification: "synthetic-only; no real resume, credential, browser profile, or user .data used",
  originalDevelopmentDocumentHashes: {
    current: currentOriginalDocumentHashes,
    historicalExpected: {
      "docs/DEVELOPMENT_PLAN.md": "4e7d8cf83a8a93c4737d388c203f322a92a7eebee5980da5b7aae24f59eb6810",
      "docs/FEASIBILITY.md": "af8686376196794c824cadb222e213db1ff0c5b18f717e18e86b8691bfad109c",
      "docs/FEATURE_PARITY.md": "ae7e085e5fc84cca94831fa1528130cd4704ae8dc5f7053d1f27bf2e9d5e2e3f",
      "docs/target.archify.json": "b7f1cef2428193dea43af7780c747fff4080b9fa509de88c7ec7f661ba64b90d",
    },
    note: "three Markdown source hashes match; target.archify.json has the React-workspace update recorded in docs/audit-20260930.md",
  },
  fixedInputs: {
    referenceDate: "2026-09-30",
    randomSeed: "not-used; identifiers and timestamps are deterministic",
    viewportCssPixels: [[1440, 900], [1920, 1080], [1050, 700]],
    dpiPercent: [100, 125, 150, 200],
    previewZoomPercent: [20, 100, 200],
    deviceScaleFactor: [1, 1.25, 1.5, 2],
    paneCasesFromHistoricalSelfCheck: ["pane-default", "pane-min", "pane-max-clamped"],
    normalizedScrollStops: [0, 0.5, 1],
    themeCasesFromHistoricalSelfCheck: ["theme-light", "theme-dark"],
    templates: ["legacy-v1", "clear-single-v1", "compact-single-v1"],
    densities: ["comfortable", "standard", "compact"],
    fontAndTemplateSha256: fixedResourceHashes,
    fixedFontHashesFromProtectedBaseline: "docs/baseline-manifest.json",
  },
  scenarios: scenarioMetadata.map(([id, featureIds, expectedPageCount]) => ({
    id,
    path: `fixtures/remaining/documents/${id}.json`,
    featureIds,
    expectedPageCount,
  })),
  additionalInputs: [
    { id: "avatar-red-1px", path: "fixtures/remaining/assets/avatar-red-1px.png", mime: "image/png", synthetic: true },
    { id: "version-graph-1000", path: "fixtures/remaining/version-graph-1000.json", commits: 1000, synthetic: true },
    { id: "richtext-golden", path: "fixtures/legacy-richtext-golden.json", synthetic: true },
    { id: "layout-matrix", path: "fixtures/remaining/layout-matrix.json", combinations: 9, isolatedParameterCases: 18 },
    { id: "migration-scenarios", path: "fixtures/remaining/migration-scenarios.json", cases: migrationScenarios.cases.length },
    { id: "coverage-input-map", path: "fixtures/remaining/coverage-input-map.json", requirementCount: Object.keys(coverageInputs).length },
  ],
  existingBaselineReferences: {
    protectedManifest: "docs/baseline-manifest.json",
    historicalVisualSelfCheckPointer: "desktop/docs/current-preview-selfcheck-20260926.json",
    resolvedVisualSelfCheck: "docs/current-preview-selfcheck-20260926.json",
    crossPageSelection: "docs/paper-text-selection-baseline-20260927.json",
    threeRunTypstPoc: "docs/bench-typst-poc-20260926.json",
    historicalFailureId: "PREVIEW-01",
  },
  localStorageKeysObservedInVisualFixture: [
    "resume-diy-state", "resume-diy-presentation-v1", "resume-diy-section-order-v2",
    "resume-diy-modules", "resume-diy-module-names", "resume-diy-title",
    "resume-diy-summary-title", "resume-diy-preferences", "resume-diy-layout-consistency-v1",
  ],
  legacyBrowserExportInventory: {
    source: "crates/zinecv-storage/src/migration.rs",
    sourceSha256: legacyExportSourceSha256,
    verification: "Rust inspect_browser_export and read_known_browser_key own validation and the allow-list",
  },
  renderedFixtureEvidence: {
    path: ".artifacts/remaining/R01/render-smoke.json",
    rendererSha256: "2fac285342d7e2d81741bd877f712a7607b12ddbd941c324d50f348d3b4ea9cc",
    command: "engine_render.exe <fixture.json> <output.png> 0 1.333333",
    result: "12/12 fixtures rendered; page counts recorded; avatar asset decoded successfully",
    scope: "fixture validity and page-count calibration only; not F or D acceptance",
  },
  benchmarkProtocol: {
    ordinarySamplesPerRound: 30,
    rounds: 3,
    coldStarts: 10,
    report: ["p50", "p95", "max", "failures", "environment", "fixtureSha256", "processMemory"],
    candidateBudgets: {
      inputFeedbackMsP95: 50,
      previewOneToTwoPagesMs: 250,
      previewFivePagesMs: 750,
      editableColdStartMs: 2000,
      templateSwitchMs: 500,
      fivePagePdfMs: 2000,
      dragFrameMsP95: 16.7,
      commit1000SnapshotsMs: 150,
      memoryMiB: "500 candidate; freeze after first comparable baseline",
    },
    comparableLegacyMeasurements: "missing; three short Typst PoC process runs are not a comparable old/new baseline",
  },
  manualEvidenceStillRequired: [
    "Microsoft Pinyin composition, candidate acceptance/cancel, emoji and durable save",
    "pointer drag across pages, keyboard/focus recovery, reduced motion and assistive reading order",
    "fixed-input full shell/A4 comparison against the independent legacy application",
  ],
  manualScenarioSource: {
    path: "fixtures/remaining/manual-scenarios.md",
    sha256: manualScenarioSha256,
    scenarioIds: ["VIS-01", "IME-01", "UI-01", "NATIVE-01", "IMPORT-01", "VERSION-01", "MIGRATION-01", "IDENTITY-01", "AGENT-01", "PROPOSAL-01", "REAL-MODEL-01", "MOTION-01", "FILE-01", "INSTALL-01", "LICENSE-01", "RELEASE-01", "REPRO-01"],
  },
  featureInputMap: "fixtures/remaining/coverage-input-map.json",
  externalBlockers: ["real model credentials", "font/icon redistribution evidence", "clean Win10/Win11 VMs", "human IME/accessibility acceptance"],
  fileSha256: fileHashes,
};
outputs.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const readme = "# R01 synthetic acceptance inputs\n\n" +
  "These fixtures are generated only from deterministic fictional data. Do not replace the protected historical preview baseline or use a real browser profile, credential, resume, or `.data` file.\n\n" +
  "Run `node tools/generate-remaining-fixtures.mjs --write` to regenerate, then `node tools/generate-remaining-fixtures.mjs --check` to verify exact bytes and SHA-256. Page counts remain diagnostic until recorded with the current release renderer. The 1,000-commit graph is a UI/performance input, not proof of database throughput.\n\n" +
  "The fixed viewport/DPI/zoom matrix and benchmark sampling protocol live in `manifest.json`. Human IME, accessibility, installed-WebView2, visual comparison, and real model evidence remain separate.\n";
outputs.set("README.md", readme);

function validateInputs() {
  if (graph.commits.length !== 1000) throw new Error("expected exactly 1000 synthetic commits");
  const ids = new Set(graph.commits.map((commit) => commit.id));
  if (ids.size !== 1000) throw new Error("version graph IDs are not unique");
  for (const commit of graph.commits) {
    if (commit.parentId !== null && !ids.has(commit.parentId)) throw new Error(`missing parent for ${commit.id}`);
  }
  for (const [name, value] of documents) {
    if (value.schemaVersion !== 2 || !value.documentId.startsWith("fixture-")) {
      throw new Error(`invalid ResumeDocument fixture: ${name}`);
    }
    const sectionIds = value.sections.map((section) => section.id);
    if (new Set(sectionIds).size !== sectionIds.length) throw new Error(`duplicate section ID in ${name}`);
    const entryIds = value.sections.flatMap((section) => section.entries ?? []).map((item) => item.id);
    if (new Set(entryIds).size !== entryIds.length) throw new Error(`duplicate entry ID in ${name}`);
  }
  const hiddenAward = allModules.find((section) => section.kind === "awards");
  if (hiddenAward?.visible !== false || hiddenAward.entries.length !== 1) {
    throw new Error("hidden section must retain synthetic content");
  }
  const rich = documents.get("richtext-cjk-latin-emoji-link-lists");
  const ordered = rich.sections[0].entries[0].body.find((block) => block.type === "list");
  if (ordered?.start !== 7 || ordered.items[1][1].type !== "list") {
    throw new Error("ordered-list start and nested-list fixture are missing");
  }
  const expectedIds = [...Array.from({ length: 44 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 8 }, (_, index) => `D${String(index + 1).padStart(2, "0")}`)];
  const uncovered = expectedIds.filter((id) => !Array.isArray(coverageInputs[id]) || coverageInputs[id].length === 0);
  const unexpected = Object.keys(coverageInputs).filter((id) => !expectedIds.includes(id));
  if (uncovered.length || unexpected.length) {
    throw new Error(`invalid F/D input map; uncovered=${uncovered.join(",")} unexpected=${unexpected.join(",")}`);
  }
  const fixtureInputs = new Set([
    ...documents.keys(), "version-graph-1000.json", "layout-matrix.json", "migration-scenarios.json",
  ]);
  const manualInputs = new Set(manualScenarioIds);
  const invalidReferences = Object.entries(coverageInputs).flatMap(([featureId, references]) =>
    references.filter((reference) => !fixtureInputs.has(reference) && !manualInputs.has(reference))
      .map((reference) => `${featureId}:${reference}`));
  const unmappedManualScenarios = [...manualInputs].filter((scenarioId) =>
    !Object.values(coverageInputs).some((references) => references.includes(scenarioId)));
  if (new Set(manualScenarioIds).size !== manualScenarioIds.length || invalidReferences.length || unmappedManualScenarios.length) {
    throw new Error(`invalid scenario references; duplicateManual=${new Set(manualScenarioIds).size !== manualScenarioIds.length} invalid=${invalidReferences.join(",")} unmappedManual=${unmappedManualScenarios.join(",")}`);
  }
  if (layoutMatrix.combinations.length !== 9 || migrationScenarios.cases.length !== 9) {
    throw new Error("layout and migration input matrices are incomplete");
  }
  const expectedOriginalHashes = {
    "docs/DEVELOPMENT_PLAN.md": "4e7d8cf83a8a93c4737d388c203f322a92a7eebee5980da5b7aae24f59eb6810",
    "docs/FEASIBILITY.md": "af8686376196794c824cadb222e213db1ff0c5b18f717e18e86b8691bfad109c",
    "docs/FEATURE_PARITY.md": "ae7e085e5fc84cca94831fa1528130cd4704ae8dc5f7053d1f27bf2e9d5e2e3f",
  };
  for (const [path, expected] of Object.entries(expectedOriginalHashes)) {
    if (currentOriginalDocumentHashes[path] !== expected) throw new Error(`protected development document hash changed: ${path}`);
  }
}

validateInputs();
await mkdir(documentRoot, { recursive: true });
await mkdir(join(fixtureRoot, "assets"), { recursive: true });
let mismatches = 0;
for (const [relativePath, contents] of outputs) {
  const destination = join(fixtureRoot, relativePath);
  if (mode === "--write") {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    continue;
  }
  try {
    const actual = await readFile(destination);
    if (!actual.equals(Buffer.isBuffer(contents) ? contents : Buffer.from(contents))) {
      console.error(`MISMATCH ${relativePath} expectedSha256=${hash(contents)}`);
      mismatches += 1;
    }
  } catch {
    console.error(`MISSING ${relativePath}`);
    mismatches += 1;
  }
}
if (mode === "--check" && mismatches > 0) process.exitCode = 1;
else console.log(`R01_FIXTURES mode=${mode} documents=${documents.size} commits=${graph.commits.length} files=${outputs.size} mismatches=${mismatches}`);
