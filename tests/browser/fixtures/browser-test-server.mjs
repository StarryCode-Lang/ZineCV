import { createServer } from "vite";
import { chromium } from "playwright";
import { resolve } from "node:path";

const blankPage = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ZineCV browser test page</title></head><body><div id="root"></div></body></html>`;

export function launchBrowserTestChromium(options = {}) {
  return chromium.launch({ ...options, args: [...(options.args ?? []), "--no-proxy-server"] });
}

export function createBrowserTestServerPool(create, listen) {
  const entries = new Map();
  const leases = new WeakMap();
  return {
    async acquire(root) {
      const key = resolve(root);
      let entry = entries.get(key);
      if (!entry) {
        entry = { server: Promise.resolve().then(() => create(key)), ready: null };
        entries.set(key, entry);
      }
      let server;
      try { server = await entry.server; }
      catch (error) { if (entries.get(key) === entry) entries.delete(key); throw error; }
      // Per-test close releases the facade; the suite owns the actual server.
      // All server methods still receive Vite's original receiver.
      const lease = new Proxy(server, { get(target, property) {
        if (property === "close") return async () => {};
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      leases.set(lease, entry);
      return lease;
    },
    async listen(lease) {
      const entry = leases.get(lease);
      if (!entry) return listen(lease);
      entry.ready ??= entry.server.then(listen);
      await entry.ready;
      return lease;
    },
    async close() {
      const pending = [...entries.values()];
      entries.clear();
      const results = await Promise.allSettled(pending.map(async entry => {
        // Failed creation has no server; setup failures are already reported
        // by their test. A successfully created server must always be closed.
        const server = await entry.server.catch(() => null);
        await entry.ready?.catch(() => {});
        if (server) await server.close();
      }));
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Browser test server cleanup failed");
    },
  };
}

let sharedServers;
export function enableSharedBrowserTestServers() {
  sharedServers ??= createBrowserTestServerPool(createUnsharedBrowserTestServer,
    server => listenForUnsharedBrowserTestServer(server, { closeOnError: false }));
}

export async function closeSharedBrowserTestServers() {
  const pool = sharedServers;
  sharedServers = undefined;
  await pool?.close();
}

export function createBrowserTestServer(root) {
  return sharedServers ? sharedServers.acquire(root) : createUnsharedBrowserTestServer(root);
}

function createUnsharedBrowserTestServer(root) {
  return createServer({
    root,
    optimizeDeps: {
      noDiscovery: true,
      include: [
        "react", "react-dom/client", "motion", "motion/mini", "motion/react", "motion/react-m",
        "@tiptap/extension-list", "@tiptap/react", "@tiptap/starter-kit", "lucide-react",
        "use-sync-external-store/shim", "tesseract.js", "mammoth", "jszip", "docx-preview",
        "pdfjs-dist/legacy/build/pdf.mjs", "html2canvas",
      ],
    },
    plugins: [{
      name: "zinecv-browser-test-page",
      configureServer(server) {
        server.middlewares.use("/__zinecv_browser_test_page.html", async (_request, response, next) => {
          try {
            const html = await server.transformIndexHtml("/__zinecv_browser_test_page.html", blankPage);
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(html);
          } catch (error) {
            next(error);
          }
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
}

export async function listenForBrowserTestServer(server) {
  return sharedServers ? sharedServers.listen(server) : listenForUnsharedBrowserTestServer(server);
}

async function listenForUnsharedBrowserTestServer(server, { closeOnError = true } = {}) {
  try {
    await server.listen();
    const optimizer = server.environments.client.depsOptimizer;
    const ready = async () => {
      await optimizer?.scanProcessing;
      const pendingDependencies = Object.values(optimizer?.metadata.discovered ?? {})
        .map((dependency) => dependency.processing)
        .filter(Boolean);
      await Promise.all(pendingDependencies);
    };
    let timeoutId;
    try {
      await Promise.race([
        ready(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Vite browser test dependencies did not finish optimization within 120 seconds")), 120_000);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    process.stderr.write(`Browser test Vite setup failed: ${error.stack ?? error.message}\n`);
    if (closeOnError) await server.close();
    throw error;
  }
  return server;
}
