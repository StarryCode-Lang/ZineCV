import { loadModule as loadTestModule, loadModule } from "./module-loader.mjs";
import { test, mock } from "node:test";
import { strict as assert } from "node:assert";
import { NativeDocumentClient } from "../../src/platform/NativeDocumentClient.ts";

// agent-session-flush
{
  // agent-session-flush：验证 src/ui/agent/sessions.ts 的流式会话落盘调度
  // （AGENT_SESSION_WRITE_DEBOUNCE_MS trailing 去抖 + flushScheduledAgentSessionWrite
  // 强制落盘）。测试走浏览器降级路径（isTauriRuntime === false），用假 storage
  // 捕获持久化调用，并确保全程不触达 native IPC。测试只写不跑，统一验证阶段
  // 通过 `node --test tests/unit/*.test.mjs` 执行。




  function createDependencies() {
    return {
      "../../platform/ipc": {
        hasDocumentRuntime: () => false,
        nativeInvoke: async () => {
          throw new Error("调度测试不应触达 native IPC");
        },
      },
    };
  }

  function createStorageSpy() {
    const writes = [];
    return {
      writes,
      localStorage: {
        getItem: () => null,
        setItem: (key, value) => writes.push({ key, value }),
        removeItem: () => {},
      },
    };
  }

  async function withBrowserStorage(run) {
    const spy = createStorageSpy();
    const previous = globalThis.localStorage;
    globalThis.localStorage = spy.localStorage;
    try {
      await run(spy);
    } finally {
      if (previous === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = previous;
    }
  }

  function createStore(deltaText) {
    return {
      activeId: "session-1",
      sessions: [
        {
          id: "session-1",
          title: "新对话",
          createdAt: 1,
          updatedAt: 1,
          messages: [{ id: "m-1", role: "assistant", text: deltaText }],
        },
      ],
    };
  }

  const loadModule = dependencies => loadTestModule('src/ui/agent/sessions.ts', dependencies);

  test("800ms 去抖窗口内的多次流式 delta 只产生一次持久化调用，且以最后一次状态为准", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const sessions = await loadModule(createDependencies());
      assert.equal(sessions.AGENT_SESSION_WRITE_DEBOUNCE_MS, 800);
      await withBrowserStorage(async (spy) => {
        // 模拟一次流式输出的多个 message.delta：每个 delta 调度一次落盘。
        sessions.scheduleAgentSessionWrite(createStore("delta-1"), "account-a");
        sessions.scheduleAgentSessionWrite(createStore("delta-2"), "account-a");
        sessions.scheduleAgentSessionWrite(createStore("delta-3"), "account-a");

        mock.timers.tick(799);
        assert.equal(spy.writes.length, 0, "去抖窗口内不应落盘");

        mock.timers.tick(1);
        assert.equal(spy.writes.length, 1, "800ms trailing 到期后仅落盘一次");
        assert.equal(spy.writes[0].key, "resume-diy-agent-sessions-v2:account-a");
        const persisted = JSON.parse(spy.writes[0].value);
        assert.equal(persisted.sessions[0].messages[0].text, "delta-3");
      });
    } finally {
      mock.timers.reset();
    }
  });

  test("flush 强制立即落盘最新待写状态，并取消未触发的去抖定时器", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const sessions = await loadModule(createDependencies());
      await withBrowserStorage(async (spy) => {
        sessions.scheduleAgentSessionWrite(createStore("streaming"), "account-a");
        sessions.scheduleAgentSessionWrite(createStore("final"), "account-a");

        sessions.flushScheduledAgentSessionWrite();
        assert.equal(spy.writes.length, 1, "flush 必须立即落盘，不等待去抖窗口");
        const persisted = JSON.parse(spy.writes[0].value);
        assert.equal(persisted.sessions[0].messages[0].text, "final");

        mock.timers.tick(sessions.AGENT_SESSION_WRITE_DEBOUNCE_MS * 2);
        assert.equal(spy.writes.length, 1, "flush 后去抖定时器已取消，不应重复落盘");

        sessions.flushScheduledAgentSessionWrite();
        assert.equal(spy.writes.length, 1, "无待写状态时 flush 是空操作");
      });
    } finally {
      mock.timers.reset();
    }
  });

  test("flush 之后的后续 delta 重新进入去抖窗口并按序落盘", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const sessions = await loadModule(createDependencies());
      await withBrowserStorage(async (spy) => {
        sessions.scheduleAgentSessionWrite(createStore("before-flush"), "account-a");
        sessions.flushScheduledAgentSessionWrite();
        assert.equal(spy.writes.length, 1);
        assert.equal(
          JSON.parse(spy.writes[0].value).sessions[0].messages[0].text,
          "before-flush",
        );

        sessions.scheduleAgentSessionWrite(createStore("after-flush"), "account-a");
        mock.timers.tick(sessions.AGENT_SESSION_WRITE_DEBOUNCE_MS);
        assert.equal(spy.writes.length, 2, "新调度在窗口到期后按序落盘");
        assert.equal(
          JSON.parse(spy.writes[1].value).sessions[0].messages[0].text,
          "after-flush",
        );
      });
    } finally {
      mock.timers.reset();
    }
  });
}

// draft-authority-queue
{
  const workspace = await loadModule("src/platform/workspace.ts", {
    "./NativeDocumentClient": {NativeDocumentClient: class {}}, "./ipc": {}, "./documentBridge": {}, "./editorBuffers": {},
  });
  const {registerDraftFlush, runDraftAuthorityAction} = workspace;
  const {serializePersistAction} = await loadModule("src/platform/useNativeResumePersistence.ts", {
    react: {}, "./documentBridge": {}, "./workspace": workspace, "./ipc": {}, "../ui/agent/sessions": {},
  });

  test("version authority waits for preceding saves and prevents autosave during command and reload", async () => {
    const unregister = registerDraftFlush(async () => ({ok: true}), serializePersistAction);
    const events = []; let cursor = 0, releaseSave, releaseVersion;
    const saveGate = new Promise(resolve => { releaseSave = resolve; });
    const versionGate = new Promise(resolve => { releaseVersion = resolve; });
    try {
      const first = serializePersistAction(async () => { events.push("save-start"); await saveGate; cursor++; events.push("save-end"); });
      const version = runDraftAuthorityAction(async () => { assert.equal(cursor, 1); events.push("version-start"); await versionGate; cursor++; events.push("reload-end"); });
      const second = serializePersistAction(async () => { assert.equal(cursor, 2); events.push("next-save"); });
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(events, ["save-start"]);
      releaseSave(); await first; await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(events, ["save-start", "save-end", "version-start"]);
      releaseVersion(); await Promise.all([version, second]);
      assert.deepEqual(events, ["save-start", "save-end", "version-start", "reload-end", "next-save"]);
    } finally { releaseSave(); releaseVersion(); unregister(); }
  });

  test("failed authority operation releases the persistence queue without swallowing the error", async () => {
    const unregister = registerDraftFlush(async () => ({ok: true}), serializePersistAction);
    try {
      await assert.rejects(runDraftAuthorityAction(async () => { throw new Error("native CAS conflict"); }), /native CAS conflict/);
      let saved = false;
      await serializePersistAction(async () => { saved = true; });
      assert.equal(saved, true);
    } finally { unregister(); }
  });
}

// native-persistence
{
  test("failed session writes block flush, and a later durable write recovers", async () => {
    let fail = true;
    const store = { activeId: "s", sessions: [] };
    const sessions = await loadModule("src/ui/agent/sessions.ts", {
      "../../platform/ipc": { hasDocumentRuntime: () => true, nativeInvoke: async (command) => {
        if (command === "bootstrap_agent_sessions") return { revision: 0, store };
        if (fail) throw new Error("disk write failed");
        return 1;
      } },
    });
    await sessions.loadAgentSessions("account");
    assert.equal(await sessions.writeAgentSessions(store, "account"), false);
    await assert.rejects(sessions.flushAgentSessionWrites(), /disk write failed/);
    fail = false;
    assert.equal(await sessions.writeAgentSessions(store, "account"), true);
    await sessions.flushAgentSessionWrites();
  });

  test("template catalog exposes only acknowledged data", async () => {
    let rejectWrite;
    const catalog = await loadModule("src/ui/domain/imported-template.ts", {
      "../../platform/ipc": { hasDocumentRuntime: () => true, nativeInvoke: async (command) => {
        if (command === "read_imported_template_catalog") return { revision: 0, payloadJson: "[]" };
        return new Promise((resolve, reject) => { rejectWrite = reject; });
      } },
    });
    await catalog.loadImportedTemplates();
    const pending = catalog.writeImportedTemplates([{ id: "unsaved", name: "not durable" }]);
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(catalog.readImportedTemplates(), []);
    rejectWrite(new Error("disk full"));
    await assert.rejects(pending, /disk full/);
    assert.deepEqual(catalog.readImportedTemplates(), []);
  });

  test("native template previews hydrate from assets and survive a failed catalog write", async () => {
    const assetHash = "a".repeat(64);
    const revisionHash = "b".repeat(64);
    const dataUrl = "data:image/png;base64,c3ludGhldGlj";
    let failWrite = false;
    let stored = {
      revision: 4,
      payloadJson: JSON.stringify([{
        id: "asset-template",
        name: "Saved template",
        sourceName: "fixture.pdf",
        sourceType: "pdf",
        accent: "#2455a4",
        formatId: "legacy-v1",
        layout: "single-column",
        analysis: "synthetic fixture",
        previewAssetId: assetHash,
        revisionHash,
        revisionStatus: "current",
        knownRevisions: [{ revisionHash, rendererStatus: "current" }],
      }]),
    };
    const writes = [];
    const catalog = await loadModule("src/ui/domain/imported-template.ts", {
      "../../platform/ipc": {
        hasDocumentRuntime: () => true,
        nativeInvoke: async (command, args) => {
          if (command === "read_imported_template_catalog") return stored;
          if (command === "read_avatar_asset") return { dataUrl };
          if (command === "write_imported_template_catalog") {
            writes.push(args);
            if (failWrite) throw new Error("catalog revision conflict");
            const incoming = JSON.parse(args.payloadJson);
            stored = {
              revision: stored.revision + 1,
              payloadJson: JSON.stringify(incoming.map((template) => ({
                ...template,
                previewAssetId: assetHash,
                revisionHash,
              }))),
            };
            return stored.revision;
          }
          throw new Error(`unexpected command ${command}`);
        },
      },
    });

    await catalog.loadImportedTemplates();
    assert.equal(catalog.readImportedTemplates()[0].previewDataUrl, dataUrl);
    assert.equal(catalog.readImportedTemplates()[0].revisionHash, revisionHash);
    await catalog.writeImportedTemplates(catalog.readImportedTemplates());
    assert.equal(writes.length, 1);
    assert.equal(writes[0].expectedRevision, 4);
    assert.equal(JSON.parse(writes[0].payloadJson)[0].previewDataUrl, undefined);
    assert.equal(catalog.readImportedTemplates()[0].previewDataUrl, dataUrl);

    failWrite = true;
    const edited = catalog.readImportedTemplates().map((template) => ({
      ...template,
      name: "Unsaved rename",
    }));
    await assert.rejects(catalog.writeImportedTemplates(edited), /catalog revision conflict/);
    assert.equal(catalog.readImportedTemplates()[0].name, "Saved template");
    assert.equal(catalog.readImportedTemplates()[0].previewDataUrl, dataUrl);
  });

  test("history avatar reads do not replace the active avatar cache or source hash", async () => {
    const calls = [];
    const flushOrder = [];
    const document = { basic: { avatarAssetId: "current" } };
    const workspace = await loadModule("src/platform/workspace.ts", {
      "./NativeDocumentClient": { NativeDocumentClient: class {
        snapshot = { document, cursor: {} };
        async load() { return this.snapshot; }
      } },
      "./documentBridge": { snapshotFromDocument: (document, avatar) => ({ resume: { basic: { avatar } } }) },
      "./ipc": { nativeInvoke: async (command, args) => {
        calls.push({ command, args });
        return command === "read_avatar_asset" ? { dataUrl: `data:${args.hash}` } : { hash: "new", dataUrl: args.dataUrl };
      } },
      "./editorBuffers": { flushEditorBuffers: async () => { flushOrder.push("editor"); } },
    });
    await workspace.loadWorkspaceState();
    const history = await workspace.snapshotFromLoadedDocument({ basic: { avatarAssetId: "history" } });
    assert.equal(history.resume.basic.avatar, "data:history");
    await workspace.storeAvatarAsset(document, "data:current");
    assert.equal(calls.filter(({ command }) => command === "store_avatar_asset").length, 0);
    await workspace.storeAvatarAsset(document, "data:new");
    assert.equal(calls.at(-1).args.previousHash, "current");
    workspace.registerDraftFlush(async () => {
      flushOrder.push("draft");
      return { ok: true };
    });
    await workspace.flushDraftBeforeVersionAction();
    assert.deepEqual(flushOrder, ["editor", "draft"]);
  });
}

// native-document-client
{
  function initialState() {
    return {
      cursor: {
        documentId: "doc-1", contextId: "context-1", revision: "0",
        branchId: "main", headId: null,
      },
      document: {
        schemaVersion: 2, documentId: "doc-1", title: "原标题", basic: {},
        sections: [], presentation: {}, sourceRef: null, legacyExtensions: {},
      },
    };
  }

  function receipt(envelope, durable = true) {
    return {
      commandId: envelope.commandId,
      cursor: { ...initialState().cursor, revision: String(Number(envelope.expectedRevision) + 1) },
      durable,
      snapshotHash: "fixture-hash",
      document: { ...initialState().document, title: envelope.payload.title },
      changedIds: ["doc-1"],
    };
  }

  test("reselecting the active editing source accepts only an unchanged no-op receipt", async () => {
    const state = initialState();
    let changed = false;
    const client = new NativeDocumentClient(async command => command === "document_state"
      ? structuredClone(state)
      : { ...structuredClone(state), created: false, document: { ...state.document, title: changed ? "unacknowledged" : state.document.title } });
    await client.load();
    const request = { expectedCursor: state.cursor, sourceKind: "imported_template", sourceId: "active", initialDocument: state.document };
    const result = await client.switchEditingContext(request);
    assert.equal(result.created, false);
    assert.deepEqual(client.snapshot, state);
    assert.equal(client.saveStatus, "saved");
    changed = true;
    await assert.rejects(client.switchEditingContext(request), /invalid context switch/);
    assert.deepEqual(client.snapshot, state);
  });

  test("serializes commands against the latest durable cursor", async () => {
    const envelopes = [];
    let releaseFirst;
    const firstAck = new Promise((resolve) => { releaseFirst = resolve; });
    const invoke = async (command, args) => {
      if (command === "document_state") return initialState();
      assert.equal(command, "apply_document_command");
      envelopes.push(args.envelope);
      if (envelopes.length === 1) await firstAck;
      return receipt(args.envelope);
    };
    let sequence = 0;
    const client = new NativeDocumentClient(invoke, () => `command-${++sequence}`);
    await client.load();
    const first = client.submit({ type: "setDocumentTitle", title: "第一版" });
    const second = client.submit({ type: "setDocumentTitle", title: "第二版" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(envelopes.length, 1);
    assert.equal(client.saveStatus, "saving");
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(envelopes.map((item) => item.expectedRevision), ["0", "1"]);
    assert.deepEqual(envelopes.map((item) => item.commandId), ["command-1", "command-2"]);
    assert.equal((await client.flush()).document.title, "第二版");
    assert.equal(client.saveStatus, "saved");
  });

  test("lost ack keeps the exact command for retry and does not report saved", async () => {
    const envelopes = [];
    let state = initialState();
    const invoke = async (command, args) => {
      if (command === "document_state") return state;
      envelopes.push(structuredClone(args.envelope));
      const result = receipt(args.envelope);
      state = { cursor: result.cursor, document: result.document };
      if (envelopes.length === 1) throw new Error("transport lost acknowledgement");
      return result;
    };
    const client = new NativeDocumentClient(invoke, () => "stable-id");
    await client.load();
    await assert.rejects(client.submit({ type: "setDocumentTitle", title: "保留输入" }), /acknowledgement/);
    await assert.rejects(client.flush(), /acknowledgement/);
    assert.equal(client.snapshot.document.title, "原标题");
    assert.equal(client.saveStatus, "failed");
    await client.retryFailed();
    assert.deepEqual(envelopes[1], envelopes[0]);
    assert.equal(client.snapshot.document.title, "保留输入");
    assert.equal(client.saveStatus, "saved");
  });

  test("missing durable ack blocks later commands without losing the pending request", async () => {
    const envelopes = [];
    let durable = false;
    let state = initialState();
    const invoke = async (command, args) => {
      if (command === "document_state") return state;
      envelopes.push(structuredClone(args.envelope));
      const result = receipt(args.envelope, durable);
      if (durable) state = { cursor: result.cursor, document: result.document };
      return result;
    };
    let sequence = 0;
    const client = new NativeDocumentClient(invoke, () => `command-${++sequence}`);
    client.subscribe(() => { throw new Error("observer failure"); });
    await client.load();
    const first = client.submit({ type: "setDocumentTitle", title: "未确认" });
    const second = client.submit({ type: "setDocumentTitle", title: "后续编辑" });
    await assert.rejects(first, /durable/);
    await assert.rejects(second, /durable/);
    assert.equal(envelopes.length, 1);
    assert.equal(client.snapshot.cursor.revision, "0");
    durable = true;
    await client.retryFailed();
    assert.deepEqual(envelopes[1], envelopes[0]);
    assert.equal(client.snapshot.cursor.revision, "1");
    await client.submit({ type: "setDocumentTitle", title: "重新发起" });
    assert.equal(envelopes[2].expectedRevision, "1");
    assert.equal(client.saveStatus, "saved");
  });

  test("retry acknowledges the old receipt and preserves a later durable edit", async () => {
    let state = initialState();
    let original;
    const envelopes = [];
    const client = new NativeDocumentClient(async (command, args) => {
      if (command === "document_state") return state;
      envelopes.push(structuredClone(args.envelope));
      if (!original) {
        original = receipt(args.envelope);
        state = { cursor: original.cursor, document: original.document };
        throw new Error("lost ack");
      }
      return original;
    }, () => "lost-command");
    await client.load();
    await assert.rejects(client.submit({ type: "setDocumentTitle", title: "第一版" }), /lost ack/);
    state = { cursor: { ...state.cursor, revision: "2" }, document: { ...state.document, title: "另一窗口后续编辑" } };
    await client.retryFailed();
    assert.deepEqual(envelopes[0], envelopes[1]);
    assert.equal(client.snapshot.cursor.revision, "2");
    assert.equal(client.snapshot.document.title, "另一窗口后续编辑");
    assert.equal(client.saveStatus, "saved");
  });

  test("failed context switch preserves the current context and can be retried", async () => {
    let fail = true;
    const state = initialState();
    const calls = [];
    const client = new NativeDocumentClient(async (command, args) => {
      if (command === "document_state") return state;
      assert.equal(command, "switch_editing_context");
      calls.push(args.request);
      if (fail) throw new Error("context store busy");
      return {
        cursor: { ...state.cursor, contextId: "source-b", revision: "1" },
        document: { ...state.document, title: "B 草稿" },
        created: false,
      };
    });
    await client.load();
    const request = {
      expectedCursor: state.cursor,
      sourceKind: "imported_template",
      sourceId: "source-b-id",
      initialDocument: state.document,
    };

    await assert.rejects(client.switchEditingContext(request), /context store busy/);
    assert.equal(client.snapshot.cursor.contextId, "context-1");
    assert.equal(client.snapshot.document.title, "原标题");
    assert.equal(client.saveStatus, "idle");

    fail = false;
    const switched = await client.switchEditingContext(request);
    assert.equal(switched.created, false);
    assert.equal(client.snapshot.cursor.contextId, "source-b");
    assert.equal(client.snapshot.document.title, "B 草稿");
    assert.equal(client.currentSessionEpoch, 2);
    assert.equal(calls.length, 2);
  });

  test("reload advances the context epoch when history activates another source", async () => {
    let state = initialState();
    const client = new NativeDocumentClient(async (command) => {
      assert.equal(command, "document_state");
      return state;
    });
    await client.load();
    state = {
      cursor: { ...state.cursor, contextId: "source-b", revision: "1" },
      document: { ...state.document, title: "历史里的来源 B" },
    };
    const reloaded = await client.reload();
    assert.equal(client.currentSessionEpoch, 1);
    assert.equal(reloaded.cursor.contextId, "source-b");
    assert.equal(client.snapshot.document.title, "历史里的来源 B");
  });

  test("import lost acknowledgement retries the identical atomic request", async () => {
    let state = initialState();
    const requests = [];
    const invoke = async (command, args) => {
      if (command === "document_state") return state;
      assert.equal(command, "apply_import");
      requests.push(structuredClone(args.request));
      const request = args.request;
      const result = {
        commandId: request.commandId,
        cursor: { ...request.cursor, revision: String(Number(request.cursor.revision) + 1) },
        durable: true,
        snapshotHash: "import-fixture-hash",
        document: { ...initialState().document, basic: { name: "导入姓名" } },
        changedIds: request.acceptedCandidateIds,
      };
      state = { cursor: result.cursor, document: result.document };
      if (requests.length === 1) throw new Error("import acknowledgement lost");
      return result;
    };
    const client = new NativeDocumentClient(invoke, () => "import-command-stable");
    await client.load();
    const target = client.snapshot.cursor;
    await assert.rejects(
      client.applyImport("import-draft-1", ["candidate-1"], target),
      /acknowledgement lost/,
    );
    assert.equal(client.snapshot.cursor.revision, "0");
    await client.retryFailed();
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(client.snapshot.cursor.revision, "1");
    assert.equal(client.snapshot.document.basic.name, "导入姓名");
  });

  test("an import parsed against an old editing cursor cannot target a switched source", async () => {
    let state = initialState();
    const applied = [];
    const client = new NativeDocumentClient(async (command, args) => {
      if (command === "document_state") return state;
      if (command === "switch_editing_context") {
        state = {
          cursor: { ...state.cursor, contextId: "source-b", revision: "1" },
          document: { ...state.document, title: "来源 B" },
        };
        return { ...state, created: false };
      }
      if (command === "apply_import") applied.push(args.request);
      throw new Error(`unexpected native command: ${command}`);
    });
    await client.load();
    const parsedAgainst = client.snapshot.cursor;
    await client.switchEditingContext({
      expectedCursor: parsedAgainst,
      sourceKind: "imported_template",
      sourceId: "source-b",
      initialDocument: client.snapshot.document,
    });
    await assert.rejects(
      client.applyImport("import-draft-2", ["candidate-2"], parsedAgainst),
      /target changed after the candidates were prepared/,
    );
    assert.deepEqual(applied, []);
    assert.equal(client.snapshot.cursor.contextId, "source-b");
    assert.equal(client.snapshot.document.title, "来源 B");
  });
}

// workspace-settings
{
  function createWindow(initial = {}, innerWidth = 1280) {
    const values = new Map(Object.entries(initial));
    return {
      innerWidth,
      localStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
      },
      values,
    };
  }

  async function withWindow(windowValue, run) {
    const previous = globalThis.window;
    globalThis.window = windowValue;
    try {
      await run(windowValue);
    } finally {
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
    }
  }

  const loadModule = dependencies => loadTestModule('src/platform/settings.ts', dependencies);

  test("SQLite preferences override cache and a completed migration ignores later cache edits", async () => {
    await withWindow(createWindow({
      "resume-diy-editor-pane-width": "640",
      "resume-diy-agent-mode-v1": "chat",
      "resume-diy-preview-zoom-v1": "175",
    }), async (windowValue) => {
      const database = new Map([
        ["workspace-preferences-migrated-v1", "1"],
        ["resume-diy-preview-zoom-v1", "125"],
      ]);
      const settings = await loadModule({
        "./ipc": {
          hasDocumentRuntime: () => true,
          nativeInvoke: async (command, { key, value }) => {
            if (command === "read_setting") return database.get(key) ?? null;
            if (command === "write_setting") {
              if (value === null) database.delete(key);
              else database.set(key, value);
              return;
            }
            throw new Error(`unexpected command ${command}`);
          },
        },
      });

      const loaded = await settings.loadWorkspaceSettings();
      assert.equal(loaded.previewZoomPercent, 125);
      assert.equal(loaded.editorPaneWidth, 560);
      windowValue.localStorage.setItem("resume-diy-preview-zoom-v1", "190");
      assert.equal((await settings.loadWorkspaceSettings()).previewZoomPercent, 125);
    });
  });

  test("preview defaults to fit while an explicitly saved zoom remains a physical percentage", async () => {
    await withWindow(createWindow(), async () => {
      const database = new Map([["workspace-preferences-migrated-v1", "1"]]);
      const settings = await loadModule({
        "./ipc": {
          hasDocumentRuntime: () => true,
          nativeInvoke: async (command, { key }) => {
            if (command === "read_setting") return database.get(key) ?? null;
            throw new Error(`unexpected command ${command}`);
          },
        },
      });

      assert.equal((await settings.loadWorkspaceSettings()).previewZoomPercent, null);
      database.set("resume-diy-preview-zoom-v1", "100");
      assert.equal((await settings.loadWorkspaceSettings()).previewZoomPercent, 100);
    });
  });

  test("legacy UI settings migrate once into SQLite and the marker is written last", async () => {
    await withWindow(createWindow({
      "resume-diy-editor-pane-width": "640",
      "resume-diy-agent-mode-v1": "chat",
    }), async (windowValue) => {
      const database = new Map();
      const writes = [];
      const settings = await loadModule({
        "./ipc": {
          hasDocumentRuntime: () => true,
          nativeInvoke: async (command, { key, value }) => {
            if (command === "read_setting") return database.get(key) ?? null;
            if (command === "write_setting") {
              writes.push(key);
              database.set(key, value);
              return;
            }
            throw new Error(`unexpected command ${command}`);
          },
        },
      });

      const migrated = await settings.loadWorkspaceSettings();
      assert.equal(migrated.editorPaneWidth, 640);
      assert.equal(migrated.agentMode, "chat");
      assert.equal(database.get("workspace-preferences-migrated-v1"), "1");
      assert.equal(writes.at(-1), "workspace-preferences-migrated-v1");
      windowValue.localStorage.setItem("resume-diy-editor-pane-width", "700");
      assert.equal((await settings.loadWorkspaceSettings()).editorPaneWidth, 640);
    });
  });

  test("SQLite read failure blocks startup instead of falling back to local cache", async () => {
    await withWindow(createWindow({ "resume-diy-editor-pane-width": "640" }), async () => {
      const settings = await loadModule({
        "./ipc": {
          hasDocumentRuntime: () => true,
          nativeInvoke: async () => { throw new Error("database unavailable"); },
        },
      });
      await assert.rejects(settings.loadWorkspaceSettings(), /database unavailable/);
    });
  });

  test("failed SQLite writes preserve the cache and a retry updates it after acknowledgement", async () => {
    await withWindow(createWindow({ "resume-diy-editor-pane-width": "510" }), async (windowValue) => {
      let fail = true;
      const database = new Map();
      const settings = await loadModule({
        "./ipc": {
          hasDocumentRuntime: () => true,
          nativeInvoke: async (command, { key, value }) => {
            if (command === "read_setting") return database.get(key) ?? null;
            if (command === "write_setting") {
              if (fail) throw new Error("disk full");
              database.set(key, value);
              return;
            }
            throw new Error(`unexpected command ${command}`);
          },
        },
      });

      await assert.rejects(settings.writeWorkspaceSetting("editorPaneWidth", 620), /disk full/);
      assert.equal(windowValue.localStorage.getItem("resume-diy-editor-pane-width"), "510");
      fail = false;
      await settings.writeWorkspaceSetting("editorPaneWidth", 620);
      assert.equal(database.get("resume-diy-editor-pane-width"), "620");
      assert.equal(windowValue.localStorage.getItem("resume-diy-editor-pane-width"), "620");
    });
  });

  test("rapid writes to one preference reach SQLite in invocation order", async () => {
    await withWindow(createWindow(), async () => {
      let releaseFirst;
      const writes = [];
      const settings = await loadModule({
        "./ipc": {
          hasDocumentRuntime: () => true,
          nativeInvoke: async (command, { key, value }) => {
            if (command !== "write_setting") throw new Error(`unexpected command ${command}`);
            writes.push(value);
            if (writes.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
            return;
          },
        },
      });

      const first = settings.writeWorkspaceSetting("editorPaneWidth", 600);
      await new Promise((resolve) => setImmediate(resolve));
      const second = settings.writeWorkspaceSetting("editorPaneWidth", 700);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(writes, ["600"]);
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(writes, ["600", "700"]);
    });
  });
}
