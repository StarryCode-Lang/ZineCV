import init, { WebStore, WebAgent, default_document } from "../../../.artifacts/wasm-bindings/zinecv_wasm.js";
const ready = init();
let store;
let agent;
self.onmessage = async ({ data }) => {
  try {
    await ready;
    agent ??= new WebAgent();
    let result;
    switch (data.action) {
      case "open":
        store = await WebStore.open(data.directory);
        store.initialize(default_document("store-poc"), "store-context");
        result = JSON.parse(store.load("store-poc")); break;
      case "apply": result = JSON.parse(store.apply("user", JSON.stringify(data.envelope))); break;
      case "load": result = JSON.parse(store.load("store-poc")); break;
      case "backup": result = JSON.parse(store.backup()); break;
      case "restore": await store.reserve_snapshot_capacity(); result = JSON.parse(store.restore(JSON.stringify(data.payload))); break;
      case "close": store.close(); store.free(); result = true; break;
      case "agent": result = JSON.parse(await agent.run(data.baseUrl, "synthetic-model", "", JSON.stringify(data.request))); break;
      case "cancel-agent": agent.cancel(); result = true; break;
      default: throw new Error("Unknown action");
    }
    self.postMessage({ id: data.id, result });
  } catch (error) { self.postMessage({ id: data.id, error: String(error), stack: error?.stack }); }
};
