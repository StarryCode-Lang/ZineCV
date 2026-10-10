import init, { WebStore, WebAgent, default_document, open_secret_capability,
  prepare_provider_secret, prepare_stored_secrets, clear_secret_cache, browser_provider } from "../../../.artifacts/wasm-bindings/zinecv_wasm.js";

let store, agent, activeRun, releaseLock, secureSecrets = false, storeTail = Promise.resolve();
const withStore = operation => {
  const result = storeTail.then(operation);
  storeTail = result.catch(() => {}); return result;
};
const refreshSecrets = () => prepare_stored_secrets(JSON.parse(store.ciphertexts()));
const errorText = value => value instanceof Error ? value.message : String(value);

self.__zinecvAgentDelta = (runId, text) => {
  store.persist_agent_delta(runId, text);
  self.postMessage({ type: "agent_delta", runId, text });
};

async function initialize() {
  await init();
  if (!navigator.storage?.getDirectory || !navigator.locks) throw new Error("此浏览器无法提供可靠的本地保存，请使用桌面应用或支持 OPFS 与 Web Locks 的浏览器");
  const opened = new Promise((resolve, reject) => {
    navigator.locks.request("zinecv-workspace-writer", { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error("另一个标签页正在编辑此工作区，请先关闭它")); return; }
      try {
        try { await open_secret_capability("workspace"); secureSecrets = true; } catch { secureSecrets = false; }
        store = await WebStore.open("/zinecv-workspace");
        store.initialize(default_document("workspace-default-document"), "workspace-default-context");
        if (secureSecrets) await refreshSecrets();
        agent = new WebAgent(); resolve();
        await new Promise(resolveRelease => { releaseLock = resolveRelease; });
      } catch (error) { reject(error); }
    }).catch(reject);
  });
  await opened;
  return { core: "wasm", storage: { persistent: true, concurrentWriters: false, backend: "opfs-sahpool" },
    secureSecrets, nativeDialogs: false, fileSystemAccess: false, modelDirectFetch: true, workerIsolation: true, webLocks: true };
}

async function runAgent(args) {
  const config = await withStore(async () => { await refreshSecrets(); return JSON.parse(store.prepare_agent(JSON.stringify(args))); });
  let outcome;
  try {
    outcome = await agent.run(config.baseUrl, config.model, config.key || "", JSON.stringify(config.request));
  } catch (error) {
    await withStore(() => store.finish_browser_agent("{}", errorText(error)));
    throw error;
  } finally { clear_secret_cache(); }
  return withStore(() => JSON.parse(store.finish_browser_agent(outcome, undefined)));
}

async function invoke(command, args) {
  if (command === "initialize") return initialize();
  if (command === "cancel_agent_run") { if (activeRun?.id === args.runId) agent.cancel(); return null; }
  if (["provider_models", "provider_test"].includes(command)) {
    const config = await withStore(async () => { if (secureSecrets) await refreshSecrets(); return store.prepare_provider(JSON.stringify(args)); });
    try {
      const tested = command === "provider_test";
      const result = await browser_provider(config, tested);
      return await withStore(async () => { if (secureSecrets) await refreshSecrets(); return JSON.parse(store.finish_provider(config, result, tested)); });
    } finally { clear_secret_cache(); }
  }
  if (command === "agent_chat") {
    if (activeRun) throw new Error("Agent 正在运行");
    const promise = runAgent(args); activeRun = { id: args.runId, promise };
    try { return await promise; } finally { activeRun = null; }
  }
  if (["restore_database_backup", "replace_version_store"].includes(command) && activeRun) throw new Error("请先结束正在运行的 Agent，再恢复数据库或替换版本历史");
  if (["login_account", "logout_account"].includes(command) && activeRun) { agent.cancel(); await activeRun.promise.catch(() => {}); }
  return withStore(async () => {
    if (["restore_database_backup", "replace_version_store"].includes(command)) await store.reserve_snapshot_capacity();
    if (command === "replace_version_store") store.snapshot_before_replace();
    if (command === "restore_database_backup" && secureSecrets) {
      await prepare_stored_secrets(JSON.parse(store.backup_ciphertexts(JSON.stringify(args.payload))));
    }
    if (command === "store_provider_key") {
      if (!secureSecrets) throw new Error("此浏览器的安全密钥存储不可用，无法保存 API Key");
      if (args.key) await prepare_provider_secret(args.key);
    }
    if (secureSecrets && ["provider_profile", "export_database_backup"].includes(command)) await refreshSecrets();
    try { return JSON.parse(store.invoke(command, JSON.stringify(args))); }
    finally { if (["store_provider_key", "provider_profile", "export_database_backup", "logout_account"].includes(command)) clear_secret_cache(); }
  });
}
self.onmessage = async ({ data }) => {
  try { self.postMessage({ id: data.id, result: await invoke(data.command, data.args || {}) }); }
  catch (error) { self.postMessage({ id: data.id, error: errorText(error) }); }
};
