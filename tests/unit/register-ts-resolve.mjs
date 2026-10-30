// 由 package.json 的 test:unit 经 --import 预加载，向全部测试线程注册 TS 解析钩子。
import { registerHooks, enableCompileCache } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "./ts-resolve-hooks.mjs";

// Cache compiled JS only; every assertion and module instance still executes.
// V8 coverage must parse afresh to preserve its precise coverage accounting.
const coverage = process.env.NODE_V8_COVERAGE || [...process.execArgv, process.env.NODE_OPTIONS ?? ""].some(value => value.includes("--experimental-test-coverage"));
if (!coverage && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  const cache = enableCompileCache(process.env.NODE_COMPILE_CACHE ?? fileURLToPath(new URL("../../.artifacts/cache/node-compile/", import.meta.url)));
  if (cache.directory) process.env.NODE_COMPILE_CACHE = cache.directory;
}
registerHooks({ resolve });
