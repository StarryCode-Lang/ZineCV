// waitForFunction treats a returned Promise as truthy before it resolves.
// Keep synchronous DOM predicates in the browser and await async IPC predicates
// explicitly, so false results poll again instead of producing a false pass.
// CDP 连接成功时 WebView2 页面可能尚未附着（contexts 为空）。轮询等待首个
// 页面出现，避免 page 为 undefined 时在 installAsyncWait 或后续断言处抛错。
// Keep the original deadline, but do not leave its timer holding Node open
// after a successful close/exit. A deadline still resolves undefined.
export async function settleBefore(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([operation, new Promise(done => { timer = setTimeout(done, timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

export async function waitForFirstPage(browser, { timeoutMs = 60_000, isAlive } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAlive && !isAlive()) throw new Error("Native host exited before page attach");
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the first WebView2 page");
}

export function installAsyncWait(page) {
  if (page.__zinecvAsyncWait) return;
  const original = page.waitForFunction.bind(page);
  page.waitForFunction = async (predicate, argument, options = {}) => {
    if (typeof predicate !== "function" || predicate.constructor.name !== "AsyncFunction") return original(predicate, argument, options);
    const timeout = options.timeout ?? 30_000;
    const deadline = timeout === 0 ? Infinity : performance.now() + timeout;
    const polling = typeof options.polling === "number" ? Math.max(1, options.polling) : 100;
    while (performance.now() < deadline) {
      const remaining = deadline - performance.now();
      let timer;
      const evaluation = page.evaluateHandle(predicate, argument);
      let handle;
      try {
        handle = Number.isFinite(remaining) ? await Promise.race([evaluation, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Async native predicate timed out after ${timeout}ms`)), Math.max(1, remaining));
        })]) : await evaluation;
      } catch (error) {
        evaluation.then(lateHandle => lateHandle.dispose(), () => {});
        throw error;
      } finally { clearTimeout(timer); }
      if (await handle.evaluate(value => Boolean(value))) return handle;
      await handle.dispose();
      await new Promise(resolve => setTimeout(resolve, Math.min(polling, Math.max(0, deadline - performance.now()))));
    }
    throw new Error(`Async native predicate timed out after ${timeout}ms`);
  };
  page.__zinecvAsyncWait = true;
}
