import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { installIpcInterceptor } from "../native/ipc-interceptor.mjs";

function fixture(response) {
  const requests = [];
  const window = { fetch: async (...args) => { requests.push(args); return response; } };
  const context = createContext({ window, URL, Response, ArrayBuffer, Error });
  const page = { evaluate: (fn, arg) => runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`, context) };
  return { window, page, requests };
}

test("save-picker interception preserves unrelated native response identity and unread body", async () => {
  const response = new Response(new Uint8Array([0, 255, 7]), {
    status: 409, headers: { "Tauri-Response": "error", "Content-Type": "application/octet-stream", "X-Native": "kept" },
  });
  const f = fixture(response);
  await installIpcInterceptor(f.page, { commands: ["pick_export_path"] });
  f.window.__zinecvTestInvoke = () => { throw new Error("unselected command reached handler"); };
  const result = await f.window.fetch("http://ipc.localhost/document_state", { body: "not parsed by interceptor" });
  assert.equal(result, response);
  assert.equal(result.bodyUsed, false);
  assert.equal(result.status, 409);
  assert.equal(result.headers.get("X-Native"), "kept");
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [0, 255, 7]);
  assert.equal(f.requests.length, 1);
});

test("selected save picker returns supplied path without calling native dialog", async () => {
  const f = fixture(new Response("unexpected"));
  await installIpcInterceptor(f.page, { commands: ["pick_export_path"] });
  f.window.__zinecvTestInvoke = command => { assert.equal(command, "pick_export_path"); return "D:\\isolated\\export.pdf"; };
  const response = await f.window.fetch("http://ipc.localhost/pick_export_path", { body: "{}" });
  assert.equal(await response.json(), "D:\\isolated\\export.pdf");
  assert.equal(f.requests.length, 0);
});

test("existing default interception still forwards native errors to test handlers", async () => {
  const f = fixture(new Response(JSON.stringify({ message: "native failure" }), {
    headers: { "Tauri-Response": "error", "Content-Type": "application/json" },
  }));
  await installIpcInterceptor(f.page);
  f.window.__zinecvTestInvoke = (_command, _args, forward) => forward();
  const response = await f.window.fetch("http://ipc.localhost/document_state", { body: "{}" });
  assert.equal(response.headers.get("Tauri-Response"), "error");
  assert.deepEqual(await response.json(), { message: "native failure" });
  assert.equal(f.requests.length, 1);
});
