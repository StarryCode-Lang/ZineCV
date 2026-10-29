import { loadModule } from "./module-loader.mjs";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { structureRecognizedLines } from "../../src/ui/services/resume-content-recognition.ts";
import { monthLabel } from "../../src/ui/utils/resume.ts";

// version-details
{
  test("1001-commit graph keeps missing snapshots lazy and preserves metadata", async () => {
    let hydrated = 0;
    const { storeFromGraph, parseGraph } = await loadModule("src/platform/useNativeResumeVersions.ts", {
      react: {}, "./documentBridge": {}, "./ipc": {}, "./versionDetails": {},
      "./NativeDocumentClient": {},
      "./workspace": { snapshotFromLoadedDocument: async (document) => { hydrated++; return document; } },
    }, "\nexport { storeFromGraph, parseGraph };\n");
    const commits = Array.from({ length: 1001 }, (_, index) => ({
      id: `commit-${index}`, originBranchId: "main", parentId: index ? `commit-${index - 1}` : null,
      message: `version ${index}`, createdAt: "2020-01-01T00:00:00Z",
      snapshotDocumentJson: index < 1000 ? JSON.stringify({ title: `snapshot ${index}` }) : "",
    }));
    const store = await storeFromGraph(parseGraph({ cursor: {},
      branches: [{ id: "main", name: "main", isCurrent: true, headCommitId: "commit-0", createdAt: "" }], commits }));
    assert.equal(store.commits.length, 1001);
    assert.equal(hydrated, 1000);
    assert.equal(store.commits[1000].snapshot, null);
    assert.equal(store.commits[1000].message, "version 1000");
    assert.equal(store.currentBranchId, "main");
  });

  test("graph refresh reuses unchanged snapshots, but never stale replacement or other-context data", async () => {
    let hydrated = 0;
    const { storeFromGraph, parseGraph } = await loadModule("src/platform/useNativeResumeVersions.ts", {
      react: {}, "./documentBridge": {}, "./ipc": {}, "./versionDetails": {},
      "./NativeDocumentClient": {},
      "./workspace": { snapshotFromLoadedDocument: async document => { hydrated++; return { document }; } },
    }, "\nexport { storeFromGraph, parseGraph };\n");
    const raw = { cursor: { documentId: "doc", contextId: "one" },
      branches: [{ id: "main", name: "main", isCurrent: true, headCommitId: "v0", createdAt: "" }],
      commits: Array.from({ length: 1000 }, (_, index) => ({ id: `v${index}`, originBranchId: "main",
        parentId: null, message: `version ${index}`, createdAt: "2020-01-01",
        snapshotDocumentJson: JSON.stringify({ title: `snapshot ${index}` }) })) };
    let graph = parseGraph(raw), store = await storeFromGraph(graph);
    assert.equal(graph.commits.filter(commit => commit.snapshotDocument).length, 1,
      "only the native head needs a second parsed document graph");
    const original = store;
    for (let index = 0; index < 20; index++) {
      const next = parseGraph(structuredClone(raw), graph);
      store = await storeFromGraph(next, { graph, store }); graph = next;
    }
    assert.equal(hydrated, 1000, "20 refreshes must not allocate 20,000 additional snapshots");
    assert.deepEqual(store, original);
    assert.equal(store.commits[999], original.commits[999]);
    const movedHead = structuredClone(raw);
    movedHead.branches[0].headCommitId = "v999";
    let moved = parseGraph(movedHead, graph);
    const movedStore = await storeFromGraph(moved, { graph, store });
    assert.equal(moved.commits[999].snapshotDocument.title, "snapshot 999");
    assert.equal(moved.commits.filter(commit => commit.snapshotDocument).length, 1);
    assert.equal(movedStore.commits[999].snapshot, store.commits[999].snapshot);
    assert.equal(hydrated, 1000, "moving the head does not rematerialize UI snapshots");
    const lazy = structuredClone(movedHead);
    lazy.commits[998].snapshotDocumentJson = "";
    const lazyGraph = parseGraph(lazy, moved);
    const lazyStore = await storeFromGraph(lazyGraph, { graph: moved, store: movedStore });
    assert.equal(lazyStore.commits[998].snapshot, null, "an unmaterialized commit must not reuse stale UI content");
    const changed = structuredClone(raw);
    changed.commits[0].snapshotDocumentJson = JSON.stringify({ title: "replaced same ID" });
    changed.commits[1].message = "metadata changed";
    let next = parseGraph(changed, graph);
    const replaced = await storeFromGraph(next, { graph, store });
    assert.equal(hydrated, 1001);
    assert.equal(replaced.commits[0].snapshot.document.title, "replaced same ID");
    assert.equal(replaced.commits[1].message, "metadata changed");
    assert.equal(replaced.commits[1].snapshot, store.commits[1].snapshot);
    const otherContext = structuredClone(changed);
    otherContext.cursor.contextId = "other";
    graph = next; next = parseGraph(otherContext, graph);
    await storeFromGraph(next, { graph, store: replaced });
    assert.equal(hydrated, 2001, "a different editing context must hydrate afresh");
  });

  test("detail loads only requested snapshot, backup hydrates missing items sequentially", async () => {
    const calls = [];
    let active = 0;
    let peak = 0;
    const workspace = { nativeClient: { currentSessionEpoch: 1, snapshot: { cursor: {
      documentId: "doc", contextId: "a", branchId: "main", headId: "cached", revision: "1",
    } } },
      snapshotFromLoadedDocument: async (document) => document };
    const details = await loadModule("src/platform/versionDetails.ts", {
      "./workspace": workspace,
      "./ipc": { nativeInvoke: async (command, args) => {
        calls.push([command, args]); peak = Math.max(peak, ++active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return { id: args.commitId, snapshotDocumentJson: JSON.stringify({ title: args.commitId }) };
      } },
    });
    assert.deepEqual(await details.loadCommitDetail("older"), { title: "older" });
    assert.deepEqual(calls[0], ["version_commit_detail", { commitId: "older" }]);
    const complete = { id: "cached", snapshot: { title: "cached" } };
    const result = await details.materializeVersionStore({ currentBranchId: "main",
      branches: [{ id: "main", headCommitId: "cached" }], commits: [complete,
      { id: "old-a", snapshot: null }, { id: "old-b", snapshot: null }] });
    assert.equal(result.commits[0], complete);
    assert.deepEqual(result.commits[2].snapshot, { title: "old-b" });
    assert.equal(peak, 1);
    assert.equal(calls.length, 3);
  });

  test("backup rejects same-context revision changes during asynchronous detail reads", async () => {
    const nativeClient = { currentSessionEpoch: 1, snapshot: { cursor: {
      documentId: "doc", contextId: "a", branchId: "main", headId: "cached", revision: "1",
    } } };
    const details = await loadModule("src/platform/versionDetails.ts", {
      "./workspace": { nativeClient, snapshotFromLoadedDocument: async (document) => document },
      "./ipc": { nativeInvoke: async (_command, args) => {
        await new Promise((resolve) => setImmediate(resolve));
        nativeClient.snapshot.cursor.revision = "2";
        return { id: args.commitId, snapshotDocumentJson: "{}" };
      } },
    });
    const store = { currentBranchId: "main", branches: [{ id: "main", headCommitId: "cached" }],
      commits: [{ id: "cached", snapshot: {} }, { id: "old", snapshot: null }] };
    await assert.rejects(details.materializeVersionStore(store), /版本库已变化/);
  });

  test("backup rejects a graph whose current branch head does not match the authority cursor", async () => {
    const details = await loadModule("src/platform/versionDetails.ts", {
      "./workspace": { nativeClient: { currentSessionEpoch: 1, snapshot: { cursor: {
        documentId: "doc", contextId: "a", branchId: "main", headId: "new-head", revision: "2",
      } } } }, "./ipc": {},
    });
    await assert.rejects(details.materializeVersionStore({ currentBranchId: "main",
      branches: [{ id: "main", headCommitId: "old-head" }],
      commits: [{ id: "old-head", snapshot: {} }] }), /版本库已变化/);
  });

  test("detail rejects malformed replies and stale editing contexts", async () => {
    const nativeClient = { currentSessionEpoch: 1, snapshot: { cursor: { contextId: "a" } } };
    let response = { id: "wrong", snapshotDocumentJson: "{}" };
    let changeContext = false;
    const details = await loadModule("src/platform/versionDetails.ts", {
      "./workspace": { nativeClient, snapshotFromLoadedDocument: async (document) => document },
      "./ipc": { nativeInvoke: async () => {
        if (changeContext) nativeClient.currentSessionEpoch++;
        return response;
      } },
    });
    await assert.rejects(details.loadCommitDetail("old"), /版本详情无效/);
    response = { id: "old", snapshotDocumentJson: "" };
    await assert.rejects(details.loadCommitDetail("old"), /版本详情无效/);
    response = { id: "old", snapshotDocumentJson: "{}" };
    changeContext = true;
    await assert.rejects(details.loadCommitDetail("old"), /工作区已切换/);
  });
}

// legacy-import
{
  async function loadImportedTemplateParser() {
    return loadModule('src/ui/domain/imported-template.ts', {
      '../../platform/ipc': { hasDocumentRuntime: () => false, nativeInvoke: async () => {
        throw new Error('unexpected template IPC call');
      } },
    });
  }

  async function loadLegacyImporter() {
    const dependencies = {
      "../ui/domain/imported-template": await loadImportedTemplateParser(),
      "../ui/domain/resume-normalization": {
        migratePersonalSites: (value) => value,
        normalizeResumeState: (value) => value,
        normalizeSectionOrder: (value) => value,
      },
      "../ui/domain/resume-model": {
        moduleTitles: {},
      },
      "../ui/domain/template-model": {
        normalizePresentation: (value) => value,
      },
      "./documentBridge": {
        documentFromSnapshot: () => ({ schemaVersion: 2 }),
      },
      "./workspace": {
        nativeClient: { snapshot: null },
      },
      "./ipc": {
        nativeInvoke: async () => {
          throw new Error("unexpected native IPC call");
        },
      },
    };
    return loadModule('src/platform/legacyImport.ts', dependencies);
  }

  test("versions-only import keeps history without inferring a current draft", async () => {
    const importer = await loadLegacyImporter();
    const source = {
      currentBranchId: "main",
      branches: [{
        id: "main",
        name: "默认版本",
        createdAt: "2026-01-01T00:00:00Z",
        headCommitId: "commit-head",
      }],
      commits: [{
        id: "commit-head",
        branchId: "main",
        parentId: null,
        message: "synthetic head",
        createdAt: "2026-01-01T00:00:00Z",
        snapshot: { resumeTitle: "合成历史快照" },
      }],
    };
    const before = structuredClone(source);

    const imported = importer.parseLegacyDataFile(source);

    assert.equal(imported.kind, "project-versions");
    assert.equal(imported.snapshot, null);
    assert.equal(imported.store.commits[0].snapshot.resumeTitle, "合成历史快照");
    assert.deepEqual(source, before);
  });

  test("migration preparation keeps source bytes, explicit namespace, graph IDs, and conflict acknowledgements", async () => {
    const sourceHash = "a".repeat(64);
    const conflictKey = "reviewed-identity-update";
    const calls = [];
    const source = {
      currentBranchId: "main",
      branches: [{
        id: "main",
        name: "Imported main",
        createdAt: "2026-01-01T00:00:00Z",
        headCommitId: "commit-a",
      }],
      commits: [{
        id: "commit-a",
        branchId: "main",
        parentId: null,
        message: "synthetic",
        createdAt: "2026-01-01T00:00:00Z",
        snapshot: { resumeTitle: "Synthetic history" },
      }],
    };
    const dependencies = {
      "../ui/domain/imported-template": await loadImportedTemplateParser(),
      "../ui/domain/resume-normalization": {
        migratePersonalSites: (value) => value,
        normalizeResumeState: (value) => value,
        normalizeSectionOrder: (value) => value,
      },
      "../ui/domain/resume-model": { moduleTitles: {} },
      "../ui/domain/template-model": { normalizePresentation: (value) => value },
      "./documentBridge": {
        documentFromSnapshot: (snapshot, documentId) => ({
          schemaVersion: 2,
          documentId,
          title: snapshot.resumeTitle,
        }),
      },
      "./workspace": { nativeClient: { snapshot: null } },
      "./ipc": {
        nativeInvoke: async (command, args) => {
          calls.push({ command, args });
          if (command === "inspect_legacy_migration") {
            return {
              readyForDryRun: true,
              namespaceDecisionRequired: false,
              sources: [{
                sourceId: "version-json",
                sourceSha256: sourceHash,
                issues: [],
              }],
              issues: [],
              conflicts: [],
            };
          }
          if (command === "dry_run_legacy_migration") {
            return {
              status: "ready",
              stagedDocumentCount: 1,
              conversionIssues: [],
            };
          }
          if (command === "inspect_legacy_identity_conflicts") {
            return [{
              conflictKey,
              entityKind: "commit",
              legacyId: "commit-a",
              existingVariantCount: 1,
            }];
          }
          throw new Error(`unexpected command ${command}`);
        },
      },
    };
    const exports = await loadModule('src/platform/legacyImport.ts', dependencies);

    const raw = JSON.stringify(source);
    const prepared = await exports.prepareLegacyMigration(
      raw,
      { kind: "project-versions", snapshot: null, store: source },
      {
        documentId: "native-doc",
        contextId: "context-a",
        revision: "4",
        branchId: "main:native-doc",
        headId: null,
      },
      "resume-diy-versions-synthetic",
    );

    assert.deepEqual(calls.map((item) => item.command), [
      "inspect_legacy_migration",
      "dry_run_legacy_migration",
      "inspect_legacy_identity_conflicts",
    ]);
    assert.equal(calls[0].args.request.sources[0].rawJson, raw);
    assert.equal(calls[0].args.request.sourceNamespace, "resume-diy-versions-synthetic");
    assert.equal(calls[1].args.request.convertedDocuments[0].document.documentId, "native-doc");
    assert.equal(calls[2].args.request.versionGraph.commits[0].id, "commit-a");
    assert.equal(prepared.request.currentDraft, null);
    assert.deepEqual(prepared.request.acceptedIdentityUpdates, [conflictKey]);
  });
}

// import-provenance
{
  // 页码 provenance 的单测：全部使用内存合成 RecognizedLine 输入，不触碰 fixtures/ 下任何夹具。
  //
  // 验证边界说明：import-draft.ts 的 evidence()/candidatesFrom() 是 evidence.page 的最终
  // 消费方，但其静态导入链包含 template-import.ts 顶层的
  // `import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"`（Vite 专有
  // 查询后缀），node 无法解析，因此本文件直接断言 evidence.page 的唯一数据源——
  // structureRecognizedLines 产出的 fieldProvenance（page + 来源行文本）。
  // fieldProvenance → evidence() 的接线由 npm run check:ts 的类型约束覆盖。
  // evidence() 的取值契约：page = source?.page ?? null，excerpt 优先取 source.text。

  test("PDF：目标字段只出现在第 2/3 页时，字段 provenance 携带真实页码", () => {
    const content = structureRecognizedLines(
      [
        { text: "张三", page: 1 },
        { text: "求职意向：前端工程师", page: 1 },
        { text: "联系方式：zhangsan@example.com", page: 2 },
        { text: "电话：13800138000", page: 2 },
        { text: "教育经历", page: 2 },
        { text: "2016.09 - 2020.06 某大学 计算机科学与技术 本科", page: 2 },
        { text: "工作经历", page: 3 },
        { text: "2020.07 - 至今 某科技公司 前端工程师", page: 3 },
      ],
      "pdf",
    );
    // 基本信息字段：只出现在第 2 页 → 页码为 2，不是 1 也不是 null
    assert.equal(content.fieldProvenance["basic:email"]?.page, 2);
    assert.equal(content.fieldProvenance["basic:phone"]?.page, 2);
    // 来源行文本是结构化证据（该字段命中的第一行），而非显示文本匹配
    assert.equal(
      content.fieldProvenance["basic:email"]?.text,
      "联系方式：zhangsan@example.com",
    );
    assert.equal(content.fieldProvenance["basic:phone"]?.text, "电话：13800138000");
    // 姓名来源在第 1 页
    assert.equal(content.fieldProvenance["basic:name"]?.page, 1);
    assert.equal(content.fieldProvenance["basic:name"]?.text, "张三");
    // 模块字段：教育经历内容在第 2 页、工作经历内容在第 3 页
    assert.equal(content.fieldProvenance["section:education"]?.page, 2);
    assert.equal(content.fieldProvenance["section:work"]?.page, 3);
    // 自定义模块的首个来源（求职意向行）在第 1 页
    assert.equal(content.fieldProvenance["section:custom"]?.page, 1);
  });

  test("PDF：同一字段跨页出现时，provenance 记录首个可靠来源", () => {
    const content = structureRecognizedLines(
      [
        { text: "李四", page: 2 },
        { text: "电话：13900139000", page: 2 },
        { text: "工作经历", page: 3 },
        { text: "电话：13900139000", page: 3 },
      ],
      "pdf",
    );
    assert.equal(content.fieldProvenance["basic:phone"]?.page, 2);
    assert.equal(content.fieldProvenance["basic:phone"]?.text, "电话：13900139000");
  });

  test("PDF：值需要跨行拼接才能命中时，不编造单行页码（provenance 缺省）", () => {
    const content = structureRecognizedLines(
      [
        { text: "赵六", page: 1 },
        { text: "138", page: 1 },
        { text: "00138000", page: 1 },
      ],
      "pdf",
    );
    // 电话只在 join(" ") 后的全文中可匹配，任何单行都不包含完整值：
    // 此时不得把任一行的页码当作电话来源。
    assert.equal(content.fieldProvenance["basic:phone"], undefined);
  });

  test("DOCX/图片：没有页码时 provenance.page 保持 null，不编造 PDF 页码", () => {
    const lines = [
      { text: "王五" },
      { text: "wangwu@example.com" },
      { text: "电话：13700137000" },
      { text: "教育经历" },
      { text: "2017.09 - 2021.06 某大学 软件工程 本科" },
    ];
    for (const source of ["word", "image"]) {
      const content = structureRecognizedLines(lines, source);
      // 可定位字段的 provenance 条目存在，但 page 为 null
      const emailProvenance = content.fieldProvenance["basic:email"];
      assert.ok(emailProvenance, `${source} 应为可定位字段保留来源行`);
      assert.equal(emailProvenance.page, null);
      assert.equal(emailProvenance.text, "wangwu@example.com");
      // 全部 provenance 条目都不携带页码
      for (const [key, entry] of Object.entries(content.fieldProvenance))
        assert.equal(
          entry.page,
          null,
          `${source} 的 ${key} 不应携带页码`,
        );
    }
  });
}

// utils-resume
{
  test("monthLabel 格式化年-月形态（两种格式）", () => {
    assert.equal(monthLabel("2021-01"), "2021.01");
    assert.equal(monthLabel("2021-01", "2021年1月"), "2021年01月");
    // 历史数据可能存在单位数月份，保持旧版原样拼接行为
    assert.equal(monthLabel("2021-1"), "2021.1");
    assert.equal(monthLabel("2021-1", "2021年1月"), "2021年1月");
  });

  test("monthLabel 空值与非日期值原样返回，不产生 undefined 污染", () => {
    assert.equal(monthLabel(""), "");
    assert.equal(monthLabel("至今"), "至今");
    assert.equal(monthLabel("至今", "2021年1月"), "至今");
    assert.equal(monthLabel("现在"), "现在");
    assert.equal(monthLabel("present"), "present");
    assert.equal(monthLabel("2023"), "2023");
  });
}
