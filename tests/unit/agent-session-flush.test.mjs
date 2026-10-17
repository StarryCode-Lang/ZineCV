import { loadModule as loadTestModule } from "./module-loader.mjs";
// agent-session-flush：验证 src/ui/agent/sessions.ts 的流式会话落盘调度
// （AGENT_SESSION_WRITE_DEBOUNCE_MS trailing 去抖 + flushScheduledAgentSessionWrite
// 强制落盘）。测试走浏览器降级路径（isTauriRuntime === false），用假 storage
// 捕获持久化调用，并确保全程不触达 native IPC。测试只写不跑，统一验证阶段
// 通过 `node --test tests/unit/*.test.mjs` 执行。
import { test, mock } from "node:test";
import { strict as assert } from "node:assert";


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
