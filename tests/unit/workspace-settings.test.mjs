import { loadModule as loadTestModule } from "./module-loader.mjs";
import { test } from "node:test";
import { strict as assert } from "node:assert";


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
