import { createServer } from "vite";
import { chromium } from "playwright";

const blankPage = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ZineCV browser test page</title></head><body><div id="root"></div></body></html>`;

export function launchBrowserTestChromium(options = {}) {
  return chromium.launch({ ...options, args: [...(options.args ?? []), "--no-proxy-server"] });
}

export function createBrowserTestServer(root) {
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
  await server.listen();
  try {
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
    await server.close();
    throw error;
  }
  return server;
}
